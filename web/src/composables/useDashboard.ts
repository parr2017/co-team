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

export interface TaskListFilter {
  scope?: 'external';
  projectId?: string;
}

// ---------- module-level singleton store (one WS connection for the whole app) ----------
const agents = reactive<Record<string, AgentLiveState>>({});
const tasks = reactive<Record<string, TaskGraph>>({});
const events = ref<EventItem[]>([]);
const connected = ref(false);
const taskTotal = ref(0);
const taskPage = ref(1);
const taskPageSize = ref(20);
const eventListeners = new Set<(msg: EventEnvelope) => void>();
let ws: WebSocket | null = null;
let started = false;
let taskFilter: TaskListFilter | undefined = { scope: 'external' };

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

function handleEvent(msg: EventEnvelope) {
  const ev = msg.type || '';
  const p = msg.payload || {};
  events.value.unshift({ ts: msg.ts || new Date().toISOString(), type: ev, data: p });
  if (events.value.length > 200) events.value.pop();

  if (p.task_id && !tasks[p.task_id]) void fetchSingleTask(String(p.task_id));

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
    }
    if (ev === 'execute_start') task.status = 'running';
    else if (ev === 'execute_complete') task.status = 'success';
    else if (ev === 'execute_failed') task.status = 'failed';
    else if (ev === 'execute_cancelled') task.status = 'cancelled';
    else if (ev === 'execute_waiting_approval') task.status = 'waiting_approval';
    else if (ev === 'task_needs_clarification') task.status = 'clarifying';
    else if (ev === 'task_clarified') task.status = 'planned';
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

function connectWs() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}/ws/events`);
  ws.onopen = () => (connected.value = true);
  ws.onclose = () => {
    connected.value = false;
    setTimeout(connectWs, 3000);
  };
  ws.onmessage = (e) => {
    try {
      handleEvent(JSON.parse(e.data));
    } catch {
      /* ignore */
    }
  };
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
  return { agents, tasks, events, connected, taskTotal, taskPage, taskPageSize, loadTasks, loadAgents, loadJournals, onEvent, clearEvents: () => { events.value = []; } };
}
