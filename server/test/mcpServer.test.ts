import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import type { ApiContext } from '../src/api';
import type { AppConfig } from '../src/config';
import type { TaskGraph } from '../src/types';
import type { SearchHit } from '../src/knowledge';
import { registerCoteamMcpRoutes } from '../src/mcpServer/server';
import type { CoteamToolSeams } from '../src/mcpServer/tools';

// ---------- 假依赖缝（不碰真实 store/knowledge/orchestrator） ----------

const GRAPHS: TaskGraph[] = [
  {
    task_id: 't1aaaa',
    nodes: [
      { id: 'n1', task_id: 't1aaaa', name: '搭骨架', status: 'completed', agent: 'dev', result: null, error: '', retry_count: 0, complexity: 'normal', requires_approval: false, needs_human: false, created_at: '2026-09-20 10:00:00', updated_at: '2026-09-20 10:00:00' } as any,
      { id: 'n2', task_id: 't1aaaa', name: '补测试', status: 'pending', agent: 'dev', result: null, error: '', retry_count: 0, complexity: 'normal', requires_approval: false, needs_human: false, created_at: '2026-09-20 10:00:00', updated_at: '2026-09-20 10:00:00' } as any,
    ],
    edges: [],
    description: '给 MCP 反向层补测试\n补充：覆盖鉴权与参数校验',
    workspace: 'D:/pxx/projects/demo',
    status: 'planned',
    created_at: '2026-09-20 10:00:00',
    updated_at: '2026-09-20 11:00:00',
    project_id: 'p1',
  },
  {
    task_id: 't2bbbb',
    nodes: [],
    edges: [],
    description: '',
    workspace: 'D:/pxx/projects/demo2',
    status: 'running',
    created_at: '2026-09-21 09:00:00',
    updated_at: '2026-09-21 09:30:00',
  },
] as unknown as TaskGraph[];

const HITS: SearchHit[] = [
  {
    id: 'k1',
    title: 'vitest 并行测试不稳定',
    category: 'general-tech',
    tags: ['test'],
    source: 'unit-test',
    created_at: '2026-09-01 00:00:00',
    updated_at: '2026-09-01 00:00:00',
    content: '经验正文：并行文件互踩 tmp 目录时先查 fileParallelism。',
    score: 4.2,
  },
] as unknown as SearchHit[];

function makeSeams(overrides: Partial<CoteamToolSeams> = {}): CoteamToolSeams {
  return {
    listTasks: async () => GRAPHS,
    getTask: async (taskId) => GRAPHS.find((g) => g.task_id === taskId) ?? null,
    createTask: async (input) => {
      // 模拟 agent 校验失败（与默认缝同口径）
      if (input.agent && input.agent !== 'dev') {
        throw new Error(`agent 不存在：${input.agent}（可用 agent：dev, reviewer）`);
      }
      return { task_id: 'fake123', workspace: `/tmp/ws/${input.title}`, node_id: 'n-fake123', status: 'pending' };
    },
    searchKnowledge: async (_query, limit) => HITS.slice(0, limit),
    listAgents: () => [
      { name: 'dev', role: '开发', description: '写代码与测试' },
      { name: 'reviewer', role: '审查', description: '挑刺' },
    ],
    ...overrides,
  };
}

function makeCtx(token: string | undefined): ApiContext {
  return {
    config: {
      dashboard: token === undefined ? { host: '127.0.0.1', port: 8855 } : { host: '127.0.0.1', port: 8855, token },
      projects: { root: 'D:/pxx/projects', selfdev_root: 'D:/pxx/selfdev' },
    } as unknown as AppConfig,
    orchestrator: {} as any,
    modelPool: {} as any,
    taskQueue: {} as any,
  };
}

/** 构造一个挂了 /mcp/coteam 的 Hono app（每次测试独立注册） */
function makeApp(token: string | undefined, seams?: CoteamToolSeams): Hono {
  const app = new Hono();
  registerCoteamMcpRoutes(app, makeCtx(token), seams ? { seams } : undefined);
  return app;
}

const TOKEN = 'test-token-1234';

/** JSON-RPC over Streamable HTTP（stateless，无需会话头） */
function rpc(app: Hono, method: string, params?: unknown, opts: { auth?: string; id?: number } = {}) {
  const { auth = TOKEN, id = 1 } = opts;
  return app.request('/mcp/coteam', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      // Streamable HTTP 规范：client 必须同时接受两种响应内容类型
      Accept: 'application/json, text/event-stream',
      ...(auth ? { Authorization: `Bearer ${auth}` } : {}),
    },
    body: JSON.stringify({ jsonrpc: '2.0', id, method, ...(params !== undefined ? { params } : {}) }),
  });
}

async function rpcResult(app: Hono, method: string, params?: unknown, opts?: { auth?: string }) {
  const res = await rpc(app, method, params, opts);
  expect(res.status).toBe(200);
  const body = await res.json() as any;
  expect(body.error).toBeUndefined();
  return body.result;
}

// ---------- 鉴权 ----------

