import * as fs from 'node:fs';
import * as path from 'node:path';
import { canExecute, executeCommand, writeFiles, CommandResult, PermissionPolicy } from './sandbox';

const MAX_FILE_BYTES = 64 * 1024;
const IGNORED_DIRS = new Set(['.git', '__pycache__', 'node_modules', '.venv', 'venv', '.idea', '.vscode']);

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

/** Read-only tools the agent may request mid-conversation. */
export function applyToolCalls(workspace: string, toolCalls: { tool: string; path?: string }[] | undefined): unknown[] {
  const results: unknown[] = [];
  for (const call of toolCalls || []) {
    const name = (call.tool || '').toLowerCase();
    if (name === 'list_files' || name === 'list' || name === 'ls') {
      results.push({ tool: 'list_files', files: listFiles(workspace) });
    } else if (name === 'read_file' || name === 'read') {
      results.push({ tool: 'read_file', ...readFile(workspace, call.path || '') });
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
