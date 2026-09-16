/**
 * Co-Team mobile API client — deliberately independent from web/src/api.
 * Backend src/types.ts is the conceptual SSOT; this is the mobile subset.
 * VITE_API_BASE enables standalone/app packaging later (defaults to same-origin).
 */

import { openTokenGate } from '../tokenGate';
import { statusText } from '../utils/events';

const BASE = import.meta.env.VITE_API_BASE ?? '';

// SEC-P0 API Token：localStorage 持久化；401 时清掉失效凭据并弹全局输入层（存后自动重试）
export function getApiToken(): string {
  return localStorage.getItem('coteam-api-token') || '';
}
export function setApiToken(token: string) {
  localStorage.setItem('coteam-api-token', token);
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const build = (): RequestInit => {
    const token = getApiToken();
    const headers = new Headers(init?.headers);
    if (token) headers.set('Authorization', `Bearer ${token}`);
    return { ...init, headers };
  };
  let res: Response;
  try {
    res = await fetch(`${BASE}${url}`, build());
  } catch {
    // phones (esp. iOS Safari) abort long fetches with "Load failed" / "Failed to fetch";
    // surface a readable message instead of the raw browser error
    throw new Error('网络连接失败或请求超时，请检查网络后重试');
  }
  if (res.status === 401) {
    // 无 token 或已存 token 失效（换服务器/被撤销）：清掉旧值再弹门禁，
    // 否则"已存失效 token"会永不重询问形成死锁；成功输入后用新 token 重试原请求
    localStorage.removeItem('coteam-api-token');
    const ok = await openTokenGate();
    if (ok) return request<T>(url, init);
    throw new Error('访问被拒绝：需要有效的 API Token');
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
  // B1（2026-09-17）：tolerant 验收交付——主体完成但验收有失败项
  | 'completed_with_warnings'
  | 'failed' | 'retrying' | 'cancelled' | 'waiting_approval' | 'waiting_clarify'
  | 'interrupted' | 'finalizing';

export interface TaskNode {
  id: string;
  name: string;
  status: TaskStatus;
  agent: string;
  error?: string;
  reason?: string;
  retry_count?: number;
  requires_approval?: boolean;
  /** 人工门标记：环境/前置/审批类失败，双端展示"已处理，从此节点继续" */
  needs_human?: boolean;
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
  /** 环境预检（o3xmkraj 复盘）：执行前对计划所需命令的白名单/PATH 探测结果 */
  preflight?: { checked_at: string; ok: boolean; missing_whitelist?: string[]; missing_path?: string[] };
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
  /** 产生这条发言的模型（群聊模型徽标） */
  model?: string;
}

/** 发用户消息：text 可空但需 react_to；reply_to 做引用回复 */
/** 用户附图（随消息提交的 dataURL；服务端 ingest 后消息里只存引用） */
export interface IncomingImage {
  name: string;
  dataUrl: string;
}

/** 服务端落库后的图片引用（消息 meta.images，前端据此渲染气泡） */
export interface StoredImage {
  id: string;
  name: string;
  url: string;
  wsPath?: string;
  desc?: string;
  descModel?: string;
}

export interface PostDiscussionPayload {
  text?: string;
  reply_to?: string;
  react_to?: string;
  emoji?: string;
  images?: IncomingImage[];
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
  /** 最新一次转出的任务（兼容字段，= task_ids 最后一项） */
  task_id?: string;
  /** 转任务不封存：本讨论转出的全部任务，一聊可多任务 */
  task_ids?: string[];
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
  workspace: string;
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
  taskEvents: (id: string) => request<{ task_id: string; events: EventEnvelope[] }>(`/api/tasks/${id}/events`),
  metrics: () => request<{
    tasks: { total: number; success: number; success_rate: number };
    agents: Record<string, { tasks: number; completed: number; failed: number; retries: number; tokens: number }>;
    failure_types?: Record<string, number>;
    quality?: { defects_total: number; defects_closed: number; defect_close_rate: number; fix_rounds_avg: number; test_pass_rate: number; delivery_consistent_rate: number; delivery_checked_nodes: number };
    token_usage: Record<string, { prompt_tokens: number; completion_tokens: number; calls: number; cost: number }>;
    tokens_total: number;
    cost_total: number;
  }>('/api/metrics'),
  metricsTrend: (days = 7) => request<{ trend: { date: string; tasks: number; defects_total: number; success_rate: number }[] }>(`/api/metrics/trend?days=${days}`),
  // 外部 MCP 服务连接状态（MCP client；未配置返回空数组）
  mcpStatus: () => request<{ mcp: { name: string; type: 'stdio' | 'http'; enabled: boolean; connected: boolean; error?: string; toolCount: number }[] }>('/api/status'),
  taskJournals: (id: string) => request<{ task_id: string; journals: Record<string, JournalEntry[]> }>(`/api/tasks/${id}/journals`),
  approveNode: (taskId: string, nodeId: string) => post(`/api/tasks/${taskId}/approve/${nodeId}`),
  // 人工门续跑：needs_human 节点在人工修复后重置该节点及下游并重新入队
  retryNode: (taskId: string, nodeId: string) => post<{ status: string; reset_nodes: string[] }>(`/api/tasks/${taskId}/nodes/${nodeId}/retry`, {}),
  // 环境预检停靠后的人工放行（补授白名单后一键开跑）
  runTask: (taskId: string) => post<{ status: string; task_id: string }>(`/api/tasks/${taskId}/run`, {}),
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
  interveneTask: (id: string, message: string, images?: IncomingImage[]) =>
    post<{ status: string; intervention_id: string; note: string }>(`/api/tasks/${id}/intervene`, { message, images: images?.length ? images : undefined }),
  // M2 全员实时问答：回答 agent 的阻塞式提问
  answerAsk: (id: string, askId: string, answer: string, images?: IncomingImage[]) =>
    post<{ ok: boolean; ask_id: string }>(`/api/tasks/${id}/asks/${askId}/answer`, { answer, images: images?.length ? images : undefined }),
  getPendingCommands: (id: string) => request<{ commands: any[] }>(`/api/tasks/${id}/pending-commands`),
  resolveCommand: (id: string, commandId: string, approved: boolean) =>
    post(`/api/tasks/${id}/commands/${commandId}/approve`, { approved }),
  // 命令执行分级：任务级 level + 白名单命令（o3xmkraj 复盘补齐移动端入口）
  getTaskPolicy: (id: string) => request<{ task_id: string; execution_policy: { level: string; whitelist_commands?: string[] } | null }>(`/api/tasks/${id}/policy`),
  setTaskPolicy: (id: string, level: string | null, whitelistCommands?: string[]) =>
    request<{ status: string; execution_policy: { level: string; whitelist_commands?: string[] } | null }>(`/api/tasks/${id}/policy`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ level, whitelist_commands: whitelistCommands }),
    }),
  listAsks: (id: string) => request<{ asks: any[] }>(`/api/tasks/${id}/asks`),
  status: () => request<any>('/api/status'),
  // M10-C 管理面补齐
  getTaskGoal: (id: string) => request<{ content: string; updated_at?: string }>(`/api/tasks/${id}/goal`),
  updateTaskGoal: (id: string, content: string) =>
    request(`/api/tasks/${id}/goal`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content }) }),
  listSnapshots: () => request<{ snapshots: any[] }>('/api/snapshots'),
  rollbackSnapshot: (taskId: string, snapshotId: string, confirmed = true) =>
    post(`/api/snapshots/${snapshotId}/rollback`, { task_id: taskId, confirm: confirmed }),
  getNodeClarify: (id: string, nodeId: string) =>
    request<{ task_id: string; node_id: string; mode: string; brief: { approach: string; files?: string[]; risks?: string[]; questions?: string[] }; answers: { question: string; answer: string }[] }>(`/api/tasks/${id}/nodes/${nodeId}/clarify`),
  clarifyNode: (id: string, nodeId: string, payload: { approve?: boolean; answers?: { question: string; answer: string }[]; text?: string }) =>
    post<{ status: string }>(`/api/tasks/${id}/nodes/${nodeId}/clarify`, payload),
  // M5 最终验收报告
  acceptanceReport: (id: string) => request<{ report: any }>(`/api/tasks/${id}/acceptance-report`),
  // M3 监督者提案
  listProposals: (id: string) =>
    request<{ proposals: any[] }>(`/api/tasks/${id}/proposals`),
  decideProposal: (id: string, proposalId: string, approved: boolean) =>
    post<{ ok: boolean; status: string }>(`/api/tasks/${id}/proposals/${proposalId}/decide`, { approved }),
  createTask: (payload: { description: string; workspace: string; level?: string; main_model_id?: string; project_id?: string; profile?: 'simple' | 'expert'; allow_self_ref?: boolean; execution_policy?: { level?: string; whitelist_commands?: string[] } }) =>
    post<{ status: 'created' | 'needs_clarification' | 'pending'; task_id: string; questions?: string[]; summary?: string; graph?: TaskGraph }>('/api/tasks', payload.profile === 'simple'
      ? { ...payload, auto_run: true, plan_async: true, skip_clarification: true }
      : { ...payload, auto_run: false, plan_async: true }),
  clarifyTask: (id: string, payload: { answers?: { question: string; answer: string; images?: IncomingImage[] }[]; confirm?: boolean; text?: string }) =>
    post<{ status: string; questions?: string[]; graph?: TaskGraph }>(`/api/tasks/${id}/clarify`, { ...payload, plan_async: true }),
  agentProfiles: () => request<{ agents: Record<string, AgentProfileSummary> }>('/api/agents/profiles'),
  listSkills: () => request<{ skills: SkillMeta[]; bindings: Record<string, string[]> }>('/api/skills'),
  nodeDiff: (taskId: string, nodeId: string) => request<NodeDiffResponse>(`/api/tasks/${taskId}/nodes/${nodeId}/diff`),
  getModelPool: () => request<{ model_pool: ModelPoolItem[] }>('/api/config/model-pool'),
  fsList: (p: string) => request<FsListing>(`/api/fs?path=${encodeURIComponent(p)}`),
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
  /** agent 转任务确认卡的用户拍板：confirm 真正建任务开工，cancel 继续讨论 */
  resolveDiscussionConvert: (id: string, confirmId: string, action: 'confirm' | 'cancel') =>
    post<{ status: string; state: 'confirmed' | 'cancelled'; project_id?: string; task_id?: string }>(`/api/discussions/${id}/convert/confirm`, { confirm_id: confirmId, action }),
  listKnowledge: (params: { category?: string; project_id?: string; source?: string } = {}) => {
    const sp = new URLSearchParams();
    if (params.category) sp.set('category', params.category);
    if (params.project_id) sp.set('project_id', params.project_id);
    if (params.source) sp.set('source', params.source);
    return request<{ entries: KnowledgeEntry[] }>(`/api/knowledge?${sp}`);
  },
  // 包 D：全局命令权限（级别 + 白名单）
  getPermissions: () =>
    request<{ permissions: { level: string; whitelist_commands: string[]; max_time_sec?: number }; levels: string[] }>('/api/config/permissions'),
  savePermissions: (level: string, whitelist_commands: string[]) =>
    post<{ status: string; permissions: { level: string; whitelist_commands: string[] } }>('/api/config/permissions', { level, whitelist_commands }),
};

export function statusLabel(s: string): string {
  // 状态中文唯一来源：utils/events.ts 的 STATUS_TEXT（此前两套映射各说各话）
  return statusText(s);
}
