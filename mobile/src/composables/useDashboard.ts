/**
 * Module-level singleton store (same pattern as web's useDashboard, independent
 * implementation): tasks + agents + WS event fan-out for the mobile app.
 */

import { ref } from 'vue';
import { api, type TaskGraph, type AgentLiveState, type EventEnvelope } from '../api';
import { useWs } from './useWs';

const tasks = ref<Record<string, TaskGraph>>({});
const taskTotal = ref(0);
const taskPage = ref(1);
const taskPageSize = ref(20);
const agents = ref<Record<string, AgentLiveState>>({});
const connected = ref(false);

const { ensureStarted, onEvent, onResync } = useWs();

let started = false;
const statusListeners = new Set<(t: TaskGraph) => void>();

async function loadTasks(page = 1, q?: string) {
  const d = await api.listTasks(page, taskPageSize.value, q);
  taskTotal.value = d.total;
  taskPage.value = d.page;
  const map: Record<string, TaskGraph> = { ...tasks.value };
  for (const t of d.tasks) map[t.task_id] = t;
  tasks.value = map;
}

async function fetchSingleTask(taskId: string) {
  try {
    const t = await api.getTask(taskId);
    tasks.value = { ...tasks.value, [t.task_id]: t };
    statusListeners.forEach((fn) => fn(t));
  } catch { /* task may be deleted */ }
}

async function loadAgents() {
  try {
    const d = await api.agentProfiles();
    const map: Record<string, AgentLiveState> = {};
    for (const [name, p] of Object.entries(d.agents)) {
      map[name] = {
        name,
        status: (p as any).status || 'idle',
        model: (p as any).last_model,
        currentAction: '',
      };
    }
    agents.value = map;
  } catch { /* ignore */ }
}

function handleEvent(msg: EventEnvelope) {
  const p = msg.payload || {};
  const tid = p.task_id as string | undefined;

  if (msg.type === 'agent_activity' && p.agent) {
    const a = agents.value[p.agent as string] || { name: String(p.agent) };
    agents.value = {
      ...agents.value,
      [String(p.agent)]: { ...a, currentAction: String(p.text || ''), model: p.model ? String(p.model) : a.model },
    };
    return;
  }
  if (msg.type === 'agent_final' && p.agent) {
    const a = agents.value[p.agent as string];
    if (a) agents.value = { ...agents.value, [String(p.agent)]: { ...a, currentAction: '' } };
    return;
  }

  // task/node lifecycle events → refresh the affected task + bump live statuses
  if (tid) void fetchSingleTask(tid);
  if (msg.type.startsWith('node_') && tid && p.node_id) {
    const t = tasks.value[tid];
    if (t) {
      const nodes = t.nodes.map((n) => (n.id === p.node_id ? { ...n, status: p.status || n.status, error: p.error || n.error } : n));
      tasks.value = { ...tasks.value, [tid]: { ...t, nodes: nodes as TaskGraph['nodes'] } };
    }
  }
}

export function useDashboard() {
  if (!started) {
    started = true;
    ensureStarted();
    onEvent(handleEvent);
    void loadTasks();
    void loadAgents();
    // foreground resync: refresh whatever the missed frames changed
    onResync(() => {
      void loadTasks(taskPage.value);
      void loadAgents();
    });
  }
  return {
    tasks, taskTotal, taskPage, taskPageSize, agents, connected,
    loadTasks, fetchSingleTask, loadAgents,
    onEvent(fn: (msg: EventEnvelope) => void) { return onEvent(fn); },
    onResync(fn: () => void): () => void { return onResync(fn); },
    onTaskStatus(fn: (t: TaskGraph) => void): () => void {
      statusListeners.add(fn);
      return () => statusListeners.delete(fn);
    },
  };
}
