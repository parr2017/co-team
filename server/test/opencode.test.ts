import { describe, it, expect, afterAll, afterEach, beforeAll, vi } from 'vitest';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { OpencodeClient } from '../src/opencode/client';
import { OpencodeManager, discoverDesktopPort, trimMessageForUi, validateOpencodeInstanceConfigs } from '../src/opencode/manager';
import { buildOpencodeJson, resolveModelRef, writeInstanceConfig } from '../src/opencode/modelInjection';
import { extractLastAssistantText, isOcTool, runOpencodeTool } from '../src/opencode/ocTools';
import { applyToolCalls } from '../src/tools';
import type { ModelConfig } from '../src/types';
import type { OpencodeBridge } from '../src/opencode/types';

const silent = { debug() {}, info() {}, warn() {}, error() {} } as any;

// ---------- 假 opencode server（落成临时 .cjs 由 manager 真 spawn；勿走 `-e`——
// Windows shell:true 下 cmd 会把 JS 里的 => / < > 当重定向语法吃掉） ----------

/** 解析 `--port N`；行为对齐真 opencode serve 的最小端点集 */
const FAKE_OC = `
const http = require('http');
const port = Number(process.argv[process.argv.indexOf('--port') + 1] || 0);
let sseRes = null;
const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://127.0.0.1');
  const json = (code, body) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
  const empty = (code) => { res.writeHead(code); res.end(); };
  if (req.method === 'GET' && u.pathname === '/api/info') {
    // FAKE_REQUIRE_AUTH=1 时模拟真实 opencode 2.x：无 Basic 凭据返回 401 空 content-type（官方客户端会抛 UnsupportedContentType）
    if (process.env.FAKE_REQUIRE_AUTH && req.headers.authorization !== 'Basic ' + Buffer.from('opencode:fake-password-0123').toString('base64')) { res.writeHead(401); return res.end(); }
    return json(200, { version: '2.0.15-fake', pid: process.pid, urls: [], paths: { tmp: '' } });
  }
  if (req.method === 'GET' && u.pathname === '/api/session') return json(200, { data: [{ id: 's1', title: 'first', location: { directory: 'C:/fake-project' }, time: { created: 1, updated: 100 } }, { id: 's2', title: 'second', location: { directory: 'C:/other' }, time: { created: 2, updated: 200 } }], cursor: {} });
  if (req.method === 'GET' && u.pathname === '/api/session/active') return json(200, { s1: { type: 'idle' } });
  if (req.method === 'POST' && u.pathname === '/api/session') return json(200, { data: { id: 'new-s', title: 'created' } });
  if (req.method === 'GET' && u.pathname === '/api/session/s1/message') return json(200, { data: [{ id: 'm1', type: 'user', time: { created: 1 }, text: 'hello from fake' }], cursor: {} });
  if (req.method === 'GET' && u.pathname === '/api/session/s1/message/m1') return json(200, { data: { id: 'm1', type: 'user', time: { created: 1 }, text: 'hello from fake' } });
  if (req.method === 'POST' && u.pathname === '/api/session/s1/model') return empty(204);
  if (req.method === 'POST' && u.pathname === '/api/session/s1/prompt') return json(200, { data: { id: 'm2', sessionID: 's1', type: 'user', time: { created: 1 }, payload: { text: '' }, delivery: 'queue' } });
  if (req.method === 'POST' && u.pathname === '/api/session/s1/interrupt') return json(200, { interrupted: true });
  if (req.method === 'POST' && u.pathname === '/api/session/s1/revert/stage') return json(200, { data: { messageID: 'm1' } });
  if (req.method === 'POST' && u.pathname === '/api/session/s1/revert/commit') return empty(204);
  if (req.method === 'GET' && u.pathname === '/api/session/s1/diff') return json(200, { data: [{ file: 'a.ts', additions: 3, deletions: 1 }] });
  if (req.method === 'POST' && u.pathname === '/api/session/s1/permission/p1/reply') return empty(204);
  if (req.method === 'GET' && u.pathname === '/api/location') return json(200, { directory: 'C:/fake-project', project: { id: 'p1', directory: 'C:/fake-project', canonical: 'C:/fake-project' } });
  if (req.method === 'GET' && u.pathname === '/api/event') {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('data: ' + JSON.stringify({ id: 'e0', type: 'server.connected', data: {} }) + '\\n\\n');
    res.write('data: ' + JSON.stringify({ id: 'e1', type: 'session.idle', data: { sessionID: 's1' } }) + '\\n\\n');
    sseRes = res;
    const t = setInterval(() => res.write(': ping\\n\\n'), 1000);
    req.on('close', () => { clearInterval(t); if (sseRes === res) sseRes = null; });
    return;
  }
  if (req.method === 'POST' && u.pathname === '/api/test/emit-parts') {
    // 模拟 v2 真实行为：新消息只有 part 级事件（无 message.updated），验证缓存骨架自建
    if (sseRes) {
      sseRes.write('data: ' + JSON.stringify({ id: 'e2', type: 'session.text.started', data: { sessionID: 's1', assistantMessageID: 'm-new', ordinal: 0 } }) + '\\n\\n');
      sseRes.write('data: ' + JSON.stringify({ id: 'e3', type: 'session.text.ended', data: { sessionID: 's1', assistantMessageID: 'm-new', ordinal: 0, text: 'PATCHED_NEW_MSG' } }) + '\\n\\n');
    }
    return json(200, { ok: true });
  }
  if (req.method === 'GET' && u.pathname === '/notfound') return json(404, { error: 'nope' });
  empty(204);
});
server.listen(port, '127.0.0.1', () => { console.log('fake-oc listening ' + port); console.log('server password fake-password-0123'); });
`;

async function waitFor(fn: () => boolean | Promise<boolean>, timeoutMs = 15000): Promise<boolean> {
  const begin = Date.now();
  for (;;) {
    if (await fn()) return true;
    if (Date.now() - begin > timeoutMs) return false;
    await new Promise((r) => setTimeout(r, 100));
  }
}

// ---------- client（mock fetch，不打真服务） ----------

function mockFetch(routes: Record<string, { status?: number; body?: unknown; text?: string }>): void {
  vi.stubGlobal('fetch', async (url: string | URL | Request, init?: RequestInit) => {
    const u = new URL(String(url));
    const route = routes[`${(init?.method || 'GET') as string} ${u.pathname}`] || routes[`* ${u.pathname}`];
    if (!route) return new Response(JSON.stringify({ message: 'not found' }), { status: 404, headers: { 'content-type': 'application/json' } });
    const body = route.text ?? (route.body !== undefined ? JSON.stringify(route.body) : '');
    return new Response(body, { status: route.status ?? 200, headers: { 'content-type': 'application/json' } });
  });
}

