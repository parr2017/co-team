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
import { listAsks, resolveAsk } from '../askGate';
import { getTaskGraph, listTaskGraphs, listTaskGraphsPaged, persistGraph, saveTaskGraph, deleteTask, listProjects } from '../store';
import { getTaskConversations } from '../transcript';
import { toAgentInfo } from '../agents';
import { mergeTaskBranch } from '../git';
import { DiscussionError } from '../discussion';
import { WorkspaceError, assertStandaloneWorkspace, slugifyProjectName, prepareSelfdevClone, removeSelfdev } from '../workspace';
import { getDocRegistry } from '../ssot';
import { listFiles, readFile } from '../tools';
import { isIgnoredRelPath } from '../sandbox';
import type { AppConfig, OrchestrationConfig } from '../config';
import { PROJECT_ROOT } from '../config';
import type { TaskGraph, TaskNode } from '../types';
import type { FeishuHandler } from '../feishu/webhook';
import { getLogger } from '../logger';

export interface ApiContext {
  config: AppConfig;
  orchestrator: Orchestrator;
  modelPool: ModelPool;
  taskQueue: TaskQueueManager;
  /** feature: 每日问题报告 — scanner handle so the PUT config route can hot-reload it */
  dailyReportScanner?: { reload(enabled: boolean, hour: number): void };
}

