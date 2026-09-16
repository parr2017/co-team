import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { applyToolCalls, type KnowledgeToolContext } from '../src/tools';
import { buildAgentHarness } from '../src/harness';
import { McpManager, validateMcpServerConfigs } from '../src/mcp/manager';
import type { McpServerConfig } from '../src/mcp/types';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';

// ---------- 进程内 MCP 测试 server（InMemoryTransport，不 spawn 真实进程） ----------

function makeTestServer() {
  const server = new Server({ name: 'test-mcp', version: '1.0.0' }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      { name: 'Echo', description: '回显输入文本', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } },
      { name: 'BigOutput', description: '返回超长文本', inputSchema: { type: 'object', properties: {} } },
      { name: 'Fail', description: '返回 isError', inputSchema: { type: 'object', properties: {} } },
    ],
  }));
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const name = req.params.name;
    const args = (req.params.arguments || {}) as Record<string, unknown>;
    if (name === 'Echo') return { content: [{ type: 'text', text: `echo:${args.text}` }] };
    if (name === 'BigOutput') return { content: [{ type: 'text', text: 'x'.repeat(50000) }] };
    if (name === 'Fail') return { content: [{ type: 'text', text: 'boom' }], isError: true };
    return { content: [{ type: 'text', text: `unknown:${name}` }] };
  });
  return server;
}

/** transport 工厂被测试缝替换：server 名 → 预创建的 InMemory client 侧 transport */
const transports = new Map<string, Transport>();

class TestMcpManager extends McpManager {
  protected override createTransport(cfg: McpServerConfig): Transport {
    const t = transports.get(cfg.name);
    if (!t) throw new Error(`no in-memory transport for ${cfg.name}`);
    return t;
  }
}

const silentLogger = { debug() {}, info() {}, warn() {}, error() {} } as any;

async function waitConnected(manager: McpManager, name: string, timeoutMs = 5000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const st = manager.status().find((s) => s.name === name);
    if (st?.connected) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return false;
}

let manager: TestMcpManager;
const testCfg: McpServerConfig = { name: 'test', type: 'stdio', command: 'unused', timeout_sec: 5, max_result_chars: 200 };

beforeAll(async () => {
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  transports.set('test', clientT);
  const server = makeTestServer();
  await server.connect(serverT);
  manager = new TestMcpManager([testCfg], silentLogger);
  manager.setAgentServersProvider((agent) => (agent === 'dev' ? ['test'] : []));
  manager.start();
  expect(await waitConnected(manager, 'test')).toBe(true);
});

afterAll(async () => {
  await manager?.stop();
});

function ctxWith(agent: string, withBridge = true): KnowledgeToolContext {
  return { agent, ...(withBridge ? { mcp: manager } : {}) };
}

// ---------- McpBridge / 注册表 ----------

describe('McpManager：连接与 agent 白名单', () => {
  it('InMemory server 连接成功并拿到工具注册表（原始名）', () => {
    const st = manager.status()[0];
    expect(st).toMatchObject({ name: 'test', connected: true, toolCount: 3 });
  });

  it('toolsIndex 教学名统一小写且字节稳定；未绑定 agent 返回空串', () => {
    const a = manager.toolsIndex('dev');
    expect(a).toContain('mcp__test__echo');
    expect(a).toContain('mcp__test__bigoutput');
    expect(a).toContain('"arguments"');
    expect(a).toBe(manager.toolsIndex('dev'));
    expect(manager.toolsIndex('stranger')).toBe('');
  });
});

// ---------- applyToolCalls mcp__ 分支 ----------

