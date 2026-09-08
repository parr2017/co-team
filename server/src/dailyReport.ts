import { busGet, busSet, busKeys } from './bus';
import { emitProgress, listTaskGraphs, getTaskJournals } from './store';
import { notify } from './notify';
import { getLogger } from './logger';

// ---------- feature: 每日问题沉淀报告 ----------
// 运行中的报错与功能性问题按天沉淀，固定时间汇总报告给用户，
// 由用户决定是否修复（转为任务 / 忽略）。界面开关打开后才会触发。

export interface DailyReportItem {
  id: string;
  /** normalized error signature for grouping */
  signature: string;
  category: 'model_env' | 'code_defect' | 'command_risk' | 'requirement' | 'other';
  count: number;
  /** the most recent raw error text */
  sample: string;
  first_seen: string;
  last_seen: string;
  sources: { task_id?: string; node_id?: string; node_name?: string; agent?: string }[];
}

export interface DailyReport {
  date: string;
  generated_at: string;
  items: DailyReportItem[];
  /** item_id → user decision */
  resolved: Record<string, { action: 'fix_now' | 'create_task' | 'skip'; ts: string; task_id?: string }>;
}

export interface PendingCommandRecord {
  id: string;
  node_id: string;
  node_name: string;
  command: string;
  ts: string;
}

const REPORT_KEY = (date: string) => `reports:daily:${date}`;
const LAST_REPORT_KEY = 'reports:daily:last_generated_date';

/** Local YYYY-MM-DD for "today" (the report hour is interpreted in server-local time). */
export function todayStr(now = new Date()): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/** Normalize an error string into a grouping signature: strip numbers/paths/hex so variants collapse. */
export function errorSignature(err: string): string {
  const cleaned = (err || '')
    .slice(0, 300)
    .replace(/0x[0-9a-f]+/gi, '0xX')
    .replace(/\d+/g, 'N')
    .replace(/[A-Za-z]:\\[^\s"']+/g, '<path>')
    .replace(/\/[\w./-]{3,}/g, '<path>')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
  return cleaned.slice(0, 120) || '(empty)';
}

export function classifyError(sample: string): DailyReportItem['category'] {
  const s = sample.toLowerCase();
  // stream_stalled/wallclock_cap/connection_died/non_stream_timeout：2026-09-09 超时新语义文案
  // （旧文案含"timeout"可被兜住，新文案必须显式收编，否则模型环境类问题会漏归为 other）
  if (/no available model|all models failed|cooldown|模型池|model .*fail|econn|etimedout|502|503|504|timeout|rate.?limit|stream_stalled|wallclock_cap|connection_died|non_stream_timeout/.test(s)) return 'model_env';
  if (/command not in whitelist|等待人工审批|command failed|拒绝/.test(s)) return 'command_risk';
  if (/需求|澄清|clarif|验收/.test(s)) return 'requirement';
  if (/parse|schema|not valid json|failed to produce|assert|expect|error|exception|fail/.test(s)) return 'code_defect';
  return 'other';
}

export class DailyReportBuilder {
  private items = new Map<string, DailyReportItem>();

  add(err: string, source: DailyReportItem['sources'][number], ts: string): void {
    const sample = (err || '').trim();
    if (!sample) return;
    const signature = errorSignature(sample);
    const existing = this.items.get(signature);
    if (existing) {
      existing.count += 1;
      existing.last_seen = ts > existing.last_seen ? ts : existing.last_seen;
      existing.first_seen = ts < existing.first_seen ? ts : existing.first_seen;
      if (sample.length > existing.sample.length) existing.sample = sample;
      if (existing.sources.length < 10) existing.sources.push(source);
      return;
    }
    this.items.set(signature, {
      id: Math.random().toString(36).slice(2, 10),
      signature,
      category: classifyError(sample),
      count: 1,
      sample,
      first_seen: ts,
      last_seen: ts,
      sources: [source],
    });
  }

  build(date: string): DailyReport {
    const items = [...this.items.values()].sort((a, b) => b.count - a.count || b.last_seen.localeCompare(a.last_seen));
    return { date, generated_at: new Date().toISOString(), items, resolved: {} };
  }
}

/** Collect errors from every task: failed nodes, error journals, pending-command history. */
export async function collectErrorsSince(sinceMs: number): Promise<DailyReportBuilder> {
  const builder = new DailyReportBuilder();
  const graphs = await listTaskGraphs();
  for (const g of graphs) {
    const updatedAt = new Date(g.updated_at || g.created_at || 0).getTime();
    const createdMs = new Date(g.created_at || 0).getTime();
    // graph-level scan only touches tasks touched in the window
    if (updatedAt < sinceMs && createdMs < sinceMs) continue;
    for (const n of g.nodes) {
      const ts = n.updated_at || n.created_at || g.updated_at;
      if (new Date(ts || 0).getTime() < sinceMs) continue;
      if ((n.status === 'failed' || n.needs_human) && n.error) {
        builder.add(n.error, { task_id: g.task_id, node_id: n.id, node_name: n.name, agent: n.agent }, ts);
      }
      for (const e of n.result?.errors || []) builder.add(e, { task_id: g.task_id, node_id: n.id, node_name: n.name, agent: n.agent }, ts);
    }
    try {
      const journals = await getTaskJournals(g.task_id);
      for (const [agent, entries] of Object.entries(journals)) {
        for (const j of entries) {
          if (j.kind !== 'error' || !j.text) continue;
          if (new Date(j.ts || 0).getTime() < sinceMs) continue;
          builder.add(j.text, { task_id: g.task_id, node_id: j.node_id, node_name: j.node_name, agent }, j.ts);
        }
      }
    } catch {
      /* journal scan is best-effort */
    }
  }
  return builder;
}

/** Build (or rebuild) today's report from data since the previous report. */
export async function generateDailyReport(now = new Date()): Promise<DailyReport> {
  const date = todayStr(now);
  const lastDate = (await busGet<string>(LAST_REPORT_KEY)) || '';
  const last = lastDate ? new Date(`${lastDate}T00:00:00`).getTime() : Date.now() - 24 * 3600_000;
  const builder = await collectErrorsSince(last);
  const report = builder.build(date);
  await busSet(REPORT_KEY(date), report);
  await busSet(LAST_REPORT_KEY, date);
  const logger = getLogger();
  logger.info('Daily report generated', { date, items: report.items.length, total: report.items.reduce((s, i) => s + i.count, 0) });
  await emitProgress('daily_report_ready', { date, count: report.items.length });
  notify(
    'daily_report_ready',
    { date, count: report.items.length },
    `[Co-Team] 每日问题报告（${date}）已生成：${report.items.length} 类问题，请在工作台查看并决定是否修复`
  );
  return report;
}

export async function getDailyReport(date: string): Promise<DailyReport | null> {
  return (await busGet<DailyReport>(REPORT_KEY(date))) || null;
}

export async function listDailyReports(limit = 30): Promise<DailyReport[]> {
  const keys = await busKeys('reports:daily:*');
  const dates = keys
    .map((k) => k.replace('reports:daily:', ''))
    .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d))
    .sort((a, b) => b.localeCompare(a))
    .slice(0, limit);
  const reports: DailyReport[] = [];
  for (const d of dates) {
    const r = await getDailyReport(d);
    if (r) reports.push(r);
  }
  return reports;
}

