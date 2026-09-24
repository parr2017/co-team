/**
 * 原生 function calling 主循环回归（2026-09-23 架构迁移）：
 * 项目开发任务（orchestrator executeNode）工具轮必须走供应商 tool_calls 通道，
 * 不得再因"正文为空/散文"误判为「不是有效 JSON」而烧纠正轮。
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

const chatCalls: { messages: { role: string; content: string }[]; opts?: { tools?: unknown[] } }[] = [];
type ChatScript = (callIndex: number) => any;
let script: ChatScript[] = [];

vi.mock('../src/llm', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/llm')>();
  return {
    ...actual,
    chat: async (_entry: any, messages: { role: string; content: string }[], _mt?: number, _temp?: number, _signal?: any, _cap?: number, _onDelta?: any, opts?: { tools?: unknown[] }) => {
      const idx = chatCalls.length;
      chatCalls.push({ messages: JSON.parse(JSON.stringify(messages)), opts });
      const fn = script[idx] ?? script[script.length - 1];
      return fn(idx);
    },
  };
});

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { initBus, closeBus } from '../src/bus';
import { ModelPool } from '../src/scheduler';
import { Orchestrator } from '../src/orchestrator/orchestrator';
import { configureNativeTools } from '../src/toolSchema';
import type { ModelConfig, TaskNode } from '../src/types';

function cfg(overrides: Partial<ModelConfig> & { id: string; name: string }): ModelConfig {
  return { api_key: 'k', base_url: 'http://localhost:9', max_tokens: 128000, ...overrides } as ModelConfig;
}

function makeNode(id: string, extra: Partial<TaskNode> = {}): TaskNode {
  return {
    id, task_id: 't-fc', name: id + ' work', status: 'pending', agent: 'dev', result: null, error: '',
    retry_count: 0, complexity: 'normal', requires_approval: false, needs_human: false,
    created_at: '', updated_at: '', reason: '', branch: '', ...extra,
  } as TaskNode;
}

const successJson = JSON.stringify({ status: 'success', summary: 'done', verification: '逐项核对完成', changes: [], errors: [] });

describe('orchestrator 主循环原生 function calling', () => {
  let tmp: string;
  let orchestrator: Orchestrator;
  let entry: any;
  let plugin: any;

  beforeEach(async () => {
    process.env.COTEAM_FORCE_MEMORY = '1';
    configureNativeTools(true);
    chatCalls.length = 0;
    script = [];
    closeBus();
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-fc-'));
    const devDir = path.join(tmp, 'dev');
    fs.mkdirSync(devDir, { recursive: true });
    fs.writeFileSync(path.join(devDir, 'agent.yaml'), 'name: dev\ntags: [code]\nrole: 开发\n');
    await initBus({ host: '127.0.0.1', port: 6399, db: 0 });
    const pool = new ModelPool([cfg({ id: 'm1', name: 'm1', tags: ['code'] })]);
    orchestrator = new Orchestrator({
      agentsDir: tmp,
      modelPool: pool,
      policy: { level: 'full', whitelistCommands: null, maxTimeSec: 10 },
      maxRetries: 1,
      sandboxEnabled: false,
      gitEnabled: false,
      branchWorkflow: false,
      outputTiers: { simple: 8000, normal: 32000, complex: 64000 },
    });
    await orchestrator.loadAgents();
    entry = pool.getModel('m1');
    plugin = (orchestrator as any).router.getAvailable().get('dev');
  });

  afterEach(() => {
    configureNativeTools(true);
    fs.rmSync(tmp, { recursive: true, force: true });
    closeBus();
  });

  it('FC 工具轮（content 空 + toolCalls）→ 执行工具，不报「不是有效 JSON」，无纠正轮', async () => {
    const writePath = path.join(tmp, 'fc-ok.txt');
    script = [
      // 第 1 轮：原生 tool_calls 调 write_file，正文为空（FC 正常形态）
      () => ({ content: '', promptTokens: 10, completionTokens: 20, finishReason: 'tool_calls', toolCalls: [{ tool: 'write_file', path: 'fc-ok.txt', content: 'ok\n' }] }),
      // 第 2 轮：正文最终 JSON 收尾
      () => ({ content: successJson, promptTokens: 10, completionTokens: 20, finishReason: 'stop' }),
    ];
    const r = await (orchestrator as any).callAgent('t-fc', makeNode('n1'), plugin, entry, tmp, false, '', 'test', { level: 'full', whitelistCommands: null, maxTimeSec: 10 });
    expect(r.status).toBe('success');
    // 工具真实落盘
    expect(fs.existsSync(writePath)).toBe(true);
    expect(fs.readFileSync(writePath, 'utf-8')).toBe('ok\n');
    // 只有 2 次 LLM 调用（工具轮 + 收尾），没有"不是有效 JSON"纠正轮
    expect(chatCalls.length).toBe(2);
    // 纠正消息不得出现（FC 工具轮不再被误判）
    const allUser = chatCalls.flatMap((c) => c.messages.filter((m) => m.role === 'user').map((m) => String(m.content)));
    expect(allUser.some((c) => c.includes('无法解析为 JSON') || c.includes('既不是供应商 tool_calls'))).toBe(false);
  });

  it('FC 工具轮 + 叙述正文 → 不误判，执行工具', async () => {
    script = [
      // 模型输出叙述正文 + 原生 toolCalls（2026-09-20 实测形态）
      () => ({ content: '我先看一下当前文件，然后写入。', promptTokens: 10, completionTokens: 20, finishReason: 'tool_calls', toolCalls: [{ tool: 'write_file', path: 'fc-narr.txt', content: 'ok\n' }] }),
      () => ({ content: successJson, promptTokens: 10, completionTokens: 20, finishReason: 'stop' }),
    ];
    const r = await (orchestrator as any).callAgent('t-fc', makeNode('n2'), plugin, entry, tmp, false, '', 'test', { level: 'full', whitelistCommands: null, maxTimeSec: 10 });
    expect(r.status).toBe('success');
    expect(fs.existsSync(path.join(tmp, 'fc-narr.txt'))).toBe(true);
    expect(chatCalls.length).toBe(2);
    const allUser = chatCalls.flatMap((c) => c.messages.filter((m) => m.role === 'user').map((m) => String(m.content)));
    expect(allUser.some((c) => c.includes('无法解析为 JSON'))).toBe(false);
  });

  it('FC 开启时 tools 传给 chat（opts.tools 非空）', async () => {
    script = [
      () => ({ content: successJson, promptTokens: 10, completionTokens: 20, finishReason: 'stop' }),
    ];
    await (orchestrator as any).callAgent('t-fc', makeNode('n3'), plugin, entry, tmp, false, '', 'test', { level: 'full', whitelistCommands: null, maxTimeSec: 10 });
    expect(chatCalls[0].opts?.tools?.length ?? 0).toBeGreaterThan(0);
  });

  it('FC 关闭时走 JSON 文本契约（tools 不传）', async () => {
    configureNativeTools(false);
    script = [
      () => ({ content: successJson, promptTokens: 10, completionTokens: 20, finishReason: 'stop' }),
    ];
    const r = await (orchestrator as any).callAgent('t-fc', makeNode('n4'), plugin, entry, tmp, false, '', 'test', { level: 'full', whitelistCommands: null, maxTimeSec: 10 });
    expect(r.status).toBe('success');
    expect(chatCalls[0].opts?.tools ?? []).toHaveLength(0);
  });
});

/**
 * 2026-09-23 回归（learn-english 任务 pk0udn4p 节点 s2-1 失败实证）：
 * 任务管线 agent 曾拿不到 exec 工具——无法运行 flutter analyze / flutter test，
 * 只能申报"缺少 shell 命令执行工具"并被判合法阻塞，s2-2 起全部连带失败。
 * 本组断言：FC exec 工具真实执行、stdout 回传后续轮可见、白名单策略按预期 park。
 */
