import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

// E5 软重试 + 动态输出预算（o3xmkraj 复盘）回归：
// 1) 动态预算按轮次阶梯放大（32k → 64k → 128k，封顶模型上限）
// 2) E5 烧穿 → 同模型降思考强度软重试（reasoning_effort low，非关闭）
// 3) 软重试成功不记账；仍烧穿记防浪费记忆，同模型二次直接换模
// 4) 非 length 空正文连续 2 轮快速失败

const chatCalls: { maxTokens?: number; messages: { role: string; content: string }[]; opts?: { extraBody?: Record<string, unknown> } }[] = [];
type ChatScript = (callIndex: number, args: { maxTokens: number; messages: { role: string; content: string }[]; opts?: { extraBody?: Record<string, unknown> } }) => any;
let script: ChatScript[] = [];

vi.mock('../src/llm', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/llm')>();
  return {
    ...actual,
    chat: async (_entry: any, messages: { role: string; content: string }[], maxTokens: number, _temp?: number, _signal?: any, _cap?: number, _onDelta?: any, opts?: { extraBody?: Record<string, unknown> }) => {
      const idx = chatCalls.length;
      chatCalls.push({ maxTokens, messages: JSON.parse(JSON.stringify(messages)), opts });
      const fn = script[idx] ?? script[script.length - 1];
      return fn(idx, { maxTokens, messages, opts });
    },
  };
});

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { initBus, closeBus } from '../src/bus';
import { ModelPool } from '../src/scheduler';
import { Orchestrator } from '../src/orchestrator/orchestrator';
import type { ModelConfig, TaskNode } from '../src/types';

function cfg(overrides: Partial<ModelConfig> & { name: string }): ModelConfig {
  return { api_key: 'k', base_url: 'http://localhost:9', max_tokens: 128000, ...overrides } as ModelConfig;
}

function makeNode(id: string, extra: Partial<TaskNode> = {}): TaskNode {
  return {
    id, task_id: 't-e5', name: id + ' work', status: 'pending', agent: 'dev', result: null, error: '',
    retry_count: 0, complexity: 'normal', requires_approval: false, needs_human: false,
    created_at: '', updated_at: '', reason: '', branch: '', ...extra,
  } as TaskNode;
}

const successJson = JSON.stringify({ status: 'success', summary: 'done', verification: '逐项核对完成', changes: ['x.txt: ok'], errors: [] });

