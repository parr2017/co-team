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
import { getTaskGraph, listTaskGraphs, listTaskGraphsPaged, persistGraph, saveTaskGraph, deleteTask, listProjects, appendJournal, emitProgress } from '../store';
import { getTaskConversations } from '../transcript';
import { toAgentInfo } from '../agents';
import { mergeTaskBranch } from '../git';
import { DiscussionError } from '../discussion';
import { ConvoError } from '../convo';
import { WorkspaceError, assertStandaloneWorkspace, slugifyProjectName, prepareSelfdevClone, removeSelfdev } from '../workspace';
import { getDocRegistry } from '../ssot';
import { listFiles, readFile } from '../tools';
import { isIgnoredRelPath } from '../sandbox';
import type { AppConfig, OrchestrationConfig } from '../config';
import { PROJECT_ROOT } from '../config';
import type { TaskGraph, TaskNode } from '../types';
import type { FeishuHandler } from '../feishu/webhook';
import { registerConvoRoutes } from './convos';
import { registerOpencodeRoutes } from './opencode';
import { registerCoteamMcpRoutes } from '../mcpServer/server';
import { getLogger } from '../logger';
import type { McpManager } from '../mcp/manager';
import type { McpServerConfig, McpServerStatus } from '../mcp/types';
import type { OpencodeManager } from '../opencode/manager';

