/**
 * oc 桥（Step 4）：/oc 进入 OpenCode 模式——绑定实例/会话后自由文本即 prompt，
 * 终稿完成推送回通知聊天；并全局监控【所有实例的所有会话】：完成/失败通知 +
 * 待确认权限/提问审批卡（跨实例聚合，30s 扫描 + 事件驱动）。
 *
 * 通知落点：feishu:oc:notify_chat（/oc 激活时记录）→ 回落审批人私聊。
 * 噪音阀门：config.feishu.oc_watch = all（默认）/ managed / bound。
 * 权限响应 readonly 实例也可用（answerPermission 是 readonly 唯一写操作）。
 */
import { busGet, busSet, getBus } from '../bus';
import { CHANNELS } from '../types';
import { getLogger } from '../logger';
import type { FeishuConfig } from '../config';
import type { FeishuSession } from './session';
import { setSession } from './session';
import { sendCard, sendText } from './messageService';
import { buildResultCard, btnRow, card2, cardResponse, form, inputField, md, note, submitBtn } from './cards';
import type { CardActionInput } from './approvalCards';

export interface OcInstanceLite { id: string; label: string; kind: string; state: string; mode: string }
export interface OcSessionLite { id: string; title?: string }

export interface OcBridgeDeps {
  listInstances: () => Promise<OcInstanceLite[]>;
  activeSession: (instanceId: string) => Promise<OcSessionLite | null>;
  listSessions: (instanceId: string) => Promise<OcSessionLite[]>;
  createSession: (instanceId: string, title?: string) => Promise<OcSessionLite | null>;
  sendPrompt: (instanceId: string, sessionId: string, prompt: string) => Promise<{ ok: boolean; error?: string }>;
  abort: (instanceId: string, sessionId: string) => Promise<boolean>;
  listModels: (instanceId: string) => Promise<{ id: string; label: string; is_default?: boolean }[]>;
  switchModel: (instanceId: string, sessionId: string, modelId: string) => Promise<boolean>;
  listAgents?: (instanceId: string) => Promise<{ id: string; label: string }[]>;
  switchAgent: (instanceId: string, sessionId: string, agent: string) => Promise<boolean>;
  readLastReply: (instanceId: string, sessionId: string) => Promise<string | null>;
  /** 会话最近消息（切会话时预览当前内容用） */
  readRecent: (instanceId: string, sessionId: string, limit: number) => Promise<{ role: string; text: string }[]>;
  pendingAll: () => { permissions: Record<string, any>[]; questions: Record<string, any>[] };
  answerPermission: (instanceId: string, sessionId: string, permissionId: string, response: 'once' | 'always' | 'reject') => Promise<boolean>;
  answerQuestion: (instanceId: string, requestID: string, answers: string[][]) => Promise<boolean>;
  rejectQuestion: (instanceId: string, requestID: string) => Promise<boolean>;
  /** 会话归属提取（oc_event → session id），由挂载处用 events.eventSessionId 实现 */
  eventSessionId: (event: Record<string, any>) => string;
  instanceKind: (instanceId: string) => string;
}

export interface OcBridge {
  enter(arg: string, session: FeishuSession, chatId: string): Promise<string>;
  listSessions(session: FeishuSession): Promise<string>;
  createSession(title: string, session: FeishuSession, chatId: string): Promise<string>;
  switchTo(ref: string, session: FeishuSession, chatId: string): Promise<string>;
  model(ref: string, session: FeishuSession): Promise<string>;
  agent(ref: string, session: FeishuSession): Promise<string>;
  stop(session: FeishuSession): Promise<string>;
  send(text: string, session: FeishuSession, chatId: string): Promise<string>;
  replyTo(instanceId: string, sessionId: string, text: string, chatId?: string): Promise<string>;
  handleCardAction(cfg: FeishuConfig, input: CardActionInput): Promise<Record<string, unknown> | void>;
  start(cfg: FeishuConfig): () => void;
  /** 单次权限/提问扫描（start 的 30s 定时器即循环调用它；独立导出便于测试） */
  scanPendingOnce(cfg: FeishuConfig): Promise<void>;
}

const BIND_TTL_SEC = 7 * 24 * 3600;

async function notifyChat(cfg: FeishuConfig, chatId?: string): Promise<{ id: string; type: 'chat_id' | 'open_id' } | null> {
  if (chatId) await busSet('feishu:oc:notify_chat', { chat_id: chatId }, BIND_TTL_SEC);
  const saved = chatId ? { chat_id: chatId } : await busGet<{ chat_id: string }>('feishu:oc:notify_chat');
  if (saved?.chat_id) return { id: saved.chat_id, type: 'chat_id' };
  if (cfg.approvers?.length) return { id: cfg.approvers[0], type: 'open_id' };
  return null;
}

