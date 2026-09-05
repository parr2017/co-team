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
  | 'waiting_approval';

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
  maxTokens: number;
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
