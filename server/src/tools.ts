import * as fs from 'node:fs';
import * as path from 'node:path';
import { canExecute, executeCommand, writeFiles, CommandResult, PermissionPolicy } from './sandbox';
import { assertWithinJail, jailViolationMessage } from './workspace';
import { writeKnowledge } from './knowledge';
import { writeDoc, SSOT_DOC_TYPES, type SsotDocType } from './ssot';
import { pushAgentMessage, MAX_MESSAGE_LENGTH, type AgentMessage } from './agentMessages';
import { findSkillForAgent } from './skills';

export interface KnowledgeToolContext {
  agent: string;
  task_id?: string;
  project_id?: string;
  /** sandbox dir receiving doc file writes (write_doc) */
  sandboxDir?: string;
  /** valid send_message targets: agent names (orchestrator/user are always allowed) */
  availableAgents?: string[];
  /** names of the skills indexed for this node (load_skill hints on miss) */
  availableSkills?: string[];
  node_id?: string;
  node_name?: string;
}

const MAX_FILE_BYTES = 64 * 1024;
/** i6efv5h2 复盘：单文件注入的字符预算——全文回显是上下文膨胀主源，超出截断并注明 */
const MAX_READ_CHARS = 16000;
const IGNORED_DIRS = new Set(['.git', '__pycache__', 'node_modules', '.venv', 'venv', '.idea', '.vscode']);
const GREP_MAX_RESULTS = 80;

/** 缓存优先裁剪的度量基线：CJK 1 token/字、其余 ~4 字符/token 的保守启发式 */
export function estimateTokens(s: string): number {
  let cjk = 0;
  let other = 0;
  // 用显式码点区间：字面量字符类里 "空格-〿" 会连出 U+0020..U+303F 把拉丁字母吞进 CJK
  const CJK = /[\u3000-\u303f\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff00-\uffef]/;
  for (const ch of s) {
    if (CJK.test(ch)) cjk += 1;
    else other += 1;
  }
  return cjk + Math.ceil(other / 4);
}

/** load_skill 注入上限：技能正文按需拉取后仍然限幅，防单技能撑爆窗口 */
const MAX_SKILL_BODY_CHARS = 12000;

/**
 * 缓存优先的目录树渲染（替代 flat 全量 join）：深度/行数/字符三重预算，
 * 排序确定性——同一工作树必产出字节一致的字符串（前缀缓存友好）。
 */
export function renderWorkspaceTree(workspace: string, maxChars = 1500, maxDepth = 3): string {
  const base = path.resolve(workspace);
  if (!fs.existsSync(base)) return '(工作目录为空)';
  const lines: string[] = [];
  let totalFiles = 0;
  let truncated = false;
  const walk = (dir: string, depth: number) => {
    if (truncated) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // 目录级 fs 异常静默降级（缓存优先裁剪不得炸掉组装）
    }
    const dirs = entries.filter((e) => e.isDirectory() && !IGNORED_DIRS.has(e.name)).sort((a, b) => a.name.localeCompare(b.name));
    const files = entries.filter((e) => e.isFile()).sort((a, b) => a.name.localeCompare(b.name));
    totalFiles += files.length;
    const indent = '  '.repeat(depth);
    const shown = files.slice(0, depth >= maxDepth ? 3 : 12);
    for (const f of shown) {
      lines.push(`${indent}${f.name}${files.length > shown.length && f === shown[shown.length - 1] ? ` …(+${files.length - shown.length})` : ''}`);
      if (lines.join('\n').length > maxChars) { truncated = true; return; }
    }
    if (depth < maxDepth) for (const d of dirs) {
      lines.push(`${indent}${d.name}/`);
      if (lines.join('\n').length > maxChars) { truncated = true; return; }
      walk(path.join(dir, d.name), depth + 1);
      if (truncated) return;
    } else if (dirs.length) {
      lines.push(`${indent}[+${dirs.length} 个子目录，明细用 list_files]`);
      if (lines.join('\n').length > maxChars) { truncated = true; return; }
    }
  };
  walk(base, 0);
  const body = lines.join('\n');
  return truncated ? `${body}\n…（目录树过大已截断，共 ${totalFiles}+ 文件可见部分如上，明细用 list_files 工具）` : body;
}

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

