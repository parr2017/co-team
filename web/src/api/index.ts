// Shared API client + types mirroring the server contract.

export type TaskStatus = 'pending' | 'queued' | 'planned' | 'clarifying' | 'running' | 'completed' | 'failed' | 'retrying' | 'cancelled' | 'waiting_approval' | 'waiting_clarify' | 'interrupted' | 'finalizing';

export type TaskLevel = 'light' | 'standard' | 'heavy';

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
  /** 用户附图（随回答提交的 dataURL，服务端富化为视觉描述注入规划） */
  images?: IncomingImage[];
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
  /** OBS-1 经验闭环度量 */
  hits?: number;
  last_hit_at?: string;
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

export interface TaskMergeResult {
  ok: boolean;
  target: string;
  taskBranch: string;
  commit: string | null;
  conflicts: string[];
  message: string;
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
  /** 本节点实际使用的模型与 token 消耗（dispatch 成功后写入） */
  model?: string;
  tokens?: number;
  git_commit?: { branch: string; commit: string | null };
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
  /** 该节点分支的切出父分支——节点 diff 的计算基准 */
  branch_base?: string;
  started_at?: string;
  finished_at?: string;
  created_at: string;
  updated_at: string;
}

export interface NodeDiffResponse {
  node_id: string;
  branch: string;
  available: boolean;
  reason?: string;
  patch: string;
  files: { path: string; insertions: number; deletions: number }[];
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
  /** M4 滚动规划 */
  rolling?: boolean;
  stage?: number;
  stage_count?: number;
  stage_goal?: string;
  checklist?: { id: string; requirement: string; status?: string; evidence?: string }[];
  /** 永续开发（2026-09-15）：infra 类自动重排计数 */
  infra_retries?: number;
  /** 环境预检（o3xmkraj 复盘）：执行前对计划所需命令的白名单/PATH 探测结果 */
  preflight?: { checked_at: string; ok: boolean; missing_whitelist?: string[]; missing_path?: string[] };
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
  /** OBS-1 健康细节（scheduler 记账） */
  fail_count?: number;
  slow_count?: number;
  cooldown_ms?: number;
  effective_priority?: number;
}

export interface StatusResponse {
  status: string;
  time: string;
  model_pool: Record<string, ModelStatus>;
  agents_dir: string;
  tokens_total: number;
  cost_total: number;
  /** 外部 MCP 服务连接状态（MCP client；未配置为空数组） */
  mcp?: McpServerStatus[];
}

// ---------- 外部 MCP 服务（MCP client） ----------

export interface McpServerConfig {
  name: string;
  type: 'stdio' | 'http';
  enabled?: boolean;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  url?: string;
  headers?: Record<string, string>;
  max_result_chars?: number;
  timeout_sec?: number;
  allow_tools?: string[];
}

export interface McpServerStatus {
  name: string;
  type: 'stdio' | 'http';
  enabled: boolean;
  connected: boolean;
  error?: string;
  toolCount: number;
}

export interface McpTestResult {
  ok: boolean;
  tools?: { name: string; description?: string }[];
  error?: string;
}

export interface MetricsResponse {
  tasks: { total: number; success: number; success_rate: number };
  agents: Record<string, { tasks: number; completed: number; failed: number; retries: number; tokens: number }>;
  failure_types?: Record<string, number>;
  quality?: QualitySummary;
  token_usage: Record<string, { prompt_tokens: number; completion_tokens: number; calls: number; cost: number }>;
  tokens_total: number;
  cost_total: number;
}

/** feature: 模型标签模板 —— 用户自定义命名标签组合（如「视觉+推理」） */
export interface TagTemplate {
  name: string;
  tags: string[];
}

/** feature: 模型长度模板 —— 用户自定义命名长度值（如 256K=262144），上下文/输出上限一键应用 */
export interface LengthTemplate {
  name: string;
  value: number;
}

export interface ModelConfig {
  /** 模型唯一标识符（全池唯一键） */
  id: string;
  name: string;
  provider?: string;
  api_key: string;
  base_url: string;
  /** 单次生成输出 token 上限（含思考 token），属模型能力 */
  max_tokens?: number;
  /** 模型上下文窗口（prompt 与输出共享） */
  context_length?: number;
  concurrency?: number;
  priority?: number;
  professional_weight?: number;
  cost_per_1k?: number;
  tags?: string[];
  /** capability roles: 'chat' (default) and/or 'embedding' */
  roles?: string[];
  /** vLLM 透传参数（如 {enable_thinking:false}）——设置界面不编辑，保存时原样带回 */
  chat_template_kwargs?: Record<string, unknown>;
}

export interface AgentDefinition {
  name: string;
  dir: string;
  role: string;
  description: string;
  tags: string[];
  model_override: string | null;
  timeout: number;
  version: string;
  prompt: string;
  skills?: string[];
  /** 绑定的外部 MCP server 白名单（agent.yaml mcp_servers） */
  mcp_servers?: string[];
}

