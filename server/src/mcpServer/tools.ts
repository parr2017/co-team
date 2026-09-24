/**
 * W3 反向层 —— co-team 作为 MCP server 的工具实现（白名单最小化，只读默认）。
 *
 * 职责：
 * - 5 个工具的声明（name / description / JSON schema）与 handler 实现；
 * - 软错误收口（对齐 mcp/manager.ts 纪律）：参数缺失、依赖异常一律以
 *   { isError: true } 的 content 返回，绝不 throw 穿透炸掉 MCP 连接；
 * - store / knowledge 依赖经 CoteamToolSeams 注入（server.ts 接真实实现，
 *   测试接假实现），本文件只 import 类型，不 import 业务模块，保持可测；
 * - 单次结果统一截断到 MAX_RESULT_CHARS（对齐 mcp/types.ts 的 DEFAULT_MCP_MAX_RESULT_CHARS）。
 */
import type { CallToolResult, Tool } from '@modelcontextprotocol/sdk/types.js';
import type { TaskGraph, TaskNode } from '../types';
import type { SearchHit } from '../knowledge';

/** 单次结果截断预算（字符）——与 MCP client 侧默认值对齐 */
const MAX_RESULT_CHARS = 16000;

/** 列表类工具缺省条数（任务清单取前 20 条，避免把整库塞回上下文） */
const LIST_TASKS_LIMIT = 20;

/** 知识条目正文截断长度（字符） */
const KNOWLEDGE_CONTENT_CHARS = 1200;

// ---------- 工具依赖缝（server.ts 接真实实现，测试注入假实现） ----------

export interface CoteamAgentInfo {
  name: string;
  role: string;
  description: string;
}

export interface CoteamCreateTaskInput {
  title: string;
  description?: string;
  workspace?: string;
  agent?: string;
}

export interface CoteamCreateTaskResult {
  task_id: string;
  workspace: string;
  node_id: string;
  status: string;
}

export interface CoteamToolSeams {
  /** 全部任务（listTaskGraphs，按 updated_at 倒序），由工具层截取前 N 条 */
  listTasks(): Promise<TaskGraph[]>;
  /** 单个任务图；不存在返回 null */
  getTask(taskId: string): Promise<TaskGraph | null>;
  /** 直接落库创建任务（不自动执行——执行是 POST /api/tasks/:id/execute 的人工动作） */
  createTask(input: CoteamCreateTaskInput): Promise<CoteamCreateTaskResult>;
  /** 知识库混合检索 */
  searchKnowledge(query: string, limit: number): Promise<SearchHit[]>;
  /** agent 清单（orchestrator.plugins 的 name/role/description） */
  listAgents(): CoteamAgentInfo[];
}

// ---------- 结果封装（软错误 discipline） ----------

/** 工具返回体：直接复用 SDK 的 CallToolResult（content + isError） */
export type CoteamToolResult = CallToolResult;

function ok(payload: unknown): CoteamToolResult {
  return { content: [{ type: 'text', text: truncate(JSON.stringify(payload, null, 2)) }] };
}

function fail(message: string): CoteamToolResult {
  return { content: [{ type: 'text', text: message }], isError: true };
}

function truncate(text: string): string {
  if (text.length <= MAX_RESULT_CHARS) return text;
  return `${text.slice(0, MAX_RESULT_CHARS)}\n…（结果超长已截断到 ${MAX_RESULT_CHARS} 字符，可用更精确参数重取）`;
}

// ---------- 工具声明 ----------

