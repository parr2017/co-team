/**
 * P2.2 工具结果四级水位线（星瑶 tool_result_maintenance.py 改造移植，请求本地版）：
 *
 *   0.50w  snip  —— 旧工具结果 JSON 掐头去尾（本地免费，按条冻结防反复改写）
 *   0.62w  elide —— 仍超长的结果整体占位符化（"重新调用工具可取回完整内容"）
 *   0.72w  fold  —— 既有断崖折叠（foldMessagesInto，确定性纯函数）
 *   0.90w  —— 物理上限：交给 CONTEXT_OVERFLOW_RE 分型（换窗/换模）
 *
 * 不变量（与星瑶同源）：
 * - 每条结果最多被改写一次：snip 过的条目带 marker 冻结，elide 只对未冻结条目生效
 * - 尾部保护区：最近 N 条工具结果消息永不改写（模型正在用的证据）
 * - 确定性：同输入同字节——同参数重复调用产生一致结果，前缀缓存可复用
 * - elide 语义 = 信息未销毁：重新调用工具即可找回（配合 knowledge_search/scratchpad 工具）
 */

/** 工具结果消息的统一前缀（orchestrator 工具轮回注格式） */
const RESULT_PREFIX = '工具执行结果：';
const SNIP_MARKER = '…[中段已省略';
/** 已 snip 条目的判定特征（冻结依据） */
const SNIP_FINGERPRINT = 'SNIPPED';

export interface SnipOptions {
  /** 单字符串值超过该长度才截断 */
  snipChars?: number;
  /** 尾部保护区：最近 N 条工具结果消息不动 */
  protectTail?: number;
}

/** 提取工具结果 JSON（解析失败返回 null——非 JSON 内容不做外科手术）。 */
function parseResultJson(content: string): unknown[] | null {
  const idx = content.indexOf(RESULT_PREFIX);
  if (idx < 0) return null;
  const json = content.slice(idx + RESULT_PREFIX.length).trim();
  if (!json.startsWith('[')) return null;
  try {
    const arr = JSON.parse(json);
    return Array.isArray(arr) ? arr : null;
  } catch {
    return null;
  }
}

function snipString(s: string, snipChars: number): string {
  if (s.length <= snipChars || s.includes(SNIP_FINGERPRINT)) return s;
  const head = Math.floor(snipChars * 0.6);
  const tail = snipChars - head;
  return `${s.slice(0, head)}\n${SNIP_MARKER} ${s.length - snipChars} 字 SNIPPED——如需完整内容请重新调用该工具（同参数可精确取回）]\n${s.slice(-tail)}`;
}

/** 深度遍历改写长字符串值（对象结构保留；已 snip 的值冻结不动）。 */
function snipValue(v: unknown, snipChars: number): unknown {
  if (typeof v === 'string') return snipString(v, snipChars);
  if (Array.isArray(v)) return v.map((x) => snipValue(x, snipChars));
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      out[k] = k === 'error' ? val : snipValue(val, snipChars); // 错误文本永不裁剪（星瑶不变量）
    }
    return out;
  }
  return v;
}

/**
 * L1 snip：旧工具结果超长字符串值掐头去尾。返回被改写的消息条数（幂等——
 * 已 snip 的内容再次调用不再变化，保证跨轮字节稳定）。
 */
export function snipOldToolResults(messages: { role: string; content: string }[], opts: SnipOptions = {}): number {
  const snipChars = opts.snipChars ?? 1500;
  const protectTail = opts.protectTail ?? 2;
  let mutated = 0;
  let seenResults = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== 'user' || !m.content.startsWith(RESULT_PREFIX)) continue;
    seenResults += 1;
    if (seenResults <= protectTail) continue; // 尾部保护区
    const parsed = parseResultJson(m.content);
    if (!parsed) continue;
    const prefixEnd = m.content.indexOf(RESULT_PREFIX) + RESULT_PREFIX.length;
    const jsonText = m.content.slice(prefixEnd).trim();
    const snipped = snipValue(parsed, snipChars) as unknown[];
    const next = JSON.stringify(snipped);
    if (next === jsonText) continue; // 幂等：无变化不写
    messages[i] = { role: 'user', content: `${RESULT_PREFIX}\n${next}` };
    mutated += 1;
  }
  return mutated;
}

/**
 * L2 elide：snip 后仍然巨大的结果条目整体占位符化（保留 tool/path 等定位字段）。
 * 返回被 elide 的条目数。
 */
export function elideLongToolResults(messages: { role: string; content: string }[], opts: { elideChars?: number; protectTail?: number } = {}): number {
  const elideChars = opts.elideChars ?? 3000;
  const protectTail = opts.protectTail ?? 2;
  let elidedItems = 0;
  let seenResults = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== 'user' || !m.content.startsWith(RESULT_PREFIX)) continue;
    seenResults += 1;
    if (seenResults <= protectTail) continue;
    const parsed = parseResultJson(m.content);
    if (!parsed) continue;
    const prefixEnd = m.content.indexOf(RESULT_PREFIX) + RESULT_PREFIX.length;
    const jsonText = m.content.slice(prefixEnd).trim();
    const nextArr = parsed.map((item) => {
      if (item && typeof item === 'object' && (item as Record<string, unknown>)._elided) return item;
      const text = JSON.stringify(item);
      if (text.length <= elideChars) return item;
      const rec = item as Record<string, unknown>;
      elidedItems += 1;
      return {
        _elided: true,
        tool: rec.tool ?? 'unknown',
        ...(rec.path ? { path: rec.path } : {}),
        original_chars: text.length,
        note: '结果已省略（上下文水位线）——重新调用同一工具（同参数）即可取回完整内容；早期发现已存任务 scratchpad，可用 scratchpad_search 检索关键结论',
      };
    });
    const next = JSON.stringify(nextArr);
    if (next === jsonText) continue;
    messages[i] = { role: 'user', content: `${RESULT_PREFIX}\n${next}` };
  }
  return elidedItems;
}
