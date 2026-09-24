/**
 * OpenCode 接管 API（/api/opencode/*）——双端「外部运行时」面板与服务端集成的数据面。
 *
 * 路由（与 web/mobile 面板的契约一一对应）：
 *   GET    /api/opencode/instances                     实例状态清单
 *   GET    /api/opencode/config                        实例配置（含密钥占位符不回显明文）
 *   PUT    /api/opencode/config                        保存并热生效（applyConfig 差异启停）
 *   POST   /api/opencode/instances/:id/start | stop    managed 实例手动启停
 *   GET    /api/opencode/instances/:id/sessions        会话列表
 *   GET    /api/opencode/sessions/:i/:s/messages       会话消息
 *   POST   /api/opencode/sessions/:i/:s/prompt         发指令（同步等结果）
 *   POST   /api/opencode/sessions/:i/:s/abort          打断
 *   POST   /api/opencode/sessions/:i/:s/revert         回退消息
 *   GET    /api/opencode/sessions/:i/:s/diff           文件变更
 *   POST   /api/opencode/sessions/:i/:s/permissions    回应权限请求（面板审批按钮）
 *
 * 权限语义：全部 /api 请求已过 dashboard token 门禁（createApi 统一中间件）；
 * 实例级 readonly/control 档位与 agent 白名单由 OpencodeManager 门控（agent=undefined=API 层）。
 */
import { Hono } from 'hono';
import { streamSSE, type SSEStreamingApi } from 'hono/streaming';
import type { ApiContext, HttpError } from './index';
import { readJsonAuto } from './index';
import { validateOpencodeInstanceConfigs } from '../opencode/manager';
import { saveOpencodeInstances } from '../configStore';
import { runOpencodeTool } from '../opencode/ocTools';
import type { OpencodeInstanceConfig } from '../opencode/types';