export function readFile(workspace: string, filePath: string): { ok: boolean; path: string; content?: string; error?: string; truncated?: boolean } {
  const base = path.resolve(workspace);
  const target = path.resolve(base, filePath);
  if (!target.startsWith(base)) return { ok: false, path: filePath, error: 'path outside workspace' };
  if (!fs.existsSync(target) || !fs.statSync(target).isFile()) return { ok: false, path: filePath, error: `file not found: ${filePath}` };
  const stat = fs.statSync(target);
  if (stat.size > MAX_FILE_BYTES) {
    // 大文件不再是死路：仍给开头预算内的内容 + 指引（旧行为直接报错逼模型盲改）
    const head = fs.readFileSync(target, 'utf-8').slice(0, MAX_READ_CHARS);
    return { ok: true, path: filePath, content: `${head}\n…(文件共 ${stat.size} 字节，仅注入前 ${MAX_READ_CHARS} 字符；用 grep 定位后编辑，或用 edits 做精确替换)`, truncated: true };
  }
  const text = fs.readFileSync(target, 'utf-8');
  if (text.length > MAX_READ_CHARS) {
    return { ok: true, path: filePath, content: `${text.slice(0, MAX_READ_CHARS)}\n…(文件共 ${text.length} 字符，已截断注入；用 grep 定位后编辑，或用 edits 做精确替换)`, truncated: true };
  }
  return { ok: true, path: filePath, content: text };
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
  try {
    regex = new RegExp(pattern, 'i');
    // 部分引擎错误（嵌套层数超上限等）在 test 编译路径才抛——这里提前触发一次，
    // 转软错误给模型，而不是留到逐文件匹配时被 catch-all 静默吞成 0 命中（伪成功）。
    regex.test('');
  } catch (e: any) {
    const msg = String(e?.message || e);
    return { ok: false, error: /too complex|number of captures/i.test(msg) ? `invalid regex: pattern 过于复杂（嵌套层数超引擎上限），请简化: ${pattern.slice(0, 80)}` : `invalid regex: ${pattern}` };
  }

  const matches: { file: string; line: number; text: string }[] = [];

  // ENOTDIR 修复（i6efv5h2 复盘）：模型常把 grep 的 path 参数传成【文件】而非目录
  // （"在这个文件里搜"），旧代码直接 readdirSync(文件) 抛 ENOTDIR，异常沿调用链
  // 炸毁整次模型尝试——两个任务共 8 次死亡源于此。文件路径就单文件逐行匹配。
  if (fs.statSync(searchRoot).isFile()) {
    try {
      const lines = fs.readFileSync(searchRoot, 'utf-8').split('\n');
      for (let i = 0; i < lines.length && matches.length < GREP_MAX_RESULTS; i++) {
        if (regex.test(lines[i])) matches.push({ file: path.relative(base, searchRoot), line: i + 1, text: lines[i].trim().slice(0, 200) });
      }
      return { ok: true, matches };
    } catch (e: any) {
      return { ok: false, error: `grep on file failed: ${String(e?.message || e).slice(0, 200)}` };
    }
  }

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
  try {
    walk(searchRoot);
  } catch (e: any) {
    return { ok: false, error: `grep walk failed: ${String(e?.message || e).slice(0, 200)}` };
  }
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

/** Read-only tools the agent may request mid-conversation, plus write_knowledge for
 *  experience deposit, write_doc for SSOT collaboration docs and send_message for
 *  agent-to-agent deferred messaging (improvement #4 behavioral contract). */
export async function applyToolCalls(workspace: string, toolCalls: { tool: string; path?: string; pattern?: string; query?: string; title?: string; content?: string; tags?: string[]; category?: string; type?: string; to?: string; text?: string; name?: string }[] | undefined, knowledgeCtx?: KnowledgeToolContext): Promise<unknown[]> {
  const results: unknown[] = [];
  for (const call of toolCalls || []) {
    const name = (call.tool || '').toLowerCase();
    // 软错误纪律（i6efv5h2 复盘）：任何 fs/遍历异常转 {ok:false} 回喂模型，
    // 绝不允许沿调用链炸毁整次 LLM 尝试——一次 throw = 一次 600s 模型尝试陪葬。
    if (name === 'list_files' || name === 'list' || name === 'ls') {
      try {
        results.push({ tool: 'list_files', files: listFiles(workspace) });
      } catch (e: any) {
        results.push({ tool: 'list_files', ok: false, error: String(e?.message || e).slice(0, 200) });
      }
    } else if (name === 'load_skill') {
      // 技能正文按需拉取（缓存优先裁剪）：注入的只有索引，模型判断相关才拉全文
      const skillName = String(call.name || call.path || '').trim();
      const skill = skillName ? findSkillForAgent(skillName, knowledgeCtx?.agent || '') : null;
      if (!skill) {
        results.push({
          tool: 'load_skill', ok: false,
          error: `技能不存在或对本 agent 不可用: ${skillName || '(name 缺失)'}`,
          available: knowledgeCtx?.availableSkills || [],
        });
      } else {
        const body = skill.body.length > MAX_SKILL_BODY_CHARS ? `${skill.body.slice(0, MAX_SKILL_BODY_CHARS)}\n…(技能正文超长已截断)` : skill.body;
        results.push({ tool: 'load_skill', ok: true, name: skill.name, description: skill.description, body });
      }
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
    } else if (name === 'write_knowledge') {
      if (!knowledgeCtx) {
        results.push({ tool: 'write_knowledge', ok: false, error: 'knowledge deposit not available in this context' });
        continue;
      }
      try {
        const category = call.category === 'project' ? 'project' : 'general-tech';
        const written = writeKnowledge({
          title: String(call.title || ''),
          content: String(call.content || ''),
          category,
          project_id: knowledgeCtx.project_id,
          tags: call.tags,
          source: knowledgeCtx.task_id ? `agent:${knowledgeCtx.agent} task:${knowledgeCtx.task_id}` : `agent:${knowledgeCtx.agent}`,
        });
        results.push({ tool: 'write_knowledge', ok: true, id: written.id, updated: written.updated, category });
      } catch (e: any) {
        results.push({ tool: 'write_knowledge', ok: false, error: String(e?.message || e).slice(0, 200) });
      }
    } else if (name === 'write_doc') {
      if (!knowledgeCtx?.task_id) {
        results.push({ tool: 'write_doc', ok: false, error: 'doc update not available in this context' });
        continue;
      }
      const type = String(call.type || '').trim().toUpperCase() as SsotDocType;
      if (!(SSOT_DOC_TYPES as string[]).includes(type)) {
        results.push({ tool: 'write_doc', ok: false, error: `type 必须是 ${SSOT_DOC_TYPES.join('/')} 之一` });
        continue;
      }
      try {
        const doc = await writeDoc(knowledgeCtx.task_id, type, String(call.content || ''), knowledgeCtx.agent, knowledgeCtx.sandboxDir);
        results.push({ tool: 'write_doc', ok: true, type, version: doc.version, path: doc.path });
      } catch (e: any) {
        results.push({ tool: 'write_doc', ok: false, error: String(e?.message || e).slice(0, 200) });
      }
    } else if (name === 'send_message') {
      if (!knowledgeCtx) {
        results.push({ tool: 'send_message', ok: false, error: 'messaging not available in this context' });
        continue;
      }
      const to = String(call.to || '').trim();
      const allowed = [...new Set([...(knowledgeCtx?.availableAgents || []), 'orchestrator', 'user'])];
      if (!to || !allowed.includes(to)) {
        results.push({ tool: 'send_message', ok: false, error: `to 必须是以下之一: ${allowed.join(', ')}` });
        continue;
      }
      const text = String(call.text || '').trim().slice(0, MAX_MESSAGE_LENGTH);
      if (!text) {
        results.push({ tool: 'send_message', ok: false, error: 'text 不能为空' });
        continue;
      }
      const msg: AgentMessage = {
        id: Math.random().toString(36).slice(2, 10),
        from: knowledgeCtx.agent,
        to,
        text,
        ts: new Date().toISOString(),
        node_id: knowledgeCtx.node_id,
        node_name: knowledgeCtx.node_name,
      };
      try {
        await pushAgentMessage(knowledgeCtx.task_id || '', msg);
        results.push({ tool: 'send_message', ok: true, to, id: msg.id });
      } catch (e: any) {
        results.push({ tool: 'send_message', ok: false, error: String(e?.message || e).slice(0, 200) });
      }
    } else {
      results.push({ tool: name, ok: false, error: `tool '${name}' not allowed mid-run` });
    }
  }
  return results;
}

/**
 * Apply an agent's final output according to the execution policy (feature: 命令执行分级):
 * - plan_only: nothing is written or executed — files/commands are returned as a proposal;
 * - readonly: file writes are held back as proposals; commands stay whitelist-gated;
 * - approve_required: whitelisted commands run, the rest are parked in output.pending_commands;
 * - whitelist_auto: legacy behavior — non-whitelisted commands are rejected outright;
 * - full: everything runs.
 */
export function applyFinalOutput(workspace: string, output: Record<string, any>, policy: PermissionPolicy): Record<string, any> {
  if (policy.level === 'plan_only') {
    output.plan_only = true;
    output.proposed = {
      files: (output.files || []).map((f: { path: string; content?: string }) => ({ path: f.path, bytes: String(f.content ?? '').length })),
      edits: (output.edits || []).map((e: { path?: string }) => String(e.path || '')),
      commands: (output.commands || []).map(String),
    };
    output.files = [];
    output.edits = [];
    output.commands = [];
    output.command_results = [];
    output.changes = [];
    return output;
  }

  let written: string[] = [];
  if (policy.level === 'readonly') {
    output.proposed = {
      files: (output.files || []).map((f: { path: string; content?: string }) => ({ path: f.path, bytes: String(f.content ?? '').length })),
      edits: (output.edits || []).map((e: { path?: string }) => String(e.path || '')),
      commands: (output.commands || []).map(String),
    };
    output.files = [];
    output.edits = [];
  } else {
    written = writeFiles(workspace, output.files || []);
    // B3c: incremental find/replace edits on existing files
    const { edited, failures } = applyEdits(workspace, output.edits || []);
    written.push(...edited);
    if (failures.length) output.errors = [...(output.errors || []), ...failures];
  }

  const commandResults: CommandResult[] = (output.commands || []).map((c: string) => {
    const command = String(c);
    // 目录监狱预检：越界命令直接拒绝，不进待审批队列（人不应被要求批准越狱操作）
    const jail = assertWithinJail(command, workspace);
    if (!jail.ok) {
      return { command, allowed: false, returncode: -1, stdout: '', stderr: jailViolationMessage(jail.violations, workspace) };
    }
    if (policy.level === 'full' || canExecute(policy, command)) return executeCommand(command, workspace, policy);
    if (policy.level === 'approve_required') {
      // park the command for human approval — the orchestrator blocks node completion on it
      return { command, allowed: false, needs_approval: true, returncode: -1, stdout: '', stderr: '等待人工审批（执行策略 approve_required）' };
    }
    return { command, allowed: false, returncode: -1, stdout: '', stderr: 'command not in whitelist' };
  });
  const pendingCommands = commandResults.filter((c) => c.needs_approval).map((c) => c.command);
  if (pendingCommands.length) output.pending_commands = pendingCommands;

  const declared: string[] = output.changes || [];
  const merged = [...new Set([...written, ...declared.map((c: unknown) => String(c))])];
  output.changes = merged;
  // D2: delivery declaration discipline — files actually written but not declared
  // by the model are surfaced instead of silently accepted.
  const declaredPaths = new Set(declared.map((c: unknown) => String(c).split(':')[0].trim()));
  const unreported = written.filter((w) => !declaredPaths.has(w));
  if (unreported.length) output.unreported_files = unreported;
  output.command_results = commandResults.map((c: CommandResult) => ({ command: c.command, needs_approval: c.needs_approval || false, returncode: c.returncode, stderr: c.stderr.slice(-500), stdout: c.stdout.slice(-4000) }));

  const failed = commandResults.filter((c: CommandResult) => c.returncode !== 0 && !c.needs_approval);
  if (failed.length) {
    output.errors = [...(output.errors || []), ...failed.map((c: CommandResult) => `command failed: ${c.command}: ${c.stderr.slice(-200)}`)];
  }
  return output;
}

/** B3c: apply find/replace edits to existing files. Returns edited relative paths;
 *  find-text misses and path violations are reported as failures (never silent). */
export function applyEdits(workspace: string, edits: { path?: string; find?: string; replace?: string }[] | undefined): { edited: string[]; failures: string[] } {
  const base = path.resolve(workspace);
  const edited: string[] = [];
  const failures: string[] = [];
  for (const ed of edits || []) {
    const rel = String(ed.path || '').trim();
    if (!rel) continue;
    const target = path.resolve(base, rel);
    if (!target.startsWith(base)) { failures.push(`edit rejected (path outside workspace): ${rel}`); continue; }
    let before: string;
    try { before = fs.readFileSync(target, 'utf-8'); } catch { failures.push(`edit failed (file not found): ${rel}`); continue; }
    const find = String(ed.find ?? '');
    if (!find || !before.includes(find)) { failures.push(`edit failed (find text not found): ${rel}`); continue; }
    fs.writeFileSync(target, before.replace(find, String(ed.replace ?? '')), 'utf-8');
    edited.push(rel);
  }
  return { edited, failures };
}

export { canExecute } from './sandbox';
export type { PermissionPolicy };
