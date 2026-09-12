import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// stub the LLM: behaviors 队列驱动（与 intervention.test.ts 同模式），让真实 callAgent 跑通 ask 闭环
const seenMessages: { role: string; content: string }[][] = [];
type Behavior = (() => { content: string } | Promise<{ content: string }>) | undefined;
const behaviors: Behavior[] = [];
const okFinal = { content: JSON.stringify({ status: 'success', summary: 'done', verification: '已按用户回答落实', changes: ['x.txt: ok'], errors: [] }) };
vi.mock('../src/llm', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/llm')>();
  return {
    ...actual,
    chat: async (_entry: any, messages: { role: string; content: string }[]) => {
      seenMessages.push(messages.map((m) => ({ ...m })));
      const b = behaviors.shift();
      const r = typeof b === 'function' ? await b(messages) : (b || okFinal);
      return { content: r.content, promptTokens: 3, completionTokens: 4 };
    },
  };
});

import { initBus, closeBus, getBus, busGet } from '../src/bus';
import { ModelPool } from '../src/scheduler';
import { Orchestrator } from '../src/orchestrator/orchestrator';
import { createApi } from '../src/api';
import { TaskQueueManager } from '../src/taskQueue';
import type { AppConfig } from '../src/config';
import { applyToolCalls } from '../src/tools';
import {
  abandonAsk,
  cancelAsks,
  consumeAskQueue,
  createAsk,
  flushAgentAsks,
  listAsks,
  queueAskForAgent,
  resolveAsk,
  settleTaskPendingAsks,
  waitForAnswer,
} from '../src/askGate';
import { getTaskGraph, getTaskJournals, saveTaskGraph } from '../src/store';
import type { TaskGraph, TaskNode } from '../src/types';

let tmp: string;
let orchestrator: Orchestrator;
let capturedEvents: { type: string; payload: Record<string, unknown> }[] = [];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

beforeEach(async () => {
  process.env.COTEAM_FORCE_MEMORY = '1';
  closeBus();
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-ask-'));
  for (const name of ['dev', 'review']) {
    const dir = path.join(tmp, name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'agent.yaml'), `name: ${name}\ntags: [code]\nrole: 测试\n`);
  }
  await initBus({ host: '127.0.0.1', port: 6399, db: 0 });
  seenMessages.length = 0;
  behaviors.length = 0;
  capturedEvents = [];
  getBus().subscribe('coteam:dashboard', (msg: any) => capturedEvents.push(msg));
  const pool = new ModelPool([{ name: 'fake-model', api_key: 'k', base_url: 'http://localhost:9', tags: ['code'] }]);
  orchestrator = new Orchestrator({
    agentsDir: tmp, modelPool: pool, policy: { whitelistCommands: null, maxTimeSec: 10 },
    maxRetries: 1, sandboxEnabled: false, gitEnabled: false, branchWorkflow: false,
    askTimeoutSec: 5,
  });
  await orchestrator.loadAgents();
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
  closeBus();
});

function makeNode(id: string, agent: string, extra: Partial<TaskNode> = {}): TaskNode {
  return {
    id, task_id: 't', name: id, status: 'pending', agent, result: null, error: '',
    retry_count: 0, complexity: 'normal', requires_approval: false, needs_human: false,
    created_at: '', updated_at: '',
    ...extra,
  };
}

