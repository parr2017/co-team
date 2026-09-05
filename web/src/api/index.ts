// Shared API client + types mirroring the server contract.

export type TaskStatus = 'pending' | 'queued' | 'planned' | 'clarifying' | 'running' | 'completed' | 'failed' | 'retrying' | 'cancelled' | 'waiting_approval';

export type TaskLevel = 'light' | 'standard' | 'heavy';

export interface QueueEntry {
  task_id: string;
  workspace: string;
  enqueued_at: string;
}

export interface QueueSnapshot {
  key: string;
  project_id: string | null;
  running_task_id: string | null;
  pending: QueueEntry[];
  blocked: boolean;
  blocked_reason: string;
  blocked_by: string | null;
}

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

export interface ClarifyAnswer {
  question: string;
  answer: string;
}

export interface KnowledgeEntry {
  id: string;
  title: string;
  category: 'general-tech' | 'project';
  project_id?: string;
  tags: string[];
  source: string;
  created_at: string;
  updated_at: string;
  updated_by?: string;
  content: string;
  /** hybrid search relevance (keyword + embedding cosine), present on q= results */
  score?: number;
  age_days?: number;
}

export interface SnapshotMeta {
  id: string;
  task_id: string;
  tag: string;
  workspace: string;
  git_ref: string | null;
  branch: string | null;
  kv_keys: string[];
  created_at: string;
  note?: string;
}

export interface NodeDeliverableRef {
  node_name: string;
  markdown: string;
  ts: string;
}

export interface NodeRecordRow {
  node_id: string;
  name: string;
  agent: string;
  status: string;
  retry_count: number;
  model: string | null;
  tokens: number;
  duration_sec: number;
  deliverable: NodeDeliverableRef | null;
}

export interface TaskRecordRow {
  task_id: string;
  description: string;
  status: string;
  level: string | null;
  tokens: number;
  duration_sec: number;
  nodes: NodeRecordRow[];
}

export interface ProjectProgressReport {
  project: { id: string; name: string; workspace: string };
  totals: {
    tasks: number; tasks_success: number; tasks_failed: number; tasks_running: number;
    nodes: number; nodes_completed: number; nodes_failed: number; retries: number;
    tokens: number; duration_sec: number; deliverables: number;
  };
  tasks: TaskRecordRow[];
}

export interface DeliverableDoc {
  node_id: string;
  node_name: string;
  agent: string;
  status: string;
  markdown: string;
  defects?: DefectReport[];
  ts: string;
}

export interface TestFixReport {
  framework?: string;
  attempts: number;
  failures: { name: string; message?: string }[];
  summary: string;
}

export interface DefectReport {
  title: string;
  detail: string;
  severity?: 'low' | 'medium' | 'high';
}

export interface AgentResult {
  status?: 'success' | 'failed';
  error?: string;
  changes?: string[];
  summary?: string;
  errors?: string[];
  escalated?: boolean;
  report?: TestFixReport;
  defects?: DefectReport[];
  gate_test?: { command: string; returncode: number; passed: boolean; summary?: string };
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
  complexity: string;
  requires_approval: boolean;
  needs_human: boolean;
  reason?: string;
  branch?: string;
  started_at?: string;
  finished_at?: string;
  created_at: string;
  updated_at: string;
}

export interface TaskEvent {
  type: string;
  ts: string;
  payload: Record<string, any>;
}

export interface TaskGraph {
  task_id: string;
  nodes: TaskNode[];
  edges: [string, string][];
  description: string;
  workspace: string;
  status: string;
  project_id?: string | null;
  level?: TaskLevel | null;
  main_model_id?: string | null;
  created_at: string;
  updated_at: string;
  git_commit?: { branch: string; commit: string | null };
  merged_branches?: string[];
  fix_for?: { task_id: string; node_id: string };
}

export interface QualitySummary {
  fix_loop_nodes: number;
  fix_rounds_avg: number;
  fix_rounds_max: number;
  test_reported_nodes: number;
  test_pass_rate: number;
  defects_total: number;
  defects_converted: number;
  defects_closed: number;
  defect_close_rate: number;
  delivery_checked_nodes: number;
  delivery_consistent_rate: number;
}

