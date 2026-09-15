import { getLogger } from './logger';
import { getTaskGraph, persistGraph, emitProgress, appendJournal } from './store';
import { busSet } from './bus';
import { notify } from './notify';
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
 * 永续开发（2026-09-15，c2g0ya6d / 5wkawk89 / r6fn2mbb 复盘）：基础设施类失败
 * （模型池不稳/上下文超限/服务重启）自动重排，content 类失败才停靠人工。
 * 分类看节点 error_type：内容类任一出现即整体按 content 处理（人该看）；
 * 其余（capacity/context_overflow/other 未知模型侧）都算 infra——免费模型池的
 * 连接死亡/断流大多落在 other。
 */
export const CONTENT_ERROR_TYPES = new Set(['precondition', 'blocker', 'content', 'budget', 'system']);
/** 人工门失败（o3xmkraj 复盘）：环境/前置/审批类 needs_human——车道不锁、不自动重排，
 *  等人在任务上"已处理，从此节点继续"（POST /nodes/:id/retry） */
export const HUMAN_GATE_ERROR_TYPES = new Set(['human_gate']);
/** infra 失败自动重排的递增延时（1min → 5min → 15min，封顶） */
export const INFRA_REQUEUE_BACKOFF_MS = [60_000, 300_000, 900_000];

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
  private infraRequeueTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private logger = getLogger();

  constructor(
    private executor: TaskExecutor,
    private capacity: CapacityProbe,
    private maxInfraRetries = 3
  ) {}

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
    // the lane slot; approving/clarifying relaunches it through enqueue() with the slot held.
    // M5.1 修正（mv4yq6n0 派生死锁实证）：车道还有排队任务时必须放行——派生修复任务
    // 与父任务同车道，父任务停在人工门会把孩子永久堵死。父任务已暂停、不写工作区，
    // 派生任务接手安全；父任务批准恢复时经 enqueue() 重新排队，自然排在派生任务之后。
    if (status === 'waiting_approval' || status === 'waiting_clarify') {
      if (!lane.pending.length) return;
      lane.running = null;
      this.logger.info('Human-gate task releases lane to queued tasks', { lane: key, taskId, pending: lane.pending.length });
      this.tryStart(key);
      return;
    }
    lane.running = null;
    if (status === 'failed') {
      const failure = await this.classifyFailure(taskId);
      if (failure.kind === 'human_gate') {
        // 人工门失败（o3xmkraj 复盘）：环境/前置问题，锁车道只会堵死整个项目——
        // 保槽放行，等人在任务上"已处理，从此节点继续"（POST /nodes/:id/retry）
        this.logger.warn('Human-gate failure — lane released, awaiting manual node retry', { lane: key, taskId, nodes: (await getTaskGraph(taskId))?.nodes.filter((n) => n.status === 'failed').length });
        await emitProgress('queue_human_gate', { lane: key, task_id: taskId, message: '任务停在人工门：修复环境后在任务详情点「已处理，从此节点继续」' });
        await notify('queue_human_gate', { task_id: taskId }, `[Co-Team] 任务 ${taskId} 停在人工门（需人工介入），车道已放行——处理后请在任务详情点「从此节点继续」`);
        this.tryStart(key);
        return;
      }
      if (failure.kind === 'infra' && (failure.retries ?? 0) < this.maxInfraRetries) {
        // 永续开发：infra 失败不锁车道——递增延时自动重排（execute 重跑会自动复位
        // 非 completed 节点），车道让给后续任务，模型池恢复后本任务自动续命
        const attempt = (failure.retries ?? 0) + 1;
        const delayMs = INFRA_REQUEUE_BACKOFF_MS[Math.min(attempt - 1, INFRA_REQUEUE_BACKOFF_MS.length - 1)];
        const delaySec = Math.round(delayMs / 1000);
        this.logger.warn('Infra failure — auto requeue (lane stays open)', { lane: key, taskId, attempt, max: this.maxInfraRetries, delay_sec: delaySec });
        await appendJournal(taskId, 'orchestrator', {
          role: 'master', kind: 'error',
          text: `⚡ 模型池/基础设施不稳导致失败，第 ${attempt}/${this.maxInfraRetries} 次自动重排（${delaySec}s 后）——内容无问题，无需人工`,
          ts: new Date().toISOString(), node_id: '', node_name: '',
        });
        await emitProgress('queue_auto_requeue', { lane: key, task_id: taskId, attempt, max: this.maxInfraRetries, delay_sec: delaySec });
        this.scheduleInfraRequeue(taskId, failure.projectId ?? null, failure.workspace, delayMs);
        await emitProgress('queue_update', { lane: key, ...this.snapshot(key) });
        this.tryStart(key); // 车道已让空：后续排队任务照常启动
        return;
      }
      lane.blocked = true;
      lane.blockedBy = taskId;
      lane.blockedReason = failure.kind === 'infra'
        ? `任务 ${taskId} 基础设施类失败且自动重排已达上限（${this.maxInfraRetries} 次），队列已阻塞，请处理后手动恢复`
        : `任务 ${taskId} 内容/需求类失败，队列已阻塞，请处理后手动恢复`;
      this.logger.warn('Queue blocked by failed task', { lane: key, taskId, failure_class: failure.kind });
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

  /** 人工门任务收场（命令被拒绝/任务转失败）后释放车道槽位——waiting_approval
   *  期间 lane.running 仍指向本任务，不释放会让同车道后续任务永久排队。 */
  releaseStalled(taskId: string): QueueSnapshot | null {
    const key = this.taskLane.get(taskId);
    if (!key) return null;
    const lane = this.lane(key);
    if (lane.running === taskId) {
      lane.running = null;
      this.logger.info('Stalled human-gate task released its lane slot', { lane: key, taskId });
      this.tryStart(key);
    }
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

  /** 任务失败分型：看节点 error_type 汇总——任一内容类即 content，否则 infra。 */
  private async classifyFailure(taskId: string): Promise<{
    kind: 'infra' | 'content' | 'human_gate';
    retries?: number;
    projectId?: string | null;
    workspace?: string;
  }> {
    try {
      const graph = await getTaskGraph(taskId);
      if (!graph) return { kind: 'content' };
      // 未记录 error_type（历史图/异常路径）保守按 content 处理——只有明确分型的才走 infra 自动重排
      const failedNodes = (graph.nodes || []).filter((n) => n.status === 'failed');
      const hasContent = failedNodes.some((n) => {
        const t = String((n as any).error_type || '');
        return !t || CONTENT_ERROR_TYPES.has(t);
      });
      const hasHumanGate = failedNodes.some((n) => HUMAN_GATE_ERROR_TYPES.has(String((n as any).error_type || '')));
      return {
        kind: hasContent ? 'content' : hasHumanGate ? 'human_gate' : 'infra',
        retries: graph.infra_retries ?? 0,
        projectId: graph.project_id ?? null,
        workspace: graph.workspace,
      };
    } catch {
      return { kind: 'content' };
    }
  }

  /** infra 失败的延时自动重排：到点重新 enqueue（车道此时已让空，其他任务先行）。 */
  private scheduleInfraRequeue(taskId: string, projectId: string | null, workspace: string | undefined, delayMs: number): void {
    const prev = this.infraRequeueTimers.get(taskId);
    if (prev) clearTimeout(prev);
    const timer = setTimeout(async () => {
      this.infraRequeueTimers.delete(taskId);
      try {
        const graph = await getTaskGraph(taskId);
        // 用户在等待窗口里删了任务/手动改了状态/手动重发——不抢跑
        if (!graph || graph.status !== 'failed') return;
        graph.infra_retries = (graph.infra_retries ?? 0) + 1;
        await persistGraph(graph);
        await this.enqueue(taskId, projectId, workspace || graph.workspace);
        this.logger.info('Infra requeue fired', { taskId, attempt: graph.infra_retries });
      } catch (e) {
        this.logger.error('Infra requeue failed', { taskId, error: String(e).slice(0, 200) });
      }
    }, delayMs);
    this.infraRequeueTimers.set(taskId, timer);
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