describe('askGate (store layer)', () => {
  it('createAsk + waitForAnswer + resolveAsk 完成一次问答闭环', async () => {
    const ask = await createAsk({ task_id: 't1', from: 'dev', to: 'user', question: '字段名用 userId 还是 user_id？' });
    const waitP = waitForAnswer(ask.id, 't1', 5000);
    const hit = await resolveAsk(ask.id, 't1', '用 userId', 'user');
    expect(hit).toBe(true);
    const r = await waitP;
    expect(r.noAnswer).toBe(false);
    expect(r.answer).toBe('用 userId');
    expect(r.by).toBe('user');
    const asks = await listAsks('t1');
    expect(asks[0].status).toBe('answered');
  });

  it('超时按 noAnswer 收场并落盘 timeout', async () => {
    const ask = await createAsk({ task_id: 't2', from: 'dev', to: 'user', question: '在吗' });
    const r = await waitForAnswer(ask.id, 't2', 80);
    expect(r.noAnswer).toBe(true);
    expect(r.reason).toBe('timeout');
    const asks = await listAsks('t2');
    expect(asks[0].status).toBe('timeout');
  }, 10000);

  it('abandonAsk 立即释放等待者；flushAgentAsks 只收场接收方向（防同名 agent 并发误杀）', async () => {
    const a1 = await createAsk({ task_id: 't3', from: 'dev', to: 'user', question: 'q1' });
    const w1 = waitForAnswer(a1.id, 't3', 5000);
    await abandonAsk(a1.id, 't3', '咨询不可用');
    expect((await w1).noAnswer).toBe(true);

    const a2 = await createAsk({ task_id: 't3', from: 'dev', to: 'review', question: 'q2' }); // dev 发出：不被 flush（等待者属提问方自己的 dispatch）
    const a3 = await createAsk({ task_id: 't3', from: 'review', to: 'dev', question: 'q3' }); // dev 收到：flush 收场
    const w2 = waitForAnswer(a2.id, 't3', 30000);
    const w3 = waitForAnswer(a3.id, 't3', 5000);
    const n = await flushAgentAsks('t3', 'dev');
    expect(n).toBe(1);
    expect((await w3).reason).toBe('unanswered');
    // dev 发出的 q2 只能靠超时收场（提问方 dispatch 已死，无人在等）——手动收场避免悬挂
    await abandonAsk(a2.id, 't3', 'test cleanup');
    await w2;
    const asks = await listAsks('t3');
    expect(asks.filter((a) => a.status === 'unanswered').length).toBe(3);
  });

  it('cancelAsks 释放该任务全部在飞等待', async () => {
    const a = await createAsk({ task_id: 't4', from: 'dev', to: 'user', question: 'q' });
    const w = waitForAnswer(a.id, 't4', 30000);
    const other = await createAsk({ task_id: 't-other', from: 'dev', to: 'user', question: 'q' });
    const wOther = waitForAnswer(other.id, 't-other', 30000);
    expect(await cancelAsks('t4')).toBe(1);
    expect((await w).reason).toBe('cancelled');
    // 其他任务不受影响——手动收场避免悬挂定时器
    await cancelAsks('t-other');
    await wOther;
  }, 10000);

  it('queueAskForAgent/consumeAskQueue 消费即清空；settleTaskPendingAsks 落盘全部 pending', async () => {
    await queueAskForAgent('t5', 'dev', { ask_id: 'a', from: 'review', question: 'q1' });
    await queueAskForAgent('t5', 'dev', { ask_id: 'b', from: 'review', question: 'q2' });
    expect((await consumeAskQueue('t5', 'dev')).length).toBe(2);
    expect(await consumeAskQueue('t5', 'dev')).toEqual([]);

    await createAsk({ task_id: 't5', from: 'dev', to: 'user', question: 'q' });
    expect(await settleTaskPendingAsks('t5')).toBe(1);
    expect((await listAsks('t5')).every((a) => a.status === 'timeout')).toBe(true);
  });
});

describe('ask tools (tools.ts gating)', () => {
  it('无 askBridge 时 ask/answer 一律拒绝（讨论室天然门控）', async () => {
    const r1 = await applyToolCalls('/ws', [{ tool: 'ask_user', question: 'x' } as any]);
    const r2 = await applyToolCalls('/ws', [{ tool: 'ask_agent', to: 'dev', question: 'x' } as any]);
    const r3 = await applyToolCalls('/ws', [{ tool: 'answer', ask_id: 'a', content: 'x' } as any]);
    expect(r1[0]).toMatchObject({ ok: false });
    expect(r2[0]).toMatchObject({ ok: false });
    expect(r3[0]).toMatchObject({ ok: false });
  });

  it('有 askBridge 时：ask_user 返回回答，no_answer 附带假设继续提示', async () => {
    const ctx = {
      agent: 'dev',
      askBridge: {
        askUser: async () => ({ answer: '用 userId', noAnswer: false }),
        askAgent: async () => ({ noAnswer: true, reason: 'timeout' }),
        answer: async () => true,
      },
    };
    const r1 = await applyToolCalls('/ws', [{ tool: 'ask_user', question: '字段名？' } as any], ctx as any);
    expect(r1[0]).toMatchObject({ ok: true, answer: '用 userId' });
    const r2 = await applyToolCalls('/ws', [{ tool: 'ask_agent', to: 'review', question: '评审过了吗' } as any], ctx as any);
    expect(r2[0]).toMatchObject({ ok: false, no_answer: true });
    expect(String((r2[0] as any).hint)).toContain('假设');
  });
});

