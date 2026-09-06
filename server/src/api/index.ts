import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { Hono } from 'hono';
import type { Context } from 'hono';
import { WebSocket, WebSocketServer } from 'ws';
import type { Server } from 'node:http';
import { Orchestrator } from '../orchestrator/orchestrator';
import { ModelPool } from '../scheduler';
import type { TaskQueueManager, QueueSnapshot } from '../taskQueue';
import { busGet, busKeys, busSet, busDel, getBus } from '../bus';
import { getTaskGraph, listTaskGraphs, listTaskGraphsPaged, persistGraph, saveTaskGraph, deleteTask, listProjects } from '../store';
import { getTaskConversations } from '../transcript';
import { toAgentInfo } from '../agents';
import type { AppConfig, OrchestrationConfig } from '../config';
import type { TaskGraph, TaskNode } from '../types';
import type { FeishuHandler } from '../feishu/webhook';
import { getLogger } from '../logger';

export interface ApiContext {
  config: AppConfig;
  orchestrator: Orchestrator;
  modelPool: ModelPool;
  taskQueue: TaskQueueManager;
}

function validateWorkspace(workspace: string): string {
  const ws = (workspace || '').trim().replace(/^"|"$/g, '');
  if (!ws) throw new HttpError(400, 'workspace is required');
  if (!path.isAbsolute(ws)) throw new HttpError(400, `workspace must be an absolute path, got: ${ws}`);
  return ws;
}

export class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

// GBK-tolerant JSON intake: clients in a GBK Windows console (e.g. curl from cmd)
// send Chinese as GBK bytes, which silently turn into mojibake when decoded as
// UTF-8 (lossy — the bytes are gone afterwards). Try strict UTF-8 first and fall
// back to GBK so task descriptions / knowledge titles stay readable.
const utf8Strict = new TextDecoder('utf-8', { fatal: true });
const gbkDecoder: TextDecoder | null = (() => {
  try { return new TextDecoder('gbk'); } catch { return null; }
})();

async function readJsonAuto<T>(c: Context): Promise<T> {
  const buf = await c.req.arrayBuffer();
  if (!buf.byteLength) return c.req.json<T>();
  let text: string;
  try {
    text = utf8Strict.decode(buf);
  } catch {
    text = gbkDecoder ? gbkDecoder.decode(buf) : new TextDecoder().decode(buf);
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    return c.req.json<T>();
  }
}

