import * as fs from 'node:fs';
import * as path from 'node:path';
import * as yaml from 'js-yaml';
import type { ModelConfig } from './types';
import type { McpServerConfig } from './mcp/types';
import { DEFAULT_MCP_MAX_RESULT_CHARS, DEFAULT_MCP_TIMEOUT_SEC } from './mcp/types';

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
  /** M2 全员实时问答：阻塞式 ask 等待回答的超时秒数（缺省 900） */
  ask_timeout_sec?: number;
  /** 永续开发：infra 类失败的自动重排上限（缺省 3，超限锁车道转人工） */
  auto_requeue_max?: number;
  /** M3 监督者：事件驱动 + 周期心跳的有边界处置 */
  supervisor?: {
    enabled?: boolean;
    heartbeat_sec?: number;
    min_interval_sec?: number;
    /** 2.4 中程里程碑通知：每节点完成即推 notify（缺省关闭） */
    milestone_notify?: boolean;
  };
  /** M4 滚动规划：rolling（缺省）| static */
  planning_mode?: 'rolling' | 'static';
  /** M4 阶段数上限（缺省 5） */
  rolling_max_stages?: number;
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
  dashboard: { host: string; port: number; token?: string };
  model_pool: ModelConfig[];
  orchestrator: OrchestrationConfig;
  permissions: { level?: string; whitelist_commands?: string[]; max_time_sec?: number };
  redis: { host: string; port: number; db: number; password?: string };
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
  /** 群组讨论引擎 v2：组内工具执行策略（缺省=项目目录监狱内完全控制）、每触发轮数上限、全量背景注入预算、并行发言并发上限 */
  discussion?: {
    permissions?: { level?: string; whitelist_commands?: string[]; max_time_sec?: number };
    max_rounds?: number;
    project_context_char_cap?: number;
    /** 并行发言并发上限（P2-4）：同一批发言者并发执行的信号量宽度，超模型池容量自然排队 */
    parallel_speakers?: number;
  };
  /** 2026-09-09 超时语义重做：时长本身不判死——只有确定性死亡/静默超线/人工判定才是失败 */
  llm?: LlmTimeoutConfig;
  /** 上下文预算（缓存优先裁剪）：估算 prompt 超线触发一次性断崖折叠 */
  context?: ContextConfig;
  /** feishu bot (event subscription mode); secrets come from COTEAM_FEISHU_* env vars */
  feishu?: FeishuConfig;
  /** 外部 MCP server 接入（MCP client）；server 级配置，agent 可见性走 agent.yaml 的 mcp_servers */
  mcp?: { servers: McpServerConfig[] };
}