export interface TrendPoint {
  date: string;
  tasks: number;
  success_rate: number;
  fix_rounds_total: number;
  defects_total: number;
  defects_fixed: number;
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

export interface ConversationRound {
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
  rounds: ConversationRound[];
  tokens: number;
  error: string;
  duration_sec?: number;
}

export interface ModelStatus {
  concurrency: number;
  active: number;
  available: number;
  priority: number;
  tags: string[];
  healthy: boolean;
  cost_per_1k: number;
}

export interface StatusResponse {
  status: string;
  time: string;
  model_pool: Record<string, ModelStatus>;
  agents_dir: string;
  tokens_total: number;
  cost_total: number;
}

export interface MetricsResponse {
  tasks: { total: number; success: number; success_rate: number };
  agents: Record<string, { tasks: number; completed: number; failed: number; retries: number; tokens: number }>;
  quality?: QualitySummary;
  token_usage: Record<string, { prompt_tokens: number; completion_tokens: number; calls: number; cost: number }>;
  tokens_total: number;
  cost_total: number;
}

export interface ModelConfig {
  name: string;
  provider?: string;
  api_key: string;
  base_url: string;
  concurrency?: number;
  priority?: number;
  professional_weight?: number;
  cost_per_1k?: number;
  tags?: string[];
}

export interface AgentDefinition {
  name: string;
  dir: string;
  role: string;
  description: string;
  tags: string[];
  model_override: string | null;
  max_tokens: number;
  timeout: number;
  version: string;
  prompt: string;
  skills?: string[];
}

export interface ProjectMemoryItem {
  text: string;
  ts: string;
  kind: 'auto' | 'manual';
  task_id?: string;
}

export interface JournalEntry {
  role: 'master' | 'agent';
  kind: 'brief' | 'tool_results' | 'round' | 'final' | 'error' | 'intervene' | 'deliverable';
  text: string;
  ts: string;
  node_id: string;
  node_name: string;
  model?: string;
  tokens?: number;
  meta?: Record<string, any>;
}

export interface AgentProfileInfo {
  name: string;
  role: string;
  description: string;
  tags: string[];
  version: string;
  timeout: number;
  memory?: string[];
  profile: {
    name: string;
    tasks: { task_id: string; description: string; node: string; status: string; ts: string; tokens?: number; model?: string }[];
    stats: { total: number; success: number; failed: number; tokens: number };
    last_model?: string;
    last_active?: string;
  };
}

export interface ProjectSummary {
  id: string;
  name: string;
  workspace: string;
  description?: string;
  created_at: string;
  task_count: number;
  done_count: number;
  running: boolean;
  issues: number;
  updated_at: string;
}

export interface ProjectDetail extends ProjectSummary {
  memory: ProjectMemoryItem[];
  tasks: TaskGraph[];
}

export interface FsListing {
  path: string;
  parent: string | null;
  dirs: { name: string; path: string }[];
  shortcuts: { name: string; path: string }[];
}

export interface EventEnvelope {
  type: string;
  ts: string;
  payload: Record<string, any>;
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((body as any).detail || res.statusText);
  return body as T;
}

export interface SkillMeta {
  name: string;
  description: string;
  tags: string[];
  source: string;
  body?: string;
}

export const api = {
  createTask: (description: string, workspace: string, autoRun = true, projectId?: string, opts?: { mainModelId?: string; level?: string }) =>
    request<{ task_id: string; status?: string; questions?: string[]; summary?: string; level?: string; graph?: TaskGraph }>('/api/tasks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ description, workspace, auto_run: autoRun, project_id: projectId, main_model_id: opts?.mainModelId, level: opts?.level }),
    }),
  clarifyTask: (id: string, payload: { answers?: ClarifyAnswer[]; confirm?: boolean; text?: string }) =>
    request<{ status: string; questions?: string[]; graph?: TaskGraph }>(`/api/tasks/${id}/clarify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }),
  setTaskModel: (id: string, modelId: string) =>
    request(`/api/tasks/${id}/model`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model_id: modelId }) }),
  getTaskGoal: (id: string) => request<{ task_id: string; content: string; updated_at?: string; updated_by?: string }>(`/api/tasks/${id}/goal`),
  updateTaskGoal: (id: string, content: string) =>
    request(`/api/tasks/${id}/goal`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content }) }),
  taskProgress: (id: string) => request<ProgressInfo>(`/api/tasks/${id}/progress`),
  listKnowledge: (params: { category?: string; project_id?: string; q?: string; limit?: number } = {}) => {
    const sp = new URLSearchParams();
    if (params.category) sp.set('category', params.category);
    if (params.project_id) sp.set('project_id', params.project_id);
    if (params.q) sp.set('q', params.q);
    if (params.limit) sp.set('limit', String(params.limit));
    return request<{ entries: KnowledgeEntry[] }>(`/api/knowledge?${sp}`);
  },
  createKnowledge: (payload: { title: string; content: string; category?: string; project_id?: string; tags?: string[] }) =>
    request<{ status: string; id: string }>('/api/knowledge', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }),
  updateKnowledge: (id: string, payload: { title?: string; content?: string; tags?: string[] }) =>
    request<{ status: string; entry: KnowledgeEntry }>(`/api/knowledge/${id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }),
  deleteKnowledge: (id: string) => request(`/api/knowledge/${id}`, { method: 'DELETE' }),
  listSnapshots: (taskId?: string) =>
    request<{ snapshots: SnapshotMeta[] }>(`/api/snapshots${taskId ? `?task_id=${encodeURIComponent(taskId)}` : ''}`),
  createSnapshot: (taskId: string, tag = 'manual', note?: string) =>
    request<{ status: string; snapshot: SnapshotMeta }>('/api/snapshots', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ task_id: taskId, tag, note }) }),
  rollbackSnapshot: (id: string) =>
    request<{ ok: boolean; git_action: string; kv_restored: number; details: string[] }>(`/api/snapshots/${id}/rollback`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ confirm: true }) }),
  listTasks: (page = 1, pageSize = 20, filter?: { scope?: 'external'; projectId?: string; q?: string }) => {
    const params = new URLSearchParams({ page: String(page), pageSize: String(pageSize) });
    if (filter?.scope) params.set('scope', filter.scope);
    if (filter?.projectId) params.set('project_id', filter.projectId);
    if (filter?.q) params.set('q', filter.q);
    return request<{ tasks: TaskGraph[]; total: number; page: number; pageSize: number }>(`/api/tasks?${params}`);
  },
  getTask: (id: string) => request<TaskGraph>(`/api/tasks/${id}`),
  deleteTask: (id: string) => request(`/api/tasks/${id}`, { method: 'DELETE' }),
  cancelTask: (id: string) => request(`/api/tasks/${id}/cancel`, { method: 'POST' }),
  executeTask: (id: string) => request(`/api/tasks/${id}/execute`, { method: 'POST' }),
  queues: () => request<{ queues: QueueSnapshot[] }>('/api/queues'),
  resumeQueue: (key: string) =>
    request<{ status: string; queue: QueueSnapshot }>(`/api/queues/${encodeURIComponent(key)}/resume`, { method: 'POST' }),
  clearQueue: (key: string) =>
    request<{ status: string; queue: QueueSnapshot }>(`/api/queues/${encodeURIComponent(key)}/clear`, { method: 'POST' }),
  taskEvents: (id: string) => request<{ task_id: string; events: TaskEvent[] }>(`/api/tasks/${id}/events`),
  replan: (id: string, feedback: string) =>
    request<{ summary: string }>(`/api/tasks/${id}/replan`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ feedback }) }),
  updateNode: (taskId: string, nodeId: string, patch: { name?: string; agent?: string; action?: 'delete' }) =>
    request(`/api/tasks/${taskId}/nodes/${nodeId}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch) }),
  roadmap: () => request<{ content: string; updated_at: string }>('/api/system/roadmap'),
  createProject: (name: string, workspace: string, description?: string, scaffold = false) =>
    request<{ project_id: string; scaffold?: { dirs: string[]; files: string[]; git_initialized: boolean } | null }>('/api/projects', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, workspace, description, scaffold }) }),
  listProjects: () => request<{ projects: ProjectSummary[] }>('/api/projects'),
  getProject: (id: string) => request<ProjectDetail & { id: string }>(`/api/projects/${id}`),
  addProjectMemory: (id: string, text: string) =>
    request(`/api/projects/${id}/memory`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }) }),
  taskJournals: (id: string) => request<{ task_id: string; journals: Record<string, JournalEntry[]> }>(`/api/tasks/${id}/journals`),
  agentProfiles: () => request<{ agents: Record<string, AgentProfileInfo> }>('/api/agents/profiles'),
  approveNode: (taskId: string, nodeId: string) => request(`/api/tasks/${taskId}/approve/${nodeId}`, { method: 'POST' }),
  convertDefect: (taskId: string, nodeId: string, defectIndex: number, autoRun = false) =>
    request<{ status: string; fix_task_id: string; fix_for: { task_id: string; node_id: string }; questions: string[] }>(`/api/tasks/${taskId}/defects/convert`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ node_id: nodeId, defect_index: defectIndex, auto_run: autoRun }),
    }),
  metricsTrend: (days = 14) => request<{ days: number; trend: TrendPoint[] }>(`/api/metrics/trend?days=${days}`),
  listDeliverables: (taskId: string) => request<{ task_id: string; deliverables: DeliverableDoc[] }>(`/api/tasks/${taskId}/deliverables`),
  getDeliverable: (taskId: string, nodeId: string) => request<DeliverableDoc & { task_id: string }>(`/api/tasks/${taskId}/deliverables/${nodeId}`),
  projectReport: (id: string) => request<ProjectProgressReport>(`/api/projects/${id}/report`),
  listSkills: () => request<{ skills: SkillMeta[]; bindings: Record<string, string[]> }>('/api/skills'),
  createSkill: (payload: { name: string; description?: string; tags?: string[]; content?: string }) =>
    request<{ status: string; total: number }>('/api/skills', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }),
  updateSkill: (name: string, payload: { name?: string; description?: string; tags?: string[]; content?: string }) =>
    request<{ status: string }>(`/api/skills/${name}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }),
  deleteSkill: (name: string) => request(`/api/skills/${name}`, { method: 'DELETE' }),
  reloadSkills: () => request<{ status: string; total: number }>('/api/skills/reload', { method: 'POST' }),
  interveneTask: (taskId: string, message: string) =>
    request<{ status: string; intervention_id: string; note: string }>(`/api/tasks/${taskId}/intervene`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message }),
    }),
  taskLogs: (id: string) => request<{ task_id: string; logs: Record<string, AgentConversation[]> }>(`/api/tasks/${id}/logs`),
  listAgents: () => request<{ agents: AgentInfo[] }>('/api/agents'),
  agentDefinitions: () => request<{ agents: AgentDefinition[] }>('/api/agents/definitions'),
  createAgent: (def: Partial<AgentDefinition>) =>
    request('/api/agents', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(def) }),
  updateAgent: (dirName: string, def: Partial<AgentDefinition>) =>
    request(`/api/agents/${dirName}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(def) }),
  deleteAgent: (dirName: string) => request(`/api/agents/${dirName}`, { method: 'DELETE' }),
  getModelPool: () => request<{ model_pool: ModelConfig[] }>('/api/config/model-pool'),
  saveModelPool: (model_pool: ModelConfig[]) =>
    request('/api/config/model-pool', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model_pool }) }),
  testModel: (model: ModelConfig) =>
    request<{ ok: boolean; latency_ms: number; response_preview?: string; error?: string }>(
      '/api/config/model-pool/test',
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(model) }
    ),
  reloadAgents: () => request('/api/agents/reload', { method: 'POST' }),
  status: () => request<StatusResponse>('/api/status'),
  metrics: () => request<MetricsResponse>('/api/metrics'),
  fsList: (path: string) => request<FsListing>(`/api/fs?path=${encodeURIComponent(path)}`),
};
