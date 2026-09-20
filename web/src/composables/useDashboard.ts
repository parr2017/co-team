import { reactive, ref } from 'vue';
import { api, type EventEnvelope, type TaskGraph } from '../api';

export interface AgentLiveState {
  name: string;
  role: string;
  status: 'idle' | 'running' | 'done' | 'error';
  task: { id: string; taskId?: string; name: string; error?: string } | null;
  currentAction?: string;
  model?: string;
  changes: string[];
  history: { ts: string; text: string; type: string }[];
  taskCount: number;
  changeCount: number;
}

export interface EventItem {
  ts: string;
  type: string;
  data: Record<string, any>;
}

/** 2.2 节点心跳卡数据源：运行中节点的实时执行态（事件流聚合，刷新后靠节点状态回填起步） */
export interface NodeRuntime {
  taskId: string;
  nodeId: string;
  agent: string;
  name?: string;
  model?: string;
  startedAt?: string;
  round?: number;
  tokens?: number;
  retryCount?: number;
  backoffSec?: number;
  failoverFrom?: string;
  deltaText?: string;
  /** 最近一次 delta 事件时间戳（前端 3s 内视为"正在生成"） */
  deltaAt?: number;
  finishedAt?: number;
}

export interface TaskListFilter {
  scope?: 'external';
  projectId?: string;
  /** keyword search over task_id / description (improvement 6 / R4) */
  q?: string;
}

// ---------- module-level singleton store (one WS connection for the whole app) ----------
const agents = reactive<Record<string, AgentLiveState>>({});
const tasks = reactive<Record<string, TaskGraph>>({});
const events = ref<EventItem[]>([]);
const connected = ref(false);
const taskTotal = ref(0);
const taskPage = ref(1);
const taskPageSize = ref(20);
/** current task-creation stage (assessing/planning) for submit-button feedback (#P1-3) */
const createStage = ref('');
/** key: `${taskId}:${nodeId}` — 2.2 心跳卡 + 2.1 生成直播的实时执行态 */
const nodeRuntime = reactive<Record<string, NodeRuntime>>({});
const eventListeners = new Set<(msg: EventEnvelope) => void>();
let ws: WebSocket | null = null;
let started = false;
let taskFilter: TaskListFilter | undefined = { scope: 'external' };
/** 任务中心是否包含项目任务（默认只列外部任务，与原设计一致） */
const includeProjects = ref(false);

function setTaskScope(all: boolean) {
  includeProjects.value = all;
  taskFilter = all ? {} : { scope: 'external' };
  void loadTasks(1, taskPageSize.value);
}

/** Subscribe to raw WS events (called after internal state updates). Returns an unsubscribe fn. */
export function onEvent(cb: (msg: EventEnvelope) => void): () => void {
  eventListeners.add(cb);
  return () => eventListeners.delete(cb);
}

function ensureAgent(name: string): AgentLiveState {
  if (!agents[name]) {
    agents[name] = { name, role: '', status: 'idle', task: null, changes: [], history: [], taskCount: 0, changeCount: 0 };
  }
  return agents[name];
}

function runtimeKey(taskId: string, nodeId: string): string {
  return `${taskId}:${nodeId}`;
}

function ensureRuntime(taskId: string, nodeId: string, agent?: string): NodeRuntime {
  const k = runtimeKey(taskId, nodeId);
  if (!nodeRuntime[k]) {
    nodeRuntime[k] = { taskId, nodeId, agent: agent || '' };
  } else if (agent && !nodeRuntime[k].agent) {
    nodeRuntime[k].agent = agent;
  }
  return nodeRuntime[k];
}

/** 2.1/2.2：组件读取节点实时执行态（心跳卡/打字机） */
export function getNodeRuntime(taskId: string, nodeId: string): NodeRuntime | null {
  return nodeRuntime[runtimeKey(taskId, nodeId)] || null;
}

/** 2.1：任务内是否有节点正在生成（打字机指示器），且 delta 新鲜（3s 内） */
export function liveDelta(taskId: string, nodeId: string): string | null {
  const r = nodeRuntime[runtimeKey(taskId, nodeId)];
  if (!r?.deltaText || !r.deltaAt) return null;
  return Date.now() - r.deltaAt < 3000 ? r.deltaText : null;
}

const RT = (p: Record<string, any>) => nodeRuntime[runtimeKey(String(p.task_id || ''), String(p.node_id || ''))];

