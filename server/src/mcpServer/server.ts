/**
 * W3 反向层 —— 把 co-team 暴露成一个 MCP server（供 opencode 等 MCP client 调用）。
 *
 * 职责：
 * - 在 /mcp/coteam 提供 Streamable HTTP transport：
 *   stateless 模式（每次请求新建 Server 实例，无会话内存增长）+ JSON 响应
 *   （enableJsonResponse，响应完整落地后即可整体关闭，无悬挂 SSE 流）；
 * - 鉴权复用 dashboard.token：Authorization: Bearer <token> 精确匹配才放行；
 *   未配置 token 时拒绝全部请求并返回明确错误（本机自托管服务不应无门禁暴露
 *   写能力，与 feishu webhook 未配密钥拒绝挂载同思路）；
 * - 工具白名单（只读默认 + 1 个创建）见 tools.ts；handler 内全部软错误收口，
 *   绝不 throw 炸连接。
 *
 * 挂载由主会话完成（一行）：registerCoteamMcpRoutes(app, ctx)——参考 registerConvoRoutes。
 */
import * as path from 'node:path';
import { Hono } from 'hono';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import type { ApiContext } from '../api';
import { PROJECT_ROOT } from '../config';
import { getLogger } from '../logger';
import { slugifyProjectName } from '../workspace';
import type { TaskNode } from '../types';
import { COTEAM_TOOLS, callCoteamTool, type CoteamToolSeams } from './tools';

/** MCP endpoint 挂载点（与 dashboard 同端口，供 opencode.json 的 remote MCP 配置） */
export const COTEAM_MCP_PATH = '/mcp/coteam';

/** MCP server 自报身份（client 侧 initialize 可见） */
const MCP_SERVER_NAME = 'co-team';
const MCP_SERVER_VERSION = '0.2.0';

/** 任务缺省执行 agent（与 planner fallbackGraph 的 dev 兜底一致） */
const DEFAULT_AGENT = 'dev';

/** projects.root 缺省值（config.projects 未配置时，与 api/index.ts 同口径） */
function projectsRoot(ctx: ApiContext): string {
  return ctx.config.projects?.root || path.resolve(PROJECT_ROOT, '..', 'projects');
}

/**
 * 默认依赖缝：接真实 store / knowledge / orchestrator。
 * store/knowledge 用动态 import（与 api/index.ts 同模式）——反向层被挂载但无请求时
 * 零开销；测试可通过 registerCoteamMcpRoutes 的 opts.seams 注入假实现。
 */
export function defaultCoteamToolSeams(ctx: ApiContext): CoteamToolSeams {
  return {
    listTasks: async () => (await import('../store')).listTaskGraphs(),
    getTask: async (taskId) => (await import('../store')).getTaskGraph(taskId),
    createTask: async (input) => {
      const { saveTaskGraph } = await import('../store');
      const { assertStandaloneWorkspace } = await import('../workspace');
      const title = input.title.trim();
      // agent 白名单校验：拼错名字要在创建时就发现，而不是等执行时静默落空
      const agent = (input.agent || '').trim() || DEFAULT_AGENT;
      if (!ctx.orchestrator.plugins.has(agent)) {
        throw new Error(`agent 不存在：${agent}（可用 agent：${[...ctx.orchestrator.plugins.keys()].join(', ') || '（无）'}）`);
      }
      // 工作区治理与 POST /api/tasks 同口径：不得落在 co-team 自身仓库或其他 git 仓库工作树内
      const workspace = await assertStandaloneWorkspace(
        (input.workspace || '').trim() || path.join(projectsRoot(ctx), slugifyProjectName(title)),
        { projectRoot: PROJECT_ROOT },
      );
      const taskId = Math.random().toString(36).slice(2, 10);
      const nodeId = `n-${taskId}`;
      const now = new Date().toISOString();
      // 单节点骨架任务：落库即 pending，等待人工在界面/接口发车（不自动执行）
      const node: TaskNode = {
        id: nodeId,
        task_id: taskId,
        name: title,
        status: 'pending',
        agent,
        result: null,
        error: '',
        retry_count: 0,
        complexity: 'normal',
        requires_approval: false,
        needs_human: false,
        created_at: now,
        updated_at: now,
      };
      await saveTaskGraph(taskId, [node], [], {
        description: input.description ? `${title}\n\n${input.description}` : title,
        workspace,
        status: 'pending',
      });
      return { task_id: taskId, workspace, node_id: nodeId, status: 'pending' };
    },
    searchKnowledge: async (query, limit) => (await import('../knowledge')).searchKnowledgeHybrid(query, { limit }),
    listAgents: () =>
      [...ctx.orchestrator.plugins.values()].map((p) => ({
        name: p.name,
        role: p.role || '',
        description: p.description || '',
      })),
  };
}

