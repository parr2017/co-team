import * as fs from 'node:fs';
import * as path from 'node:path';
import * as yaml from 'js-yaml';
import { PROJECT_ROOT } from './config';
import type { ModelConfig } from './types';
import type { McpServerConfig } from './mcp/types';

function configPath(root: string = PROJECT_ROOT): string {
  return path.join(root, 'config', 'config.yaml');
}

function readRaw(root: string = PROJECT_ROOT): Record<string, any> {
  const p = configPath(root);
  if (!fs.existsSync(p)) return {};
  return (yaml.load(fs.readFileSync(p, 'utf-8')) as Record<string, any>) || {};
}

function writeRaw(raw: Record<string, any>, root: string = PROJECT_ROOT): void {
  fs.mkdirSync(path.dirname(configPath(root)), { recursive: true });
  fs.writeFileSync(configPath(root), yaml.dump(raw, { lineWidth: 120 }), 'utf-8');
}

export function saveModelPool(models: ModelConfig[], root: string = PROJECT_ROOT): void {
  const raw = readRaw(root);
  raw.model_pool = models;
  writeRaw(raw, root);
}

/** feature: 每日问题报告 — persist the UI toggle + report hour into config.yaml. */
export function saveDailyReport(cfg: { enabled: boolean; hour: number }, root: string = PROJECT_ROOT): void {
  const raw = readRaw(root);
  raw.daily_report = {
    enabled: cfg.enabled === true,
    hour: Math.min(23, Math.max(0, Math.floor(Number(cfg.hour) || 0))),
  };
  writeRaw(raw, root);
}

/** 包 D（2026-09-16）：全局命令权限（permissions 节）读写——设置界面替代手改 config.yaml */export function readPermissions(root: string = PROJECT_ROOT): { level: string; whitelist_commands: string[]; max_time_sec?: number } {
  const raw = readRaw(root);
  const p = (raw.permissions || {}) as Record<string, any>;
  return {
    level: typeof p.level === 'string' ? p.level : '',
    whitelist_commands: Array.isArray(p.whitelist_commands) ? p.whitelist_commands.map(String) : [],
    ...(typeof p.max_time_sec === 'number' ? { max_time_sec: p.max_time_sec } : {}),
  };
}

export function savePermissions(cfg: { level: string; whitelist_commands: string[]; max_time_sec?: number }, root: string = PROJECT_ROOT): void {
  const raw = readRaw(root);
  raw.permissions = {
    level: cfg.level,
    whitelist_commands: cfg.whitelist_commands,
    ...(cfg.max_time_sec !== undefined ? { max_time_sec: cfg.max_time_sec } : {}),
  };
  writeRaw(raw, root);
}

// ---------- 外部 MCP 服务（mcp 节）----------

/** 保存 MCP server 列表并热生效（UI 设置 → MCP服务）；空列表=移除整个 mcp 节 */
export function saveMcpServers(servers: McpServerConfig[], root: string = PROJECT_ROOT): void {
  const raw = readRaw(root);
  if (servers.length) raw.mcp = { servers };
  else delete raw.mcp;
  writeRaw(raw, root);
}

// ---------- agent file management ----------

const DEFAULT_PROMPT = (name: string, role: string) =>
  `# ${role || name} Agent\n\n你是${role || name} Agent，负责根据任务描述完成工作。\n\n## 最终输出格式（JSON，不要 markdown 代码块）\n\n{\n  "status": "success|failed",\n  "changes": ["file: 说明"],\n  "summary": "摘要",\n  "errors": [],\n  "files": [{"path": "相对路径", "content": "完整内容"}],\n  "commands": []\n}\n`;

const DEFAULT_HANDLER = `function preRun(task) {
  return task;
}

function postRun(result) {
  return result;
}

module.exports = { preRun, postRun };
`;

function sanitizeName(name: string): string {
  const clean = name.trim().toLowerCase().replace(/[^a-z0-9_-]/g, '');
  if (!clean) throw new Error('agent name must contain [a-z0-9_-]');
  return clean;
}

export function listAgentDirs(agentsDir: string): string[] {
  if (!fs.existsSync(agentsDir)) return [];
  return fs
    .readdirSync(agentsDir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && fs.existsSync(path.join(agentsDir, d.name, 'agent.yaml')))
    .map((d) => d.name);
}

export function readAgentDefinition(agentsDir: string, dirName: string) {
  const dir = path.join(agentsDir, dirName);
  const cfg = (yaml.load(fs.readFileSync(path.join(dir, 'agent.yaml'), 'utf-8')) as Record<string, any>) || {};
  const promptFile = path.join(dir, 'prompt.md');
  return {
    name: cfg.name || dirName,
    dir: dirName,
    role: cfg.role || '',
    description: cfg.description || '',
    tags: cfg.tags || [],
    model_override: cfg.model_override ?? null,
    timeout: cfg.timeout ?? 300,
    version: cfg.version || '1.0.0',
    skills: Array.isArray(cfg.skills) ? cfg.skills.map(String) : [],
    mcp_servers: Array.isArray(cfg.mcp_servers) ? cfg.mcp_servers.map(String) : [],
    prompt: fs.existsSync(promptFile) ? fs.readFileSync(promptFile, 'utf-8') : '',
  };
}

export function writeAgentDefinition(
  agentsDir: string,
  originalDir: string | null,
  def: {
    name: string;
    role?: string;
    description?: string;
    tags?: string[];
    model_override?: string | null;
    max_tokens?: number;
    timeout?: number;
    prompt?: string;
    skills?: string[];
    /** 绑定的外部 MCP server 白名单（agent.yaml mcp_servers） */
    mcp_servers?: string[];
  }
): string {
  const dirName = sanitizeName(def.name);
  const targetDir = path.join(agentsDir, dirName);
  if (originalDir && originalDir !== dirName) {
    const src = path.join(agentsDir, originalDir);
    if (fs.existsSync(src)) fs.renameSync(src, targetDir);
  } else {
    fs.mkdirSync(targetDir, { recursive: true });
  }
  const cfg: Record<string, any> = {
    name: dirName,
    role: def.role ?? '',
    version: '1.0.0',
    description: def.description ?? '',
    tags: def.tags ?? [],
    model_override: def.model_override ?? null,
    timeout: def.timeout ?? 300,
    skills: def.skills ?? [],
    mcp_servers: (def.mcp_servers ?? []).map((s) => String(s).toLowerCase()),
  };
  fs.writeFileSync(path.join(targetDir, 'agent.yaml'), yaml.dump(cfg), 'utf-8');
  const promptFile = path.join(targetDir, 'prompt.md');
  if (def.prompt !== undefined) fs.writeFileSync(promptFile, def.prompt, 'utf-8');
  else if (!fs.existsSync(promptFile)) fs.writeFileSync(promptFile, DEFAULT_PROMPT(dirName, cfg.role), 'utf-8');
  const handlerFile = path.join(targetDir, 'handler.js');
  if (!fs.existsSync(handlerFile)) fs.writeFileSync(handlerFile, DEFAULT_HANDLER, 'utf-8');
  return dirName;
}

export function deleteAgent(agentsDir: string, dirName: string): void {
  const dir = path.join(agentsDir, sanitizeName(dirName));
  if (!fs.existsSync(dir)) throw new Error(`agent not found: ${dirName}`);
  fs.rmSync(dir, { recursive: true, force: true });
}