export function registerOpencodeRoutes(app: Hono, ctx: ApiContext): void {
  const oc = () => {
    if (!ctx.opencode) throw new Error('未配置 opencode.instances（config.yaml），OpenCode 接管未启用');
    return ctx.opencode;
  };

  // ---------- 实例状态与配置 ----------

  app.get('/api/opencode/instances', (c) => {
    try {
      return c.json({ instances: oc().listInstances() });
    } catch (e: any) {
      return c.json({ instances: [], error: String(e?.message || e) }, 200);
    }
  });

  app.get('/api/opencode/config', (c) => {
    const instances = (ctx.config.opencode?.instances || []).map((i) => ({
      ...i,
      // 密钥不回显明文：占位符原样（${ENV_VAR}），真实值以 *** 占位
      ...(i.auth?.password ? { auth: { ...i.auth, password: /\$\{[A-Z0-9_]+\}/i.test(i.auth.password) ? i.auth.password : '***' } } : {}),
    }));
    return c.json({ instances });
  });

  app.put('/api/opencode/config', async (c) => {
    const body = await readJsonAuto<{ instances?: unknown }>(c);
    // 保存前把面板回传的 *** 掩码还原成磁盘上的真实占位/值（不允许通过 UI 窥探或清空密钥）
    const onDisk = ctx.config.opencode?.instances || [];
    const raw = Array.isArray(body.instances) ? (body.instances as Record<string, any>[]) : [];
    const merged: OpencodeInstanceConfig[] = raw.map((i) => {
      if (i?.auth?.password === '***') {
        const prev = onDisk.find((o) => o.id === String(i.id || '').toLowerCase());
        return { ...i, ...(prev?.auth?.password ? { auth: { ...i.auth, password: prev.auth.password } } : { auth: { ...i.auth, password: '' } }) } as OpencodeInstanceConfig;
      }
      return i as OpencodeInstanceConfig;
    });
    const instances = validateOpencodeInstanceConfigs(merged);
    oc(); // 未启用时拒绝写配置（防止面板凭空开启半成品状态）
    saveOpencodeInstances(instances);
    await oc().applyConfig(instances);
    return c.json({ ok: true, instances: instances.length });
  });

  app.post('/api/opencode/instances/:id/start', async (c) => {
    const ok = await oc().startInstance(c.req.param('id'));
    return c.json({ ok });
  });

  app.post('/api/opencode/instances/:id/stop', async (c) => {
    const ok = await oc().stopInstance(c.req.param('id'));
    return c.json({ ok });
  });

  // ---------- 会话面（桥调用：agent=undefined 即 API 层，不看 agent 白名单） ----------

  app.get('/api/opencode/instances/:id/sessions', async (c) => {
    const r = await oc().listSessions(undefined, c.req.param('id'));
    return c.json(r.ok ? { sessions: r.data } : { sessions: [], error: r.error }, r.ok ? 200 : 400);
  });

  /** 新建会话（control 档；"新建并接管"的安全路径——不碰 TUI 正在用的会话） */
  app.post('/api/opencode/instances/:id/sessions', async (c) => {
    const body = await readJsonAuto<{ title?: string }>(c).catch(() => ({}) as { title?: string });
    const r = await oc().createSession(undefined, c.req.param('id'), body.title ? String(body.title) : undefined);
    return c.json(r.ok ? { ok: true, session: r.data } : { ok: false, error: r.error }, r.ok ? 200 : 400);
  });

  app.get('/api/opencode/sessions/:instance/:session/messages', async (c) => {
    const r = await oc().readMessages(undefined, c.req.param('instance'), c.req.param('session'));
    return c.json(r.ok ? { messages: r.data, ...(r.truncated ? { truncated: true } : {}) } : { error: r.error }, r.ok ? 200 : 400);
  });

  app.post('/api/opencode/sessions/:instance/:session/prompt', async (c) => {
    const body = await readJsonAuto<{ prompt?: string; model?: unknown; agent?: string }>(c);
    const prompt = String(body.prompt || '').trim();
    if (!prompt) return c.json({ detail: 'prompt 不能为空' }, 400);
    // model 双轨：字符串=池名(manager 解析)或原生 provider/model；对象 {providerID,modelID} 直穿（attached 用 opencode 自己的模型）
    let model: { providerID: string; modelID: string } | undefined;
    if (typeof body.model === 'string' && body.model.trim()) {
      model = oc().resolveModel(c.req.param('instance'), body.model.trim());
      if (!model) return c.json({ ok: false, error: `模型 ${body.model} 无法解析（managed 用池内名；attached 用 provider/model 原生格式）` }, 400);
    } else if (body.model && typeof body.model === 'object') {
      const m = body.model as { providerID?: string; modelID?: string };
      if (m.providerID && m.modelID) model = { providerID: m.providerID, modelID: m.modelID };
    }
    const agent = String(body.agent || '').trim() || undefined;
    const r = await oc().sendPrompt(undefined, c.req.param('instance'), c.req.param('session'), prompt, model, agent);
    return c.json(r.ok ? { ok: true, result: r.data } : { ok: false, error: r.error }, r.ok ? 200 : 400);
  });

  app.post('/api/opencode/sessions/:instance/:session/abort', async (c) => {
    const r = await oc().abortSession(undefined, c.req.param('instance'), c.req.param('session'));
    return c.json(r.ok ? { ok: true } : { ok: false, error: r.error }, r.ok ? 200 : 400);
  });

  app.post('/api/opencode/sessions/:instance/:session/revert', async (c) => {
    const body = await readJsonAuto<{ message_id?: string }>(c);
    const messageId = String(body.message_id || '').trim();
    if (!messageId) return c.json({ detail: 'message_id 不能为空' }, 400);
    const r = await oc().revertMessage(undefined, c.req.param('instance'), c.req.param('session'), messageId);
    return c.json(r.ok ? { ok: true } : { ok: false, error: r.error }, r.ok ? 200 : 400);
  });

  app.get('/api/opencode/sessions/:instance/:session/diff', async (c) => {
    const r = await oc().sessionDiff(undefined, c.req.param('instance'), c.req.param('session'));
    return c.json(r.ok ? { ok: true, diff: r.data, ...(r.truncated ? { truncated: true } : {}) } : { ok: false, error: r.error }, r.ok ? 200 : 400);
  });

  app.post('/api/opencode/sessions/:instance/:session/permissions', async (c) => {
    const body = await readJsonAuto<{ permission_id?: string; response?: string }>(c);
    // 复用 oc_ 分发器的参数校验（permission_id/response 语义与工具版一致）
    const r = await runOpencodeTool(oc(), undefined, {
      tool: 'oc_permission',
      instance: c.req.param('instance'),
      session_id: c.req.param('session'),
      permission_id: body.permission_id,
      response: body.response,
    });
    return c.json((r as { ok: boolean }).ok ? { ok: true } : { ok: false, error: (r as { error?: string }).error }, (r as { ok: boolean }).ok ? 200 : 400);
  });

  // ---------- TUI 同构接管面（对话镜像的实时数据与驱动通道） ----------

  /** 接管当前对话：busy 优先否则最近更新（TUI 无 state API，启发式 + reason 可解释） */
  app.get('/api/opencode/instances/:id/active-session', async (c) => {
    const r = await oc().activeSession(undefined, c.req.param('id'));
    return c.json(r.ok ? { ok: true, ...r.data } : { ok: false, error: r.error }, r.ok ? 200 : 400);
  });

  /** agent 清单（composer 的 agent 下拉；opencode 内置 + 自定义） */
  app.get('/api/opencode/instances/:id/agents', async (c) => {
    const r = await oc().listAgents(undefined, c.req.param('id'));
    return c.json(r.ok ? { agents: r.data } : { agents: [], error: r.error }, 200);
  });

  /** providers + 默认模型（attached 实例的模型下拉；managed 用 co-team 模型池） */
  app.get('/api/opencode/instances/:id/models', async (c) => {
    const r = await oc().listProviders(undefined, c.req.param('id'));
    return c.json(r.ok ? { ...r.data } : { providers: [], default: {}, error: r.error }, 200);
  });

  /** 会话状态表（busy/idle；composer 的忙碌指示） */
  app.get('/api/opencode/sessions/:instance/:session/status', async (c) => {
    const r = await oc().sessionStatus(undefined, c.req.param('instance'));
    const s = r.ok ? r.data?.[c.req.param('session')] : undefined;
    return c.json({ ok: true, status: s?.type || 'unknown' });
  });

  /** 会话 todos（TUI 顶部任务清单） */
  app.get('/api/opencode/sessions/:instance/:session/todo', async (c) => {
    const r = await oc().sessionTodos(undefined, c.req.param('instance'), c.req.param('session'));
    return c.json(r.ok ? { todos: r.data } : { todos: [], error: r.error }, 200);
  });

  /** 斜杠命令（TUI 的 /命令，如 summarize） */
  app.post('/api/opencode/sessions/:instance/:session/command', async (c) => {
    const body = await readJsonAuto<{ command?: string }>(c);
    const command = String(body.command || '').trim().replace(/^\//, '');
    if (!command) return c.json({ detail: 'command 不能为空' }, 400);
    const r = await oc().runCommand(undefined, c.req.param('instance'), c.req.param('session'), command);
    return c.json(r.ok ? { ok: true, result: r.data } : { ok: false, error: r.error }, r.ok ? 200 : 400);
  });

  // ---------- TUI 驱动（遥控用户 TUI：塞字/提交/toast/开会话选择器） ----------

  app.post('/api/opencode/tui/:id/append', async (c) => {
    const body = await readJsonAuto<{ text?: string }>(c);
    const text = String(body.text || '');
    if (!text.trim()) return c.json({ detail: 'text 不能为空' }, 400);
    const r = await oc().tuiAppend(undefined, c.req.param('id'), text);
    return c.json(r.ok ? { ok: true } : { ok: false, error: r.error }, r.ok ? 200 : 400);
  });

  app.post('/api/opencode/tui/:id/submit', async (c) => {
    const r = await oc().tuiSubmit(undefined, c.req.param('id'));
    return c.json(r.ok ? { ok: true } : { ok: false, error: r.error }, r.ok ? 200 : 400);
  });

  app.post('/api/opencode/tui/:id/toast', async (c) => {
    const body = await readJsonAuto<{ message?: string; variant?: string }>(c);
    const message = String(body.message || '');
    if (!message.trim()) return c.json({ detail: 'message 不能为空' }, 400);
    const variant = ['info', 'success', 'warning', 'error'].includes(String(body.variant)) ? (body.variant as 'info') : 'info';
    const r = await oc().tuiToast(undefined, c.req.param('id'), message, variant);
    return c.json(r.ok ? { ok: true } : { ok: false, error: r.error }, r.ok ? 200 : 400);
  });

  app.post('/api/opencode/tui/:id/open-sessions', async (c) => {
    const r = await oc().tuiOpenSessions(undefined, c.req.param('id'));
    return c.json(r.ok ? { ok: true } : { ok: false, error: r.error }, r.ok ? 200 : 400);
  });

  /** 让位式接管：把 TUI 导航到指定会话（co-team 独占前让 TUI 切走——opencode 无踢客户端 API，
   *  select-session 是 162 端点里唯一能让"原客户端让位"的手段） */
  app.post('/api/opencode/tui/:id/select-session', async (c) => {
    const body = await readJsonAuto<{ session_id?: string }>(c);
    const sid = String(body.session_id || '').trim();
    if (!sid) return c.json({ detail: 'session_id 不能为空' }, 400);
    const r = await oc().tuiSelectSession(undefined, c.req.param('id'), sid);
    return c.json(r.ok ? { ok: true } : { ok: false, error: r.error }, r.ok ? 200 : 400);
  });

  // ---------- PTY（TUI 的实时终端：bash 工具跑在 PTY 里，浏览器持票直连） ----------

  app.get('/api/opencode/instances/:id/ptys', async (c) => {
    const r = await oc().ptyList(undefined, c.req.param('id'));
    return c.json(r.ok ? { ptys: r.data } : { ptys: [], error: r.error }, 200);
  });

  app.post('/api/opencode/instances/:id/ptys/:ptyId/ticket', async (c) => {
    const r = await oc().ptyTicket(undefined, c.req.param('id'), c.req.param('ptyId'));
    return c.json(r.ok ? { ok: true, ...r.data } : { ok: false, error: r.error }, r.ok ? 200 : 400);
  });

  /** managed 直连信息：无鉴权 + CORS 已放行 → 前端 EventSource/WS 直连 opencode（最真流式） */
  app.get('/api/opencode/instances/:id/direct', (c) => {
    const info = oc().directInfo(c.req.param('id'));
    return c.json({ ...info, events_url: info.ok ? `${info.url}/event` : '' });
  });

  /**
   * attached 实例的 SSE 代理：co-team 持 Basic 鉴权代收（EventSource 无法设请求头），
   * 同源分帧给前端。帧型与 WS oc_event 一致：{event} 或 {events:[...]}（delta 微批）。
   */
  app.get('/api/opencode/instances/:id/events', async (c) => {
    const manager = oc();
    const direct = manager.directInfo(c.req.param('id'));
    if (direct.ok) {
      return c.json({ ok: true, direct: true, url: direct.url, events_url: `${direct.url}/event`, hint: 'managed 实例无鉴权，前端应直连' }, 200);
    }
    return streamSSE(c, async (stream: SSEStreamingApi) => {
      const ac = new AbortController();
      stream.onAbort(() => ac.abort());
      const send = async (frame: { event?: unknown; events?: unknown[] }) => {
        try {
          await stream.writeSSE({ data: JSON.stringify(frame), event: 'oc' });
        } catch { /* 前端断开 */ }
      };
      try {
        await manager.proxyEvents(c.req.param('id'), (ev) => void send({ event: ev }), ac.signal);
      } catch (e: any) {
        try { await stream.writeSSE({ data: JSON.stringify({ error: String(e?.message || e).slice(0, 200) }), event: 'oc_error' }); } catch { /* 已断 */ }
      }
    });
  });
}