/** 挂载 co-team MCP 反向层（Hono 子 app 隔离鉴权，不影响 /api 已挂路由） */
export function registerCoteamMcpRoutes(app: Hono, ctx: ApiContext, opts?: { seams?: CoteamToolSeams }): void {
  const logger = getLogger();
  const token = (ctx.config.dashboard?.token || '').trim();
  const mcp = new Hono();

  // 未配置 token = 无门禁暴露写能力（coteam_create_task 可建任务入队）——整体拒绝
  if (!token) {
    mcp.all('*', (c) =>
      c.json(
        {
          error: 'co-team MCP 反向层未启用：config.yaml 的 dashboard.token 未配置',
          hint: '在 config/config.yaml 的 dashboard 节配置 token 并重启 co-team 后，本 endpoint 才会放行（鉴权复用同一 token）',
        },
        503,
      ),
    );
    app.route(COTEAM_MCP_PATH, mcp);
    logger.warn('co-team MCP server 已挂载但拒绝所有请求：dashboard.token 未配置（无门禁不外露写能力）', { path: COTEAM_MCP_PATH });
    return;
  }

  // 鉴权：Bearer token 精确匹配（与 /api 的 SEC-P0 门禁同语义）
  mcp.use('*', async (c, next) => {
    const header = c.req.header('Authorization') || '';
    if (header !== `Bearer ${token}`) {
      return c.json({ error: 'unauthorized：/mcp/coteam 需要 Authorization: Bearer <co-team dashboard.token>' }, 401);
    }
    await next();
  });

  mcp.all('*', async (c) => {
    // stateless 模式：GET（独立 SSE 流）无会话可挂、DELETE 无会话可删——
    // 都会让连接无限期悬挂，直接 405（MCP 规范允许 stateless server 拒绝 GET）
    if (c.req.method !== 'POST') {
      return c.json({ error: `method ${c.req.method} not allowed：/mcp/coteam 为 stateless MCP endpoint，只接受 POST` }, 405);
    }
    const seams = opts?.seams ?? defaultCoteamToolSeams(ctx);
    const server = new Server({ name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION }, { capabilities: { tools: {} } });
    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: COTEAM_TOOLS }));
    server.setRequestHandler(CallToolRequestSchema, async (req) =>
      callCoteamTool(seams, req.params.name, req.params.arguments as Record<string, unknown> | undefined),
    );
    // sessionIdGenerator: undefined = 无会话管理（每请求一个全新 transport/server）；
    // enableJsonResponse = 响应为完整 JSON（handleRequest 返回时即落地，可安全关闭）
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    try {
      await server.connect(transport);
      return await transport.handleRequest(c.req.raw);
    } finally {
      await transport.close();
      await server.close();
    }
  });

  app.route(COTEAM_MCP_PATH, mcp);
  logger.info('co-team MCP server mounted', { path: COTEAM_MCP_PATH, tools: COTEAM_TOOLS.length, transport: 'streamable-http(stateless)' });
}
