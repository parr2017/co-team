import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// LLM stub：behaviors 队列驱动（与 askGate.test.ts 同模式）。signal.aborted 时立即抛错（打断语义）。
type Behavior = ((entryName: string) => Promise<{ content: string }> | { content: string }) | undefined;
const behaviors: Behavior[] = [];
let chatCalls = 0;
vi.mock('../src/llm', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/llm')>();
  return {
    ...actual,
    chat: async (entry: any, _messages: unknown, _mt?: number, _temp?: number, signal?: AbortSignal) => {
      chatCalls++;
      if (signal?.aborted) throw new Error('LLM 调用被外部取消');
      const b = behaviors.shift();
      const run = () => (b ? b(String(entry?.name || '')) : Promise.resolve({ content: JSON.stringify({ reply: '（无行为）' }) }));
      if (!signal) return run();
      // 挂起的行为也要能被 abort 打断（与真实 chatStreamed 的外部取消语义一致）
      return Promise.race([
        Promise.resolve().then(run),
        new Promise<never>((_, rej) => { signal.addEventListener('abort', () => rej(new Error('LLM 调用被外部取消')), { once: true }); }),
      ]);
    },
  };
});

import { initBus, closeBus, getBus, busGet } from '../src/bus';
import { ModelPool } from '../src/scheduler';
import { Orchestrator } from '../src/orchestrator/orchestrator';
import type { Logger } from '../src/logger';
import * as convo from '../src/convo';
import type { ConvoDeps } from '../src/convo';
import { saveProject } from '../src/store';
import { simpleGit } from 'simple-git';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const fakeLogger: Logger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } as unknown as Logger;

let tmp: string;
let ws: string;
let deps: ConvoDeps;

const toolCalls = (calls: Record<string, unknown>[]) => ({ content: JSON.stringify({ tool_calls: calls }) });
const reply = (text: string) => ({ content: JSON.stringify({ reply: text }) });

beforeEach(async () => {
  process.env.COTEAM_FORCE_MEMORY = '1';
  closeBus();
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-convo-'));
  ws = path.join(tmp, 'proj');
  fs.mkdirSync(ws, { recursive: true });
  fs.writeFileSync(path.join(ws, 'hello.txt'), 'hello\n');
  // partner agent（真实 agents 目录发现路径）
  const agentsDir = path.join(tmp, 'agents');
  fs.mkdirSync(path.join(agentsDir, 'partner'), { recursive: true });
  fs.writeFileSync(path.join(agentsDir, 'partner', 'agent.yaml'), 'name: partner\ntags: [code]\nrole: 搭档\n');
  fs.writeFileSync(path.join(agentsDir, 'partner', 'prompt.md'), '你是搭档（测试版）。');

  await initBus({ host: '127.0.0.1', port: 6399, db: 0 });
  await saveProject({ id: 'p1', name: '测试项目', workspace: ws, created_at: new Date().toISOString() });
  const pool = new ModelPool([
    { id: 'fake-model', name: 'fake-model', api_key: 'k', base_url: 'http://localhost:9', tags: ['code'], priority: 1 },
    { id: 'fake-model-2', name: 'fake-model-2', api_key: 'k', base_url: 'http://localhost:9', tags: ['code'], priority: 2 },
  ]);
  const orchestrator = new Orchestrator({
    agentsDir, modelPool: pool, policy: { level: 'full', whitelistCommands: null, maxTimeSec: 10 },
    maxRetries: 1, sandboxEnabled: false, gitEnabled: false, branchWorkflow: false,
  });
  await orchestrator.loadAgents();
  deps = { orchestrator, pool, logger: fakeLogger };
  behaviors.length = 0;
  chatCalls = 0;
  convo.configureConvo({ permissions: { level: 'full' }, ask_timeout_sec: 2 });
  getBus().subscribe('coteam:dashboard', () => {});
});

afterEach(async () => {
  await closeBus();
  fs.rmSync(tmp, { recursive: true, force: true });
});

/** 等 status 变为指定值（轮询，超时 3s） */
async function waitForStatus(convoId: string, status: string, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const c = await convo.getConvo(convoId);
    if (c?.status === status) return;
    await sleep(20);
  }
  throw new Error(`status never reached ${status}`);
}

/** 等谓词成立（轮询） */
async function waitFor(pred: () => Promise<boolean>, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await pred()) return;
    await sleep(20);
  }
  throw new Error('condition never reached');
}