/** env/headers 等必须是 string→string 平对象；非法条目静默丢弃 */
function stringRecord(v: unknown): Record<string, string> | undefined {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return undefined;
  const out: Record<string, string> = {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    if (typeof k === 'string' && k && (typeof val === 'string' || typeof val === 'number' || typeof val === 'boolean')) {
      out[k] = String(val);
    }
  }
  return Object.keys(out).length ? out : undefined;
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
    dashboard: { host: raw.dashboard?.host ?? '127.0.0.1', port: raw.dashboard?.port ?? 8855, token: raw.dashboard?.token },
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
      // M2 全员实时问答：阻塞式 ask 等待回答的超时
      ask_timeout_sec: raw.orchestrator?.ask_timeout_sec ?? 900,
      // M3 监督者
      supervisor: {
        enabled: raw.orchestrator?.supervisor?.enabled ?? true,
        heartbeat_sec: raw.orchestrator?.supervisor?.heartbeat_sec ?? 600,
        min_interval_sec: raw.orchestrator?.supervisor?.min_interval_sec ?? 120,
        milestone_notify: raw.orchestrator?.supervisor?.milestone_notify ?? false,
      },
      // M4 滚动规划
      planning_mode: ['rolling', 'static'].includes(raw.orchestrator?.planning_mode) ? raw.orchestrator.planning_mode : 'rolling',
      rolling_max_stages: raw.orchestrator?.rolling_max_stages ?? 5,
      // 永续开发（2026-09-15）：infra 类失败的自动重排上限（超限才锁车道转人工）
      auto_requeue_max: raw.orchestrator?.auto_requeue_max ?? 3,
      self_mod_gate: {
        enabled: raw.orchestrator?.self_mod_gate?.enabled ?? true,
        test_command: raw.orchestrator?.self_mod_gate?.test_command || 'npm test',
        meta_paths: raw.orchestrator?.self_mod_gate?.meta_paths || DEFAULT_META_PATHS,
        timeout_sec: raw.orchestrator?.self_mod_gate?.timeout_sec ?? 600,
      },
    },
    // B9（2026-09-17）：permissions.level 非法值不再静默穿透——手改 config.yaml 写错时
    // 加载即拦截并告警，置空让 policyFromConfig 走唯一回退路径（有白名单 → whitelist_auto，
    // 否则 approve_required）。API 写路径（/api/config/permissions）已有 400 校验，此处补齐
    // 手改路径；合法值列表与 sandbox.ts PERMISSION_LEVELS 保持一致（内联防早期加载循环依赖）。
    permissions: (() => {
      const p: Record<string, unknown> = { ...(raw.permissions || {}) };
      const validLevels = ['plan_only', 'readonly', 'approve_required', 'whitelist_auto', 'full'];
      const lvl = String(p.level ?? '').trim();
      if (lvl && !validLevels.includes(lvl)) {
        console.warn(`[config] permissions.level "${lvl}" 不是合法值（可选：${validLevels.join(' | ')}）——已忽略该配置；实际生效级别由命令白名单决定（有白名单 → whitelist_auto，无 → approve_required），请修正 config.yaml`);
        delete p.level;
      }
      return p;
    })(),
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
    discussion: {
      permissions: raw.discussion?.permissions || undefined,
      max_rounds: raw.discussion?.max_rounds,
      project_context_char_cap: raw.discussion?.project_context_char_cap,
      parallel_speakers: raw.discussion?.parallel_speakers,
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
    mcp: parseMcpConfig(raw.mcp),
  };
}

/** mcp.servers 解析：宽松容错——非法条目丢弃不炸启动；名称归一小写（对齐工具名 lowerCase 纪律） */
function parseMcpConfig(raw: any): { servers: McpServerConfig[] } | undefined {
  const list = Array.isArray(raw?.servers) ? raw.servers : [];
  const servers: McpServerConfig[] = [];
  for (const s of list) {
    if (!s || typeof s !== 'object') continue;
    const name = typeof s.name === 'string' ? s.name.trim().toLowerCase() : '';
    if (!name || !/^[a-z0-9][a-z0-9_-]*$/.test(name)) continue;
    const type = s.type === 'http' ? 'http' : 'stdio';
    if (type === 'stdio' && typeof s.command !== 'string') continue;
    if (type === 'http' && typeof s.url !== 'string') continue;
    const env = stringRecord(s.env);
    const headers = stringRecord(s.headers);
    servers.push({
      name,
      type,
      enabled: s.enabled !== false,
      ...(typeof s.command === 'string' ? { command: s.command } : {}),
      ...(Array.isArray(s.args) ? { args: s.args.map((a: unknown) => String(a)) } : {}),
      ...(env ? { env } : {}),
      ...(typeof s.cwd === 'string' ? { cwd: s.cwd } : {}),
      ...(typeof s.url === 'string' ? { url: s.url } : {}),
      ...(headers ? { headers } : {}),
      max_result_chars: positiveOr(s.max_result_chars, DEFAULT_MCP_MAX_RESULT_CHARS),
      timeout_sec: positiveOr(s.timeout_sec, DEFAULT_MCP_TIMEOUT_SEC),
      ...(Array.isArray(s.allow_tools) ? { allow_tools: s.allow_tools.map((t: unknown) => String(t).toLowerCase()) } : {}),
    });
  }
  return servers.length ? { servers } : undefined;
}
