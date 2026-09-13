/**
 * 统一时间格式化（全站唯一来源）：
 * - fmtDateTime: MM-DD HH:mm（列表/卡片通用）
 * - relativeTime: 刚刚 / N 分钟前 / N 小时前 / N 天前 / 超过一周落日期
 * 服务端 ts 形如 "YYYY-MM-DD HH:mm:ss"（Safari 不认空格分隔），统一先归一为 ISO。
 */
function toDate(ts?: string | number): Date | null {
  if (!ts) return null;
  const d = ts instanceof Date ? ts : new Date(typeof ts === 'string' && ts.includes(' ') && !ts.includes('T') ? ts.replace(' ', 'T') : ts);
  return isNaN(d.getTime()) ? null : d;
}

export function fmtDateTime(ts?: string | number): string {
  const d = toDate(ts);
  if (!d) return ts ? String(ts) : '';
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

export function relativeTime(ts?: string | number): string {
  const d = toDate(ts);
  if (!d) return ts ? String(ts) : '';
  const diff = Date.now() - d.getTime();
  if (diff < 60_000) return '刚刚';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
  if (diff < 7 * 86_400_000) return `${Math.floor(diff / 86_400_000)} 天前`;
  return fmtDateTime(d);
}
