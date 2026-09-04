import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { Hono } from 'hono';
import { WebSocket, WebSocketServer } from 'ws';
import type { Server } from 'node:http';
import { Orchestrator } from '../orchestrator/orchestrator';
import { ModelPool } from '../scheduler';
import { busGet, busKeys, busSet, getBus } from '../bus';
import { getTaskGraph, listTaskGraphs, listTaskGraphsPaged, persistGraph, saveTaskGraph, deleteTask } from '../store';
import { getTaskConversations } from '../transcript';
import { toAgentInfo } from '../agents';
import type { AppConfig, OrchestrationConfig } from '../config';
import type { TaskGraph, TaskNode } from '../types';
import { getLogger } from '../logger';

export interface ApiContext {
  config: AppConfig;
  orchestrator: Orchestrator;
  modelPool: ModelPool;
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

export function createApi(ctx: ApiContext): Hono {
  const app = new Hono();
  const logger = getLogger();

  const runInBackground = (taskId: string, workspace: string): void => {
    logger.info('Starting background task execution', { taskId, workspace });
    void (async () => {
      try {
        await ctx.orchestrator.execute(taskId, workspace);
        logger.info('Background task execution completed', { taskId });
      } catch (e: any) {
        const error = String(e).slice(0, 500);
        logger.error('Background task execution failed', { taskId, error });
        // surface the failure on the graph itself — a task must never be left 'running' or vanish from the list
        try {
          const { getTaskGraph, persistGraph } = await import('../store');
          const graph = await getTaskGraph(taskId);
          if (graph) {
            graph.status = 'failed';
            await persistGraph(graph);
          }
        } catch { /* best effort */ }
        await busSet(`task:graph:${taskId}:bg_error`, { error }).catch(() => {});
      }
    })();
  };

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
    const body = await c.req.json<{ name?: string; workspace?: string; description?: string }>();
    if (!body.name || !body.workspace) throw new HttpError(400, 'name and workspace are required');
    const workspace = validateWorkspace(body.workspace);
    const id = Math.random().toString(36).slice(2, 10);
    const { saveProject } = await import('../store');
    await saveProject({ id, name: body.name, workspace, description: body.description, created_at: new Date().toISOString() });
    return c.json({ status: 'created', project_id: id });
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
    const body = await c.req.json<{ description?: string; request?: string; workspace?: string; auto_run?: boolean; project_id?: string }>();
    const description = body.description || body.request || '';
    if (!description) throw new HttpError(400, 'description is required');
    const workspace = validateWorkspace(body.workspace || '');
    
    logger.info('Creating task', { description: description.slice(0, 100), workspace, auto_run: body.auto_run });
    
    const { taskId, graph } = await ctx.orchestrator.createTask(description, workspace, body.project_id);
    
    logger.info('Task created', { 
      taskId, 
      nodesCount: graph.nodes.length,
      edgesCount: graph.edges.length,
      auto_run: body.auto_run === true 
    });
    
    // tasks land in "planned" state waiting for user review in the plan review panel;
    // auto_run is opt-in for script/API callers
    if (body.auto_run === true) runInBackground(taskId, workspace);
    return c.json({ status: 'created', task_id: taskId, graph, auto_run: body.auto_run === true });
  });

  app.post('/api/tasks/:taskId/execute', async (c) => {
    const taskId = c.req.param('taskId');
    const graph = await getTaskGraph(taskId);
    if (!graph) throw new HttpError(404, 'task not found');
    const ws = validateWorkspace(c.req.query('workspace') || graph.workspace || '.');
    
    logger.info('Executing task', { taskId, workspace: ws });
    runInBackground(taskId, ws);
    
    return c.json({ status: 'started', task_id: taskId, workspace: ws });
  });

  app.post('/api/tasks/:taskId/cancel', async (c) => {
    const taskId = c.req.param('taskId');
    const graph = await getTaskGraph(taskId);
    if (!graph) throw new HttpError(404, 'task not found');
    await busSet(`task:cancel:${taskId}`, true);
    return c.json({ status: 'cancelling', task_id: taskId });
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
    runInBackground(taskId, ws);
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
    return c.json({ status: 'deleted', task_id: taskId });
  });

  app.get('/api/tasks', async (c) => {
    const page = parseInt(c.req.query('page') || '1');
    const pageSize = parseInt(c.req.query('pageSize') || '20');
    
    const scope = c.req.query('scope');
    const projectId = c.req.query('project_id');
    // scope=external → only tasks without a project (workbench ad-hoc tasks)
    const filter = scope === 'external' ? { project_id: null } : projectId ? { project_id: projectId } : undefined;
    const paged = await listTaskGraphsPaged(page, pageSize, filter);
    return c.json({
      tasks: paged.items.map((g: TaskGraph) => ({
        id: g.task_id,
        description: g.description,
        workspace: g.workspace,
        status: g.status,
        project_id: g.project_id ?? null,
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
    return c.json({ model_pool: ctx.config.model_pool });
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
    
    if (!body.name || !body.api_key || !body.base_url) {
      throw new HttpError(400, 'name, api_key and base_url are required');
    }

    const entry = makeEntry({
      name: body.name,
      api_key: body.api_key,
      base_url: body.base_url,
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