/** Record the user's decision on a report item (skip / fix now / convert to a repair task). */
export async function resolveReportItem(date: string, itemId: string, action: 'fix_now' | 'create_task' | 'skip', taskId?: string): Promise<DailyReport | null> {
  const report = await getDailyReport(date);
  if (!report) throw new Error(`report not found: ${date}`);
  const item = report.items.find((i) => i.id === itemId);
  if (!item) throw new Error('report item not found');
  report.resolved[itemId] = { action, ts: new Date().toISOString(), ...(taskId ? { task_id: taskId } : {}) };
  await busSet(REPORT_KEY(date), report);
  return report;
}

export interface DailyReportScanner {
  reload(enabled: boolean, hour: number): void;
  stop(): void;
}

/** Minute-tick scanner; at the configured hour (once per day) it generates the report.
 *  When `enabled` is false it does nothing — the UI switch is the single trigger. */
export function startDailyReportScanner(opts: { enabled: boolean; hour: number }): DailyReportScanner {
  let enabled = opts.enabled;
  let hour = opts.hour;
  let running = false;

  const tick = async () => {
    if (!enabled || running) return;
    const now = new Date();
    if (now.getHours() !== hour) return;
    if ((await busGet<string>(LAST_REPORT_KEY)) === todayStr(now)) return;
    running = true;
    try {
      await generateDailyReport(now);
    } catch (e) {
      getLogger().warn('Daily report generation failed', { error: String(e).slice(0, 300) });
    } finally {
      running = false;
    }
  };

  const timer = setInterval(() => void tick(), 60_000);
  timer.unref?.();
  return {
    reload(nextEnabled: boolean, nextHour: number): void {
      enabled = nextEnabled;
      hour = nextHour;
    },
    stop(): void {
      clearInterval(timer);
    },
  };
}
