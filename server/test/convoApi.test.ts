import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// LLM stub（与 convo.test.ts 同模式）
type Behavior = ((entryName: string) => Promise<{ content: string }> | { content: string }) | undefined;
const behaviors: Behavior[] = [];
vi.mock('../src/llm', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/llm')>();
  return {
    ...actual,
    chat: async (entry: any, _messages: unknown, _mt?: number, _temp?: number, signal?: AbortSignal) => {
      if (signal?.aborted) throw new Error('LLM 调用被外部取消');
      const b = behaviors.shift();
      const run = () => (b ? b(String(entry?.name || '')) : Promise.resolve({ content: JSON.stringify({ reply: '（无行为）' }) }));
      if (!signal) return run();
      return Promise.race([
        Promise.resolve().then(run),
        new Promise<never>((_, rej) => { signal.addEventListener('abort', () => rej(new Error('LLM 调用被外部取消')), { once: true }); }),
      ]);
    },
  };
});

import { initBus, closeBus } from '../src/bus';
import { ModelPool } from '../src/scheduler';
import { Orchestrator } from '../src/orchestrator/orchestrator';
import { createApi } from '../src/api';
import type { AppConfig } from '../src/config';


const fakeLogger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } as any;
let tmp: string;
let app: ReturnType<typeof createApi>;

