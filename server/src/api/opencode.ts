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

  app.get('/api/opencode/sessions/:instance/:session/messages', async (c) => {
    const r = await oc().readMessages(undefined, c.req.param('instance'), c.req.param('session'));
    return c.json(r.ok ? { messages: r.data, ...(r.truncated ? { truncated: true } : {}) } : { error: r.error }, r.ok ? 200 : 400);
  });

  app.post('/api/opencode/sessions/:instance/:session/prompt', async (c) => {
    const body = await readJsonAuto<{ prompt?: string; model?: string }>(c);
    const prompt = String(body.prompt || '').trim();
    if (!prompt) return c.json({ detail: 'prompt 不能为空' }, 400);
    const model = body.model ? oc().resolveModel(c.req.param('instance'), String(body.model)) : undefined;
    const r = await oc().sendPrompt(undefined, c.req.param('instance'), c.req.param('session'), prompt, model);
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
}
