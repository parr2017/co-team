/**
 * Quality metrics (P0-1/P0-2 measurement): aggregate node-level quality signals
 * that already live on the task graph — fix-loop rounds, test-fix outcomes,
 * structured defects and their fix-task closure, and delivery consistency
 * (reported changes vs actual git working-tree changes).
 *
 * Per-task-run samples are appended to a per-day bus key so /api/metrics/trend
 * can show evolution over time without a separate database.
 */
import { busGet, busKeys, busSet } from './bus';
import type { TaskGraph, TaskNode } from './types';

export interface QualitySummary {
  /** nodes that went through the test-fix loop, and the rounds they needed */
  fix_loop_nodes: number;
  fix_rounds_avg: number;
  fix_rounds_max: number;
  /** nodes with a structured test report: pass rate among them */
  test_reported_nodes: number;
  test_pass_rate: number;
  /** P0-2: defects reported by agents + how many became fix tasks / got closed */
  defects_total: number;
  defects_converted: number;
  defects_closed: number;
  defect_close_rate: number;
  /** P0-1: reported-vs-actual change consistency */
  delivery_checked_nodes: number;
  delivery_consistent_rate: number;
}

/** Summarize quality signals across a set of task graphs. */
export function summarizeQuality(graphs: TaskGraph[]): QualitySummary {
  const nodes = graphs.flatMap((g) => g.nodes.filter((n) => n.agent !== 'orchestrator'));

  const reportNodes = nodes.filter((n) => n.result?.report);
  const fixRounds = reportNodes.map((n) => n.result!.report!.attempts).filter((a) => a > 0);
  const passed = reportNodes.filter((n) => (n.result!.report!.failures || []).length === 0).length;

  const defects = nodes.flatMap((n) => n.result?.defects || []);
  const fixTasks = graphs.filter((g) => g.fix_for);
  const converted = fixTasks.length;
  const closed = fixTasks.filter((g) => g.status === 'success').length;

  const checked = nodes.filter((n) => n.result?.delivery_check);
  const consistent = checked.filter((n) => n.result!.delivery_check!.consistent).length;

  const avg = (xs: number[]) => (xs.length ? Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 100) / 100 : 0);
  const rate = (n: number, d: number) => (d ? Math.round((n / d) * 1000) / 1000 : 0);

  return {
    fix_loop_nodes: fixRounds.length,
    fix_rounds_avg: avg(fixRounds),
    fix_rounds_max: fixRounds.length ? Math.max(...fixRounds) : 0,
    test_reported_nodes: reportNodes.length,
    test_pass_rate: rate(passed, reportNodes.length),
    defects_total: defects.length,
    defects_converted: converted,
    defects_closed: closed,
    defect_close_rate: rate(closed, converted),
    delivery_checked_nodes: checked.length,
    delivery_consistent_rate: rate(consistent, checked.length),
  };
}

export interface TaskRunSample {
  task_id: string;
  ts: string;
  status: string;
  nodes: number;
  completed: number;
  fix_rounds: number;
  defects: number;
  level?: string;
  project_id?: string;
  fix_for_task?: string;
}

const SAMPLE_TTL_SEC = 90 * 24 * 3600;

function todayKey(): string {
  return `metrics:samples:${new Date().toISOString().slice(0, 10)}`;
}

/** Append one per-task-run sample after execute() finishes. Best-effort. */
export async function sampleTaskRun(graph: TaskGraph, status: string): Promise<void> {
  const nodes = graph.nodes.filter((n) => n.agent !== 'orchestrator');
  const fixRounds = nodes.map((n) => n.result?.report?.attempts || 0);
  const sample: TaskRunSample = {
    task_id: graph.task_id,
    ts: new Date().toISOString(),
    status,
    nodes: nodes.length,
    completed: nodes.filter((n) => n.status === 'completed').length,
    fix_rounds: fixRounds.reduce((a, b) => a + b, 0),
    defects: nodes.reduce((a, n) => a + (n.result?.defects?.length || 0), 0),
    ...(graph.level ? { level: graph.level } : {}),
    ...(graph.project_id ? { project_id: graph.project_id } : {}),
    ...(graph.fix_for ? { fix_for_task: graph.fix_for.task_id } : {}),
  };
  const key = todayKey();
  const existing = (await busGet<TaskRunSample[]>(key)) || [];
  existing.push(sample);
  await busSet(key, existing, SAMPLE_TTL_SEC);
}

export interface TrendPoint {
  date: string;
  tasks: number;
  success_rate: number;
  fix_rounds_total: number;
  defects_total: number;
  defects_fixed: number;
}

/** Daily trend over the last N days from the sample keys. */
export async function getTrend(days = 14): Promise<TrendPoint[]> {
  const keys = (await busKeys('metrics:samples:*')).sort();
  const out: TrendPoint[] = [];
  for (const key of keys.slice(-days)) {
    const date = key.replace('metrics:samples:', '');
    const samples = (await busGet<TaskRunSample[]>(key)) || [];
    const success = samples.filter((s) => s.status === 'success').length;
    out.push({
      date,
      tasks: samples.length,
      success_rate: samples.length ? Math.round((success / samples.length) * 1000) / 1000 : 0,
      fix_rounds_total: samples.reduce((a, s) => a + (s.fix_rounds || 0), 0),
      defects_total: samples.reduce((a, s) => a + (s.defects || 0), 0),
      defects_fixed: samples.filter((s) => s.status === 'success' && s.fix_for_task).length,
    });
  }
  return out;
}
