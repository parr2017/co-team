import * as fs from 'node:fs';
import * as path from 'node:path';
import { canExecute, executeCommand, writeFiles, CommandResult, PermissionPolicy } from './sandbox';

const MAX_FILE_BYTES = 64 * 1024;
const IGNORED_DIRS = new Set(['.git', '__pycache__', 'node_modules', '.venv', 'venv', '.idea', '.vscode']);
const GREP_MAX_RESULTS = 80;

export function listFiles(workspace: string, limit = 200): string[] {
  const base = path.resolve(workspace);
  const out: string[] = [];
  const walk = (dir: string) => {
    if (out.length >= limit) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (out.length >= limit) return;
      if (entry.isDirectory()) {
        if (!IGNORED_DIRS.has(entry.name)) walk(path.join(dir, entry.name));
        continue;
      }
      out.push(path.relative(base, path.join(dir, entry.name)));
    }
  };
  if (fs.existsSync(base)) walk(base);
  return out;
}

export function readFile(workspace: string, filePath: string): { ok: boolean; path: string; content?: string; error?: string } {
  const base = path.resolve(workspace);
  const target = path.resolve(base, filePath);
  if (!target.startsWith(base)) return { ok: false, path: filePath, error: 'path outside workspace' };
  if (!fs.existsSync(target) || !fs.statSync(target).isFile()) return { ok: false, path: filePath, error: `file not found: ${filePath}` };
  const stat = fs.statSync(target);
  if (stat.size > MAX_FILE_BYTES) return { ok: false, path: filePath, error: `file too large: ${stat.size} bytes` };
  return { ok: true, path: filePath, content: fs.readFileSync(target, 'utf-8') };
}

export function readDir(workspace: string, dirPath: string): { ok: boolean; path: string; entries?: string[]; error?: string } {
  const base = path.resolve(workspace);
  const target = path.resolve(base, dirPath);
  if (!target.startsWith(base)) return { ok: false, path: dirPath, error: 'path outside workspace' };
  if (!fs.existsSync(target) || !fs.statSync(target).isDirectory()) return { ok: false, path: dirPath, error: `directory not found: ${dirPath}` };
  try {
    const entries = fs.readdirSync(target, { withFileTypes: true }).map((e) => `${e.isDirectory() ? '[dir] ' : ''}${e.name}`);
    return { ok: true, path: dirPath, entries };
  } catch (e: any) {
    return { ok: false, path: dirPath, error: e.message };
  }
}

export function grepFiles(workspace: string, pattern: string, subPath?: string): { ok: boolean; matches?: { file: string; line: number; text: string }[]; error?: string } {
  if (!pattern) return { ok: false, error: 'pattern is required' };
  const base = path.resolve(workspace);
  const searchRoot = subPath ? path.resolve(base, subPath) : base;
  if (!searchRoot.startsWith(base)) return { ok: false, error: 'path outside workspace' };
  if (!fs.existsSync(searchRoot)) return { ok: false, error: `path not found: ${subPath || '.'}` };

  let regex: RegExp;
  try { regex = new RegExp(pattern, 'i'); } catch { return { ok: false, error: `invalid regex: ${pattern}` }; }

  const matches: { file: string; line: number; text: string }[] = [];
  const walk = (dir: string) => {
    if (matches.length >= GREP_MAX_RESULTS) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (matches.length >= GREP_MAX_RESULTS) return;
      if (entry.isDirectory()) {
        if (!IGNORED_DIRS.has(entry.name)) walk(path.join(dir, entry.name));
        continue;
      }
      const filePath = path.join(dir, entry.name);
      try {
        const stat = fs.statSync(filePath);
        if (stat.size > MAX_FILE_BYTES) continue;
        const lines = fs.readFileSync(filePath, 'utf-8').split('\n');
        for (let i = 0; i < lines.length; i++) {
          if (regex.test(lines[i])) {
            matches.push({ file: path.relative(base, filePath), line: i + 1, text: lines[i].trim().slice(0, 200) });
            if (matches.length >= GREP_MAX_RESULTS) break;
          }
        }
      } catch { /* skip binary / unreadable */ }
    }
  };
  walk(searchRoot);
  return { ok: true, matches };
}

export function gitLog(workspace: string): { ok: boolean; log?: string; error?: string } {
  try {
    const result = executeCommand('git log --oneline -20', workspace, { level: 'normal', whitelist_commands: [] } as any);
    return { ok: true, log: result.stdout || '(no commits)' };
  } catch (e: any) {
    return { ok: false, error: e.message };
  }
}

export function gitDiff(workspace: string): { ok: boolean; diff?: string; error?: string } {
  try {
    const result = executeCommand('git diff --stat', workspace, { level: 'normal', whitelist_commands: [] } as any);
    return { ok: true, diff: result.stdout || '(no changes)' };
  } catch (e: any) {
    return { ok: false, error: e.message };
  }
}

/** Read-only tools the agent may request mid-conversation. */
export function applyToolCalls(workspace: string, toolCalls: { tool: string; path?: string; pattern?: string; query?: string }[] | undefined): unknown[] {
  const results: unknown[] = [];
  for (const call of toolCalls || []) {
    const name = (call.tool || '').toLowerCase();
    if (name === 'list_files' || name === 'list' || name === 'ls') {
      results.push({ tool: 'list_files', files: listFiles(workspace) });
    } else if (name === 'read_file' || name === 'read') {
      results.push({ tool: 'read_file', ...readFile(workspace, call.path || '') });
    } else if (name === 'read_dir' || name === 'readdir') {
      results.push({ tool: 'read_dir', ...readDir(workspace, call.path || '') });
    } else if (name === 'grep' || name === 'search') {
      results.push({ tool: 'grep', ...grepFiles(workspace, call.pattern || call.query || '', call.path) });
    } else if (name === 'git_log') {
      results.push({ tool: 'git_log', ...gitLog(workspace) });
    } else if (name === 'git_diff') {
      results.push({ tool: 'git_diff', ...gitDiff(workspace) });
    } else {
      results.push({ tool: name, ok: false, error: `tool '${name}' not allowed mid-run` });
    }
  }
  return results;
}

/** Apply an agent's final output: write files, run whitelisted commands. Mutates output. */
export function applyFinalOutput(workspace: string, output: Record<string, any>, policy: PermissionPolicy): Record<string, any> {
  const written = writeFiles(workspace, output.files || []);
  const commandResults = (output.commands || []).map((c: string) => executeCommand(String(c), workspace, policy));

  const declared: string[] = output.changes || [];
  const merged = [...new Set([...written, ...declared.map((c: unknown) => String(c))])];
  output.changes = merged;
  output.command_results = commandResults.map((c: CommandResult) => ({ command: c.command, returncode: c.returncode, stderr: c.stderr.slice(-500) }));

  const failed = commandResults.filter((c: CommandResult) => c.returncode !== 0);
  if (failed.length) {
    output.errors = [...(output.errors || []), ...failed.map((c: CommandResult) => `command failed: ${c.command}: ${c.stderr.slice(-200)}`)];
  }
  return output;
}

export { canExecute } from './sandbox';
export type { PermissionPolicy };
