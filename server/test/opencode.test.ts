import { describe, it, expect, afterAll, beforeAll, vi } from 'vitest';
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
const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://127.0.0.1');
  const json = (code, body) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
  if (req.method === 'GET' && u.pathname === '/global/health') return json(200, { healthy: true, version: '1.18.32-fake' });
  if (req.method === 'GET' && u.pathname === '/doc') return json(200, { paths: { '/session': {}, '/session/{id}/message': {}, '/session/{id}/abort': {}, '/session/{id}/diff': {}, '/session/{id}/permissions/{permissionID}': {}, '/event': {}, '/tui/append-prompt': {} } });
  if (req.method === 'GET' && u.pathname === '/session') return json(200, [{ id: 's1', title: 'first' }, { id: 's2', title: 'second' }]);
  if (req.method === 'GET' && u.pathname === '/session/status') return json(200, { s1: { type: 'idle' } });
  if (req.method === 'POST' && u.pathname === '/session') return json(200, { id: 'new-s', title: 'created' });
  if (req.method === 'GET' && u.pathname === '/session/s1/message') return json(200, [{ info: { id: 'm1' }, parts: [{ type: 'text', text: 'hello from fake' }] }]);
  if (req.method === 'POST' && u.pathname === '/session/s1/message') return json(200, { info: { id: 'm2' }, parts: [{ type: 'text', text: 'done' }] });
  if (req.method === 'POST' && u.pathname === '/session/s1/abort') return json(200, true);
  if (req.method === 'POST' && u.pathname === '/session/s1/revert') return json(200, true);
  if (req.method === 'GET' && u.pathname === '/session/s1/diff') return json(200, [{ file: 'a.ts', additions: 3, deletions: 1 }]);
  if (req.method === 'POST' && u.pathname === '/session/s1/permissions/p1') return json(200, true);
  if (req.method === 'POST' && u.pathname === '/tui/append-prompt') return json(200, true);
  if (req.method === 'GET' && u.pathname === '/event') {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('data: ' + JSON.stringify({ type: 'server.connected', properties: {} }) + '\\n\\n');
    res.write('data: ' + JSON.stringify({ type: 'session.idle', properties: { sessionID: 's1' } }) + '\\n\\n');
    const t = setInterval(() => res.write(': ping\\n\\n'), 1000);
    req.on('close', () => clearInterval(t));
    return;
  }
  if (req.method === 'GET' && u.pathname === '/notfound') return json(404, { error: 'nope' });
  json(200, true);
});
server.listen(port, '127.0.0.1', () => console.log('fake-oc listening ' + port));
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
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    const u = new URL(url);
    const route = routes[`${(init?.method || 'GET') as string} ${u.pathname}`] || routes[`* ${u.pathname}`];
    if (!route) return new Response('not found', { status: 404 });
    const body = route.text ?? (route.body !== undefined ? JSON.stringify(route.body) : '');
    return new Response(body, { status: route.status ?? 200, headers: { 'content-type': 'application/json' } });
  });
}