export interface ApiContext {
  config: AppConfig;
  orchestrator: Orchestrator;
  modelPool: ModelPool;
  taskQueue: TaskQueueManager;
  /** feature: 每日问题报告 — scanner handle so the PUT config route can hot-reload it */
  dailyReportScanner?: { reload(enabled: boolean, hour: number): void };
  /** P1.5 Dream 整理线程 — graceful shutdown handle */
  stopDreamScanner?: () => void;
  /** 外部 MCP 服务管理器（MCP client）；未配置=undefined，mcp 配置路由按空列表处理 */
  mcp?: McpManager;
  /** OpenCode 接管管理器（managed 托管 + attached 接管）；未配置=undefined */
  opencode?: OpencodeManager;
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

export async function readJsonAuto<T>(c: Context): Promise<T> {
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

  // 用户附图静态服务：文件名白名单（img-<id>.<ext>）拒绝路径穿越，注册在 SPA static
  // 之前。本机应用不做鉴权（与 dashboard 同级暴露），content-type 按扩展名映射。
  app.get('/media/:file', async (c) => {
    const file = c.req.param('file');
    const { mediaDir, MEDIA_FILE_RE, IMAGE_MEDIA_TYPES } = await import('../media');
    if (!MEDIA_FILE_RE.test(file)) return c.json({ detail: 'invalid media file name' }, 400);
    const full = path.join(mediaDir(), file);
    if (!fs.existsSync(full)) return c.json({ detail: 'media not found' }, 404);
    const ext = path.extname(file).toLowerCase();
    const body = await fs.promises.readFile(full);
    c.header('Content-Type', IMAGE_MEDIA_TYPES[ext] || 'application/octet-stream');
    c.header('Cache-Control', 'public, max-age=86400');
    return c.body(body);
  });

  app.onError((err, c) => {
    // DiscussionError/ConvoError/WorkspaceError carry their own HTTP status (409 busy / 400 validation / ...)
    const status = err instanceof HttpError || err instanceof DiscussionError || err instanceof ConvoError || err instanceof WorkspaceError ? err.status : 500;
    logger.error('API error', { error: err.message, status, stack: err.stack });
    return c.json({ detail: err.message }, status as any);
  });

  // SEC-P0 API Token 门禁：配置 dashboard.token 后，全部 /api 请求必须携带
  // Authorization: Bearer <token>（或 ?token=，供无法设头的场景）。未配置 = 不启用门禁（仅建议本机使用）。
  const apiToken = ctx.config.dashboard?.token;
  if (apiToken) {
    app.use('/api/*', async (c, next) => {
      const header = c.req.header('Authorization') || '';
      const query = new URL(c.req.url).searchParams.get('token') || '';
      if (header !== `Bearer ${apiToken}` && query !== apiToken) {
        return c.json({ detail: 'unauthorized (missing/invalid API token)' }, 401);
      }
      await next();
    });
  }

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
      // B1（2026-09-17）：completed_with_warnings（验收有警告的 tolerant 交付）计入完成
      const done = tasks.filter((t) => t.status === 'success' || t.status === 'completed_with_warnings').length;
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

  // P1.1：项目元数据编辑（结构化字段 + 简报，字段白名单防整对象覆盖）
  app.put('/api/projects/:id', async (c) => {
    const { updateProject } = await import('../store');
    const body = await readJsonAuto<{ name?: string; description?: string; tech_stack?: string; conventions?: string; domain?: string; stage?: string; audience?: string; brief?: string }>(c);
    const updated = await updateProject(c.req.param('id'), body);
    if (!updated) throw new HttpError(404, 'project not found');
    return c.json({ status: 'updated', project: updated });
  });

  // P1.1：项目简报初稿生成（LLM 从 description/记忆/知识/任务汇总；用户可在 UI 再编辑）
  app.post('/api/projects/:id/brief', async (c) => {
    const { getProject, listProjectTasks, getProjectMemory, updateProject } = await import('../store');
    const { listKnowledge } = await import('../knowledge');
    const { chat } = await import('../llm');
    const { extractJson, stripCodeFence } = await import('../llm');
    const id = c.req.param('id');
    const proj = await getProject(id);
    if (!proj) throw new HttpError(404, 'project not found');
    const [memory, tasks, knowledge] = await Promise.all([
      getProjectMemory(id, 30),
      listProjectTasks(id),
      Promise.resolve(listKnowledge({ category: 'project', project_id: id, limit: 10 })),
    ]);
    const entry = ctx.modelPool.selectStrongModel() ?? ctx.modelPool.selectStrongModel(['code']);
    if (!entry) throw new HttpError(503, '模型池无可用模型，无法生成简报');
    const facts = [
      `项目名：${proj.name}`,
      proj.description ? `描述：${proj.description}` : '',
      proj.tech_stack ? `技术栈：${proj.tech_stack}` : '',
      proj.domain ? `领域：${proj.domain}` : '',
      proj.audience ? `受众：${proj.audience}` : '',
      proj.stage ? `阶段：${proj.stage}` : '',
      memory.length ? `项目记忆（最近 ${Math.min(10, memory.length)} 条）：\n${memory.slice(-10).map((m) => `- ${m.text}`).join('\n')}` : '',
      knowledge.length ? `知识库条目：\n${knowledge.slice(0, 5).map((k) => `- 《${k.title}》${k.content.slice(0, 120)}`).join('\n')}` : '',
      tasks.length ? `历史任务：${tasks.slice(0, 8).map((t) => `${t.description?.slice(0, 60) || t.task_id}（${t.status}）`).join('；')}` : '',
    ].filter(Boolean).join('\n');
    const res = await chat(entry, [
      { role: 'system', content: '你是项目档案管理员。根据给定的项目材料写一份《项目简报》（Markdown，300-600 字），供 AI 协作系统在每次任务前注入作为项目概念基准。必须包含以下小节：## 一句话定位、## 技术栈与架构要点、## 关键约定（编码/协作规范）、## 当前状态与进行中的事、## 注意事项（踩坑与经验）。忠实于材料，材料中没有的写「暂无记录」，禁止编造。直接输出 Markdown 正文，无代码栅栏。' },
      { role: 'user', content: facts },
    ], undefined, 0.2);
    const brief = stripCodeFence(res.content).trim();
    if (!brief) throw new HttpError(502, '简报生成结果为空，请重试');
    const updated = await updateProject(id, { brief, brief_updated_at: new Date().toISOString() });
    return c.json({ status: 'generated', brief, project: updated });
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
      /** B1（2026-09-17）：验收策略——strict=验收失败即任务失败；tolerant（缺省）=完成·有警告 */
      acceptance_policy?: 'strict' | 'tolerant';
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

    // B1：创建时可选指定验收策略（缺省 tolerant，与编排器裁决一致）
    if (body.acceptance_policy) {
      if (!['strict', 'tolerant'].includes(body.acceptance_policy)) throw new HttpError(400, 'acceptance_policy must be strict | tolerant');
      const fresh = await getTaskGraph(taskId);
      if (fresh) {
        fresh.acceptance_policy = body.acceptance_policy;
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
    const body = await c.req.json<{ answers?: { question: string; answer: string; images?: { name: string; dataUrl: string }[] }[]; confirm?: boolean; text?: string; plan_async?: boolean }>();
    // 澄清回答附图：逐条富化（视觉描述 + workspace 原图路径），orchestrator.clarify 零改动
    if (body.answers?.some((a) => a.images?.length)) {
      const graph = await getTaskGraph(taskId);
      const { ingestUserImages, renderImagesForContext } = await import('../media');
      for (const a of body.answers) {
        if (!a.images?.length) continue;
        const r = await ingestUserImages(ctx.modelPool, a.images, { workspace: graph?.workspace });
        if (r.error) throw new HttpError(400, r.error);
        if (r.stored.length) a.answer = `${a.answer || ''}${a.answer ? '\n' : ''}${renderImagesForContext(r.stored)}`;
      }
    }
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
    // 流内打断（2026-09-16）：abort 本任务 in-flight LLM 流——此前取消只能等轮边界轮询
    ctx.orchestrator.abortTask(taskId);
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
    const body = await c.req.json<{ message?: string; images?: { name: string; dataUrl: string }[] }>();
    const message = (body.message || '').trim();
    if (!message && !body.images?.length) throw new HttpError(400, 'message is required');
    const graph = await getTaskGraph(taskId);
    if (!graph) throw new HttpError(404, 'task not found');
    // failed 任务也放行：监督者的 retry_failed 提案被批准重试后，队列中的消息会被消费注入
    if (!['running', 'pending', 'planned', 'retrying', 'waiting_approval', 'failed'].includes(graph.status)) {
      throw new HttpError(400, `task is not running (status: ${graph.status}), intervention will never be consumed`);
    }
    // 用户附图：入口即富化——agent 下一轮拿到的注入文本自带视觉描述与 workspace 原图路径
    let imageMeta: { id: string; name: string; url: string; wsPath?: string; desc?: string }[] | undefined;
    let enriched = message;
    if (body.images?.length) {
      const { ingestUserImages, renderImagesForContext } = await import('../media');
      const r = await ingestUserImages(ctx.modelPool, body.images, { workspace: graph.workspace });
      if (r.error) throw new HttpError(400, r.error);
      if (r.stored.length) {
        imageMeta = r.stored;
        enriched = `${message}${message ? '\n' : ''}${renderImagesForContext(r.stored)}`;
      }
    }
    const note = graph.status === 'failed'
      ? '任务已失败：消息已入队，批准「重试」提案后会在下一轮注入 agent'
      : '将在 Agent 下一轮对话注入';
    const { pushIntervention, appendJournal, emitProgress } = await import('../store');
    const item = await pushIntervention(taskId, enriched);
    // war-room journal: the user's message appears immediately as a master-side bubble
    await appendJournal(taskId, 'orchestrator', {
      role: 'master',
      kind: 'intervene',
      text: message || `（用户附图 ${imageMeta?.length || 0} 张）`,
      ts: item.ts,
      node_id: 'intervene',
      node_name: '用户介入',
      meta: { intervention_id: item.id, ...(imageMeta ? { images: imageMeta } : {}) },
    });
    await emitProgress('user_intervened', { task_id: taskId, message: enriched.slice(0, 500), intervention_id: item.id });
    const { notify } = await import('../notify');
    notify('user_intervened', { task_id: taskId }, `[Co-Team] 用户向任务 ${taskId} 发送介入指示：${enriched.slice(0, 80)}`);
    return c.json({ status: 'queued', task_id: taskId, intervention_id: item.id, note });
  });

  // M2 全员实时问答：用户回答 agent 的阻塞式提问（ask_user），等待中的节点立即被唤醒
  app.post('/api/tasks/:taskId/asks/:askId/answer', async (c) => {
    const taskId = c.req.param('taskId');
    const askId = c.req.param('askId');
    const body = await c.req.json<{ answer?: string; images?: { name: string; dataUrl: string }[] }>();
    const answer = (body.answer || '').trim();
    if (!answer && !body.images?.length) throw new HttpError(400, 'answer is required');
    const asks = await listAsks(taskId);
    const rec = asks.find((a) => a.id === askId);
    if (!rec) throw new HttpError(404, 'ask not found');
    if (rec.status !== 'pending') throw new HttpError(400, `ask already settled (status: ${rec.status})`);
    // 用户附图：回答富化后注入等待中的 agent（视觉描述 + workspace 原图路径）
    let enriched = answer;
    if (body.images?.length) {
      const graph = await getTaskGraph(taskId);
      const { ingestUserImages, renderImagesForContext } = await import('../media');
      const r = await ingestUserImages(ctx.modelPool, body.images, { workspace: graph?.workspace });
      if (r.error) throw new HttpError(400, r.error);
      if (r.stored.length) enriched = `${answer}${answer ? '\n' : ''}${renderImagesForContext(r.stored)}`;
    }
    const okDone = await resolveAsk(askId, taskId, enriched, 'user');
    if (!okDone) throw new HttpError(409, 'ask is no longer being waited on');
    return c.json({ ok: true, ask_id: askId, task_id: taskId });
  });

  // OBS-1 服务日志查询（tail）：?date=YYYY-MM-DD&lines=N
  app.get('/api/logs', async (c) => {
    const date = c.req.query('date') || new Date().toISOString().split('T')[0];
    const lines = Math.min(800, Math.max(1, Number(c.req.query('lines') || 120)));
    const file = path.join(PROJECT_ROOT, 'logs', `co-team-${date}.log`);
    if (!fs.existsSync(file)) return c.json({ date, lines: [] });
    // 2026-09-15 OOM 复盘：此前 readFileSync 全量读入——2.7GB 的 09-14 EPIPE 风暴日志
    // 撞 V8 字符串上限（500），且被日志查看器 5s 轮询反复分配巨型缓冲，最终把进程堆打到
    // 4GB OOM 杀死。日志查看只需要尾部：定长窗口读，永不随文件大小膨胀。
    const TAIL_BYTES = 512 * 1024;
    const stat = fs.statSync(file);
    const start = Math.max(0, stat.size - TAIL_BYTES);
    const fd = fs.openSync(file, 'r');
    try {
      const len = Math.min(TAIL_BYTES, stat.size);
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, start);
      // 丢弃首个可能被截断的半行（tail 窗口切在行中间时）
      let text = buf.toString('utf-8');
      if (start > 0) {
        const nl = text.indexOf('\n');
        if (nl >= 0) text = text.slice(nl + 1);
      }
      const all = text.split('\n').filter((l) => l.length > 0);
      const truncated = start > 0;
      return c.json({ date, total: truncated ? null : all.length, truncated, lines: all.slice(-lines) });
    } finally {
      fs.closeSync(fd);
    }
  });

  app.get('/api/tasks/:taskId/asks', async (c) => {
    const taskId = c.req.param('taskId');
    return c.json({ asks: await listAsks(taskId) });
  });

  // ---------- M3 监督者提案：列表与批准/拒绝（批准后执行改图） ----------

  app.get('/api/tasks/:taskId/proposals', async (c) => {
    const taskId = c.req.param('taskId');
    const proposals = await busGet<any[]>(`task:proposals:${taskId}`);
    return c.json({ proposals: proposals || [] });
  });

  // M5 最终验收报告（平台矩阵 + 逐项机审证据）
  app.get('/api/tasks/:taskId/acceptance-report', async (c) => {
    const taskId = c.req.param('taskId');
    const report = await busGet<Record<string, any>>(`task:acceptance:${taskId}`);
    return c.json({ report: report || null });
  });

  app.post('/api/tasks/:taskId/proposals/:proposalId/decide', async (c) => {
    const taskId = c.req.param('taskId');
    const proposalId = c.req.param('proposalId');
    const body = await c.req.json<{ approved?: boolean }>();
    const approved = body.approved === true;
    const graph = await getTaskGraph(taskId);
    if (!graph) throw new HttpError(404, 'task not found');
    const key = `task:proposals:${taskId}`;
    const proposals = (await busGet<any[]>(key)) || [];
    const proposal = proposals.find((x) => x.id === proposalId);
    if (!proposal) throw new HttpError(404, 'proposal not found');
    if (proposal.status !== 'pending') throw new HttpError(400, `proposal already ${proposal.status}`);
    proposal.decided_at = new Date().toISOString();
    if (!approved) {
      proposal.status = 'rejected';
      await busSet(key, proposals);
      await appendJournal(taskId, 'orchestrator', {
        role: 'master', kind: 'round',
        text: `监督者提案已拒绝：${proposal.reason || proposal.type}`,
        ts: new Date().toISOString(), node_id: '', node_name: '',
        meta: { supervisor: true, proposal_id: proposalId, decision: 'rejected' },
      });
      return c.json({ ok: true, status: 'rejected' });
    }
    proposal.status = 'approved';
    try {
      if (proposal.type === 'retry_failed') {
        const node = graph.nodes.find((n: any) => n.id === proposal.node_id);
        if (!node) throw new Error(`节点 ${proposal.node_id} 不存在`);
        if (node.status !== 'failed') throw new Error(`节点状态为 ${node.status}，仅 failed 节点可重试`);
        node.status = 'pending';
        node.error = '';
        node.needs_human = false;
        await persistGraph(graph);
        await ctx.taskQueue.enqueue(taskId, graph.project_id ?? null, graph.workspace);
      } else if (proposal.type === 'cancel_subtree') {
        const node = graph.nodes.find((n: any) => n.id === proposal.node_id);
        if (!node) throw new Error(`节点 ${proposal.node_id} 不存在`);
        if (!['pending', 'failed', 'waiting_approval', 'waiting_clarify'].includes(node.status)) {
          throw new Error(`节点状态为 ${node.status}，不可取消`);
        }
        node.status = 'cancelled';
        node.error = '监督者提案批准：取消';
        // 连带取消全部 pending 下游（BFS）
        const upstream = new Map<string, string[]>();
        for (const n of graph.nodes) upstream.set(n.id, []);
        for (const [src, dst] of graph.edges) upstream.get(dst)?.push(src);
        let changed = true;
        const cancelled = new Set([node.id]);
        while (changed) {
          changed = false;
          for (const n of graph.nodes) {
            if (n.status === 'pending' && (upstream.get(n.id) || []).some((d) => cancelled.has(d))) {
              n.status = 'cancelled';
              n.error = '上游被取消（监督者提案）';
              cancelled.add(n.id);
              changed = true;
            }
          }
        }
        await persistGraph(graph);
      } else if (proposal.type === 'insert_node') {
        await ctx.orchestrator.addNode(taskId, {
          name: String(proposal.new_node?.name || '监督者插入节点'),
          agent: String(proposal.new_node?.agent || ''),
          afterNodeId: String(proposal.after_node_id || graph.nodes[0]?.id || ''),
        });
      } else if (proposal.type === 'derive_task') {
        // M5 一键批准全自动派生：创建派生修复任务（继承工作区/项目/经验，rolling 只修缺陷），
        // planAsync + autoRun → 后台规划完成后自动入队执行（onTaskPlanned 钩子）
        const created = await ctx.orchestrator.createTask(
          String(proposal.description || proposal.reason || '派生修复任务'),
          graph.workspace,
          graph.project_id,
          { autoRun: true, planAsync: true, skipClarification: true },
        );
        proposal.derived_task_id = created.taskId;
      } else {
        throw new Error(`未知提案类型 ${proposal.type}`);
      }
      proposal.status = 'executed';
      await busSet(key, proposals);
      await appendJournal(taskId, 'orchestrator', {
        role: 'master', kind: 'round',
        text: `监督者提案已批准并执行：${proposal.reason || proposal.type}`,
        ts: new Date().toISOString(), node_id: '', node_name: '',
        meta: { supervisor: true, proposal_id: proposalId, decision: 'executed' },
      });
      await emitProgress('supervisor_proposal_executed', { task_id: taskId, proposal_id: proposalId, type: proposal.type });
      return c.json({ ok: true, status: 'executed' });
    } catch (e: any) {
      proposal.status = 'failed';
      proposal.exec_error = String(e?.message || e).slice(0, 300);
      await busSet(key, proposals);
      throw new HttpError(400, proposal.exec_error);
    }
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
      throw new HttpError(400, 'level must be plan_only | readonly | approve_required | whitelist_auto | full | unrestricted');
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
      // o3xmkraj 复盘：批准 → 节点已重置 pending，重新入队续跑；拒绝 → 释放车道槽位
      if ((result as { node_resumed?: boolean }).node_resumed) {
        const graph = await getTaskGraph(taskId);
        if (graph) await ctx.taskQueue.enqueue(taskId, graph.project_id ?? null, validateWorkspace(graph.workspace || ''));
      } else if (body.approved === false) {
        ctx.taskQueue.releaseStalled(taskId);
      }
      return c.json({ task_id: taskId, command_id: commandId, ...result });
    } catch (e: any) {
      throw new HttpError(400, String(e.message || e));
    }
  });

  // 人工门续跑（o3xmkraj 复盘）：needs_human 节点在人工修复环境/补充信息后，
  // 一键重置该节点及被连带取消的下游 → 重新入队，不再"整任务报废"
  app.post('/api/tasks/:taskId/nodes/:nodeId/retry', async (c) => {
    const taskId = c.req.param('taskId');
    const nodeId = c.req.param('nodeId');
    const graph = await getTaskGraph(taskId);
    if (!graph) throw new HttpError(404, 'task not found');
    const node = graph.nodes.find((n) => n.id === nodeId);
    if (!node) throw new HttpError(404, 'node not found');
    // 三种可续跑形态：① needs_human 失败节点（人工修完环境/补完信息）；
    // ② interrupted 被中断节点——含"反复重启被停靠 failed"的任务（infra_retries>3 时
    //    sweepInterruptedTasks 判死，但成果都在，环境恢复后应当能人工复活，此前无路径）；
    // ③ 僵尸 running 节点——持久状态是 running 但内存里没有执行器（进程被杀/异常丢线程），
    //    调度器永远跳过它，只能经此接口解锁（2026-09-23 pk0udn4p s2-3 卡死 9 小时实证）。
    //    isNodeExecuting 为 true 的一律拒绝：那是真在跑的节点，重置会双跑。
    const zombieRunning = node.status === 'running' && !ctx.orchestrator.isNodeExecuting(taskId, nodeId);
    const interrupted = node.status === 'interrupted';
    if (!((node.status === 'failed' && node.needs_human) || zombieRunning || interrupted)) {
      throw new HttpError(400, '节点不是"需人工介入/被中断/僵尸 running"态，无需续跑');
    }
    // 被停靠/中断的任务整体复活：清零重启计数与任务级失败态（入队时置 queued）
    if (['failed', 'interrupted'].includes(graph.status)) {
      graph.status = 'queued';
      graph.infra_retries = 0;
      await persistGraph(graph);
    }
    const upstream = new Map<string, string[]>();
    for (const n of graph.nodes) upstream.set(n.id, []);
    for (const [src, dst] of graph.edges) upstream.get(dst)?.push(src);
    const reset = new Set<string>([nodeId]);
    let changed = true;
    while (changed) {
      changed = false;
      for (const n of graph.nodes) {
        if ((n.status === 'pending' || n.status === 'cancelled') && !reset.has(n.id) && (upstream.get(n.id) || []).some((d) => reset.has(d))) {
          // !reset.has 守卫（2026-09-16 o3xmkraj 实证）：缺它时 Set.add 幂等但 changed
          // 仍被置 true——下游存在 pending/cancelled 节点即无条件死循环，冻结事件循环
          // （retry POST 后全 API 无响应、supervisor 心跳同停），一天两起假死皆此因
          reset.add(n.id);
          changed = true;
        }
      }
    }
    for (const n of graph.nodes) {
      if (reset.has(n.id) && n.status !== 'pending') {
        n.status = 'pending';
        n.error = '';
        (n as any).error_type = undefined;
        n.needs_human = false;
        n.finished_at = '';
      }
    }
    await persistGraph(graph);
    await appendJournal(taskId, 'orchestrator', {
      role: 'master', kind: 'round',
      text: `人工已处理：节点「${node.name}」及其下游共 ${reset.size} 个节点重置待跑，任务重新入队`,
      ts: new Date().toISOString(), node_id: node.id, node_name: node.name,
    });
    await emitProgress('node_retried', { task_id: taskId, node_id: node.id, name: node.name, reset_nodes: [...reset] });
    await ctx.taskQueue.enqueue(taskId, graph.project_id ?? null, validateWorkspace(graph.workspace || ''));
    return c.json({ status: 'requeued', task_id: taskId, node_id: nodeId, reset_nodes: [...reset] });
  });

  // 环境预检停靠后的人工放行（o3xmkraj 复盘）：补授白名单/装好工具链后一键开跑
  app.post('/api/tasks/:taskId/run', async (c) => {
    const taskId = c.req.param('taskId');
    const graph = await getTaskGraph(taskId);
    if (!graph) throw new HttpError(404, 'task not found');
    if (['running', 'queued', 'finalizing'].includes(graph.status)) throw new HttpError(400, `任务正在执行中（${graph.status}），无需重复发车`);
    await appendJournal(taskId, 'orchestrator', {
      role: 'master', kind: 'round',
      text: '人工放行：任务重新发车（将再次执行环境预检）',
      ts: new Date().toISOString(), node_id: '', node_name: '',
    });
    await ctx.taskQueue.enqueue(taskId, graph.project_id ?? null, validateWorkspace(graph.workspace || ''));
    return c.json({ status: 'enqueued', task_id: taskId });
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
    const { listKnowledge, searchKnowledgeHybrid, listStaleKnowledge, isValidCategory } = await import('../knowledge');
    const categoryRaw = c.req.query('category') || '';
    const category = isValidCategory(categoryRaw) ? categoryRaw : undefined;
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
    const { writeKnowledge, listKnowledge, categoryDir, isValidCategory } = await import('../knowledge');
    const body = await readJsonAuto<{ title?: string; content?: string; category?: string; project_id?: string; tags?: string[] }>(c);
    if (!body.title || !body.content) throw new HttpError(400, 'title and content are required');
    const category = isValidCategory(body.category) ? body.category : 'general-tech';
    try {
      // governance: semantic near-duplicate — when the embedding model is configured,
      // a ≥0.95 cosine match updates the existing entry instead of creating a copy
      if ((await import('../embeddings')).embeddingEnabled()) {
        const embeddings = await import('../embeddings');
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
        category,
        project_id: body.project_id,
        tags: body.tags,
        source: 'user',
      });
      return c.json({ status: result.updated ? 'updated' : 'created', id: result.id });
    } catch (e: any) {
      throw new HttpError(400, String(e.message || e));
    }
  });

