export type TaskStatus =
  | 'pending'
  | 'planned'
  | 'running'
  | 'completed'
  | 'failed'
  | 'retrying'
  | 'cancelled'
  | 'waiting_approval';

export type Complexity = 'simple' | 'normal' | 'complex';

export interface FileChange {
  path: string;
  content: string;
}

export interface ToolCall {
  tool: string;
  path?: string;
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
  merged?: string[];
  git_commit?: { branch: string; commit: string | null };
  command_results?: { command: string; returncode: number; stderr: string }[];
  raw_output?: string;
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
  branch?: string;
  started_at?: string;
  finished_at?: string;
  created_at: string;
  updated_at: string;
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
