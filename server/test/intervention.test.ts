import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// stub the LLM so the real callAgent runs; captured messages let tests assert
// what the agent actually received (interventions ride inside the userMsg).
// behaviors 队列驱动：每次 chat 调用依次弹出对应脚本（缺省=直接成功），可注入 mid-round 副作用
const seenMessages: { role: string; content: string }[][] = [];
type Behavior = ((messages: { role: string; content: string }[]) => { content: string } | Promise<{ content: string }>) | undefined;
const behaviors: Behavior[] = [];
const okFinal = { content: JSON.stringify({ status: 'success', summary: 'done', verification: '已逐项核对产出与任务要求', changes: ['x.txt: ok'], errors: [] }) };
vi.mock('../src/llm', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/llm')>();
  return {
    ...actual,
    chat: async (_entry: any, messages: { role: string; content: string }[]) => {
      seenMessages.push(messages.map((m) => ({ ...m })));
      const b = behaviors.shift();
      const r = b ? await b(messages) : okFinal;
      return { content: r.content, promptTokens: 3, completionTokens: 4 };
    },
  };
});

import { initBus, closeBus, getBus } from '../src/bus';
import { ModelPool } from '../src/scheduler';
import { Orchestrator } from '../src/orchestrator/orchestrator';
import { createApi } from '../src/api';
import { TaskQueueManager } from '../src/taskQueue';
import type { AppConfig } from '../src/config';
import {
  saveTaskGraph,
  getTaskGraph,
  pushIntervention,
  consumeInterventions,
  getTaskJournals,
  deleteTask,
} from '../src/store';
import type { TaskGraph, TaskNode } from '../src/types';

let tmp: string;
let orchestrator: Orchestrator;
let capturedEvents: { type: string; payload: Record<string, unknown> }[] = [];

