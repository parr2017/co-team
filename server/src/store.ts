import { busGet, busSet, busKeys, busDel, getBus } from './bus';
import { CHANNELS, ProjectMemoryItem, TaskGraph, TaskNode } from './types';

export function nowIso(): string {
  return new Date().toISOString().replace('T', ' ').split('.')[0];
}

export async function saveTaskGraph(
  taskId: string,
  nodes: TaskNode[],
  edges: [string, string][],
  meta?: { description?: string; workspace?: string; status?: string; project_id?: string }
): Promise<void> {
  const existing = await getTaskGraph(taskId);
  const graph: TaskGraph = {
    task_id: taskId,
    nodes,
    edges: edges.map((e) => [e[0], e[1]]),
    description: meta?.description ?? existing?.description ?? '',
    workspace: meta?.workspace ?? existing?.workspace ?? '',
    status: meta?.status ?? existing?.status ?? 'pending',
    project_id: meta?.project_id ?? existing?.project_id ?? undefined,
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

export interface PagedResult<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

export async function listTaskGraphsPaged(
  page = 1,
  pageSize = 20,
  filter?: { project_id?: string | null }
): Promise<PagedResult<TaskGraph>> {
  let allGraphs = await listTaskGraphs();
  if (filter && 'project_id' in filter) {
    allGraphs = allGraphs.filter((g) => (g.project_id ?? null) === (filter.project_id ?? null));
  }
  const total = allGraphs.length;
  const start = (page - 1) * pageSize;
  const items = allGraphs.slice(start, start + pageSize);
  return { items, total, page, pageSize };
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

/** Clear the cancel flag so a cancelled task can be executed again. */
export async function clearCancelled(taskId: string): Promise<void> {
  await busDel(`task:cancel:${taskId}`);
}

export async function getApprovals(taskId: string): Promise<string[]> {
  return (await busGet<string[]>(`task:approvals:${taskId}`)) || [];
}

// ---------- project mode ----------

export interface ProjectRecord {
  id: string;
  name: string;
  workspace: string;
  description?: string;
  created_at: string;
}

export async function saveProject(p: ProjectRecord): Promise<void> {
  await busSet(`project:${p.id}`, p);
}

export async function getProject(id: string): Promise<ProjectRecord | null> {
  return busGet<ProjectRecord>(`project:${id}`);
}

export async function listProjects(): Promise<ProjectRecord[]> {
  const keys = await busKeys('project:*');
  const out: ProjectRecord[] = [];
  for (const key of keys) {
    if (key.endsWith(':deleted')) continue;
    const p = await busGet<ProjectRecord>(key);
    if (p) out.push(p);
  }
  return out;
}

export async function addProjectMemory(projectId: string, text: string, kind: 'auto' | 'manual' = 'auto', taskId?: string): Promise<void> {
  if (!text) return;
  const key = `project:${projectId}:memory`;
  const items = (await busGet<ProjectMemoryItem[]>(key)) || [];
  items.push({ text, ts: new Date().toISOString(), kind, task_id: taskId });
  await busSet(key, items.slice(-50));
}

export async function getProjectMemory(projectId: string, limit = 10): Promise<ProjectMemoryItem[]> {
  const items = (await busGet<ProjectMemoryItem[]>(`project:${projectId}:memory`)) || [];
  return items.slice(-limit);
}

export async function listProjectTasks(projectId: string): Promise<TaskGraph[]> {
  const graphs = await listTaskGraphs();
  return graphs.filter((g) => g.project_id === projectId);
}

// ---------- agent life: memory, profile, task session journal ----------

export interface JournalEntry {
  role: 'master' | 'agent';
  kind: 'brief' | 'tool_results' | 'round' | 'final' | 'error';
  text: string;
  ts: string;
  node_id: string;
  node_name: string;
  model?: string;
  tokens?: number;
  meta?: Record<string, any>;
}

export async function appendJournal(taskId: string, agent: string, entry: JournalEntry): Promise<void> {
  const key = `task:${taskId}:agent:${agent}:journal`;
  const journal = (await busGet<JournalEntry[]>(key)) || [];
  journal.push(entry);
  await busSet(key, journal.slice(-120));
  // push the delta so chat surfaces stream live instead of polling
  await emitProgress('journal_append', { task_id: taskId, agent, entry });
}

export async function getTaskJournals(taskId: string): Promise<Record<string, JournalEntry[]>> {
  const keys = await busKeys(`task:${taskId}:agent:*:journal`);
  const journals: Record<string, JournalEntry[]> = {};
  for (const key of keys) {
    const agent = key.split(':')[3];
    journals[agent] = (await busGet<JournalEntry[]>(key)) || [];
  }
  return journals;
}

/** Per-agent cross-task lessons ("life experience"). */
export async function addAgentMemory(agent: string, lesson: string, maxItems = 15): Promise<void> {
  if (!lesson) return;
  const key = `agent:${agent}:memory`;
  const items = (await busGet<string[]>(key)) || [];
  items.push(lesson);
  await busSet(key, items.slice(-maxItems));
}

export async function getAgentMemory(agent: string, limit = 5): Promise<string[]> {
  const items = (await busGet<string[]>(`agent:${agent}:memory`)) || [];
  return items.slice(-limit);
}

export interface AgentProfileTask {
  task_id: string;
  description: string;
  node: string;
  status: string;
  ts: string;
  tokens?: number;
  model?: string;
}

export interface AgentProfile {
  name: string;
  tasks: AgentProfileTask[];
  stats: { total: number; success: number; failed: number; tokens: number };
  last_model?: string;
  last_active?: string;
}

export async function recordAgentTask(agent: string, task: AgentProfileTask): Promise<void> {
  const key = `agent:profile:${agent}`;
  const profile = (await busGet<AgentProfile>(key)) || {
    name: agent,
    tasks: [],
    stats: { total: 0, success: 0, failed: 0, tokens: 0 },
  };
  profile.tasks.push(task);
  profile.tasks = profile.tasks.slice(-30);
  profile.stats.total += 1;
  if (task.status === 'completed') profile.stats.success += 1;
  else if (task.status === 'failed') profile.stats.failed += 1;
  profile.stats.tokens += task.tokens || 0;
  profile.last_active = task.ts;
  if (task.model) profile.last_model = task.model;
  await busSet(key, profile);
}

export async function getAgentProfiles(): Promise<Record<string, AgentProfile>> {
  const keys = await busKeys('agent:profile:*');
  const profiles: Record<string, AgentProfile> = {};
  for (const key of keys) {
    const name = key.split(':')[2];
    profiles[name] = (await busGet<AgentProfile>(key)) || { name, tasks: [], stats: { total: 0, success: 0, failed: 0, tokens: 0 } };
  }
  return profiles;
}

// ---------- delete operations ----------

export async function deleteTask(taskId: string): Promise<void> {
  await busDel(`task:graph:${taskId}`);
  await busDel(`task:events:${taskId}`);
  await busDel(`task:cancel:${taskId}`);
  await busDel(`task:approvals:${taskId}`);
  await busDel(`task:feedbacks:${taskId}`);
  
  const journalKeys = await busKeys(`task:${taskId}:agent:*:journal`);
  for (const key of journalKeys) {
    await busDel(key);
  }
  
  const sessionKeys = await busKeys(`task:${taskId}:agent:*:session`);
  for (const key of sessionKeys) {
    await busDel(key);
  }
}