describe('applyToolCalls mcp__ 分支', () => {
  it('arguments 透传并拿到 text output', async () => {
    const r = await applyToolCalls('/tmp', [{ tool: 'mcp__test__echo', arguments: { text: 'hi' } }], ctxWith('dev'));
    expect(r[0]).toMatchObject({ tool: 'mcp__test__echo', ok: true, server: 'test', output: 'echo:hi' });
  });

  it('工具名大小写不敏感（模型侧 lowerCase 纪律）', async () => {
    const r = await applyToolCalls('/tmp', [{ tool: 'mcp__TEST__ECHO', arguments: { text: 'up' } }], ctxWith('dev'));
    expect(r[0]).toMatchObject({ ok: true, output: 'echo:up' });
  });

  it('模型没写 arguments 时平铺字段兜底为参数', async () => {
    const r = await applyToolCalls('/tmp', [{ tool: 'mcp__test__echo', text: 'flat' }], ctxWith('dev'));
    expect(r[0]).toMatchObject({ ok: true, output: 'echo:flat' });
  });

  it('缺桥 → 软错误（不炸轮次）', async () => {
    const r = await applyToolCalls('/tmp', [{ tool: 'mcp__test__echo', arguments: { text: 'x' } }], ctxWith('dev', false));
    expect(r[0]).toMatchObject({ ok: false });
    expect(String((r[0] as any).error)).toContain('MCP');
  });

  it('agent 未绑定该 server → 软错误', async () => {
    const r = await applyToolCalls('/tmp', [{ tool: 'mcp__test__echo', arguments: { text: 'x' } }], ctxWith('stranger'));
    expect(r[0]).toMatchObject({ ok: false });
    expect(String((r[0] as any).error)).toContain('未绑定');
  });

  it('未知 server / 未知工具 → 软错误', async () => {
    const noServer = await applyToolCalls('/tmp', [{ tool: 'mcp__nope__x' }], ctxWith('dev'));
    expect(noServer[0]).toMatchObject({ ok: false });
    const noTool = await applyToolCalls('/tmp', [{ tool: 'mcp__test__nope' }], ctxWith('dev'));
    expect(noTool[0]).toMatchObject({ ok: false });
  });

  it('畸形名字（缺服务或工具段）→ 软错误', async () => {
    const bad = await applyToolCalls('/tmp', [{ tool: 'mcp__broken' }], ctxWith('dev'));
    expect(bad[0]).toMatchObject({ ok: false });
  });

  it('MCP isError → ok:false 且错误原文回喂', async () => {
    const r = await applyToolCalls('/tmp', [{ tool: 'mcp__test__fail' }], ctxWith('dev'));
    expect(r[0]).toMatchObject({ ok: false, error: 'boom' });
  });

  it('结果超长按 max_result_chars 截断并标记 truncated', async () => {
    const r = await applyToolCalls('/tmp', [{ tool: 'mcp__test__bigoutput' }], ctxWith('dev'));
    const out = r[0] as any;
    expect(out.ok).toBe(true);
    expect(out.truncated).toBe(true);
    expect(out.output.length).toBeLessThan(50000);
    expect(out.output).toContain('截断');
  });

  it('软错误纪律：mcp__ 分支任何路径都不 throw', async () => {
    const results = await applyToolCalls('/tmp', [
      { tool: 'mcp__test__echo', arguments: { text: 'a' } },
      { tool: 'mcp__nope__x' },
      { tool: 'mcp__broken' },
    ], ctxWith('dev', false));
    expect(results).toHaveLength(3);
    expect(results.every((r: any) => r.ok === false)).toBe(true);
  });
});

// ---------- validateMcpServerConfigs ----------

describe('validateMcpServerConfigs（PUT /api/config/mcp 的结构校验）', () => {
  it('合法 stdio/http 配置通过并归一化', () => {
    const out = validateMcpServerConfigs([
      { name: 'FS', type: 'stdio', command: 'npx', args: ['-y', 'pkg'], allow_tools: ['Read_File'] },
      { name: 'gh', type: 'http', url: 'http://127.0.0.1:8931/mcp', headers: { Authorization: 'Bearer x' } },
    ]);
    expect(out[0]).toMatchObject({ name: 'fs', type: 'stdio', enabled: true, allow_tools: ['read_file'] });
    expect(out[1]).toMatchObject({ name: 'gh', type: 'http', url: 'http://127.0.0.1:8931/mcp' });
  });

  it('非法输入逐项拒绝', () => {
    expect(() => validateMcpServerConfigs('nope')).toThrow();
    expect(() => validateMcpServerConfigs([{ name: 'Bad Name!', type: 'stdio', command: 'x' }])).toThrow(/服务名/);
    expect(() => validateMcpServerConfigs([{ name: 'dup', type: 'stdio', command: 'x' }, { name: 'dup', type: 'stdio', command: 'y' }])).toThrow(/重复/);
    expect(() => validateMcpServerConfigs([{ name: 'a', type: 'stdio' }])).toThrow(/command/);
    expect(() => validateMcpServerConfigs([{ name: 'b', type: 'http', url: 'not-a-url' }])).toThrow(/url/);
    expect(() => validateMcpServerConfigs([{ name: 'c', type: 'http', url: 'ftp://x/y' }])).toThrow(/url/);
  });
});

// ---------- harness 教学注入 ----------

describe('harness mcpBlock 注入（L3）', () => {
  const baseCtx = {
    name: 'dev',
    role: '后端开发',
    description: '',
    prompt: 'x',
  };

  it('有 mcpBlock 时渲染进 L3；无时零输出', () => {
    const withMcp = buildAgentHarness({ ...baseCtx, mcpBlock: '服务器 test：\n- mcp__test__echo：回显' });
    expect(withMcp).toContain('### 外部 MCP 工具');
    expect(withMcp).toContain('mcp__test__echo');
    const without = buildAgentHarness(baseCtx);
    expect(without).not.toContain('外部 MCP 工具');
  });
});
