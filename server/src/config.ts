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
  /** improvement 5 (R5): hours before a 'clarifying' task gets a timeout reminder */
  clarify_timeout_hours?: number;
  /** feature: 降级策略优化 — seconds dispatch waits for model capacity before breaking the glass */
  model_wait_timeout_sec?: number;
  /** feature: 实施前澄清 — global default clarify gate: off | brief | confirm */
  node_clarify?: 'off' | 'brief' | 'confirm';
  /** P0-1 self-modification gate: self-referential tasks (workspace = co-team itself)
   *  must pass the repo's own test suite, and meta-facility edits need human approval */
  self_mod_gate?: SelfModGateConfig;
}

export interface SelfModGateConfig {
  enabled: boolean;
  test_command: string;
  /** path prefixes (repo-relative, /-separated) whose modification counts as meta-facility change */
  meta_paths: string[];
  timeout_sec?: number;
}

export const DEFAULT_META_PATHS = [
  'server/src/harness.ts',
  'server/src/skills.ts',
  'server/src/deliverable.ts',
  'server/src/orchestrator/',
  'skills/',
  'agents/',
];

export interface AppConfig {
  agents_dir: string;
  dashboard: { host: string; port: number };
  model_pool: ModelConfig[];
  orchestrator: OrchestrationConfig;
  permissions: { level?: string; whitelist_commands?: string[]; max_time_sec?: number };
  redis: { host: string; port: number; db: number };
  knowledge: {
    dir: string;
    /** RAG upgrade: model_pool entry name used for /v1/embeddings; unset/missing → keyword search only */
    embedding?: { enabled?: boolean; model?: string };
    /** governance: entries not updated for this many days are stale candidates */
    stale_days?: number;
  };
  /** custom grading keywords (improvement 7 / R6), appended to built-in rules */
  grading?: { heavy?: string[]; light?: string[] };
  /** 项目治理：所有项目拥有独立目录 + 独立 git 仓库，任务操作被限制在项目目录内 */
  projects?: {
    /** 项目根目录；新建项目缺省工作区 = <root>/<slug(name)> */
    root: string;
    /** 自指任务（用 co-team 开发 co-team）的隔离克隆根目录 = <selfdev_root>/<taskId> */
    selfdev_root: string;
  };
  /** feature: 每日问题报告 — disabled by default; only reports when explicitly enabled */
  daily_report?: { enabled: boolean; hour: number };
  /** 2026-09-09 超时语义重做：时长本身不判死——只有确定性死亡/静默超线/人工判定才是失败 */
  llm?: LlmTimeoutConfig;
  /** 上下文预算（缓存优先裁剪）：估算 prompt 超线触发一次性断崖折叠 */
  context?: ContextConfig;
  /** feishu bot (event subscription mode); secrets come from COTEAM_FEISHU_* env vars */
  feishu?: FeishuConfig;
}

export interface LlmTimeoutConfig {
  /** 发出请求→首个数据块的静默上限（秒），覆盖大 prompt prefill 阶段；0=关闭 */
  first_token_idle_sec: number;
  /** 流打开后两次数据块之间的静默上限（秒）；任意 chunk 刷新计时；0=关闭 */
  stream_idle_sec: number;
  /** 墙钟保险丝（秒），默认关闭——慢不是失败，仅防失控；0=关闭 */
  wallclock_cap_sec: number;
  /** 非流式请求的总上限（秒，无进度信号可用，只能用总时长兜底） */
  non_stream_timeout_sec: number;
  /** 单轮 LLM 调用超过该秒数但成功 → 记 slow（降权），不记失败 */
  slow_success_sec: number;
  /** 按节点复杂度的输出预算分档；置空对象 {} 可整体关闭（回退模型 max_tokens）。
   *  推理模型光思考就可能吃掉 2 万 token——预算过小会造成"思考耗尽正文为空"的
   *  假性失败（xfzrhwkc 实测 16000 对 Qwen3.6 不足），故 normal/complex 档放宽 */
  output_tiers: { simple: number; normal: number; complex: number };
}

export interface ContextConfig {
  /** prompt 估算超该 token 数触发一次确定性历史折叠（每尝试至多一次） */
  max_prompt_tokens: number;
  /** 工作区文件树注入的字符预算 */
  workspace_tree_max_chars: number;
  /** 全局目标注入的字符上限（超出截断并注明） */
  goal_max_chars: number;
}

export const DEFAULT_LLM_TIMEOUT: LlmTimeoutConfig = {
  first_token_idle_sec: 900,
  stream_idle_sec: 900,
  wallclock_cap_sec: 0,
  non_stream_timeout_sec: 900,
  slow_success_sec: 300,
  output_tiers: { simple: 8000, normal: 32000, complex: 64000 },
};

export const DEFAULT_CONTEXT: ContextConfig = {
  max_prompt_tokens: 16000,
  workspace_tree_max_chars: 1500,
  goal_max_chars: 1500,
};

export interface FeishuConfig {
  app_id?: string;
  app_secret?: string;
  verification_token?: string;
  encrypt_key?: string;
  /** open platform base url (override for tests) */
  api_base?: string;
}

export const PROJECT_ROOT = path.resolve(__dirname, '..', '..');