beforeEach(async () => {
  process.env.COTEAM_FORCE_MEMORY = '1';
  closeBus();
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-interv-'));
  const devDir = path.join(tmp, 'dev');
  fs.mkdirSync(devDir, { recursive: true });
  fs.writeFileSync(path.join(devDir, 'agent.yaml'), 'name: dev\ntags: [code]\nrole: 开发\n');
  await initBus({ host: '127.0.0.1', port: 6399, db: 0 });
  seenMessages.length = 0;
  behaviors.length = 0;
  capturedEvents = [];
  getBus().subscribe('coteam:dashboard', (msg: any) => capturedEvents.push(msg));
  const pool = new ModelPool([{ name: 'fake-model', api_key: 'k', base_url: 'http://localhost:9', tags: ['code'] }]);
  orchestrator = new Orchestrator({
    agentsDir: tmp, modelPool: pool, policy: { whitelistCommands: null, maxTimeSec: 10 },
    maxRetries: 1, sandboxEnabled: false, gitEnabled: false, branchWorkflow: false,
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

describe('intervention queue (store layer)', () => {
  it('push then consume returns messages and clears the queue', async () => {
    await pushIntervention('t-q', '请改用 Redis 缓存');
    await pushIntervention('t-q', '注意处理并发');
    const first = await consumeInterventions('t-q');
    expect(first.map((m) => m.message)).toEqual(['请改用 Redis 缓存', '注意处理并发']);
    expect(first[0].id).toBeTruthy();
    expect(first[0].ts).toBeTruthy();
    const second = await consumeInterventions('t-q');
    expect(second).toEqual([]);
  });

  it('consume on an empty queue is a no-op', async () => {
    expect(await consumeInterventions('t-none')).toEqual([]);
  });

  it('deleteTask clears the pending intervention queue', async () => {
    await pushIntervention('t-del', 'will be dropped');
    await deleteTask('t-del');
    expect(await consumeInterventions('t-del')).toEqual([]);
  });
});

describe('intervention injection (real callAgent via runGraph)', () => {
  it('injects pending interventions into the userMsg, consumes the queue and journals the trace', async () => {
    const nodes = [makeNode('n1', 'dev')];
    await saveTaskGraph('t-inj', nodes, [], { description: 'x', workspace: tmp, status: 'running' });
    await pushIntervention('t-inj', '请务必使用 TypeScript strict 模式');
    await pushIntervention('t-inj', '补充：必须覆盖边界情况');

    const graph = (await getTaskGraph('t-inj')) as TaskGraph;
    await (orchestrator as any).runGraph('t-inj', graph, tmp);

    // the agent received both interventions inside the userMsg
    const userContents = seenMessages.flat().filter((m) => m.role === 'user').map((m) => m.content);
    const allUser = userContents.join('\n');
    expect(allUser).toContain('用户插话');
    expect(allUser).toContain('请务必使用 TypeScript strict 模式');
    expect(allUser).toContain('补充：必须覆盖边界情况');

    // queue is emptied after consumption
    expect(await consumeInterventions('t-inj')).toEqual([]);

    // journal carries the injection trace
    const journals = await getTaskJournals('t-inj');
    const devJournal = journals['dev'] || [];
    const trace = devJournal.find((e) => e.kind === 'intervene');
    expect(trace).toBeTruthy();
    expect(trace!.text).toContain('n1');
    expect(trace!.meta?.interventions).toContain('请务必使用 TypeScript strict 模式');
    // 送达回执只陈述事实（群聊化纪律：不替 agent 表态）
    expect(trace!.text).toContain('已送达');
    expect(trace!.meta?.delivered).toBeTruthy();
    expect(capturedEvents.some((e) => e.type === 'intervention_injected' && e.payload.task_id === 't-inj')).toBe(true);

    // the brief (master briefing) contains the intervention block too
    const brief = devJournal.find((e) => e.kind === 'brief');
    expect(brief!.text).toContain('用户插话');

    // node completed through the normal pipeline
    const after = (await getTaskGraph('t-inj')) as TaskGraph;
    expect(after.nodes[0].status).toBe('completed');
  });

  it('no pending interventions → userMsg has no intervention block', async () => {
    const nodes = [makeNode('n1', 'dev')];
    await saveTaskGraph('t-noinj', nodes, [], { description: 'x', workspace: tmp, status: 'running' });

    const graph = (await getTaskGraph('t-noinj')) as TaskGraph;
    await (orchestrator as any).runGraph('t-noinj', graph, tmp);

    const allUser = seenMessages.flat().filter((m) => m.role === 'user').map((m) => m.content).join('\n');
    expect(allUser).not.toContain('用户插话');

    const journals = await getTaskJournals('t-noinj');
    expect((journals['dev'] || []).some((e) => e.kind === 'intervene')).toBe(false);
  });

  it('interventions sent mid-run are delivered on the agent round, not lost (queue stays until consumed)', async () => {
    // push AFTER the task ran — nothing consumed it, the queue must still hold it
    await pushIntervention('t-late', '任务结束后的指示应保留在队列中');
    const q = await consumeInterventions('t-late');
    expect(q.map((m) => m.message)).toEqual(['任务结束后的指示应保留在队列中']);
  });
});

describe('intervention API (POST /api/tasks/:taskId/intervene)', () => {
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

  it('queues the message, writes a journal intervene entry and broadcasts user_intervened', async () => {
    await saveTaskGraph('t-api', [makeNode('n1', 'dev')], [], { description: 'x', workspace: tmp, status: 'running' });
    const app = makeApp();
    const res = await app.request('/api/tasks/t-api/intervene', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: '请把日志改成 JSON 格式输出' }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('queued');
    expect(body.intervention_id).toBeTruthy();
    // queued for the next round
    const q = await consumeInterventions('t-api');
    expect(q.map((m) => m.message)).toEqual(['请把日志改成 JSON 格式输出']);
    // journal has the master-side intervene bubble
    const journals = await getTaskJournals('t-api');
    const entry = (journals['orchestrator'] || []).find((e) => e.kind === 'intervene');
    expect(entry).toBeTruthy();
    expect(entry!.text).toBe('请把日志改成 JSON 格式输出');
    // broadcast went out over the dashboard channel
    expect(capturedEvents.some((e) => e.type === 'user_intervened' && e.payload.task_id === 't-api')).toBe(true);
  });

  it('rejects intervention on a task that is not running', async () => {
    await saveTaskGraph('t-done', [makeNode('n1', 'dev')], [], { description: 'x', workspace: tmp, status: 'success' });
    const app = makeApp();
    const res = await app.request('/api/tasks/t-done/intervene', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'nope' }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.detail).toContain('not running');
    expect(await consumeInterventions('t-done')).toEqual([]);
  });

  it('rejects an empty message with 400', async () => {
    await saveTaskGraph('t-empty', [makeNode('n1', 'dev')], [], { description: 'x', workspace: tmp, status: 'running' });
    const app = makeApp();
    const res = await app.request('/api/tasks/t-empty/intervene', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: '   ' }),
    });
    expect(res.status).toBe(400);
  });

  it('404s for an unknown task', async () => {
    const app = makeApp();
    const res = await app.request('/api/tasks/no-such/intervene', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'hello' }),
    });
    expect(res.status).toBe(404);
  });
});

// ---------- 群聊化批次一：轮间注入 / 真实回应 / 接力 / 不吞话 ----------