  // P1.4 经验候选卡确认入库（半自动沉淀：用户点确认才写知识库，忽略则不留存）
  app.post('/api/knowledge/confirm', async (c) => {
    const { writeKnowledge, isValidCategory } = await import('../knowledge');
    const body = await readJsonAuto<{ title?: string; content?: string; category?: string; project_id?: string; tags?: string[]; source?: string }>(c);
    if (!body.title || !body.content) throw new HttpError(400, 'title and content are required');
    try {
      const result = writeKnowledge({
        title: body.title,
        content: body.content,
        category: isValidCategory(body.category) ? body.category : 'project',
        project_id: body.project_id,
        tags: body.tags?.length ? body.tags : ['确认经验'],
        source: body.source || 'confirmed',
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

  // P2-8 群聊小改一键回滚：按 undo_id 恢复写前内容（新文件=删除）
  app.post('/api/discussions/:id/undo', async (c) => {
    const { undoDiscussionWrites } = await import('../discussion');
    const body = await readJsonAuto<{ undo_ids?: string[] }>(c);
    const ids = (body.undo_ids || []).map(String).filter(Boolean).slice(0, 20);
    if (!ids.length) throw new HttpError(400, 'undo_ids is required');
    const r = await undoDiscussionWrites(discDeps(), c.req.param('id'), ids);
    return c.json({ status: 'ok', ...r });
  });

  app.post('/api/discussions/:id/messages', async (c) => {
    // 引擎 v2：用户消息不再被 busy 拒收（409 废除）——随时入库；在飞的响应循环
    // 会在每位发言者之间检查新消息并重新路由（轮内真打断）。
    const { postUserMessage, getDiscussion, triggerRound, isDiscussionBusy } = await import('../discussion');
    const id = c.req.param('id');
    const body = await readJsonAuto<{ text?: string; reply_to?: string; react_to?: string; emoji?: string; images?: { name: string; dataUrl: string }[] }>(c);
    const { message, mentioned } = await postUserMessage(discDeps(), id, body.text || '', {
      reply_to: body.reply_to, react_to: body.react_to, emoji: body.emoji,
      images: body.images?.length ? body.images : undefined,
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

  app.post('/api/discussions/:id/convert/confirm', async (c) => {
    // agent 转任务确认卡的用户拍板入口：confirm 真正建任务开工，cancel 继续讨论
    const { resolveConvertConfirm } = await import('../discussion');
    const body = await readJsonAuto<{ confirm_id?: string; action?: 'confirm' | 'cancel' }>(c);
    if (!body.confirm_id) throw new HttpError(400, 'confirm_id is required');
    const action = body.action === 'cancel' ? 'cancel' : 'confirm';
    const result = await resolveConvertConfirm(discDeps(), c.req.param('id'), body.confirm_id, action, validateWorkspace);
    return c.json({ status: result.state, ...result });
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
    // 供应商名称必填（同名模型靠它区分；下拉展示 name · provider）
    pool.forEach((m, i) => {
      if (!m || typeof m !== 'object') throw new HttpError(400, `第 ${i + 1} 个模型条目无效`);
      const pv = String(m.provider ?? '').trim();
      if (!pv) throw new HttpError(400, `第 ${i + 1} 个模型「${m.name || '未命名'}」缺少供应商名称（必填）`);
      m.provider = pv;
    });
    for (const m of pool) {
      if (!m.id || !m.name || !m.api_key || !m.base_url) throw new HttpError(400, 'each model needs id, name, api_key and base_url');
    }
    const ids = new Set<string>();
    for (const m of pool) {
      if (ids.has(m.id)) throw new HttpError(400, `duplicate model id: ${m.id} (id is the pool's unique key)`);
      ids.add(m.id);
    }
    saveModelPool(pool);
    ctx.config.model_pool = pool;
    ctx.modelPool.replaceModels(pool);
    return c.json({ status: 'saved', model_pool: pool });
  });

  // feature: 模型标签模板 —— 用户自定义命名标签组合（如「视觉+推理」），模型行一键应用
  app.get('/api/config/model-tag-templates', (c) => {
    return c.json({ templates: ctx.config.model_tag_templates ?? [] });
  });

  app.put('/api/config/model-tag-templates', async (c) => {
    const { saveTagTemplates } = await import('../configStore');
    const body = await c.req.json<{ templates?: any[] }>();
    const templates = body.templates;
    if (!Array.isArray(templates)) throw new HttpError(400, 'templates must be an array');
    const cleaned = templates.map((t) => ({
      name: String(t?.name ?? '').trim(),
      tags: Array.isArray(t?.tags) ? t.tags.map((x: any) => String(x).trim()).filter(Boolean) : [],
    }));
    for (const t of cleaned) {
      if (!t.name) throw new HttpError(400, 'each template needs a name');
    }
    const names = new Set<string>();
    for (const t of cleaned) {
      if (names.has(t.name)) throw new HttpError(400, `duplicate template name: ${t.name}`);
      names.add(t.name);
    }
    saveTagTemplates(cleaned);
    ctx.config.model_tag_templates = cleaned;
    return c.json({ status: 'saved', templates: cleaned });
  });

  // feature: 模型长度模板 —— 用户自定义命名长度值（如 256K=262144），上下文/输出上限一键应用
  app.get('/api/config/model-length-templates', (c) => {
    return c.json({ templates: ctx.config.model_length_templates ?? [] });
  });

  app.put('/api/config/model-length-templates', async (c) => {
    const { saveLengthTemplates } = await import('../configStore');
    const body = await c.req.json<{ templates?: any[] }>();
    const templates = body.templates;
    if (!Array.isArray(templates)) throw new HttpError(400, 'templates must be an array');
    const cleaned = templates.map((t) => ({
      name: String(t?.name ?? '').trim(),
      value: Math.max(0, Math.floor(Number(t?.value))),
    }));
    for (const t of cleaned) {
      if (!t.name) throw new HttpError(400, 'each template needs a name');
      if (!Number.isFinite(t.value) || t.value <= 0) throw new HttpError(400, `template ${t.name} needs a positive numeric value`);
    }
    const names = new Set<string>();
    for (const t of cleaned) {
      if (names.has(t.name)) throw new HttpError(400, `duplicate template name: ${t.name}`);
      names.add(t.name);
    }
    saveLengthTemplates(cleaned);
    ctx.config.model_length_templates = cleaned;
    return c.json({ status: 'saved', templates: cleaned });
  });

  app.post('/api/config/model-pool/test', async (c) => {
    const { chat } = await import('../llm');
    const { makeEntry } = await import('../scheduler');
    const body = await c.req.json<{ id?: string; name?: string; api_key?: string; base_url?: string }>();

    if (!body.id && !body.name) throw new HttpError(400, 'id or name is required');

    // id-only form: test an already-configured pool entry without re-entering its key
    let apiKey = body.api_key;
    let baseUrl = body.base_url;
    let testName = body.name;
    if (!apiKey || !baseUrl) {
      const existing = ctx.modelPool.getModel(body.id || body.name || '');
      if (!existing) throw new HttpError(404, `model not in pool: ${body.id || body.name} (api_key/base_url required for unknown models)`);
      apiKey = apiKey || existing.api_key;
      baseUrl = baseUrl || existing.base_url;
      testName = testName || existing.name;
    }

    const entry = makeEntry({
      id: body.id || `test-${Date.now()}`,
      name: testName || body.name || 'test',
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

  // 包 D（2026-09-16）：全局命令权限——设置界面替代手改 config.yaml
  app.get('/api/config/permissions', async (c) => {
    const { readPermissions } = await import('../configStore');
    const { GLOBAL_PERMISSION_LEVELS } = await import('../sandbox');
    return c.json({ permissions: readPermissions(), levels: GLOBAL_PERMISSION_LEVELS });
  });

  app.put('/api/config/permissions', async (c) => {
    const { savePermissions } = await import('../configStore');
    const { policyFromConfig, GLOBAL_PERMISSION_LEVELS } = await import('../sandbox');
    const body = await c.req.json<{ level?: string; whitelist_commands?: string[]; max_time_sec?: number }>();
    const level = String(body.level || '').trim();
    // 全局权限：2026-09-23 起六档全开（unrestricted 曾只给协作会话；写/删文件仍锁项目内）
    if (!(GLOBAL_PERMISSION_LEVELS as string[]).includes(level)) throw new HttpError(400, `level 必须是以下之一: ${GLOBAL_PERMISSION_LEVELS.join(' | ')}`);
    if (!Array.isArray(body.whitelist_commands)) throw new HttpError(400, 'whitelist_commands must be an array');
    const whitelist = body.whitelist_commands.map((s) => String(s).trim()).filter(Boolean);
    const maxTime = body.max_time_sec !== undefined ? Math.max(1, Math.floor(Number(body.max_time_sec) || 300)) : undefined;
    const permissions = { level, whitelist_commands: whitelist, ...(maxTime !== undefined ? { max_time_sec: maxTime } : {}) };
    savePermissions(permissions);
    ctx.config.permissions = permissions;
    // 运行时热更：新任务立即按新策略执行（无需重启）
    ctx.orchestrator.setPolicy(policyFromConfig(permissions));
    return c.json({ status: 'saved', permissions });
  });

  // ---------- 外部 MCP 服务管理（MCP client） ----------

  app.get('/api/config/mcp', (c) => {
    return c.json({
      servers: ctx.config.mcp?.servers || [],
      runtime: ctx.mcp ? ctx.mcp.status() : [],
    });
  });

  app.put('/api/config/mcp', async (c) => {
    const body = await c.req.json<{ servers?: unknown }>();
    const { validateMcpServerConfigs } = await import('../mcp/manager');
    const { saveMcpServers } = await import('../configStore');
    let servers: McpServerConfig[];
    try {
      servers = validateMcpServerConfigs(body.servers);
    } catch (e: any) {
      throw new HttpError(400, String(e?.message || e));
    }
    saveMcpServers(servers);
    ctx.config.mcp = servers.length ? { servers } : undefined;
    // 保存即热生效：差异重连（新增/变更连，删除/禁用断），未变更的不动
    if (ctx.mcp) await ctx.mcp.applyConfig(servers);
    return c.json({ status: 'saved', servers, runtime: ctx.mcp ? ctx.mcp.status() : [] });
  });

  app.post('/api/config/mcp/test', async (c) => {
    const body = await c.req.json<{ server?: unknown }>();
    const { validateMcpServerConfigs, probeMcpServer } = await import('../mcp/manager');
    let cfg: McpServerConfig;
    try {
      cfg = validateMcpServerConfigs([body.server])[0];
    } catch (e: any) {
      throw new HttpError(400, String(e?.message || e));
    }
    // 不落盘探测：连上 → listTools → 关闭；成功带工具数，失败带具体报错
    const result = await probeMcpServer(cfg);
    return c.json(result, result.ok ? 200 : 400);
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
    // P1.5 裁决回流：用户对问题报告的裁决（修什么/怎么修）沉淀为知识——同类问题下次直接命中
    try {
      const { writeKnowledge } = await import('../knowledge');
      writeKnowledge({
        title: `问题裁决：${item.category} · ${item.sample.slice(0, 50)}`,
        content: `问题模式：${item.sample.slice(0, 500)}\n\n用户裁决：${body.action === 'skip' ? '已确认忽略' : `已转修复任务 ${repairTaskId || ''}`}\n来源：每日问题报告 ${date}（${item.count} 次出现）`,
        category: 'feedback',
        project_id: undefined,
        tags: ['问题报告', body.action],
        source: `daily-report:${date}`,
      });
    } catch { /* 裁决回流失败不阻塞响应 */ }
    return c.json({ status: 'resolved', action: body.action, task_id: repairTaskId, report: updated });
  });

  // ---------- P1.5 Dream 整理线程（手动触发 + 治理报告查询） ----------

  app.post('/api/dream/run', async (c) => {
    const { runDreamConsolidation } = await import('../dream');
    const body = await readJsonAuto<{ force?: boolean }>(c).catch(() => ({}) as { force?: boolean });
    const result = await runDreamConsolidation(ctx.modelPool, logger, { force: body?.force === true });
    return c.json({ status: 'done', ...result });
  });

  app.get('/api/dream/report', async (c) => {
    const date = c.req.query('date') || new Date().toISOString().slice(0, 10);
    const report = await import('../bus').then((m) => m.busGet(`dream:governance:${date}`));
    return c.json({ date, ...(report || { candidates: [] }) });
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
      tasks_success: taskRows.filter((t) => t.status === 'success' || t.status === 'completed_with_warnings').length,
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

  // ---------- 协作会话（单 agent 长对话直接操作项目） ----------

  registerConvoRoutes(app, ctx);

  // ---------- OpenCode 接管（外部运行时面板 / 服务端集成） ----------

  registerOpencodeRoutes(app, ctx);

  // ---------- co-team 作为 MCP server（opencode 等外部客户端反向调用） ----------

  registerCoteamMcpRoutes(app, ctx);

  // ---------- feishu bot (event subscription mode) ----------

  if (ctx.config.feishu?.app_id && ctx.config.feishu.app_secret) {
    // SEC-P0：encrypt_key 与 verification_token 都未配置 = webhook 无鉴权（任何人可建任务入队），
    // 此时拒绝挂载路由
    if (!ctx.config.feishu.encrypt_key && !ctx.config.feishu.verification_token) {
      logger.warn('Feishu webhook NOT mounted: no encrypt_key / verification_token configured (unauthenticated webhook is disabled by SEC-P0)');
    } else {
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
      // 外部 MCP 服务连接状态（MCP client）：web 状态灯与 mobile 状态列表共用
      mcp: ctx.mcp ? ctx.mcp.status() : [],
    });
  });

  app.get('/api/metrics', async (c) => {
    const agentStats: Record<string, { tasks: number; completed: number; failed: number; retries: number; tokens: number }> = {};
    const failureTypes: Record<string, number> = {};
    let tasksTotal = 0;
    let tasksSuccess = 0;
    const graphs = await listTaskGraphs();
    for (const graph of graphs) {
      tasksTotal += 1;
      if (graph.status === 'success' || graph.status === 'completed_with_warnings') tasksSuccess += 1;
      for (const node of graph.nodes) {
        const agent = node.agent || 'unknown';
        const stat = (agentStats[agent] ||= { tasks: 0, completed: 0, failed: 0, retries: 0, tokens: 0 });
        stat.tasks += 1;
        if (node.status === 'completed') stat.completed += 1;
        else if (node.status === 'failed') stat.failed += 1;
        stat.retries += node.retry_count || 0;
        // OBS-1：per-agent tokens 从节点结果聚合（此前硬编码 0）
        stat.tokens += (node.result as any)?.tokens || (node.result as any)?.execution?.tokens || 0;
        // OBS-1：失败分型聚合
        if (node.status === 'failed') {
          const et = (node as any).error_type || 'other';
          failureTypes[et] = (failureTypes[et] || 0) + 1;
        }
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
      // OBS-1：失败分型构成（budget/precondition/blocker/capacity/content/system/other）
      failure_types: failureTypes,
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

export function attachWebSocket(server: Server, dashboardChannel: string, apiToken?: string): WebSocketServer {
  const wss = new WebSocketServer({ noServer: true });
  const clients = new Set<WebSocket>();

  server.on('upgrade', (request: any, socket: any, head: any) => {
    const url = new URL(request.url, 'http://localhost');
    if (url.pathname !== '/ws/events') return;
    // SEC-P0：配置 API token 后，WS 升级同样要求 ?token= 匹配
    if (apiToken && url.searchParams.get('token') !== apiToken) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
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
