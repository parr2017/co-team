/**
 * 统一时间格式化（mobile 端唯一来源，与 web/src/utils/time.ts 同构）：
 * - fmtDateTime: M/D HH:mm（列表/卡片通用）
 * - relativeTime: 刚刚 / N 分钟前 / N 小时前 / N 天前 / 超过一周落日期
 * 服务端 ts 形如 "YYYY-MM-DD HH:mm:ss"（Safari 不认空格分隔），统一先归一为 ISO。
 */
export type TimeInput = string | number | Date;

function toDate(ts?: TimeInput): Date | null {
  if (!ts) return null;
  const d = ts instanceof Date ? ts : new Date(typeof ts === 'string' && ts.includes(' ') && !ts.includes('T') ? ts.replace(' ', 'T') : ts);
  return isNaN(d.getTime()) ? null : d;
}

export function fmtDateTime(ts?: TimeInput): string {
  const d = toDate(ts);
  if (!d) return ts ? String(ts) : '';
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

export function relativeTime(ts?: TimeInput): string {
  const d = toDate(ts);
  if (!d) return ts ? String(ts) : '';
  const diff = Date.now() - d.getTime();
  if (diff < 60_000) return '刚刚';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
  if (diff < 7 * 86_400_000) return `${Math.floor(diff / 86_400_000)} 天前`;
  return fmtDateTime(d);
}

/** 审批门滞留豁免（2026-10-01）：waiting_approval/clarify 停靠超过 3 天视为陈年僵尸，
 *  不再计入角标、不再进审批收件箱——任务本身不受影响，仍可在任务列表里手动处理。 */
export const GATE_STALE_MS = 3 * 24 * 3_600_000;

export function isGateStale(updatedAt?: string | number | null): boolean {
  if (!updatedAt) return false;
  const ts = typeof updatedAt === 'number' ? updatedAt : Date.parse(updatedAt);
  if (!Number.isFinite(ts) || ts <= 0) return false;
  return Date.now() - ts > GATE_STALE_MS;
}
