import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync, spawn } from 'node:child_process';
import { simpleGit } from 'simple-git';
import { assertWithinJail, jailViolationMessage } from './workspace';

/** Command execution levels (feature: 命令执行分级), from most to least restrictive.
 *  `unrestricted`（无边界）解除命令与读取的目录监狱；写/删文件工具在任何级别下都锁项目内。
 *  2026-09-23 起对全局配置、任务 execution_policy、协作会话三处同时开放——
 *  此前仅协作会话可用，任务侧会静默回退 base.level（用户"开了无边界却没生效"的根因）。 */
export type PermissionLevel = 'plan_only' | 'readonly' | 'approve_required' | 'whitelist_auto' | 'full' | 'unrestricted';

export const PERMISSION_LEVELS: PermissionLevel[] = ['plan_only', 'readonly', 'approve_required', 'whitelist_auto', 'full', 'unrestricted'];

/** 全局配置（config.yaml permissions.level / 任务 execution_policy / 协作会话）允许的级别。 */
export const GLOBAL_PERMISSION_LEVELS: PermissionLevel[] = ['plan_only', 'readonly', 'approve_required', 'whitelist_auto', 'full', 'unrestricted'];

export function isPermissionLevel(v: unknown): v is PermissionLevel {
  return typeof v === 'string' && (PERMISSION_LEVELS as string[]).includes(v);
}

export interface PermissionPolicy {
  level: PermissionLevel;
  whitelistCommands: string[] | null;
  maxTimeSec: number;
  /** 群聊放行敏感命令（rm/python -c/git push 等）；绝对禁止命令（sudo/schtasks 等）不受此开关影响 */
  allow_sensitive?: boolean;
  /** 无边界（unrestricted）：解除命令与读取的目录监狱；写/删文件工具**不**受此影响（仍锁项目内） */
  jailBypass?: boolean;
}

/** 已告警过的非法 level（每进程每值一次——o3xmkraj 实测 `level: normal` 静默回退
 *  whitelist_auto，用户想要的审批语义从未生效却无人知晓） */
const warnedInvalidLevels = new Set<string>();

export function policyFromConfig(permissions?: { level?: string; whitelist_commands?: string[]; max_time_sec?: number; allow_sensitive?: boolean } | null): PermissionPolicy {
  const whitelistCommands = permissions?.whitelist_commands ?? null;
  const raw = (permissions?.level || '').trim();
  if (raw && !isPermissionLevel(raw) && !warnedInvalidLevels.has(raw)) {
    warnedInvalidLevels.add(raw);
    console.warn(`[config] permissions.level "${raw}" 不是合法值（可选：${PERMISSION_LEVELS.join(' | ')}）——已按 ${whitelistCommands ? 'whitelist_auto' : 'approve_required'} 回退，请修正 config.yaml`);
  }
  // back-compat: an old config with a whitelist but no level behaved as whitelist_auto
  const level = isPermissionLevel(raw) ? raw : whitelistCommands ? 'whitelist_auto' : 'approve_required';
  return {
    level,
    whitelistCommands,
    maxTimeSec: permissions?.max_time_sec ?? 300,
    allow_sensitive: permissions?.allow_sensitive ?? false,
    jailBypass: level === 'unrestricted',
  };
}

/** Overlay a task-level execution policy onto the global policy (feature: 命令执行分级). */
export function policyWithLevel(
  base: PermissionPolicy,
  override?: { level?: string; whitelist_commands?: string[] } | null
): PermissionPolicy {
  if (!override) return base;
  const whitelistCommands = Array.isArray(override.whitelist_commands)
    ? override.whitelist_commands.map(String)
    : base.whitelistCommands;
  const raw = (override.level || '').trim();
  // 2026-09-23：unrestricted 现在对任务同样有效（曾只给协作会话，命中即静默回退 base.level）
  const level = isPermissionLevel(raw) ? raw : base.level;
  return {
    level,
    whitelistCommands,
    maxTimeSec: base.maxTimeSec,
    allow_sensitive: base.allow_sensitive,
    jailBypass: level === 'unrestricted',
  };
}