/** A4 简单模式: safe default whitelist for auto-exec when the user didn't pick a policy. */
const SIMPLE_MODE_WHITELIST = ['node', 'npm', 'npx', 'git', 'python', 'python3', 'pip', 'pytest', 'ls', 'dir', 'cat', 'type', 'mkdir', 'echo'];

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
    // DiscussionError/WorkspaceError carry their own HTTP status (409 busy / 400 validation / ...)
    const status = err instanceof HttpError || err instanceof DiscussionError || err instanceof WorkspaceError ? err.status : 500;
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

  /** 项目治理：根目录 + slug 建议，供双端 UI 预填 */
  app.get('/api/projects/root', async (c) => {
    const p = ctx.config.projects;
    return c.json({ root: p?.root || path.resolve(PROJECT_ROOT, '..', 'projects'), selfdev_root: p?.selfdev_root || '' });
  });

  app.post('/api/projects', async (c) => {
    const body = await readJsonAuto<{ name?: string; workspace?: string; description?: string; scaffold?: boolean; allow_self_ref?: boolean }>(c);
    if (!body.name) throw new HttpError(400, 'name is required');
    // 缺省工作区 = projects.root/<slug(name)>：项目天然拥有独立目录
    const rawWs = (body.workspace || '').trim() || path.join(ctx.config.projects?.root || path.resolve(PROJECT_ROOT, '..', 'projects'), slugifyProjectName(body.name));
    const workspace = await assertStandaloneWorkspace(validateWorkspace(rawWs), {
      allowSelfRef: body.allow_self_ref === true,
      projectRoot: PROJECT_ROOT,
    });
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
      main_model_id?: string; level?: string; skip_clarification?: boolean; plan_async?: boolean;
      execution_policy?: { level?: string; whitelist_commands?: string[] }; node_clarify?: string;
      profile?: 'simple' | 'expert';
      fix_for?: { task_id?: string; node_id?: string };
      allow_self_ref?: boolean;
    }>(c);
    const description = body.description || body.request || '';
    if (!description) throw new HttpError(400, 'description is required');
    // 任务工作区同样受治理：不得落在 co-team 仓库内（除非显式自指），不得嵌套在其他仓库
    const workspace = await assertStandaloneWorkspace(validateWorkspace(body.workspace || ''), {
      allowSelfRef: body.allow_self_ref === true,
      projectRoot: PROJECT_ROOT,
    });
    // A4 模式档位: simple mode bundles completion-first defaults so non-experts just
    // submit a description — clarification skipped, no per-node brief gate, safe
    // whitelist auto-exec, auto-run after planning.
    const simpleMode = body.profile === 'simple';
    // a task pointing at a nonexistent project would silently vanish from every project view
    if (body.project_id) {
      const { getProject } = await import('../store');
      if (!(await getProject(body.project_id))) throw new HttpError(404, `project not found: ${body.project_id}`);
    }
    if (body.node_clarify && !['off', 'brief', 'confirm'].includes(body.node_clarify)) {
      throw new HttpError(400, 'node_clarify must be off | brief | confirm');
    }

    logger.info('Creating task', {
      description: description.slice(0, 100), workspace, auto_run: body.auto_run,
      main_model_id: body.main_model_id, level: body.level,
      execution_policy: body.execution_policy?.level, node_clarify: body.node_clarify,
      fix_for: body.fix_for?.task_id,
    });

    const { taskId, graph, needsClarification, questions, summary, level } = await ctx.orchestrator.createTask(description, workspace, body.project_id, {
      mainModelId: body.main_model_id,
      level: body.level,
      executionPolicy: body.execution_policy ?? (simpleMode ? { level: 'whitelist_auto', whitelist_commands: SIMPLE_MODE_WHITELIST } : undefined),
      nodeClarify: (body.node_clarify ?? (simpleMode ? 'off' : undefined)) as any,
      planAsync: body.plan_async === true,
      skipClarification: simpleMode || body.skip_clarification === true,
      allowSelfRef: body.allow_self_ref === true,
      autoRun: body.auto_run === true || (simpleMode && body.auto_run !== false),
    });

    // P0-2: defect-fix backlink — a task created to fix a defect links to its source node
    if (body.fix_for?.task_id) {
      const fresh = await getTaskGraph(taskId);
      if (fresh) {
        fresh.fix_for = { task_id: body.fix_for.task_id, node_id: body.fix_for.node_id || '' };
        await persistGraph(fresh);
      }
    }

    logger.info('Task created', {
      taskId,
      nodesCount: graph.nodes.length,
      edgesCount: graph.edges.length,
      auto_run: body.auto_run === true,
      needsClarification: !!needsClarification,
      level,
    });

    // plan_async (mobile): assessment/planning run in the background — the task graph
    // already exists in `pending`; clients follow it via WS events or GET /api/tasks/:id
    if (body.plan_async === true) {
      return c.json({ status: 'pending', task_id: taskId, level });
    }

    // clarification gate (improvement 5): never auto-run an unclarified task
    if (needsClarification) {
      return c.json({ status: 'needs_clarification', task_id: taskId, questions: questions || [], summary, level });
    }

    // tasks land in "planned" state waiting for user review in the plan review panel;
    // auto_run is opt-in for script/API callers — simple mode defaults to auto-run
    let queue: QueueSnapshot | null = null;
    if (body.auto_run === true || (simpleMode && body.auto_run !== false)) queue = await ctx.taskQueue.enqueue(taskId, body.project_id ?? null, workspace);
    return c.json({ status: 'created', task_id: taskId, graph, auto_run: body.auto_run === true, level, queue });
  });

  // improvement 5: clarification loop — human answers, then explicit confirmation
  // plan_async (mobile): the request returns before any LLM work ('assessing' | 'pending')
  app.post('/api/tasks/:taskId/clarify', async (c) => {
    const taskId = c.req.param('taskId');
    const body = await c.req.json<{ answers?: { question: string; answer: string }[]; confirm?: boolean; text?: string; plan_async?: boolean }>();
    try {
      const result = await ctx.orchestrator.clarify(taskId, {
        answers: body.answers,
        confirm: body.confirm,
        text: body.text,
        planAsync: body.plan_async === true,
      });
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

  // ---------- A3 验收合并闭环: one-click merge of the task deliverable branch ----------

  app.post('/api/tasks/:taskId/merge', async (c) => {
    const taskId = c.req.param('taskId');
    const body = await readJsonAuto<{ target?: string; dry_run?: boolean }>(c).catch(() => ({}) as { target?: string; dry_run?: boolean });
    const graph = await getTaskGraph(taskId);
    if (!graph) throw new HttpError(404, 'task not found');
    if (graph.status !== 'success') throw new HttpError(400, `任务未成功完成（当前: ${graph.status}），无可合并成果`);
    const workspace = validateWorkspace(graph.workspace || '.');
    const taskBranch = `coteam/task-${taskId}`;
    const result = await mergeTaskBranch(workspace, taskBranch, body.target, body.dry_run === true);
    logger.info('Task merge', { taskId, ...result });
    return c.json({ task_id: taskId, ...result });
  });

  // ---------- A2 协同文档列表/预览/导出 ----------

  app.get('/api/tasks/:taskId/docs', async (c) => {
    const taskId = c.req.param('taskId');
    const registry = await getDocRegistry(taskId);
    return c.json({
      task_id: taskId,
      docs: registry.map((d) => ({
        type: d.type,
        path: d.path,
        version: d.version,
        updated_at: d.updated_at,
        updated_by: d.updated_by,
        content: d.content,
      })),
    });
  });

  // ---------- A1 实时产出视图: browse the task's working sandbox read-only ----------

  app.get('/api/tasks/:taskId/output', async (c) => {
    const taskId = c.req.param('taskId');
    const graph = await getTaskGraph(taskId);
    if (!graph) throw new HttpError(404, 'task not found');
    const sandbox = graph.sandbox_path;
    if (!sandbox || !fs.existsSync(sandbox)) {
      return c.json({ task_id: taskId, sandbox_path: sandbox || null, available: false, files: [] });
    }
    const files = listFiles(sandbox, 500).filter((f) => !isIgnoredRelPath(f));
    return c.json({ task_id: taskId, sandbox_path: sandbox, available: true, files });
  });

  app.get('/api/tasks/:taskId/output/file', async (c) => {
    const taskId = c.req.param('taskId');
    const graph = await getTaskGraph(taskId);
    if (!graph) throw new HttpError(404, 'task not found');
    const sandbox = graph.sandbox_path;
    if (!sandbox || !fs.existsSync(sandbox)) throw new HttpError(410, '任务工作副本不存在（沙箱已清理）');
    const rel = c.req.query('path') || '';
    const result = readFile(sandbox, rel);
    if (!result.ok) throw new HttpError(400, result.error || 'cannot read file');
    return c.json({ task_id: taskId, path: rel, content: result.content ?? '' });
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

  // M2 全员实时问答：用户回答 agent 的阻塞式提问（ask_user），等待中的节点立即被唤醒
  app.post('/api/tasks/:taskId/asks/:askId/answer', async (c) => {
    const taskId = c.req.param('taskId');
    const askId = c.req.param('askId');
    const body = await c.req.json<{ answer?: string }>();
    const answer = (body.answer || '').trim();
    if (!answer) throw new HttpError(400, 'answer is required');
    const asks = await listAsks(taskId);
    const rec = asks.find((a) => a.id === askId);
    if (!rec) throw new HttpError(404, 'ask not found');
    if (rec.status !== 'pending') throw new HttpError(400, `ask already settled (status: ${rec.status})`);
    const okDone = await resolveAsk(askId, taskId, answer, 'user');
    if (!okDone) throw new HttpError(409, 'ask is no longer being waited on');
    return c.json({ ok: true, ask_id: askId, task_id: taskId });
  });

  app.get('/api/tasks/:taskId/asks', async (c) => {
    const taskId = c.req.param('taskId');
    return c.json({ asks: await listAsks(taskId) });
  });

  app.post('/api/tasks/:taskId/approve/:nodeId', async (c) => {
    const taskId = c.req.param('taskId');
    const nodeId = c.req.param('nodeId');
    const graph = await getTaskGraph(taskId);
    if (!graph) throw new HttpError(404, 'task not found');
    const approvals = (await busGet<string[]>(`task:approvals:${taskId}`)) || [];
    if (!approvals.includes(nodeId)) approvals.push(nodeId);
    await busSet(`task:approvals:${taskId}`, approvals);
    // 空 workspace 不再兜底成 '.'（服务进程 CWD=co-team，会把任务 git 操作落进自身仓库）
    const ws = validateWorkspace(graph.workspace || '');
    await ctx.taskQueue.enqueue(taskId, graph.project_id ?? null, ws);
    return c.json({ status: 'approved', task_id: taskId, node_id: nodeId });
  });

  // feature: 实施前澄清 — 用户查看节点简报后确认/答复，节点回到待执行
  app.post('/api/tasks/:taskId/nodes/:nodeId/clarify', async (c) => {
    const taskId = c.req.param('taskId');
    const nodeId = c.req.param('nodeId');
    const body = await readJsonAuto<{ approve?: boolean; answers?: { question: string; answer: string }[]; text?: string }>(c);
    try {
      const result = await ctx.orchestrator.clarifyNode(taskId, nodeId, body);
      const graph = await getTaskGraph(taskId);
      if (result.status === 'pending' && graph) {
        await ctx.taskQueue.enqueue(taskId, graph.project_id ?? null, validateWorkspace(graph.workspace || ''));
      }
      return c.json({ task_id: taskId, node_id: nodeId, ...result });
    } catch (e: any) {
      throw new HttpError(400, String(e.message || e));
    }
  });

  // feature: 实施前澄清 — 读取节点简报与用户答复
  app.get('/api/tasks/:taskId/nodes/:nodeId/clarify', async (c) => {
    const taskId = c.req.param('taskId');
    const nodeId = c.req.param('nodeId');
    const state = await busGet(`task:node:clarify:${taskId}:${nodeId}`);
    if (!state) throw new HttpError(404, 'no clarify state for this node');
    return c.json({ task_id: taskId, node_id: nodeId, ...state });
  });

  // feature: 命令执行分级 — 查看/调整任务的执行策略
  app.get('/api/tasks/:taskId/policy', async (c) => {
    const graph = await getTaskGraph(c.req.param('taskId'));
    if (!graph) throw new HttpError(404, 'task not found');
    return c.json({ task_id: graph.task_id, execution_policy: graph.execution_policy ?? null });
  });

  app.put('/api/tasks/:taskId/policy', async (c) => {
    const taskId = c.req.param('taskId');
    const body = await readJsonAuto<{ level?: string | null; whitelist_commands?: string[] }>(c);
    const graph = await getTaskGraph(taskId);
    if (!graph) throw new HttpError(404, 'task not found');
    const { isPermissionLevel } = await import('../sandbox');
    if (body.level !== null && body.level !== undefined && body.level !== '' && !isPermissionLevel(body.level)) {
      throw new HttpError(400, 'level must be plan_only | readonly | approve_required | whitelist_auto | full');
    }
    if (body.level === null || body.level === '') {
      graph.execution_policy = undefined;
    } else {
      graph.execution_policy = {
        level: isPermissionLevel(body.level) ? body.level : graph.execution_policy?.level || 'approve_required',
        ...(body.whitelist_commands ? { whitelist_commands: body.whitelist_commands.map(String) } : {}),
      };
    }
    await persistGraph(graph);
    return c.json({ status: 'updated', task_id: taskId, execution_policy: graph.execution_policy ?? null });
  });

  // feature: 命令执行分级 — 任务级待审批命令队列
  app.get('/api/tasks/:taskId/pending-commands', async (c) => {
    const taskId = c.req.param('taskId');
    return c.json({ task_id: taskId, commands: (await busGet(`task:pending_commands:${taskId}`)) || [] });
  });

  app.post('/api/tasks/:taskId/commands/:commandId/approve', async (c) => {
    const taskId = c.req.param('taskId');
    const commandId = c.req.param('commandId');
    const body = await readJsonAuto<{ approved?: boolean }>(c);
    try {
      const result = await ctx.orchestrator.resolvePendingCommand(taskId, commandId, body.approved !== false);
      return c.json({ task_id: taskId, command_id: commandId, ...result });
    } catch (e: any) {
      throw new HttpError(400, String(e.message || e));
    }
  });

  // P0-2: convert a structured defect from a node's result into a fix task with a backlink
  app.post('/api/tasks/:taskId/defects/convert', async (c) => {
    const taskId = c.req.param('taskId');
    const body = await c.req.json<{ node_id?: string; defect_index?: number; auto_run?: boolean }>();
    if (!body.node_id) throw new HttpError(400, 'node_id is required');
    const graph = await getTaskGraph(taskId);
    if (!graph) throw new HttpError(404, 'task not found');
    const node = graph.nodes.find((n) => n.id === body.node_id);
    if (!node) throw new HttpError(404, 'node not found');
    const defectIndex = body.defect_index ?? 0;
    const defect = node.result?.defects?.[defectIndex];
    if (!defect) throw new HttpError(400, `defect not found at index ${defectIndex} on node ${body.node_id}`);

    const description = [
      `[缺陷修复] 来源任务 ${taskId} 节点「${node.name}」发现的缺陷：${defect.title}`,
      '',
      `缺陷描述：${defect.detail}`,
      defect.severity ? `严重程度：${defect.severity}` : '',
      '',
      '请先定位根因，再做最小修复，并运行相关测试验证修复有效。',
    ].filter(Boolean).join('\n');

    logger.info('Converting defect to fix task', { taskId, node_id: body.node_id, defect_index: defectIndex, title: defect.title });
    const { taskId: fixTaskId, needsClarification, questions } = await ctx.orchestrator.createTask(description, graph.workspace, graph.project_id, {
      mainModelId: graph.main_model_id,
      level: 'standard',
    });

    let queue: QueueSnapshot | null = null;
    if (!needsClarification) {
      const fresh = await getTaskGraph(fixTaskId);
      if (fresh) {
        fresh.fix_for = { task_id: taskId, node_id: body.node_id };
        await persistGraph(fresh);
      }
      if (body.auto_run === true) {
        queue = await ctx.taskQueue.enqueue(fixTaskId, graph.project_id ?? null, graph.workspace);
      }
    }
    const { appendJournal, emitProgress } = await import('../store');
    await appendJournal(taskId, 'orchestrator', {
      role: 'master',
      kind: 'brief',
      text: `缺陷「${defect.title}」已转化为修复任务 ${fixTaskId}${needsClarification ? '（等待需求澄清）' : ''}`,
      ts: new Date().toISOString(),
      node_id: body.node_id,
      node_name: node.name,
      meta: { fix_task_id: fixTaskId },
    });
    await emitProgress('defect_converted', { task_id: taskId, node_id: body.node_id, fix_task_id: fixTaskId, defect: defect.title });
    return c.json({
      status: needsClarification ? 'needs_clarification' : 'created',
      fix_task_id: fixTaskId,
      fix_for: { task_id: taskId, node_id: body.node_id },
      questions: questions || [],
      queue,
    });
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

  // 自指任务的隔离克隆：任务删除后由人显式清理（保留期内可审阅/并回成果）
  app.delete('/api/tasks/:taskId/selfdev', async (c) => {
    const taskId = c.req.param('taskId');
    const graph = await getTaskGraph(taskId);
    if (!graph) throw new HttpError(404, 'task not found');
    if (!graph.selfdev_path) throw new HttpError(400, '该任务没有隔离克隆');
    removeSelfdev(graph.selfdev_path);
    return c.json({ status: 'removed', path: graph.selfdev_path });
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
            // 上限 50 与 store.addAgentMemory 的 maxItems 对齐，前端据此展示真实经验条数
            memory: (await getAgentMemory(p.name, 50).catch(() => [])) || [],
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
    const body = await readJsonAuto<{ name?: string; agent?: string; model_id?: string | null; clarify_mode?: string; action?: 'delete' }>(c);
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
      // feature: 每步骤可用不同 LLM — node-level model pin (null/'' clears the pin)
      if (body.model_id !== undefined) {
        const modelId = (body.model_id || '').trim();
        if (modelId && !ctx.modelPool.getModel(modelId)) throw new HttpError(400, `model not in pool: ${modelId}`);
        node.model_id = modelId || undefined;
      }
      if (body.clarify_mode !== undefined) {
        if (body.clarify_mode && !['off', 'brief', 'confirm'].includes(body.clarify_mode)) {
          throw new HttpError(400, 'clarify_mode must be off | brief | confirm');
        }
        node.clarify_mode = (body.clarify_mode || undefined) as any;
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

  // 人工补差：计划审核阶段在指定节点后插入节点
  app.post('/api/tasks/:taskId/nodes', async (c) => {
    const taskId = c.req.param('taskId');
    const body = await c.req.json<{ name?: string; agent?: string; after_node_id?: string }>();
    if (!body.name?.trim() || !body.agent || !body.after_node_id) {
      throw new HttpError(400, 'name / agent / after_node_id 均必填');
    }
    try {
      const node = await ctx.orchestrator.addNode(taskId, {
        name: body.name.trim(),
        agent: body.agent,
        afterNodeId: body.after_node_id,
      });
      const graph = await getTaskGraph(taskId);
      return c.json({ status: 'added', node, graph });
    } catch (e: any) {
      throw new HttpError(400, String(e.message || e));
    }
  });

  // 节点代码变更：分支工作流下节点完成时已固化 diff 到 KV，随时可查
  app.get('/api/tasks/:taskId/nodes/:nodeId/diff', async (c) => {
    const { getNodeDiff } = await import('../store');
    const taskId = c.req.param('taskId');
    const nodeId = c.req.param('nodeId');
    const graph = await getTaskGraph(taskId);
    if (!graph) throw new HttpError(404, 'task not found');
    const node = graph.nodes.find((n) => n.id === nodeId);
    if (!node) throw new HttpError(404, 'node not found');
    if (!node.branch) {
      return c.json({ node_id: nodeId, branch: '', available: false, reason: '该节点未启用分支工作流，无独立代码变更', patch: '', files: [] });
    }
    const diff = await getNodeDiff(taskId, nodeId);
    if (!diff) {
      return c.json({ node_id: nodeId, branch: node.branch, available: false, reason: node.status === 'completed' ? '变更记录缺失（旧任务或未产生提交）' : '节点尚未产生提交', patch: '', files: [] });
    }
    return c.json({ node_id: nodeId, branch: node.branch, available: true, patch: diff.patch, files: diff.files });
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
    // source filter: e.g. source=discussion:<id> lists experiences deposited by one group discussion
    const sourcePrefix = c.req.query('source') || '';
    const limit = parseInt(c.req.query('limit') || '50');
    const query = { category, project_id: projectId, limit };
    const bySource = (entries: { source?: string }[]) => (sourcePrefix ? entries.filter((e) => (e.source || '').startsWith(sourcePrefix)) : entries);
    // governance: stale-candidate listing (updated_at older than stale_days)
    if (c.req.query('stale') === '1') {
      const days = parseInt(c.req.query('days') || String(ctx.config.knowledge?.stale_days ?? 90), 10) || 90;
      return c.json({ stale_days: days, entries: bySource(listStaleKnowledge(days, query)) });
    }
    if (q) {
      // hybrid: keyword score + embedding cosine (degrades to keyword-only without a model)
      return c.json({ entries: bySource(await searchKnowledgeHybrid(q, query)) });
    }
    return c.json({ entries: bySource(listKnowledge(query)) });
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

  // ---------- group discussions (群组沟通 → 方案转项目 → 经验沉淀) ----------

  const discDeps = () => ({ orchestrator: ctx.orchestrator, pool: ctx.modelPool, taskQueue: ctx.taskQueue, logger });

  app.post('/api/discussions', async (c) => {
    const { createDiscussion } = await import('../discussion');
    const body = await readJsonAuto<{ title?: string; topic?: string; members?: string[]; mode?: 'manual' | 'auto'; project_id?: string }>(c);
    const disc = await createDiscussion(discDeps(), {
      title: body.title || '', topic: body.topic, members: body.members || [], mode: body.mode, project_id: body.project_id,
    });
    return c.json({ status: 'created', discussion: disc });
  });

  app.get('/api/discussions', async (c) => {
    const { listDiscussions, getMessages, hasPendingUserQuestion } = await import('../discussion');
    const status = c.req.query('status');
    const items = [];
    for (const d of await listDiscussions()) {
      if (status && d.status !== status) continue;
      const msgs = await getMessages(d.id);
      items.push({ ...d, message_count: msgs.length, pending_user: hasPendingUserQuestion(msgs) });
    }
    return c.json({ discussions: items });
  });

  app.get('/api/discussions/:id', async (c) => {
    // busy 一并返回：重进页面/新设备打开在飞讨论时，UI 立刻恢复"成员处理中"状态
    const { getDiscussion, getMessages, hasPendingUserQuestion, isDiscussionBusy } = await import('../discussion');
    const d = await getDiscussion(c.req.param('id'));
    if (!d) throw new HttpError(404, 'discussion not found');
    const msgs = await getMessages(c.req.param('id'));
    return c.json({ ...d, messages: msgs, pending_user: hasPendingUserQuestion(msgs), busy: await isDiscussionBusy(c.req.param('id')) });
  });

  app.put('/api/discussions/:id', async (c) => {
    const { updateDiscussion } = await import('../discussion');
    const body = await readJsonAuto<{ mode?: 'manual' | 'auto'; title?: string; scheme?: string }>(c);
    const disc = await updateDiscussion(c.req.param('id'), body);
    return c.json({ status: 'updated', discussion: disc });
  });

  app.delete('/api/discussions/:id', async (c) => {
    const { getDiscussion, deleteDiscussion } = await import('../discussion');
    if (!(await getDiscussion(c.req.param('id')))) throw new HttpError(404, 'discussion not found');
    await deleteDiscussion(c.req.param('id'));
    return c.json({ status: 'deleted', id: c.req.param('id') });
  });

  app.post('/api/discussions/:id/messages', async (c) => {
    // 引擎 v2：用户消息不再被 busy 拒收（409 废除）——随时入库；在飞的响应循环
    // 会在每位发言者之间检查新消息并重新路由（轮内真打断）。
    const { postUserMessage, getDiscussion, triggerRound, isDiscussionBusy } = await import('../discussion');
    const id = c.req.param('id');
    const body = await readJsonAuto<{ text?: string; reply_to?: string; react_to?: string; emoji?: string }>(c);
    const { message, mentioned } = await postUserMessage(discDeps(), id, body.text || '', {
      reply_to: body.reply_to, react_to: body.react_to, emoji: body.emoji,
    });
    const disc = await getDiscussion(id);
    const busy = await isDiscussionBusy(id);
    if (disc && message && !busy) triggerRound(discDeps(), disc, mentioned);
    return c.json({
      status: 'accepted',
      message,
      // queued=true：一轮在飞，新消息由在飞循环消化（无需等待，也不会丢）
      queued: !!message && busy,
      responding: !busy && message ? (mentioned.length ? mentioned : 'auto') : null,
    });
  });

  app.post('/api/discussions/:id/round', async (c) => {
    // 「继续讨论」按钮：走统一响应循环（自动模式多轮/手动模式一轮），
    // 循环内会消化期间到达的用户消息（drain），不再有触发后失联的问题。
    const { getDiscussion, triggerRound, isDiscussionBusy } = await import('../discussion');
    const id = c.req.param('id');
    if (await isDiscussionBusy(id)) throw new HttpError(409, '该讨论有一轮正在进行，请稍候');
    const disc = await getDiscussion(id);
    if (!disc) throw new HttpError(404, 'discussion not found');
    triggerRound(discDeps(), disc, []);
    return c.json({ status: 'accepted' });
  });

  app.post('/api/discussions/:id/stop', async (c) => {
    const { requestStop } = await import('../discussion');
    await requestStop(discDeps(), c.req.param('id'));
    return c.json({ status: 'stopping' });
  });

  app.post('/api/discussions/:id/scheme', async (c) => {
    const { generateScheme } = await import('../discussion');
    const disc = await generateScheme(discDeps(), c.req.param('id'));
    return c.json({ status: 'converged', discussion: disc });
  });

  app.post('/api/discussions/:id/convert', async (c) => {
    const { convertToProject } = await import('../discussion');
    const body = await readJsonAuto<{
      target?: 'new' | 'existing'; name?: string; workspace?: string; scaffold?: boolean;
      project_id?: string; auto_run?: boolean;
    }>(c);
    const target = body.target === 'new' || body.target === 'existing' ? body.target : null;
    if (!target) throw new HttpError(400, "target must be 'new' | 'existing'");
    if (target === 'new' && body.workspace) {
      await assertStandaloneWorkspace(validateWorkspace(body.workspace), { allowSelfRef: false, projectRoot: PROJECT_ROOT });
    }
    const result = await convertToProject(discDeps(), c.req.param('id'), { ...body, target }, validateWorkspace);
    return c.json({ status: 'converted', ...result });
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
    const names = new Set<string>();
    for (const m of pool) {
      if (names.has(m.name)) throw new HttpError(400, `duplicate model name: ${m.name} (name is the pool's unique key)`);
      names.add(m.name);
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

  // 模型池服务分组：拉取某个 base_url + api_key 上游实际可用的模型列表（OpenAI 兼容 GET /models）
  app.post('/api/config/upstream-models', async (c) => {
    const { listUpstreamModels } = await import('../llm');
    const body = await c.req.json<{ api_key?: string; base_url?: string }>();
    if (!body.base_url || !body.api_key) throw new HttpError(400, 'base_url and api_key are required');
    try {
      const models = await listUpstreamModels(body.api_key, body.base_url);
      return c.json({ ok: true, models });
    } catch (e: any) {
      return c.json({ ok: false, error: String(e.message || e).slice(0, 300) }, 400);
    }
  });

  // ---------- feature: 每日问题报告 ----------

  app.get('/api/config/daily-report', (c) => {
    return c.json(ctx.config.daily_report || { enabled: false, hour: 9 });
  });

  app.put('/api/config/daily-report', async (c) => {
    const body = await readJsonAuto<{ enabled?: boolean; hour?: number }>(c);
    const enabled = body.enabled === true;
    const hour = Math.min(23, Math.max(0, Math.floor(Number(body.hour ?? 9))));
    const { saveDailyReport } = await import('../configStore');
    saveDailyReport({ enabled, hour });
    ctx.config.daily_report = { enabled, hour };
    // hot-reload the scanner — the UI switch takes effect immediately
    ctx.dailyReportScanner?.reload(enabled, hour);
    return c.json({ status: 'saved', enabled, hour });
  });

  app.get('/api/reports/daily', async (c) => {
    const { listDailyReports } = await import('../dailyReport');
    const limit = Number(c.req.query('limit') || 30);
    return c.json({ reports: await listDailyReports(Number.isFinite(limit) ? limit : 30) });
  });

  app.get('/api/reports/daily/:date', async (c) => {
    const { getDailyReport } = await import('../dailyReport');
    const report = await getDailyReport(c.req.param('date'));
    if (!report) throw new HttpError(404, `report not found: ${c.req.param('date')}`);
    return c.json(report);
  });

  // 用户决策：忽略 / 立即修复 / 转为修复任务（进入计划评审）
  app.post('/api/reports/daily/:date/resolve', async (c) => {
    const date = c.req.param('date');
    const body = await readJsonAuto<{ item_id?: string; action?: 'fix_now' | 'create_task' | 'skip'; workspace?: string }>(c);
    if (!body.item_id || !body.action) throw new HttpError(400, 'item_id and action are required');
    const { getDailyReport, resolveReportItem } = await import('../dailyReport');
    const report = await getDailyReport(date);
    if (!report) throw new HttpError(404, `report not found: ${date}`);
    const item = report.items.find((i) => i.id === body.item_id);
    if (!item) throw new HttpError(404, 'report item not found');

    let repairTaskId: string | undefined;
    if (body.action === 'fix_now' || body.action === 'create_task') {
      // derive a repair task from the report item; workspace comes from the source task
      let workspace = body.workspace || '';
      if (!workspace && item.sources[0]?.task_id) {
        const src = await getTaskGraph(item.sources[0].task_id);
        workspace = src?.workspace || '';
      }
      if (!workspace) throw new HttpError(400, 'workspace is required (no source task workspace found)');
      const description = `修复问题报告（${date}）：${item.sample.slice(0, 300)}${item.sources[0]?.task_id ? `\n\n来源任务: ${item.sources[0].task_id}` : ''}`;
      const created = await ctx.orchestrator.createTask(description, workspace, undefined, { level: 'light' });
      repairTaskId = created.taskId;
    }
    const updated = await resolveReportItem(date, body.item_id, body.action, repairTaskId);
    return c.json({ status: 'resolved', action: body.action, task_id: repairTaskId, report: updated });
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
    const graphs = await listTaskGraphs();
    for (const graph of graphs) {
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
    const { summarizeQuality } = await import('../metrics');
    return c.json({
      tasks: {
        total: tasksTotal,
        success: tasksSuccess,
        success_rate: tasksTotal ? Math.round((tasksSuccess / tasksTotal) * 1000) / 1000 : 0,
      },
      agents: agentStats,
      // P0-1/P0-2 quality loop: fix rounds, test outcomes, defect closure, delivery consistency
      quality: summarizeQuality(graphs),
      model_pool: ctx.modelPool.getStatus(),
      token_usage: ctx.modelPool.getUsage(),
      tokens_total: ctx.modelPool.totalTokens(),
      cost_total: ctx.modelPool.totalCost(),
    });
  });

  // P0-1/P0-2: daily quality trend from the per-run samples written by execute()
  app.get('/api/metrics/trend', async (c) => {
    const days = Math.max(1, Math.min(90, parseInt(c.req.query('days') || '14', 10) || 14));
    const { getTrend } = await import('../metrics');
    return c.json({ days, trend: await getTrend(days) });
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
