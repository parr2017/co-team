import { describe, expect, it } from 'vitest';
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
