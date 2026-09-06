import { getLogger } from './logger';
import { getTaskGraph, persistGraph, emitProgress } from './store';
import { busSet } from './bus';
import type { TaskStatus } from './types';

/** Minimal execution surface (satisfied by Orchestrator). */
export interface TaskExecutor {
  execute(taskId: string, workspace: string): Promise<{ status?: string }>;
}

/** Minimal model-pool surface (satisfied by ModelPool). */
export interface CapacityProbe {
  usableCapacity(): number;
}

export interface QueueEntry {
  task_id: string;
  workspace: string;
  enqueued_at: string;
}

export interface QueueSnapshot {
  key: string;
  project_id: string | null;
  running_task_id: string | null;
  pending: QueueEntry[];
  blocked: boolean;
  blocked_reason: string;
  blocked_by: string | null;
}

interface Lane {
  running: string | null;
  pending: QueueEntry[];
  blocked: boolean;
  blockedReason: string;
  blockedBy: string | null;
}

const CAPACITY_RETRY_MS = 10_000;

/**
 * Project-scoped task queues. Rules:
 * - one lane per project (project_id; tasks without a project share the `default` lane) —
 *   within a lane tasks run strictly one at a time, in enqueue order;
 * - different lanes run concurrently;
 * - a lane only starts its next task when the model pool has usable capacity,
 *   otherwise the start is retried shortly instead of failing the task;
 * - a failed task (including model-allocation failure) BLOCKS its lane — the user
 *   decides when to resume (POST /api/queues/:key/resume). User cancellation does not block.
 *
 * Lane state is in-memory: tasks marked `queued` survive a restart in the graph store,
 * but the queue itself must be rebuilt by re-executing them manually.
 */
export class TaskQueueManager {
  private lanes = new Map<string, Lane>();
  private taskLane = new Map<string, string>();
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private logger = getLogger();

  constructor(private executor: TaskExecutor, private capacity: CapacityProbe) {}

  private keyFor(projectId?: string | null): string {
    return projectId || 'default';
  }

  private lane(key: string): Lane {
    let lane = this.lanes.get(key);
    if (!lane) {
      lane = { running: null, pending: [], blocked: false, blockedReason: '', blockedBy: null };
      this.lanes.set(key, lane);
    }
    return lane;
  }

  /**
   * Queue a task for execution. If the task already owns the lane slot (e.g. resuming
   * after node approval) it relaunches immediately; otherwise it joins the pending
   * tail and starts only when it reaches the head of an unblocked lane.
   */
  async enqueue(taskId: string, projectId: string | null | undefined, workspace: string): Promise<QueueSnapshot> {
    const key = this.keyFor(projectId);
    const lane = this.lane(key);
    this.taskLane.set(taskId, key);

    if (lane.running === taskId) {
      this.launch(taskId, workspace);
      return this.snapshot(key);
    }
    if (!lane.pending.some((e) => e.task_id === taskId)) {
      lane.pending.push({ task_id: taskId, workspace, enqueued_at: new Date().toISOString() });
      await this.setGraphStatus(taskId, 'queued');
    }
    this.tryStart(key);
    return this.snapshot(key);
  }

  private tryStart(key: string): void {
    const lane = this.lanes.get(key);
    if (!lane || lane.running || lane.blocked) return;
    const head = lane.pending[0];
    if (!head) return;
    if (this.capacity.usableCapacity() <= 0) {
      // model pool exhausted — defer the start instead of burning the task on
      // an immediate 'No available model' failure
      this.logger.info('Queue start deferred: no model capacity', { lane: key, taskId: head.task_id });
      this.scheduleCapacityRetry();
      return;
    }
    lane.pending.shift();
    lane.running = head.task_id;
    this.logger.info('Queue dispatching task', { lane: key, taskId: head.task_id, pendingLeft: lane.pending.length });
    void this.launch(head.task_id, head.workspace);
  }

