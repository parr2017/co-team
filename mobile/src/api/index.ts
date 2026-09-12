/**
 * Co-Team mobile API client — deliberately independent from web/src/api.
 * Backend src/types.ts is the conceptual SSOT; this is the mobile subset.
 * VITE_API_BASE enables standalone/app packaging later (defaults to same-origin).
 */

const BASE = import.meta.env.VITE_API_BASE ?? '';

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${BASE}${url}`, init);
  } catch {
    // phones (esp. iOS Safari) abort long fetches with "Load failed" / "Failed to fetch";
    // surface a readable message instead of the raw browser error
    throw new Error('网络连接失败或请求超时，请检查网络后重试');
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((body as any).detail || res.statusText || `请求失败(${res.status})`);
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
  | 'pending' | 'queued' | 'planned' | 'clarifying' | 'running' | 'completed' | 'success'
  | 'failed' | 'retrying' | 'cancelled' | 'waiting_approval' | 'waiting_clarify';

export interface TaskNode {
  id: string;
  name: string;
  status: TaskStatus;
  agent: string;
  error?: string;
  reason?: string;
  retry_count?: number;
  requires_approval?: boolean;
  result?: { summary?: string; changes?: string[]; verification?: string; report?: TestReport; model?: string; tokens?: number; defects?: DefectReport[] } | null;
  started_at?: string;
  finished_at?: string;
  branch?: string;
  /** 该节点分支的切出父分支——节点 diff 的计算基准 */
  branch_base?: string;
}

export interface NodeDiffResponse {
  node_id: string;
  branch: string;
  available: boolean;
  reason?: string;
  patch: string;
  files: { path: string; insertions: number; deletions: number }[];
}

export interface SkillMeta {
  name: string;
  description: string;
  tags: string[];
  source: string;
}

export interface DefectReport {
  title: string;
  detail: string;
  severity?: 'low' | 'medium' | 'high';
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
  kind: 'brief' | 'tool_results' | 'round' | 'final' | 'error' | 'intervene' | 'message' | 'doc' | 'ask' | 'answer';
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

// ---------- 群组沟通 / 知识库 ----------

export interface DiscussionMessage {
  id: string;
  /** 'user' | agent 名 | 'system' */
  from: string;
  text: string;
  ts: string;
  round?: number;
  mentioned?: string[];
  needs_user?: boolean;
  /** system 消息渲染形态：notice 轻灰提示 / card 居中卡片 */
  kind?: 'notice' | 'card';
  /** agent 工具活动行（🔧 折叠展示） */
  tool?: boolean;
  /** 用户消息引用的另一条消息 id */
  reply_to?: string;
  /** emoji 回应：emoji -> 回应者列表 */
  reactions?: Record<string, string[]>;
  /** M5.2 任务↔群聊互通：bridge_ask 卡片（task_id+ask_id）等结构化附加信息 */
  meta?: Record<string, any>;
}

/** 发用户消息：text 可空但需 react_to；reply_to 做引用回复 */
export interface PostDiscussionPayload {
  text?: string;
  reply_to?: string;
  react_to?: string;
  emoji?: string;
}

/** 群成员资料（署名拟人化：中文角色 + 稳定配色依据） */
export interface AgentInfo {
  name: string;
  role: string;
  description: string;
  tags: string[];
  modelOverride: string | null;
  timeout: number;
}

export interface Discussion {
  id: string;
  title: string;
  topic?: string;
  members: string[];
  mode: 'manual' | 'auto';
  status: 'discussing' | 'converged' | 'converted';
  scheme: string;
  scheme_version: number;
  project_id?: string;
  task_id?: string;
  created_at: string;
  updated_at: string;
  message_count?: number;
  pending_user?: boolean;
}

export interface DiscussionDetail extends Discussion {
  messages: DiscussionMessage[];
  /** 打开时是否有一轮在飞（UI 恢复 busy 状态用） */
  busy?: boolean;
}

export interface ConvertDiscussionPayload {
  target: 'new' | 'existing';
  name?: string;
  workspace?: string;
  scaffold?: boolean;
  project_id?: string;
  auto_run?: boolean;
}

export interface KnowledgeEntry {
  id: string;
  title: string;
  category: string;
  project_id?: string;
  tags: string[];
  source: string;
  created_at: string;
  updated_at: string;
  content: string;
}

export interface DeliverableDoc {
  node_id: string;
  node_name: string;
  agent: string;
  status: string;
  markdown: string;
  ts: string;
}

export interface ProjectProgressReport {
  project: { id: string; name: string; workspace: string };
  totals: {
    tasks: number; tasks_success: number; tasks_failed: number; tasks_running: number;
    nodes: number; nodes_completed: number; nodes_failed: number; retries: number;
    tokens: number; duration_sec: number; deliverables: number;
  };
  tasks: {
    task_id: string;
    description: string;
    status: string;
    level: string | null;
    tokens: number;
    duration_sec: number;
    nodes: {
      node_id: string; name: string; agent: string; status: string; retry_count: number;
      model: string | null; tokens: number; duration_sec: number;
      deliverable: { node_name: string; markdown: string; ts: string } | null;
    }[];
  }[];
}

// ---------- api ----------

/** normalize the list-item shape: the list endpoint returns `id`, the detail endpoint `task_id` */
function normalizeTask(raw: Record<string, any>): TaskGraph {
  return { ...raw, task_id: String(raw.task_id || raw.id || '') } as TaskGraph;
}

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

export const api = {
  queues: async (): Promise<QueueSnapshot[]> => {
    const d = await request<{ queues: QueueSnapshot[] }>('/api/queues');
    return d.queues;
  },
  resumeQueue: (key: string) => post<{ status: string; queue: QueueSnapshot }>(`/api/queues/${encodeURIComponent(key)}/resume`),
  clearQueue: (key: string) => post<{ status: string; queue: QueueSnapshot }>(`/api/queues/${encodeURIComponent(key)}/clear`),
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
  convertDefect: (taskId: string, nodeId: string, defectIndex: number, autoRun = false) =>
    post<{ status: string; fix_task_id: string; questions?: string[] }>(`/api/tasks/${taskId}/defects/convert`, { node_id: nodeId, defect_index: defectIndex, auto_run: autoRun }),
  cancelTask: (id: string) => post(`/api/tasks/${id}/cancel`),
  updateNode: (id: string, nodeId: string, patch: { name?: string; agent?: string; action?: 'delete' }): Promise<{ status: string }> =>
    request<{ status: string }>(`/api/tasks/${id}/nodes/${nodeId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    }),
  listAgents: async (): Promise<string[]> => {
    const d = await request<{ agents: { name: string }[] }>('/api/agents');
    return (d.agents || []).map((a) => a.name);
  },
  /** 群成员资料卡用：完整 agent 信息 */
  listAgentInfos: () => request<{ agents: AgentInfo[] }>('/api/agents'),
  executeTask: (id: string) => post(`/api/tasks/${id}/execute`),
  replan: (id: string, feedback: string) => post(`/api/tasks/${id}/replan`, { feedback }),
  interveneTask: (id: string, message: string) =>
    post<{ status: string; intervention_id: string; note: string }>(`/api/tasks/${id}/intervene`, { message }),
  // M2 全员实时问答：回答 agent 的阻塞式提问
  answerAsk: (id: string, askId: string, answer: string) =>
    post<{ ok: boolean; ask_id: string }>(`/api/tasks/${id}/asks/${askId}/answer`, { answer }),
  // M5 最终验收报告
  acceptanceReport: (id: string) => request<{ report: any }>(`/api/tasks/${id}/acceptance-report`),
  // M3 监督者提案
  listProposals: (id: string) =>
    request<{ proposals: any[] }>(`/api/tasks/${id}/proposals`),
  decideProposal: (id: string, proposalId: string, approved: boolean) =>
    post<{ ok: boolean; status: string }>(`/api/tasks/${id}/proposals/${proposalId}/decide`, { approved }),
  createTask: (payload: { description: string; workspace: string; level?: string; main_model_id?: string; project_id?: string; profile?: 'simple' | 'expert'; allow_self_ref?: boolean }) =>
    post<{ status: 'created' | 'needs_clarification' | 'pending'; task_id: string; questions?: string[]; summary?: string; graph?: TaskGraph }>('/api/tasks', payload.profile === 'simple'
      ? { ...payload, auto_run: true, plan_async: true, skip_clarification: true }
      : { ...payload, auto_run: false, plan_async: true }),
  clarifyTask: (id: string, payload: { answers?: { question: string; answer: string }[]; confirm?: boolean; text?: string }) =>
    post<{ status: string; questions?: string[]; graph?: TaskGraph }>(`/api/tasks/${id}/clarify`, { ...payload, plan_async: true }),
  agentProfiles: () => request<{ agents: Record<string, AgentProfileSummary> }>('/api/agents/profiles'),
  listSkills: () => request<{ skills: SkillMeta[]; bindings: Record<string, string[]> }>('/api/skills'),
  nodeDiff: (taskId: string, nodeId: string) => request<NodeDiffResponse>(`/api/tasks/${taskId}/nodes/${nodeId}/diff`),
  getModelPool: () => request<{ model_pool: ModelPoolItem[] }>('/api/config/model-pool'),
  fsList: (p: string) => request<FsListing>(`/api/fs?path=${encodeURIComponent(p)}`),
  listDeliverables: (taskId: string) => request<{ task_id: string; deliverables: DeliverableDoc[] }>(`/api/tasks/${taskId}/deliverables`),
  getDeliverable: (taskId: string, nodeId: string) => request<DeliverableDoc & { task_id: string }>(`/api/tasks/${taskId}/deliverables/${nodeId}`),
  // A3 验收合并闭环
  mergeTask: (taskId: string, dryRun: boolean, target?: string) =>
    post<{ ok: boolean; target: string; message: string; conflicts?: string[] }>(`/api/tasks/${taskId}/merge`, { dry_run: dryRun, target }),
  // A2 协同文档
  taskDocs: (taskId: string) =>
    request<{ task_id: string; docs: { type: string; path: string; version: number; updated_by: string; content: string }[] }>(`/api/tasks/${taskId}/docs`),
  // A1 实时产出视图
  taskOutput: (taskId: string) =>
    request<{ task_id: string; sandbox_path: string | null; available: boolean; files: string[] }>(`/api/tasks/${taskId}/output`),
  taskOutputFile: (taskId: string, path: string) =>
    request<{ path: string; content: string }>(`/api/tasks/${taskId}/output/file?path=${encodeURIComponent(path)}`),
  projectReport: (id: string) => request<ProjectProgressReport>(`/api/projects/${id}/report`),
  // ---------- projects ----------
  listProjects: () => request<{ projects: ProjectSummary[] }>('/api/projects'),
  getProject: (id: string) => request<ProjectDetail>(`/api/projects/${id}`),
  createProject: (payload: { name: string; workspace?: string; description?: string; scaffold?: boolean; allow_self_ref?: boolean }) =>
    post<{ status: string; project_id: string }>('/api/projects', payload),
  projectsRoot: () => request<{ root: string; selfdev_root: string }>('/api/projects/root'),
  listProjectTasks: async (projectId: string, page = 1, pageSize = 50): Promise<{ tasks: TaskGraph[]; total: number; page: number; pageSize: number }> => {
    const sp = new URLSearchParams({ page: String(page), pageSize: String(pageSize), project_id: projectId });
    const d = await request<{ tasks: Record<string, any>[]; total: number; page: number; pageSize: number }>(`/api/tasks?${sp}`);
    return { ...d, tasks: d.tasks.map(normalizeTask) };
  },
  // ---------- 群组沟通（与 web 端同名方法，服务端 discussion.ts 的镜像） ----------
  listDiscussions: () => request<{ discussions: Discussion[] }>('/api/discussions'),
  getDiscussion: (id: string) => request<DiscussionDetail>(`/api/discussions/${id}`),
  createDiscussion: (payload: { title: string; topic?: string; members: string[]; mode?: 'manual' | 'auto'; project_id?: string }) =>
    post<{ status: string; discussion: Discussion }>('/api/discussions', payload),
  updateDiscussion: (id: string, patch: { mode?: 'manual' | 'auto'; title?: string; scheme?: string }) =>
    request<{ status: string; discussion: Discussion }>(`/api/discussions/${id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch) }),
  deleteDiscussion: (id: string) => request(`/api/discussions/${id}`, { method: 'DELETE' }),
  postDiscussionMessage: (id: string, payload: PostDiscussionPayload) =>
    post<{ status: string; message: DiscussionMessage | null; queued?: boolean; responding: string[] | string | null }>(`/api/discussions/${id}/messages`, payload),
  discussionRound: (id: string) => post<{ status: string }>(`/api/discussions/${id}/round`),
  discussionStop: (id: string) => post<{ status: string }>(`/api/discussions/${id}/stop`),
  generateScheme: (id: string) => post<{ status: string; discussion: Discussion }>(`/api/discussions/${id}/scheme`),
  convertDiscussion: (id: string, payload: { target: 'new' | 'existing'; name?: string; workspace?: string; scaffold?: boolean; project_id?: string; auto_run?: boolean }) =>
    post<{ status: string; project_id: string; task_id: string }>(`/api/discussions/${id}/convert`, payload),
  listKnowledge: (params: { category?: string; project_id?: string; source?: string } = {}) => {
    const sp = new URLSearchParams();
    if (params.category) sp.set('category', params.category);
    if (params.project_id) sp.set('project_id', params.project_id);
    if (params.source) sp.set('source', params.source);
    return request<{ entries: KnowledgeEntry[] }>(`/api/knowledge?${sp}`);
  },
};

export function statusLabel(s: string): string {
  return ({
    planned: '待确认计划', clarifying: '需求需澄清', pending: '待执行', queued: '排队中', running: '执行中',
    completed: '已完成', success: '已完成', failed: '失败', waiting_approval: '待审批', waiting_clarify: '待澄清',
    retrying: '重试中', cancelled: '已取消',
  } as Record<string, string>)[s] || s;
}
