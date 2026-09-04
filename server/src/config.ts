import * as fs from 'node:fs';
import * as path from 'node:path';
import * as yaml from 'js-yaml';
import type { ModelConfig } from './types';

export interface OrchestrationConfig {
  max_retries: number;
  model?: string;
  sandbox: boolean;
  git: boolean;
  branch_workflow: boolean;
  token_budget?: number;
  max_fix_rounds?: number;
}

export interface AppConfig {
  agents_dir: string;
  dashboard: { host: string; port: number };
  model_pool: ModelConfig[];
  orchestrator: OrchestrationConfig;
  permissions: { level?: string; whitelist_commands?: string[]; max_time_sec?: number };
  redis: { host: string; port: number; db: number };
  knowledge: { dir: string };
}

export const PROJECT_ROOT = path.resolve(__dirname, '..', '..');

export function loadConfig(root: string = PROJECT_ROOT): AppConfig {
  const configPath = path.join(root, 'config', 'config.yaml');
  let raw: any = {};
  if (fs.existsSync(configPath)) {
    raw = yaml.load(fs.readFileSync(configPath, 'utf-8')) || {};
  }
  const agentsDir = raw.agents_dir || './agents';
  return {
    agents_dir: path.isAbsolute(agentsDir) ? agentsDir : path.join(root, agentsDir),
    dashboard: { host: raw.dashboard?.host ?? '0.0.0.0', port: raw.dashboard?.port ?? 8855 },
    model_pool: raw.model_pool || [],
    orchestrator: {
      max_retries: raw.orchestrator?.max_retries ?? 3,
      model: raw.orchestrator?.model,
      sandbox: raw.orchestrator?.sandbox ?? true,
      git: raw.orchestrator?.git ?? true,
      branch_workflow: raw.orchestrator?.branch_workflow ?? true,
      token_budget: raw.orchestrator?.token_budget,
      max_fix_rounds: raw.orchestrator?.max_fix_rounds,
    },
    permissions: raw.permissions || {},
    redis: raw.redis || { host: '127.0.0.1', port: 6379, db: 0 },
    knowledge: { dir: path.isAbsolute(raw.knowledge?.dir || '') ? raw.knowledge.dir : path.join(root, raw.knowledge?.dir || 'data/knowledge') },
  };
}
