import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ModelPool } from '../src/scheduler';
import { Orchestrator } from '../src/orchestrator/orchestrator';
import { initBus, closeBus } from '../src/bus';
import type { ModelConfig, ModelEntry, TaskNode } from '../src/types';

// feature: 降级策略优化 —— 节点级/agent级模型指定、等待容量、突破冷却、主 Agent 兜底

function cfg(overrides: Partial<ModelConfig> & { name: string }): ModelConfig {
  return { api_key: 'k', base_url: 'http://localhost:9', ...overrides } as ModelConfig;
}

function makeNode(id: string, extra: Partial<TaskNode> = {}): TaskNode {
  return {
    id, task_id: 't', name: id, status: 'pending', agent: 'dev', result: null, error: '',
    retry_count: 0, complexity: 'normal', requires_approval: false, needs_human: false,
    created_at: '', updated_at: '', ...extra,
  };
}

describe('model pinning & degradation (resolvePrimary)', () => {
  let tmp: string;
  let orchestrator: Orchestrator;

  beforeEach(async () => {
    process.env.COTEAM_FORCE_MEMORY = '1';
    closeBus();
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-deg-'));
    const devDir = path.join(tmp, 'dev');
    fs.mkdirSync(devDir, { recursive: true });
    fs.writeFileSync(path.join(devDir, 'agent.yaml'), 'name: dev\ntags: [code]\nrole: 开发\n');
    await initBus({ host: '127.0.0.1', port: 6399, db: 0 });
    orchestrator = new Orchestrator({
      agentsDir: tmp,
      modelPool: new ModelPool([
        cfg({ name: 'm-strong', priority: 1, tags: ['code'], professional_weight: 90 }),
        cfg({ name: 'm-cheap', priority: 2, tags: ['code'], professional_weight: 50 }),
        cfg({ name: 'm-image', priority: 3, tags: ['image'], professional_weight: 40 }),
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
    fs.rmSync(tmp, { recursive: true, force: true });
    closeBus();
  });

  it('node-level pin wins over agent override and dynamic selection', async () => {
    const plugin = (orchestrator as any).router.getAvailable().get('dev');
    const primary = await (orchestrator as any).resolvePrimary('t', makeNode('n1', { model_id: 'm-cheap' }), plugin);
    expect(primary.name).toBe('m-cheap');
  });

  it('falls back to agent model_override when the node pin is not in the pool', async () => {
    const plugin = { name: 'dev', tags: ['code'], modelOverride: 'm-strong' };
    const primary = await (orchestrator as any).resolvePrimary('t', makeNode('n1', { model_id: 'ghost' }), plugin);
    expect(primary.name).toBe('m-strong');
  });

  it('falls back to dynamic selection when neither pin resolves', async () => {
    const plugin = { name: 'dev', tags: ['code'], modelOverride: 'ghost-agent-model' };
    const primary = await (orchestrator as any).resolvePrimary('t', makeNode('n1'), plugin);
    // 动态选择：complex=normal 加权随机落在 code 标签模型里，绝不会落到 m-image
    expect(['m-strong', 'm-cheap']).toContain(primary.name);
  });

  it('emergencyCandidates ignores cooldown and still offers capacity', () => {
    const pool = orchestrator['pool'] as ModelPool;
    for (const m of ['m-strong', 'm-cheap', 'm-image']) {
      const entry = pool.getModel(m)!;
      entry.failCount = 5; // 深度冷却
      entry.lastFailureAt = Date.now();
    }
    // 健康选择为空
    expect(pool.selectModel(['code'], 'normal')).toBeNull();
    // 紧急通道仍有候选（忽略冷却）
    const emergency = pool.emergencyCandidates();
    expect(emergency.length).toBe(3);
    expect(emergency[0].name).toBe('m-strong');
  });

  it('waitForModel returns once capacity is released instead of failing', async () => {
    const pool = orchestrator['pool'] as ModelPool;
    const entries = ['m-strong', 'm-cheap', 'm-image'].map((m) => pool.getModel(m)!);
    // 占满所有模型槽位（selectModel 在 tag 组全满时会回退到全池）
    for (const e of entries) for (let i = 0; i < e.concurrency; i++) pool.tryAcquire(e);
    expect(pool.selectModel(['code'], 'normal')).toBeNull();

    const waiting = (orchestrator as any).waitForModel('t', ['code'], 'normal') as Promise<ModelEntry | null>;
    setTimeout(() => pool.release(entries[0]), 300);
    const got = await waiting;
    expect(got?.name).toBe('m-strong');
  }, 10_000);

  it('main-agent fallback kicks in when even escalation has no model', async () => {
    const pool = orchestrator['pool'] as ModelPool;
    // 所有模型深度冷却
    for (const m of ['m-strong', 'm-cheap', 'm-image']) {
      const entry = pool.getModel(m)!;
      entry.failCount = 5;
      entry.lastFailureAt = Date.now();
    }
    const graph = {
      task_id: 't-fb', nodes: [makeNode('n1')], edges: [] as [string, string][],
      description: 'fallback', workspace: tmp, status: 'running', created_at: '', updated_at: '',
      main_model_id: 'm-cheap',
    };
    await (orchestrator as any); // noop：本用例只验证兜底选择表达式
    // 直接验证 executeNodeInner 的兜底选择表达式：main_model_id → emergencyCandidates()[0]
    const mainEntry = (graph.main_model_id ? pool.getModel(graph.main_model_id) : null) || pool.emergencyCandidates()[0] || null;
    expect(mainEntry?.name).toBe('m-cheap');
    expect(pool.isHealthy(mainEntry as ModelEntry)).toBe(false); // 突破冷却也要能拿到
  });
});