const json = (r: Response) => r.json() as Promise<any>;
const post = (url: string, body?: unknown) =>
  app.request(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
const patch = (url: string, body: unknown) =>
  app.request(url, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

beforeEach(async () => {
  process.env.COTEAM_FORCE_MEMORY = '1';
  closeBus();
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-convo-api-'));
  const ws = path.join(tmp, 'proj');
  fs.mkdirSync(ws, { recursive: true });
  fs.writeFileSync(path.join(ws, 'a.txt'), 'a\n');
  const agentsDir = path.join(tmp, 'agents');
  fs.mkdirSync(path.join(agentsDir, 'partner'), { recursive: true });
  fs.writeFileSync(path.join(agentsDir, 'partner', 'agent.yaml'), 'name: partner\ntags: [code]\nrole: 搭档\n');
  fs.writeFileSync(path.join(agentsDir, 'partner', 'prompt.md'), '你是搭档。');
  await initBus({ host: '127.0.0.1', port: 6399, db: 0 });
  behaviors.length = 0;
  const pool = new ModelPool([
    { id: 'fake-model', name: 'fake-model', api_key: 'k', base_url: 'http://localhost:9', tags: ['code'] },
  ]);
  const orchestrator = new Orchestrator({
    agentsDir, modelPool: pool, policy: { level: 'full', whitelistCommands: null, maxTimeSec: 10 },
    maxRetries: 1, sandboxEnabled: false, gitEnabled: false, branchWorkflow: false,
  });
  await orchestrator.loadAgents();
  app = createApi({
    config: { agents_dir: agentsDir, dashboard: {}, model_pool: [], orchestrator: {}, permissions: {}, redis: {} } as unknown as AppConfig,
    orchestrator,
    modelPool: pool,
    taskQueue: {} as any,
  });
  // 直接在 KV 落一个项目（省去 /api/projects 的目录校验链）
  const { busSet } = await import('../src/bus');
  await busSet('project:p1', { id: 'p1', name: '测试项目', workspace: ws, created_at: new Date().toISOString() });
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
  closeBus();
});

describe('convo API（/api/convos）', () => {
  it('创建 → 列表 → 详情 → PATCH → 发消息（工具循环跑通）→ 删除', async () => {
    // 不绑定项目：只读对话也可创建
    const cr = await json(await post('/api/convos', { title: '冒烟会话' }));
    expect(cr.status).toBe('created');
    expect(cr.convo.agent_id).toBe('partner');

    const list = await json(await app.request('/api/convos'));
    expect(list.convos.some((c: any) => c.id === cr.convo.id)).toBe(true);

    // 发消息（无 workspace，工具会软错误回喂）
    behaviors.push(() => ({ content: JSON.stringify({ reply: '收到' }) }));
    const sent = await json(await post(`/api/convos/${cr.convo.id}/messages`, { text: '你好' }));
    expect(sent.status).toBe('accepted');
    // 等 turn 完成
    await new Promise((r) => setTimeout(r, 300));
    const detail = await json(await app.request(`/api/convos/${cr.convo.id}`));
    expect(detail.messages.length).toBeGreaterThanOrEqual(2);
    expect(detail.messages[0].role).toBe('user');
    expect(detail.messages[detail.messages.length - 1].text).toContain('收到');
    expect(detail.status).toBe('idle');

    // PATCH 标题/模型校验
    const up = await json(await patch(`/api/convos/${cr.convo.id}`, { title: '改名了' }));
    expect(up.convo.title).toBe('改名了');
    const bad = await app.request(`/api/convos/${cr.convo.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model_id: 'nope' }) });
    expect(bad.status).toBe(400);

    // 空文本 400
    const empty = await app.request(`/api/convos/${cr.convo.id}/messages`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: '' }) });
    expect(empty.status).toBe(400);

    // 不存在的会话 404
    expect((await app.request('/api/convos/none')).status).toBe(404);

    const del = await json(await app.request(`/api/convos/${cr.convo.id}`, { method: 'DELETE' }));
    expect(del.status).toBe('deleted');
    expect((await app.request('/api/convos')).status).toBe(200);
  }, 20000);

  it('busy 时消息自动入队 + promote 立即插入', async () => {
    const cr = await json(await post('/api/convos', {}));
    // 真实驱动：挂起行为让 turn 进入 running，第二条消息自动入队
    behaviors.push(() => new Promise(() => {}));
    await post(`/api/convos/${cr.convo.id}/messages`, { text: '第一条' });
    const waitRunning = async () => {
      for (let i = 0; i < 60; i++) {
        const d = await json(await app.request(`/api/convos/${cr.convo.id}`));
        if (d.status === 'running') return d;
        await new Promise((r) => setTimeout(r, 50));
      }
      throw new Error('never running');
    };
    await waitRunning();
    const sent = await json(await post(`/api/convos/${cr.convo.id}/messages`, { text: '插话' }));
    expect(sent.queued).toBe(true);
    expect((await json(await app.request(`/api/convos/${cr.convo.id}`))).pending_queue).toBe(1);
    // promote：打断 + 队列被异步消费
    const pr = await json(await post(`/api/convos/${cr.convo.id}/promote`));
    expect(pr.status).toBe('promoted');
    for (let i = 0; i < 60; i++) {
      const after = await json(await app.request(`/api/convos/${cr.convo.id}`));
      if (after.pending_queue === 0 && after.status === 'idle') break;
      await new Promise((r) => setTimeout(r, 100));
    }
    const after = await json(await app.request(`/api/convos/${cr.convo.id}`));
    expect(after.pending_queue).toBe(0);
  }, 20000);

  it('fork + @文件搜索端点', async () => {
    const cr = await json(await post('/api/convos', {}));
    // fork 空会话
    const fk = await json(await post(`/api/convos/${cr.convo.id}/fork`, { title: '副本' }));
    expect(fk.status).toBe('forked');
    expect(fk.convo.id).not.toBe(cr.convo.id);
    // 搜索端点（该会话未绑定项目 → 空列表）
    const s = await json(await app.request(`/api/convos/${cr.convo.id}/search?q=a`));
    expect(Array.isArray(s.files)).toBe(true);
  }, 20000);

  it('fork 默认重置权限为继承全局（D）；resetPolicy:false 才保留', async () => {
    const cr = await json(await post('/api/convos', { policy_level: 'plan_only' }));
    expect(cr.convo.policy_level).toBe('plan_only');
    // 默认：副本权限被重置（避免继承 plan_only 继续卡死）
    const fk = await json(await post(`/api/convos/${cr.convo.id}/fork`, { title: '副本' }));
    expect(fk.convo.policy_level).toBeUndefined();
    // 显式保留
    const keep = await json(await post(`/api/convos/${cr.convo.id}/fork`, { title: '保留权限', resetPolicy: false }));
    expect(keep.convo.policy_level).toBe('plan_only');
  }, 20000);
});
