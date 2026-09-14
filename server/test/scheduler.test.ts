import { describe, expect, it, vi } from 'vitest';
import { ModelPool } from '../src/scheduler';

describe('ModelPool', () => {
  const configs = [
    { name: 'cheap', api_key: 'k', base_url: 'u', priority: 1, professional_weight: 30, cost_per_1k: 0.001, tags: ['general'] },
    { name: 'coder', api_key: 'k', base_url: 'u', priority: 1, professional_weight: 90, cost_per_1k: 0.01, tags: ['code'] },
    { name: 'weak', api_key: 'k', base_url: 'u', priority: 2, professional_weight: 30, cost_per_1k: 0.001, tags: [] },
  ];

  it('selects by complexity: simple prefers cheapest, complex prefers strongest', () => {
    const pool = new ModelPool(configs);
    expect(pool.selectModel([], 'simple')!.name).toBe('cheap');
    expect(pool.selectModel([], 'complex')!.name).toBe('coder');
  });

  it('filters by tags with fallback to all', () => {
    const pool = new ModelPool(configs);
    expect(pool.selectModel(['code'], 'complex')!.name).toBe('coder');
    expect(pool.selectModel([], 'complex')).not.toBeNull();
  });

  it('excludes primary from fallback chain', () => {
    const pool = new ModelPool(configs);
    const primary = pool.selectModel([], 'complex')!;
    const chain = pool.fallbackChain(primary);
    expect(chain[0].name).toBe(primary.name);
    expect(chain.some((m) => m.name === primary.name && m !== primary)).toBe(false);
  });

  it('skips unhealthy models', () => {
    const pool = new ModelPool(configs);
    const broken = (pool as any).models.find((m: any) => m.name === 'coder');
    for (let i = 0; i < 3; i++) pool.markFailure(broken);
    expect(pool.isHealthy(broken)).toBe(false);
    expect(pool.selectModel([], 'complex')!.name).not.toBe('coder');
  });

  it('records usage tokens and cost', () => {
    const pool = new ModelPool(configs);
    pool.recordUsage('coder', 1000, 1000);
    expect(pool.totalTokens()).toBe(2000);
    expect(pool.totalCost()).toBeCloseTo(0.02, 6);
  });

  it('tracks slots', () => {
    const pool = new ModelPool([{ name: 'm', api_key: 'k', base_url: 'u', concurrency: 1 }]);
    const m = (pool as any).models[0];
    expect(pool.tryAcquire(m)).toBe(true);
    expect(pool.tryAcquire(m)).toBe(false);
    pool.release(m);
    expect(pool.tryAcquire(m)).toBe(true);
  });
});

describe('ModelPool failure cooldown (circuit breaker)', () => {
  const configs = [{ name: 'flakey', api_key: 'k', base_url: 'u', priority: 1, professional_weight: 50, cost_per_1k: 0, tags: [] }];

  it('cooldown grows exponentially with consecutive failures and expires', () => {
    const pool = new ModelPool(configs);
    const m = (pool as any).models[0];
    for (let i = 0; i < 3; i++) pool.markFailure(m);
    expect(pool.cooldownRemainingMs(m)).toBeGreaterThan(0);
    expect(pool.isHealthy(m)).toBe(false);
    // 5 consecutive failures → 4min window (60s * 2^2), capped at 15min later on
    for (let i = 0; i < 2; i++) pool.markFailure(m);
    expect(pool.cooldownRemainingMs(m)).toBeGreaterThan(3 * 60_000);
    // once the window elapses the model returns to the pool
    m.lastFailureAt = Date.now() - 16 * 60_000;
    expect(pool.isHealthy(m)).toBe(true);
    // a success resets the failure counter entirely
    pool.markFailure(m);
    pool.markSuccess(m);
    expect(pool.isHealthy(m)).toBe(true);
  });
});

// 2026-09-14 群聊全员沉默复盘：配额跟着 base_url+api_key 走，同 key 多模型时
// "个别模型 429" = 整组限流。软避让只改顺序与窗口，不落健康分、到期自愈。
describe('ModelPool endpoint-group capacity avoidance', () => {
  const groupConfigs = [
    { name: 'g1a', api_key: 'ka', base_url: 'u1', priority: 1, professional_weight: 90, cost_per_1k: 0.01, tags: ['code'] },
    { name: 'g1b', api_key: 'ka', base_url: 'u1', priority: 1, professional_weight: 80, cost_per_1k: 0.01, tags: ['code'] },
    { name: 'g2a', api_key: 'kb', base_url: 'u2', priority: 2, professional_weight: 70, cost_per_1k: 0.02, tags: ['code'] },
  ];

  it('容量信号让同端点组整体避让，其他组顶上', () => {
    const pool = new ModelPool(groupConfigs);
    const g1a = pool.getModel('g1a')!;
    pool.noteCapacityHit(g1a);
    // 同 key 的 g1b 也被视为限流组（软避让），选择落到 g2a
    expect(pool.capacityBlocked(g1a)).toBe(true);
    expect(pool.capacityBlocked(pool.getModel('g1b')!)).toBe(true);
    expect(pool.capacityBlocked(pool.getModel('g2a')!)).toBe(false);
    expect(pool.selectModel(['code'])!.name).toBe('g2a');
  });

  it('避让只改顺序不排除：全池同组限流仍能选出（链可硬撞）', () => {
    const pool = new ModelPool([{ name: 'only', api_key: 'k', base_url: 'u', priority: 1, professional_weight: 50, cost_per_1k: 0, tags: [] }]);
    pool.noteCapacityHit(pool.getModel('only')!);
    expect(pool.selectModel([])!.name).toBe('only');
    expect(pool.fallbackChain(pool.getModel('only')!).length).toBe(1);
  });

  it('降级链把容量组沉底但不剔除', () => {
    const pool = new ModelPool(groupConfigs);
    const g2a = pool.getModel('g2a')!;
    pool.noteCapacityHit(g2a);
    const chain = pool.fallbackChain(pool.getModel('g1a')!, ['code']);
    expect(chain[0].name).toBe('g1a'); // primary 永远在链首
    const order = chain.map((m) => m.name);
    expect(order.indexOf('g1b')).toBeLessThan(order.indexOf('g2a')); // 未限流组先于容量组
  });

  it('窗口过期自愈：不再影响选择', () => {
    vi.useFakeTimers();
    try {
      // 确定性选择：weight 0 的备胎永不被加权摇中，避让窗口内必落 g2a、过期后必回 g1a
      const pool = new ModelPool([
        { name: 'g1a', api_key: 'ka', base_url: 'u1', priority: 1, professional_weight: 90, cost_per_1k: 0.01, tags: ['code'] },
        { name: 'g2a', api_key: 'kb', base_url: 'u2', priority: 1, professional_weight: 0, cost_per_1k: 0.02, tags: ['code'] },
      ]);
      pool.noteCapacityHit(pool.getModel('g1a')!);
      expect(pool.selectModel(['code'])!.name).toBe('g2a');
      vi.advanceTimersByTime(ModelPool.CAPACITY_AVOID_MS + 1);
      expect(pool.capacityBlocked(pool.getModel('g1a')!)).toBe(false);
      expect(pool.selectModel(['code'])!.name).toBe('g1a');
    } finally {
      vi.useRealTimers();
    }
  });

  it('replaceModels 清空容量信号（改配置视为人工介入）', () => {
    const pool = new ModelPool(groupConfigs);
    pool.noteCapacityHit(pool.getModel('g1a')!);
    pool.replaceModels(groupConfigs);
    expect(pool.capacityBlocked(pool.getModel('g1a')!)).toBe(false);
  });
});