describe('group-chat batch 1', () => {
  it('interventions arriving mid-round are injected between tool rounds with a delivery ack', async () => {
    await saveTaskGraph('t-mid', [makeNode('n1', 'dev')], [], { description: 'x', workspace: tmp, status: 'running' });
    behaviors.push(
      // 第 1 轮：请求工具调用；执行中用户插话（attempt 开头已消费过，这条只能被轮间检查捞到）
      async () => {
        await pushIntervention('t-mid', '执行中插话：记得加错误处理');
        return { content: JSON.stringify({ tool_calls: [{ tool: 'read_file', path: 'nothing.txt' }] }) };
      },
      () => okFinal,
    );
    const graph = (await getTaskGraph('t-mid')) as TaskGraph;
    await (orchestrator as any).runGraph('t-mid', graph, tmp);

    // 第二次 chat 调用的最后一条 user 消息 = 工具结果 + 插话块
    const secondCall = seenMessages[1];
    expect(secondCall).toBeTruthy();
    const lastUser = [...secondCall].reverse().find((m) => m.role === 'user')!;
    expect(lastUser.content).toContain('用户插话');
    expect(lastUser.content).toContain('记得加错误处理');
    expect(lastUser.content).toContain('reply_to_user');

    // 送达回执：第 2 轮注入的灰条事实陈述 + 事件
    const journals = await getTaskJournals('t-mid');
    const ack = (journals['dev'] || []).find((e) => e.kind === 'intervene' && (e.meta as any)?.delivered?.round === 2);
    expect(ack).toBeTruthy();
    expect(ack!.text).toContain('已送达');
    expect(ack!.text).not.toContain('收到');
    expect(capturedEvents.some((e) => e.type === 'intervention_injected' && (e.payload as any).round === 2)).toBe(true);
  });

  it('reply_to_user lands as a direct bubble; intervene_defer re-queues for later nodes', async () => {
    await saveTaskGraph('t-reply', [makeNode('n1', 'dev')], [], { description: 'x', workspace: tmp, status: 'running' });
    await pushIntervention('t-reply', '加个导出按钮');
    await pushIntervention('t-reply', '这个数据模型该改');
    behaviors.push(() => ({
      content: JSON.stringify({
        status: 'success', summary: 'ok', verification: 'v', changes: [],
        reply_to_user: '导出按钮本轮已加上；数据模型改动超出本节点范围，已接力',
        intervene_defer: ['这个数据模型该改'],
      }),
    }));
    const graph = (await getTaskGraph('t-reply')) as TaskGraph;
    await (orchestrator as any).runGraph('t-reply', graph, tmp);

    const journals = await getTaskJournals('t-reply');
    const direct = (journals['dev'] || []).find((e) => e.kind === 'message' && (e.meta as any)?.direct);
    expect(direct).toBeTruthy();
    expect(direct!.text).toContain('导出按钮');
    expect((direct!.meta as any).to).toBe('user');
    expect(capturedEvents.some((e) => e.type === 'agent_message' && (e.payload as any).direct === true)).toBe(true);

    // defer 条目回队接力 + 「↻」灰条 + 事件
    const q = await consumeInterventions('t-reply');
    expect(q.some((m) => m.message.includes('接力') && m.message.includes('这个数据模型该改'))).toBe(true);
    const relay = (journals['dev'] || []).find((e) => (e.meta as any)?.deferred);
    expect(relay).toBeTruthy();
    expect(capturedEvents.some((e) => e.type === 'intervention_deferred')).toBe(true);
  });

  it('interventions are re-queued when the attempt fails — model trouble never swallows user words', async () => {
    await saveTaskGraph('t-fail', [makeNode('n1', 'dev')], [], { description: 'x', workspace: tmp, status: 'running' });
    await pushIntervention('t-fail', '别动数据库配置');
    // 所有尝试都失败（maxRetries=1 → 两次 attempt，每次都消费再回队）
    const failContent = { content: JSON.stringify({ status: 'failed', summary: 'x', verification: 'v', errors: ['缺权限'] }) };
    behaviors.push(() => failContent, () => failContent, () => failContent, () => failContent);
    const graph = (await getTaskGraph('t-fail')) as TaskGraph;
    await (orchestrator as any).runGraph('t-fail', graph, tmp);

    const after = (await getTaskGraph('t-fail')) as TaskGraph;
    expect(after.nodes[0].status).toBe('failed');
    const q = await consumeInterventions('t-fail');
    expect(q.length).toBeGreaterThan(0);
    expect(q.some((m) => m.message.includes('重放') && m.message.includes('别动数据库配置'))).toBe(true);
  });
});
