import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { initBus, closeBus } from '../src/bus';
import { saveTaskGraph, listTaskGraphsPaged } from '../src/store';

beforeEach(async () => {
  process.env.COTEAM_FORCE_MEMORY = '1';
  closeBus();
  await initBus({ host: '127.0.0.1', port: 6399, db: 0 });
});

afterEach(() => closeBus());

describe('listTaskGraphsPaged keyword search (R4)', () => {
  beforeEach(async () => {
    await saveTaskGraph('ts-abc123', [], [], { description: '实现用户登录模块 JWT', workspace: 'D:/w' });
    await saveTaskGraph('ts-def456', [], [], { description: '优化缓存 retry 策略', workspace: 'D:/w' });
    await saveTaskGraph('ts-ghi789', [], [], { description: 'WRITE DOCS FOR LOGIN', workspace: 'D:/w' });
  });

  it('filters by description keyword, case-insensitive', async () => {
    const r = await listTaskGraphsPaged(1, 20, { q: '登录' });
    expect(r.total).toBe(1);
    expect(r.items.map((g) => g.task_id)).toEqual(['ts-abc123']);
  });

  it('matches partial and case-insensitive English words', async () => {
    const r = await listTaskGraphsPaged(1, 20, { q: 'LOGIN' });
    expect(r.items.map((g) => g.task_id)).toEqual(['ts-ghi789']);
    const r2 = await listTaskGraphsPaged(1, 20, { q: 'docs' });
    expect(r2.items.map((g) => g.task_id)).toEqual(['ts-ghi789']);
  });

  it('filters by task_id', async () => {
    const r = await listTaskGraphsPaged(1, 20, { q: 'ABC12' });
    expect(r.items.map((g) => g.task_id)).toEqual(['ts-abc123']);
  });

  it('combines with project_id filter', async () => {
    await saveTaskGraph('ts-prj-1', [], [], { description: '登录 in project', workspace: 'D:/w', project_id: 'p1' });
    // project filter narrows to p1's tasks, keyword narrows within them
    const r = await listTaskGraphsPaged(1, 20, { project_id: 'p1', q: '登录' });
    expect(r.items.map((g) => g.task_id)).toEqual(['ts-prj-1']);
    const rNone = await listTaskGraphsPaged(1, 20, { project_id: 'p1', q: '不存在xyz' });
    expect(rNone.total).toBe(0);
    // external (project_id: null) excludes the project task even though its description matches
    const rExternal = await listTaskGraphsPaged(1, 20, { project_id: null, q: '登录' });
    expect(rExternal.items.map((g) => g.task_id)).toEqual(['ts-abc123']);
  });

  it('blank / whitespace q behaves like no filter', async () => {
    const r = await listTaskGraphsPaged(1, 20, { q: '   ' });
    expect(r.total).toBe(3);
  });

  it('no match returns empty page with total 0', async () => {
    const r = await listTaskGraphsPaged(1, 20, { q: '不存在的关键词xyz' });
    expect(r.total).toBe(0);
    expect(r.items).toEqual([]);
  });
});
