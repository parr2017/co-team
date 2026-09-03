import { onMounted, onUnmounted, reactive, ref } from 'vue';
import { api, type EventEnvelope, type TaskGraph } from '../api';

export interface AgentLiveState {
  name: string;
  role: string;
  status: 'idle' | 'running' | 'done' | 'error';
  task: { id: string; taskId?: string; name: string; error?: string } | null;
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

export function useDashboard() {
  const agents = reactive<Record<string, AgentLiveState>>({});
  const tasks = reactive<Record<string, TaskGraph>>({});
  const events = ref<EventItem[]>([]);
  const connected = ref(false);
  let ws: WebSocket | null = null;
  let closed = false;
  const nodeLogsCache = reactive<Record<string, Record<string, import('../api').AgentConversation[]>>>({});

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

    if (p.task_id && !tasks[p.task_id]) void loadTasks();

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
        if (agent.task && p.task_id) agent.task.taskId = p.task_id as string;
        agent.changes = (p.changes as string[]) || [];
        agent.changeCount += ((p.changes as string[]) || []).length;
      } else {
        agent.status = 'error';
        if (agent.task && p.task_id) agent.task.taskId = p.task_id as string;
        if (agent.task) agent.task.error = p.error as string;
      }
    }
  }

  function connectWs() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    ws = new WebSocket(`${proto}://${location.host}/ws/events`);
    ws.onopen = () => (connected.value = true);
    ws.onclose = () => {
      connected.value = false;
      if (!closed) setTimeout(connectWs, 3000);
    };
    ws.onmessage = (e) => {
      try {
        handleEvent(JSON.parse(e.data));
      } catch {
        /* ignore */
      }
    };
  }

  async function loadTasks() {
    try {
      const d = await api.listTasks();
      for (const raw of d.tasks) {
        const t = raw as Record<string, any>;
        // list endpoint returns `id`; normalize so components can rely on task_id
        const taskId = String(t.task_id || t.id);
        const normalized = { ...t, id: taskId, task_id: taskId } as unknown as TaskGraph;
        if (!tasks[taskId]) tasks[taskId] = normalized;
        else Object.assign(tasks[taskId], normalized);
      }
      // hydrate agent card states from persisted node statuses so a fresh page
      // (or a WS reconnect) reflects reality instead of sitting on "idle"
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

  async function loadNodeLogs(taskId: string) {
    if (nodeLogsCache[taskId]) return nodeLogsCache[taskId];
    const d = await api.taskLogs(taskId);
    nodeLogsCache[taskId] = d.logs;
    return d.logs;
  }

  onMounted(() => {
    connectWs();
    void loadAgents();
    void loadTasks();
  });
  onUnmounted(() => {
    closed = true;
    ws?.close();
  });

  return { agents, tasks, events, connected, loadTasks, loadAgents, loadNodeLogs, clearEvents: () => { events.value = []; } };
}