describe('OpencodeClient', () => {
  afterEach(() => vi.unstubAllGlobals());
  afterAll(() => vi.unstubAllGlobals());

  it('health / probe：仅接受 2.x 且不低于 2.0.15', async () => {
    for (const [version, accepted] of [['1.18.32', false], ['2.0.15', true], ['3.0.0', false]] as const) {
      mockFetch({ 'GET /api/info': { body: { version, pid: 1, urls: [], paths: { tmp: '' } } } });
      const client = new OpencodeClient({ baseUrl: 'http://127.0.0.1:9999' });
      const health = await client.health();
      expect(health.data?.version).toBe(version);
      expect(health.ok).toBe(accepted);
      const capabilities = await client.probe();
      expect(capabilities.healthy).toBe(accepted);
      expect(capabilities.version).toBe(version);
      if (accepted) {
        expect(capabilities.sync_prompt).toBe(false);
        expect(capabilities.async_prompt).toBe(true);
        expect(capabilities.abort).toBe(true);
        expect(capabilities.revert).toBe(true);
        expect(capabilities.diff).toBe(true);
        expect(capabilities.permissions).toBe(true);
        expect(capabilities.events).toBe(true);
        expect(capabilities.shell).toBe(true);
        expect(capabilities.tui).toBe(false);
      }
    }
  });

  it('form.created → question.asked：全字段语义透传 + 类型归一化（提问卡渲染契约）', () => {
    const client = new OpencodeClient({ baseUrl: 'http://127.0.0.1:9999' });
    const events = (client as unknown as { convertEvents: (e: unknown) => Array<{ type: string; properties: Record<string, any> }> }).convertEvents({
      id: 'evt-q1',
      type: 'form.created',
      data: {
        form: {
          id: 'form-1',
          sessionID: 'ses-1',
          title: '挖 Juable token 前的四个问题',
          fields: [
            // OpenCode 2.x 表单字段契约：key/type/title/description/options{value,label,description}/custom/maxItems/required/when/hidden/placeholder/min/max/url
            { key: 'q0', type: 'multiselect', title: '目标入口', maxItems: 1, custom: true, required: true, options: [{ value: 'desktop', label: '桌面客户端', description: '走 .NET Remoting' }, { value: 'web', label: 'Web 端' }] },
            { key: 'q1', type: 'multiselect', header: 'token 用途', title: '拿到 token 之后要干什么？', options: [{ value: 'sso', label: '单点登录 (recommended)' }] },
            { key: 'q2', type: 'string', title: '补充说明', placeholder: '想说的都写这里', required: true },
            { key: 'q3', type: 'string', title: '入口域名', options: [{ value: 'lan', label: '内网' }], when: [{ key: 'q0', op: 'eq', value: 'web' }] },
            { key: 'q4', type: 'number', title: '并发数', minimum: 1, maximum: 5 },
            { key: 'q5', type: 'boolean', title: '允许写文件' },
            { key: 'q6', type: 'external', title: '授权协议', url: 'https://example.com/eula' },
            { key: 'q7', type: 'string', title: '内部备注', hidden: true },
          ],
        },
      },
    });
    const q = events.find((e) => e.type === 'question.asked');
    expect(q).toBeTruthy();
    expect(q!.properties.id).toBe('form-1');
    expect(q!.properties.sessionID).toBe('ses-1');
    expect(q!.properties.title).toBe('挖 Juable token 前的四个问题');
    const qs = q!.properties.questions as any[];
    expect(qs).toHaveLength(8);
    // q0：maxItems:1 → 单选；required/custom 透传；options 带 value
    expect(qs[0].type).toBe('multiselect');
    expect(qs[0].question).toBe('目标入口');
    expect(qs[0].multiple).toBe(false);
    expect(qs[0].required).toBe(true);
    expect(qs[0].custom).toBe(true);
    expect(qs[0].options).toEqual([{ value: 'desktop', label: '桌面客户端', description: '走 .NET Remoting' }, { value: 'web', label: 'Web 端', description: undefined }]);
    // q1：header 透传；未限 1 项 → 多选
    expect(qs[1].type).toBe('multiselect');
    expect(qs[1].header).toBe('token 用途');
    expect(qs[1].multiple).toBe(true);
    // q2：string 无 options → input；placeholder 透传
    expect(qs[2].type).toBe('input');
    expect(qs[2].placeholder).toBe('想说的都写这里');
    expect(qs[2].custom).toBe(false);
    // q3：string+options → select；when 条件透传
    expect(qs[3].type).toBe('select');
    expect(qs[3].when).toEqual([{ key: 'q0', op: 'eq', value: 'web' }]);
    // q4/q5/q6：number（min/max）/ boolean / external（url）
    expect(qs[4].type).toBe('number');
    expect(qs[4].minimum).toBe(1);
    expect(qs[4].maximum).toBe(5);
    expect(qs[5].type).toBe('boolean');
    expect(qs[6].type).toBe('external');
    expect(qs[6].externalUrl).toBe('https://example.com/eula');
    // q7：hidden 透传
    expect(qs[7].hidden).toBe(true);
  });

  it('answerQuestion key-based：按 form schema 收口类型（label→value / number / boolean / multiselect 数组）', async () => {
    let replyBody: any;
    vi.stubGlobal('fetch', async (url: string | URL | Request, init?: RequestInit) => {
      const path = new URL(String(url)).pathname;
      if (path === '/api/form') {
        return new Response(JSON.stringify({ data: [{ id: 'form-1', sessionID: 'ses-1' }] }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if ((init?.method || 'GET') === 'GET' && path === '/api/session/ses-1/form/form-1') {
        return new Response(JSON.stringify({ data: { id: 'form-1', sessionID: 'ses-1', fields: [
          { key: 'entrance', type: 'multiselect', options: [{ value: 'desktop', label: '桌面客户端' }] },
          { key: 'concurrency', type: 'number' },
          { key: 'allowWrite', type: 'boolean' },
          { key: 'eula', type: 'external' },
          { key: 'note', type: 'string' },
        ] } }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (init?.method === 'POST' && path.endsWith('/reply')) {
        replyBody = JSON.parse(String(init?.body));
        return new Response(null, { status: 204 });
      }
      return new Response(null, { status: 204 });
    });
    const client = new OpencodeClient({ baseUrl: 'http://127.0.0.1:9999' });
    const r = await client.answerQuestion('form-1', {
      entrance: ['桌面客户端'],
      concurrency: '3',
      allowWrite: true,
      eula: true,
      note: 'ok',
    });
    expect(r.ok).toBe(true);
    expect(replyBody.answer).toEqual({ entrance: ['desktop'], concurrency: 3, allowWrite: true, eula: true, note: 'ok' });
    vi.unstubAllGlobals();
  });

  it('HTTP 错误与网络异常全部软收口 {ok:false}', async () => {
    mockFetch({ 'GET /api/session': { status: 500, text: 'boom' } });
    const result = await new OpencodeClient({ baseUrl: 'http://127.0.0.1:9999' }).listSessions();
    expect(result.ok).toBe(false);
    expect(result.error).toContain('500');
    vi.unstubAllGlobals();
    vi.stubGlobal('fetch', async () => { throw new Error('ECONNREFUSED'); });
    const network = await new OpencodeClient({ baseUrl: 'http://127.0.0.1:9999' }).listSessions();
    expect(network.ok).toBe(false);
    expect(network.error).toContain('Transport');
  });

  it('构造器注入 Basic auth，错误消息不泄露凭据', async () => {
    let authorization = '';
    let signal: AbortSignal | null | undefined;
    vi.stubGlobal('fetch', async (_url: string | URL | Request, init?: RequestInit) => {
      authorization = new Headers(init?.headers).get('authorization') || '';
      signal = init?.signal;
      if (authorization !== `Basic ${Buffer.from('opencode:secret').toString('base64')}`) {
        return new Response(JSON.stringify({ message: 'Authorization: Basic leaked secret' }), { status: 401, headers: { 'content-type': 'application/json' } });
      }
      return new Response(JSON.stringify({ version: '2.0.15', pid: 1, urls: [], paths: { tmp: '' } }), { status: 200, headers: { 'content-type': 'application/json' } });
    });
    const client = new OpencodeClient({ baseUrl: 'http://127.0.0.1:9999', auth: { username: 'opencode', password: 'secret' } });
    expect((await client.health()).ok).toBe(true);
    expect(authorization).toBe(`Basic ${Buffer.from('opencode:secret').toString('base64')}`);
    expect(signal).toBeInstanceOf(AbortSignal);
    vi.stubGlobal('fetch', async () => { throw new Error('Authorization: secret'); });
    const error = (await client.listSessions()).error || '';
    expect(error).not.toContain('secret');
  });

  it('session list 使用官方 v2 envelope 并按元素截断', async () => {
    const data = Array.from({ length: 40 }, (_, index) => ({ id: `s${index}`, title: 'x'.repeat(100) }));
    mockFetch({ 'GET /api/session': { body: { data, cursor: {} } } });
    const result = await new OpencodeClient({ baseUrl: 'http://127.0.0.1:9999', maxResultChars: 500 }).listSessions();
    expect(result.ok).toBe(true);
    expect(Array.isArray(result.data)).toBe(true);
    expect(result.truncated).toBe(true);
    expect((result.data as unknown[]).length).toBeLessThan(40);
  });

  it('prompt 先用官方 switchModel，再以 session.prompt 入队并返回 inbox message', async () => {
    const requests: { method: string; path: string; body?: any }[] = [];
    vi.stubGlobal('fetch', async (url: string | URL | Request, init?: RequestInit) => {
      const path = new URL(String(url)).pathname;
      requests.push({ method: init?.method || 'GET', path, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      if (path === '/api/session/s1/model') return new Response(null, { status: 204 });
      return new Response(JSON.stringify({ data: { id: 'inbox-1', sessionID: 's1', type: 'user', time: { created: 1 }, payload: { text: 'do it' }, delivery: 'queue' } }), { status: 200, headers: { 'content-type': 'application/json' } });
    });
    const result = await new OpencodeClient({ baseUrl: 'http://127.0.0.1:9999' }).prompt('s1', 'do it', { providerID: 'deepseek', modelID: 'ds-v4' });
    expect(result.ok).toBe(true);
    expect((result.data as { id: string }).id).toBe('inbox-1');
    expect(requests.map((request) => request.path)).toEqual(['/api/session/s1/model', '/api/session/s1/prompt']);
    expect(requests[0]?.body).toEqual({ model: { id: 'ds-v4', providerID: 'deepseek' } });
    expect(requests[1]?.body).toMatchObject({ text: 'do it' });
  });

  it('messages list/get 与 interrupt 使用官方 v2 方法', async () => {
    const requests: string[] = [];
    mockFetch({
      'GET /api/session/s1/message': { body: { data: [{ id: 'm1', type: 'user', time: { created: 1 }, text: 'hello' }], cursor: {} } },
      'GET /api/session/s1/message/m1': { body: { id: 'm1', type: 'user', time: { created: 1 }, text: 'hello' } },
      'POST /api/session/s1/interrupt': { body: { interrupted: true } },
    });
    vi.stubGlobal('fetch', async (url: string | URL | Request, init?: RequestInit) => {
      const path = new URL(String(url)).pathname;
      requests.push(`${init?.method || 'GET'} ${path}`);
      if (path.endsWith('/interrupt')) return new Response(JSON.stringify({ interrupted: true }), { status: 200, headers: { 'content-type': 'application/json' } });
      if (path.endsWith('/message/m1')) return new Response(JSON.stringify({ data: { id: 'm1', type: 'user', time: { created: 1 }, text: 'hello' } }), { status: 200, headers: { 'content-type': 'application/json' } });
      return new Response(JSON.stringify({ data: [{ id: 'm1', type: 'user', time: { created: 1 }, text: 'hello' }], cursor: {} }), { status: 200, headers: { 'content-type': 'application/json' } });
    });
    const client = new OpencodeClient({ baseUrl: 'http://127.0.0.1:9999' });
    expect((await client.listMessages('s1', 10)).ok).toBe(true);
    const message = await client.getMessage('s1', 'm1');
    expect(message).toMatchObject({ ok: true, data: {
      info: { id: 'm1', role: 'user' },
      parts: [{ id: 'm1:text', messageID: 'm1', type: 'text', text: 'hello' }],
    } });
    expect((await client.abortSession('s1')).data).toBe(true);
    expect(requests).toEqual([
      'GET /api/session/s1/message',
      'GET /api/session/s1/message/m1',
      'POST /api/session/s1/interrupt',
    ]);
  });

  it('把 v2 assistant content 投影为现有 UI 的 parts', async () => {
    mockFetch({
      'GET /api/session/s1/message': {
        body: {
          data: [{
            id: 'assistant-1',
            type: 'assistant',
            time: { created: 1 },
            agent: 'build',
            model: { id: 'model-1', providerID: 'provider-1' },
            content: [
              { type: 'text', text: 'done' },
              { type: 'reasoning', text: 'thinking' },
              { type: 'tool', id: 'tool-1', name: 'read', state: { status: 'completed', input: { path: 'a.ts' }, content: [{ type: 'text', text: 'ok' }] } },
            ],
          }],
          cursor: {},
        },
      },
    });
    const result = await new OpencodeClient({ baseUrl: 'http://127.0.0.1:9999' }).listMessages('s1');
    expect(result.data).toEqual([expect.objectContaining({
      info: expect.objectContaining({ id: 'assistant-1', role: 'assistant', providerID: 'provider-1', modelID: 'model-1' }),
      parts: [
        expect.objectContaining({ type: 'text', text: 'done' }),
        expect.objectContaining({ type: 'reasoning', text: 'thinking' }),
        expect.objectContaining({ type: 'tool', callID: 'tool-1', tool: 'read', state: expect.objectContaining({ status: 'completed', input: { path: 'a.ts' } }) }),
      ],
    })]);
  });

  it('permission.reply 与 form reply/cancel 替代旧 question/todo', async () => {
    let replyBody: any;
    vi.stubGlobal('fetch', async (url: string | URL | Request, init?: RequestInit) => {
      const path = new URL(String(url)).pathname;
      if (path === '/api/session/s1/permission/p1/reply') {
        replyBody = JSON.parse(String(init?.body));
        return new Response(null, { status: 204 });
      }
      if (path === '/api/form') {
        return new Response(JSON.stringify({ location: { directory: 'C:/p' }, data: [{ id: 'f1', sessionID: 's1', title: 'Pick', fields: [] }] }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if ((init?.method || 'GET') === 'GET' && path === '/api/session/s1/form/f1') {
        return new Response(JSON.stringify({ data: { id: 'f1', sessionID: 's1', title: 'Pick', fields: [{ key: 'choice', type: 'multiselect' }], state: {} } }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return new Response(null, { status: 204 });
    });
    const client = new OpencodeClient({ baseUrl: 'http://127.0.0.1:9999' });
    expect((await client.answerPermission('s1', 'p1', 'always')).ok).toBe(true);
    expect(replyBody).toEqual({ decision: 'always' });
    expect((await client.answerQuestion('f1', [['a', 'b']])).ok).toBe(true);
    expect(await client.rejectQuestion('f1')).toEqual({ ok: true, data: true });
    const todos = await client.sessionTodos('s1');
    const tui = await client.appendPrompt('x');
    expect(todos).toEqual({ ok: false, error: 'OpenCode 2.0.15 官方客户端不提供该能力' });
    expect(tui).toEqual({ ok: false, error: 'OpenCode 2.0.15 官方客户端不提供该能力' });
  });

  it('event.subscribe 保留 AbortSignal，并把 V2Event id/data/location 转为 OcEvent', async () => {
    vi.stubGlobal('fetch', async (_url: string | URL | Request, init?: RequestInit) => {
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      const stream = new ReadableStream({
        start(controller) {
          const encoder = new TextEncoder();
          controller.enqueue(encoder.encode('data: {"id":"evt-1","type":"session.execution.started","location":{"directory":"C:/p"},"data":{"sessionID":"s1"}}\n\n'));
          controller.enqueue(encoder.encode('data: {"id":"evt-2","type":"session.execution.succeeded","location":{"directory":"C:/p"},"data":{"sessionID":"s1"}}\n\n'));
          controller.enqueue(encoder.encode('data: {"id":"evt-3","type":"session.text.delta","data":{"sessionID":"s1","assistantMessageID":"m2","ordinal":0,"delta":"hi"}}\n\n'));
          controller.enqueue(encoder.encode('data: {"id":"evt-4","type":"session.tool.success","data":{"sessionID":"s1","assistantMessageID":"m2","id":"tool-1","content":[{"type":"text","text":"ok"}]}}\n\n'));
          controller.close();
        },
      });
      return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    });
    const controller = new AbortController();
    const events = new OpencodeClient({ baseUrl: 'http://127.0.0.1:9999' }).eventStream(controller.signal);
    const started = await events.next();
    expect(started.value).toMatchObject({
      type: 'session.status',
      id: 'evt-1',
      location: { directory: 'C:/p' },
      properties: { sessionID: 's1', status: { type: 'busy' } },
    });
    const succeeded = await events.next();
    expect(succeeded.value).toMatchObject({
      type: 'session.idle',
      id: 'evt-2',
      properties: { sessionID: 's1' },
    });
    expect((await events.next()).value).toMatchObject({
      type: 'message.part.delta',
      id: 'evt-3',
      properties: { sessionID: 's1', messageID: 'm2', partID: 'm2:text:0', field: 'text', delta: 'hi' },
    });
    expect((await events.next()).value).toMatchObject({
      type: 'message.part.updated',
      id: 'evt-4',
      properties: { sessionID: 's1', part: { type: 'tool', callID: 'tool-1', state: { status: 'completed' } } },
    });
    expect((await events.next()).done).toBe(true);
  });

  it('event.subscribe：inbox.enqueued 投影为用户消息（骨架+text part），interrupted 映射 idle 但 shutdown 除外', async () => {
    vi.stubGlobal('fetch', async (_url: string | URL | Request, init?: RequestInit) => {
      const stream = new ReadableStream({
        start(controller) {
          const encoder = new TextEncoder();
          controller.enqueue(encoder.encode('data: {"id":"i1","type":"session.inbox.enqueued","data":{"inboxID":"u9","sessionID":"s1","item":{"type":"user","payload":{"text":"帮我看看这个"},"delivery":"steer"}}}\n\n'));
          controller.enqueue(encoder.encode('data: {"id":"i2","type":"session.execution.interrupted","data":{"sessionID":"s1","reason":"user"}}\n\n'));
          controller.enqueue(encoder.encode('data: {"id":"i3","type":"session.execution.interrupted","data":{"sessionID":"s1","reason":"shutdown"}}\n\n'));
          controller.close();
        },
      });
      return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    });
    const events = new OpencodeClient({ baseUrl: 'http://127.0.0.1:9999' }).eventStream(new AbortController().signal);
    const skeleton = await events.next();
    expect(skeleton.value).toMatchObject({
      type: 'message.updated',
      id: 'i1',
      properties: { sessionID: 's1', info: { id: 'u9', sessionID: 's1', role: 'user' } },
    });
    const userPart = await events.next();
    expect(userPart.value).toMatchObject({
      type: 'message.part.updated',
      id: 'i1',
      properties: { sessionID: 's1', part: { id: 'u9:text', messageID: 'u9', type: 'text', text: '帮我看看这个' } },
    });
    expect((await events.next()).value).toMatchObject({
      type: 'session.idle',
      id: 'i2',
      properties: { sessionID: 's1' },
    });
    // shutdown：不产出任何事件
    expect((await events.next()).done).toBe(true);
  });
});

// ---------- manager：managed 实例真 spawn 假服务，attached gating ----------

describe('OpencodeManager', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'coteam-oc-'));
  /** 假 serve 脚本路径（node <file> serve --port N ...） */
  const fakeOcFile = path.join(tmp, 'fake-oc.cjs');
  const managers: OpencodeManager[] = [];

  beforeAll(() => {
    fs.writeFileSync(fakeOcFile, FAKE_OC, 'utf-8');
  });

  afterAll(async () => {
    for (const m of managers) await m.stop();
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* Windows 句柄释放延迟——容忍 */ }
  });

  it('managed：spawn → 健康 → capabilities → connected，桥调用可用，stopInstance 杀掉进程', async () => {
    const mgr = new OpencodeManager([
      { id: 't1', kind: 'managed', command: 'node', args: [fakeOcFile], project_root: tmp, auto_start: true },
    ], silent);
    managers.push(mgr);
    mgr.setAgentProvider(() => ['*']);
    const forwarded: Array<{ id?: string; type: string }> = [];
    mgr.setEventForwarder((_instance, event) => forwarded.push({ id: event.id, type: event.type }));
    mgr.start();
    const ok = await waitFor(() => mgr.listInstances()[0]?.state === 'connected');
    expect(ok).toBe(true);
    const st = mgr.listInstances()[0]!;
    expect(st.capabilities?.version).toBe('2.0.15-fake');
    expect(st.pid).toBeGreaterThan(0);
    expect(await waitFor(() => forwarded.length > 0 && Boolean(mgr.latestEventId('t1')))).toBe(true);
    expect(mgr.replayEvents('t1', 'unknown')).toBeNull();
    expect(mgr.replayEvents('t1', forwarded[0]!.id)).toEqual(expect.any(Array));

    const sessions = await mgr.listSessions('dev', 't1');
    expect(sessions.ok).toBe(true);
    expect((sessions.data as any[]).length).toBe(2);
    // v2 归一化：location.directory → 顶层 directory（顺序跟上游，不做二次排序）
    expect((sessions.data as any[])[0].directory).toBe('C:/fake-project');
    expect((sessions.data as any[])[1].directory).toBe('C:/other');

    const created = await mgr.createSession('dev', 't1', 'co-team 派活');
    expect(created.ok).toBe(true);
    expect((created.data as any).id).toBe('new-s');

    const sent = await mgr.sendPrompt('dev', 't1', 's1', '跑个测试', { providerID: 'p', modelID: 'm' });
    expect(sent.ok).toBe(true);

    const diff = await mgr.sessionDiff('dev', 't1', 's1');
    expect(diff.ok).toBe(true);

    const perm = await mgr.answerPermission(undefined, 't1', 's1', 'p1', 'once');
    expect(perm.ok).toBe(true);

    // 停实例：进程退出 + 状态归位
    expect(await mgr.stopInstance('t1')).toBe(true);
    await waitFor(() => !mgr.listInstances().find((s) => s.id === 't1')?.pid);
    expect(mgr.listInstances().find((s) => s.id === 't1')?.pid).toBeUndefined();
  }, 20000);

  it('managed：serve 强制 Basic 鉴权时从日志解析密码带凭据连接（opencode 2.x 默认行为）', async () => {
    const mgr = new OpencodeManager([
      { id: 'auth-m', kind: 'managed', command: 'node', args: [fakeOcFile], project_root: tmp, auto_start: true, env: { FAKE_REQUIRE_AUTH: '1' } },
    ], silent);
    managers.push(mgr);
    mgr.setAgentProvider(() => ['*']);
    mgr.start();
    // 若密码解析/凭据注入断裂：/api/info 401 空 content-type → UnsupportedContentType → 就绪超时
    expect(await waitFor(() => mgr.listInstances()[0]?.state === 'connected')).toBe(true);
    expect(mgr.listInstances()[0]?.error).toBeUndefined();
    expect(await mgr.stopInstance('auth-m')).toBe(true);
    await waitFor(() => !mgr.listInstances().find((s) => s.id === 'auth-m')?.pid);
  }, 20000);

  it('attached-cli：readonly 档拒绝控制操作、放行只读与审批；allow_shell 默认禁用', async () => {
    // 先手动拉起一个假服务当 attached 目标
    const port = 38112;
    const child = spawn('node', [fakeOcFile, 'serve', '--port', String(port)], { stdio: 'ignore', shell: true });
    let up = false;
    for (let i = 0; i < 100 && !up; i++) {
        try { up = (await fetch(`http://127.0.0.1:${port}/api/info`)).ok; } catch { /* 未起 */ }
      if (!up) await new Promise((r) => setTimeout(r, 100));
    }
    expect(up).toBe(true);
    try {
      const mgr = new OpencodeManager([
        { id: 'ro', kind: 'attached-cli', url: `http://127.0.0.1:${port}`, mode: 'readonly' },
      ], silent);
      managers.push(mgr);
      mgr.start();
      const ok = await waitFor(() => mgr.listInstances()[0]?.state === 'connected');
      expect(ok).toBe(true);

      expect((await mgr.listSessions(undefined, 'ro')).ok).toBe(true);
      const send = await mgr.sendPrompt(undefined, 'ro', 's1', 'hi');
      expect(send.ok).toBe(false);
      expect(send.error).toContain('readonly');
      const abort = await mgr.abortSession(undefined, 'ro', 's1');
      expect(abort.ok).toBe(false);
      // 审批响应是人工放行动作，readonly 也放行
      expect((await mgr.answerPermission(undefined, 'ro', 's1', 'p1', 'reject')).ok).toBe(true);
      // shell 高危默认关
      const shell = await mgr.runShell(undefined, 'ro', 's1', 'rm -rf /');
      expect(shell.ok).toBe(false);
      expect(shell.error).toContain('allow_shell');
    } finally {
      child.kill('SIGTERM');
    }
  }, 20000);

  it('attached：SSE part 事件对缓存外的新消息自建骨架（接管介入后 readMessages 不漏新回复）', async () => {
    const port = 38113;
    const child = spawn('node', [fakeOcFile, 'serve', '--port', String(port)], { stdio: 'ignore', shell: true });
    let up = false;
    for (let i = 0; i < 100 && !up; i++) {
      try { up = (await fetch(`http://127.0.0.1:${port}/api/info`)).ok; } catch { /* 未起 */ }
      if (!up) await new Promise((r) => setTimeout(r, 100));
    }
    expect(up).toBe(true);
    try {
      const mgr = new OpencodeManager([
        { id: 'cache', kind: 'attached-cli', url: `http://127.0.0.1:${port}`, mode: 'control' },
      ], silent);
      managers.push(mgr);
      mgr.start();
      expect(await waitFor(() => mgr.listInstances()[0]?.state === 'connected')).toBe(true);

      // 先读一次：权威拉取建立缓存（m1）
      const before = await mgr.readMessages(undefined, 'cache', 's1', { limit: 20 });
      expect(before.ok).toBe(true);
      expect((before.data!.messages as any[]).map((m) => m.info?.id ?? m.id)).toEqual(['m1']);

      // 触发假服务推送 v2 风格的新消息 part 事件（无 message.updated）
      const trigger = await fetch(`http://127.0.0.1:${port}/api/test/emit-parts`, { method: 'POST' });
      expect(trigger.ok).toBe(true);
      expect(await waitFor(async () => {
        const after = await mgr.readMessages(undefined, 'cache', 's1', { limit: 20 });
        if (!after.ok) return false;
        const ids = (after.data!.messages as any[]).map((m) => m.info?.id ?? m.id);
        return ids.includes('m-new') && JSON.stringify(after.data!.messages).includes('PATCHED_NEW_MSG');
      })).toBe(true);
    } finally {
      child.kill('SIGTERM');
    }
  }, 20000);

  it('agent 可见性：未绑定的 agent 全部不可见', async () => {
    const mgr = new OpencodeManager([{ id: 'x', kind: 'attached-cli', url: 'http://127.0.0.1:1' }], silent);
    managers.push(mgr);
    mgr.setAgentProvider((agent) => (agent === 'partner' ? ['*'] : ['y']));
    expect(mgr.listInstances('partner').some((i) => i.id === 'x')).toBe(true);
    expect(mgr.listInstances('dev').some((i) => i.id === 'x')).toBe(false);
    expect(mgr.listInstances(undefined).some((i) => i.id === 'x')).toBe(true); // API 层不看白名单
    const r = await mgr.listSessions('dev', 'x');
    expect(r.ok).toBe(false);
    expect(r.error).toContain('未绑定');
  });

  it('discoverDesktopPort：解析桌面日志目录里的 port 行', () => {
    const tmpApp = fs.mkdtempSync(path.join(os.tmpdir(), 'coteam-appdata-'));
    const prev = process.env.APPDATA;
    process.env.APPDATA = tmpApp;
    try {
      const dir = path.join(tmpApp, 'ai.opencode.desktop', 'logs', '20260924T060000');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'main.log'), 'junk\n[info] crash reporter started {\n  port: \'49374\'\n');
      expect(discoverDesktopPort()).toBe(49374);
    } finally {
      process.env.APPDATA = prev;
      fs.rmSync(tmpApp, { recursive: true, force: true });
    }
  });
});

// ---------- 校验器 ----------

describe('validateOpencodeInstanceConfigs', () => {
  it('三类 kind 合法条目落字段', () => {
    const out = validateOpencodeInstanceConfigs([
      { id: 'm1', kind: 'managed', project_root: 'D:/p', port: 4196, model_injection: true },
      { id: 'a1', kind: 'attached-cli', url: 'http://127.0.0.1:5000', mode: 'control' },
      { id: 'd1', kind: 'attached-desktop', auth: { username: 'opencode', password: '${OC_PW}' } },
    ]);
    expect(out.map((o) => o.id)).toEqual(['m1', 'a1', 'd1']);
    expect(out[0]).toMatchObject({ kind: 'managed', port: 4196, model_injection: true, auto_start: true });
    expect(out[1]).toMatchObject({ mode: 'control' });
    expect(out[2]!.auth?.password).toBe('${OC_PW}');
    expect(out.every((o) => o.mode === 'readonly' || o.mode === 'control')).toBe(true);
  });

  it('脏数据一律 throw 且消息可读', () => {
    expect(() => validateOpencodeInstanceConfigs([{ id: 'bad id', kind: 'managed' }])).toThrow(/无效实例 id/);
    expect(() => validateOpencodeInstanceConfigs([{ id: 'a', kind: 'weird' }])).toThrow(/kind/);
    expect(() => validateOpencodeInstanceConfigs([{ id: 'a', kind: 'attached-cli', url: 'ftp://x' }])).toThrow(/url/);
    expect(() => validateOpencodeInstanceConfigs([{ id: 'a', kind: 'attached-cli', mode: 'root' }])).toThrow(/mode/);
    expect(() => validateOpencodeInstanceConfigs([{ id: 'a', kind: 'managed', port: 70000 }])).toThrow(/port/);
    expect(() => validateOpencodeInstanceConfigs('x')).toThrow(/数组/);
  });
});

// ---------- 模型注入 ----------

const POOL: ModelConfig[] = [
  { id: '1', name: 'deepseek-chat', provider: 'DeepSeek', api_key: 'sk-a', base_url: 'https://api.deepseek.com/v1', context_length: 128000, max_tokens: 8000 },
  { id: '2', name: 'qwen-max', provider: 'Aliyun', api_key: 'sk-b', base_url: 'https://dashscope.aliyuncs.com/compatible-mode/v1' },
];

describe('modelInjection', () => {
  it('buildOpencodeJson：provider 指向 OpenAI 兼容接入点，apiKey 仅 env 占位', () => {
    const j = buildOpencodeJson(POOL) as any;
    expect(j.provider.deepseek.npm).toBe('@ai-sdk/openai-compatible');
    expect(j.provider.deepseek.options.baseURL).toBe('https://api.deepseek.com/v1');
    expect(j.provider.deepseek.options.apiKey).toBe('{env:COTEAM_OC_KEY_DEEPSEEK}');
    expect(j.provider.deepseek.models['deepseek-chat'].limit).toEqual({ context: 128000, output: 8000 });
    expect(j.model).toBe('deepseek/deepseek-chat');
    expect(JSON.stringify(j)).not.toContain('sk-a'); // 密钥绝不落盘
  });

  it('resolveModelRef：池内模型名 → {providerID, modelID}', () => {
    expect(resolveModelRef(POOL, 'qwen-max')).toEqual({ providerID: 'aliyun', modelID: 'qwen-max' });
    expect(resolveModelRef(POOL, 'missing')).toBeUndefined();
  });

  it('writeInstanceConfig：合并写不覆盖用户既有键，provider 冲突加后缀', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'coteam-oc-json-'));
    fs.writeFileSync(path.join(dir, 'opencode.json'), JSON.stringify({ theme: 'tokyonight', provider: { deepseek: { models: { user_model: {} } } } }));
    const env = writeInstanceConfig(dir, POOL);
    expect(env).toEqual({ COTEAM_OC_KEY_DEEPSEEK: 'sk-a', COTEAM_OC_KEY_ALIYUN: 'sk-b' });
    const merged = JSON.parse(fs.readFileSync(path.join(dir, 'opencode.json'), 'utf-8'));
    expect(merged.theme).toBe('tokyonight'); // 用户键保留
    expect(merged.provider.deepseek.models.user_model).toBeDefined(); // 用户 provider 保留
    expect(merged.provider['deepseek-coteam'].models['deepseek-chat']).toBeDefined(); // 冲突加后缀
    expect(merged.provider.aliyun).toBeDefined();
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

// ---------- oc_* 工具层（假桥：跑 run_task 全流程与模型降级链） ----------

/** 可控假桥：记录调用序列，按脚本决定返回值 */
class FakeBridge {
  calls: string[] = [];
  /** prompt 第 N 次发送是否失败（模拟模型故障，触发降级链） */
  failFirstSend = false;
  constructor(private opts: { shell?: boolean } = {}) {}
  private n = 0;

  listInstances() {
    return [{
      id: 't1', kind: 'managed' as const, enabled: true, state: 'connected' as const,
      url: 'http://127.0.0.1:1', mode: 'control' as const, version: '1.0', model_injection: true,
    }];
  }
  instanceCapabilities() {
    return { healthy: true, version: '1.0', sync_prompt: true, async_prompt: true, abort: true, revert: true, diff: true, permissions: true, events: true, shell: this.opts.shell === true, tui: false };
  }
  async listSessions() { this.calls.push('listSessions'); return { ok: true, data: [{ id: 's1' }] }; }
  async createSession() { this.calls.push('createSession'); return { ok: true, data: { id: 'sess-new' } }; }
  async readMessages(_a: unknown, _i: string, _s: string, opts?: { limit?: number; before?: string }) {
    this.calls.push(`readMessages:${opts?.before ? 'page' : 'tail'}`);
    const msg = { info: { id: 'm1', role: 'assistant' }, parts: [{ type: 'text', text: '任务完成：测试全绿' }] };
    return { ok: true, data: { messages: [msg], has_more: !!opts?.before, trimmed: [] } };
  }
  async sendPrompt() { this.calls.push('sendPrompt'); return { ok: true, data: { info: { role: 'assistant' }, parts: [{ type: 'text', text: 'ok' }] } }; }
  async sendPromptAsync() {
    this.calls.push('sendPromptAsync');
    this.n += 1;
    if (this.failFirstSend && this.n === 1) return { ok: false, error: '模型 429 限流' };
    return { ok: true, data: { messageID: 'm-new' } };
  }
  async abortSession() { this.calls.push('abort'); return { ok: true, data: true }; }
  async revertMessage() { this.calls.push('revert'); return { ok: true, data: true }; }
  async sessionDiff() { this.calls.push('diff'); return { ok: true, data: [{ file: 'a.ts', additions: 2, deletions: 0 }] }; }
  async answerPermission() { this.calls.push('permission'); return { ok: true, data: true }; }
  async runShell() { this.calls.push('shell'); return { ok: true, data: {} }; }
  async waitSessionIdle() { this.calls.push('waitIdle'); return { ok: true, data: 'idle' as const }; }
  toolsIndex() { return 'fake-index'; }
  listModelsForAgent() { return [{ instance: 't1', models: ['m-a', 'm-b'] }]; }
  hasShellEnabled() { return this.opts.shell === true; }
  resolveModel(_i: string, name: string) { return name === 'm-a' || name === 'm-b' ? { providerID: 'p', modelID: name } : undefined; }
}

function fakeBridge(opts: { shell?: boolean } = {}): FakeBridge & OpencodeBridge {
  return new FakeBridge(opts) as FakeBridge & OpencodeBridge;
}

describe('oc_* 工具层', () => {
  it('isOcTool 精确匹配（不误伤未来工具）', () => {
    expect(isOcTool('oc_run_task')).toBe(true);
    expect(isOcTool('OC_RUN_TASK')).toBe(false); // 调用方已 lowerCase，这里验证原样语义
    expect(isOcTool('oc_unknown')).toBe(false);
    expect(isOcTool('exec')).toBe(false);
  });

  it('extractLastAssistantText：从 parts 抽取最后一条助手文本', () => {
    expect(extractLastAssistantText([
      { info: { role: 'user' }, parts: [{ type: 'text', text: '问题' }] },
      { info: { role: 'assistant' }, parts: [{ type: 'reasoning', text: '想' }, { type: 'text', text: '答案' }] },
    ])).toBe('答案');
    expect(extractLastAssistantText([{ info: { role: 'user' }, parts: [] }])).toBe('');
    expect(extractLastAssistantText('not-array' as unknown as unknown[])).toBe('');
  });

  it('oc_run_task：建会话→异步发→等 idle→回收终局文本+diff', async () => {
    const bridge = fakeBridge();
    const r = await runOpencodeTool(bridge, 'dev', { tool: 'oc_run_task', instance: 't1', prompt: '把测试跑绿' });
    expect(r.ok).toBe(true);
    expect(r.session).toBe('sess-new');
    expect(r.final_text).toBe('任务完成：测试全绿');
    expect(r.diff).toEqual([{ file: 'a.ts', additions: 2, deletions: 0 }]);
    expect(bridge.calls).toEqual(['createSession', 'sendPromptAsync', 'waitIdle', 'readMessages:tail', 'diff']);
  });

  it('oc_run_task 模型降级链：首选失败自动换下一个', async () => {
    const bridge = fakeBridge();
    bridge.failFirstSend = true;
    const r = await runOpencodeTool(bridge, 'dev', { tool: 'oc_run_task', instance: 't1', prompt: 'x', models: ['m-a', 'm-b'] });
    expect(r.ok).toBe(true);
    // 两次 sendPromptAsync：第一次 m-a 失败，第二次 m-b 成功
    expect(bridge.calls.filter((c) => c === 'sendPromptAsync').length).toBe(2);
    const sends = bridge.calls;
    expect(sends.indexOf('sendPromptAsync')).toBeGreaterThan(-1);
  });

  it('oc_run_task 模型名不可解析时明确报错', async () => {
    const r = await runOpencodeTool(fakeBridge(), 'dev', { tool: 'oc_run_task', instance: 't1', prompt: 'x', models: ['not-in-pool'] });
    expect(r.ok).toBe(false);
    expect(String(r.error)).toContain('not-in-pool');
  });

  it('oc_permission 参数校验：response 三态', async () => {
    const bridge = fakeBridge();
    expect((await runOpencodeTool(bridge, 'dev', { tool: 'oc_permission', instance: 't1', session_id: 's1', permission_id: 'p1', response: 'reject' })).ok).toBe(true);
    expect((await runOpencodeTool(bridge, 'dev', { tool: 'oc_permission', instance: 't1', session_id: 's1', permission_id: 'p1', response: 'maybe' })).ok).toBe(false);
    expect((await runOpencodeTool(bridge, 'dev', { tool: 'oc_permission', instance: 't1', session_id: 's1', response: 'once' })).ok).toBe(false);
  });

  it('oc_shell 走桥的 runShell（实例未开 allow_shell 时由 manager 拒——这里验参数传递）', async () => {
    const bridge = fakeBridge({ shell: true });
    const r = await runOpencodeTool(bridge, 'dev', { tool: 'oc_shell', instance: 't1', session_id: 's1', command: 'ls' });
    expect(r.ok).toBe(true);
    expect(bridge.calls).toContain('shell');
  });

  it('未知/缺参：软错误不 throw', async () => {
    expect((await runOpencodeTool(fakeBridge(), 'dev', { tool: 'oc_nope', instance: 't1' })).ok).toBe(false);
    expect((await runOpencodeTool(fakeBridge(), 'dev', { tool: 'oc_send', instance: '', prompt: 'x' })).ok).toBe(false);
    expect((await runOpencodeTool(fakeBridge(), 'dev', { tool: 'oc_send', instance: 't1', session_id: 's1' })).ok).toBe(false);
  });
});

// ---------- applyToolCalls 的 oc_ 分发（任务管线路径） ----------

describe('applyToolCalls oc_ 分发', () => {
  it('经 knowledgeCtx.opencode 桥执行并回喂', async () => {
    const bridge = fakeBridge();
    const results = await applyToolCalls(process.cwd(), [{ tool: 'oc_run_task', instance: 't1', prompt: '跑测试' }] as any, { agent: 'dev', opencode: bridge });
    expect((results[0] as any).ok).toBe(true);
    expect((results[0] as any).final_text).toBe('任务完成：测试全绿');
  });

  it('缺桥：软错误提示配置方向', async () => {
    const results = await applyToolCalls(process.cwd(), [{ tool: 'oc_read', instance: 't1', session_id: 's1' }] as any, { agent: 'dev' });
    expect((results[0] as any).ok).toBe(false);
    expect(String((results[0] as any).error)).toContain('opencode.instances');
  });
});

// ---------- 消息分页与裁剪（"看不全"修复） ----------

describe('trimMessageForUi（消息 UI 裁剪）', () => {
  it('剥掉 info.system（UserMessage 的 system prompt，UI 不用）', () => {
    const r = trimMessageForUi({ info: { id: 'm1', role: 'user', system: 'you are a helpful assistant '.repeat(1000) }, parts: [{ id: 'p1', type: 'text', text: 'hi' }] });
    expect((r.msg.info as any).system).toBeUndefined();
    expect((r.msg.info as any).id).toBe('m1');
    expect(r.trimmed).toEqual([]);
  });

  it('超大 tool 输出头尾裁剪并标记 part id', () => {
    const big = 'x'.repeat(300 * 1024);
    const r = trimMessageForUi({ info: { id: 'm2', role: 'assistant' }, parts: [{ id: 'pt1', type: 'tool', tool: 'bash', state: { status: 'completed', input: {}, output: big } }] });
    const out = (r.msg.parts as any)[0].state.output as string;
    expect(out.length).toBeLessThan(12 * 1024);
    expect(out.startsWith('xxxx')).toBe(true);
    expect(out).toContain('中间省略');
    expect(out.endsWith('x'.repeat(8192))).toBe(true);
    expect(r.trimmed).toEqual(['pt1']);
  });

  it('超大 input（图片 base64/长 diff）折叠为占位——裁剪不能形同虚设', () => {
    const bigInput = { image: 'data:image/png;base64,' + 'A'.repeat(400 * 1024), prompt: '看图' };
    const r = trimMessageForUi({ info: { id: 'm4', role: 'assistant' }, parts: [{ id: 'pt4', type: 'tool', tool: 'read', state: { status: 'completed', input: bigInput, output: 'ok' } }] });
    const p = (r.msg.parts as any)[0];
    expect(p.state.input.__trimmed).toContain('输入参数过大');
    expect(JSON.stringify(p).length).toBeLessThan(4 * 1024);
    expect(p.state.output).toBe('ok'); // 短 output 不动
    expect(r.trimmed).toEqual(['pt4']);
  });

  it('超大 attachments（read 图片的 base64，实测 291KB）折叠为文件名摘要', () => {
    const attachments = [{ filename: 'shot.png', mime: 'image/png', url: 'data:image/png;base64,' + 'B'.repeat(290 * 1024) }];
    const r = trimMessageForUi({ info: { id: 'm5', role: 'assistant' }, parts: [{ id: 'pt5', type: 'tool', tool: 'read', state: { status: 'completed', input: { file: 'a.png' }, attachments, output: 'Image read successfully' } }] });
    const p = (r.msg.parts as any)[0];
    expect(JSON.stringify(p).length).toBeLessThan(4 * 1024);
    expect(p.state.attachments).toEqual([{ filename: 'shot.png' }]); // 只留文件名
    expect(p.state.__attachmentsTrimmed).toContain('附件内容过大已折叠');
    expect(r.trimmed).toEqual(['pt5']);
  });

  it('小消息原样不动', () => {
    const msg = { info: { id: 'm3', role: 'assistant' }, parts: [{ id: 'p', type: 'text', text: '短' }] };
    expect(trimMessageForUi(msg).msg).toEqual(msg);
  });
});
