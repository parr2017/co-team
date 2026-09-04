import { describe, expect, it, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { simpleGit } from 'simple-git';
import { initBus, closeBus, busGet, busSet } from '../src/bus';
import { saveTaskGraph } from '../src/store';
import { createSnapshot, getAuditLog, getSnapshot, listSnapshots, rollbackSnapshot } from '../src/snapshot';

beforeEach(async () => {
  process.env.COTEAM_FORCE_MEMORY = '1';
  closeBus();
  await initBus({ host: '127.0.0.1', port: 6399, db: 0 });
});

async function makeRepo(): Promise<{ dir: string; firstCommit: string }> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-snap-'));
  const g = simpleGit({ baseDir: dir });
  await g.init();
  await g.addConfig('user.name', 't');
  await g.addConfig('user.email', 't@t');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'v1');
  await g.add('-A');
  await g.commit('first');
  const log = await g.log({ maxCount: 1 });
  return { dir, firstCommit: log.latest!.hash };
}

describe('snapshots & rollback (improvement 10)', () => {
  it('creates snapshots with git ref + KV state export and indexes them', async () => {
    const { dir, firstCommit } = await makeRepo();
    await saveTaskGraph('t-snap', [], [], { description: 'd', workspace: dir });
    await busSet('task:t-snap:goal:test', { content: 'goal' });

    const snap = await createSnapshot('t-snap', { tag: 'task-start', workspace: dir });
    expect(snap.git_ref).toBe(firstCommit);
    expect(snap.kv_keys).toContain('task:t-snap:goal:test');
    expect((await listSnapshots({ task_id: 't-snap' }))[0].id).toBe(snap.id);
    expect(await getSnapshot(snap.id)).not.toBeNull();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('refuses rollback without explicit confirmation and audits attempts', async () => {
    const { dir } = await makeRepo();
    await saveTaskGraph('t-snap2', [], [], { description: 'd', workspace: dir });
    const snap = await createSnapshot('t-snap2', { tag: 'task-end', workspace: dir });
    await expect(rollbackSnapshot(snap.id, { confirmed: false })).rejects.toThrow('confirmation');
    await expect(rollbackSnapshot('no-such-snap', { confirmed: true })).rejects.toThrow('not found');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('rolls back KV state atomically: post-snapshot keys removed, snapshot values restored', async () => {
    const { dir } = await makeRepo();
    await saveTaskGraph('t-snap3', [], [], { description: 'd', workspace: dir });
    await busSet('task:t-snap3:goal:x', { content: 'v1' });
    const snap = await createSnapshot('t-snap3', { tag: 'decision', workspace: dir });

    // mutate after the snapshot: change value + create a post-snapshot key
    await busSet('task:t-snap3:goal:x', { content: 'v2' });
    await busSet('task:t-snap3:agent:dev:session', [{ role: 'user', content: 'new' }]);

    const result = await rollbackSnapshot(snap.id, { confirmed: true });
    expect(result.ok).toBe(true);
    expect(result.kv_restored).toBeGreaterThanOrEqual(1);
    expect(await busGet('task:t-snap3:goal:x')).toEqual({ content: 'v1' });
    expect(await busGet('task:t-snap3:agent:dev:session')).toBeNull(); // post-snapshot key removed

    const audit = await getAuditLog();
    expect(audit.some((a) => a.action === 'rollback' && (a.detail as any).snapshot_id === snap.id)).toBe(true);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('sandbox rollback hard-resets to the snapshot ref', async () => {
    const { dir, firstCommit } = await makeRepo();
    await saveTaskGraph('t-snap4', [], [], { description: 'd', workspace: dir });
    const snap = await createSnapshot('t-snap4', { tag: 'task-start', sandbox: dir });

    fs.writeFileSync(path.join(dir, 'a.txt'), 'v2-broken');
    const g = simpleGit({ baseDir: dir });
    await g.add('-A');
    await g.commit('broken work');

    const result = await rollbackSnapshot(snap.id, { confirmed: true, sandbox: dir });
    expect(result.git_action).toContain('reset');
    expect(fs.readFileSync(path.join(dir, 'a.txt'), 'utf-8')).toBe('v1');
    const log = await g.log({ maxCount: 1 });
    expect(log.latest!.hash).toBe(firstCommit);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