export const COTEAM_TOOLS: Tool[] = [
  {
    name: 'coteam_list_tasks',
    title: '列出 co-team 任务',
    description: '列出 co-team 最近的任务（按更新时间倒序，缺省前 20 条），返回 id/标题/状态/项目/创建时间。只读。',
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'integer', description: '返回条数（1-50，缺省 20）', minimum: 1, maximum: 50 },
      },
      required: [],
    },
  },
  {
    name: 'coteam_get_task',
    title: '查看任务详情',
    description: '按 task_id 查看单个 co-team 任务的状态摘要（含各节点的 id/名称/状态/执行 agent，不返回完整大图）。只读。',
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        task_id: { type: 'string', description: '任务 id（coteam_list_tasks 返回的 id）' },
      },
      required: ['task_id'],
    },
  },
  {
    name: 'coteam_create_task',
    title: '创建 co-team 任务',
    description:
      '在 co-team 创建一个任务草稿（直接落库，不自动规划、不自动执行）。执行是人工动作：创建后调用 co-team 的 POST /api/tasks/<task_id>/execute 或在界面发车。workspace 缺省为 projects.root 下的 slug 目录。',
    annotations: { readOnlyHint: false, destructiveHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: '任务标题（需求的一句话描述）' },
        description: { type: 'string', description: '可选：任务详情/验收标准补充' },
        workspace: { type: 'string', description: '可选：绝对路径工作区（不得位于 co-team 自身仓库或其他 git 仓库工作树内）' },
        agent: { type: 'string', description: '可选：执行 agent 名（须为 coteam_list_agents 中的名字，缺省 dev）' },
      },
      required: ['title'],
    },
  },
  {
    name: 'coteam_search_knowledge',
    title: '检索知识库',
    description: '用关键词检索 co-team 知识库（hybrid：关键词 + 向量语义），返回标题/分类/相关度/正文（截断）。只读。',
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '检索关键词（自然语言）' },
        limit: { type: 'integer', description: '返回条数（1-10，缺省 5）', minimum: 1, maximum: 10 },
      },
      required: ['query'],
    },
  },
  {
    name: 'coteam_list_agents',
    title: '列出 agent',
    description: '列出 co-team 已注册的 agent（名称/角色/描述），可作为 coteam_create_task 的 agent 参数。只读。',
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
];

// ---------- 参数校验 ----------

function strParam(args: Record<string, unknown>, key: string): { value?: string; error?: string } {
  const v = args[key];
  if (v === undefined || v === null || v === '') return { error: `参数缺失：${key} 为必填字符串` };
  if (typeof v !== 'string') return { error: `参数类型错误：${key} 应为字符串，收到 ${Array.isArray(v) ? 'array' : typeof v}` };
  return { value: v };
}