function handleEvent(msg: EventEnvelope) {
  const ev = msg.type || '';
  const p = msg.payload || {};
  if (ev === 'ping') return; // 服务端 15s 心跳：不入事件缓冲（否则约 50 分钟即把真实事件挤光）
  events.value.unshift({ ts: msg.ts || new Date().toISOString(), type: ev, data: p });
  if (events.value.length > 200) events.value.pop();

  if (ev === 'task_creating') createStage.value = String(p.stage || '');
  else if (['task_needs_clarification', 'execute_start'].includes(ev)) createStage.value = '';

  // 外部任务视图：payload 显式携带 project_id 的事件必然是项目任务，直接跳过预取
  if (ev !== 'task_creating' && p.task_id && !tasks[p.task_id] && !(p.project_id && taskFilter?.scope === 'external')) {
    void fetchSingleTask(String(p.task_id));
  }

  const task = p.task_id ? tasks[p.task_id] : null;
  if (task) {
    const node = p.node_id ? task.nodes.find((n) => n.id === p.node_id) : null;
    if (node) {
      if (ev === 'node_start') node.status = 'running';
      else if (ev === 'node_complete') node.status = 'completed';
      else if (ev === 'node_error') node.status = 'failed';
      else if (ev === 'node_waiting_approval') node.status = 'waiting_approval';
      else if (ev === 'node_cancelled') node.status = 'cancelled';
      else if (ev === 'node_retry') node.status = 'retrying';
      else if (ev === 'node_awaiting_clarify') node.status = 'waiting_clarify';
      else if (ev === 'node_clarified') node.status = 'pending';
    }
    if (ev === 'execute_start') task.status = 'running';
    else if (ev === 'execute_complete') task.status = 'success';
    else if (ev === 'execute_failed') task.status = 'failed';
    else if (ev === 'execute_cancelled') task.status = 'cancelled';
    else if (ev === 'execute_waiting_approval') task.status = 'waiting_approval';
    else if (ev === 'task_needs_clarification') task.status = 'clarifying';
    else if (ev === 'task_clarified') task.status = 'planned';
    // 永续开发（2026-09-15）：收尾阶段与自动重排事件驱动状态
    else if (ev === 'task_finalizing') task.status = 'finalizing';
  }

  // 2.2 节点心跳卡：实时执行态聚合
  // 注意：页面可能在节点启动之后才打开（错过 node_start）——delta/退避/换模/重试事件
  // 都要能自举创建 runtime 条目，否则打开晚的用户永远看不到心跳与直播（实测教训）
  if (p.task_id && p.node_id) {
    const r = RT(p);
    if (ev === 'node_start') {
      const nr = ensureRuntime(String(p.task_id), String(p.node_id), p.agent as string);
      nr.name = p.name as string;
      nr.startedAt = new Date().toISOString();
      nr.tokens = 0;
      nr.retryCount = 0;
      nr.backoffSec = undefined;
      nr.failoverFrom = undefined;
      nr.deltaText = undefined;
      nr.finishedAt = undefined;
    } else if (ev === 'agent_first_token' || ev === 'agent_delta' || ev === 'llm_backoff' || ev === 'model_failover' || ev === 'node_retry') {
      // 自举：无论是否见过 node_start，都补建条目（startedAt 缺省由任务水合回填）
      const nr = r || ensureRuntime(String(p.task_id), String(p.node_id), p.agent as string);
      if (ev === 'agent_first_token') {
        nr.model = p.model as string;
      } else if (ev === 'agent_delta') {
        nr.deltaText = String(p.text || '');
        nr.deltaAt = Date.now();
        if (p.model) nr.model = p.model as string;
      } else if (ev === 'node_retry') {
        nr.retryCount = Number(p.attempt || (nr.retryCount || 0) + 1);
      } else if (ev === 'llm_backoff') {
        nr.backoffSec = Number(p.backoff_sec || 0);
        nr.model = p.model as string;
      } else if (ev === 'model_failover') {
        nr.failoverFrom = String(p.model || '');
        nr.backoffSec = undefined;
      }
    } else if (r && ev === 'agent_round') {
      r.model = p.model as string;
      r.round = Number(p.round || r.round || 0);
      r.tokens = (r.tokens || 0) + Number(p.tokens || 0);
    } else if (r && ['node_complete', 'node_error', 'node_cancelled'].includes(ev)) {
      r.finishedAt = Date.now();
      r.deltaText = undefined;
    }
  }

  // fine-grained agent life events: keep the "what is it doing right now" line fresh
  if (p.agent && ['agent_activity', 'agent_round', 'agent_final'].includes(ev)) {
    const a = ensureAgent(p.agent as string);
    if (p.model) a.model = p.model as string;
    if (ev === 'agent_activity') a.currentAction = p.text as string;
    else if (ev === 'agent_round') a.currentAction = `第 ${p.round} 轮对话完成`;
    else if (ev === 'agent_final') a.currentAction = p.ok ? `汇报: ${String(p.summary || '').slice(0, 40)}` : `汇报失败: ${String(p.summary || '').slice(0, 40)}`;
  }

  if (p.agent && ['node_start', 'node_complete', 'node_error'].includes(ev)) {
    const agent = ensureAgent(p.agent as string);
    agent.history.unshift({ ts: msg.ts, text: p.name || ev, type: ev });
    if (agent.history.length > 50) agent.history.pop();
    if (ev === 'node_start') {
      agent.status = 'running';
      agent.task = { id: p.node_id as string, taskId: p.task_id as string, name: p.name as string };
      agent.taskCount += 1;
    } else if (ev === 'node_complete') {
      agent.status = 'done';
      agent.currentAction = '完成，等待主 Agent 下一步安排';
      if (agent.task && p.task_id) agent.task.taskId = p.task_id as string;
      agent.changes = (p.changes as string[]) || [];
      agent.changeCount += ((p.changes as string[]) || []).length;
    } else {
      agent.status = 'error';
      if (agent.task && p.task_id) agent.task.taskId = p.task_id as string;
      if (agent.task) agent.task.error = p.error as string;
    }
  }

  for (const cb of eventListeners) cb(msg);
}

