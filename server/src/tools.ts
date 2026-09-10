import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
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

export function readFile(workspace: string, filePath: string, lineStart?: number, lineEnd?: number): { ok: boolean; path: string; content?: string; error?: string; truncated?: boolean; total_lines?: number } {
  const base = path.resolve(workspace);
  const target = path.resolve(base, filePath);
  if (!target.startsWith(base)) return { ok: false, path: filePath, error: 'path outside workspace' };
  if (!fs.existsSync(target) || !fs.statSync(target).isFile()) return { ok: false, path: filePath, error: `file not found: ${filePath}` };
  const stat = fs.statSync(target);
  // M5（2y3tuote 实证）：行范围读取——大文件节点 5 轮工具预算 × 16k 截断拼不出完整现场，
  // 模型被迫盲写或上报"缺少文件内容"；给精确续读能力（先 grep 定行号，再按段读）。
  if (lineStart && lineStart > 0) {
    const all = fs.readFileSync(target, 'utf-8').split('\n');
    const from = Math.max(1, Math.floor(lineStart));
    const to = Math.min(all.length, Math.max(from, Math.floor(lineEnd || from + 400)));
    const seg = all.slice(from - 1, to).join('\n');
    const clipped = seg.length > MAX_READ_CHARS ? seg.slice(0, MAX_READ_CHARS) : seg;
    return {
      ok: true, path: filePath, total_lines: all.length,
      content: `${clipped}\n（${filePath} 第 ${from}-${from + clipped.split('\n').length - 1} 行，共 ${all.length} 行${clipped.length < seg.length ? '，本段也被截——用 line_end 缩小范围' : to < all.length ? `，续读用 {"path":"${filePath}","line_start":${to + 1}}` : '，已到文件尾'}）`,
      truncated: to < all.length || clipped.length < seg.length,
    };
  }
  if (stat.size > MAX_FILE_BYTES) {
    // 大文件不再是死路：仍给开头预算内的内容 + 指引（旧行为直接报错逼模型盲改）
    const head = fs.readFileSync(target, 'utf-8').slice(0, MAX_READ_CHARS);
    const headLines = head.split('\n').length;
    return { ok: true, path: filePath, content: `${head}\n…(文件共 ${stat.size} 字节，仅注入前 ${MAX_READ_CHARS} 字符；用 grep 定位行号后按行范围续读：{"path":"${filePath}","line_start":${headLines + 1},"line_end":${headLines * 2}}，或用 edits 做精确替换)`, truncated: true };
  }
  const text = fs.readFileSync(target, 'utf-8');
  if (text.length > MAX_READ_CHARS) {
    const cutLines = text.slice(0, MAX_READ_CHARS).split('\n').length;
    return { ok: true, path: filePath, total_lines: text.split('\n').length, content: `${text.slice(0, MAX_READ_CHARS)}\n…(文件共 ${text.length} 字符，已截断注入；续读：{"path":"${filePath}","line_start":${cutLines + 1}}，或先 grep 定位再按行范围读)`, truncated: true };
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

// ---------- check_page：headless 渲染验证（前端交付的"眼睛"） ----------
// 动机（jr3gdkxq 质检）：SPA 页面 JS 运行时崩溃时 curl 仍返回 200 + 正常 <title>，
// 命令级验证物理上看不见渲染缺陷——验证节点的天花板必须抬到"真实渲染文本"。
// 实现走系统 Chrome/Edge 的 --dump-dom（零新依赖），仅允许 localhost（dev server 场景，
// 兼防 SSRF/外联）。

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1', '0.0.0.0']);

export function findHeadlessBrowser(): string | null {
  const cands: string[] = [];
  if (process.env.COTEAM_BROWSER_PATH) cands.push(process.env.COTEAM_BROWSER_PATH);
  if (process.platform === 'win32') {
    const roots = [process.env['PROGRAMFILES'], process.env['PROGRAMFILES(X86)'], process.env['LOCALAPPDATA']]
      .filter((x): x is string => !!x);
    for (const root of roots) {
      cands.push(path.join(root, 'Google', 'Chrome', 'Application', 'chrome.exe'));
      cands.push(path.join(root, 'Microsoft', 'Edge', 'Application', 'msedge.exe'));
    }
  } else if (process.platform === 'darwin') {
    cands.push('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
    cands.push('/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge');
    cands.push('/Applications/Chromium.app/Contents/MacOS/Chromium');
  } else {
    cands.push('/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/microsoft-edge');
  }
  return cands.find((p) => { try { return fs.existsSync(p); } catch { return false; } }) || null;
}

function dumpDomWith(browser: string, url: string, headlessFlag: string, budgetMs: number, timeoutMs: number): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let killed = false;
    const proc = spawn(browser, [headlessFlag, '--disable-gpu', '--no-first-run', '--disable-extensions', `--virtual-time-budget=${budgetMs}`, '--dump-dom', url], { stdio: ['ignore', 'pipe', 'pipe'] });
    const timer = setTimeout(() => { killed = true; try { proc.kill(); } catch { /* gone */ } }, timeoutMs);
    proc.stdout?.on('data', (d: Buffer) => { stdout += d.toString(); });
    proc.stderr?.on('data', (d: Buffer) => { stderr += d.toString(); });
    proc.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code: killed ? -1 : (code ?? -1), stdout, stderr });
    });
    proc.on('error', (e) => {
      clearTimeout(timer);
      resolve({ code: -2, stdout: '', stderr: String(e?.message || e) });
    });
  });
}