function intParam(args: Record<string, unknown>, key: string, fallback: number, min: number, max: number): number {
  const v = args[key];
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() ? Number(v) : NaN;
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

// ---------- 各工具 handler（内部自带 try/catch，错误以 isError content 返回） ----------

async function listTasksTool(seams: CoteamToolSeams, args: Record<string, unknown>): Promise<CoteamToolResult> {
  try {
    const limit = intParam(args, 'limit', LIST_TASKS_LIMIT, 1, 50);
    const graphs = await seams.listTasks();
    const tasks = graphs.slice(0, limit).map((g) => ({
      id: g.task_id,
      title: (g.description || '').split('\n')[0].trim().slice(0, 100) || g.task_id,
      status: g.status,
      project_id: g.project_id ?? null,
      created_at: g.created_at,
    }));
    return ok({ count: tasks.length, total: graphs.length, tasks });
  } catch (e: any) {
    return fail(`列出任务失败：${String(e?.message || e)}`);
  }
}

async function getTaskTool(seams: CoteamToolSeams, args: Record<string, unknown>): Promise<CoteamToolResult> {
  const p = strParam(args, 'task_id');
  if (p.error) return fail(`${p.error}（示例：{"task_id":"abc12345"}）`);
  try {
    const g = await seams.getTask(p.value!);
    if (!g) return fail(`任务不存在：${p.value}`);
    return ok({
      task_id: g.task_id,
      title: (g.description || '').split('\n')[0].trim().slice(0, 100) || g.task_id,
      status: g.status,
      workspace: g.workspace,
      project_id: g.project_id ?? null,
      created_at: g.created_at,
      updated_at: g.updated_at,
      nodes: g.nodes.map((n: TaskNode) => ({ id: n.id, name: n.name, status: n.status, agent: n.agent })),
    });
  } catch (e: any) {
    return fail(`获取任务 ${p.value} 失败：${String(e?.message || e)}`);
  }
}

async function createTaskTool(seams: CoteamToolSeams, args: Record<string, unknown>): Promise<CoteamToolResult> {
  const p = strParam(args, 'title');
  if (p.error) return fail(`${p.error}（示例：{"title":"给登录页加单元测试"}）`);
  const title = p.value!.trim();
  if (!title) return fail('参数无效：title 不能为空白字符串');
  try {
    const created = await seams.createTask({
      title,
      ...(typeof args.description === 'string' && args.description.trim() ? { description: args.description } : {}),
      ...(typeof args.workspace === 'string' && args.workspace.trim() ? { workspace: args.workspace } : {}),
      ...(typeof args.agent === 'string' && args.agent.trim() ? { agent: args.agent } : {}),
    });
    return ok({
      task_id: created.task_id,
      status: created.status,
      workspace: created.workspace,
      node_id: created.node_id,
      note: '任务已创建（未规划、未执行）。执行是人工动作：调用 co-team 的 POST /api/tasks/<task_id>/execute，或在 co-team 界面「发车」。',
    });
  } catch (e: any) {
    return fail(`创建任务失败：${String(e?.message || e)}`);
  }
}

async function searchKnowledgeTool(seams: CoteamToolSeams, args: Record<string, unknown>): Promise<CoteamToolResult> {
  const p = strParam(args, 'query');
  if (p.error) return fail(`${p.error}（示例：{"query":"vitest 并行测试不稳定"}）`);
  try {
    const limit = intParam(args, 'limit', 5, 1, 10);
    const hits = await seams.searchKnowledge(p.value!, limit);
    const entries = hits.map((h) => ({
      id: h.id,
      title: h.title,
      category: h.category,
      score: h.score,
      content: h.content.length > KNOWLEDGE_CONTENT_CHARS ? `${h.content.slice(0, KNOWLEDGE_CONTENT_CHARS)}…（正文已截断）` : h.content,
    }));
    return ok({ count: entries.length, entries });
  } catch (e: any) {
    return fail(`知识库检索失败：${String(e?.message || e)}`);
  }
}

async function listAgentsTool(seams: CoteamToolSeams, _args: Record<string, unknown>): Promise<CoteamToolResult> {
  try {
    const agents = seams.listAgents();
    return ok({ count: agents.length, agents });
  } catch (e: any) {
    return fail(`列出 agent 失败：${String(e?.message || e)}`);
  }
}

// ---------- 分发入口（最后一道软错误兜底：任何漏网异常都不 throw） ----------

export async function callCoteamTool(
  seams: CoteamToolSeams,
  name: string,
  args: Record<string, unknown> | undefined,
): Promise<CoteamToolResult> {
  const a = args && typeof args === 'object' && !Array.isArray(args) ? args : {};
  try {
    switch (name) {
      case 'coteam_list_tasks':
        return await listTasksTool(seams, a);
      case 'coteam_get_task':
        return await getTaskTool(seams, a);
      case 'coteam_create_task':
        return await createTaskTool(seams, a);
      case 'coteam_search_knowledge':
        return await searchKnowledgeTool(seams, a);
      case 'coteam_list_agents':
        return await listAgentsTool(seams, a);
      default:
        return fail(`未知工具：${name}（可用工具：${COTEAM_TOOLS.map((t) => t.name).join(', ')}）`);
    }
  } catch (e: any) {
    // 理论不可达（各 handler 已各自收口）——仍守住"绝不 throw 穿透连接"的底线
    return fail(`工具 ${name} 执行失败：${String(e?.message || e)}`);
  }
}
