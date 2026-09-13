/**
 * SEC-P0 命令守卫：白名单从「首词」升级为「首词 + 参数形态」两级校验。
 *
 * 背景（V1/V2 实证）：白名单只匹配命令首词时，`python -c "<任意代码>"`、
 * `pip install 恶意包`、`git push --force` 全部借解释器之名放行。本模块把
 * 命令按链式分段（&&/||/;/|），逐段识别高危形态；命中即转人工审批，不直接执行。
 *
 * 局限（诚实记录）：基于字符串解析，base64/编码/间接执行理论上仍可绕过——
 * 更强的隔离（OS 级沙箱/容器）属于后续 SEC-P1。
 */

export interface CommandClassification {
  sensitive: boolean;
  reasons: string[];
  /** 链式分段后的每段命令（首词校验用） */
  segments: string[];
}

/** 引号感知的链式分段：&& / || / ; / | */
export function splitChained(command: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quote: string | null = null;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (quote) {
      cur += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      cur += ch;
      continue;
    }
    if (command.startsWith('&&', i) || command.startsWith('||', i)) {
      out.push(cur);
      cur = '';
      i++;
      continue;
    }
    if (ch === ';' || ch === '|') {
      out.push(cur);
      cur = '';
      continue;
    }
    cur += ch;
  }
  out.push(cur);
  return out.map((s) => s.trim()).filter(Boolean);
}

const INTERPRETERS = new Set(['python', 'python3', 'py', 'node', 'perl', 'ruby', 'php', 'powershell', 'pwsh']);
const INLINE_CODE_FLAGS = new Set(['-c', '-e', '--eval', '-command', '-encodedcommand']);
const DELETE_BINS = new Set(['rm', 'del', 'rd', 'rmdir', 'erase', 'remove-item']);
const SYSTEM_BINS = new Set(['format', 'shutdown', 'reboot', 'diskpart']);

function firstWord(segment: string): { bin: string; args: string[] } {
  const parts = segment.trim().split(/\s+/).filter(Boolean);
  const raw = parts[0] || '';
  // 剥掉常见包裹：cmd /c xxx、env VAR=1 xxx
  let bin = raw.toLowerCase();
  const args = parts.slice(1);
  if ((bin === 'cmd' || bin === 'cmd.exe') && (args[0] === '/c' || args[0] === '/C')) {
    return firstWord(args.slice(1).join(' '));
  }
  return { bin: bin.replace(/\.(exe|cmd|bat)$/i, ''), args };
}

function segmentSensitive(segment: string): string | null {
  const { bin, args } = firstWord(segment);
  const flagArgs = args.map((a) => a.toLowerCase());

  if (DELETE_BINS.has(bin)) return '删除操作';
  if (SYSTEM_BINS.has(bin)) return '系统级操作';

  if (INTERPRETERS.has(bin)) {
    const inline = flagArgs.some((a) => INLINE_CODE_FLAGS.has(a.replace(/^-+/, (m) => '-' + m)) || INLINE_CODE_FLAGS.has(a));
    if (inline) return '解释器内联代码（-c/-e/-Command）';
    if ((bin === 'powershell' || bin === 'pwsh') && flagArgs.some((a) => a.startsWith('-') === false && a.endsWith('.ps1') === false && !a.startsWith('-'))) {
      // powershell 直接跟裸代码串
      return '解释器内联代码（-Command）';
    }
  }
  if ((bin === 'pip' || bin === 'pip3') && args[0]?.toLowerCase() === 'install' && !flagArgs.includes('-r') && !flagArgs.includes('--requirement')) {
    return 'pip install 会执行包内任意代码';
  }
  if (bin === 'git') {
    const sub = (args[0] || '').toLowerCase();
    if (sub === 'push') return 'git push 外推仓库';
    if (sub === 'reset' && flagArgs.includes('--hard')) return 'git reset --hard 丢弃工作区';
    if (sub === 'clean') return 'git clean 删除未跟踪文件';
  }
  return null;
}

/** 分类一条命令（含链式）：命中任一高危形态即 sensitive。 */
export function classifyCommand(command: string): CommandClassification {
  const segments = splitChained(command);
  const reasons: string[] = [];
  for (const seg of segments) {
    const r = segmentSensitive(seg);
    if (r && !reasons.includes(r)) reasons.push(r);
  }
  return { sensitive: reasons.length > 0, reasons, segments };
}

/** 链式命令的每段首词都必须过白名单（非 full 策略用）——`git log && del x` 不再借首词放行。 */
export function canExecuteChain(policy: { level: string; whitelistCommands: string[] | null }, command: string, whitelistCheck: (segment: string) => boolean): boolean {
  if (policy.level === 'full' || policy.whitelistCommands === null) return true;
  return splitChained(command).every((seg) => whitelistCheck(seg));
}
