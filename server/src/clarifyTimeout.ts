import { busGet, busSet } from './bus';
import { emitProgress, listTaskGraphs } from './store';
import { notify } from './notify';
import { getLogger } from './logger';

export interface ClarifyTimeoutOptions {
  /** hours a task may stay in 'clarifying' before the reminder fires */
  timeoutHours: number;
  /** scan interval in minutes (default 10) */
  intervalMinutes?: number;
}

/** One-shot reminder flag per task, so a stuck task never spams the user. */
const reminderKey = (taskId: string) => `task:clarify:reminded:${taskId}`;

/**
 * Improvement 5 (R5): clarification-loop timeout. Tasks parked in 'clarifying'
 * block the whole pipeline — if the human never answers, the system nudges them
 * once after the configured threshold and never again for the same task.
 */
export async function scanClarifyTimeouts(opts: ClarifyTimeoutOptions): Promise<string[]> {
  const cutoff = Date.now() - opts.timeoutHours * 3600_000;
  const graphs = await listTaskGraphs();
  const reminded: string[] = [];
  for (const g of graphs) {
    if (g.status !== 'clarifying') continue;
    const updated = new Date(g.updated_at || g.created_at || Date.now()).getTime();
    if (updated > cutoff) continue;
    if (await busGet(reminderKey(g.task_id))) continue; // already reminded once
    await busSet(reminderKey(g.task_id), { reminded_at: new Date().toISOString() });
    await emitProgress('clarify_timeout', {
      task_id: g.task_id,
      stuck_hours: Math.round((Date.now() - updated) / 3600_000),
      description: (g.description || '').slice(0, 100),
    });
    notify('clarify_timeout', { task_id: g.task_id }, `[Co-Team] 任务 ${g.task_id} 已在需求澄清状态等待超过 ${opts.timeoutHours} 小时，请回复澄清问题以继续`);
    getLogger().warn('Clarification timeout reminder sent', { taskId: g.task_id, stuckHours: Math.round((Date.now() - updated) / 3600_000) });
    reminded.push(g.task_id);
  }
  return reminded;
}

/** Start the periodic scan (used by server startup; returns the timer for tests). */
export function startClarifyTimeoutScanner(opts: ClarifyTimeoutOptions): NodeJS.Timeout {
  const intervalMs = (opts.intervalMinutes ?? 10) * 60_000;
  const tick = () => {
    scanClarifyTimeouts(opts).catch(() => { /* scan errors must never crash the server */ });
  };
  // first pass after a short warm-up so the server finishes booting first
  const warmup = setTimeout(tick, 30_000);
  warmup.unref?.();
  const timer = setInterval(tick, intervalMs);
  timer.unref?.();
  return timer;
}