function sessionMarker(s: FeishuSession, instanceId: string, sessionId?: string): string {
  if (s.oc_instance !== instanceId) return '';
  return sessionId && s.oc_session === sessionId ? ' ✓当前' : sessionId ? '' : '';
}

export function createOcBridge(deps: OcBridgeDeps): OcBridge {
  const logger = getLogger();

  async function bindInstance(instanceId: string, session: FeishuSession, chatId: string): Promise<string> {
    session.mode = 'oc';
    session.oc_instance = instanceId;
    const active = await deps.activeSession(instanceId).catch(() => null);
    session.oc_session = active?.id || (await deps.listSessions(instanceId).catch(() => []))[0]?.id || '';
    await setSession(session);
    await notifyChat(cfg0(), chatId);
    return `✅ 已进入 OpenCode 模式，绑定 ${instanceId}${session.oc_session ? `（会话 ${session.oc_session.slice(0, 12)}）` : ''}。直接输入需求即开始执行；/list 会话 · /new 新建 · /exit 返回。`;
  }

  // cfg 由 start() 注入（通知落点用到 approvers 回落）
  let cfgRef: FeishuConfig | null = null;
  const cfg0 = () => cfgRef || ({ app_id: '', app_secret: '', approvers: [] } as FeishuConfig);

  /** 切会话后的"当前内容"预览：最近几轮对话（用户/助手各一行截断）。 */
  async function renderOcPreview(instanceId: string, sessionId: string): Promise<string> {
    try {
      const recent = await deps.readRecent(instanceId, sessionId, 4);
      if (!recent.length) return '\n（该会话暂无消息）';
      return `\n最近对话：\n${recent.map((m) => `${m.role === 'user' ? '用户' : '助手'}：${m.text.replace(/\s+/g, ' ').slice(0, 120)}`).join('\n')}`;
    } catch {
      return '';
    }
  }

  return {
    async enter(arg, session, chatId) {
      const instances = await deps.listInstances();
      if (!instances.length) return '未发现 OpenCode 实例（managed 未启动或 attached 未运行）。';
      if (arg.trim()) {
        const hit = instances.find((i) => i.id === arg || i.label.includes(arg));
        if (!hit) return `未找到实例「${arg}」。可用：\n${instances.map((i, idx) => `${idx + 1}. ${i.id}（${i.kind} · ${i.state}）`).join('\n')}`;
        return bindInstance(hit.id, session, chatId);
      }
      // 自动绑定：第一个 running 实例
      const first = instances.find((i) => i.state === 'running' || i.state === 'connected') || instances[0];
      const listText = instances.map((i, idx) => `${i === first ? `**${idx + 1}. ${i.id}**` : `${idx + 1}. ${i.id}`}（${i.kind} · ${i.state}${i.mode === 'readonly' ? ' · 只读' : ''}）`).join('\n');
      session.last_list = instances.map((i) => ({ id: i.id, label: `${i.id}（${i.kind} · ${i.state}）` }));
      session.last_list_kind = 'oc_instance';
      await setSession(session);
      const bindMsg = await bindInstance(first.id, session, chatId);
      return `${bindMsg}\n实例列表：\n${listText}`;
    },

    async listSessions(session) {
      if (!session.oc_instance) return '未绑定实例，/oc 重新进入。';
      const sessions = await deps.listSessions(session.oc_instance).catch(() => []);
      session.last_list = sessions.map((s) => ({ id: s.id, label: s.title || s.id }));
      session.last_list_kind = 'oc_session';
      await setSession(session);
      const lines = sessions.slice(0, 10).map((s, i) => `${session.oc_session === s.id ? `**${i + 1}. ${s.title || s.id}（当前）**` : `${i + 1}. ${s.title || s.id}`}`);
      return `实例 ${session.oc_instance} 的会话：\n${lines.join('\n') || '（无会话）'}\n/switch 序号切换 · /new 新建。`;
    },

    async createSession(title, session, chatId) {
      if (!session.oc_instance) return '未绑定实例，/oc 重新进入。';
      const s = await deps.createSession(session.oc_instance, title || undefined).catch(() => null);
      if (!s) return '新建会话失败。';
      session.oc_session = s.id;
      await setSession(session);
      await notifyChat(cfg0(), chatId);
      return `✅ 已新建会话 ${s.title || s.id.slice(0, 12)} 并绑定。直接输入需求。`;
    },

    async switchTo(ref, session, chatId) {
      const n = Number(ref);
      if (Number.isInteger(n) && session.last_list_kind === 'oc_session' && session.last_list?.[n - 1]) {
        const sid = session.last_list[n - 1].id;
        const inst = session.oc_instance || '';
        session.oc_session = sid;
        await setSession(session);
        await notifyChat(cfg0(), chatId);
        const preview = await renderOcPreview(inst, sid);
        return `✅ 已切换到会话 ${sid.slice(0, 12)}。${preview}`;
      }
      if (Number.isInteger(n) && session.last_list_kind === 'oc_instance' && session.last_list?.[n - 1]) {
        const bindMsg = await bindInstance(session.last_list[n - 1].id, session, chatId);
        const inst = session.oc_instance || '';
        const sid = session.oc_session || '';
        const preview = sid ? await renderOcPreview(inst, sid) : '';
        return `${bindMsg}${preview}`;
      }
      return '序号无效：先 /list 或 /oc 刷新列表。';
    },

    async model(ref, session) {
      if (!session.oc_instance || !session.oc_session) return '未绑定实例/会话，/oc 重新进入。';
      const models = await deps.listModels(session.oc_instance).catch(() => []);
      if (!ref.trim()) {
        session.last_list = models.map((m) => ({ id: m.id, label: m.label }));
        session.last_list_kind = 'model';
        await setSession(session);
        return `可用模型：\n${models.slice(0, 12).map((m, i) => `${i + 1}. ${m.label}${m.is_default ? '（默认）' : ''}`).join('\n')}\n/model 序号或名称切换。`;
      }
      const n = Number(ref);
      const hit = Number.isInteger(n) && session.last_list_kind === 'model' ? session.last_list?.[n - 1] : undefined;
      const modelId = hit?.id || models.find((m) => m.id === ref || m.label === ref)?.id || (ref.includes('/') ? ref : '');
      if (!modelId) return `未找到模型「${ref}」，/model 查看全部。`;
      const ok = await deps.switchModel(session.oc_instance, session.oc_session, modelId);
      return ok ? `✅ 已切换模型 ${modelId}。` : '切换失败（见服务端日志）。';
    },

    async agent(ref, session) {
      if (!session.oc_instance || !session.oc_session) return '未绑定实例/会话，/oc 重新进入。';
      if (!ref.trim()) {
        const agents = deps.listAgents ? await deps.listAgents(session.oc_instance).catch(() => []) : [];
        if (!agents.length) return '该实例未提供 Agent 列表，请直接 /agent <名称>。';
        session.last_list = agents.map((a) => ({ id: a.id, label: a.label }));
        session.last_list_kind = 'agent';
        await setSession(session);
        return `可用 Agent：\n${agents.map((a, i) => `${i + 1}. ${a.label}`).join('\n')}\n/agent 序号或名称切换。`;
      }
      const n = Number(ref);
      const hit = Number.isInteger(n) && session.last_list_kind === 'agent' ? session.last_list?.[n - 1] : undefined;
      const agentId = hit?.id || ref;
      const ok = await deps.switchAgent(session.oc_instance, session.oc_session, agentId);
      return ok ? `✅ 已切换 Agent ${agentId}。` : '切换失败（见服务端日志）。';
    },

    async stop(session) {
      if (!session.oc_instance || !session.oc_session) return '未绑定实例/会话。';
      const ok = await deps.abort(session.oc_instance, session.oc_session);
      return ok ? '✅ 已中止当前执行。' : '中止失败（可能已结束）。';
    },

    async send(text, session, chatId) {
      if (!session.oc_instance || !session.oc_session) return '未绑定实例/会话，先 /oc 进入并绑定。';
      return this.replyTo(session.oc_instance, session.oc_session, text, chatId);
    },

    async replyTo(instanceId, sessionId, text, chatId) {
      await notifyChat(cfg0(), chatId);
      const r = await deps.sendPrompt(instanceId, sessionId, text);
      return r.ok
        ? `已发送到 ${instanceId}（会话 ${sessionId.slice(0, 12)}），完成后推送结果——可以关掉飞书等通知。`
        : `发送失败：${String(r.error || '未知错误').slice(0, 200)}`;
    },

    async handleCardAction(cfg, input) {
      const who = input.operatorOpenId || 'unknown';
      let params: Record<string, unknown> | null = input.value && Object.keys(input.value).length ? input.value : null;
      if (!params && input.messageId) params = (await busGet(`feishu:route:${input.messageId}`)) || null;
      if (!params) return;
      const act = String(params.act || '');
      const reply = async (title: string, lines: string[]): Promise<Record<string, unknown>> => {
        const card = buildResultCard(title, lines);
        if (input.messageId) await sendCard(cfg, input.chatId || '', card).catch(() => {});
        return cardResponse(card);
      };
      try {
        if (!cfg.approvers?.length || !cfg.approvers.includes(who)) {
          return reply('无权操作', [`操作人 ${who} 不在审批白名单内。`]);
        }
        if (act === 'oc_reply') {
          // 完成卡上的快速回复：向该会话继续发 prompt——空响应让表单复位，完成推送再回来
          const text = String(input.formValue?.reply || '').trim();
          if (!text) return cardResponse(buildResultCard('内容为空', ['请输入内容后再提交。']));
          const instance = String(params.instance || '');
          const sessionId = String(params.session_id || '');
          const r = await deps.sendPrompt(instance, sessionId, text);
          if (r.ok) await sendText(cfg, input.chatId || '', `已发送到 ${instance}（会话 ${sessionId.slice(0, 12)}），完成后推送结果。`);
          else await sendText(cfg, input.chatId || '', `发送失败：${String(r.error || '未知错误').slice(0, 200)}`);
          return;
        }
        if (act === 'oc_perm') {
          const instance = String(params.instance || '');
          const sessionId = String(params.session_id || '');
          const permissionId = String(params.permission_id || '');
          const response = (params.response === 'always' ? 'always' : params.response === 'reject' ? 'reject' : 'once') as 'once' | 'always' | 'reject';
          const ok = await deps.answerPermission(instance, sessionId, permissionId, response);
          return ok
            ? reply(`✅ 权限已${response === 'reject' ? '拒绝' : '批准'}`, [`${instance} · ${permissionId}`])
            : reply('⏱ 权限已失效', [`${instance} · ${permissionId} 不在等待中。`]);
        }
        if (act === 'oc_question') {
          const instance = String(params.instance || '');
          const requestID = String(params.request_id || '');
          const answer = String(input.formValue?.answer || '').trim();
          if (!answer) return reply('回答为空', ['请输入内容后再提交。']);
          const ok = await deps.answerQuestion(instance, requestID, [[answer]]);
          return ok
            ? reply('✅ 已回答', [answer.slice(0, 100)])
            : reply('⏱ 提问已失效', [`${instance} · ${requestID} 不在等待中。`]);
        }
        return;
      } catch (e) {
        logger.warn('Feishu oc action failed', { error: String(e).slice(0, 200), act });
        return reply('⚠ 处理失败', [String((e as Error).message || e).slice(0, 200)]);
      }
    },

    start(cfg) {
      cfgRef = cfg;
      const watch = cfg.oc_watch || 'all';
      const logger2 = logger;

      const notifyTarget = async (): Promise<{ id: string; type: 'chat_id' | 'open_id' } | null> => notifyChat(cfg0());

      const watchInstance = (instanceId: string): boolean => {
        if (watch === 'all') return true;
        if (watch === 'managed') return deps.instanceKind(instanceId) === 'managed';
        return true; // 'bound' 的精确过滤在事件侧按绑定判断（简化：bound 也全推）
      };

      // 完成通知：session.idle / session.error（事件驱动）
      const unsub = getBus().subscribe(CHANNELS.DASHBOARD, (envelope: unknown) => {
        const env = envelope as { type?: string; payload?: { instance?: string; event?: Record<string, any> } } | null;
        if (env?.type !== 'oc_event') return;
        const instance = String(env.payload?.instance || '');
        const event = env.payload?.event || {};
        if (!watchInstance(instance)) return;
        if (event.type !== 'session.idle' && event.type !== 'session.error') return;
        void (async () => {
          const sid = deps.eventSessionId(event);
          if (!sid) return;
          const dedup = `feishu:oc:idle:${instance}:${sid}:${event.id || ''}`;
          if (await busGet(dedup)) return;
          await busSet(dedup, 1, 20);
          const target = await notifyTarget();
          if (!target) return;
          const failed = event.type === 'session.error';
          const replyText = (await deps.readLastReply(instance, sid).catch(() => null)) || '';
          const body = replyText
            ? replyText.length > 2400 ? `${replyText.slice(0, 2400)}\n\n…（截断，完整内容回面板）` : replyText
            : `会话 ${sid.slice(0, 12)} ${failed ? '执行出错' : '执行完成'}（无文本输出）`;
          // 完成卡带输入框：回复此卡 = 向该会话继续发 prompt（不受当前模式影响）
          const card = card2(failed ? 'red' : 'green', `🖥 OpenCode · ${instance} · ${failed ? '出错' : '已完成'}`, [
            md(`会话 ${sid.slice(0, 12)}\n${body}`),
            form(`ocr_${instance}_${sid}_${Date.now()}`, [inputField('reply', '继续此会话…'), submitBtn('发送', 'go')]),
            note(`Co-Team · OpenCode 完成${deps.instanceKind(instance) === 'attached-desktop' ? '（桌面实例）' : ''} · 引用回复本卡亦可 · ${new Date().toLocaleString()}`),
          ]);
          const messageId = await sendCard(cfg, target.id, card, target.type);
          if (messageId) {
            await busSet(`feishu:route:${messageId}`, { act: 'oc_reply', instance, session_id: sid }, BIND_TTL_SEC);
            await busSet(`feishu:reply:${messageId}`, { kind: 'oc', instance, session_id: sid }, BIND_TTL_SEC);
          }
        })().catch((e) => logger2.warn('Feishu oc completion push failed', { error: String(e).slice(0, 200), instance }));
      });

      // 权限/提问：30s 扫描跨实例 pending 聚合（对齐 clarifyTimeout 扫描器模式）
      const timer = setInterval(() => {
        void this.scanPendingOnce(cfg).catch((e) => logger2.warn('Feishu oc pending scan failed', { error: String(e).slice(0, 200) }));
      }, 30_000);

      return () => {
        unsub();
        clearInterval(timer);
      };
    },

    async scanPendingOnce(cfg) {
      cfgRef = cfg;
      const pending = deps.pendingAll();
      const target = await notifyChat(cfg0());
      if (!target) return;
      for (const p of pending.permissions || []) {
        const pid = String(p.permissionID || p.id || '');
        const instance = String(p.instance || '');
        const sid = String(p.sessionID || p.session_id || p.sessionId || '');
        if (!pid || !instance || !sid) continue;
        const seenKey = `feishu:oc:permseen:${pid}`;
        if (await busGet(seenKey)) continue;
        await busSet(seenKey, 1, 3600);
        const title = String(p.title || p.type || '权限请求');
        await sendCard(cfg, target.id, card2('orange', `⛔ OpenCode 权限待确认 · ${instance}`, [
          md(`**会话** ${sid.slice(0, 12)}\n**请求** ${title.slice(0, 300)}`),
          btnRow(
            { tag: 'button', text: { tag: 'plain_text', content: '批准一次' }, type: 'primary', size: 'medium', behaviors: [{ type: 'callback', value: { act: 'oc_perm', instance, session_id: sid, permission_id: pid, response: 'once' } }] },
            { tag: 'button', text: { tag: 'plain_text', content: '总是批准' }, type: 'default', size: 'medium', behaviors: [{ type: 'callback', value: { act: 'oc_perm', instance, session_id: sid, permission_id: pid, response: 'always' } }] },
          ),
          { tag: 'button', text: { tag: 'plain_text', content: '✖ 拒绝' }, type: 'danger', size: 'medium', behaviors: [{ type: 'callback', value: { act: 'oc_perm', instance, session_id: sid, permission_id: pid, response: 'reject' } }] },
          note(`Co-Team · OpenCode 权限 · ${new Date().toLocaleString()}`),
        ]), target.type);
      }
      for (const q of pending.questions || []) {
        const qid = String(q.requestID || q.id || '');
        const instance = String(q.instance || '');
        if (!qid || !instance) continue;
        const seenKey = `feishu:oc:qseen:${qid}`;
        if (await busGet(seenKey)) continue;
        await busSet(seenKey, 1, 3600);
        const question = String(q.question || q.title || JSON.stringify(q).slice(0, 300));
        const card = card2('orange', `❓ OpenCode 提问 · ${instance}`, [
          md(question.slice(0, 800)),
          form(`oq_${qid}`, [inputField('answer', '输入你的回答…'), submitBtn('发送', 'go')]),
          note(`Co-Team · OpenCode 提问 · ${new Date().toLocaleString()}`),
        ]);
        const messageId = await sendCard(cfg, target.id, card, target.type);
        if (messageId) await busSet(`feishu:route:${messageId}`, { act: 'oc_question', instance, request_id: qid }, BIND_TTL_SEC);
      }
    },
  };
}