describe('OpencodeClient', () => {
  afterAll(() => vi.unstubAllGlobals());

  it('health / probe：/doc 路径存在性打标 capabilities', async () => {
    mockFetch({
      'GET /global/health': { body: { healthy: true, version: '1.18.32' } },
      'GET /doc': { body: { paths: { '/session': {}, '/session/{id}/message': {}, '/event': {} } } },
    });
    const c = new OpencodeClient({ baseUrl: 'http://127.0.0.1:9999/' });
    const h = await c.health();
    expect(h.ok).toBe(true);
    expect(h.data?.version).toBe('1.18.32');
    const caps = await c.probe();
    expect(caps.healthy).toBe(true);
    expect(caps.sync_prompt).toBe(true);
    expect(caps.async_prompt).toBe(false);
    expect(caps.events).toBe(true);
    expect(caps.tui).toBe(false);
  });

  it('probe：/doc 解析失败回退 v1 保守端点集', async () => {
    mockFetch({
      'GET /global/health': { body: { healthy: true, version: 'x' } },
      'GET /doc': { text: '<html>swagger page</html>' },
    });
    const caps = await new OpencodeClient({ baseUrl: 'http://127.0.0.1:9999' }).probe();
    expect(caps.sync_prompt).toBe(true);
    expect(caps.shell).toBe(false); // v1 fallback 不含 shell
    expect(caps.tui).toBe(true);
  });

  it('HTTP 错误与网络异常全部软收口 {ok:false}', async () => {
    mockFetch({ 'GET /session': { status: 500, text: 'boom' } });
    const r = await new OpencodeClient({ baseUrl: 'http://127.0.0.1:9999' }).listSessions();
    expect(r.ok).toBe(false);
    expect(r.error).toContain('500');
    vi.unstubAllGlobals();
    vi.stubGlobal('fetch', async () => { throw new Error('ECONNREFUSED'); });
    const r2 = await new OpencodeClient({ baseUrl: 'http://127.0.0.1:9999' }).listSessions();
    expect(r2).toEqual({ ok: false, error: 'ECONNREFUSED' });
  });

  it('Basic 鉴权头注入（桌面版 service 401 场景）', async () => {
    let seen = '';
    vi.stubGlobal('fetch', async (_url: string, init?: RequestInit) => {
      seen = String((init?.headers as Record<string, string>)?.authorization || '');
      return new Response(JSON.stringify({ healthy: true, version: 'v' }), { status: 200 });
    });
    await new OpencodeClient({ baseUrl: 'http://127.0.0.1:9999', auth: { username: 'opencode', password: 'pw' } }).health();
    expect(seen).toBe(`Basic ${Buffer.from('opencode:pw').toString('base64')}`);
  });

  it('prompt 带 model 注入（场景 B 逐条选型）', async () => {
    let sent: any;
    vi.stubGlobal('fetch', async (_url: string, init?: RequestInit) => {
      sent = { method: init?.method, body: JSON.parse(String(init?.body || '{}')) };
      return new Response(JSON.stringify({ info: { id: 'm' }, parts: [] }), { status: 200 });
    });
    await new OpencodeClient({ baseUrl: 'http://127.0.0.1:9999' }).prompt('s1', 'do it', { providerID: 'deepseek', modelID: 'ds-v4' });
    expect(sent.method).toBe('POST');
    expect(sent.body.parts[0]).toEqual({ type: 'text', text: 'do it' });
    expect(sent.body.model).toEqual({ providerID: 'deepseek', modelID: 'ds-v4' });
  });

  it('列表结果按元素截断且保持数组类型', async () => {
    const big = Array.from({ length: 40 }, (_, i) => ({ id: `s${i}`, title: 'x'.repeat(100) }));
    mockFetch({ 'GET /session': { body: big } });
    const r = await new OpencodeClient({ baseUrl: 'http://127.0.0.1:9999', maxResultChars: 500 }).listSessions();
    expect(r.ok).toBe(true);
    expect(Array.isArray(r.data)).toBe(true);
    expect(r.truncated).toBe(true);
    expect((r.data as unknown[]).length).toBeLessThan(40);
  });

  it('eventStream：解析 SSE data 帧，跳过畸形帧与注释', async () => {
    const frames = [
      ': ping\n\n',
      'data: {"type":"session.idle","properties":{"sessionID":"s1"}}\n\n',
      'data: not-json\n\n',
      'data: {"type":"message.part.updated","properties":{}}\n\n',
    ];
    vi.stubGlobal('fetch', async () => {
      const stream = new ReadableStream({
        start(controller) {
          const enc = new TextEncoder();
          for (const f of frames) controller.enqueue(enc.encode(f));
          controller.close();
        },
      });
      return new Response(stream, { status: 200 });
    });
    const got: string[] = [];
    for await (const ev of new OpencodeClient({ baseUrl: 'http://127.0.0.1:9999' }).eventStream()) got.push(ev.type);
    expect(got).toEqual(['session.idle', 'message.part.updated']);
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
    mgr.start();
    const ok = await waitFor(() => mgr.listInstances()[0]?.state === 'connected');
    expect(ok).toBe(true);
    const st = mgr.listInstances()[0]!;
    expect(st.capabilities?.version).toBe('1.18.32-fake');
    expect(st.pid).toBeGreaterThan(0);

    const sessions = await mgr.listSessions('dev', 't1');
    expect(sessions.ok).toBe(true);
    expect((sessions.data as any[]).length).toBe(2);

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

  it('attached-cli：readonly 档拒绝控制操作、放行只读与审批；allow_shell 默认禁用', async () => {
    // 先手动拉起一个假服务当 attached 目标
    const port = 38112;
    const child = spawn('node', [fakeOcFile, 'serve', '--port', String(port)], { stdio: 'ignore', shell: true });
    let up = false;
    for (let i = 0; i < 100 && !up; i++) {
      try { up = (await fetch(`http://127.0.0.1:${port}/global/health`)).ok; } catch { /* 未起 */ }
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
class FakeBridge implements OpencodeBridge {
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
    const bridge = new FakeBridge();
    const r = await runOpencodeTool(bridge, 'dev', { tool: 'oc_run_task', instance: 't1', prompt: '把测试跑绿' });
    expect(r.ok).toBe(true);
    expect(r.session).toBe('sess-new');
    expect(r.final_text).toBe('任务完成：测试全绿');
    expect(r.diff).toEqual([{ file: 'a.ts', additions: 2, deletions: 0 }]);
    expect(bridge.calls).toEqual(['createSession', 'sendPromptAsync', 'waitIdle', 'readMessages:tail', 'diff']);
  });

  it('oc_run_task 模型降级链：首选失败自动换下一个', async () => {
    const bridge = new FakeBridge();
    bridge.failFirstSend = true;
    const r = await runOpencodeTool(bridge, 'dev', { tool: 'oc_run_task', instance: 't1', prompt: 'x', models: ['m-a', 'm-b'] });
    expect(r.ok).toBe(true);
    // 两次 sendPromptAsync：第一次 m-a 失败，第二次 m-b 成功
    expect(bridge.calls.filter((c) => c === 'sendPromptAsync').length).toBe(2);
    const sends = bridge.calls;
    expect(sends.indexOf('sendPromptAsync')).toBeGreaterThan(-1);
  });

  it('oc_run_task 模型名不可解析时明确报错', async () => {
    const r = await runOpencodeTool(new FakeBridge(), 'dev', { tool: 'oc_run_task', instance: 't1', prompt: 'x', models: ['not-in-pool'] });
    expect(r.ok).toBe(false);
    expect(String(r.error)).toContain('not-in-pool');
  });

  it('oc_permission 参数校验：response 三态', async () => {
    const bridge = new FakeBridge();
    expect((await runOpencodeTool(bridge, 'dev', { tool: 'oc_permission', instance: 't1', session_id: 's1', permission_id: 'p1', response: 'reject' })).ok).toBe(true);
    expect((await runOpencodeTool(bridge, 'dev', { tool: 'oc_permission', instance: 't1', session_id: 's1', permission_id: 'p1', response: 'maybe' })).ok).toBe(false);
    expect((await runOpencodeTool(bridge, 'dev', { tool: 'oc_permission', instance: 't1', session_id: 's1', response: 'once' })).ok).toBe(false);
  });

  it('oc_shell 走桥的 runShell（实例未开 allow_shell 时由 manager 拒——这里验参数传递）', async () => {
    const bridge = new FakeBridge({ shell: true });
    const r = await runOpencodeTool(bridge, 'dev', { tool: 'oc_shell', instance: 't1', session_id: 's1', command: 'ls' });
    expect(r.ok).toBe(true);
    expect(bridge.calls).toContain('shell');
  });

  it('未知/缺参：软错误不 throw', async () => {
    expect((await runOpencodeTool(new FakeBridge(), 'dev', { tool: 'oc_nope', instance: 't1' })).ok).toBe(false);
    expect((await runOpencodeTool(new FakeBridge(), 'dev', { tool: 'oc_send', instance: '', prompt: 'x' })).ok).toBe(false);
    expect((await runOpencodeTool(new FakeBridge(), 'dev', { tool: 'oc_send', instance: 't1', session_id: 's1' })).ok).toBe(false);
  });
});

// ---------- applyToolCalls 的 oc_ 分发（任务管线路径） ----------

describe('applyToolCalls oc_ 分发', () => {
  it('经 knowledgeCtx.opencode 桥执行并回喂', async () => {
    const bridge = new FakeBridge();
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
