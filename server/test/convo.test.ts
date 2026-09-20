import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// LLM stub：behaviors 队列驱动（与 askGate.test.ts 同模式）。signal.aborted 时立即抛错（打断语义）。
type Behavior = ((entryName: string) => Promise<{ content: string }> | { content: string }) | undefined;
const behaviors: Behavior[] = [];
let chatCalls = 0;
let lastChatMessages: { role: string; content: unknown }[] = [];
let lastChatTools: unknown[] | undefined;
vi.mock('../src/llm', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/llm')>();
  return {
    ...actual,
    chat: async (entry: any, messages: unknown, _mt?: number, _temp?: number, signal?: AbortSignal, _cap?: number, _onDelta?: unknown, opts?: { tools?: unknown[] }) => {
      chatCalls++;
      lastChatMessages = (messages as { role: string; content: unknown }[]) || [];
      lastChatTools = opts?.tools;
      if (signal?.aborted) throw new Error('LLM 调用被外部取消');
      const b = behaviors.shift();
      const run = () => {
        const shape = Promise.resolve(b ? b(String(entry?.name || '')) : { content: JSON.stringify({ reply: '（无行为）' }) }) as Promise<{ content: string }>;
        return shape.then((s) => {
          // 原生 function calling 模式（convo 传了 tools）：JSON 契约形态的行为转换
          // 为供应商原生形态——tool_calls 走 res.toolCalls、reply 走正文
          if (opts?.tools?.length) {
            try {
              const parsed = JSON.parse(s.content);
              if (Array.isArray(parsed.tool_calls)) {
                return { content: '', toolCalls: parsed.tool_calls.map((tc: Record<string, unknown>) => ({ tool: tc.tool, ...tc })) };
              }
              if (parsed.reply !== undefined) return { content: String(parsed.reply) };
            } catch { /* 非 JSON 行为按原样返回 */ }
          }
          return s;
        });
      };
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
import { configureNativeTools } from '../src/toolSchema';
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
  lastChatMessages = [];
  lastChatTools = undefined;
  // JSON 文本契约路径（fallback）作为既有用例的基线；FC 路径在独立 describe 覆盖
  configureNativeTools(false);
  convo.configureConvo({ permissions: { level: 'full' }, ask_timeout_sec: 2, auto_retry_base_ms: 20 });
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

  it('模型失败自动降级（auto_switch 开）：主模型 429 → 链上第二模型接管并落降级卡片（pin 不变）', async () => {
    const c = await convo.createConvo(deps, { project_id: 'p1', model_id: 'fake-model' });
    await convo.updateConvo(deps, c.id, { auto_switch: true });
    for (let i = 0; i < 3; i++) {
      behaviors.push(async () => { throw new Error('429 rate limit'); });
    }
    behaviors.push(async () => reply('备用模型回复'));
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

  it('自动切换关（默认）：主模型失败自动重试 10 次全败 → 断连卡（不降级）', async () => {
    const c = await convo.createConvo(deps, { project_id: 'p1', model_id: 'fake-model' });
    let calls = 0;
    for (let i = 0; i < 10; i++) behaviors.push(async () => { calls++; throw new Error('429 rate limit'); });
    await convo.sendConvoMessage(deps, c.id, { text: '说话' }, { trigger: false });
    await convo.runResponseLoop(deps, c.id);
    expect(calls).toBe(10); // 自动重试 10 次（退避 20ms 注入）
    const msgs = await convo.getConvoMessages(c.id);
    const broken = msgs.find((m) => m.kind === 'degrade' && (m.meta as any)?.broken);
    expect(broken).toBeTruthy();
    expect(String(broken?.text)).toContain('10 次');
    expect(msgs.some((m) => m.kind === 'degrade' && (m.meta as any)?.actual)).toBe(false); // 未降级
  }, 20000);

  it('404 模型不存在：不重试直接报错（off）', async () => {
    const c = await convo.createConvo(deps, { project_id: 'p1', model_id: 'fake-model' });
    let calls = 0;
    behaviors.push(async () => { calls++; throw new Error('404 model is not found'); });
    await convo.sendConvoMessage(deps, c.id, { text: '说话' }, { trigger: false });
    await convo.runResponseLoop(deps, c.id);
    expect(calls).toBe(1); // 404 确定性错误不重试
    const msgs = await convo.getConvoMessages(c.id);
    const broken = msgs.find((m) => m.kind === 'degrade' && (m.meta as any)?.broken);
    expect(String(broken?.text)).toContain('404');
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

  it('空输出不会死循环：模型返回空 → 落 turn_complete 终态 notice，loop 正常收尾不再烧轮', async () => {
    const c = await convo.createConvo(deps, { project_id: 'p1', model_id: 'fake-model' });
    // 模型连续返回空内容（纯空串、无 JSON、无散文）
    for (let i = 0; i < 5; i++) behaviors.push(() => ({ content: '' }));
    await convo.sendConvoMessage(deps, c.id, { text: '说点什么' }, { trigger: false });
    await convo.runResponseLoop(deps, c.id);
    // loop 应只消费一条行为（第一轮就落终态退出），且不会用尽后续行为重跑
    expect(chatCalls).toBeLessThanOrEqual(1);
    const msgs = await convo.getConvoMessages(c.id);
    const terminal = msgs.filter((m) => m.kind === 'notice' && (m.meta as any)?.turn_complete);
    expect(terminal.length).toBe(1); // 只落一次终态 notice，未重复追加
    expect(msgs[msgs.length - 1].kind).toBe('notice');
    expect((await convo.getConvo(c.id))?.status).toBe('idle'); // busy 锁已释放
  }, 20000);

  it('非 JSON 散文不静默冒充成功回复：纠正重试仍散文 → 落 contract_violation + 违约 notice', async () => {
    const c = await convo.createConvo(deps, { project_id: 'p1', model_id: 'fake-model' });
    // 模型连续散文（纠正重试后仍违约）→ 采纳但明确标注
    behaviors.push(() => ({ content: '好的，我马上开始处理这个问题，先分析一下再动手。' }));
    behaviors.push(() => ({ content: '好的，这就去处理。' }));
    await convo.sendConvoMessage(deps, c.id, { text: '帮我修个 bug' }, { trigger: false });
    await convo.runResponseLoop(deps, c.id);
    const msgs = await convo.getConvoMessages(c.id);
    const replyMsg = msgs.find((m) => m.kind === 'text' && m.role === 'assistant');
    expect(replyMsg).toBeTruthy();
    expect((replyMsg?.meta as any)?.contract_violation).toBe(true); // 明确标注契约违约
    expect(msgs.some((m) => m.kind === 'notice' && m.text.includes('未按输出契约返回 JSON'))).toBe(true);
    expect((await convo.getConvo(c.id))?.status).toBe('idle');
  }, 20000);

  it('工具执行后的散文收尾：直接采纳（不重试白烧调用）且不落误报 notice', async () => {
    const c = await convo.createConvo(deps, { project_id: 'p1', model_id: 'fake-model' });
    // 第一批：真实工具调用；收尾：散文（轻微违约，但本轮已干活）
    behaviors.push(() => toolCalls([{ tool: 'write_file', path: 'done.txt', content: 'ok\n' }]));
    behaviors.push(() => ({ content: '三件事已全部完成，dir 确认文件都在。' }));
    await convo.sendConvoMessage(deps, c.id, { text: '干活' }, { trigger: false });
    await convo.runResponseLoop(deps, c.id);
    expect(chatCalls).toBe(2); // 工具轮 + 散文收尾直接采纳，无纠正重试
    expect(fs.readFileSync(path.join(ws, 'done.txt'), 'utf-8')).toBe('ok\n');
    const msgs = await convo.getConvoMessages(c.id);
    // 工具执行过的轮次，散文收尾不落违约 notice（E2E 实测误报修复）
    expect(msgs.some((m) => m.kind === 'notice' && m.text.includes('未执行任何实际改动'))).toBe(false);
    const finalMsg = msgs.filter((m) => m.kind === 'text' && m.role === 'assistant').pop();
    expect(finalMsg?.text).toContain('三件事已全部完成');
  }, 20000);

  it('会话级权限对写文件生效：会话切 readonly 后 write_file 被拒（不再沿用全局策略）', async () => {
    const c = await convo.createConvo(deps, { project_id: 'p1', model_id: 'fake-model' });
    // 全局 convo 配置是 full；但会话级策略切为 readonly
    await convo.updateConvo(deps, c.id, { policy_level: 'readonly' });
    behaviors.push(() => toolCalls([{ tool: 'write_file', path: 'hello.txt', content: 'should not be written\n' }]));
    behaviors.push(() => reply('收到。'));
    await convo.sendConvoMessage(deps, c.id, { text: '改文件' }, { trigger: false });
    await convo.runResponseLoop(deps, c.id);
    expect(fs.readFileSync(path.join(ws, 'hello.txt'), 'utf-8')).toBe('hello\n'); // 未被写入
    const msgs = await convo.getConvoMessages(c.id);
    const toolMsg = msgs.find((m) => m.kind === 'tool');
    expect(String(toolMsg?.text)).toContain('✗'); // 写文件被拒
  }, 20000);

  it('未 pin 时主模型按 professional_weight 选强模型（弱闲聊模型不再优先）', async () => {
    // 构造池：priority 更优但 professional_weight 低的弱模型 + 强模型
    const pool = new ModelPool([
      { id: 'weak', name: 'weak', api_key: 'k', base_url: 'http://localhost:9', tags: ['code'], priority: 1, professional_weight: 10 },
      { id: 'strong', name: 'strong', api_key: 'k', base_url: 'http://localhost:9', tags: ['code'], priority: 50, professional_weight: 95 },
    ]);
    const orchestrator = new Orchestrator({
      agentsDir: path.join(tmp, 'agents'), modelPool: pool, policy: { level: 'full', whitelistCommands: null, maxTimeSec: 10 },
      maxRetries: 1, sandboxEnabled: false, gitEnabled: false, branchWorkflow: false,
    });
    await orchestrator.loadAgents();
    const deps2 = { orchestrator, pool, logger: fakeLogger };
    const c = await convo.createConvo(deps2, { project_id: 'p1' }); // 不 pin 模型
    behaviors.push(() => reply('强模型回复'));
    await convo.sendConvoMessage(deps2, c.id, { text: '干活' }, { trigger: false });
    await convo.runResponseLoop(deps2, c.id);
    const msgs = await convo.getConvoMessages(c.id);
    const finalMsg = msgs.filter((m) => m.kind === 'text' && m.role === 'assistant').pop();
    expect(finalMsg?.model).toBe('strong'); // 强模型被选中
  }, 20000);

  it('OpenAI 函数风格 tool_calls 不再被静默丢弃：模型附嘴炮 reply 时工具仍真实执行', async () => {
    // 「光回复不干活」根因：模型发 {"reply":"正在写入...","tool_calls":[{"function":{"name":"write_file","arguments":"..."}}]}
    // 旧解析 filter(c.tool) 全丢弃 → 只显示 reply、工具没跑、模型以为已执行。
    const c = await convo.createConvo(deps, { project_id: 'p1', model_id: 'fake-model' });
    behaviors.push(() => ({
      content: JSON.stringify({
        reply: '正在写入实施计划并读取源码，读完立即改。',
        tool_calls: [
          { id: 'call_1', type: 'function', function: { name: 'write_file', arguments: JSON.stringify({ path: 'PLAN.md', content: '# 计划\n' }) } },
          { id: 'call_2', type: 'function', function: { name: 'read_file', arguments: JSON.stringify({ path: 'hello.txt' }) } },
        ],
      }),
    }));
    behaviors.push(() => reply('完成。'));
    await convo.sendConvoMessage(deps, c.id, { text: '都改了' }, { trigger: false });
    await convo.runResponseLoop(deps, c.id);
    // 工具必须真实执行（这正是旧代码丢掉的）
    expect(fs.readFileSync(path.join(ws, 'PLAN.md'), 'utf-8')).toBe('# 计划\n');
    const msgs = await convo.getConvoMessages(c.id);
    expect(msgs.some((m) => m.kind === 'tool' && String(m.text).includes('写入 PLAN.md'))).toBe(true);
    const finalMsg = msgs.filter((m) => m.kind === 'text' && m.role === 'assistant').pop();
    expect(finalMsg?.text).toBe('完成。');
  }, 20000);

  it('{"name":...} 平铺风格 tool_calls 同样执行', async () => {
    const c = await convo.createConvo(deps, { project_id: 'p1', model_id: 'fake-model' });
    behaviors.push(() => ({
      content: JSON.stringify({
        tool_calls: [{ name: 'write_file', arguments: '{"path":"notes.md","content":"n\\n"}' }],
      }),
    }));
    behaviors.push(() => reply('ok'));
    await convo.sendConvoMessage(deps, c.id, { text: '记一笔' }, { trigger: false });
    await convo.runResponseLoop(deps, c.id);
    expect(fs.readFileSync(path.join(ws, 'notes.md'), 'utf-8')).toBe('n\n');
  }, 20000);

  it('引擎级自纠错：纯散文先纠正重试——模型改发 tool_calls 则真实执行且不落违约 notice', async () => {
    const c = await convo.createConvo(deps, { project_id: 'p1', model_id: 'fake-model' });
    behaviors.push(() => ({ content: '开始。第一批工具调用现在就发出——写入文件并读取源码，读完立即改。' })); // 散文违约
    behaviors.push(() => toolCalls([{ tool: 'write_file', path: 'nudged.txt', content: 'done\n' }])); // 纠正后动手
    behaviors.push(() => reply('已完成。'));
    await convo.sendConvoMessage(deps, c.id, { text: '都改了' }, { trigger: false });
    await convo.runResponseLoop(deps, c.id);
    expect(fs.readFileSync(path.join(ws, 'nudged.txt'), 'utf-8')).toBe('done\n'); // 纠正后真动手
    const msgs = await convo.getConvoMessages(c.id);
    expect(msgs.some((m) => m.kind === 'notice' && m.text.includes('未按输出契约返回 JSON'))).toBe(false);
    expect(msgs.some((m) => m.kind === 'text' && String(m.text).includes('第一批工具调用现在就发出'))).toBe(false); // 嘴炮未入 transcript
  }, 20000);

  it('引擎级自纠错：形态 B 口头承诺（零工具）先纠正——模型改发 tool_calls 则执行', async () => {
    const c = await convo.createConvo(deps, { project_id: 'p1', model_id: 'fake-model' });
    behaviors.push(() => reply('收到，立刻动手。正在写入实施计划并读取尚未审过的源码，读完立即改。')); // 合法 JSON 但纯嘴炮
    behaviors.push(() => toolCalls([{ tool: 'write_file', path: 'lazy-fixed.txt', content: 'ok\n' }]));
    behaviors.push(() => reply('已完成。'));
    await convo.sendConvoMessage(deps, c.id, { text: '开始了吗' }, { trigger: false });
    await convo.runResponseLoop(deps, c.id);
    expect(fs.readFileSync(path.join(ws, 'lazy-fixed.txt'), 'utf-8')).toBe('ok\n');
    const msgs = await convo.getConvoMessages(c.id);
    expect(msgs.some((m) => m.kind === 'text' && String(m.text).includes('正在写入实施计划'))).toBe(false); // 嘴炮回复被纠正作废
    // 纠正消息里明确告知"口头承诺不算执行"
    expect(lastChatMessages.some((m) => m.role === 'user' && String(m.content).includes('口头承诺不算执行'))).toBe(true);
  }, 20000);

  it('自纠错有界：散文纠正重试仍散文 → 采纳 + 违约 notice，不死循环', async () => {
    const c = await convo.createConvo(deps, { project_id: 'p1', model_id: 'fake-model' });
    behaviors.push(() => ({ content: '我马上开始，先分析一下。' }));
    behaviors.push(() => ({ content: '好的，这就执行。' }));
    await convo.sendConvoMessage(deps, c.id, { text: '干活' }, { trigger: false });
    await convo.runResponseLoop(deps, c.id);
    expect(chatCalls).toBe(2); // 首次 + 1 次纠正重试，有界
    const msgs = await convo.getConvoMessages(c.id);
    expect(msgs.filter((m) => m.kind === 'notice' && m.text.includes('仍未恢复')).length).toBe(1);
    expect((await convo.getConvo(c.id))?.status).toBe('idle');
  }, 20000);

  it('契约违约散文不进 LLM 历史（防上下文毒化）', async () => {
    const c = await convo.createConvo(deps, { project_id: 'p1' });
    // 第一轮：散文×2 → 违约收场
    behaviors.push(() => ({ content: '马上动手，第一批已发出。' }));
    behaviors.push(() => ({ content: '这就执行。' }));
    await convo.sendConvoMessage(deps, c.id, { text: '干活1' }, { trigger: false });
    await convo.runResponseLoop(deps, c.id);
    // 第二轮：检查发给模型的历史里没有违约散文
    behaviors.push(() => reply('正常回复。'));
    await convo.sendConvoMessage(deps, c.id, { text: '干活2' }, { trigger: false });
    await convo.runResponseLoop(deps, c.id);
    const historyText = JSON.stringify(lastChatMessages);
    expect(historyText).not.toContain('第一批已发出');
    expect(historyText).not.toContain('这就执行');
  }, 20000);

  it('过去式假完成核验：声称"已创建 X"但工作区无 X → 纠正重试，模型真动手则通过', async () => {
    const c = await convo.createConvo(deps, { project_id: 'p1', model_id: 'fake-model' });
    // 模型谎称已创建（零工具）→ 引擎核验文件不存在 → 纠正 → 模型真发 tool_calls
    behaviors.push(() => reply('已确认：`fake-file.txt` 已创建，内容已写入，文件已就绪。'));
    behaviors.push(() => toolCalls([{ tool: 'write_file', path: 'fake-file.txt', content: 'real\n' }]));
    behaviors.push(() => reply('这次真的完成了。'));
    await convo.sendConvoMessage(deps, c.id, { text: '建个文件' }, { trigger: false });
    await convo.runResponseLoop(deps, c.id);
    expect(fs.readFileSync(path.join(ws, 'fake-file.txt'), 'utf-8')).toBe('real\n'); // 纠正后真落盘
    const msgs = await convo.getConvoMessages(c.id);
    expect(msgs.some((m) => m.kind === 'text' && String(m.text).includes('文件已就绪'))).toBe(false); // 谎言回复被作废
    expect(lastChatMessages.some((m) => m.role === 'user' && String(m.content).includes('并不存在'))).toBe(true); // 核验结果进纠正消息
  }, 20000);

  it('过去式假完成核验：纠正后仍撒谎 → 采纳但落"不可当作完成依据"提醒', async () => {
    const c = await convo.createConvo(deps, { project_id: 'p1', model_id: 'fake-model' });
    behaviors.push(() => reply('已确认：`missing.txt` 已创建，一切就绪。'));
    behaviors.push(() => reply('已创建 missing.txt，完成。')); // 纠正后仍假完成
    await convo.sendConvoMessage(deps, c.id, { text: '建个文件' }, { trigger: false });
    await convo.runResponseLoop(deps, c.id);
    expect(fs.existsSync(path.join(ws, 'missing.txt'))).toBe(false);
    const msgs = await convo.getConvoMessages(c.id);
    expect(msgs.some((m) => m.kind === 'notice' && m.text.includes('不可当作完成依据'))).toBe(true);
    expect(msgs.some((m) => m.kind === 'notice' && m.text.includes('missing.txt'))).toBe(true);
  }, 20000);

  it('引用上一轮真实成果不误伤：文件真实存在时不触发纠正', async () => {
    const c = await convo.createConvo(deps, { project_id: 'p1', model_id: 'fake-model' });
    // 第一轮：真实写入
    behaviors.push(() => toolCalls([{ tool: 'write_file', path: 'real.md', content: 'r\n' }]));
    behaviors.push(() => reply('已创建 real.md。'));
    await convo.sendConvoMessage(deps, c.id, { text: '写文件' }, { trigger: false });
    await convo.runResponseLoop(deps, c.id);
    // 第二轮：零工具回复引用上轮成果（文件真实存在）→ 不纠正直接采纳
    behaviors.push(() => reply('real.md 已创建在项目根目录，可以直接查看。'));
    await convo.sendConvoMessage(deps, c.id, { text: '刚才那个文件呢' }, { trigger: false });
    await convo.runResponseLoop(deps, c.id);
    expect(chatCalls).toBe(3); // 第一轮 2 次（工具+收尾）+ 第二轮 1 次（直接采纳，无纠正调用）
    const msgs = await convo.getConvoMessages(c.id);
    expect(msgs.filter((m) => m.kind === 'notice' && m.text.includes('不可当作完成依据')).length).toBe(0);
  }, 20000);
});

describe('convo FC 原生工具通道（opencode/ZCode 同款）', () => {
  beforeEach(() => {
    configureNativeTools(true);
  });

  it('FC 路径：工具调用走 res.toolCalls，正文即回复（无 JSON 解析/纠正重试）', async () => {
    const c = await convo.createConvo(deps, { project_id: 'p1', model_id: 'fake-model' });
    // mock 把 JSON 契约形态转换为原生形态：tool_calls → res.toolCalls、reply → 正文
    behaviors.push(() => toolCalls([{ tool: 'list_files' }]));
    behaviors.push(() => reply('目录里有 hello.txt，项目是测试脚手架。'));
    await convo.sendConvoMessage(deps, c.id, { text: '看下目录' }, { trigger: false });
    await convo.runResponseLoop(deps, c.id);
    const msgs = await convo.getConvoMessages(c.id);
    expect(msgs.some((m) => m.kind === 'tool' && String(m.text).includes('list_files'))).toBe(true); // 工具执行
    expect(msgs.some((m) => m.kind === 'text' && String(m.text).includes('hello.txt'))).toBe(true); // 正文即回复
    expect(chatCalls).toBe(2);
    expect(lastChatTools?.length).toBeGreaterThan(0); // tools 参数已传给 chat
    // FC 路径不落"未按 JSON 契约"类 notice
    expect(msgs.some((m) => m.kind === 'notice' && (m.text.includes('未按 JSON 契约') || m.text.includes('未按输出契约')))).toBe(false);
  }, 20000);

  it('FC 路径：模型直接输出纯文本 → 直接采纳为回复（无纠正调用）', async () => {
    const c = await convo.createConvo(deps, { project_id: 'p1', model_id: 'fake-model' });
    behaviors.push(() => ({ content: '这个项目是测试脚手架，src 目录目前是空的。' }));
    await convo.sendConvoMessage(deps, c.id, { text: '项目是做什么的' }, { trigger: false });
    await convo.runResponseLoop(deps, c.id);
    const msgs = await convo.getConvoMessages(c.id);
    expect(msgs.some((m) => m.kind === 'text' && String(m.text).includes('测试脚手架'))).toBe(true);
    expect(chatCalls).toBe(1); // 正文即回复，无第二次纠正调用
    expect((await convo.getConvo(c.id))?.status).toBe('idle');
  }, 20000);

  it('FC 路径嘴炮防线保留：零工具 + "正在动手"声称 → 纠正重试一次', async () => {
    const c = await convo.createConvo(deps, { project_id: 'p1', model_id: 'fake-model' });
    behaviors.push(() => ({ content: '好的，马上动手，第一步先创建文件。' }));
    behaviors.push(() => toolCalls([{ tool: 'write_file', path: 'fc.txt', content: 'ok\n' }]));
    behaviors.push(() => ({ content: '文件已创建完成。' }));
    await convo.sendConvoMessage(deps, c.id, { text: '建个文件' }, { trigger: false });
    await convo.runResponseLoop(deps, c.id);
    expect(fs.readFileSync(path.join(ws, 'fc.txt'), 'utf-8')).toBe('ok\n');
    const msgs = await convo.getConvoMessages(c.id);
    expect(lastChatMessages.some((m) => m.role === 'user' && String(m.content).includes('口头承诺'))).toBe(true); // 纠正消息进上下文
    expect(msgs.filter((m) => m.kind === 'notice' && m.text.includes('未按输出契约返回 JSON')).length).toBe(0); // FC 不落 JSON 契约 notice
  }, 20000);

  it('FC 路径意图叙述门：工具轮后模型只说"让我检查…" → 纠正重试 → 真发工具 → 完整结论', async () => {
    const c = await convo.createConvo(deps, { project_id: 'p1', model_id: 'fake-model' });
    behaviors.push(() => toolCalls([{ tool: 'list_files' }]));            // 工具轮
    behaviors.push(() => ({ content: '让我检查日志看看服务是否启动成功。' })); // 意图叙述（工具已跑过）
    behaviors.push(() => toolCalls([{ tool: 'read_file', path: 'hello.txt' }])); // 纠正后真发工具
    behaviors.push(() => ({ content: 'hello.txt 内容是 hello，服务日志显示启动成功，UI 建议如下：…（完整结论）' }));
    await convo.sendConvoMessage(deps, c.id, { text: '看下服务' }, { trigger: false });
    await convo.runResponseLoop(deps, c.id);
    const msgs = await convo.getConvoMessages(c.id);
    expect(lastChatMessages.some((m) => m.role === 'user' && String(m.content).includes('叙述不算执行'))).toBe(true); // 纠正消息进上下文
    expect(msgs.filter((m) => m.kind === 'tool').length).toBe(2); // 纠正后真发工具
    const finalMsg = msgs.filter((m) => m.kind === 'text' && m.role === 'assistant').pop();
    expect(String(finalMsg?.text || '')).toContain('完整结论'); // 最终是完整结论而非半截意图
  }, 20000);

  it('full 权限放行敏感门：powershell 敏感命令直接执行不 park（strict 仍拦截）', async () => {
    const c = await convo.createConvo(deps, { project_id: 'p1', model_id: 'fake-model' });
    await convo.updateConvo(deps, c.id, { policy_level: 'full' });
    behaviors.push(() => toolCalls([{ tool: 'exec', command: 'powershell -NoProfile -Command \"Get-Date\"' }]));
    behaviors.push(() => reply('done'));
    await convo.sendConvoMessage(deps, c.id, { text: '跑个命令' }, { trigger: false });
    await convo.runResponseLoop(deps, c.id);
    const msgs = await convo.getConvoMessages(c.id);
    // 不应出现审批卡（waiting_approval）——敏感门被 full 豁免
    expect(msgs.some((m) => m.kind === 'approval')).toBe(false);
    expect((await convo.getConvo(c.id))?.status).toBe('idle');
    const toolCard = msgs.find((m) => m.kind === 'tool');
    expect(toolCard).toBeTruthy();
  }, 20000);

  it('patchConvo 并发保护：turn 运行中改 policy_level，turn 收尾后不被旧对象覆盖', async () => {
    const c = await convo.createConvo(deps, { project_id: 'p1', model_id: 'fake-model' });
    // 慢行为挂起 turn，期间用户改权限
    behaviors.push(async () => { await sleep(300); return reply('第一轮完成'); });
    await convo.sendConvoMessage(deps, c.id, { text: '第一条消息' }, { trigger: false });
    const loop = convo.runResponseLoop(deps, c.id).catch(() => {});
    await waitForStatus(c.id, 'running');
    await convo.updateConvo(deps, c.id, { policy_level: 'approve_required' });
    await loop;
    // turn 收尾（setStatus idle 走 patchConvo 局部写）后 policy_level 保持新值
    expect((await convo.getConvo(c.id))?.policy_level).toBe('approve_required');
  }, 20000);

  it('FC 叙述正文不丢弃：同响应叙述+tool_calls → 叙述 text 消息与工具卡都上屏', async () => {
    process.env.COTEAM_LLM_NATIVE_TOOLS = '1';
    configureNativeTools(true);
    const c = await convo.createConvo(deps, { project_id: 'p1', model_id: 'fake-model' });
    // mock：行为返回叙述正文 + tool_calls 混合形态（FC 下模型常见）
    behaviors.push(() => ({ content: '我先看一下当前文件结构，然后写入。', toolCalls: [{ tool: 'write_file', path: 'fc-narr.txt', content: 'ok\n' }] }));
    behaviors.push(() => ({ content: '文件已写入完成。' }));
    await convo.sendConvoMessage(deps, c.id, { text: '写个文件' }, { trigger: false });
    await convo.runResponseLoop(deps, c.id);
    const msgs = await convo.getConvoMessages(c.id);
    expect(msgs.some((m) => m.kind === 'text' && m.role === 'assistant' && String(m.text).includes('先看一下当前文件结构'))).toBe(true); // 叙述保留
    expect(msgs.some((m) => m.kind === 'tool' && (JSON.stringify((m.meta as any)?.calls || []).includes('write_file') || String(m.text).includes('fc-narr.txt')))).toBe(true); // 工具卡
    expect(fs.readFileSync(path.join(ws, 'fc-narr.txt'), 'utf-8')).toBe('ok\n');
    process.env.COTEAM_LLM_NATIVE_TOOLS = '0';
    configureNativeTools(false);
  }, 20000);
});