describe('mcpServer 鉴权（/mcp/coteam）', () => {
  it('未带 token → 401', async () => {
    const res = await rpc(makeApp(TOKEN), 'initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'test', version: '0.0.1' },
    }, { auth: '' });
    expect(res.status).toBe(401);
    const body = await res.json() as any;
    expect(String(body.error || body.detail || '')).toContain('unauthorized');
  });

  it('token 不对 → 401', async () => {
    const res = await rpc(makeApp(TOKEN), 'ping', undefined, { auth: 'wrong-token' });
    expect(res.status).toBe(401);
  });

  it('config 未配置 dashboard.token → 503 且错误信息可读（不静默放行）', async () => {
    const app = makeApp(undefined);
    const noAuth = await rpc(app, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } }, { auth: '' });
    expect(noAuth.status).toBe(503);
    const body = await noAuth.json() as any;
    expect(String(body.error)).toContain('dashboard.token');
    // 配了 token 也一样拒绝：未配置时 endpoint 整体关门
    const withAuth = await rpc(app, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } });
    expect(withAuth.status).toBe(503);
  });

  it('GET → 405（stateless endpoint 不挂独立 SSE 流）', async () => {
    const res = await makeApp(TOKEN).request('/mcp/coteam', {
      method: 'GET',
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(405);
  });
});

// ---------- MCP 协议与工具清单 ----------

describe('mcpServer 协议握手与工具清单', () => {
  it('initialize 成功且自报 co-team 身份', async () => {
    const result = await rpcResult(makeApp(TOKEN, makeSeams()), 'initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'opencode', version: '0.0.1' },
    });
    expect(result.serverInfo.name).toBe('co-team');
    expect(result.capabilities.tools).toBeTruthy();
  });

  it('tools/list 返回 5 个工具且声明完整', async () => {
    const result = await rpcResult(makeApp(TOKEN, makeSeams()), 'tools/list');
    const names = (result.tools || []).map((t: any) => t.name).sort();
    expect(names).toEqual([
      'coteam_create_task',
      'coteam_get_task',
      'coteam_list_agents',
      'coteam_list_tasks',
      'coteam_search_knowledge',
    ]);
    for (const t of result.tools) {
      expect(typeof t.description).toBe('string');
      expect(t.description.length).toBeGreaterThan(0);
      expect(t.inputSchema.type).toBe('object');
    }
    const getTask = result.tools.find((t: any) => t.name === 'coteam_get_task');
    expect(getTask.inputSchema.required).toContain('task_id');
    const createTask = result.tools.find((t: any) => t.name === 'coteam_create_task');
    expect(createTask.inputSchema.required).toContain('title');
  });
});

// ---------- 工具调用 ----------

