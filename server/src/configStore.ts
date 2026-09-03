import * as fs from 'node:fs';
import * as path from 'node:path';
import * as yaml from 'js-yaml';
import { PROJECT_ROOT } from './config';
import type { ModelConfig } from './types';

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
    max_tokens: cfg.max_tokens ?? 8192,
    timeout: cfg.timeout ?? 300,
    version: cfg.version || '1.0.0',
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
    max_tokens: def.max_tokens ?? 8192,
    timeout: def.timeout ?? 300,
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
