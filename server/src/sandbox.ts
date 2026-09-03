import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';

export interface PermissionPolicy {
  whitelistCommands: string[] | null;
  maxTimeSec: number;
}

export function policyFromConfig(permissions?: { whitelist_commands?: string[]; max_time_sec?: number } | null): PermissionPolicy {
  return {
    whitelistCommands: permissions?.whitelist_commands ?? null,
    maxTimeSec: permissions?.max_time_sec ?? 300,
  };
}

export function canExecute(policy: PermissionPolicy, command: string): boolean {
  if (policy.whitelistCommands === null) return true;
  const parts = command.trim().split(/\s+/);
  if (parts.length === 0 || !parts[0]) return false;
  const bin = path.basename(parts[0]);
  return policy.whitelistCommands.includes(bin);
}

const IGNORE = new Set(['.git', '__pycache__', 'node_modules', '.venv', 'venv', '.idea', '.vscode']);

export function createSandbox(workspace: string): string {
  if (!fs.existsSync(workspace)) fs.mkdirSync(workspace, { recursive: true });
  const sandboxDir = fs.mkdtempSync(path.join(os.tmpdir(), 'coteam-sbx-'));
  fs.cpSync(workspace, sandboxDir, { recursive: true, force: true, filter: (src) => !IGNORE.has(path.basename(src)) });
  return sandboxDir;
}

export function mergeChanges(sandbox: string, target: string): string[] {
  const changes: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const srcPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(srcPath);
        continue;
      }
      const rel = path.relative(sandbox, srcPath);
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