describe('convo 引擎', () => {
  it('创建会话（项目绑定 + 模型 pin）+ 基础 turn：工具执行 → 最终回复 → 首轮快照', async () => {
    // git 仓库 → 首轮快照应产生
    await simpleGit({ baseDir: ws }).init();
    const c = await convo.createConvo(deps, { project_id: 'p1', title: '修文件', model_id: 'fake-model' });
    expect(c.workspace).toBe(ws);
    expect(c.agent_id).toBe('partner');

    behaviors.push(() => toolCalls([{ tool: 'write_file', path: 'hello.txt', content: 'world\n' }]));
    behaviors.push(() => reply('已把 hello.txt 改为 world。'));
    await convo.sendConvoMessage(deps, c.id, { text: '把 hello.txt 改成 world' }, { trigger: false });
    await convo.runResponseLoop(deps, c.id);

    const msgs = await convo.getConvoMessages(c.id);
    const kinds = msgs.map((m) => m.kind);
    expect(kinds).toContain('tool');
    expect(kinds).toContain('diff'); // git 仓库 + 有写入 → diff 卡片
    const finalText = msgs.filter((m) => m.kind === 'text' && m.role === 'assistant').pop();
    expect(finalText?.kind).toBe('text');
    expect(finalText?.model).toBe('fake-model');
    expect(fs.readFileSync(path.join(ws, 'hello.txt'), 'utf-8')).toBe('world\n'); // 直接写入工作区
    const live = await convo.getConvo(c.id);
    expect(live?.snapshot_id).toBeTruthy(); // 首轮自动快照
    expect(live?.status).toBe('idle');
  }, 20000);

  it('排队插话：busy 时第二条消息入队，turn 结束后自动消费', async () => {
    const c = await convo.createConvo(deps, { project_id: 'p1', model_id: 'fake-model' });
    // turn1：慢行为（挂 250ms）后直接回复
    behaviors.push(async () => { await sleep(250); return reply('第一轮完成'); });
    await convo.sendConvoMessage(deps, c.id, { text: '第一条消息' }, { trigger: false });
    const loop = convo.runResponseLoop(deps, c.id).catch(() => {});
    await waitForStatus(c.id, 'running');
    // busy 中排队第二条
    const r = await convo.sendConvoMessage(deps, c.id, { text: '第二条插话' });
    expect(r.queued).toBe(true);
    await loop;
    await convo.runResponseLoop(deps, c.id).catch(() => {});
    // 循环兜底重触发会消费队列；等待 user2 得到回复
    await waitFor(async () => {
      const msgs = await convo.getConvoMessages(c.id);
      return msgs.filter((m) => m.role === 'user' && m.kind === 'text').length >= 2
        && msgs[msgs.length - 1].role === 'assistant';
    });
    let msgs = await convo.getConvoMessages(c.id);
    expect(msgs.filter((m) => m.role === 'user' && (m as any).text === '第二条插话').length).toBe(1);
    // loop1 finally 重触发是异步的——轮询等消费完成（标记清除 = turn2 已开跑）
    await waitFor(async () => {
      const ms = await convo.getConvoMessages(c.id);
      return ms.find((m) => (m as any).text === '第二条插话')?.meta?.queued === false;
    });
    msgs = await convo.getConvoMessages(c.id);
    expect(msgs[msgs.length - 1].kind).toBe('text'); // 第二轮的回复
    const live = await convo.getConvo(c.id);
    expect(live?.status).toBe('idle');
  }, 20000);

  it('立即插入：busy 中发消息自动入队 → promote 打断 → 队列消息立即处理 + queued 标记清除', async () => {
    const c = await convo.createConvo(deps, { project_id: 'p1', model_id: 'fake-model' });
    behaviors.push(() => new Promise(() => { /* 挂起直到 promote 打断 */ }));
    await convo.sendConvoMessage(deps, c.id, { text: '开始干活' }, { trigger: false });
    const loop = convo.runResponseLoop(deps, c.id).catch(() => {});
    await waitForStatus(c.id, 'running');
    // busy 中发消息：无 mode 参数，自动入队（meta.queued）
    const r = await convo.sendConvoMessage(deps, c.id, { text: '别做了，先做别的' });
    expect(r.queued).toBe(true);
    let msgs = await convo.getConvoMessages(c.id);
    expect(msgs.find((m) => m.text === '别做了，先做别的')?.meta?.queued).toBe(true);
    // turn2 的应答提前入队（promote 打断后 loop1 内部就会自动消费排队消息）
    behaviors.push(() => reply('收到，已切换到新指令。'));
    // 排队气泡上的「立即插入」→ promote：打断当前 turn，队列消息立即处理
    const pr = await convo.promoteConvoMessage(deps, c.id);
    expect(pr.promoted).toBe(true);
    expect(pr.interrupted).toBe(true);
    await loop;
    // promote 后队列消息由重触发异步消费——轮询等回复落屏
    await waitFor(async () => {
      const ms = await convo.getConvoMessages(c.id);
      return ms.some((m) => m.kind === 'interrupt')
        && ms.filter((x) => x.role === 'assistant' && x.kind === 'text').some((x) => x.text.includes('切换到新指令'))
        && ms.find((m) => m.text === '别做了，先做别的')?.meta?.queued === false;
    }, 8000);
    msgs = await convo.getConvoMessages(c.id);
    expect(msgs[msgs.length - 1].kind).toBe('text');
    expect((await convo.getConvo(c.id))?.status).toBe('idle');
  }, 20000);

  it('promote 空闲 no-op：无队列残留不误触发', async () => {
    const c = await convo.createConvo(deps, { project_id: 'p1', model_id: 'fake-model' });
    const r = await convo.promoteConvoMessage(deps, c.id);
    expect(r.promoted).toBe(false);
    expect(r.interrupted).toBe(false);
  }, 20000);

  it('approve_required：非白名单命令 park → 批准一次后执行', async () => {
    convo.configureConvo({ permissions: { level: 'approve_required', whitelist_commands: [] } });
    const c = await convo.createConvo(deps, { project_id: 'p1', model_id: 'fake-model' });
    behaviors.push(() => toolCalls([{ tool: 'exec', command: `node -e "console.log('ran-approval')"` }]));
    behaviors.push(() => reply('命令已执行。'));
    await convo.sendConvoMessage(deps, c.id, { text: '跑个命令' }, { trigger: false });
    const loop = convo.runResponseLoop(deps, c.id).catch(() => {});
    await waitFor(() => convo.listPendingApprovals(c.id).then((l) => l.length > 0));
    const [pending] = await convo.listPendingApprovals(c.id);
    expect((await convo.getConvo(c.id))?.status).toBe('waiting_approval');
    await convo.resolveConvoApproval(deps, c.id, pending.id, 'once');
    await loop;
    const msgs = await convo.getConvoMessages(c.id);
    const toolMsg = msgs.find((m) => m.kind === 'tool');
    expect(String(toolMsg?.text)).toContain('✓ exec');
    expect(msgs[msgs.length - 1].kind).toBe('text');
  }, 20000);

  it('「本会话总是允许」：同前缀命令第二次不再询问', async () => {
    convo.configureConvo({ permissions: { level: 'approve_required', whitelist_commands: [] } });
    const c = await convo.createConvo(deps, { project_id: 'p1', model_id: 'fake-model' });
    behaviors.push(() => toolCalls([{ tool: 'exec', command: 'node -e "console.log(1)"' }]));
    behaviors.push(() => reply('第一轮完成'));
    await convo.sendConvoMessage(deps, c.id, { text: '第一轮命令' }, { trigger: false });
    const loop1 = convo.runResponseLoop(deps, c.id).catch(() => {});
    await waitFor(() => convo.listPendingApprovals(c.id).then((l) => l.length > 0));
    const [p1] = await convo.listPendingApprovals(c.id);
    await convo.resolveConvoApproval(deps, c.id, p1.id, 'always');
    await loop1;
    // 第二轮：同前缀命令直接执行（无新审批产生）
    behaviors.push(() => toolCalls([{ tool: 'exec', command: 'node -e "console.log(1)"' }]));
    behaviors.push(() => reply('第二轮完成'));
    await convo.sendConvoMessage(deps, c.id, { text: '第二轮同前缀命令' }, { trigger: false });
    await convo.runResponseLoop(deps, c.id);
    const approvals = await convo.listPendingApprovals(c.id);
    expect(approvals.length).toBe(0);
    const msgs = await convo.getConvoMessages(c.id);
    expect(msgs.filter((m) => m.kind === 'approval').length).toBe(1); // 只有第一次 park
  }, 20000);

  it('ask_user 阻塞提问：等待回答 → 回答后继续收尾', async () => {
    const c = await convo.createConvo(deps, { project_id: 'p1', model_id: 'fake-model' });
    behaviors.push(() => toolCalls([{ tool: 'ask_user', question: '用 A 还是 B？' }]));
    behaviors.push(() => reply('已按你的选择继续。'));
    await convo.sendConvoMessage(deps, c.id, { text: '帮我决定下' }, { trigger: false });
    const loop = convo.runResponseLoop(deps, c.id).catch(() => {});
    await waitFor(() => convo.listPendingAsks(c.id).then((l) => l.length > 0));
    expect((await convo.getConvo(c.id))?.status).toBe('waiting_ask');
    await convo.answerConvoAsk(deps, c.id, (await convo.listPendingAsks(c.id))[0].id, '用 B');
    await loop;
    const msgs = await convo.getConvoMessages(c.id);
    expect(msgs[msgs.length - 1].kind).toBe('text');
    const askMsg = msgs.find((m) => m.kind === 'ask');
    expect(askMsg?.meta?.status).toBe('answered');
  }, 20000);

  it('模型失败自动降级：主模型 429 → 链上第二模型接管并落降级卡片（pin 不变）', async () => {
    const c = await convo.createConvo(deps, { project_id: 'p1', model_id: 'fake-model' });
    behaviors.push(async (entryName) => {
      if (entryName === 'fake-model') throw new Error('429 rate limit');
      return reply('备用模型回复');
    });
    await convo.sendConvoMessage(deps, c.id, { text: '随便说点什么' }, { trigger: false });
    await convo.runResponseLoop(deps, c.id);
    const msgs = await convo.getConvoMessages(c.id);
    const degrade = msgs.find((m) => m.kind === 'degrade');
    expect(degrade).toBeTruthy();
    expect(String(degrade?.text)).toContain('fake-model-2');
    const finalMsg = msgs[msgs.length - 1];
    expect(finalMsg.model).toBe('fake-model-2'); // 实际应答模型
    expect((await convo.getConvo(c.id))?.model_id).toBe('fake-model'); // pin 不变
  }, 20000);

  it('打断连带作废在飞审批：被打断的旧命令不会在下一轮复活', async () => {
    convo.configureConvo({ permissions: { level: 'approve_required', whitelist_commands: [] } });
    const c = await convo.createConvo(deps, { project_id: 'p1', model_id: 'fake-model' });
    behaviors.push(() => toolCalls([{ tool: 'exec', command: 'node old.js' }]));
    await convo.sendConvoMessage(deps, c.id, { text: '跑旧命令' }, { trigger: false });
    const loop = convo.runResponseLoop(deps, c.id).catch(() => {});
    await waitFor(() => convo.listPendingApprovals(c.id).then((l) => l.length > 0));
    await convo.interruptConvo(deps, c.id);
    await loop;
    const approvals = await convo.listPendingApprovals(c.id);
    expect(approvals.length).toBe(0); // 在飞审批已被打断作废
  }, 20000);

  it('spawn_agent：子 agent 独立工具循环，活动卡与摘要落流并回注主循环', async () => {
    // 补一个 dev agent 供 spawn（beforeEach 只建了 partner；注册表需重载）
    fs.mkdirSync(path.join(tmp, 'agents', 'dev'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'agents', 'dev', 'agent.yaml'), 'name: dev\ntags: [code]\nrole: 开发\n');
    fs.writeFileSync(path.join(tmp, 'agents', 'dev', 'prompt.md'), '你是 dev。');
    await deps.orchestrator.loadAgents();
    // 主 agent：spawn dev 子 agent → 子 agent 写文件 → 主 agent 收到摘要后收尾
    behaviors.push(() => toolCalls([{ tool: 'spawn_agent', agent: 'dev', task: '把 notes 写进 TODO.md' }]));
    behaviors.push(() => toolCalls([{ tool: 'write_file', path: 'TODO.md', content: 'todo\n' }]));
    behaviors.push(() => ({ content: JSON.stringify({ reply: '子任务完成：TODO.md 已写入' }) }));
    behaviors.push(() => reply('子智能体已完成，摘要见上。'));
    const c = await convo.createConvo(deps, { project_id: 'p1', model_id: 'fake-model' });
    await convo.sendConvoMessage(deps, c.id, { text: '派个子智能体写 TODO' }, { trigger: false });
    await convo.runResponseLoop(deps, c.id);
    expect(fs.readFileSync(path.join(ws, 'TODO.md'), 'utf-8')).toBe('todo\n'); // 子 agent 真实写入
    const msgs = await convo.getConvoMessages(c.id);
    const subCards = msgs.filter((m) => m.kind === 'tool' && (m.meta as any)?.subagent === 'dev');
    expect(subCards.length).toBeGreaterThanOrEqual(2); // 开始卡 + 步骤/完成卡
    const doneCard = subCards[subCards.length - 1];
    expect((doneCard.meta as any).phase).toBe('done');
    expect(String((doneCard.meta as any).summary)).toContain('TODO.md');
    const finalText = msgs.filter((m) => m.role === 'assistant' && m.kind === 'text').pop();
    expect(finalText?.text).toContain('子智能体已完成');
  }, 20000);

  it('spawn_agent：不存在的 agent 软错误回喂', async () => {
    behaviors.push(() => toolCalls([{ tool: 'spawn_agent', agent: 'nope', task: 'x' }]));
    behaviors.push(() => reply('收到失败结果。'));
    const c = await convo.createConvo(deps, { project_id: 'p1', model_id: 'fake-model' });
    await convo.sendConvoMessage(deps, c.id, { text: '派个不存在的' }, { trigger: false });
    await convo.runResponseLoop(deps, c.id);
    const msgs = await convo.getConvoMessages(c.id);
    const toolMsg = msgs.find((m) => m.kind === 'tool');
    expect(String(toolMsg?.text)).toContain('失败');
  }, 20000);

  it('plan 步骤清单：write_plan 规划 → update_plan 打勾 → 自动推进下一步', async () => {
    const c = await convo.createConvo(deps, { project_id: 'p1', model_id: 'fake-model' });
    behaviors.push(() => toolCalls([
      { tool: 'write_plan', steps: ['读文件', '改代码', '跑测试'] },
      { tool: 'update_plan', index: 0, status: 'in_progress' },
    ]));
    behaviors.push(() => toolCalls([{ tool: 'update_plan', index: 0, status: 'done' }]));
    behaviors.push(() => reply('第一步完成，进度 1/3。'));
    await convo.sendConvoMessage(deps, c.id, { text: '做个多步任务' }, { trigger: false });
    await convo.runResponseLoop(deps, c.id);
    const live = await convo.getConvo(c.id);
    expect(live?.plan?.steps.length).toBe(3);
    expect(live?.plan?.steps[0].status).toBe('done');
    // 置 done 后自动推进：下一个 pending（读文件之后的「改代码」）应为 in_progress
    expect(live?.plan?.steps[1].status).toBe('in_progress');
    const msgs = await convo.getConvoMessages(c.id);
    expect(msgs.some((m) => m.kind === 'tool' && String(m.text).includes('规划 3 步'))).toBe(true);
    expect(msgs.some((m) => m.kind === 'tool' && String(m.text).includes('进度 1/3'))).toBe(true);
  }, 20000);

  it('plan 越界/未规划软错误回喂', async () => {
    const c = await convo.createConvo(deps, { project_id: 'p1', model_id: 'fake-model' });
    behaviors.push(() => toolCalls([{ tool: 'update_plan', index: 0, status: 'done' }]));
    behaviors.push(() => reply('好的。'));
    await convo.sendConvoMessage(deps, c.id, { text: '直接打勾' }, { trigger: false });
    await convo.runResponseLoop(deps, c.id);
    const msgs = await convo.getConvoMessages(c.id);
    const toolMsg = msgs.find((m) => m.kind === 'tool');
    expect(String(toolMsg?.text)).toContain('✗');
  }, 20000);

  it('长对话压缩：超阈值消息被 LLM 折叠为摘要，LLM 历史只保留摘要+之后消息', async () => {
    const c = await convo.createConvo(deps, { project_id: 'p1', model_id: 'fake-model' });
    // 造 65 条历史（含 1 条用户触发消息）
    const { busGet, busSet } = await import('../src/bus');
    const key = `convo:${c.id}:messages`;
    const list = (await busGet<any[]>(key)) || [];
    for (let i = 0; i < 65; i++) {
      list.push({ id: `m${i}`, role: i % 2 === 0 ? 'user' : 'assistant', kind: 'text', text: `历史消息 ${i}：约定 ${i} 号细节`, ts: new Date().toISOString() });
    }
    await busSet(key, list);
    // 压缩调用 = 第 1 次 chat；压缩后本 turn 的应答 = 第 2 次
    behaviors.push(() => ({ content: '压缩摘要：用户在做压缩测试，已铺垫 65 条历史。' }));
    behaviors.push(() => reply('我已基于摘要了解背景。'));
    await convo.sendConvoMessage(deps, c.id, { text: '继续对话' }, { trigger: false });
    await convo.runResponseLoop(deps, c.id);
    const live = await convo.getConvo(c.id);
    expect(live?.compaction).toBeTruthy();
    expect(String(live?.compaction?.summary)).toContain('压缩测试');
    // LLM 第二次调用（turn 应答）的消息里应带摘要前缀，且原文消息数量被裁剪
    const msgs = await convo.getConvoMessages(c.id);
    expect(msgs.some((m) => m.kind === 'notice' && m.text.includes('自动压缩'))).toBe(true);
  }, 30000);
});
