/**
 * Co-Team mobile API client — deliberately independent from web/src/api.
 * Backend src/types.ts is the conceptual SSOT; this is the mobile subset.
 * VITE_API_BASE enables standalone/app packaging later (defaults to same-origin).
 */

const BASE = import.meta.env.VITE_API_BASE ?? '';

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${url}`, init);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((body as any).detail || res.statusText);
  return body as T;
}

function post<T>(url: string, payload?: unknown): Promise<T> {
  return request<T>(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: payload === undefined ? undefined : JSON.stringify(payload),
  });
}

// ---------- types (mobile subset) ----------

export type TaskStatus =
  | 'pending' | 'planned' | 'clarifying' | 'running' | 'completed' | 'success'
  | 'failed' | 'retrying' | 'cancelled' | 'waiting_approval';

export interface TaskNode {
  id: string;
  name: string;
  status: TaskStatus;
  agent: string;
  error?: string;
  reason?: string;
  retry_count?: number;
  requires_approval?: boolean;
  result?: { summary?: string; changes?: string[]; report?: TestReport } | null;
  started_at?: string;
  finished_at?: string;
  branch?: string;
}

export interface TestReport {
  framework?: string;
  attempts?: number;
  failures?: { name: string; message?: string }[];
  summary?: string;
}

export interface TaskGraph {
  task_id: string;
  description: string;
  workspace?: string;
  status: TaskStatus;
  project_id?: string | null;
  level?: string | null;
  main_model_id?: string | null;
  nodes: TaskNode[];
  edges: [string, string][];
  created_at?: string;
  updated_at?: string;
}

export interface ProgressInfo {
  task_id: string;
  status: string;
  percent: number;
  completed: number;
  total: number;
  eta_sec?: number;
  current_nodes: { id: string; name: string; agent: string }[];
}

export interface JournalEntry {
  role: 'master' | 'agent';
  kind: 'brief' | 'tool_results' | 'round' | 'final' | 'error' | 'intervene';
  text: string;
  ts: string;
  node_id: string;
  node_name: string;
  model?: string;
  tokens?: number;
  meta?: Record<string, any>;
}

export interface EventEnvelope {
  type: string;
  ts?: string;
  payload: Record<string, any>;
}

export interface AgentLiveState {
  name: string;
  status?: string;
  model?: string;
  currentAction?: string;
  currentTask?: string;
  tokens?: number;
}

export interface ModelPoolItem { name: string; }

export interface FsListing {
  path: string;
  parent: string | null;
  dirs: { name: string; path: string }[];
  shortcuts: { name: string; path: string }[];
}

export interface AgentProfileSummary {
  name: string;
  role: string;
  description: string;
  profile: {
    stats: { total: number; success: number; failed: number; tokens: number };
    tasks: { task_id: string; node: string; status: string; ts: string }[];
  };
  memory?: string[];
  last_model?: string;
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
  updated_at?: string;
}

export interface ProjectDetail extends ProjectSummary {
  tasks: TaskGraph[];
  memory: { text: string; ts: string; kind: string }[];
}

// ---------- api ----------

/** normalize the list-item shape: the list endpoint returns `id`, the detail endpoint `task_id` */
function normalizeTask(raw: Record<string, any>): TaskGraph {
  return { ...raw, task_id: String(raw.task_id || raw.id || '') } as TaskGraph;
}

export const api = {
  listTasks: async (page = 1, pageSize = 20, q?: string): Promise<{ tasks: TaskGraph[]; total: number; page: number; pageSize: number }> => {
    const sp = new URLSearchParams({ page: String(page), pageSize: String(pageSize) });
    if (q?.trim()) sp.set('q', q.trim());
    const d = await request<{ tasks: Record<string, any>[]; total: number; page: number; pageSize: number }>(`/api/tasks?${sp}`);
    return { ...d, tasks: d.tasks.map(normalizeTask) };
  },
  getTask: async (id: string): Promise<TaskGraph> => normalizeTask(await request<Record<string, any>>(`/api/tasks/${id}`)),
  taskProgress: (id: string) => request<ProgressInfo>(`/api/tasks/${id}/progress`),
  taskEvents: (id: string) => request<{ task_id: string; events: EventEnvelope[] }>(`/api/tasks/${id}/events`),
  taskJournals: (id: string) => request<{ task_id: string; journals: Record<string, JournalEntry[]> }>(`/api/tasks/${id}/journals`),
  approveNode: (taskId: string, nodeId: string) => post(`/api/tasks/${taskId}/approve/${nodeId}`),
  cancelTask: (id: string) => post(`/api/tasks/${id}/cancel`),
  executeTask: (id: string) => post(`/api/tasks/${id}/execute`),
  replan: (id: string, feedback: string) => post(`/api/tasks/${id}/replan`, { feedback }),
  interveneTask: (id: string, message: string) =>
    post<{ status: string; intervention_id: string; note: string }>(`/api/tasks/${id}/intervene`, { message }),
  createTask: (payload: { description: string; workspace: string; level?: string; main_model_id?: string; project_id?: string }) =>
    post<{ status: 'created' | 'needs_clarification'; task_id: string; questions?: string[]; summary?: string; graph?: TaskGraph }>('/api/tasks', { ...payload, auto_run: false }),
  clarifyTask: (id: string, payload: { answers?: { question: string; answer: string }[]; confirm?: boolean; text?: string }) =>
    post<{ status: string; questions?: string[]; graph?: TaskGraph }>(`/api/tasks/${id}/clarify`, payload),
  agentProfiles: () => request<{ agents: Record<string, AgentProfileSummary> }>('/api/agents/profiles'),
  getModelPool: () => request<{ model_pool: ModelPoolItem[] }>('/api/config/model-pool'),
  fsList: (p: string) => request<FsListing>(`/api/fs?path=${encodeURIComponent(p)}`),
  // ---------- projects ----------
  listProjects: () => request<{ projects: ProjectSummary[] }>('/api/projects'),
  getProject: (id: string) => request<ProjectDetail>(`/api/projects/${id}`),
  listProjectTasks: async (projectId: string, page = 1, pageSize = 50): Promise<{ tasks: TaskGraph[]; total: number; page: number; pageSize: number }> => {
    const sp = new URLSearchParams({ page: String(page), pageSize: String(pageSize), project_id: projectId });
    const d = await request<{ tasks: Record<string, any>[]; total: number; page: number; pageSize: number }>(`/api/tasks?${sp}`);
    return { ...d, tasks: d.tasks.map(normalizeTask) };
  },
};

export function statusLabel(s: string): string {
  return ({
    planned: '待确认计划', clarifying: '需求需澄清', pending: '待执行', running: '执行中',
    completed: '已完成', success: '已完成', failed: '失败', waiting_approval: '待审批',
    retrying: '重试中', cancelled: '已取消',
  } as Record<string, string>)[s] || s;
}