describe('E5 软重试与动态输出预算', () => {
  let tmp: string;
  let orchestrator: Orchestrator;
  let entry: any;
  let plugin: any;

  beforeEach(async () => {
    process.env.COTEAM_FORCE_MEMORY = '1';
    chatCalls.length = 0;
    script = [];
    closeBus();
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-e5-'));
    const devDir = path.join(tmp, 'dev');
    fs.mkdirSync(devDir, { recursive: true });
    fs.writeFileSync(path.join(devDir, 'agent.yaml'), 'name: dev\ntags: [code]\nrole: 开发\n');
    await initBus({ host: '127.0.0.1', port: 6399, db: 0 });
    const pool = new ModelPool([cfg({ name: 'm1', tags: ['code'] })]);
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
    fs.rmSync(tmp, { recursive: true, force: true });
    closeBus();
  });

  it('动态预算：normal 档按轮次阶梯 32k → 64k → 128k 封顶', async () => {
    script = [
      () => ({ content: JSON.stringify({ tool_calls: [{ tool: 'list_files' }] }), promptTokens: 10, completionTokens: 20, finishReason: 'stop' }),
      () => ({ content: JSON.stringify({ tool_calls: [{ tool: 'read_file', path: 'a.txt' }] }), promptTokens: 10, completionTokens: 20, finishReason: 'stop' }),
      () => ({ content: successJson, promptTokens: 10, completionTokens: 20, finishReason: 'stop' }),
    ];
    const r = await (orchestrator as any).callAgent('t-e5', makeNode('n1'), plugin, entry, tmp, false, '', 'test', { level: 'full', whitelistCommands: null, maxTimeSec: 10 });
    expect(r.status).toBe('success');
    expect(chatCalls.map((c) => c.maxTokens)).toEqual([32000, 64000, 128000]);
  });

  it('E5 烧穿 → 软重试（reasoning_effort low + 续写指令）成功不记账', async () => {
    script = [
      () => ({ content: '', promptTokens: 10, completionTokens: 38369, finishReason: 'length' }),
      (_i, { messages, opts }) => {
        expect(opts?.extraBody?.reasoning_effort).toBe('low');
        const last = messages[messages.length - 1];
        expect(last.role).toBe('user');
        expect(last.content).toContain('不要重新展开长思考');
        expect(last.content).toContain('write_file');
        return { content: successJson, promptTokens: 10, completionTokens: 5000, finishReason: 'stop' };
      },
    ];
    const r = await (orchestrator as any).callAgent('t-e5', makeNode('n1'), plugin, entry, tmp, false, '', 'test', { level: 'full', whitelistCommands: null, maxTimeSec: 10 });
    expect(r.status).toBe('success');
    // 软重试成功不进防浪费记忆
    expect((orchestrator as any).thinkingBurned.get('t-e5')?.has('m1') ?? false).toBe(false);
  });

  it('E5 软重试仍烧穿 → 记防浪费记忆并失败；同模型再次直接换模不重试', async () => {
    script = [
      () => ({ content: '', promptTokens: 10, completionTokens: 38369, finishReason: 'length' }),
      () => ({ content: '', promptTokens: 10, completionTokens: 40000, finishReason: 'length' }),
    ];
    const r1 = await (orchestrator as any).callAgent('t-e5', makeNode('n1'), plugin, entry, tmp, false, '', 'test', { level: 'full', whitelistCommands: null, maxTimeSec: 10 });
    expect(r1.status).toBe('failed');
    expect(r1.error).toContain('输出预算耗尽');
    expect(r1.error).toContain('软重试');
    expect((orchestrator as any).thinkingBurned.get('t-e5')?.has('m1')).toBe(true);

    // 同模型第二次 dispatch：命中记忆，1 次 chat 调用即失败返回
    const before = chatCalls.length;
    script = [() => ({ content: '', promptTokens: 10, completionTokens: 38369, finishReason: 'length' })];
    const r2 = await (orchestrator as any).callAgent('t-e5', makeNode('n2'), plugin, entry, tmp, false, '', 'test', { level: 'full', whitelistCommands: null, maxTimeSec: 10 });
    expect(r2.status).toBe('failed');
    expect(r2.error).toContain('直接换模');
    expect(chatCalls.length - before).toBe(1);
  });

  it('非 length 空正文连续 2 轮 → 快速失败', async () => {
    script = [
      () => ({ content: '', promptTokens: 10, completionTokens: 0, finishReason: 'stop' }),
      () => ({ content: '', promptTokens: 10, completionTokens: 0, finishReason: 'stop' }),
    ];
    const r = await (orchestrator as any).callAgent('t-e5', makeNode('n1'), plugin, entry, tmp, false, '', 'test', { level: 'full', whitelistCommands: null, maxTimeSec: 10 });
    expect(r.status).toBe('failed');
    expect(r.error).toContain('空正文连续 2 轮');
    expect(chatCalls.length).toBe(2);
  });

  it('单轮空正文给修正机会（不触发快速失败）', async () => {
    script = [
      () => ({ content: '', promptTokens: 10, completionTokens: 0, finishReason: 'stop' }),
      () => ({ content: successJson, promptTokens: 10, completionTokens: 20, finishReason: 'stop' }),
    ];
    const r = await (orchestrator as any).callAgent('t-e5', makeNode('n1'), plugin, entry, tmp, false, '', 'test', { level: 'full', whitelistCommands: null, maxTimeSec: 10 });
    expect(r.status).toBe('success');
    expect(chatCalls.length).toBe(2);
  });
});