/** 可执行文件后缀：`path.basename` 保留扩展名，而白名单与仓库惯例都是裸名——
 *  不归一化会让 `npm.cmd` / `tool\flutterw.bat` 这类包装器永远过不了白名单。 */
const EXE_SUFFIX_RE = /\.(exe|cmd|bat)$/i;

export function canExecute(policy: PermissionPolicy, command: string): boolean {
  // 'full' / 'unrestricted' 意味着完全控制：白名单检查整体豁免
  if (policy.level === 'full' || policy.level === 'unrestricted') return true;
  if (policy.whitelistCommands === null) return true;
  const parts = command.trim().split(/\s+/);
  if (parts.length === 0 || !parts[0]) return false;
  const bin = path.basename(parts[0]).replace(EXE_SUFFIX_RE, '');
  return policy.whitelistCommands.includes(bin);
}

const IGNORE = new Set(['.git', '__pycache__', '.pytest_cache', 'node_modules', '.venv', 'venv', '.idea', '.vscode', 'logs', '.history', '.coteam',
  // 构建产物（2026-09-16 o3xmkraj 实证）：Flutter build/ 43MB×上千小文件在收尾 syncToWorkspace
  // 同步 cpSync 时冻结事件循环数分钟（Defender 实时扫描放大），且产物目录从不参与交付
  'build', '.dart_tool', 'target', '.gradle']);
/** Runtime artifacts, never deliverables: caches and databases carry execution state
 *  that breaks repeat runs when committed (tests then hit their own leftover rows). */
const IGNORE_EXT = new Set(['.pyc', '.pyo', '.db', '.sqlite', '.sqlite3']);

export function isIgnoredRelPath(rel: string): boolean {
  const norm = rel.replace(/\\/g, '/');
  if (norm.split('/').some((p) => IGNORE.has(p))) return true;
  return IGNORE_EXT.has(path.extname(norm).toLowerCase());
}

// ---------- worktree 沙箱（o3xmkraj 复盘） ----------
// %TEMP% 全量拷贝绑定服务进程生命周期：服务重启 = 沙箱作废 = 中间态丢失（实测重启
// 4 次绞断恢复链）。git 仓库改用项目目录内 worktree：重启安全、产物 git 原生可审、
// 分支合并/部分抢救语义全部保留（ensureBase/createNodeBranch/syncToWorkspace 不变）。

/** 任务 worktree 根：<workspace>/.coteam/worktrees/<taskId>（目录监狱天然覆盖） */
export function worktreeRoot(workspace: string): string {
  return path.join(path.resolve(workspace), '.coteam', 'worktrees');
}

/** 创建任务沙箱：git 仓库 → worktree 模式；否则回退 %TEMP% 全量拷贝（legacy） */
export async function createSandbox(workspace: string, taskId = ''): Promise<string> {
  if (!fs.existsSync(workspace)) fs.mkdirSync(workspace, { recursive: true });
  if (taskId && fs.existsSync(path.join(workspace, '.git'))) {
    try {
      return await createWorktreeSandbox(workspace, taskId);
    } catch (e) {
      console.error('[sandbox] worktree creation failed, falling back to temp copy:', String((e as Error)?.message || e));
    }
  }
  const sandboxDir = fs.mkdtempSync(path.join(os.tmpdir(), 'coteam-sbx-'));
  fs.cpSync(workspace, sandboxDir, { recursive: true, force: true, filter: (src) => !isIgnoredRelPath(path.relative(workspace, src)) });
  return sandboxDir;
}

