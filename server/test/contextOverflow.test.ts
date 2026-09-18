import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ModelPool } from '../src/scheduler';
import { Orchestrator, CONTEXT_OVERFLOW_RE } from '../src/orchestrator/orchestrator';
import { initBus, closeBus } from '../src/bus';
import type { ModelConfig, TaskNode } from '../src/types';

// 2026-09-15（c2g0ya6d 复盘）：413 上下文超限分型——不毒化模型健康、折叠瘦身重试、
// 大窗口模型优先；全链烧光才转人工

function cfg(overrides: Partial<ModelConfig> & { id: string; name: string }): ModelConfig {
  return { api_key: 'k', base_url: 'http://localhost:9', ...overrides } as ModelConfig;
}

function makeNode(id: string, extra: Partial<TaskNode> = {}): TaskNode {
  return {
    id, task_id: 't', name: id, status: 'pending', agent: 'dev', result: null, error: '',
    retry_count: 0, complexity: 'normal', requires_approval: false, needs_human: false,
    created_at: '', updated_at: '', ...extra,
  };
}

describe('413 上下文超限分型（context_overflow）', () => {
  let tmp: string;
  let orchestrator: Orchestrator;

  beforeEach(async () => {
    process.env.COTEAM_FORCE_MEMORY = '1';
    closeBus();
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-ovf-'));
    const devDir = path.join(tmp, 'dev');
    fs.mkdirSync(devDir, { recursive: true });
    fs.writeFileSync(path.join(devDir, 'agent.yaml'), 'name: dev\ntags: [code]\nrole: 开发\n');
    await initBus({ host: '127.0.0.1', port: 6399, db: 0 });
    orchestrator = new Orchestrator({
      agentsDir: tmp,
      modelPool: new ModelPool([
        cfg({ id: 'm-small', name: 'm-small', priority: 1, tags: ['code'], professional_weight: 90, context_length: 8192 }),
        cfg({ id: 'm-mid', name: 'm-mid', priority: 2, tags: ['code'], professional_weight: 50, context_length: 131072 }),
        cfg({ id: 'm-big', name: 'm-big', priority: 3, tags: ['code'], professional_weight: 40, context_length: 200000 }),
      ]),
      policy: { level: 'approve_required', whitelistCommands: null, maxTimeSec: 10 },
      maxRetries: 2,
      sandboxEnabled: false,
      gitEnabled: false,
      modelWaitTimeoutSec: 1,
    });
    await orchestrator.loadAgents();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(tmp, { recursive: true, force: true });
    closeBus();
  });

  it('CONTEXT_OVERFLOW_RE 命中 413/payload too large/error_type 归类 context_overflow', () => {
    expect(CONTEXT_OVERFLOW_RE.test('Error: 413 status code (no body)')).toBe(true);
    expect(CONTEXT_OVERFLOW_RE.test('payload too large for this model')).toBe(true);
    expect(CONTEXT_OVERFLOW_RE.test("This model's maximum context length is 8192 tokens")).toBe(true);
    expect(CONTEXT_OVERFLOW_RE.test('Error: 429 too many requests')).toBe(false);
    const classify = (orchestrator as any).classifyNodeError.bind(orchestrator);
    expect(classify('Error: 413 status code (no body)')).toBe('context_overflow');
    expect(classify('Error: 429 rate limit')).toBe('capacity');
  });

  it('首次 413：不 markFailure，折叠瘦身同模型重试一次后成功', async () => {
    const pool = orchestrator['pool'] as ModelPool;
    const plugin = { name: 'dev', tags: ['code'] };
    const node = makeNode('n1', { model_id: 'm-small' });
    const calls: { model: string; aggressiveFold: boolean }[] = [];
    vi.spyOn(orchestrator as any, 'callAgent').mockImplementation(
      async (_t: unknown, _n: unknown, _p: unknown, entry: { name: string }, _w: unknown, _e: unknown, _l: unknown, _a: unknown, _pol: unknown, aggressiveFold: boolean) => {
        calls.push({ model: entry.name, aggressiveFold });
        if (!aggressiveFold) {
          const err: any = new Error('Error: 413 status code (no body)');
          throw err;
        }
        return { status: 'success', summary: 'folded retry ok', tokens: 10 };
      }
    );
    const result = await (orchestrator as any).dispatch('t-413', node, plugin, tmp, false, '', '第 1 次尝试');
    expect(result.status).toBe('success');
    // 同模型两次：第一次裸调 413 → 第二次带 aggressiveFold 成功
    expect(calls).toEqual([
      { model: 'm-small', aggressiveFold: false },
      { model: 'm-small', aggressiveFold: true },
    ]);
    // 健康分零污染：413 不是模型的错
    for (const m of ['m-small', 'm-mid', 'm-big']) {
      expect(pool.getModel(m)!.failCount).toBe(0);
    }
  });

  it('折叠后仍 413：不记健康分，剩余链按 context_length 降序重排（大窗口优先）', async () => {
    const pool = orchestrator['pool'] as ModelPool;
    const plugin = { name: 'dev', tags: ['code'] };
    const node = makeNode('n1', { model_id: 'm-small' });
    const triedModels: string[] = [];
    vi.spyOn(orchestrator as any, 'callAgent').mockImplementation(async (_t: unknown, _n: unknown, _p: unknown, entry: { name: string }) => {
      triedModels.push(entry.name);
      throw Object.assign(new Error('Error: 413 status code (no body)'), {});
    });
    const result = await (orchestrator as any).dispatch('t-413b', node, plugin, tmp, false, '', '第 1 次尝试');
    expect(result.status).toBe('failed');
    // 顺序：m-small（首撞）→ m-small（折叠重试）→ m-big（200k）→ m-mid（131k）
    expect(triedModels).toEqual(['m-small', 'm-small', 'm-big', 'm-mid']);
    expect(result.error).toContain('all models failed');
    for (const m of ['m-small', 'm-mid', 'm-big']) {
      expect(pool.getModel(m)!.failCount).toBe(0);
    }
  });
});