describe('mcpServer tools/call', () => {
  it('coteam_list_agents 返回假缝里的 agent', async () => {
    const result = await rpcResult(makeApp(TOKEN, makeSeams()), 'tools/call', {
      name: 'coteam_list_agents',
      arguments: {},
    });
    expect(result.isError).toBeUndefined();
    const payload = JSON.parse(result.content[0].text);
    expect(payload.agents.map((a: any) => a.name)).toEqual(['dev', 'reviewer']);
    expect(payload.agents[0]).toMatchObject({ role: '开发' });
  });

  it('coteam_search_knowledge 成功（容忍空结果但不报错）', async () => {
    const hit = await rpcResult(makeApp(TOKEN, makeSeams()), 'tools/call', {
      name: 'coteam_search_knowledge',
      arguments: { query: 'vitest' },
    });
    expect(hit.isError).toBeUndefined();
    const payload = JSON.parse(hit.content[0].text);
    expect(payload.count).toBe(1);
    expect(payload.entries[0]).toMatchObject({ title: 'vitest 并行测试不稳定', score: 4.2 });

    // 空结果也是正常返回（不抛错）
    const empty = await rpcResult(makeApp(TOKEN, makeSeams({ searchKnowledge: async () => [] })), 'tools/call', {
      name: 'coteam_search_knowledge',
      arguments: { query: '不存在的词' },
    });
    expect(empty.isError).toBeUndefined();
    expect(JSON.parse(empty.content[0].text).count).toBe(0);
  });

  it('coteam_list_tasks 取前 20 条并只含摘要字段', async () => {
    const result = await rpcResult(makeApp(TOKEN, makeSeams()), 'tools/call', { name: 'coteam_list_tasks', arguments: {} });
    const payload = JSON.parse(result.content[0].text);
    expect(payload.total).toBe(2);
    expect(payload.tasks[0]).toMatchObject({ id: 't1aaaa', status: 'planned', project_id: 'p1' });
    // 大图字段不进列表输出
    expect(payload.tasks[0].nodes).toBeUndefined();
    expect(payload.tasks[0].workspace).toBeUndefined();
  });

  it('coteam_get_task 返回节点状态摘要（不塞完整大图）', async () => {
    const result = await rpcResult(makeApp(TOKEN, makeSeams()), 'tools/call', {
      name: 'coteam_get_task',
      arguments: { task_id: 't1aaaa' },
    });
    const payload = JSON.parse(result.content[0].text);
    expect(payload.task_id).toBe('t1aaaa');
    expect(payload.nodes.map((n: any) => [n.id, n.name, n.status, n.agent])).toEqual([
      ['n1', '搭骨架', 'completed', 'dev'],
      ['n2', '补测试', 'pending', 'dev'],
    ]);
    // 每个节点只有 4 个摘要字段
    for (const n of payload.nodes) expect(Object.keys(n).sort()).toEqual(['agent', 'id', 'name', 'status']);
  });

  it('coteam_get_task 任务不存在 → isError 且消息可读', async () => {
    const result = await rpcResult(makeApp(TOKEN, makeSeams()), 'tools/call', {
      name: 'coteam_get_task',
      arguments: { task_id: 'nope' },
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('任务不存在');
    expect(result.content[0].text).toContain('nope');
  });

  it('参数缺失（缺 task_id）→ isError 且消息可读（不炸连接）', async () => {
    const result = await rpcResult(makeApp(TOKEN, makeSeams()), 'tools/call', {
      name: 'coteam_get_task',
      arguments: {},
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('task_id');
  });

  it('参数类型错误（task_id 传数字）→ isError', async () => {
    const result = await rpcResult(makeApp(TOKEN, makeSeams()), 'tools/call', {
      name: 'coteam_get_task',
      arguments: { task_id: 12345 },
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('字符串');
  });

  it('未知工具 → isError 并列出可用工具', async () => {
    const result = await rpcResult(makeApp(TOKEN, makeSeams()), 'tools/call', {
      name: 'coteam_do_magic',
      arguments: {},
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('未知工具');
    expect(result.content[0].text).toContain('coteam_list_agents');
  });

  it('coteam_create_task 成功落库（不自动执行）', async () => {
    const result = await rpcResult(makeApp(TOKEN, makeSeams()), 'tools/call', {
      name: 'coteam_create_task',
      arguments: { title: '给 co-team 写 MCP 桥', description: '覆盖 5 个工具' },
    });
    expect(result.isError).toBeUndefined();
    const payload = JSON.parse(result.content[0].text);
    expect(payload.task_id).toBe('fake123');
    expect(payload.status).toBe('pending');
    // 语义明示：执行是人工动作
    expect(payload.note).toContain('execute');
  });

  it('coteam_create_task 依赖抛错（agent 不存在）→ isError 回喂原文，不炸连接', async () => {
    const result = await rpcResult(makeApp(TOKEN, makeSeams()), 'tools/call', {
      name: 'coteam_create_task',
      arguments: { title: 'x', agent: 'ghost' },
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('agent 不存在');
    expect(result.content[0].text).toContain('ghost');
  });

  it('coteam_create_task 缺 title → isError 且消息可读', async () => {
    const result = await rpcResult(makeApp(TOKEN, makeSeams()), 'tools/call', {
      name: 'coteam_create_task',
      arguments: { description: '只有描述没有标题' },
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('title');
  });

  it('依赖持续抛错（store 挂）也不炸连接：连续两次都是 isError', async () => {
    const broken = makeSeams({
      listTasks: async () => { throw new Error('redis 未连接'); },
      getTask: async () => { throw new Error('redis 未连接'); },
    });
    const app = makeApp(TOKEN, broken);
    for (const call of [
      { name: 'coteam_list_tasks', arguments: {} },
      { name: 'coteam_get_task', arguments: { task_id: 't1aaaa' } },
    ]) {
      const result = await rpcResult(app, 'tools/call', call);
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('redis 未连接');
    }
  });

  it('单次结果超长 → 截断到 16000 字符并标注', async () => {
    // 500 个节点 × ~60 字符 ≈ 30K，远超 16000 预算
    const big = makeSeams({
      getTask: async () => ({
        ...GRAPHS[0],
        nodes: Array.from({ length: 500 }, (_, i) => ({
          id: `n${i}`,
          task_id: 't1aaaa',
          name: `节点${i}`,
          status: 'pending',
          agent: 'dev',
          result: null,
          error: '',
          retry_count: 0,
          complexity: 'normal',
          requires_approval: false,
          needs_human: false,
          created_at: '2026-09-20 10:00:00',
          updated_at: '2026-09-20 10:00:00',
        })) as any,
      }),
    });
    const result = await rpcResult(makeApp(TOKEN, big), 'tools/call', {
      name: 'coteam_get_task',
      arguments: { task_id: 't1aaaa' },
    });
    const text = result.content[0].text as string;
    expect(text.length).toBeLessThanOrEqual(16000 + 40);
    expect(text).toContain('已截断');
  });

  it('知识条目正文超 1200 字符 → 条目级截断标注', async () => {
    const long = makeSeams({ searchKnowledge: async () => [{ ...HITS[0], content: 'y'.repeat(5000) }] as any });
    const result = await rpcResult(makeApp(TOKEN, long), 'tools/call', {
      name: 'coteam_search_knowledge',
      arguments: { query: 'big' },
    });
    const content = JSON.parse(result.content[0].text).entries[0].content as string;
    expect(content.length).toBeLessThanOrEqual(1200 + 30);
    expect(content).toContain('正文已截断');
  });
});