export interface ProjectMemoryItem {
  text: string;
  ts: string;
  kind: 'auto' | 'manual';
  task_id?: string;
}

export interface JournalEntry {
  role: 'master' | 'agent';
  kind: 'brief' | 'tool_results' | 'round' | 'final' | 'error' | 'intervene' | 'deliverable' | 'message' | 'message_received' | 'handoff' | 'doc' | 'ask' | 'answer';
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
  // P1.1 项目概念双轨（均可选，旧记录缺省）
  tech_stack?: string;
  conventions?: string;
  domain?: string;
  stage?: string;
  audience?: string;
  brief?: string;
  brief_updated_at?: string;
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

// SEC-P0 API Token：设置里配置后自动携带（存 localStorage）
export function getApiToken(): string {
  return localStorage.getItem('coteam-api-token') || '';
}
export function setApiToken(token: string) {
  localStorage.setItem('coteam-api-token', token);
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const token = getApiToken();
  const headers = new Headers(init?.headers);
  if (token) headers.set('Authorization', `Bearer ${token}`);
  const res = await fetch(url, { ...init, headers });
  if (res.status === 401) {
    // SEC-P0 门禁：全局广播，TokenGate 弹窗接管（替代首访/凭据失效的全站静默空白）
    window.dispatchEvent(new CustomEvent('coteam:unauthorized'));
    throw new Error('访问被拒绝：API Token 缺失或已失效');
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    // B2（2026-09-17）：错误带操作建议（hint）——组件用 showApiError 展示两行提示
    const { errorHint } = await import('../utils/apiError');
    const detail = (body as any).detail || res.statusText;
    const err: Error & { hint?: string } = new Error(detail);
    err.hint = errorHint(String(detail));
    throw err;
  }
  return body as T;
}

export interface SkillMeta {
  name: string;
  description: string;
  tags: string[];
  source: string;
  body?: string;
}

/** feature: 每日问题沉淀报告 */
export interface DailyReportItem {
  id: string;
  signature: string;
  category: 'model_env' | 'code_defect' | 'command_risk' | 'requirement' | 'other';
  count: number;
  sample: string;
  first_seen: string;
  last_seen: string;
  sources: { task_id?: string; node_id?: string; node_name?: string; agent?: string }[];
}

export interface DailyReport {
  date: string;
  generated_at: string;
  items: DailyReportItem[];
  resolved: Record<string, { action: string; ts: string; task_id?: string }>;
}

export const PERMISSION_LEVELS = ['plan_only', 'readonly', 'approve_required', 'whitelist_auto', 'full', 'unrestricted'] as const;
export const PERMISSION_LEVEL_LABELS: Record<string, string> = {
  plan_only: '只出方案',
  readonly: '只读',
  approve_required: '改动需审批',
  whitelist_auto: '白名单自动',
  full: '目录内完全控制',
  unrestricted: '无边界（解除目录监狱）',
};

/** 协作会话：单 agent 长对话直接操作项目工作区（服务端 convo.ts 的镜像） */
export type ConvoStatus = 'idle' | 'running' | 'waiting_approval' | 'waiting_ask';
export type ConvoMessageKind = 'text' | 'tool' | 'notice' | 'degrade' | 'approval' | 'ask' | 'file' | 'interrupt' | 'diff';

export interface Convo {
  id: string;
  title: string;
  project_id?: string;
  workspace: string;
  agent_id: string;
  model_id?: string;
  status: ConvoStatus;
  policy_level?: string;
  auto_switch?: boolean;
  snapshot_id?: string;
  /** 会话步骤清单（write_plan/update_plan 维护，胶囊/展开渲染） */
  plan?: { steps: { text: string; status: 'pending' | 'in_progress' | 'done' | 'blocked'; ts: string }[]; updated_at: string };
  created_at: string;
  updated_at: string;
}

export interface ConvoMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  kind: ConvoMessageKind;
  text: string;
  ts: string;
  model?: string;
  meta?: Record<string, any>;
}

export interface ConvoApproval {
  id: string;
  command: string;
  ts: string;
  status: 'pending' | 'approved_once' | 'approved_always' | 'rejected';
  resolved_by?: string;
  resolved_at?: string;
}

export interface ConvoAsk {
  id: string;
  question: string;
  ts: string;
  status: 'pending' | 'answered' | 'timeout' | 'cancelled';
  answer?: string;
}

export interface ConvoFileRef {
  id: string;
  name: string;
  url: string;
  wsPath?: string;
  size: number;
}

export interface ConvoDetail extends Convo {
  messages: ConvoMessage[];
  pending_queue: number;
  pending_approvals: ConvoApproval[];
  pending_asks: ConvoAsk[];
  busy?: boolean;
}

/** 群组沟通：多 agent + 用户的自主讨论 → 方案 → 转项目（服务端 discussion.ts 的镜像） */
export type DiscussionMode = 'manual' | 'auto';
export type DiscussionStatus = 'discussing' | 'converged' | 'converted';

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

