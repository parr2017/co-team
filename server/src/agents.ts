import * as fs from 'node:fs';
import * as path from 'node:path';
import * as yaml from 'js-yaml';
import { createRequire } from 'node:module';
import type { AgentInfo, FileChange, ToolCall } from './types';
import type { AgentResult } from './types';

export interface AgentHandler {
  preRun?: (task: AgentTask) => AgentTask;
  postRun?: (result: AgentResult) => AgentResult;
}

export interface AgentTask {
  description: string;
  node_id: string;
  workspace: string;
  context: Record<string, unknown>;
}

export interface AgentPlugin extends AgentInfo {
  prompt: string;
  handler: AgentHandler;
  dir: string;
  version: string;
  /** explicitly bound skills from agent.yaml (`skills: [name, ...]`) — always injected */
  skills: string[];
}

export async function discoverAgents(agentsDir: string): Promise<AgentPlugin[]> {
  const plugins: AgentPlugin[] = [];
  if (!fs.existsSync(agentsDir)) return plugins;

  for (const dir of fs.readdirSync(agentsDir).sort()) {
    const agentDir = path.join(agentsDir, dir);
    const configFile = path.join(agentDir, 'agent.yaml');
    if (!fs.statSync(agentDir, { throwIfNoEntry: false })?.isDirectory() || !fs.existsSync(configFile)) continue;

    const cfg = yaml.load(fs.readFileSync(configFile, 'utf-8')) as any;
    const promptFile = path.join(agentDir, 'prompt.md');
    const prompt = fs.existsSync(promptFile) ? fs.readFileSync(promptFile, 'utf-8') : '';

    // handler hooks: prefer handler.js (CommonJS) next to agent.yaml
    let handler: AgentHandler = {};
    const handlerFile = path.join(agentDir, 'handler.js');
    if (fs.existsSync(handlerFile)) {
      try {
        const require_ = createRequire(__filename);
        const mod = require_(handlerFile);
        handler = { preRun: mod.preRun, postRun: mod.postRun };
      } catch (e) {
        console.warn(`[co-team] failed to load handler for agent ${dir}:`, e);
      }
    }

    plugins.push({
      name: cfg.name || dir,
      role: cfg.role || '',
      description: cfg.description || '',
      tags: cfg.tags || [],
      modelOverride: cfg.model_override ?? null,
      // timeout 语义（2026-09-09 重做）：节点级总时长预算（秒），超线转人工；
      // 不再是单次 LLM 调用绞杀线——缺省 1 小时以容纳本地慢模型
      timeout: cfg.timeout ?? 3600,
      prompt,
      handler,
      dir: agentDir,
      version: cfg.version || '0.0.0',
      skills: Array.isArray(cfg.skills) ? cfg.skills.map(String) : [],
    });
  }
  return plugins;
}

export function toAgentInfo(p: AgentPlugin): AgentInfo {
  return {
    name: p.name,
    role: p.role,
    description: p.description,
    tags: p.tags,
    modelOverride: p.modelOverride,
    timeout: p.timeout,
  };
}

export type { FileChange, ToolCall };
