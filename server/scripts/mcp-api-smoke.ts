/**
 * MCP 管理 API 冒烟（进程内 Hono app.request，不占 8855 端口、不打扰运行中的服务）：
 * 1. GET /api/config/mcp → 配置 + 运行时状态
 * 2. POST /api/config/mcp/test → 不落盘探测（真实 stdio filesystem server）
 * 3. PUT /api/config/mcp → 校验失败路径（非法 url 拒绝）
 */
import { createApi, type ApiContext } from '../src/api';
import { McpManager } from '../src/mcp/manager';
import type { Orchestrator } from '../src/orchestrator/orchestrator';
import type { ModelPool } from '../src/scheduler';
import type { TaskQueueManager } from '../src/taskQueue';

async function main() {
  const manager = new McpManager([
    { name: 'fs', type: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', 'D:/pxx/projects'] },
  ], { debug() {}, info() {}, warn() {}, error() {} } as any);
  manager.start();

  const ctx = {
    config: {
      dashboard: { host: '127.0.0.1', port: 0 },
      agents_dir: './agents',
      model_pool: [],
      orchestrator: {} as any,
      permissions: {},
      redis: { host: '127.0.0.1', port: 6399, db: 0 },
      knowledge: { dir: '' },
      mcp: { servers: [{ name: 'fs', type: 'stdio' as const, command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', 'D:/pxx/projects'] }] },
    },
    orchestrator: {} as Orchestrator,
    modelPool: {} as ModelPool,
    taskQueue: {} as TaskQueueManager,
    mcp: manager,
  } as unknown as ApiContext;

  const app = createApi(ctx);
  const j = async (path: string, init?: RequestInit) => {
    const res = await app.request(path, { headers: { authorization: 'Bearer smoke' }, ...init });
    return { status: res.status, body: await res.json() };
  };

  // 等连接建立
  for (let i = 0; i < 80; i++) {
    if (manager.status()[0]?.connected) break;
    await new Promise((r) => setTimeout(r, 250));
  }

  const g = await j('/api/config/mcp');
  console.log('[1] GET /api/config/mcp →', g.status, JSON.stringify(g.body.runtime));

  const t = await j('/api/config/mcp/test', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ server: { name: 'fs', type: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', 'D:/pxx/projects'] } }),
  });
  console.log('[2] POST test(真实 fs) →', t.status, 'ok:', t.body.ok, 'tools:', t.body.tools?.length, t.body.tools?.slice(0, 3).map((x: any) => x.name).join(','));

  const bad = await j('/api/config/mcp/test', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ server: { name: 'b', type: 'http', url: 'http://127.0.0.1:1/mcp' } }),
  });
  console.log('[3] POST test(不可达端口) →', bad.status, 'ok:', bad.body.ok, 'error:', String(bad.body.error || '').slice(0, 120));

  const invalid = await j('/api/config/mcp', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ servers: [{ name: 'Bad Name!', type: 'stdio', command: 'x' }] }),
  });
  console.log('[4] PUT(非法名) →', invalid.status, JSON.stringify(invalid.body));

  const tok = await j('/api/config/mcp/test', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ server: { name: 'noauth', type: 'http', url: 'http://127.0.0.1:1/mcp' } }),
  });
  console.log('[5] 完成对比基线', tok.status);

  await manager.stop();
  process.exit(0);
}

void main();