/** 用户附图（发消息时随 JSON 提交的 dataURL；服务端 ingest 后消息里只存引用） */
export interface IncomingImage {
  name: string;
  dataUrl: string;
}

/** 服务端落库后的图片引用（消息 meta.images，前端据此渲染气泡） */
export interface StoredImage {
  id: string;
  name: string;
  url: string;
  /** workspace 内相对路径（agent 可 look_image；无项目/任务关联时缺省） */
  wsPath?: string;
  /** 视觉旁路生成的中文描述（软失败时缺省） */
  desc?: string;
  descModel?: string;
}

/** 发用户消息：text 可空但需 react_to/图片；reply_to 做引用回复 */
export interface PostDiscussionPayload {
  text?: string;
  reply_to?: string;
  react_to?: string;
  emoji?: string;
  images?: IncomingImage[];
}

export interface Discussion {
  id: string;
  title: string;
  topic?: string;
  members: string[];
  mode: DiscussionMode;
  status: DiscussionStatus;
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

// ---------- 外部运行时 · OpenCode 接管（server/src/opencode 的镜像；mobile 端契约同源） ----------

/** 实例类型：managed=co-team 托管拉起；attached-cli/attached-desktop=接管用户已在跑的实例 */
export type OcInstanceKind = 'managed' | 'attached-cli' | 'attached-desktop';
/** stopped=未启动 starting=拉起中 running=进程在 connected=API 通 error=异常 */
export type OcInstanceState = 'stopped' | 'starting' | 'running' | 'connected' | 'error';
/** 控制档位：readonly=只读+审批响应；control=发消息/abort/revert/diff 全操作 */
export type OcInstanceMode = 'readonly' | 'control';

export interface OcInstance {
  id: string;
  kind: OcInstanceKind;
  label?: string;
  enabled: boolean;
  state: OcInstanceState;
  url: string;
  mode: OcInstanceMode;
  version: string;
  capabilities?: {
    healthy: boolean;
    version: string;
    sync_prompt: boolean;
    async_prompt: boolean;
    abort: boolean;
    revert: boolean;
    diff: boolean;
    permissions: boolean;
    events: boolean;
    shell: boolean;
    tui: boolean;
  };
  pid?: number;
  project_root?: string;
  model_injection: boolean;
  error?: string;
  last_checked_at?: string;
}

/** opencode 会话最小形态（title 缺省时 UI 回退展示 id 缩写） */
export interface OcSession {
  id: string;
  title?: string;
  /** opencode 全局会话库按 directory 归属项目（面板分组/徽标用） */
  directory?: string;
  agent?: string;
  model?: Record<string, unknown>;
  time?: { created: number; updated: number };
  [k: string]: unknown;
}

/** 消息 part：text=正文 / reasoning=思考 / tool=工具调用 / step-start、step-finish=步骤边界 */
export interface OcPart {
  type: string;
  text?: string;
  tool?: string;
  [k: string]: unknown;
}

export interface OcMessage {
  info: { id: string; role: string; model?: string; time?: string; [k: string]: unknown };
  parts: OcPart[];
}

export interface OcDiffFile {
  file: string;
  additions: number;
  deletions: number;
  patch?: string;
}

/** 实例配置（config.yaml 的 opencode.instances[] 条目镜像；面板空态引导用户改配置文件） */
export interface OcInstanceConfig {
  id: string;
  kind: OcInstanceKind;
  label?: string;
  enabled?: boolean;
  command?: string;
  args?: string[];
  port?: number;
  hostname?: string;
  project_root?: string;
  env?: Record<string, string>;
  model_injection?: boolean;
  auto_start?: boolean;
  url?: string;
  mode?: OcInstanceMode;
  auth?: { username?: string; password?: string };
  timeout_sec?: number;
  max_result_chars?: number;
  agents?: string[];
  allow_shell?: boolean;
}

export const api = {
  createTask: (
    description: string,
    workspace: string,
    autoRun = true,
    projectId?: string,
    opts?: { mainModelId?: string; level?: string; executionPolicy?: { level?: string; whitelist_commands?: string[] }; nodeClarify?: string; profile?: 'simple' | 'expert'; allowSelfRef?: boolean; acceptancePolicy?: 'strict' | 'tolerant' }
  ) =>
    request<{ task_id: string; status?: string; questions?: string[]; summary?: string; level?: string; graph?: TaskGraph }>('/api/tasks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        description,
        workspace,
        auto_run: autoRun,
        project_id: projectId,
        main_model_id: opts?.mainModelId,
        level: opts?.level,
        execution_policy: opts?.executionPolicy,
        node_clarify: opts?.nodeClarify,
        profile: opts?.profile,
        allow_self_ref: opts?.allowSelfRef,
        acceptance_policy: opts?.acceptancePolicy,
      }),
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
  listKnowledge: (params: { category?: string; project_id?: string; q?: string; limit?: number; source?: string; stale?: boolean } = {}) => {
    const sp = new URLSearchParams();
    if (params.category) sp.set('category', params.category);
    if (params.project_id) sp.set('project_id', params.project_id);
    if (params.q) sp.set('q', params.q);
    if (params.limit) sp.set('limit', String(params.limit));
    if (params.source) sp.set('source', params.source);
    if (params.stale) sp.set('stale', '1');
    return request<{ entries: KnowledgeEntry[] }>(`/api/knowledge?${sp}`);
  },
  createKnowledge: (payload: { title: string; content: string; category?: string; project_id?: string; tags?: string[] }) =>
    request<{ status: string; id: string }>('/api/knowledge', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }),
  // P1.4 经验候选卡确认入库
  confirmKnowledge: (payload: { title: string; content: string; category?: string; project_id?: string; tags?: string[]; source?: string }) =>
    request<{ status: string; id: string }>('/api/knowledge/confirm', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }),
  // P1.1 项目元数据编辑与简报生成
  updateProject: (id: string, payload: { name?: string; description?: string; tech_stack?: string; conventions?: string; domain?: string; stage?: string; audience?: string; brief?: string }) =>
    request<{ status: string; project: ProjectSummary }>(`/api/projects/${id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }),
  generateProjectBrief: (id: string) =>
    request<{ status: string; brief: string; project: ProjectSummary }>(`/api/projects/${id}/brief`, { method: 'POST' }),
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
  updateNode: (taskId: string, nodeId: string, patch: { name?: string; agent?: string; model_id?: string | null; clarify_mode?: string; action?: 'delete' }) =>
    request(`/api/tasks/${taskId}/nodes/${nodeId}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch) }),
  addNode: (taskId: string, payload: { name: string; agent: string; after_node_id: string }) =>
    request<{ status: string; node: TaskNode; graph: TaskGraph }>(`/api/tasks/${taskId}/nodes`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }),
  nodeDiff: (taskId: string, nodeId: string) =>
    request<NodeDiffResponse>(`/api/tasks/${taskId}/nodes/${nodeId}/diff`),
  roadmap: () => request<{ content: string; updated_at: string }>('/api/system/roadmap'),
  createProject: (payload: { name: string; workspace?: string; description?: string; scaffold?: boolean; allow_self_ref?: boolean }) =>
    request<{ project_id: string; scaffold?: { dirs: string[]; files: string[]; git_initialized: boolean } | null }>('/api/projects', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }),
  projectsRoot: () => request<{ root: string; selfdev_root: string }>('/api/projects/root'),
  listProjects: () => request<{ projects: ProjectSummary[] }>('/api/projects'),
  getProject: (id: string) => request<ProjectDetail & { id: string }>(`/api/projects/${id}`),
  addProjectMemory: (id: string, text: string) =>
    request(`/api/projects/${id}/memory`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }) }),
  taskJournals: (id: string) => request<{ task_id: string; journals: Record<string, JournalEntry[]> }>(`/api/tasks/${id}/journals`),
  agentProfiles: () => request<{ agents: Record<string, AgentProfileInfo> }>('/api/agents/profiles'),
  approveNode: (taskId: string, nodeId: string) => request(`/api/tasks/${taskId}/approve/${nodeId}`, { method: 'POST' }),
  // 人工门续跑：needs_human 节点在人工修复后重置该节点及下游并重新入队
  retryNode: (taskId: string, nodeId: string) =>
    request<{ status: string; reset_nodes: string[] }>(`/api/tasks/${taskId}/nodes/${nodeId}/retry`, { method: 'POST' }),
  // 环境预检停靠后的人工放行（补授白名单后一键开跑）
  runTask: (taskId: string) => request<{ status: string; task_id: string }>(`/api/tasks/${taskId}/run`, { method: 'POST' }),
  // feature: 实施前澄清
  getNodeClarify: (taskId: string, nodeId: string) =>
    request<{ task_id: string; node_id: string; mode: string; brief: { approach: string; files: string[]; risks: string[]; questions: string[] }; answers: { question: string; answer: string }[] }>(
      `/api/tasks/${taskId}/nodes/${nodeId}/clarify`
    ),
  clarifyNode: (taskId: string, nodeId: string, payload: { approve?: boolean; answers?: { question: string; answer: string }[]; text?: string }) =>
    request<{ status: string }>(`/api/tasks/${taskId}/nodes/${nodeId}/clarify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }),
  // feature: 命令执行分级
  getTaskPolicy: (taskId: string) => request<{ task_id: string; execution_policy: { level: string; whitelist_commands?: string[] } | null }>(`/api/tasks/${taskId}/policy`),
  setTaskPolicy: (taskId: string, level: string | null, whitelistCommands?: string[]) =>
    request<{ status: string; execution_policy: { level: string; whitelist_commands?: string[] } | null }>(`/api/tasks/${taskId}/policy`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ level, whitelist_commands: whitelistCommands }),
    }),
  getPendingCommands: (taskId: string) =>
    request<{ task_id: string; commands: { id: string; node_id: string; node_name: string; command: string; ts: string }[] }>(`/api/tasks/${taskId}/pending-commands`),
  resolveCommand: (taskId: string, commandId: string, approved: boolean) =>
    request<{ ok: boolean; returncode?: number }>(`/api/tasks/${taskId}/commands/${commandId}/approve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ approved }),
    }),
  // feature: 每日问题报告
  getDailyReportConfig: () => request<{ enabled: boolean; hour: number }>('/api/config/daily-report'),
  saveDailyReportConfig: (enabled: boolean, hour: number) =>
    request<{ status: string; enabled: boolean; hour: number }>('/api/config/daily-report', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled, hour }),
    }),
  // 包 D：全局命令权限（级别 + 白名单）
  getPermissions: () => request<{ permissions: { level: string; whitelist_commands: string[]; max_time_sec?: number }; levels: string[] }>('/api/config/permissions'),
  savePermissions: (level: string, whitelist_commands: string[], max_time_sec?: number) =>
    request<{ status: string; permissions: { level: string; whitelist_commands: string[]; max_time_sec?: number } }>('/api/config/permissions', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ level, whitelist_commands, ...(max_time_sec !== undefined ? { max_time_sec } : {}) }),
    }),
  // 外部 MCP 服务管理（保存即热生效；测试连接不落盘）
  getMcpConfig: () => request<{ servers: McpServerConfig[]; runtime: McpServerStatus[] }>('/api/config/mcp'),
  saveMcpConfig: (servers: McpServerConfig[]) =>
    request<{ status: string; servers: McpServerConfig[]; runtime: McpServerStatus[] }>('/api/config/mcp', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ servers }),
    }),
  testMcpServer: (server: McpServerConfig) =>
    request<McpTestResult>('/api/config/mcp/test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ server }),
    }),
  listDailyReports: (limit = 30) => request<{ reports: DailyReport[] }>(`/api/reports/daily?limit=${limit}`),  resolveReportItem: (date: string, itemId: string, action: 'fix_now' | 'create_task' | 'skip') =>
    request<{ status: string; action: string; task_id?: string }>(`/api/reports/daily/${date}/resolve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ item_id: itemId, action }),
    }),
  // P0-2: 缺陷转修复任务
  convertDefect: (taskId: string, nodeId: string, defectIndex: number, autoRun = false) =>
    request<{ status: string; fix_task_id: string; fix_for: { task_id: string; node_id: string }; questions: string[] }>(`/api/tasks/${taskId}/defects/convert`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ node_id: nodeId, defect_index: defectIndex, auto_run: autoRun }),
    }),
  metricsTrend: (days = 14) => request<{ days: number; trend: TrendPoint[] }>(`/api/metrics/trend?days=${days}`),
  listDeliverables: (taskId: string) => request<{ task_id: string; deliverables: DeliverableDoc[] }>(`/api/tasks/${taskId}/deliverables`),
  getDeliverable: (taskId: string, nodeId: string) => request<DeliverableDoc & { task_id: string }>(`/api/tasks/${taskId}/deliverables/${nodeId}`),
  // A3 验收合并闭环
  mergeTask: (taskId: string, dryRun: boolean, target?: string) =>
    request<TaskMergeResult>(`/api/tasks/${taskId}/merge`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ dry_run: dryRun, target }),
    }),
  // A2 协同文档列表/预览
  taskDocs: (taskId: string) =>
    request<{ task_id: string; docs: { type: string; path: string; version: number; updated_at: string; updated_by: string; content: string }[] }>(`/api/tasks/${taskId}/docs`),
  // A1 实时产出视图（沙箱只读浏览）
  taskOutput: (taskId: string) =>
    request<{ task_id: string; sandbox_path: string | null; available: boolean; files: string[] }>(`/api/tasks/${taskId}/output`),
  taskOutputFile: (taskId: string, path: string) =>
    request<{ task_id: string; path: string; content: string }>(`/api/tasks/${taskId}/output/file?path=${encodeURIComponent(path)}`),
  projectReport: (id: string) => request<ProjectProgressReport>(`/api/projects/${id}/report`),
  listSkills: () => request<{ skills: SkillMeta[]; bindings: Record<string, string[]> }>('/api/skills'),
  createSkill: (payload: { name: string; description?: string; tags?: string[]; content?: string }) =>
    request<{ status: string; total: number }>('/api/skills', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }),
  updateSkill: (name: string, payload: { name?: string; description?: string; tags?: string[]; content?: string }) =>
    request<{ status: string }>(`/api/skills/${name}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }),
  deleteSkill: (name: string) => request(`/api/skills/${name}`, { method: 'DELETE' }),
  reloadSkills: () => request<{ status: string; total: number }>('/api/skills/reload', { method: 'POST' }),
  interveneTask: (taskId: string, message: string, images?: IncomingImage[]) =>
    request<{ status: string; intervention_id: string; note: string }>(`/api/tasks/${taskId}/intervene`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message, images: images?.length ? images : undefined }),
    }),
  // M2 全员实时问答：回答 agent 的阻塞式提问
  answerAsk: (taskId: string, askId: string, answer: string, images?: IncomingImage[]) =>
    request<{ ok: boolean; ask_id: string }>(`/api/tasks/${taskId}/asks/${askId}/answer`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ answer, images: images?.length ? images : undefined }),
    }),
  // M3 监督者提案
  listProposals: (taskId: string) =>
    request<{ proposals: { id: string; type: string; reason?: string; status: string; node_id?: string; new_node?: { name: string; agent: string } }[] }>(`/api/tasks/${taskId}/proposals`),
  acceptanceReport: (taskId: string) =>
    request<{ report: any }>(`/api/tasks/${taskId}/acceptance-report`),
  decideProposal: (taskId: string, proposalId: string, approved: boolean) =>
    request<{ ok: boolean; status: string }>(`/api/tasks/${taskId}/proposals/${proposalId}/decide`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ approved }),
    }),
  taskLogs: (id: string) => request<{ task_id: string; logs: Record<string, AgentConversation[]> }>(`/api/tasks/${id}/logs`),
  // OBS-1 服务日志（tail）：?date=YYYY-MM-DD&lines=N
  logs: (date: string, lines: number) => request<{ date: string; total: number; lines: string[] }>(`/api/logs?date=${date}&lines=${lines}`),
  // M2 阻塞问答列表（此前只有 answer，无列表入口）
  listAsks: (taskId: string) => request<{ asks: { id: string; from: string; to?: string; question: string; status: string; created_at?: string; resolved_at?: string }[] }>(`/api/tasks/${taskId}/asks`),
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
  // feature: 模型标签模板 —— 用户自定义命名标签组合
  getTagTemplates: () => request<{ templates: TagTemplate[] }>('/api/config/model-tag-templates'),
  saveTagTemplates: (templates: TagTemplate[]) =>
    request<{ status: string; templates: TagTemplate[] }>('/api/config/model-tag-templates', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ templates }) }),
  // feature: 模型长度模板 —— 上下文/输出上限一键应用的命名长度值
  getLengthTemplates: () => request<{ templates: LengthTemplate[] }>('/api/config/model-length-templates'),
  saveLengthTemplates: (templates: LengthTemplate[]) =>
    request<{ status: string; templates: LengthTemplate[] }>('/api/config/model-length-templates', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ templates }) }),
  testModel: (model: ModelConfig) =>
    request<{ ok: boolean; latency_ms: number; response_preview?: string; error?: string }>(
      '/api/config/model-pool/test',
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(model) }
    ),
  // 模型池服务分组：拉取某个 base_url + api_key 上游实际可用的模型列表
  upstreamModels: (base_url: string, api_key: string) =>
    request<{ ok: boolean; models?: string[]; error?: string }>(
      '/api/config/upstream-models',
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ base_url, api_key }) }
    ),
  reloadAgents: () => request('/api/agents/reload', { method: 'POST' }),
  // ---------- 群组沟通 ----------
  listDiscussions: (status?: string) =>
    request<{ discussions: Discussion[] }>(`/api/discussions${status ? `?status=${status}` : ''}`),
  getDiscussion: (id: string) => request<DiscussionDetail>(`/api/discussions/${id}`),
  createDiscussion: (payload: { title: string; topic?: string; members: string[]; mode?: DiscussionMode; project_id?: string }) =>
    request<{ status: string; discussion: Discussion }>('/api/discussions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }),
  updateDiscussion: (id: string, patch: { mode?: DiscussionMode; title?: string; scheme?: string }) =>
    request<{ status: string; discussion: Discussion }>(`/api/discussions/${id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch) }),
  deleteDiscussion: (id: string) => request(`/api/discussions/${id}`, { method: 'DELETE' }),
  postDiscussionMessage: (id: string, payload: PostDiscussionPayload) =>
    request<{ status: string; message: DiscussionMessage | null; queued?: boolean; responding: string[] | string | null }>(`/api/discussions/${id}/messages`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
    }),
  discussionRound: (id: string) => request<{ status: string }>(`/api/discussions/${id}/round`, { method: 'POST' }),
  discussionStop: (id: string) => request<{ status: string }>(`/api/discussions/${id}/stop`, { method: 'POST' }),
  generateScheme: (id: string) =>
    request<{ status: string; discussion: Discussion }>(`/api/discussions/${id}/scheme`, { method: 'POST' }),
  convertDiscussion: (id: string, payload: ConvertDiscussionPayload) =>
    request<{ status: string; project_id: string; task_id: string }>(`/api/discussions/${id}/convert`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
    }),
  /** agent 转任务确认卡的用户拍板：confirm 真正建任务开工，cancel 继续讨论 */
  resolveDiscussionConvert: (id: string, confirmId: string, action: 'confirm' | 'cancel') =>
    request<{ status: string; state: 'confirmed' | 'cancelled'; project_id?: string; task_id?: string }>(`/api/discussions/${id}/convert/confirm`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ confirm_id: confirmId, action }),
    }),
  /** P2-8 群聊小改一键回滚：按 undo_id 恢复写前内容（新文件=删除） */
  undoDiscussionWrites: (id: string, undoIds: string[]) =>
    request<{ status: string; reverted: string[]; missing: number }>(`/api/discussions/${id}/undo`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ undo_ids: undoIds }),
    }),
  status: () => request<StatusResponse>('/api/status'),
  metrics: () => request<MetricsResponse>('/api/metrics'),
  fsList: (path: string) => request<FsListing>(`/api/fs?path=${encodeURIComponent(path)}`),

  // ---------- 协作会话（convo.ts 的镜像；mobile 端契约同源） ----------
  convoList: (projectId?: string) =>
    request<{ convos: Convo[] }>(`/api/convos${projectId ? `?project_id=${encodeURIComponent(projectId)}` : ''}`),
  convoCreate: (payload: { project_id?: string; title?: string; model_id?: string; agent_id?: string; policy_level?: string }) =>
    request<{ status: string; convo: Convo }>('/api/convos', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }),
  convoGet: (id: string) =>
    request<ConvoDetail>(`/api/convos/${id}`),
  convoUpdate: (id: string, patch: { title?: string; model_id?: string | null; policy_level?: string | null; auto_switch?: boolean }) =>
    request<{ status: string; convo: Convo }>(`/api/convos/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch) }),
  convoDelete: (id: string) => request(`/api/convos/${id}`, { method: 'DELETE' }),
  convoSend: (id: string, payload: { text: string; images?: IncomingImage[]; model_id?: string }) =>
    request<{ status: string; queued: boolean }>(`/api/convos/${id}/messages`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }),
  convoPromote: (id: string) =>
    request<{ status: string; promoted: boolean; interrupted: boolean }>(`/api/convos/${id}/promote`, { method: 'POST' }),
  convoStop: (id: string) => request<{ status: string }>(`/api/convos/${id}/stop`, { method: 'POST' }),
  convoApprove: (id: string, approvalId: string, action: 'once' | 'reject' | 'always') =>
    request<{ status: string; approval: ConvoApproval }>(`/api/convos/${id}/approvals/${approvalId}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action }) }),
  convoAnswerAsk: (id: string, askId: string, answer: string) =>
    request<{ status: string }>(`/api/convos/${id}/asks/${askId}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ answer }) }),
  convoDiff: (id: string) =>
    request<{ files: string[]; patch: string; git: boolean }>(`/api/convos/${id}/diff`),
  convoRollback: (id: string) =>
    request<{ status: string; ok: boolean; snapshot_id: string; git_action: string; details: string[] }>(`/api/convos/${id}/rollback`, { method: 'POST' }),
  convoFile: (id: string, path: string) =>
    request<{ name: string; size: number; kind: 'text' | 'image'; content?: string; dataUrl?: string }>(`/api/convos/${id}/file?path=${encodeURIComponent(path)}`),
  convoFork: (id: string, payload?: { message_id?: string; title?: string; resetPolicy?: boolean }) =>
    request<{ status: string; convo: Convo }>(`/api/convos/${id}/fork`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload || {}) }),
  convoSearchFiles: (id: string, q: string, limit = 20) =>
    request<{ files: string[]; total: number }>(`/api/convos/${id}/search?q=${encodeURIComponent(q)}&limit=${limit}`),
  /** multipart 文件上传（request 封装不含 FormData，这里单独 fetch） */
  convoUploadFiles: async (id: string, files: File[]): Promise<{ status: string; files: ConvoFileRef[] }> => {
    const fd = new FormData();
    for (const f of files) fd.append('files', f);
    const token = localStorage.getItem('coteam-api-token') || '';
    const res = await fetch(`/api/convos/${id}/files`, { method: 'POST', headers: token ? { Authorization: `Bearer ${token}` } : undefined, body: fd });
    if (!res.ok) {
      let detail = `HTTP ${res.status}`;
      try { detail = (await res.json())?.detail || detail; } catch { /* ignore */ }
      throw new Error(detail);
    }
    return res.json();
  },

  // ---------- 外部运行时 · OpenCode 接管（opencode.ts 的镜像；mobile 端契约同源） ----------
  ocInstances: () => request<{ instances: OcInstance[] }>('/api/opencode/instances'),
  ocConfig: () => request<{ instances: OcInstanceConfig[] }>('/api/opencode/config'),
  ocSaveConfig: (instances: OcInstanceConfig[]) =>
    request<{ ok: boolean }>('/api/opencode/config', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ instances }) }),
  ocStartInstance: (id: string) =>
    request<{ ok: boolean; state: string }>(`/api/opencode/instances/${encodeURIComponent(id)}/start`, { method: 'POST' }),
  ocStopInstance: (id: string) =>
    request<{ ok: boolean }>(`/api/opencode/instances/${encodeURIComponent(id)}/stop`, { method: 'POST' }),
  ocSessions: (instance: string) =>
    request<{ sessions: OcSession[] }>(`/api/opencode/instances/${encodeURIComponent(instance)}/sessions`),
  ocMessages: (instance: string, session: string) =>
    request<{ messages: OcMessage[] }>(`/api/opencode/sessions/${encodeURIComponent(instance)}/${encodeURIComponent(session)}/messages`),
  ocPrompt: (instance: string, session: string, payload: { prompt: string; model?: string | { providerID: string; modelID: string }; agent?: string }) =>
    request<{ ok: boolean; result?: unknown }>(`/api/opencode/sessions/${encodeURIComponent(instance)}/${encodeURIComponent(session)}/prompt`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
    }),
  ocAbort: (instance: string, session: string) =>
    request<{ ok: boolean }>(`/api/opencode/sessions/${encodeURIComponent(instance)}/${encodeURIComponent(session)}/abort`, { method: 'POST' }),
  ocRevert: (instance: string, session: string, messageId: string) =>
    request<{ ok: boolean }>(`/api/opencode/sessions/${encodeURIComponent(instance)}/${encodeURIComponent(session)}/revert`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message_id: messageId }),
    }),
  ocDiff: (instance: string, session: string) =>
    request<{ ok: boolean; diff: OcDiffFile[] }>(`/api/opencode/sessions/${encodeURIComponent(instance)}/${encodeURIComponent(session)}/diff`),
  ocResolvePermission: (instance: string, session: string, permissionId: string, response: 'once' | 'always' | 'reject') =>
    request<{ ok: boolean }>(`/api/opencode/sessions/${encodeURIComponent(instance)}/${encodeURIComponent(session)}/permissions`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ permission_id: permissionId, response }),
    }),
  // ---- TUI 同构接管面 ----
  ocActiveSession: (instance: string) =>
    request<{ ok: boolean; session?: OcSession; reason?: 'busy' | 'recent'; error?: string }>(`/api/opencode/instances/${encodeURIComponent(instance)}/active-session`),
  ocDirect: (instance: string) =>
    request<{ ok: boolean; direct: boolean; url: string; events_url?: string; reason?: string }>(`/api/opencode/instances/${encodeURIComponent(instance)}/direct`),
  ocAgents: (instance: string) =>
    request<{ agents: { name: string; description?: string; mode?: string }[] }>(`/api/opencode/instances/${encodeURIComponent(instance)}/agents`),
  ocModels: (instance: string) =>
    request<{ providers?: { id?: string; models?: Record<string, unknown> }[]; default?: Record<string, string> }>(`/api/opencode/instances/${encodeURIComponent(instance)}/models`),
  ocSessionStatus: (instance: string, session: string) =>
    request<{ status: string }>(`/api/opencode/sessions/${encodeURIComponent(instance)}/${encodeURIComponent(session)}/status`),
  ocTodos: (instance: string, session: string) =>
    request<{ todos: { id?: string; content: string; status: string; priority?: string }[] }>(`/api/opencode/sessions/${encodeURIComponent(instance)}/${encodeURIComponent(session)}/todo`),
  ocCommand: (instance: string, session: string, command: string) =>
    request<{ ok: boolean; result?: unknown }>(`/api/opencode/sessions/${encodeURIComponent(instance)}/${encodeURIComponent(session)}/command`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ command }),
    }),
  ocPtys: (instance: string) =>
    request<{ ptys: { id: string; title?: string; command?: string; status?: string }[] }>(`/api/opencode/instances/${encodeURIComponent(instance)}/ptys`),
  ocPtyTicket: (instance: string, ptyId: string) =>
    request<{ ok: boolean; ticket: string; expires_in: number; ws_url: string }>(`/api/opencode/instances/${encodeURIComponent(instance)}/ptys/${encodeURIComponent(ptyId)}/ticket`, { method: 'POST' }),
  ocTuiToast: (instance: string, message: string, variant: 'info' | 'success' | 'warning' | 'error' = 'info') =>
    request<{ ok: boolean }>(`/api/opencode/tui/${encodeURIComponent(instance)}/toast`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message, variant }),
    }),
  ocTuiOpenSessions: (instance: string) =>
    request<{ ok: boolean }>(`/api/opencode/tui/${encodeURIComponent(instance)}/open-sessions`, { method: 'POST' }),
  ocTuiSelectSession: (instance: string, sessionId: string) =>
    request<{ ok: boolean; error?: string }>(`/api/opencode/tui/${encodeURIComponent(instance)}/select-session`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ session_id: sessionId }),
    }),
  ocCreateSession: (instance: string, title?: string) =>
    request<{ ok: boolean; session?: OcSession }>(`/api/opencode/instances/${encodeURIComponent(instance)}/sessions`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...(title ? { title } : {}) }),
    }),
};
