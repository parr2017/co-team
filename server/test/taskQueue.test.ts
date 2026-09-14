import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { TaskQueueManager } from '../src/taskQueue';
import { saveTaskGraph, getTaskGraph, persistGraph } from '../src/store';
import { initBus, closeBus } from '../src/bus';

beforeAll(async () => {
  // unreachable redis → bus falls back to in-memory, which is what the tests want
  await initBus({ host: '127.0.0.1', port: 6399, db: 0 });
});
afterAll(async () => {
  await closeBus();
});

const tick = () => new Promise((r) => setTimeout(r, 5));

function makeQueue(initialCapacity = 10, maxInfraRetries = 3) {
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
  const mgr = new TaskQueueManager(executor, probe, maxInfraRetries);
  const finish = (taskId: string, status: string) => {
    gates.get(taskId)?.shift()?.({ status });
  };
  return { mgr, probe, calls, finish };
}

async function seedTask(taskId: string, projectId?: string, nodeExtra: Record<string, unknown> = {}) {
  await saveTaskGraph(
    taskId,
    [{ id: 'n1', task_id: taskId, name: '节点', status: 'pending', agent: 'dev', result: null, error: '', retry_count: 0, complexity: 'normal', requires_approval: false, needs_human: false, ...nodeExtra } as any],
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

  it('content-class failure (precondition) blocks the lane until the user resumes it', async () => {
    const { mgr, calls, finish } = makeQueue();
    await seedTask('qa', 'p1', { status: 'failed', error_type: 'precondition' });
    await seedTask('qb', 'p1');

    await mgr.enqueue('qa', 'p1', '/tmp/ws');
    await mgr.enqueue('qb', 'p1', '/tmp/ws');
    await tick();

    finish('qa', 'failed');
    await tick();
    // B must NOT auto-start after A failed (content failure = human decision)
    expect(calls).toEqual(['qa']);
    const snap = mgr.snapshots().find((s) => s.key === 'p1')!;
    expect(snap.blocked).toBe(true);
    expect(snap.blocked_by).toBe('qa');

    mgr.resume('p1');
    await tick();
    expect(calls).toEqual(['qa', 'qb']);
    expect(mgr.snapshots().find((s) => s.key === 'p1')!.blocked).toBe(false);
  });

  it('infra-class failure (model side) auto-requeues without blocking the lane', async () => {
    vi.useFakeTimers();
    try {
      const { mgr, calls, finish } = makeQueue();
      // 失败节点带明确 infra 分型（'other' = 未知模型侧错误）
      await seedTask('qi', 'p1', { status: 'failed', error_type: 'other' });
      await seedTask('qb', 'p1');

      await mgr.enqueue('qi', 'p1', '/tmp/ws');
      await mgr.enqueue('qb', 'p1', '/tmp/ws');
      await vi.advanceTimersByTimeAsync(10);
      expect(calls).toEqual(['qi']);

      finish('qi', 'failed');
      // 真实 orchestrator 失败时会把 graph 标 failed——模拟器同样照做，
      // 否则 requeue 的守卫（只重排 failed 任务）会正确地拒绝触发
      const failed = await getTaskGraph('qi');
      failed!.status = 'failed';
      await persistGraph(failed!);
      await vi.advanceTimersByTimeAsync(10);
      // 车道不锁：qb 立即启动；qi 进入 60s 自动重排
      expect(calls).toEqual(['qi', 'qb']);
      expect(mgr.snapshots().find((s) => s.key === 'p1')!.blocked).toBe(false);

      // 60s 到点：qi 重新排队（此时 qb 在跑，qi 排队等待）
      await vi.advanceTimersByTimeAsync(60_000);
      expect((await getTaskGraph('qi'))!.infra_retries).toBe(1);
      expect(mgr.snapshots().find((s) => s.key === 'p1')!.pending.map((e) => e.task_id)).toEqual(['qi']);

      finish('qb', 'success');
      await vi.advanceTimersByTimeAsync(10);
      expect(calls).toEqual(['qi', 'qb', 'qi']); // qi 自动续命
    } finally {
      vi.useRealTimers();
    }
  }, 15_000);

  it('infra failure beyond max requeues blocks the lane', async () => {
    const { mgr, calls, finish } = makeQueue(10, 2);
    await seedTask('qx', 'p9', { status: 'failed', error_type: 'capacity' });
    // saveTaskGraph 的 meta 不透传 infra_retries——直接改存量图
    const seeded = await getTaskGraph('qx');
    seeded!.infra_retries = 2;
    await persistGraph(seeded!);

    await mgr.enqueue('qx', 'p9', '/tmp/ws');
    await tick();
    finish('qx', 'failed');
    await tick();
    // 已达上限（infra_retries=2 >= max=2）：锁车道
    expect(calls).toEqual(['qx']);
    expect(mgr.snapshots().find((s) => s.key === 'p9')!.blocked).toBe(true);
  });

  it('legacy graphs without error_type keep the conservative block behavior', async () => {
    const { mgr, calls, finish } = makeQueue();
    await seedTask('ql', 'p8', { status: 'failed' }); // 无 error_type
    await mgr.enqueue('ql', 'p8', '/tmp/ws');
    await tick();
    finish('ql', 'failed');
    await tick();
    expect(mgr.snapshots().find((s) => s.key === 'p8')!.blocked).toBe(true);
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