async function createWorktreeSandbox(workspace: string, taskId: string): Promise<string> {
  const safeId = taskId.replace(/[^a-zA-Z0-9_-]/g, '-') || 'task';
  const wtPath = path.join(worktreeRoot(workspace), safeId);
  const g = simpleGit({ baseDir: workspace });

  // 先清扫本仓库内所有遗留任务 worktree（崩溃残留会占住 coteam/base 分支）
  const wtList = await g.raw(['worktree', 'list', '--porcelain']).catch(() => '');
  for (const line of wtList.split('\n')) {
    if (!line.startsWith('worktree ')) continue;
    const p = line.slice('worktree '.length).trim();
    if (path.resolve(p) !== path.resolve(workspace) && p.startsWith(worktreeRoot(workspace))) {
      await g.raw(['worktree', 'remove', '--force', p]).catch(() => { fs.rmSync(p, { recursive: true, force: true }); });
    }
  }
  await g.raw(['worktree', 'prune']).catch(() => {});
  if (fs.existsSync(wtPath)) fs.rmSync(wtPath, { recursive: true, force: true });

  const taskBranch = `coteam/task-${safeId}`;
  const hasCommits = !!(await g.log({ maxCount: 1 }).catch(() => null))?.latest;
  let baseSha = '';
  if (!hasCommits) {
    // 空仓库：直接在当前（未出生）分支打基线提交，不折腾 HEAD
    await g.add(['-A']).catch(() => {});
    const st = await g.status();
    if (st.staged.length || st.files.length) await g.commit(`coteam: task baseline ${safeId}`);
    baseSha = (await g.revparse(['HEAD']).catch(() => ''))?.trim() || '';
  } else {
    // 基线舞步：临时切任务分支提交当前工作树（含未提交改动），再回切用户 HEAD——
    // 用户脏改动从"合并时被 mtime 覆盖"变为"进 git 基线可追溯"
    const status = await g.status();
    let orig = status.current;
    const headSha = (await g.log({ maxCount: 1 })).latest!.hash;
    // 崩溃残留自锁（o3xmkraj 09-16 实证）：HEAD 恰好停在 coteam/base 上时，收尾的
    // branch -f coteam/base 会因 "Cannot force update the current branch" 必然抛错，
    // worktree 创建从此每次都静默降级临时拷贝。先 detach 到原提交（orig 置空走
    // 既有 headSha 恢复路径），让 branch -f 在分离 HEAD 下正常执行。
    if (orig === 'coteam/base') {
      await g.checkout(headSha, ['--detach']).catch(() => {});
      orig = '';
    }
    const branches = await g.branchLocal();
    if (branches.all.includes(taskBranch)) await g.branch(['-D', taskBranch]).catch(() => {});
    await g.checkout(['-B', taskBranch]);
    await g.add(['-A']).catch(() => {});
    const st = await g.status();
    if (st.staged.length || st.files.length) await g.commit(`coteam: task baseline ${safeId}`);
    // 清掉上一任务的节点分支：产物已合并/抢救到工作区，残留会让 createNodeBranch
    // 误 checkout 旧内容（worktree 模式下分支跨任务存活，与旧"删沙箱即删分支"不同）。
    // 此刻 HEAD 已在任务分支上——即使用户 HEAD 停在节点分支（崩溃残留）也能删干净。
    const blBefore = await g.branchLocal();
    for (const b of blBefore.all) {
      if (b === taskBranch || b === 'coteam/base' || b.startsWith('coteam/task-')) continue;
      if (b.startsWith('coteam/')) await g.branch(['-D', b]).catch(() => {});
    }
    const blAfter = await g.branchLocal();
    if (orig && orig !== taskBranch && blAfter.all.includes(orig)) await g.checkout(orig).catch(() => {});
    else if (!orig && headSha) await g.checkout(headSha).catch(() => {});
    baseSha = (await g.revparse([taskBranch]).catch(() => ''))?.trim() || '';
  }
  if (!baseSha) throw new Error('workspace repo has no baseline commit (empty directory?)');

  // coteam/base 重指向本任务基线（车道单槽位串行，同仓库一次只有一个任务）
  await g.raw(['branch', '-f', 'coteam/base', baseSha]);
  await g.raw(['worktree', 'add', wtPath, 'coteam/base']);

  // worktree 目录不进用户仓库版本管理
  const gitignore = path.join(workspace, '.gitignore');
  try {
    const cur = fs.existsSync(gitignore) ? fs.readFileSync(gitignore, 'utf-8') : '';
    if (!/^\.coteam\/?\s*$/m.test(cur)) fs.writeFileSync(gitignore, cur + (cur && !cur.endsWith('\n') ? '\n' : '') + '.coteam/\n');
  } catch { /* best effort */ }
  return wtPath;
}