  private async launch(taskId: string, workspace: string): Promise<void> {
    this.logger.info('Starting background task execution', { taskId, workspace });
    let status = 'failed';
    try {
      const result = await this.executor.execute(taskId, workspace);
      status = String(result?.status || 'failed');
    } catch (e) {
      const error = String(e).slice(0, 500);
      this.logger.error('Background task execution failed', { taskId, error });
      // surface the failure on the graph itself — a task must never be left 'running' or vanish from the list
      try {
        const graph = await getTaskGraph(taskId);
        if (graph) {
          graph.status = 'failed';
          await persistGraph(graph);
        }
      } catch { /* best effort */ }
      await busSet(`task:graph:${taskId}:bg_error`, { error }).catch(() => {});
    }
    await this.onFinished(taskId, status);
  }

  private async onFinished(taskId: string, status: string): Promise<void> {
    const key = this.taskLane.get(taskId);
    const lane = key ? this.lanes.get(key) : undefined;
    if (!key || !lane || lane.running !== taskId) return;
    // waiting_approval / waiting_clarify: the task is paused on a human gate, it keeps
    // the lane slot; approving/clarifying relaunches it through enqueue() with the slot held
    if (status === 'waiting_approval' || status === 'waiting_clarify') return;
    lane.running = null;
    if (status === 'failed') {
      lane.blocked = true;
      lane.blockedBy = taskId;
      lane.blockedReason = `任务 ${taskId} 执行失败（含模型分配失败），队列已阻塞，请处理后手动恢复`;
      this.logger.warn('Queue blocked by failed task', { lane: key, taskId });
      await emitProgress('queue_update', { lane: key, ...this.snapshot(key) });
      return; // do not start the next task — user decides when to resume
    }
    await emitProgress('queue_update', { lane: key, ...this.snapshot(key) });
    this.tryStart(key);
  }

  /** Unblock a lane and start the next pending task (user-initiated resume). */
  resume(key: string): QueueSnapshot {
    // resume/clear on an unknown key is a caller mistake — refuse instead of
    // fabricating an empty lane that then lingers in snapshots()
    if (!this.lanes.has(key)) throw new Error(`queue not found: ${key}`);
    const lane = this.lane(key);
    lane.blocked = false;
    lane.blockedReason = '';
    lane.blockedBy = null;
    this.logger.info('Queue resumed by user', { lane: key });
    this.tryStart(key);
    return this.snapshot(key);
  }

  /** Drop all pending tasks of a lane; they return to plain 'pending' status. */
  async clear(key: string): Promise<QueueSnapshot> {
    if (!this.lanes.has(key)) throw new Error(`queue not found: ${key}`);
    const lane = this.lane(key);
    const dropped = lane.pending.splice(0);
    for (const entry of dropped) {
      await this.setGraphStatus(entry.task_id, 'pending');
      this.taskLane.delete(entry.task_id);
    }
    await emitProgress('queue_update', { lane: key, ...this.snapshot(key) });
    return this.snapshot(key);
  }

  /** Drop one task from wherever it is pending (e.g. the user cancelled it). */
  async removePending(taskId: string): Promise<void> {
    const key = this.taskLane.get(taskId);
    if (!key) return;
    const lane = this.lanes.get(key);
    if (!lane) return;
    const before = lane.pending.length;
    lane.pending = lane.pending.filter((e) => e.task_id !== taskId);
    if (lane.pending.length !== before) {
      await this.setGraphStatus(taskId, 'pending');
      await emitProgress('queue_update', { lane: key, ...this.snapshot(key) });
    }
  }

  snapshots(): QueueSnapshot[] {
    return [...this.lanes.keys()].map((k) => this.snapshot(k));
  }

  private snapshot(key: string): QueueSnapshot {
    const lane = this.lane(key);
    return {
      key,
      project_id: key === 'default' ? null : key,
      running_task_id: lane.running,
      pending: [...lane.pending],
      blocked: lane.blocked,
      blocked_reason: lane.blockedReason,
      blocked_by: lane.blockedBy,
    };
  }

  private scheduleCapacityRetry(): void {
    if (this.retryTimer) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      for (const key of this.lanes.keys()) this.tryStart(key);
    }, CAPACITY_RETRY_MS);
  }

  private async setGraphStatus(taskId: string, status: TaskStatus): Promise<void> {
    try {
      const graph = await getTaskGraph(taskId);
      if (graph) {
        graph.status = status;
        await persistGraph(graph);
      }
    } catch (e) {
      this.logger.warn('Failed to update queued task status', { taskId, status, error: String(e).slice(0, 200) });
    }
  }
}