describe('orchestrator exec 工具（回归：任务管线 shell 能力）', () => {
  let tmp: string;
  let orchestrator: Orchestrator;
  let entry: any;
  let plugin: any;

  beforeEach(async () => {
    process.env.COTEAM_FORCE_MEMORY = '1';
    configureNativeTools(true);
    chatCalls.length = 0;
    script = [];
    closeBus();
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-exec-'));
    const devDir = path.join(tmp, 'dev');
    fs.mkdirSync(devDir, { recursive: true });
    fs.writeFileSync(path.join(devDir, 'agent.yaml'), 'name: dev\ntags: [code]\nrole: 开发\n');
    await initBus({ host: '127.0.0.1', port: 6399, db: 0 });
    const pool = new ModelPool([cfg({ id: 'm1', name: 'm1', tags: ['code'] })]);
    orchestrator = new Orchestrator({
      agentsDir: tmp,
      modelPool: pool,
      policy: { level: 'full', whitelistCommands: null, maxTimeSec: 60 },
      maxRetries: 1,
      sandboxEnabled: false,
      gitEnabled: false,
      branchWorkflow: false,
      outputTiers: { simple: 8000, normal: 32000, complex: 64000 },
    });
    await orchestrator.loadAgents();
    entry = pool.getModel('m1');
    plugin = (orchestrator as any).router.getAvailable().get('dev');
  });

  afterEach(() => {
    configureNativeTools(true);
    // 后台进程组兜底查杀：测试里 exec_background 起的不能留僵尸
    (orchestrator as any).killTaskProcesses('t-exec');
    (orchestrator as any).killTaskProcesses('t-fc');
    fs.rmSync(tmp, { recursive: true, force: true });
    closeBus();
  });

  it('FC exec 工具真实执行，stdout 回传且后续轮可见', async () => {
    script = [
      () => ({
        content: '', promptTokens: 10, completionTokens: 20, finishReason: 'tool_calls',
        toolCalls: [{ tool: 'exec', command: 'echo co-team-exec-marker' }],
      }),
      () => ({ content: successJson, promptTokens: 10, completionTokens: 20, finishReason: 'stop' }),
    ];
    const r = await (orchestrator as any).callAgent('t-exec', makeNode('e1'), plugin, entry, tmp, false, '', 'test', { level: 'full', whitelistCommands: null, maxTimeSec: 60 });
    expect(r.status).toBe('success');
    // 工具轮结果里有真实 stdout（marker 串）——即 exec 真的被 spawn 执行了
    const toolResults = chatCalls[1]?.messages?.filter((m: any) => m.role === 'user').map((m: any) => String(m.content)).join('\n') || '';
    expect(toolResults).toContain('co-team-exec-marker');
  });

  it('同轮两条不同 exec 命令都真实执行（dedupKey 补 command 回归）', async () => {
    script = [
      () => ({
        content: '', promptTokens: 10, completionTokens: 20, finishReason: 'tool_calls',
        toolCalls: [
          { tool: 'exec', command: 'echo FIRST-CMD' },
          { tool: 'exec', command: 'echo SECOND-CMD' },
        ],
      }),
      () => ({ content: successJson, promptTokens: 10, completionTokens: 20, finishReason: 'stop' }),
    ];
    const r = await (orchestrator as any).callAgent('t-exec', makeNode('e2'), plugin, entry, tmp, false, '', 'test', { level: 'full', whitelistCommands: null, maxTimeSec: 60 });
    expect(r.status).toBe('success');
    // 第 2 轮注入的工具执行结果 must carry BOTH markers——修复前第二条被 dedup 吞掉
    const toolResults = chatCalls[1]?.messages?.filter((m: any) => m.role === 'user').map((m: any) => String(m.content)).join('\n') || '';
    expect(toolResults).toContain('FIRST-CMD');
    expect(toolResults).toContain('SECOND-CMD');
    expect(toolResults).not.toContain('结果从略');
  });

  it('whitelist_auto 下白名单外命令 park 到 pending_commands（不硬拒、不假完成）', async () => {
    script = [
      () => ({
        content: '', promptTokens: 10, completionTokens: 20, finishReason: 'tool_calls',
        toolCalls: [{ tool: 'exec', command: 'flutter analyze' }],
      }),
      () => ({ content: JSON.stringify({ status: 'success', summary: 'done', verification: 'see exec', changes: [], errors: [] }), promptTokens: 10, completionTokens: 20, finishReason: 'stop' }),
    ];
    const r = await (orchestrator as any).callAgent('t-exec', makeNode('e3'), plugin, entry, tmp, false, '', 'test', { level: 'whitelist_auto', whitelistCommands: ['echo'], maxTimeSec: 60 });
    // 结果携带 pending_commands——调用方据此把节点挂 waiting_approval
    expect((r as any).pending_commands).toEqual(['flutter analyze']);
  });

  it('plan_only 策略下 exec 工具根本不暴露（不空转）', async () => {
    script = [
      () => ({ content: successJson, promptTokens: 10, completionTokens: 20, finishReason: 'stop' }),
    ];
    await (orchestrator as any).callAgent('t-exec', makeNode('e4'), plugin, entry, tmp, false, '', 'test', { level: 'plan_only', whitelistCommands: null, maxTimeSec: 10 });
    const tools = chatCalls[0].opts?.tools as { function: { name: string } }[] | undefined;
    expect(tools?.some((t) => t.function.name === 'exec') ?? false).toBe(false);
    expect(tools?.some((t) => t.function.name === 'read_file')).toBe(true);
  });

  it('exec_background 返回 pid 与 log，并登记到任务级进程组（可被 killTaskProcesses 查杀）', async () => {
    script = [
      () => ({
        content: '', promptTokens: 10, completionTokens: 20, finishReason: 'tool_calls',
        toolCalls: [{ tool: 'exec_background', command: 'echo bg-marker' }],
      }),
      () => ({ content: successJson, promptTokens: 10, completionTokens: 20, finishReason: 'stop' }),
    ];
    const r = await (orchestrator as any).callAgent('t-exec', makeNode('e5'), plugin, entry, tmp, false, '', 'test', { level: 'full', whitelistCommands: null, maxTimeSec: 60 });
    expect(r.status).toBe('success');
    const pids: Set<number> = (orchestrator as any).taskBgPids.get('t-exec') || new Set();
    expect(pids.size).toBeGreaterThan(0);
  });
});