describe('ask API (POST /api/tasks/:taskId/asks/:askId/answer)', () => {
  function makeApp() {
    const config: AppConfig = {
      agents_dir: tmp,
      dashboard: { host: '127.0.0.1', port: 0 },
      model_pool: [{ name: 'fake-model', api_key: 'k', base_url: 'http://localhost:9', tags: ['code'] }],
      orchestrator: { max_retries: 1, sandbox: false, git: false, branch_workflow: false } as any,
      permissions: {},
      redis: { host: '127.0.0.1', port: 6399, db: 0 },
      knowledge: { dir: path.join(tmp, 'kb') },
    };
    const pool = new ModelPool(config.model_pool);
    return createApi({ config, orchestrator, modelPool: pool, taskQueue: new TaskQueueManager(orchestrator, pool) });
  }

  it('回答命中在飞等待；重复回答 400；未知 ask 404', async () => {
    const ask = await createAsk({ task_id: 't-api', from: 'dev', to: 'user', question: '在吗' });
    const w = waitForAnswer(ask.id, 't-api', 10000);
    const app = makeApp();
    const res = await app.request('/api/tasks/t-api/asks/' + ask.id + '/answer', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ answer: '在的' }),
    });
    expect(res.status).toBe(200);
    expect((await w).answer).toBe('在的');

    const res2 = await app.request('/api/tasks/t-api/asks/' + ask.id + '/answer', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ answer: '再答一次' }),
    });
    expect(res2.status).toBe(400);

    const res3 = await app.request('/api/tasks/t-api/asks/nope/answer', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ answer: 'x' }),
    });
    expect(res3.status).toBe(404);
  }, 15000);
});