let everConnected = false;
let wsOpenedAt = 0;
// P0.4 WS 假死检测：服务端每 15s 发 ping；45s 没收到任何消息即判定半开连接，
// 主动断开触发重连（TCP 半开时 onclose 可能几十分钟不触发——"发消息没反应"的主因）
let lastServerMsgAt = Date.now();
let pongWatchdog: ReturnType<typeof setInterval> | null = null;

/** token 被拒的探活：WS 快速被断时用当前凭据打一次 /api/status 确认 */
async function probeUnauthorized() {
  try {
    const t = localStorage.getItem('coteam-api-token') || '';
    const res = await fetch('/api/status', { headers: t ? { Authorization: `Bearer ${t}` } : {} });
    if (res.status === 401) window.dispatchEvent(new CustomEvent('coteam:unauthorized'));
  } catch { /* 服务器不可达不是鉴权问题 */ }
}

/** 断线重连成功：补拉全量数据（断线期间的事件已永久丢失，靠增量事件会陈旧） */
function resyncAfterReconnect() {
  void loadAgents();
  void loadTasks(taskPage.value, taskPageSize.value);
  // 会话消息不在增量事件补拉范围（ConvoView 监听后 refreshActive 全量拉取）
  window.dispatchEvent(new CustomEvent('coteam:convo-resync'));
  // P0.4：讨论同样补拉（此前只有会话有 resync，讨论断线后群聊卡片永远陈旧）
  window.dispatchEvent(new CustomEvent('coteam:discussion-resync'));
}

function ensurePongWatchdog() {
  if (pongWatchdog) return;
  pongWatchdog = setInterval(() => {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    if (Date.now() - lastServerMsgAt > 45_000) {
      try { ws.close(); } catch { /* onclose 触发重连 */ }
    }
  }, 10_000);
}

function connectWs() {
  // 已有在途/在连的 socket：幂等返回（reconnectWs 与 3s 重连定时器并发时防双连接）
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const t = localStorage.getItem('coteam-api-token') || '';
  ws = new WebSocket(`${proto}://${location.host}/ws/events${t ? `?token=${encodeURIComponent(t)}` : ''}`);
  ws.onopen = () => {
    connected.value = true;
    lastServerMsgAt = Date.now();
    const first = !everConnected;
    everConnected = true;
    wsOpenedAt = Date.now();
    if (!first) resyncAfterReconnect();
  };
  ws.onclose = () => {
    connected.value = false;
    // 建连后 2s 内即被断开：多半是 token 被拒，探活确认后弹 Token 门禁
    if (wsOpenedAt && Date.now() - wsOpenedAt < 2000) void probeUnauthorized();
    wsOpenedAt = 0;
    setTimeout(connectWs, 3000);
  };
  ws.onmessage = (e) => {
    lastServerMsgAt = Date.now();
    try {
      handleEvent(JSON.parse(e.data));
    } catch {
      /* ignore */
    }
  };
  ensurePongWatchdog();
  // P0.4：页面重新可见时若连接已死立即重连 + 补拉（后台标签页期间断线无 onclose）
  if (typeof document !== 'undefined' && !(document as any).__coteamVisibilityHooked) {
    (document as any).__coteamVisibilityHooked = true;
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState !== 'visible') return;
      lastServerMsgAt = Math.min(lastServerMsgAt, Date.now() - 40_000); // 触发下次 watchdog 检查
      if (!ws || ws.readyState !== WebSocket.OPEN) connectWs();
      else resyncAfterReconnect();
    });
  }
}