/** seconds config: undefined/negative → default; 0 → explicit "off" (kept) */
function pickSec(v: unknown, dflt: number): number {
  const n = Number(v);
  if (v === undefined || v === null || !Number.isFinite(n)) return dflt;
  return n < 0 ? dflt : n;
}
/** token/char budget: anything non-positive or non-finite → default */
function positiveOr(v: unknown, dflt: number): number {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : dflt;
}

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
      // improvement 5 (R5): tasks stuck in 'clarifying' longer than this get a one-shot reminder
      clarify_timeout_hours: raw.orchestrator?.clarify_timeout_hours ?? 24,
      // feature: 降级策略优化 — wait for capacity instead of failing the node instantly
      model_wait_timeout_sec: raw.orchestrator?.model_wait_timeout_sec ?? 120,
      // feature: 实施前澄清 — off by default; 'brief' | 'confirm' turn the gate on globally
      node_clarify: ['off', 'brief', 'confirm'].includes(raw.orchestrator?.node_clarify) ? raw.orchestrator.node_clarify : 'off',
      self_mod_gate: {
        enabled: raw.orchestrator?.self_mod_gate?.enabled ?? true,
        test_command: raw.orchestrator?.self_mod_gate?.test_command || 'npm test',
        meta_paths: raw.orchestrator?.self_mod_gate?.meta_paths || DEFAULT_META_PATHS,
        timeout_sec: raw.orchestrator?.self_mod_gate?.timeout_sec ?? 600,
      },
    },
    permissions: raw.permissions || {},
    redis: raw.redis || { host: '127.0.0.1', port: 6379, db: 0 },
    knowledge: {
      dir: path.isAbsolute(raw.knowledge?.dir || '') ? raw.knowledge.dir : path.join(root, raw.knowledge?.dir || 'data/knowledge'),
      embedding: raw.knowledge?.embedding
        ? { enabled: raw.knowledge.embedding.enabled ?? false, model: raw.knowledge.embedding.model }
        : undefined,
      stale_days: raw.knowledge?.stale_days ?? 90,
    },
    grading: raw.grading || undefined,
    // 项目治理：默认项目根 = co-team 仓库同级的 projects 目录（config.yaml 可覆盖）
    projects: {
      root: path.isAbsolute(raw.projects?.root || '') ? raw.projects.root : path.resolve(root, '..', raw.projects?.root || 'projects'),
      selfdev_root: path.isAbsolute(raw.projects?.selfdev_root || '')
        ? raw.projects.selfdev_root
        : path.join(path.isAbsolute(raw.projects?.root || '') ? raw.projects.root : path.resolve(root, '..', raw.projects?.root || 'projects'), 'co-team-selfdev'),
    },
    daily_report: {
      // feature: 每日问题报告 — 默认关闭，界面开关打开后才会触发
      enabled: raw.daily_report?.enabled === true,
      hour: Number.isFinite(raw.daily_report?.hour) ? Math.min(23, Math.max(0, Number(raw.daily_report.hour))) : 9,
    },
    llm: {
      // 2026-09-09 超时语义重做：秒数可带小数（便于测试调小阈值）；负数按缺省，0 为显式关闭
      first_token_idle_sec: pickSec(raw.llm?.first_token_idle_sec, DEFAULT_LLM_TIMEOUT.first_token_idle_sec),
      stream_idle_sec: pickSec(raw.llm?.stream_idle_sec, DEFAULT_LLM_TIMEOUT.stream_idle_sec),
      wallclock_cap_sec: pickSec(raw.llm?.wallclock_cap_sec, DEFAULT_LLM_TIMEOUT.wallclock_cap_sec),
      non_stream_timeout_sec: pickSec(raw.llm?.non_stream_timeout_sec, DEFAULT_LLM_TIMEOUT.non_stream_timeout_sec),
      slow_success_sec: pickSec(raw.llm?.slow_success_sec, DEFAULT_LLM_TIMEOUT.slow_success_sec),
      output_tiers: raw.llm?.output_tiers === undefined
        ? { ...DEFAULT_LLM_TIMEOUT.output_tiers }
        : {
            simple: positiveOr(raw.llm?.output_tiers?.simple, DEFAULT_LLM_TIMEOUT.output_tiers.simple),
            normal: positiveOr(raw.llm?.output_tiers?.normal, DEFAULT_LLM_TIMEOUT.output_tiers.normal),
            complex: positiveOr(raw.llm?.output_tiers?.complex, DEFAULT_LLM_TIMEOUT.output_tiers.complex),
          },
    },
    context: {
      max_prompt_tokens: positiveOr(raw.context?.max_prompt_tokens, DEFAULT_CONTEXT.max_prompt_tokens),
      workspace_tree_max_chars: positiveOr(raw.context?.workspace_tree_max_chars, DEFAULT_CONTEXT.workspace_tree_max_chars),
      goal_max_chars: positiveOr(raw.context?.goal_max_chars, DEFAULT_CONTEXT.goal_max_chars),
    },
    // secrets never live in config.yaml — environment variables win
    feishu: raw.feishu
      ? {
          ...raw.feishu,
          ...(process.env.COTEAM_FEISHU_APP_ID ? { app_id: process.env.COTEAM_FEISHU_APP_ID } : {}),
          ...(process.env.COTEAM_FEISHU_APP_SECRET ? { app_secret: process.env.COTEAM_FEISHU_APP_SECRET } : {}),
          ...(process.env.COTEAM_FEISHU_VERIFICATION_TOKEN ? { verification_token: process.env.COTEAM_FEISHU_VERIFICATION_TOKEN } : {}),
          ...(process.env.COTEAM_FEISHU_ENCRYPT_KEY ? { encrypt_key: process.env.COTEAM_FEISHU_ENCRYPT_KEY } : {}),
          ...(process.env.COTEAM_FEISHU_API_BASE ? { api_base: process.env.COTEAM_FEISHU_API_BASE } : {}),
        }
      : undefined,
  };
}