describe('M2 端到端：任务管线内的实时问答闭环', () => {
  it('ask_user：agent 提问 → 用户 API 回答 → agent 拿到回答继续；journal 落 ask/answer 对', async () => {
    await saveTaskGraph('t-e2e', [makeNode('n1', 'dev')], [], { description: 'x', workspace: tmp, status: 'running' });
    behaviors.push(
      async () => ({ content: JSON.stringify({ tool_calls: [{ tool: 'ask_user', question: '主键字段用 userId 还是 user_id？' }] }) }),
      okFinal,
    );
    // 后台轮询 ask_created 事件并模拟用户回答
    const poller = setInterval(async () => {
      const ev = capturedEvents.find((e) => e.type === 'ask_created' && e.payload.task_id === 't-e2e');
      if (ev) {
        clearInterval(poller);
        await resolveAsk(String(ev.payload.ask_id), 't-e2e', '统一用 userId', 'user');
      }
    }, 10);
    try {
      const graph = (await getTaskGraph('t-e2e')) as TaskGraph;
      const result = await (orchestrator as any).runGraph('t-e2e', graph, tmp);
      expect(result.status).toBe('success');
    } finally {
      clearInterval(poller);
    }
    // journal 落了 ask 与 answer 成对气泡
    const journals = await getTaskJournals('t-e2e');
    const all = Object.values(journals).flat();
    const askEntry = all.find((e) => e.kind === 'ask');
    const answerEntry = all.find((e) => e.kind === 'answer');
    expect(askEntry).toBeTruthy();
    expect(answerEntry).toBeTruthy();
    expect(answerEntry!.meta?.ask_id).toBe(askEntry!.meta?.ask_id);
    expect(String(answerEntry!.text)).toContain('userId');
    // 第二次 chat 前的回答通过工具结果回喂给了模型
    const toolResultMsg = seenMessages[1]?.find((m) => m.role === 'user' && m.content.includes('工具执行结果'));
    expect(String(toolResultMsg?.content)).toContain('统一用 userId');
  }, 20000);

  it('ask_agent 目标执行中：并发双节点实时投递 → 目标用 answer 工具回答 → 提问方拿到结果', async () => {
    // n1（提问方）与 n2（目标）并发执行——n1 阻塞等回答时，n2 在自己的轮间消费点收到提问。
    // 并发交错不确定，按消息内容路由行为而不是按调用顺序。
    await saveTaskGraph('t-live', [makeNode('n1', 'dev'), makeNode('n2', 'dev')], [], { description: 'x', workspace: tmp, status: 'running' });
    let askIdSeen = '';
    const dispatcher = async (messages: { role: string; content: string }[]) => {
      const firstUser = messages.find((m) => m.role === 'user') || { content: '' };
      console.log('[DBG] call isN1=' + firstUser.content.includes('任务: n1') + ' last=' + String(messages[messages.length - 1]?.content || '').slice(0, 70).split('\n').join(' '));
      const isN1 = firstUser.content.includes('任务: n1');
      const last = messages[messages.length - 1];
      const lastContent = String(last?.content || '');
      if (isN1) {
        // n1：首轮发起 ask_agent（目标 n2 同名 agent 正在执行 → 实时投递）；拿到回答后 final
        if (lastContent.includes('工具执行结果')) return okFinal;
        return { content: JSON.stringify({ tool_calls: [{ tool: 'ask_agent', to: 'dev', question: '我刚写的工具函数叫什么名字？' }] }) };
      }
      // n2：收到实时提问（注入消息）→ 解析 ask_id 并回答
      const m = lastContent.match(/ask_id=(\w+)/);
      if (m) {
        askIdSeen = m[1];
        return { content: JSON.stringify({ tool_calls: [{ tool: 'answer', ask_id: m[1], content: '叫 formatUserId' }] }) };
      }
      // n2 首轮：等 n1 的提问入队（制造稳定交错），然后请求工具调用制造轮间消费点
      if (!lastContent.includes('工具执行结果')) {
        // 等 n1 把提问写进消费队列（ask_created 事件先于队列写入，不能作为信号）
        for (let i = 0; i < 500; i++) {
          const q = await busGet<any[]>('task:askq:t-live:dev');
          if (q && q.length) break;
          await sleep(10);
        }
        return { content: JSON.stringify({ tool_calls: [{ tool: 'read_file', path: 'x.txt' }] }) };
      }
      return okFinal;
    };
    for (let i = 0; i < 10; i++) behaviors.push(dispatcher); // 并发 chat 共享分派器，防抢 shift
    const graph = (await getTaskGraph('t-live')) as TaskGraph;
    const result = await (orchestrator as any).runGraph('t-live', graph, tmp);
    expect(result.status).toBe('success');
    expect(askIdSeen).toBeTruthy();
    // 某轮工具结果消息中包含回答文本
    const allMsgs = seenMessages.flat().filter((m) => m.role === 'user' && m.content.includes('工具执行结果'));
    expect(allMsgs.some((m) => m.content.includes('formatUserId'))).toBe(true);
    const journals = await getTaskJournals('t-live');
    const all = Object.values(journals).flat();
    expect(all.some((e) => String(e.meta?.delivered) === 'live')).toBe(true);
  }, 30000);

  it('ask_agent 目标空闲：走图外咨询（consult dispatch 不建节点）', async () => {
    await saveTaskGraph('t-consult', [makeNode('n1', 'dev')], [], { description: 'x', workspace: tmp, status: 'running' });
    behaviors.push(
      // n1 第 1 轮：ask_agent（目标 review 空闲 → 图外咨询）
      async () => ({ content: JSON.stringify({ tool_calls: [{ tool: 'ask_agent', to: 'review', question: '这个写法有性能问题吗' }] }) }),
      // 咨询 dispatch 是第二次 chat 调用
      () => ({ content: '没有明显性能问题，建议加个索引' }),
      // n1 第 2 轮：拿到回答 → final
      okFinal,
    );
    const graph = (await getTaskGraph('t-consult')) as TaskGraph;
    const result = await (orchestrator as any).runGraph('t-consult', graph, tmp);
    expect(result.status).toBe('success');
    // 咨询调用带"临时咨询模式"系统提示
    const consultCall = seenMessages.find((ms) => ms.some((m) => m.role === 'system' && m.content.includes('临时咨询模式')));
    expect(consultCall).toBeTruthy();
    // 回答通过 resolveAsk 回喂给提问方
    const allMsgs = seenMessages.flat().filter((m) => m.role === 'user' && m.content.includes('工具执行结果'));
    expect(allMsgs.some((m) => m.content.includes('建议加个索引'))).toBe(true);
  }, 20000);
});