export function mergeChanges(sandbox: string, target: string): string[] {
  const changes: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const srcPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!IGNORE.has(entry.name)) walk(srcPath);
        continue;
      }
      const rel = path.relative(sandbox, srcPath);
      if (isIgnoredRelPath(rel)) continue;
      const dstPath = path.join(target, rel);
      fs.mkdirSync(path.dirname(dstPath), { recursive: true });
      if (!fs.existsSync(dstPath) || fs.statSync(srcPath).mtimeMs > fs.statSync(dstPath).mtimeMs) {
        fs.copyFileSync(srcPath, dstPath);
        changes.push(rel);
      }
    }
  };
  walk(sandbox);
  return changes;
}

/** 清理沙箱：worktree（.git 是文件指针）走 git worktree remove，legacy 临时目录直接删 */
export async function cleanupSandbox(sandbox: string): Promise<void> {
  if (!sandbox || !fs.existsSync(sandbox)) return;
  const dotGit = path.join(sandbox, '.git');
  let isWorktree = false;
  try { isWorktree = fs.existsSync(dotGit) && fs.statSync(dotGit).isFile(); } catch { /* ignore */ }
  if (isWorktree) {
    try {
      await simpleGit({ baseDir: sandbox }).raw(['worktree', 'remove', '--force', sandbox]);
      return;
    } catch {
      // Windows EBUSY 等文件占用：直接删目录，worktree 元数据由下次任务的 prune 兜底
      fs.rmSync(sandbox, { recursive: true, force: true });
      return;
    }
  }
  fs.rmSync(sandbox, { recursive: true, force: true });
}

/** Write agent-produced files into the workspace; refuses path traversal. */
export function writeFiles(workspace: string, files: { path: string; content: string }[]): string[] {
  const written: string[] = [];
  const base = path.resolve(workspace);
  for (const file of files || []) {
    const rel = (file.path || '').trim();
    if (!rel) continue;
    const target = path.resolve(base, rel);
    if (!target.startsWith(base)) continue;
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const content = Array.isArray(file.content) ? (file.content as string[]).join('\n') : String(file.content ?? '');
    fs.writeFileSync(target, content, 'utf-8');
    written.push(rel);
  }
  return written;
}

export interface CommandResult {
  command: string;
  allowed: boolean;
  returncode: number;
  stdout: string;
  stderr: string;
  /** approve_required policy: the command was parked for human approval, not executed */
  needs_approval?: boolean;
  /** SEC-P0 高危形态命中（删除/系统级/内联代码/强推），强制转人工审批 */
  sensitive?: boolean;
}

