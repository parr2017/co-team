/**
 * SEC-P0 命令守卫：白名单从「首词」升级为「首词 + 参数形态」两级校验。
 *
 * 背景（V1/V2 实证）：白名单只匹配命令首词时，`python -c "<任意代码>"`、
 * `pip install 恶意包`、`git push --force` 全部借解释器之名放行。本模块把
 * 命令按链式分段（&&/||/;/|），逐段识别高危形态；命中即转人工审批，不直接执行。
 *
 * 分级（2026-09-17）：
 * - sensitive（可配置）：`rm`、`python -c`、`git push` 等——群聊设 allow_sensitive: true 可放行
 * - strict（绝对禁止）：`sudo`、`schtasks`、`vssadmin delete shadows` 等——任何配置下都拦截
 *
 * 局限（诚实记录）：基于字符串解析，base64/编码/间接执行理论上仍可绕过——
 * 更强的隔离（OS 级沙箱/容器）属于后续 SEC-P1。
 */

export interface CommandClassification {
  sensitive: boolean;
  /** 绝对禁止：任何配置下都拦截（allow_sensitive 无法绕过） */
  strict: boolean;
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

// ========== 可配置敏感命令（allow_sensitive: true 时可放行） ==========

const INTERPRETERS = new Set(['python', 'python3', 'py', 'node', 'perl', 'ruby', 'php', 'powershell', 'pwsh']);
const INLINE_CODE_FLAGS = new Set(['-c', '-e', '--eval', '-command', '-encodedcommand']);
const DELETE_BINS = new Set(['rm', 'del', 'rd', 'rmdir', 'erase', 'remove-item']);
const SYSTEM_BINS = new Set(['format', 'shutdown', 'reboot', 'diskpart']);

// ========== 绝对禁止命令（任何配置下都拦截） ==========

/** 权限提升 */
const PRIVILEGE_BINS = new Set(['sudo', 'runas', 'gsudo']);
/** Windows 服务操控（子命令级检查） */
const SC_DANGEROUS_SUBS = new Set(['stop', 'start', 'delete', 'config', 'failure']);
/** 定时任务（持久化植入） */
const SCHEDTASKS_DANGEROUS_SUBS = new Set(['create', 'delete', 'change']);
/** 注册表删除/写入 */
const REG_DANGEROUS_SUBS = new Set(['delete', 'add']);
/** 防火墙操控 */
const NETSH_DANGEROUS_SUBS = new Set(['advfirewall', 'firewall']);
/** 引导配置（禁用恢复/安全模式） */
const BCDEDIT_DANGEROUS_SUBS = new Set(['set', 'deletevalue', 'copy']);
/** 文件权限操控 */
const ICACLS_DANGEROUS_SUBS = new Set(['/grant', '/deny', '/setowner', '/reset']);
/** 磁盘数据擦除/卷影删除/备份删除 */
const WIPES_BINS = new Set(['cipher', 'fsutil', 'wbadmin', 'compact']);
/** 用户/组管理 */
const NET_USER_MGMT_SUBS = new Set(['user', 'localgroup', 'accounts']);
/** 下载执行模式（管道到 shell） */
const DOWNLOAD_EXEC_PATTERNS = [
  /\b(curl|wget)\b.*\|.*\b(sh|bash|zsh|pwsh|powershell)\b/,
  /\bInvoke-WebRequest\b.*\|\s*iex/,
  /\biwr\b.*\|\s*iex/,
  /\bInvoke-Expression\b/,
  /\biex\b/,
];
/** robocopy 镜像/清理模式（可删除目标文件） */
const ROBOCOPY_DANGEROUS_FLAGS = ['/purge', '/mir', '/move'];

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

interface SegmentResult {
  reason: string | null;
  strict: boolean;
}

function segmentSensitive(segment: string): SegmentResult {
  const { bin, args } = firstWord(segment);
  const flagArgs = args.map((a) => a.toLowerCase());

  // ===== 绝对禁止（strict） =====
  if (PRIVILEGE_BINS.has(bin)) return { reason: '权限提升', strict: true };
  if (SYSTEM_BINS.has(bin)) return { reason: '系统级操作', strict: true };

  // net user/localgroup/accounts、net stop/start
  if (bin === 'net') {
    const sub = (args[0] || '').toLowerCase();
    if (NET_USER_MGMT_SUBS.has(sub)) return { reason: '用户/组管理', strict: true };
    if (sub === 'stop' || sub === 'start') return { reason: '服务操控', strict: true };
  }

  // sc stop/start/delete/config
  if (bin === 'sc') {
    const sub = (args[0] || '').toLowerCase();
    if (SC_DANGEROUS_SUBS.has(sub)) return { reason: '服务操控', strict: true };
  }

  // schtasks create/delete/change（Windows 真实语法是斜杠旗标 /create，两种形态都要拦）
  if (bin === 'schtasks') {
    const sub = (args[0] || '').toLowerCase().replace(/^\//, '');
    if (SCHEDTASKS_DANGEROUS_SUBS.has(sub)) return { reason: '定时任务操控', strict: true };
  }

  // reg delete/add
  if (bin === 'reg') {
    const sub = (args[0] || '').toLowerCase();
    if (REG_DANGEROUS_SUBS.has(sub)) return { reason: '注册表操控', strict: true };
  }

  // netsh advfirewall/firewall
  if (bin === 'netsh') {
    const sub = (args[0] || '').toLowerCase();
    if (NETSH_DANGEROUS_SUBS.has(sub)) return { reason: '防火墙操控', strict: true };
  }

  // bcdedit set/deletevalue/copy
  if (bin === 'bcdedit') {
    const sub = (args[0] || '').toLowerCase();
    if (BCDEDIT_DANGEROUS_SUBS.has(sub)) return { reason: '引导配置操控', strict: true };
  }

  // icacls /grant /deny /setowner /reset
  if (bin === 'icacls') {
    if (flagArgs.some((a) => ICACLS_DANGEROUS_SUBS.has(a))) return { reason: '文件权限操控', strict: true };
  }

  // takeown /f
  if (bin === 'takeown') {
    if (flagArgs.includes('/f') || flagArgs.includes('/f /r')) return { reason: '文件所有权操控', strict: true };
  }

  // cipher /w、fsutil deletejournal、wbadmin delete、compact /c
  if (bin === 'cipher' && flagArgs.includes('/w')) return { reason: '磁盘数据擦除', strict: true };
  if (bin === 'fsutil') {
    const sub = (args[0] || '').toLowerCase();
    if (sub === 'deletejournal' || sub === 'usn') return { reason: '文件系统日志删除', strict: true };
  }
  if (bin === 'wbadmin') {
    const sub = (args[0] || '').toLowerCase();
    if (sub === 'delete') return { reason: '备份删除', strict: true };
  }
  if (bin === 'compact' && flagArgs.includes('/c') && (flagArgs.includes('/s') || flagArgs.includes('/a'))) return { reason: '目录压缩（可能锁定文件）', strict: true };

  // vssadmin delete shadows
  if (bin === 'vssadmin') {
    const sub = (args[0] || '').toLowerCase();
    if (sub === 'delete') return { reason: '卷影副本删除', strict: true };
  }

  // robocopy /purge /mir /move
  if (bin === 'robocopy') {
    if (flagArgs.some((a) => ROBOCOPY_DANGEROUS_FLAGS.includes(a))) return { reason: 'robocopy 镜像/清理（可删除目标文件）', strict: true };
  }

  // 下载执行管道
  for (const pat of DOWNLOAD_EXEC_PATTERNS) {
    if (pat.test(segment)) return { reason: '下载执行（远程代码注入）', strict: true };
  }

  // ===== 可配置敏感（sensitive, 非 strict） =====
  if (DELETE_BINS.has(bin)) return { reason: '删除操作', strict: false };

  if (INTERPRETERS.has(bin)) {
    const inline = flagArgs.some((a) => INLINE_CODE_FLAGS.has(a.replace(/^-+/, (m) => '-' + m)) || INLINE_CODE_FLAGS.has(a));
    if (inline) return { reason: '解释器内联代码（-c/-e/-Command）', strict: false };
    if ((bin === 'powershell' || bin === 'pwsh') && flagArgs.some((a) => a.startsWith('-') === false && a.endsWith('.ps1') === false && !a.startsWith('-'))) {
      return { reason: '解释器内联代码（-Command）', strict: false };
    }
  }
  if ((bin === 'pip' || bin === 'pip3') && args[0]?.toLowerCase() === 'install' && !flagArgs.includes('-r') && !flagArgs.includes('--requirement')) {
    return { reason: 'pip install 会执行包内任意代码', strict: false };
  }
  if (bin === 'git') {
    const sub = (args[0] || '').toLowerCase();
    if (sub === 'push') return { reason: 'git push 外推仓库', strict: false };
    if (sub === 'reset' && flagArgs.includes('--hard')) return { reason: 'git reset --hard 丢弃工作区', strict: false };
    if (sub === 'clean') return { reason: 'git clean 删除未跟踪文件', strict: false };
  }

  return { reason: null, strict: false };
}

/** 分类一条命令（含链式）：命中任一高危形态即 sensitive；命中绝对禁止形态即 strict。 */
export function classifyCommand(command: string): CommandClassification {
  const segments = splitChained(command);
  const reasons: string[] = [];
  let strict = false;
  for (const seg of segments) {
    const { reason, strict: segStrict } = segmentSensitive(seg);
    if (reason && !reasons.includes(reason)) reasons.push(reason);
    if (segStrict) strict = true;
  }
  return { sensitive: reasons.length > 0, strict, reasons, segments };
}

/** 链式命令的每段首词都必须过白名单（非 full 策略用）——`git log && del x` 不再借首词放行。 */
export function canExecuteChain(policy: { level: string; whitelistCommands: string[] | null }, command: string, whitelistCheck: (segment: string) => boolean): boolean {
  if (policy.level === 'full' || policy.whitelistCommands === null) return true;
  return splitChained(command).every((seg) => whitelistCheck(seg));
}