/** token 保存后热更新：立刻按新 token 重连 WS（此前旧连接一直用失效 token 到手动刷新页面） */
function reconnectWs() {
  if (!started || !ws) return;
  try { ws.close(); } catch { /* noop */ }
  connectWs();
}

/** Fetch one task by id and merge it into the tasks map — only when it matches the current filter, so the workbench list stays scoped. */
async function fetchSingleTask(taskId: string) {
  try {
    const t = await api.getTask(taskId);
    const external = !t.project_id;
    if (taskFilter?.scope === 'external' && !external) return;
    const normalized = { ...t, id: t.task_id } as unknown as TaskGraph;
    tasks[taskId] = normalized;
    for (const n of t.nodes || []) {
      if (!n.agent || n.agent === 'orchestrator') continue;
      const a = ensureAgent(n.agent);
      if (n.status === 'running' || n.status === 'retrying') {
        a.status = 'running';
        a.task = { id: n.id, taskId, name: n.name };
      }
    }
  } catch {
    /* ignore */
  }
}

async function loadTasks(page = 1, pageSize = 20, filter?: TaskListFilter) {
  if (filter) taskFilter = filter;
  try {
    const d = await api.listTasks(page, pageSize, taskFilter);
    taskTotal.value = d.total;
    taskPage.value = d.page;
    taskPageSize.value = d.pageSize;
    // Clear tasks and repopulate with current page
    for (const key of Object.keys(tasks)) delete tasks[key];
    for (const raw of d.tasks) {
      const t = raw as Record<string, any>;
      const taskId = String(t.task_id || t.id);
      if (!taskId) continue; // 空 id 条目会让下游轮询打出 /api/tasks//asks 404 噪音
      const normalized = { ...t, id: taskId, task_id: taskId } as unknown as TaskGraph;
      tasks[taskId] = normalized;
    }
    // hydrate agent card states from persisted node statuses
    for (const t of Object.values(tasks)) {
      for (const n of t.nodes || []) {
        if (!n.agent || n.agent === 'orchestrator') continue;
        const a = ensureAgent(n.agent);
        if (n.status === 'running' || n.status === 'retrying') {
          a.status = 'running';
          a.task = { id: n.id, taskId: t.task_id, name: n.name };
          // 2.2 水合：页面打开晚于节点启动时，从节点状态回填心跳卡（耗时从此刻起算）
          const k = `${t.task_id}:${n.id}`;
          if (!nodeRuntime[k]) {
            nodeRuntime[k] = { taskId: t.task_id, nodeId: n.id, agent: n.agent, name: n.name, startedAt: n.started_at };
          }
        } else if (n.status === 'failed') {
          if (a.status !== 'running') a.status = 'error';
        } else if (n.status === 'completed' && a.status === 'idle') {
          a.status = 'done';
        }
      }
    }
  } catch {
    /* ignore */
  }
}

async function loadAgents() {
  try {
    const d = await api.listAgents();
    for (const a of d.agents) {
      ensureAgent(a.name).role = a.role;
    }
  } catch {
    /* ignore */
  }
}

async function loadJournals(taskId: string) {
  const d = await api.taskJournals(taskId);
  return d.journals;
}

function ensureStarted() {
  if (started) return;
  started = true;
  connectWs();
  void loadAgents();
  void loadTasks();
}

/** Shared dashboard store — safe to call from any component; opens the WS only once. */
export function useDashboard() {
  ensureStarted();
  return { agents, tasks, events, connected, taskTotal, taskPage, taskPageSize, createStage, includeProjects, setTaskScope, loadTasks, loadAgents, loadJournals, onEvent, reconnectWs, getNodeRuntime, liveDelta, clearEvents: () => { events.value = []; } };
}
