/**
 * 确定性 Turn 进展观察（PH.3，移植星瑶 core/harness/progress_guard.py）：
 * 只比较确定性状态哈希与修改类提交标记，绝不读模型自然语言——
 * "复读机式空转"（每轮都有输出但什么都没干）连续多轮后在下一次 LLM 调用前熔断。
 *
 * 与 ycode 的两点适配差异：
 * - co-team 有 dedup 指针化：重复调用返回"结果从略"指针而非重新执行——所以进展哈希
 *   不能只哈希本轮 fresh 结果（"从有结果变成全指针"会被误判为哈希变化），改为维护
 *   "按调用签名的累计证据表"（evidence map），fresh 结果按 key 落账、重复调用保留旧值，
 *   哈希只反映真实的新信息增量。
 * - co-team 节点 maxRounds 上限 12/8/4（远小于 ycode 的 200）：熔断阈值取 6——
 *   连续一半预算零进展即停，省下的都是真金白银的 API 调用。
 */
import { createHash } from 'node:crypto';

export interface ProgressObservation {
  /** 本轮是否有写盘类提交（write_file/edit_file 成功） */
  mutationCommitted: boolean;
  /** 累计证据表（按调用签名去重后的全部工具结果）的哈希 */
  evidenceSha256: string;
  /** 本轮成功只读工具的读取签名（tool + 规范化参数） */
  readSignatures: string[];
}

/** 算"有界读取进展"的只读工具集（与 dedup 指针化的豁免面一致补齐视觉/文档工具）。 */
export const READ_ONLY_PROGRESS_TOOLS = new Set(['read_file', 'grep', 'list_files', 'read_dir', 'git_log', 'check_page', 'load_skill']);

export function emptyObservation(): ProgressObservation {
  return { mutationCommitted: false, evidenceSha256: '', readSignatures: [] };
}

export function readSignature(tool: string, args: Record<string, unknown> | undefined): string {
  const a = (args || {}) as Record<string, unknown>;
  const canon = JSON.stringify({
    p: a.path || '', pattern: a.pattern || '', ls: a.line_start ?? '', le: a.line_end ?? '', url: a.url || '', n: a.name || '',
  });
  return `${tool}:${createHash('sha256').update(canon).digest('hex').slice(0, 16)}`;
}

/** 累计证据表：dedupKey → 最近一次真实执行结果（重复调用不覆盖，保留旧值）。 */
export class EvidenceLedger {
  private entries = new Map<string, unknown>();

  record(key: string, result: unknown): void {
    this.entries.set(key, result);
  }

  hash(): string {
    const keys = [...this.entries.keys()].sort();
    const payload = keys.map((k) => [k, this.entries.get(k)]);
    return createHash('sha256').update(JSON.stringify(payload)).digest('hex');
  }

  get size(): number {
    return this.entries.size;
  }
}

export class TurnProgressGuard {
  /** 连续无进展轮数熔断阈值（co-team maxRounds 12/8/4，取 6 = complex 一半预算） */
  static readonly MAX_STALLED_STEPS = 6;
  /** 每尝试允许计为进展的新读取目标上限：防"无限换路径刷进度"绕过熔断（真实进展会重置预算） */
  static readonly MAX_UNIQUE_READS = 48;

  private baseline: ProgressObservation | null = null;
  private stalledSteps = 0;
  private seenReads = new Set<string>();

  observe(obs: ProgressObservation): boolean {
    const hashChanged = this.baseline !== null && obs.evidenceSha256 !== this.baseline.evidenceSha256;
    let progressed = obs.mutationCommitted || hashChanged;
    if (progressed) this.seenReads.clear();
    for (const sig of obs.readSignatures) {
      if (this.seenReads.size >= TurnProgressGuard.MAX_UNIQUE_READS) break;
      if (!this.seenReads.has(sig)) {
        this.seenReads.add(sig);
        progressed = true;
      }
    }
    if (progressed) this.stalledSteps = 0;
    else this.stalledSteps += 1;
    this.baseline = obs;
    return progressed;
  }

  get stalled(): number {
    return this.stalledSteps;
  }

  shouldAbort(): boolean {
    return this.stalledSteps >= TurnProgressGuard.MAX_STALLED_STEPS;
  }
}
