/**
 * P2.4 会话级 scratchpad（elide 语义的"折而可找回"落地）：
 * - orchestrator 折叠/水位线改写工具结果前，把「文件路径 + 关键发现」存入任务级便签
 * - agent 用 scratchpad_search 只读工具检索早前结论，消灭"重试/续传时重读同样文件"
 * - 存 bus KV（task:scratchpad:<taskId>），任务结束清理；cap 60 条防膨胀
 */
import { busGet, busSet, busDel } from './bus';

export interface ScratchEntry {
  ts: string;
  kind: 'file' | 'finding' | 'command';
  key: string;       // 检索键：文件路径 / 命令 / 主题词
  summary: string;   // 关键发现（≤400 字）
  round?: number;
}

const MAX_ENTRIES = 60;
const MAX_SUMMARY = 400;

function key(taskId: string): string {
  return `task:scratchpad:${taskId}`;
}

export async function scratchPut(taskId: string, entry: Omit<ScratchEntry, 'ts'>): Promise<void> {
  if (!taskId || !entry.key || !entry.summary) return;
  const items = (await busGet<ScratchEntry[]>(key(taskId))) || [];
  // 同 key 覆盖（同文件多次读 → 保留最新发现）
  const filtered = items.filter((it) => it.key !== entry.key);
  filtered.push({ ...entry, summary: entry.summary.slice(0, MAX_SUMMARY), ts: new Date().toISOString() });
  await busSet(key(taskId), filtered.slice(-MAX_ENTRIES), 7 * 24 * 3600);
}

export async function scratchSearch(taskId: string, query: string, limit = 5): Promise<ScratchEntry[]> {
  const items = (await busGet<ScratchEntry[]>(key(taskId))) || [];
  if (!items.length) return [];
  const q = String(query || '').toLowerCase().trim();
  if (!q) return items.slice(-limit);
  const terms = q.split(/\s+/).filter(Boolean);
  const scored = items
    .map((it) => {
      const hay = `${it.key}\n${it.summary}`.toLowerCase();
      let score = 0;
      for (const t of terms) {
        if (hay.includes(t)) score += t.length >= 3 ? 2 : 1;
      }
      return { it, score };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score);
  return scored.slice(0, limit).map((x) => x.it);
}

export async function scratchClear(taskId: string): Promise<void> {
  await busDel(key(taskId));
}

/**
 * 从工具调用+结果提取 scratchpad 条目（确定性，无 LLM）：
 * read_file/read_file_lines → 文件首部摘要；grep → 命中概览；exec → 命令与退出码。
 */
export function scratchFromToolCall(tool: string, args: Record<string, unknown>, result: Record<string, unknown>, round?: number): Omit<ScratchEntry, 'ts'> | null {
  const ok = result?.ok !== false;
  if (!ok) return null; // 失败结果不进便签（错误不裁剪也不提炼）
  if (tool === 'read_file' || tool === 'read_file_lines') {
    const p = String(args?.path || '');
    if (!p) return null;
    const content = String(result?.content ?? result?.output ?? '');
    const firstMeaningful = content.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('import') && !l.startsWith('//')).slice(0, 3).join(' | ');
    return { kind: 'file', key: p, summary: firstMeaningful ? `文件开头要点：${firstMeaningful}` : `已读取（${content.length} 字符）`, round };
  }
  if (tool === 'grep') {
    const p = String(args?.path || '');
    const pattern = String(args?.pattern || '');
    const hits = String(result?.output ?? result?.content ?? '').split('\n').filter(Boolean).slice(0, 3).join(' | ');
    return { kind: 'finding', key: `grep:${pattern}${p ? ` in ${p}` : ''}`, summary: hits ? `命中：${hits}` : '无命中', round };
  }
  if (tool === 'exec' || tool === 'exec_command') {
    const cmd = String(args?.command || '').slice(0, 120);
    if (!cmd) return null;
    const out = String(result?.stdout ?? '').split('\n').filter(Boolean).slice(0, 2).join(' | ');
    return { kind: 'command', key: cmd, summary: `exit ${result?.returncode ?? '?'}${out ? ` · ${out}` : ''}`, round };
  }
  return null;
}