export interface CheckPageResult {
  ok: boolean;
  url?: string;
  title?: string;
  /** 渲染后的可见文本（去 script/style/标签，压空白） */
  textLength?: number;
  textSample?: string;
  /** expect 里没出现在渲染结果中的片段 */
  missing?: string[];
  error?: string;
}

/**
 * headless 渲染 url 并返回可见文本；expect 中每个片段都必须出现在渲染结果里。
 * 仅允许 http(s)://localhost 系（开发服务器验证场景）。
 */
export async function checkPage(rawUrl: string, expect?: string[], timeoutSec = 60): Promise<CheckPageResult> {
  let u: URL;
  try { u = new URL(rawUrl); } catch { return { ok: false, error: `URL 无效: ${rawUrl}` }; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return { ok: false, error: '仅支持 http(s)' };
  if (!LOCAL_HOSTS.has(u.hostname)) return { ok: false, error: 'check_page 仅允许 localhost 地址（开发服务器验证）' };
  const browser = findHeadlessBrowser();
  if (!browser) return { ok: false, error: '未找到 Chrome/Edge（可设 COTEAM_BROWSER_PATH 指向浏览器可执行文件）' };
  const budgetMs = Math.min(20_000, Math.max(3_000, Math.floor(timeoutSec * 1000 / 3)));
  // Chrome 132+ 移除了旧 headless；老版本/Edge 可能不认 --headless=new——先新后旧各试一次
  let r = await dumpDomWith(browser, rawUrl, '--headless=new', budgetMs, timeoutSec * 1000);
  if (r.code !== 0 || !r.stdout.trim()) {
    const r2 = await dumpDomWith(browser, rawUrl, '--headless', budgetMs, timeoutSec * 1000);
    if (r2.stdout.trim()) r = r2;
  }
  if (!r.stdout.trim()) {
    return { ok: false, error: `渲染失败（exit ${r.code}）：${(r.stderr || '无输出').slice(-300)}` };
  }
  const dom = r.stdout;
  const title = /<title[^>]*>([^<]*)<\/title>/i.exec(dom)?.[1]?.trim() ?? '';
  const text = dom
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();
  const missing = (expect || []).map(String).filter((t) => t && !text.includes(t) && !dom.includes(t));
  return {
    ok: text.length > 0 && missing.length === 0,
    url: rawUrl,
    title,
    textLength: text.length,
    textSample: text.slice(0, 600),
    missing,
  };
}

/** Read-only tools the agent may request mid-conversation, plus write_knowledge for
 *  experience deposit, write_doc for SSOT collaboration docs and send_message for
 *  agent-to-agent deferred messaging (improvement #4 behavioral contract). */
export async function applyToolCalls(workspace: string, toolCalls: { tool: string; path?: string; pattern?: string; query?: string; title?: string; content?: string; tags?: string[]; category?: string; type?: string; to?: string; text?: string; name?: string; url?: string; expect?: string[]; line_start?: number; line_end?: number }[] | undefined, knowledgeCtx?: KnowledgeToolContext): Promise<unknown[]> {
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
      const ls = Number(call.line_start ?? (call as any).lineStart);
      const le = Number(call.line_end ?? (call as any).lineEnd);
      results.push({ tool: 'read_file', ...readFile(workspace, call.path || '', Number.isFinite(ls) && ls > 0 ? ls : undefined, Number.isFinite(le) && le > 0 ? le : undefined) });
    } else if (name === 'read_dir' || name === 'readdir') {
      results.push({ tool: 'read_dir', ...readDir(workspace, call.path || '') });
    } else if (name === 'grep' || name === 'search') {
      results.push({ tool: 'grep', ...grepFiles(workspace, call.pattern || call.query || '', call.path) });
    } else if (name === 'git_log') {
      results.push({ tool: 'git_log', ...gitLog(workspace) });
    } else if (name === 'git_diff') {
      results.push({ tool: 'git_diff', ...gitDiff(workspace) });
    } else if (name === 'check_page') {
      // 渲染级验证：前端交付的验收必须走它（curl 看不见 JS 崩溃）
      const url = String(call.url || call.path || '');
      const expect = Array.isArray(call.expect) ? call.expect.map(String) : (call.expect ? [String(call.expect)] : undefined);
      results.push({ tool: 'check_page', ...(await checkPage(url, expect)) });
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
