import { busGet, busSet, busKeys, getBus } from './bus';
import { CHANNELS, TaskGraph, TaskNode } from './types';

export function nowIso(): string {
  return new Date().toISOString().replace('T', ' ').split('.')[0];
}

export async function saveTaskGraph(
  taskId: string,
  nodes: TaskNode[],
  edges: [string, string][],
  meta?: { description?: string; workspace?: string; status?: string }
): Promise<void> {
  const existing = await getTaskGraph(taskId);
  const graph: TaskGraph = {
    task_id: taskId,
    nodes,
    edges: edges.map((e) => [e[0], e[1]]),
    description: meta?.description ?? existing?.description ?? '',
    workspace: meta?.workspace ?? existing?.workspace ?? '',
    status: meta?.status ?? existing?.status ?? 'pending',
    created_at: existing?.created_at ?? new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
  await busSet(`task:graph:${taskId}`, graph);
}

export async function getTaskGraph(taskId: string): Promise<TaskGraph | null> {
  return busGet<TaskGraph>(`task:graph:${taskId}`);
}

export async function persistGraph(graph: TaskGraph): Promise<void> {
  graph.updated_at = new Date().toISOString();
  await busSet(`task:graph:${graph.task_id}`, graph);
}

export async function listTaskGraphs(): Promise<TaskGraph[]> {
  const keys = (await busKeys('task:graph:*')).filter((k) => !k.includes(':bg_error'));
  const graphs: TaskGraph[] = [];
  for (const key of keys) {
    const g = await getTaskGraph(key.replace('task:graph:', ''));
    if (g) graphs.push(g);
  }
  graphs.sort((a, b) => (b.updated_at || '').localeCompare(a.updated_at || ''));
  return graphs;
}

export async function emitEvent(channel: string, type: string, payload: Record<string, unknown>): Promise<void> {
  const event = { type, ts: new Date().toISOString(), payload };
  getBus().publish(channel, event);
}

export async function emitProgress(type: string, payload: Record<string, unknown>): Promise<void> {
  await emitEvent(CHANNELS.TASK, type, payload);
  await emitEvent(CHANNELS.DASHBOARD, type, payload);
  const taskId = payload.task_id as string | undefined;
  if (taskId) await recordTaskEvent(taskId, type, payload);
}

const MAX_TASK_EVENTS = 200;

/** Persist a task-lifecycle event so timelines survive page refreshes. */
export async function recordTaskEvent(taskId: string, type: string, payload: Record<string, unknown>): Promise<void> {
  const key = `task:events:${taskId}`;
  const events = (await busGet<{ type: string; ts: string; payload: Record<string, unknown> }[]>(key)) || [];
  events.push({ type, ts: new Date().toISOString(), payload });
  await busSet(key, events.slice(-MAX_TASK_EVENTS));
}

export async function getTaskEvents(taskId: string): Promise<{ type: string; ts: string; payload: Record<string, unknown> }[]> {
  return (await busGet(`task:events:${taskId}`)) || [];
}

const MEMORY_KEY = 'coteam:memory:lessons';

export async function addMemory(lesson: string, maxItems = 20): Promise<void> {
  if (!lesson) return;
  const lessons = (await busGet<{ ts: string; lesson: string }[]>(MEMORY_KEY)) || [];
  lessons.push({ ts: new Date().toISOString(), lesson });
  await busSet(MEMORY_KEY, lessons.slice(-maxItems));
}

export async function getMemory(limit = 10): Promise<string[]> {
  const lessons = (await busGet<{ ts: string; lesson: string }[]>(MEMORY_KEY)) || [];
  return lessons.slice(-limit).map((l) => l.lesson);
}

export async function isCancelled(taskId: string): Promise<boolean> {
  return !!(await busGet(`task:cancel:${taskId}`));
}

export async function getApprovals(taskId: string): Promise<string[]> {
  return (await busGet<string[]>(`task:approvals:${taskId}`)) || [];
}
