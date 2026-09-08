import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync, spawn } from 'node:child_process';

/** Command execution levels (feature: 命令执行分级), from most to least restrictive. */
export type PermissionLevel = 'plan_only' | 'readonly' | 'approve_required' | 'whitelist_auto' | 'full';

export const PERMISSION_LEVELS: PermissionLevel[] = ['plan_only', 'readonly', 'approve_required', 'whitelist_auto', 'full'];

export function isPermissionLevel(v: unknown): v is PermissionLevel {
  return typeof v === 'string' && (PERMISSION_LEVELS as string[]).includes(v);
}

export interface PermissionPolicy {
  level: PermissionLevel;
  whitelistCommands: string[] | null;
  maxTimeSec: number;
}

export function policyFromConfig(permissions?: { level?: string; whitelist_commands?: string[]; max_time_sec?: number } | null): PermissionPolicy {
  const whitelistCommands = permissions?.whitelist_commands ?? null;
  const raw = (permissions?.level || '').trim();
  // back-compat: an old config with a whitelist but no level behaved as whitelist_auto
  const level = isPermissionLevel(raw) ? raw : whitelistCommands ? 'whitelist_auto' : 'approve_required';
  return {
    level,
    whitelistCommands,
    maxTimeSec: permissions?.max_time_sec ?? 300,
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
  return {
    level: isPermissionLevel(raw) ? raw : base.level,
    whitelistCommands,
    maxTimeSec: base.maxTimeSec,
  };
}

export function canExecute(policy: PermissionPolicy, command: string): boolean {
  // 'full' 意味着完全控制：白名单检查整体豁免
  if (policy.level === 'full') return true;
  if (policy.whitelistCommands === null) return true;
  const parts = command.trim().split(/\s+/);
  if (parts.length === 0 || !parts[0]) return false;
  const bin = path.basename(parts[0]);
  return policy.whitelistCommands.includes(bin);
}

const IGNORE = new Set(['.git', '__pycache__', '.pytest_cache', 'node_modules', '.venv', 'venv', '.idea', '.vscode', 'logs', '.history']);
/** Runtime artifacts, never deliverables: caches and databases carry execution state
 *  that breaks repeat runs when committed (tests then hit their own leftover rows). */
const IGNORE_EXT = new Set(['.pyc', '.pyo', '.db', '.sqlite', '.sqlite3']);

export function isIgnoredRelPath(rel: string): boolean {
  const norm = rel.replace(/\\/g, '/');
  if (norm.split('/').some((p) => IGNORE.has(p))) return true;
  return IGNORE_EXT.has(path.extname(norm).toLowerCase());
}

export function createSandbox(workspace: string): string {
  if (!fs.existsSync(workspace)) fs.mkdirSync(workspace, { recursive: true });
  const sandboxDir = fs.mkdtempSync(path.join(os.tmpdir(), 'coteam-sbx-'));
  fs.cpSync(workspace, sandboxDir, { recursive: true, force: true, filter: (src) => !isIgnoredRelPath(path.relative(workspace, src)) });
  return sandboxDir;
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

export function cleanupSandbox(sandbox: string): void {
  if (sandbox && fs.existsSync(sandbox)) fs.rmSync(sandbox, { recursive: true, force: true });
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
}

export function executeCommand(command: string, cwd: string, policy: PermissionPolicy, timeoutSec?: number): CommandResult {
  if (!canExecute(policy, command)) {
    return { command, allowed: false, returncode: -1, stdout: '', stderr: 'command not in whitelist' };
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

    const timeout = (timeoutSec ?? policy.maxTimeSec) * 1000;
    let stdout = '';
    let stderr = '';
    let killed = false;

    const proc = spawn(command, {
      shell: true,
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    proc.stdout?.on('data', (data: Buffer) => {
      stdout += data.toString();
    });

    proc.stderr?.on('data', (data: Buffer) => {
      stderr += data.toString();
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
