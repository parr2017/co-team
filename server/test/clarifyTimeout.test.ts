import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { initBus, closeBus, getBus } from '../src/bus';
import { saveTaskGraph } from '../src/store';
import { scanClarifyTimeouts } from '../src/clarifyTimeout';

let captured: { type: string; payload: Record<string, unknown> }[] = [];

beforeEach(async () => {
  process.env.COTEAM_FORCE_MEMORY = '1';
  closeBus();
  captured = [];
  await initBus({ host: '127.0.0.1', port: 6399, db: 0 });
  getBus().subscribe('coteam:dashboard', (msg: any) => captured.push(msg));
});

afterEach(() => closeBus());

function hoursAgo(h: number): string {
  return new Date(Date.now() - h * 3600_000).toISOString();
}

describe('clarify timeout scanner (R5)', () => {
  it('reminds once for a task stuck in clarifying past the threshold, then never again', async () => {
    await saveTaskGraph('t-stuck', [], [], {
      description: '卡住的澄清任务',
      workspace: 'D:/w',
      status: 'clarifying',
    });
    // force the updated_at to be older than the cutoff by re-saving with a backdated timestamp
    const { busSet } = await import('../src/bus');
    const graph = { ...(await (await import('../src/store')).getTaskGraph('t-stuck'))! };
    graph.updated_at = hoursAgo(30);
    await busSet('task:graph:t-stuck', graph);

    const first = await scanClarifyTimeouts({ timeoutHours: 24 });
    expect(first).toContain('t-stuck');
    expect(captured.some((e) => e.type === 'clarify_timeout' && e.payload.task_id === 't-stuck')).toBe(true);

    // second scan: same stuck task → no repeat reminder (KV flag)
    captured = [];
    const second = await scanClarifyTimeouts({ timeoutHours: 24 });
    expect(second).not.toContain('t-stuck');
    expect(captured.some((e) => e.type === 'clarify_timeout')).toBe(false);
  });

  it('does not remind for fresh clarifying tasks or non-clarifying statuses', async () => {
    const { busSet } = await import('../src/bus');
    await saveTaskGraph('t-fresh', [], [], { description: '新的澄清', workspace: 'D:/w', status: 'clarifying' });
    await saveTaskGraph('t-running', [], [], { description: '跑着的', workspace: 'D:/w', status: 'running' });
    const g = { ...(await (await import('../src/store')).getTaskGraph('t-running'))! };
    g.updated_at = hoursAgo(48);
    await busSet('task:graph:t-running', g);

    const reminded = await scanClarifyTimeouts({ timeoutHours: 24 });
    expect(reminded).not.toContain('t-fresh');
    expect(reminded).not.toContain('t-running');
  });
});
