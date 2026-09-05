import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { TaskQueueManager } from '../src/taskQueue';
import { saveTaskGraph, getTaskGraph } from '../src/store';
import { initBus, closeBus } from '../src/bus';

beforeAll(async () => {
  // unreachable redis → bus falls back to in-memory, which is what the tests want
  await initBus({ host: '127.0.0.1', port: 6399, db: 0 });
});
afterAll(async () => {
  await closeBus();
});

const tick = () => new Promise((r) => setTimeout(r, 5));

function makeQueue(initialCapacity = 10) {
  const probe = { capacity: initialCapacity, usableCapacity: () => probe.capacity };
  const calls: string[] = [];
  const gates = new Map<string, ((r: { status: string }) => void)[]>();
  const executor = {
    execute: (taskId: string) => {
      calls.push(taskId);
      return new Promise<{ status: string }>((resolve) => {
        const list = gates.get(taskId) || [];
        list.push(resolve);
        gates.set(taskId, list);
      });
    },
  };
  const mgr = new TaskQueueManager(executor, probe);
  const finish = (taskId: string, status: string) => {
    gates.get(taskId)?.shift()?.({ status });
  };
  return { mgr, probe, calls, finish };
}

async function seedTask(taskId: string, projectId?: string) {
  await saveTaskGraph(
    taskId,
    [{ id: 'n1', task_id: taskId, name: '节点', status: 'pending', agent: 'dev', result: null, error: '', retry_count: 0, complexity: 'normal', requires_approval: false, needs_human: false } as any],
    [],
    { description: `任务 ${taskId}`, workspace: '/tmp/ws', status: 'planned', project_id: projectId }
  );
}

describe('TaskQueueManager', () => {
  it('same project: second task waits in queue until the first finishes', async () => {
    const { mgr, calls, finish } = makeQueue();
    await seedTask('qa', 'p1');
    await seedTask('qb', 'p1');

    await mgr.enqueue('qa', 'p1', '/tmp/ws');
    await tick();
    expect(calls).toEqual(['qa']);

    await mgr.enqueue('qb', 'p1', '/tmp/ws');
    await tick();
    // B stays queued while A runs
    expect(calls).toEqual(['qa']);
    expect((await getTaskGraph('qb'))!.status).toBe('queued');
    const snap = mgr.snapshots().find((s) => s.key === 'p1')!;
    expect(snap.running_task_id).toBe('qa');
    expect(snap.pending.map((e) => e.task_id)).toEqual(['qb']);
    expect(snap.blocked).toBe(false);

    finish('qa', 'success');
    await tick();
    expect(calls).toEqual(['qa', 'qb']);
  });

  it('a failed task blocks its lane until the user resumes it', async () => {
    const { mgr, calls, finish } = makeQueue();
    await seedTask('qa', 'p1');
    await seedTask('qb', 'p1');

    await mgr.enqueue('qa', 'p1', '/tmp/ws');
    await mgr.enqueue('qb', 'p1', '/tmp/ws');
    await tick();

    finish('qa', 'failed');
    await tick();
    // B must NOT auto-start after A failed
    expect(calls).toEqual(['qa']);
    const snap = mgr.snapshots().find((s) => s.key === 'p1')!;
    expect(snap.blocked).toBe(true);
    expect(snap.blocked_by).toBe('qa');

    mgr.resume('p1');
    await tick();
    expect(calls).toEqual(['qa', 'qb']);
    expect(mgr.snapshots().find((s) => s.key === 'p1')!.blocked).toBe(false);
  });

  it('different projects run concurrently', async () => {
    const { mgr, calls } = makeQueue();
    await seedTask('qa', 'p1');
    await seedTask('qb', 'p2');

    await mgr.enqueue('qa', 'p1', '/tmp/ws');
    await mgr.enqueue('qb', 'p2', '/tmp/ws');
    await tick();
    expect(calls).toEqual(['qa', 'qb']);
  });

  it('no model capacity defers the start instead of failing the task', async () => {
    const { mgr, probe, calls } = makeQueue(0);
    await seedTask('qa', 'p1');

    await mgr.enqueue('qa', 'p1', '/tmp/ws');
    await tick();
    expect(calls).toEqual([]);
    expect((await getTaskGraph('qa'))!.status).toBe('queued');

    probe.capacity = 5;
    mgr.resume('p1');
    await tick();
    expect(calls).toEqual(['qa']);
  });

  it('cancelled pending task is dropped from the queue', async () => {
    const { mgr, calls, finish } = makeQueue();
    await seedTask('qa', 'p1');
    await seedTask('qb', 'p1');

    await mgr.enqueue('qa', 'p1', '/tmp/ws');
    await mgr.enqueue('qb', 'p1', '/tmp/ws');
    await mgr.removePending('qb');
    await tick();

    finish('qa', 'success');
    await tick();
    expect(calls).toEqual(['qa']);
    expect(mgr.snapshots().find((s) => s.key === 'p1')!.pending).toEqual([]);
  });
});
