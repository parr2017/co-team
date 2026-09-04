import type { TaskGraph, ProgressInfo } from './types';

/** Last progress broadcast per task — throttles proactive reporting to avoid message flooding. */
const lastBroadcast = new Map<string, number>();

export const PROGRESS_BROADCAST_INTERVAL_MS = 30_000;

/** Compute the unified progress snapshot from a task graph. */
export function computeProgress(graph: TaskGraph, message?: string, error?: string): ProgressInfo {
  const nodes = graph.nodes.filter((n) => n.agent !== 'orchestrator');
  const total = nodes.length;
  const completed = nodes.filter((n) => n.status === 'completed').length;
  const running = nodes.filter((n) => n.status === 'running' || n.status === 'retrying');
  const percent = total === 0 ? (graph.status === 'success' ? 100 : 0) : Math.round((completed / total) * 100);

  // ETA: average duration of completed nodes × remaining nodes (parallelism factored in roughly)
  let etaSec: number | undefined;
  const durations = nodes
    .filter((n) => n.started_at && n.finished_at)
    .map((n) => (new Date(n.finished_at as string).getTime() - new Date(n.started_at as string).getTime()) / 1000);
  if (durations.length && completed < total) {
    const avg = durations.reduce((s, d) => s + d, 0) / durations.length;
    const remaining = total - completed;
    const parallelism = Math.max(1, Math.min(running.length || 1, 4));
    etaSec = Math.max(0, Math.round((avg * remaining) / parallelism));
  }

  return {
    task_id: graph.task_id,
    status: graph.status,
    percent,
    completed,
    total,
    eta_sec: etaSec,
    current_nodes: running.map((n) => ({ id: n.id, name: n.name, agent: n.agent })),
    message,
    error,
    updated_at: new Date().toISOString(),
  };
}

/**
 * Throttled proactive reporting (improvement 6): milestone events pass immediately,
 * intermediate chatter is suppressed unless the interval elapsed.
 */
export function shouldBroadcast(taskId: string, force = false, now = Date.now()): boolean {
  if (force) {
    lastBroadcast.set(taskId, now);
    return true;
  }
  const last = lastBroadcast.get(taskId) ?? 0;
  if (now - last >= PROGRESS_BROADCAST_INTERVAL_MS) {
    lastBroadcast.set(taskId, now);
    return true;
  }
  return false;
}

export function clearProgressThrottle(taskId: string): void {
  lastBroadcast.delete(taskId);
}
