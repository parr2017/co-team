export type TaskStatus =
  | 'pending'
  | 'queued'
  | 'planned'
  | 'clarifying'
  | 'running'
  | 'completed'
  | 'failed'
  | 'retrying'
  | 'cancelled'
  | 'waiting_approval'
  /** node-level pre-execution clarification gate (实施前澄清) */
  | 'waiting_clarify';

/** Per-node pre-execution clarification gate (feature: 每步骤实施前澄清). */
export type ClarifyMode = 'off' | 'brief' | 'confirm';

export type Complexity = 'simple' | 'normal' | 'complex';

/** Task-level grading (improvement 7): matches the execution pipeline template. */
export type TaskLevel = 'light' | 'standard' | 'heavy';

/** Unified progress message format (improvement 6). */
export interface ProgressInfo {
  task_id: string;
  status: string;
  percent: number;
  completed: number;
  total: number;
  eta_sec?: number;
  current_nodes: { id: string; name: string; agent: string }[];
  message?: string;
  error?: string;
  updated_at: string;
}

export interface FileChange {
  path: string;
  content: string;
}

export interface ToolCall {
  tool: string;
  path?: string;
}

export interface TestFixReport {
  framework?: string;
  attempts: number;
  failures: { name: string; message?: string }[];
  summary: string;
}

/** P0-2: a problem the agent found but did not (or could not) fix in this node. */
export interface DefectReport {
  title: string;
  detail: string;
  severity?: 'low' | 'medium' | 'high';
}

export interface AgentResult {
  status: 'success' | 'failed';
  error?: string;
  changes?: string[];
  summary?: string;
  errors?: string[];
  files?: FileChange[];
  commands?: string[];
  tool_calls?: ToolCall[];
  escalated?: boolean;
  conflicts?: string[];
  tokens?: number;
  model?: string;
  merged?: string[];
  git_commit?: { branch: string; commit: string | null };
  command_results?: { command: string; returncode: number; stderr: string; stdout?: string }[];
  raw_output?: string;
  /** harness self-check: what was verified and how (output-contract requirement) */
  verification?: string;
  /** structured test-fix report (improvement 8 / R9) */
  report?: TestFixReport;
  /** SSOT docs this node updated via write_doc (improvement #4 behavioral contract) */
  doc_updates?: { type: string; version: number }[];
  /** P0-2: problems discovered but not fixed in this node — convertible to fix tasks */
  defects?: DefectReport[];
  /** P0-1 self-modification gate: the mandatory self-test run on self-referential tasks */
  gate_test?: { command: string; returncode: number; passed: boolean; summary?: string };
  /** quality metric: reported changes vs actual git working-tree changes */
  delivery_check?: { consistent: boolean; reported_count: number; actual_count: number; unreported: string[]; phantom: string[] };
}

export interface TaskNode {
  id: string;
  task_id: string;
  name: string;
  status: TaskStatus;
  agent: string;
  result: AgentResult | null;
  error: string;
  retry_count: number;
  complexity: Complexity;
  requires_approval: boolean;
  needs_human: boolean;
  reason?: string;
  /** one-line contribution of this node to the global goal (improvement 9) */
  goal_link?: string;
  branch?: string;
  /** the branch this node's branch was cut from — diff base for node changes */
  branch_base?: string;
  /** node-level model pin (feature: 每步骤可用不同 LLM); falls back to agent model_override, then pool selection */
  model_id?: string;
  /** pre-execution clarification gate for this node; unset → task-level / global default */
  clarify_mode?: ClarifyMode;
  started_at?: string;
  finished_at?: string;
  created_at: string;
  updated_at: string;
}

export interface ProjectInfo {
  id: string;
  name: string;
  workspace: string;
  description?: string;
  created_at: string;
}

export interface ProjectMemoryItem {
  text: string;
  ts: string;
  kind: 'auto' | 'manual';
  task_id?: string;
}

export interface TaskGraph {
  task_id: string;
  nodes: TaskNode[];
  edges: [string, string][];
  description: string;
  workspace: string;
  status: string;
  created_at: string;
  updated_at: string;
  project_id?: string;
  /** main agent (planner/routing) model pinned at creation time (improvement 11) */
  main_model_id?: string;
  /** task grading level (improvement 7) */
  level?: TaskLevel;
  /** task-level command execution policy overriding the global config (feature: 命令执行分级) */
  execution_policy?: { level: string; whitelist_commands?: string[] };
  /** task-level default for the per-node pre-execution clarification gate */
  node_clarify?: ClarifyMode;
  /** sandbox dir the task is (or was) executing in — powers the live output view (A1) */
  sandbox_path?: string;
  /** 自指任务（用 co-team 开发 co-team）：执行被隔离到 projects.selfdev_root 的本地克隆 */
  self_ref?: boolean;
  /** 隔离克隆的实际工作目录（execute 时写入；主副本零触碰） */
  selfdev_path?: string;
  /** P0-2 backlink: this task was created to fix a defect found in task_id/node_id */
  fix_for?: { task_id: string; node_id: string };
}

export interface EventEnvelope {
  type: string;
  ts: string;
  payload: Record<string, unknown>;
}

export interface ModelConfig {
  name: string;
  provider?: string;
  api_key: string;
  base_url: string;
  concurrency?: number;
  professional_weight?: number;
  priority?: number;
  tags?: string[];
  cost_per_1k?: number;
  /** 单次生成输出 token 上限（推理模型的思考 token 也计入）。属模型能力，不随 agent 配置 */
  max_tokens?: number;
  /** 模型上下文窗口（prompt 与输出共享），供上下文分级裁剪/扩容使用 */
  context_length?: number;
  /** optional capability roles: 'chat' (default) and/or 'embedding' (knowledge RAG) */
  roles?: string[];
}

export interface AgentConversationRound {
  assistant?: string;
  user?: string;
  tool_results?: unknown[] | null;
  parse_error?: string | null;
}

export interface AgentConversation {
  label: string;
  agent: string;
  model: string;
  node_name: string;
  started_at: string;
  system: string;
  rounds: AgentConversationRound[];
  tokens: number;
  error: string;
  duration_sec?: number;
}

export interface AgentInfo {
  name: string;
  role: string;
  description: string;
  tags: string[];
  modelOverride: string | null;
  timeout: number;
}

export interface FsEntry {
  name: string;
  path: string;
}

export const CHANNELS = {
  TASK: 'coteam:tasks',
  AGENT: 'coteam:agents',
  DASHBOARD: 'coteam:dashboard',
  NOTIFY: 'coteam:notify',
} as const;
