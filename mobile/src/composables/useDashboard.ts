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
/** 2.1 生成直播（2026-09-15）：agent_delta 节流事件的末段文本，key `${taskId}:${nodeId}` */
const deltas = ref<Record<string, { text: string; at: number; model?: string }>>({});

const { ensureStarted, onEvent, onResync } = useWs();

let started = false;
const statusListeners = new Set<(t: TaskGraph) => void>();

/** 触发全量任务预取的生命周期事件（高频心跳 agent_round/progress_update/journal_append 不再打全量 GET） */
const REFRESH_EVENTS = new Set([
  'node_start', 'node_complete', 'node_error', 'node_retry', 'node_cancelled',
  'node_waiting_approval', 'node_awaiting_clarify', 'node_clarified', 'node_added',
  'execute_start', 'execute_failed', 'execute_waiting_approval',
  'task_needs_clarification', 'task_clarified', 'task_replanned', 'task_model_changed',
  'goal_updated', 'stage_started', 'acceptance_report',
  'task_finalizing', 'task_interrupted', 'queue_auto_requeue', 'stage_planning',
  'command_pending_approval', 'command_resolved',
  'ask_created', 'ask_resolved',
  'supervisor_proposal', 'supervisor_proposal_executed',
  'snapshot_created', 'snapshot_rolled_back',
]);

async function loadTasks(page = 1, q?: string) {
  const d = await api.listTasks(page, taskPageSize.value, q);
  taskTotal.value = d.total;
  taskPage.value = d.page;
  const map: Record<string, TaskGraph> = { ...tasks.value };
  for (const t of d.tasks) if (t.task_id) map[t.task_id] = t; // 空 id 条目会引发 /api/tasks//asks 404 轮询噪音
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
  if (tid && REFRESH_EVENTS.has(msg.type)) void fetchSingleTask(tid);
  if (msg.type === 'agent_delta' && tid && p.node_id) {
    deltas.value = {
      ...deltas.value,
      [`${tid}:${p.node_id}`]: { text: String(p.text || ''), at: Date.now(), model: p.model ? String(p.model) : undefined },
    };
    return;
  }
  if (tid && p.node_id && ['node_complete', 'node_error', 'node_cancelled'].includes(msg.type)) {
    if (deltas.value[`${tid}:${p.node_id}`]) {
      const next = { ...deltas.value };
      delete next[`${tid}:${p.node_id}`];
      deltas.value = next;
    }
  }
  if (msg.type.startsWith('node_') && tid && p.node_id) {
    const t = tasks.value[tid];
    if (t) {
      const nodes = t.nodes.map((n) => (n.id === p.node_id ? { ...n, status: p.status || n.status, error: p.error || n.error } : n));
      tasks.value = { ...tasks.value, [tid]: { ...t, nodes: nodes as TaskGraph['nodes'] } };
    }
  }
}

function putTask(t: TaskGraph) {
  tasks.value = { ...tasks.value, [t.task_id]: t };
  statusListeners.forEach((fn) => fn(t));
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
    loadTasks, fetchSingleTask, loadAgents, putTask,
    /** 2.1 生成直播：3s 内的 delta 视为"正在生成"，返回末段文本 */
    liveDelta(taskId: string, nodeId: string): string | null {
      const d = deltas.value[`${taskId}:${nodeId}`];
      if (!d || Date.now() - d.at >= 3000) return null;
      return d.text;
    },
    onEvent(fn: (msg: EventEnvelope) => void) { return onEvent(fn); },
    onResync(fn: () => void): () => void { return onResync(fn); },
    onTaskStatus(fn: (t: TaskGraph) => void): () => void {
      statusListeners.add(fn);
      return () => statusListeners.delete(fn);
    },
  };
}
