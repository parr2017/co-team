/**
 * unified patch 解析：按文件分块 + 双侧行号（与 web DiffDialog 同构）。
 * 移动端用于 diff 弹层的分文件渲染、文件过滤与复制。
 */

export interface DiffLine { kind: 'meta' | 'hunk' | 'add' | 'del' | 'ctx'; oldNo: number; newNo: number; text: string }
export interface DiffFile { path: string; insertions: number; deletions: number; lines: DiffLine[]; patch: string }

export function parsePatch(patch: string): DiffFile[] {
  if (!patch) return [];
  const out: DiffFile[] = [];
  let cur: DiffFile | null = null;
  let oldNo = 0;
  let newNo = 0;
  for (const raw of patch.split('\n')) {
    const line = raw.replace(/\r$/, '');
    if (line.startsWith('diff --git ')) {
      cur = { path: '(unknown)', insertions: 0, deletions: 0, lines: [], patch: line + '\n' };
      out.push(cur);
      continue;
    }
    if (line.startsWith('--- ')) {
      if (cur) cur.patch += line + '\n';
      continue;
    }
    if (line.startsWith('+++ ')) {
      let p = line.slice(4).replace(/\t.*$/, '').trim();
      if (p === '/dev/null') {
        const prev = (patch.split('\n').find((l) => l.startsWith('--- ')) || '');
        p = prev.slice(4).trim();
      }
      p = p.replace(/^(a|b)\//, '');
      if (cur) { cur.path = p || cur.path; cur.patch += line + '\n'; }
      continue;
    }
    if (line.startsWith('@@')) {
      const m = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      if (m) { oldNo = parseInt(m[1], 10); newNo = parseInt(m[2], 10); }
      cur?.lines.push({ kind: 'hunk', oldNo: 0, newNo: 0, text: line });
      if (cur) cur.patch += line + '\n';
      continue;
    }
    if (!cur) continue;
    cur.patch += line + '\n';
    if (line.startsWith('+')) {
      cur.lines.push({ kind: 'add', oldNo: 0, newNo: newNo++, text: line.slice(1) });
      cur.insertions += 1;
    } else if (line.startsWith('-')) {
      cur.lines.push({ kind: 'del', oldNo: oldNo++, newNo: 0, text: line.slice(1) });
      cur.deletions += 1;
    } else if (line.startsWith('index ') || line.startsWith('\\')) {
      cur.lines.push({ kind: 'meta', oldNo: 0, newNo: 0, text: line });
    } else {
      cur.lines.push({ kind: 'ctx', oldNo: oldNo++, newNo: newNo++, text: line.replace(/^ /, '') });
    }
  }
  if (!out.length && patch.trim()) {
    return [{ path: '(patch)', insertions: 0, deletions: 0, lines: patch.split('\n').map((t) => ({ kind: 'meta' as const, oldNo: 0, newNo: 0, text: t })), patch }];
  }
  return out;
}