export function executeCommand(command: string, cwd: string, policy: PermissionPolicy, timeoutSec?: number): CommandResult {
  if (!canExecute(policy, command)) {
    return { command, allowed: false, returncode: -1, stdout: '', stderr: 'command not in whitelist' };
  }
  // 目录监狱：命令里的绝对路径/`..` 逃逸一律拒绝——full = 目录内完全控制；unrestricted = 解除
  if (!policy.jailBypass) {
    const jail = assertWithinJail(command, cwd);
    if (!jail.ok) {
      return { command, allowed: false, returncode: -1, stdout: '', stderr: jailViolationMessage(jail.violations, cwd) };
    }
  }
  const timeout = (timeoutSec ?? policy.maxTimeSec) * 1000;
  try {
    const proc = spawnSync(command, {
      shell: true,
      cwd,
      encoding: 'utf-8',
      timeout,
      maxBuffer: 8 * 1024 * 1024,
    });
    return {
      command,
      allowed: true,
      returncode: proc.status ?? -1,
      stdout: (proc.stdout || '').slice(-4000),
      stderr: ((proc.stderr || '') + (proc.error ? ` ${proc.error.message}` : '')).slice(-2000),
    };
  } catch (e: any) {
    const timedOut = e?.code === 'ETIMEDOUT' || /timed out/i.test(String(e));
    return {
      command,
      allowed: true,
      returncode: -1,
      stdout: '',
      stderr: timedOut ? `timeout after ${timeout / 1000}s` : String(e).slice(0, 500),
    };
  }
}

/** Async version of executeCommand that supports AbortSignal for cancellation. */
export function executeCommandAsync(
  command: string,
  cwd: string,
  policy: PermissionPolicy,
  timeoutSec?: number,
  signal?: AbortSignal
): Promise<CommandResult> {
  return new Promise((resolve) => {
    if (!canExecute(policy, command)) {
      resolve({ command, allowed: false, returncode: -1, stdout: '', stderr: 'command not in whitelist' });
      return;
    }
    // 目录监狱（同 executeCommand）：越界命令不执行；unrestricted 解除
    if (!policy.jailBypass) {
      const jail = assertWithinJail(command, cwd);
      if (!jail.ok) {
        resolve({ command, allowed: false, returncode: -1, stdout: '', stderr: jailViolationMessage(jail.violations, cwd) });
        return;
      }
    }

    const timeout = (timeoutSec ?? policy.maxTimeSec) * 1000;
    let stdout = '';
    let stderr = '';
    let killed = false;

    // 并行加固（Phase 2，2026-09-16）：输出滚动截尾（各保留尾部 1MB）——此前 stdout/stderr
    // 无界累积（同步版有 8MB maxBuffer，异步版裸奔），大输出命令（构建/日志回放）在并行
    // 任务 ×N 下是隐性 OOM 源（历史两次 4GB OOM 治理后的残留面）
    const COMMAND_OUTPUT_CAP = 1_000_000;
    const capTail = (acc: string, chunk: string): string => {
      acc += chunk;
      return acc.length > COMMAND_OUTPUT_CAP ? acc.slice(-COMMAND_OUTPUT_CAP) : acc;
    };

    const proc = spawn(command, {
      shell: true,
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    proc.stdout?.on('data', (data: Buffer) => {
      stdout = capTail(stdout, data.toString());
    });

    proc.stderr?.on('data', (data: Buffer) => {
      stderr = capTail(stderr, data.toString());
    });

    const cleanup = () => {
      if (!proc.killed) {
        proc.kill();
        killed = true;
      }
    };

    if (signal) {
      signal.addEventListener('abort', cleanup, { once: true });
    }

    const timer = setTimeout(() => {
      cleanup();
      resolve({
        command,
        allowed: true,
        returncode: -1,
        stdout: stdout.slice(-4000),
        stderr: `timeout after ${timeout / 1000}s`,
      });
    }, timeout);

    proc.on('close', (code) => {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', cleanup);
      resolve({
        command,
        allowed: true,
        returncode: code ?? -1,
        stdout: stdout.slice(-4000),
        stderr: stderr.slice(-2000),
      });
    });

    proc.on('error', (err) => {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', cleanup);
      resolve({
        command,
        allowed: true,
        returncode: -1,
        stdout: '',
        stderr: killed ? 'cancelled' : String(err).slice(0, 500),
      });
    });
  });
}
