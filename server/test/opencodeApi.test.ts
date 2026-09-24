import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import { registerOpencodeRoutes } from '../src/api/opencode';
import type { ApiContext } from '../src/api';
import type { OpencodeBridge } from '../src/opencode/types';

/** 最小假 manager：只实现路由用到的桥方法 */
const fakeBridge: OpencodeBridge = {
  listInstances: () => [
    { id: 't1', kind: 'managed', enabled: true, state: 'connected', url: 'http://127.0.0.1:4196', mode: 'control', version: '1.18.32', model_injection: true },
    { id: 'ro', kind: 'attached-cli', enabled: true, state: 'connected', url: 'http://127.0.0.1:5000', mode: 'readonly', version: '', model_injection: false },
  ],
  instanceCapabilities: () => undefined,
  listSessions: async (_a, instance) => (instance === 't1' ? { ok: true, data: [{ id: 's1', title: '会话一' }] } : { ok: false, error: `实例 ${instance} 未连接` }),
  createSession: async (_a, instance) => ({ ok: instance === 't1', data: instance === 't1' ? { id: 's-new' } : undefined, error: instance === 't1' ? undefined : 'readonly 档拒绝建会话' }),
  readMessages: async () => ({ ok: true, data: [{ info: { id: 'm1', role: 'assistant' }, parts: [{ type: 'text', text: '结果' }] }] }),
  sendPrompt: async () => ({ ok: true, data: { info: {} } }),
  sendPromptAsync: async () => ({ ok: true, data: { messageID: 'm-x' } }),
  abortSession: async () => ({ ok: true, data: true }),
  revertMessage: async () => ({ ok: true, data: true }),
  sessionDiff: async () => ({ ok: true, data: [{ file: 'a.ts', additions: 1, deletions: 0 }] }),
  answerPermission: async (_a, _i, _s, _p, response) => (response === 'reject' ? { ok: true, data: true } : { ok: false, error: 'x' }),
  runShell: async () => ({ ok: false, error: '实例未开启 allow_shell' }),
  waitSessionIdle: async () => ({ ok: true, data: 'idle' }),
  toolsIndex: () => '',
  listModelsForAgent: () => [],
  hasShellEnabled: () => false,
  resolveModel: () => undefined,
};

const ctx = {
  config: { opencode: { instances: [{ id: 't1', kind: 'managed' }, { id: 'ro', kind: 'attached-cli', mode: 'readonly', auth: { username: 'opencode', password: '${OC_PW}' } }] } },
  opencode: {
    listInstances: () => fakeBridge.listInstances(undefined),
    applyConfig: async () => {},
    startInstance: async () => true,
    stopInstance: async () => true,
    resolveModel: () => undefined,
    listSessions: (a: string | undefined, i: string) => fakeBridge.listSessions(a, i),
    readMessages: (a: string | undefined, i: string, s: string) => fakeBridge.readMessages(a, i, s),
    sendPrompt: (a: string | undefined, i: string, s: string, p: string, m?: { providerID: string; modelID: string }) => fakeBridge.sendPrompt(a, i, s, p, m),
    abortSession: (a: string | undefined, i: string, s: string) => fakeBridge.abortSession(a, i, s),
    revertMessage: (a: string | undefined, i: string, s: string, m: string) => fakeBridge.revertMessage(a, i, s, m),
    sessionDiff: (a: string | undefined, i: string, s: string) => fakeBridge.sessionDiff(a, i, s),
    answerPermission: (a: string | undefined, i: string, s: string, p: string, r: 'once' | 'always' | 'reject') => fakeBridge.answerPermission(a, i, s, p, r),
  },
} as unknown as ApiContext;

function app(): Hono {
  const a = new Hono();
  // 路由依赖 ./index 导出的 readJsonAuto/HttpError——注册器只用 readJsonAuto，mock 掉 fetch body 由 Hono 处理
  registerOpencodeRoutes(a, ctx);
  return a;
}

const json = (body: unknown) => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

describe('/api/opencode 路由', () => {
  it('GET instances 返回清单', async () => {
    const res = await app().request('/api/opencode/instances');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { instances: unknown[] };
    expect(body.instances.length).toBe(2);
  });

  it('GET config：env 占位符原样透传、真实值掩码', async () => {
    const body = (await (await app().request('/api/opencode/config')).json()) as { instances: { auth?: { password?: string } }[] };
    expect(body.instances[1]?.auth?.password).toBe('${OC_PW}');
  });

  it('GET sessions：未连接实例走 400 软错误', async () => {
    expect((await app().request('/api/opencode/instances/t1/sessions')).status).toBe(200);
    expect((await app().request('/api/opencode/instances/ghost/sessions')).status).toBe(400);
  });

  it('POST prompt 缺 prompt → 400', async () => {
    const res = await app().request('/api/opencode/sessions/t1/s1/prompt', json({}));
    expect(res.status).toBe(400);
  });

  it('POST prompt 正常 200', async () => {
    const res = await app().request('/api/opencode/sessions/t1/s1/prompt', json({ prompt: '干活' }));
    expect(res.status).toBe(200);
    expect(((await res.json()) as { ok: boolean }).ok).toBe(true);
  });

  it('POST permissions 经 oc_permission 校验（缺 permission_id → 400）', async () => {
    expect((await app().request('/api/opencode/sessions/t1/s1/permissions', json({ response: 'once' }))).status).toBe(400);
    expect((await app().request('/api/opencode/sessions/t1/s1/permissions', json({ permission_id: 'p1', response: 'reject' }))).status).toBe(200);
    expect((await app().request('/api/opencode/sessions/t1/s1/permissions', json({ permission_id: 'p1', response: 'bad' }))).status).toBe(400);
  });

  it('GET diff / POST abort / POST revert', async () => {
    const d = await app().request('/api/opencode/sessions/t1/s1/diff');
    expect(d.status).toBe(200);
    expect(((await d.json()) as { diff: unknown[] }).diff.length).toBe(1);
    expect((await app().request('/api/opencode/sessions/t1/s1/abort', { method: 'POST' })).status).toBe(200);
    expect((await app().request('/api/opencode/sessions/t1/s1/revert', json({ message_id: 'm1' }))).status).toBe(200);
    expect((await app().request('/api/opencode/sessions/t1/s1/revert', json({}))).status).toBe(400);
  });

  it('未配置 opencode 时优雅降级（instances 空 + error，不 500）', async () => {
    const noCtx = { config: {}, opencode: undefined } as unknown as ApiContext;
    const a = new Hono();
    registerOpencodeRoutes(a, noCtx);
    const res = await a.request('/api/opencode/instances');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { instances: unknown[]; error?: string };
    expect(body.instances).toEqual([]);
    expect(body.error).toContain('opencode.instances');
  });
});