export function createApi(ctx: ApiContext): Hono {
  const app = new Hono();
  const logger = getLogger();

  // all task executions go through the project queue: same project runs one task at
  // a time, different projects run concurrently, failures block the lane until resumed

  app.onError((err, c) => {
    const status = err instanceof HttpError ? err.status : 500;
    logger.error('API error', { error: err.message, status, stack: err.stack });
    return c.json({ detail: err.message }, status as any);
  });

  // 请求日志中间件
  app.use('*', async (c, next) => {
    const start = Date.now();
    const method = c.req.method;
    const path = new URL(c.req.url).pathname;
    
    await next();
    
    const duration = Date.now() - start;
    const status = c.res.status;
    
    if (status >= 400) {
      logger.warn('API request failed', { method, path, status, duration });
    } else if (path.startsWith('/api/')) {
      logger.debug('API request', { method, path, status, duration });
    }
  });

  // ---------- projects ----------

  app.post('/api/projects', async (c) => {
    const body = await readJsonAuto<{ name?: string; workspace?: string; description?: string; scaffold?: boolean }>(c);
    if (!body.name || !body.workspace) throw new HttpError(400, 'name and workspace are required');
    const workspace = validateWorkspace(body.workspace);
    const id = Math.random().toString(36).slice(2, 10);
    const { saveProject } = await import('../store');
    await saveProject({ id, name: body.name, workspace, description: body.description, created_at: new Date().toISOString() });
    // standard initialization workflow: scaffold dirs + structured docs + git repo
    let scaffoldResult = null;
    try {
      if (body.scaffold) {
        const { scaffoldProject } = await import('../scaffold');
        scaffoldResult = await scaffoldProject(workspace, { name: body.name, description: body.description });
      } else {
        const { initGitOnly } = await import('../scaffold');
        await initGitOnly(workspace);
      }
    } catch (e: any) {
      logger.warn('Project git/scaffold initialization failed (project still created)', { id, error: String(e?.message || e) });
    }
    return c.json({ status: 'created', project_id: id, scaffold: scaffoldResult });
  });

  app.get('/api/projects', async (c) => {
    const { listProjects, listProjectTasks, getProjectMemory } = await import('../store');
    const projects = await listProjects();
    const out = [];
    for (const p of projects) {
      const tasks = await listProjectTasks(p.id);
      const memory = await getProjectMemory(p.id, 50);
      const done = tasks.filter((t) => t.status === 'success').length;
      out.push({
        ...p,
        task_count: tasks.length,
        done_count: done,
        running: tasks.some((t) => t.status === 'running'),
        issues: memory.filter((m) => m.text.startsWith('问题:')).length,
        updated_at: tasks[0]?.updated_at || p.created_at,
      });
    }
    out.sort((a, b) => (b.updated_at || '').localeCompare(a.updated_at || ''));
    return c.json({ projects: out });
  });

  app.get('/api/projects/:id', async (c) => {
    const { getProject, listProjectTasks, getProjectMemory } = await import('../store');
    const id = c.req.param('id');
    const info = await getProject(id);
    if (!info) throw new HttpError(404, 'project not found');
    const tasks = await listProjectTasks(id);
    const memory = await getProjectMemory(id, 50);
    return c.json({ ...info, tasks, memory });
  });

  app.post('/api/projects/:id/memory', async (c) => {
    const { addProjectMemory } = await import('../store');
    const id = c.req.param('id');
    const body = await c.req.json<{ text?: string }>();
    if (!body.text) throw new HttpError(400, 'text is required');
    await addProjectMemory(id, body.text, 'manual');
    return c.json({ status: 'added' });
  });

  // ---------- tasks ----------

  app.post('/api/tasks', async (c) => {
    const body = await readJsonAuto<{
      description?: string; request?: string; workspace?: string; auto_run?: boolean; project_id?: string;
      main_model_id?: string; level?: string; skip_clarification?: boolean;
    }>(c);
    const description = body.description || body.request || '';
    if (!description) throw new HttpError(400, 'description is required');
    const workspace = validateWorkspace(body.workspace || '');
    // a task pointing at a nonexistent project would silently vanish from every project view
    if (body.project_id) {
      const { getProject } = await import('../store');
      if (!(await getProject(body.project_id))) throw new HttpError(404, `project not found: ${body.project_id}`);
    }

    logger.info('Creating task', {
      description: description.slice(0, 100), workspace, auto_run: body.auto_run,
      main_model_id: body.main_model_id, level: body.level,
    });

    const { taskId, graph, needsClarification, questions, summary, level } = await ctx.orchestrator.createTask(description, workspace, body.project_id, {
      mainModelId: body.main_model_id,
      level: body.level,
    });

    logger.info('Task created', {
      taskId,
      nodesCount: graph.nodes.length,
      edgesCount: graph.edges.length,
      auto_run: body.auto_run === true,
      needsClarification: !!needsClarification,
      level,
    });

    // clarification gate (improvement 5): never auto-run an unclarified task
    if (needsClarification) {
      return c.json({ status: 'needs_clarification', task_id: taskId, questions: questions || [], summary, level });
    }

    // tasks land in "planned" state waiting for user review in the plan review panel;
    // auto_run is opt-in for script/API callers
    let queue: QueueSnapshot | null = null;
    if (body.auto_run === true) queue = await ctx.taskQueue.enqueue(taskId, body.project_id ?? null, workspace);
    return c.json({ status: 'created', task_id: taskId, graph, auto_run: body.auto_run === true, level, queue });
  });

  // improvement 5: clarification loop — human answers, then explicit confirmation
  app.post('/api/tasks/:taskId/clarify', async (c) => {
    const taskId = c.req.param('taskId');
    const body = await c.req.json<{ answers?: { question: string; answer: string }[]; confirm?: boolean; text?: string }>();
    try {
      const result = await ctx.orchestrator.clarify(taskId, body);
      return c.json({ task_id: taskId, ...result });
    } catch (e: any) {
      throw new HttpError(400, String(e.message || e));
    }
  });

  // improvement 11: mid-task main-agent model change (user-initiated)
  app.put('/api/tasks/:taskId/model', async (c) => {
    const taskId = c.req.param('taskId');
    const body = await c.req.json<{ model_id?: string }>();
    if (!body.model_id) throw new HttpError(400, 'model_id is required');
    try {
      const result = await ctx.orchestrator.setMainModel(taskId, body.model_id);
      return c.json({ task_id: taskId, ...result });
    } catch (e: any) {
      throw new HttpError(400, String(e.message || e));
    }
  });

  // improvement 9: global goal query / update
  app.get('/api/tasks/:taskId/goal', async (c) => {
    const taskId = c.req.param('taskId');
    const graph = await getTaskGraph(taskId);
    if (!graph) throw new HttpError(404, 'task not found');
    return c.json({ task_id: taskId, ...(await ctx.orchestrator.getGoal(taskId)) });
  });

  app.put('/api/tasks/:taskId/goal', async (c) => {
    const taskId = c.req.param('taskId');
    const body = await c.req.json<{ content?: string }>();
    if (!body.content) throw new HttpError(400, 'content is required');
    try {
      const result = await ctx.orchestrator.updateGoal(taskId, body.content);
      return c.json({ task_id: taskId, ...result });
    } catch (e: any) {
      throw new HttpError(400, String(e.message || e));
    }
  });

  // improvement 6: human-side progress query (real-time snapshot, no polling of events)
  app.get('/api/tasks/:taskId/progress', async (c) => {
    const taskId = c.req.param('taskId');
    const graph = await getTaskGraph(taskId);
    if (!graph) throw new HttpError(404, 'task not found');
    const { computeProgress } = await import('../progress');
    return c.json(computeProgress(graph));
  });

  app.post('/api/tasks/:taskId/execute', async (c) => {
    const taskId = c.req.param('taskId');
    const graph = await getTaskGraph(taskId);
    if (!graph) throw new HttpError(404, 'task not found');
    const ws = validateWorkspace(c.req.query('workspace') || graph.workspace || '.');
    
    logger.info('Executing task', { taskId, workspace: ws });
    const queue = await ctx.taskQueue.enqueue(taskId, graph.project_id ?? null, ws);

    return c.json({ status: 'started', task_id: taskId, workspace: ws, queue });
  });

  app.post('/api/tasks/:taskId/cancel', async (c) => {
    const taskId = c.req.param('taskId');
    const graph = await getTaskGraph(taskId);
    if (!graph) throw new HttpError(404, 'task not found');
    await busSet(`task:cancel:${taskId}`, true);
    // a cancelled task must not stay in the queue — drop it from the pending tail
    await ctx.taskQueue.removePending(taskId);
    return c.json({ status: 'cancelling', task_id: taskId });
  });

  // ---------- task queues (project-scoped execution lanes) ----------

  app.get('/api/queues', async (c) => {
    return c.json({ queues: ctx.taskQueue.snapshots() });
  });

  app.post('/api/queues/:key/resume', async (c) => {
    const key = c.req.param('key');
    try {
      logger.info('Resuming task queue', { key });
      return c.json({ status: 'resumed', queue: ctx.taskQueue.resume(key) });
    } catch (e: any) {
      throw new HttpError(404, String(e?.message || e));
    }
  });

  app.post('/api/queues/:key/clear', async (c) => {
    const key = c.req.param('key');
    try {
      logger.info('Clearing task queue', { key });
      const queue = await ctx.taskQueue.clear(key);
      return c.json({ status: 'cleared', queue });
    } catch (e: any) {
      throw new HttpError(404, String(e?.message || e));
    }
  });

  // improvement 6 (R1): message-style intervention — queue a user message for the
  // agent's next conversation round; surfaces in the war room as a green bubble
  app.post('/api/tasks/:taskId/intervene', async (c) => {
    const taskId = c.req.param('taskId');
    const body = await c.req.json<{ message?: string }>();
    const message = (body.message || '').trim();
    if (!message) throw new HttpError(400, 'message is required');
    const graph = await getTaskGraph(taskId);
    if (!graph) throw new HttpError(404, 'task not found');
    if (!['running', 'pending', 'planned', 'retrying', 'waiting_approval'].includes(graph.status)) {
      throw new HttpError(400, `task is not running (status: ${graph.status}), intervention will never be consumed`);
    }
    const { pushIntervention, appendJournal, emitProgress } = await import('../store');
    const item = await pushIntervention(taskId, message);
    // war-room journal: the user's message appears immediately as a master-side bubble
    await appendJournal(taskId, 'orchestrator', {
      role: 'master',
      kind: 'intervene',
      text: message,
      ts: item.ts,
      node_id: 'intervene',
      node_name: '用户介入',
      meta: { intervention_id: item.id },
    });
    await emitProgress('user_intervened', { task_id: taskId, message: message.slice(0, 500), intervention_id: item.id });
    const { notify } = await import('../notify');
    notify('user_intervened', { task_id: taskId }, `[Co-Team] 用户向任务 ${taskId} 发送介入指示：${message.slice(0, 80)}`);
    return c.json({ status: 'queued', task_id: taskId, intervention_id: item.id, note: '将在 Agent 下一轮对话注入' });
  });

  app.post('/api/tasks/:taskId/approve/:nodeId', async (c) => {
    const taskId = c.req.param('taskId');
    const nodeId = c.req.param('nodeId');
    const graph = await getTaskGraph(taskId);
    if (!graph) throw new HttpError(404, 'task not found');
    const approvals = (await busGet<string[]>(`task:approvals:${taskId}`)) || [];
    if (!approvals.includes(nodeId)) approvals.push(nodeId);
    await busSet(`task:approvals:${taskId}`, approvals);
    const ws = graph.workspace || '.';
    await ctx.taskQueue.enqueue(taskId, graph.project_id ?? null, ws);
    return c.json({ status: 'approved', task_id: taskId, node_id: nodeId });
  });

  app.get('/api/tasks/:taskId', async (c) => {
    const graph = await getTaskGraph(c.req.param('taskId'));
    if (!graph) throw new HttpError(404, 'task not found');
    return c.json(graph);
  });

  app.delete('/api/tasks/:taskId', async (c) => {
    const taskId = c.req.param('taskId');
    const graph = await getTaskGraph(taskId);
    if (!graph) throw new HttpError(404, 'task not found');
    await deleteTask(taskId);
    await busDel(`task:clarify:${taskId}`);
    await busDel(`task:goal:${taskId}`);
    await busDel(`ssot:docs:${taskId}`);
    return c.json({ status: 'deleted', task_id: taskId });
  });

  app.get('/api/tasks', async (c) => {
    const page = parseInt(c.req.query('page') || '1');
    const pageSize = parseInt(c.req.query('pageSize') || '20');

    const scope = c.req.query('scope');
    const projectId = c.req.query('project_id');
    const q = c.req.query('q') || undefined;
    // scope=external → only tasks without a project (workbench ad-hoc tasks)
    const filter = scope === 'external' ? { project_id: null, q } : projectId ? { project_id: projectId, q } : q ? { q } : undefined;
    const paged = await listTaskGraphsPaged(page, pageSize, filter);
    return c.json({
      tasks: paged.items.map((g: TaskGraph) => ({
        task_id: g.task_id,
        id: g.task_id,
        description: g.description,
        workspace: g.workspace,
        status: g.status,
        project_id: g.project_id ?? null,
        level: g.level ?? null,
        main_model_id: g.main_model_id ?? null,
        nodes: g.nodes,
        edges: g.edges,
        created_at: g.created_at,
        updated_at: g.updated_at,
      })),
      total: paged.total,
      page: paged.page,
      pageSize: paged.pageSize,
    });
  });

  app.get('/api/tasks/:taskId/logs', async (c) => {
    const taskId = c.req.param('taskId');
    return c.json({ task_id: taskId, logs: await getTaskConversations(taskId) });
  });

  app.get('/api/tasks/:taskId/events', async (c) => {
    const { getTaskEvents } = await import('../store');
    const taskId = c.req.param('taskId');
    return c.json({ task_id: taskId, events: await getTaskEvents(taskId) });
  });

  app.get('/api/tasks/:taskId/journals', async (c) => {
    const { getTaskJournals } = await import('../store');
    const taskId = c.req.param('taskId');
    return c.json({ task_id: taskId, journals: await getTaskJournals(taskId) });
  });

  // ---------- node deliverables (统一模板交付成果) ----------

  app.get('/api/tasks/:taskId/deliverables', async (c) => {
    const { listDeliverables } = await import('../deliverable');
    const taskId = c.req.param('taskId');
    return c.json({ task_id: taskId, deliverables: await listDeliverables(taskId) });
  });

  app.get('/api/tasks/:taskId/deliverables/:nodeId', async (c) => {
    const { getDeliverable } = await import('../deliverable');
    const taskId = c.req.param('taskId');
    const d = await getDeliverable(taskId, c.req.param('nodeId'));
    if (!d) throw new HttpError(404, 'deliverable not found');
    return c.json({ task_id: taskId, ...d });
  });

  app.get('/api/agents/profiles', async (c) => {
    const { getAgentProfiles, getAgentMemory } = await import('../store');
    const profiles = await getAgentProfiles();
    // merge yaml identity so the UI can render person cards without extra calls
    const merged = await Object.fromEntries(
      await Promise.all(
        [...ctx.orchestrator.plugins.values()].map(async (p) => [
          p.name,
          {
            name: p.name,
            role: p.role,
            description: p.description,
            tags: p.tags,
            version: p.version,
            timeout: p.timeout,
            memory: (await getAgentMemory(p.name, 8).catch(() => [])) || [],
            profile: profiles[p.name] || { name: p.name, tasks: [], stats: { total: 0, success: 0, failed: 0, tokens: 0 } },
          },
        ])
      )
    );
    return c.json({ agents: merged });
  });

  app.post('/api/tasks/:taskId/replan', async (c) => {
    const taskId = c.req.param('taskId');
    const body = await c.req.json<{ feedback?: string }>().catch(() => ({ feedback: '' }));
    try {
      const graph = await ctx.orchestrator.replan(taskId, body.feedback || '');
      return c.json({ status: 'replanned', summary: graph.summary, graph });
    } catch (e: any) {
      throw new HttpError(400, String(e.message || e));
    }
  });

  app.put('/api/tasks/:taskId/nodes/:nodeId', async (c) => {
    const taskId = c.req.param('taskId');
    const nodeId = c.req.param('nodeId');
    const body = await c.req.json<{ name?: string; agent?: string; action?: 'delete' }>();
    const graph = await getTaskGraph(taskId);
    if (!graph) throw new HttpError(404, 'task not found');
    const node = graph.nodes.find((n) => n.id === nodeId);
    if (!node) throw new HttpError(404, 'node not found');

    if (body.action === 'delete') {
      graph.nodes = graph.nodes.filter((n) => n.id !== nodeId);
      graph.edges = graph.edges.filter(([a, b]) => a !== nodeId && b !== nodeId);
    } else {
      if (body.name) node.name = body.name;
      if (body.agent) {
        if (body.agent !== 'orchestrator' && !ctx.orchestrator.plugins.has(body.agent)) {
          throw new HttpError(400, `unknown agent: ${body.agent}`);
        }
        node.agent = body.agent;
      }
    }
    // keep the auto merge node waiting on every agent node
    const merge = graph.nodes.find((n) => n.id === 'merge-auto');
    if (merge) {
      graph.edges = graph.edges.filter(([, dst]) => dst !== 'merge-auto');
      for (const n of graph.nodes) {
        if (n.id !== 'merge-auto' && n.agent !== 'orchestrator') {
          graph.edges.push([n.id, 'merge-auto']);
        }
      }
    }
    await persistGraph(graph);
    return c.json({ status: 'updated', graph });
  });

  app.get('/api/system/roadmap', async (c) => {
    const { PROJECT_ROOT } = await import('../config');
    const fs = await import('node:fs');
    const path = await import('node:path');
    const file = path.join(PROJECT_ROOT, '开发路线.md');
    if (!fs.existsSync(file)) throw new HttpError(404, 'roadmap file not found');
    return c.json({ content: fs.readFileSync(file, 'utf-8'), updated_at: fs.statSync(file).mtime.toISOString() });
  });

  // ---------- knowledge base (improvement 3) ----------

  app.get('/api/knowledge', async (c) => {
    const { listKnowledge, searchKnowledgeHybrid, listStaleKnowledge } = await import('../knowledge');
    const category = c.req.query('category') as 'general-tech' | 'project' | undefined;
    const projectId = c.req.query('project_id') || undefined;
    const q = c.req.query('q') || '';
    const limit = parseInt(c.req.query('limit') || '50');
    const query = { category, project_id: projectId, limit };
    // governance: stale-candidate listing (updated_at older than stale_days)
    if (c.req.query('stale') === '1') {
      const days = parseInt(c.req.query('days') || String(ctx.config.knowledge?.stale_days ?? 90), 10) || 90;
      return c.json({ stale_days: days, entries: listStaleKnowledge(days, query) });
    }
    if (q) {
      // hybrid: keyword score + embedding cosine (degrades to keyword-only without a model)
      return c.json({ entries: await searchKnowledgeHybrid(q, query) });
    }
    return c.json({ entries: listKnowledge(query) });
  });

  app.post('/api/knowledge', async (c) => {
    const { writeKnowledge, listKnowledge, categoryDir } = await import('../knowledge');
    const body = await readJsonAuto<{ title?: string; content?: string; category?: string; project_id?: string; tags?: string[] }>(c);
    if (!body.title || !body.content) throw new HttpError(400, 'title and content are required');
    try {
      // governance: semantic near-duplicate — when the embedding model is configured,
      // a ≥0.95 cosine match updates the existing entry instead of creating a copy
      if ((await import('../embeddings')).embeddingEnabled()) {
        const embeddings = await import('../embeddings');
        const category = body.category === 'project' ? 'project' as const : 'general-tech' as const;
        const candidates = listKnowledge({ category, project_id: body.project_id });
        const vectors = await embeddings.ensureEntryVectors(candidates, (e) => categoryDir(e.category, e.project_id));
        const qv = await embeddings.embedQuery(`${body.title}\n${body.content}`);
        let best: { id: string; sim: number } | null = null;
        for (const e of candidates) {
          const v = vectors.get(e.id);
          if (!v || !qv) continue;
          const sim = embeddings.cosine(qv, v);
          if (!best || sim > best.sim) best = { id: e.id, sim };
        }
        if (best && best.sim >= 0.95) {
          const result = writeKnowledge({
            title: candidates.find((e) => e.id === best!.id)!.title,
            content: body.content,
            category,
            project_id: body.project_id,
            tags: body.tags,
            source: 'user',
          });
          return c.json({ status: 'updated', id: result.id, duplicate: true, similarity: Math.round(best.sim * 1000) / 1000 });
        }
      }
      const result = writeKnowledge({
        title: body.title,
        content: body.content,
        category: body.category === 'project' ? 'project' : 'general-tech',
        project_id: body.project_id,
        tags: body.tags,
        source: 'user',
      });
      return c.json({ status: result.updated ? 'updated' : 'created', id: result.id });
    } catch (e: any) {
      throw new HttpError(400, String(e.message || e));
    }
  });

  app.get('/api/knowledge/:id', async (c) => {
    const { getKnowledge } = await import('../knowledge');
    const entry = getKnowledge(c.req.param('id'));
    if (!entry) throw new HttpError(404, 'knowledge entry not found');
    return c.json(entry);
  });

  app.put('/api/knowledge/:id', async (c) => {
    const { updateKnowledge } = await import('../knowledge');
    const body = await c.req.json<{ title?: string; content?: string; tags?: string[] }>();
    const updated = updateKnowledge(c.req.param('id'), body);
    if (!updated) throw new HttpError(404, 'knowledge entry not found');
    return c.json({ status: 'updated', entry: updated });
  });

  app.delete('/api/knowledge/:id', async (c) => {
    const { deleteKnowledge } = await import('../knowledge');
    const ok = deleteKnowledge(c.req.param('id'));
    if (!ok) throw new HttpError(404, 'knowledge entry not found');
    return c.json({ status: 'deleted', id: c.req.param('id') });
  });

  // ---------- snapshots (improvement 10) ----------

  app.get('/api/snapshots', async (c) => {
    const { listSnapshots } = await import('../snapshot');
    const taskId = c.req.query('task_id') || undefined;
    const tag = c.req.query('tag') || undefined;
    return c.json({ snapshots: await listSnapshots({ task_id: taskId, tag }) });
  });

  app.post('/api/snapshots', async (c) => {
    const { createSnapshot } = await import('../snapshot');
    const body = await c.req.json<{ task_id?: string; tag?: string; note?: string }>();
    if (!body.task_id) throw new HttpError(400, 'task_id is required');
    const graph = await getTaskGraph(body.task_id);
    if (!graph) throw new HttpError(404, 'task not found');
    try {
      const meta = await createSnapshot(body.task_id, { tag: body.tag || 'manual', note: body.note });
      return c.json({ status: 'created', snapshot: meta });
    } catch (e: any) {
      throw new HttpError(400, String(e.message || e));
    }
  });

  app.post('/api/snapshots/:id/rollback', async (c) => {
    const { rollbackSnapshot } = await import('../snapshot');
    const body = await c.req.json<{ confirm?: boolean }>().catch(() => ({ confirm: false }));
    try {
      const result = await rollbackSnapshot(c.req.param('id'), { confirmed: body.confirm === true });
      return c.json(result);
    } catch (e: any) {
      throw new HttpError(400, String(e.message || e));
    }
  });

  app.get('/api/snapshots/audit', async (c) => {
    const { getAuditLog } = await import('../snapshot');
    return c.json({ audit: await getAuditLog() });
  });

  // ---------- agents ----------

  app.get('/api/agents', (c) => {
    return c.json({ agents: [...ctx.orchestrator.plugins.values()].map(toAgentInfo) });
  });

  app.get('/api/agents/definitions', async (c) => {
    const { listAgentDirs, readAgentDefinition } = await import('../configStore');
    const defs = listAgentDirs(ctx.config.agents_dir).map((dir) => readAgentDefinition(ctx.config.agents_dir, dir));
    return c.json({ agents: defs });
  });

  app.post('/api/agents', async (c) => {
    const { writeAgentDefinition } = await import('../configStore');
    const body = await c.req.json();
    const dirName = writeAgentDefinition(ctx.config.agents_dir, null, body);
    const names = await ctx.orchestrator.reloadAgents();
    return c.json({ status: 'created', agent: dirName, agents: names });
  });

  app.put('/api/agents/:dirName', async (c) => {
    const { writeAgentDefinition } = await import('../configStore');
    const dirName = c.req.param('dirName');
    const body = await c.req.json();
    const newDir = writeAgentDefinition(ctx.config.agents_dir, dirName, { ...body, name: body.name || dirName });
    const names = await ctx.orchestrator.reloadAgents();
    return c.json({ status: 'updated', agent: newDir, agents: names });
  });

  app.delete('/api/agents/:dirName', async (c) => {
    const { deleteAgent } = await import('../configStore');
    deleteAgent(ctx.config.agents_dir, c.req.param('dirName'));
    const names = await ctx.orchestrator.reloadAgents();
    return c.json({ status: 'deleted', agents: names });
  });

  app.post('/api/agents/reload', async (c) => {
    const names = await ctx.orchestrator.reloadAgents();
    return c.json({ status: 'reloaded', agents: names });
  });

  // ---------- config management ----------

  app.get('/api/config/model-pool', (c) => {
    // health info rides along so the UI model picker can show availability (improvement 11)
    return c.json({ model_pool: ctx.config.model_pool, health: ctx.modelPool.getStatus() });
  });

  app.put('/api/config/model-pool', async (c) => {
    const { saveModelPool } = await import('../configStore');
    const body = await c.req.json<{ model_pool?: any[] }>();
    const pool = body.model_pool;
    if (!Array.isArray(pool)) throw new HttpError(400, 'model_pool must be an array');
    for (const m of pool) {
      if (!m.name || !m.api_key || !m.base_url) throw new HttpError(400, 'each model needs name, api_key and base_url');
    }
    saveModelPool(pool);
    ctx.config.model_pool = pool;
    ctx.modelPool.replaceModels(pool);
    return c.json({ status: 'saved', model_pool: pool });
  });

  app.post('/api/config/model-pool/test', async (c) => {
    const { chat } = await import('../llm');
    const { makeEntry } = await import('../scheduler');
    const body = await c.req.json<{ name?: string; api_key?: string; base_url?: string }>();

    if (!body.name) throw new HttpError(400, 'name is required');

    // name-only form: test an already-configured pool entry without re-entering its key
    let apiKey = body.api_key;
    let baseUrl = body.base_url;
    if (!apiKey || !baseUrl) {
      const existing = ctx.modelPool.getModel(body.name);
      if (!existing) throw new HttpError(404, `model not in pool: ${body.name} (api_key/base_url required for unknown models)`);
      apiKey = apiKey || existing.api_key;
      baseUrl = baseUrl || existing.base_url;
    }

    const entry = makeEntry({
      name: body.name,
      api_key: apiKey,
      base_url: baseUrl,
    });

    const start = Date.now();
    try {
      const result = await chat(entry, [{ role: 'user', content: 'ping' }], 32, 0);
      return c.json({
        ok: true,
        latency_ms: Date.now() - start,
        model: body.name,
        response_preview: result.content.slice(0, 100),
      });
    } catch (e: any) {
      return c.json({
        ok: false,
        error: String(e.message || e).slice(0, 300),
        latency_ms: Date.now() - start,
      }, 400);
    }
  });

  // ---------- project progress & cost report (进度成本表) ----------

  app.get('/api/projects/:id/report', async (c) => {
    const { getProject, listProjectTasks } = await import('../store');
    const { listDeliverables } = await import('../deliverable');
    const id = c.req.param('id');
    const project = await getProject(id);
    if (!project) throw new HttpError(404, 'project not found');

    const tasks = await listProjectTasks(id);
    const taskRows = [];
    for (const t of tasks) {
      // node deliverables (统一模板交付成果) keyed by node for the report table
      const delivs = await listDeliverables(t.task_id);
      const delivByNode = new Map(delivs.map((d) => [d.node_id, d]));
      const nodes = t.nodes.map((n) => {
        const tokens = n.result?.tokens || 0;
        const model = n.result?.model || null;
        const durationSec = n.started_at
          ? Math.max(0, Math.round(((n.finished_at ? new Date(n.finished_at).getTime() : Date.now()) - new Date(n.started_at).getTime()) / 1000))
          : 0;
        const deliv = delivByNode.get(n.id);
        return {
          node_id: n.id,
          name: n.name,
          agent: n.agent,
          status: n.status,
          retry_count: n.retry_count || 0,
          model,
          tokens,
          duration_sec: durationSec,
          started_at: n.started_at || null,
          finished_at: n.finished_at || null,
          deliverable: deliv ? { node_name: deliv.node_name, markdown: deliv.markdown, ts: deliv.ts } : null,
        };
      });
      taskRows.push({
        task_id: t.task_id,
        description: t.description,
        status: t.status,
        level: t.level ?? null,
        created_at: t.created_at,
        updated_at: t.updated_at,
        tokens: nodes.reduce((s, n) => s + n.tokens, 0),
        duration_sec: nodes.reduce((s, n) => s + n.duration_sec, 0),
        nodes,
      });
    }

    const allNodes = taskRows.flatMap((t) => t.nodes);
    const totals = {
      tasks: taskRows.length,
      tasks_success: taskRows.filter((t) => t.status === 'success').length,
      tasks_failed: taskRows.filter((t) => t.status === 'failed').length,
      tasks_running: taskRows.filter((t) => ['running', 'retrying', 'pending', 'waiting_approval'].includes(t.status)).length,
      nodes: allNodes.length,
      nodes_completed: allNodes.filter((n) => n.status === 'completed').length,
      nodes_failed: allNodes.filter((n) => n.status === 'failed').length,
      retries: allNodes.reduce((s, n) => s + n.retry_count, 0),
      tokens: allNodes.reduce((s, n) => s + n.tokens, 0),
      duration_sec: allNodes.reduce((s, n) => s + n.duration_sec, 0),
      deliverables: allNodes.filter((n) => n.deliverable).length,
    };
    taskRows.sort((a, b) => (b.updated_at || '').localeCompare(a.updated_at || ''));
    return c.json({ project: { id: project.id, name: project.name, workspace: project.workspace }, totals, tasks: taskRows });
  });

  // ---------- agent skills (SKILL.md convention) ----------

  app.get('/api/skills', async (c) => {
    const { getSkills, reloadSkills } = await import('../skills');
    const { PROJECT_ROOT } = await import('../config');
    const globalDir = path.join(PROJECT_ROOT, 'skills');
    reloadSkills(ctx.config.agents_dir, globalDir);
    const skills = getSkills();
    const bindings: Record<string, string[]> = {};
    for (const p of ctx.orchestrator.plugins.values()) bindings[p.name] = p.skills || [];
    return c.json({ skills, bindings });
  });

  app.post('/api/skills', async (c) => {
    const { writeSkill, reloadSkills, getSkills } = await import('../skills');
    const { PROJECT_ROOT } = await import('../config');
    const globalDir = path.join(PROJECT_ROOT, 'skills');
    const body = await c.req.json<{ name?: string; description?: string; tags?: string[]; content?: string }>();
    if (!body.name?.trim()) throw new HttpError(400, 'name is required');
    try {
      writeSkill(globalDir, { name: body.name, description: body.description, tags: body.tags, content: body.content });
    } catch (e: any) {
      throw new HttpError(400, String(e.message || e));
    }
    reloadSkills(ctx.config.agents_dir, globalDir);
    return c.json({ status: 'created', total: getSkills().length });
  });

  app.put('/api/skills/:name', async (c) => {
    const { writeSkill, reloadSkills, getSkills } = await import('../skills');
    const { PROJECT_ROOT } = await import('../config');
    const globalDir = path.join(PROJECT_ROOT, 'skills');
    const name = c.req.param('name');
    const existing = getSkills().find((s) => s.name === name);
    if (!existing) throw new HttpError(404, 'skill not found');
    const body = await c.req.json<{ description?: string; tags?: string[]; content?: string; name?: string }>();
    writeSkill(globalDir, {
      name: body.name || name,
      description: body.description ?? existing.description,
      tags: body.tags ?? existing.tags,
      content: body.content ?? existing.body,
      originalName: name,
    });
    reloadSkills(ctx.config.agents_dir, globalDir);
    return c.json({ status: 'updated' });
  });

  app.delete('/api/skills/:name', async (c) => {
    const { deleteSkill, reloadSkills } = await import('../skills');
    const { PROJECT_ROOT } = await import('../config');
    const globalDir = path.join(PROJECT_ROOT, 'skills');
    if (!deleteSkill(globalDir, c.req.param('name'))) throw new HttpError(404, 'skill not found in global library');
    reloadSkills(ctx.config.agents_dir, globalDir);
    return c.json({ status: 'deleted' });
  });

  app.post('/api/skills/reload', async (c) => {
    const { reloadSkills, getSkills } = await import('../skills');
    const { PROJECT_ROOT } = await import('../config');
    const skills = reloadSkills(ctx.config.agents_dir, path.join(PROJECT_ROOT, 'skills'));
    return c.json({ status: 'reloaded', total: skills.length, skills: skills.map((s) => ({ name: s.name, source: s.source })) });
  });

  // ---------- feishu bot (event subscription mode) ----------

  if (ctx.config.feishu?.app_id && ctx.config.feishu.app_secret) {
    let handlerP: Promise<FeishuHandler> | null = null;
    const getHandler = () => {
      handlerP ||= import('../feishu/webhook').then((m) =>
        m.createFeishuHandler(ctx.config.feishu!, {
          createTask: (description, workspace, projectId, opts) =>
            ctx.orchestrator.createTask(description, workspace, projectId, { level: opts?.level }).then((r) => ({
              taskId: r.taskId,
              needsClarification: r.needsClarification,
              questions: r.questions,
            })),
          enqueue: (taskId, projectId, workspace) => ctx.taskQueue.enqueue(taskId, projectId, workspace),
          listProjects: async () => (await listProjects()).map((p) => ({ id: p.id, name: p.name, workspace: p.workspace })),
          listAgentNames: () => [...ctx.orchestrator.plugins.keys()],
        })
      );
      return handlerP;
    };
    app.post('/api/feishu/webhook', async (c) => (await getHandler()).handle(c));
    logger.info('Feishu bot webhook mounted at /api/feishu/webhook', { app_id: ctx.config.feishu.app_id });
  }

  // ---------- status / metrics / fs ----------

  app.get('/api/status', (c) => {
    return c.json({
      status: 'running',
      time: new Date().toISOString(),
      model_pool: ctx.modelPool.getStatus(),
      agents_dir: ctx.config.agents_dir,
      tokens_total: ctx.modelPool.totalTokens(),
      cost_total: ctx.modelPool.totalCost(),
    });
  });

  app.get('/api/metrics', async (c) => {
    const agentStats: Record<string, { tasks: number; completed: number; failed: number; retries: number; tokens: number }> = {};
    let tasksTotal = 0;
    let tasksSuccess = 0;
    for (const graph of await listTaskGraphs()) {
      tasksTotal += 1;
      if (graph.status === 'success') tasksSuccess += 1;
      for (const node of graph.nodes) {
        const agent = node.agent || 'unknown';
        const stat = (agentStats[agent] ||= { tasks: 0, completed: 0, failed: 0, retries: 0, tokens: 0 });
        stat.tasks += 1;
        if (node.status === 'completed') stat.completed += 1;
        else if (node.status === 'failed') stat.failed += 1;
        stat.retries += node.retry_count || 0;
        stat.tokens += 0; // per-node token usage lives in conversations
      }
    }
    return c.json({
      tasks: {
        total: tasksTotal,
        success: tasksSuccess,
        success_rate: tasksTotal ? Math.round((tasksSuccess / tasksTotal) * 1000) / 1000 : 0,
      },
      agents: agentStats,
      model_pool: ctx.modelPool.getStatus(),
      token_usage: ctx.modelPool.getUsage(),
      tokens_total: ctx.modelPool.totalTokens(),
      cost_total: ctx.modelPool.totalCost(),
    });
  });

  app.get('/api/fs', async (c) => {
    const query = (c.req.query('path') || '').trim();
    if (!query) {
      const home = os.homedir();
      const drives: { name: string; path: string }[] = [];
      if (process.platform === 'win32') {
        for (const letter of 'ABCDEFGHIJKLMNOPQRSTUVWXYZ') {
          const drive = `${letter}:\\`;
          if (fs.existsSync(drive)) drives.push({ name: drive, path: drive });
        }
      }
      return c.json({ path: '', parent: null, dirs: drives, shortcuts: [{ name: '主目录', path: home }] });
    }
    let p = path.resolve(query);
    if (!fs.existsSync(p)) throw new HttpError(404, `path not found: ${query}`);
    if (fs.statSync(p).isFile()) p = path.dirname(p);
    const dirs: { name: string; path: string }[] = [];
    try {
      for (const entry of fs.readdirSync(p, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        if (!entry.isDirectory()) continue;
        if (entry.name.startsWith('.') || entry.name.startsWith('$')) continue;
        dirs.push({ name: entry.name, path: path.join(p, entry.name) });
        if (dirs.length >= 300) break;
      }
    } catch {
      /* permission denied: return what we have */
    }
    const parent = path.dirname(p);
    return c.json({ path: p, parent: parent === p ? null : parent, dirs, shortcuts: [] });
  });

  return app;
}

export function attachWebSocket(server: Server, dashboardChannel: string): WebSocketServer {
  const wss = new WebSocketServer({ noServer: true });
  const clients = new Set<WebSocket>();

  server.on('upgrade', (request: any, socket: any, head: any) => {
    const url = new URL(request.url, 'http://localhost');
    if (url.pathname !== '/ws/events') return;
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit('connection', ws, request);
    });
  });

  wss.on('connection', (ws) => {
    clients.add(ws);
    const unsubscribe = getBus().subscribe(dashboardChannel, (msg) => {
      try {
        ws.send(JSON.stringify(msg));
      } catch {
        /* client gone */
      }
    });
    const ping = setInterval(() => {
      try {
        ws.send('{"type":"ping"}');
      } catch {
        /* noop */
      }
    }, 15_000);
    ws.on('close', () => {
      clients.delete(ws);
      clearInterval(ping);
      unsubscribe();
    });
  });

  return wss;
}

export type { TaskNode };
export { saveTaskGraph, persistGraph };
