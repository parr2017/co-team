/**
 * convo 桥（Step 3）：/convo 进入会话模式——自由文本注入协作会话，agent 终稿
 * 以富文本卡推回绑定聊天；会话中的审批/提问升级为决策卡。
 *
 * 绑定：feishu:chat:convo:{convoId} = { chat_id, title }（7 天 TTL）——只有
 * 绑定过的会话才推送；面板创建的会话不推（与任务绑定同策略）。
 * 事件面：convo_message（assistant 终稿）/ convo_approval / convo_ask /
 * convo_turn_end（失败收场提示），全部走 coteam:dashboard 频道。
 */
import { busGet, busSet, getBus } from '../bus';
import { CHANNELS } from '../types';
import { getLogger } from '../logger';
import type { FeishuConfig } from '../config';
import type { FeishuSession } from './session';
import { setSession } from './session';
import { sendCard, sendText } from './messageService';
import { buildResultCard, card2, cardResponse, form, inputField, md, note, submitBtn, btnRow } from './cards';
import type { CardActionInput } from './approvalCards';

export interface ConvoListItem {
  id: string;
  title: string;
  status: string;
  updated_at: string;
}

export interface ConvoBridgeDeps {
  list: () => Promise<ConvoListItem[]>;
  create: (input: { title?: string; project_id?: string }) => Promise<{ id: string; title: string; status: string; updated_at: string }>;
  send: (convoId: string, text: string) => Promise<{ queued: boolean }>;
  stop: (convoId: string) => Promise<void>;
  resolveApproval: (convoId: string, approvalId: string, action: 'once' | 'always' | 'reject') => Promise<unknown>;
  answerAsk: (convoId: string, askId: string, answer: string) => Promise<unknown>;
}

export interface ConvoBridge {
  enter(arg: string, session: FeishuSession, chatId: string): Promise<string>;
  list(session: FeishuSession): Promise<string>;
  create(title: string, session: FeishuSession, chatId: string): Promise<string>;
  switchTo(ref: string, session: FeishuSession, chatId: string): Promise<string>;
  send(text: string, session: FeishuSession, chatId: string): Promise<string>;
  /** 指定会话发言（引用回复路由用，不依赖当前绑定） */
  sendTo(convoId: string, text: string, chatId?: string): Promise<string>;
  stop(session: FeishuSession): Promise<string>;
  handleCardAction(cfg: FeishuConfig, input: CardActionInput): Promise<Record<string, unknown> | void>;
  start(cfg: FeishuConfig): () => void;
  /** 内部：绑定并回列表文本（enter 的无参路径用） */
  bindAndList(convo: { id: string; title: string; status: string; updated_at: string }, convos: ConvoListItem[], session: FeishuSession, chatId: string): Promise<string>;
}

const BIND_TTL_SEC = 7 * 24 * 3600;
const REPLY_MAX = 2800;

async function bindChat(convoId: string, title: string, chatId: string): Promise<void> {
  await busSet(`feishu:chat:convo:${convoId}`, { chat_id: chatId, title }, BIND_TTL_SEC);
}

function renderList(convos: ConvoListItem[], currentId?: string): { text: string; items: { id: string; label: string }[] } {
  const shown = convos.slice(0, 8);
  const items = shown.map((c) => ({ id: c.id, label: `${c.title}（${c.status}）` }));
  const lines = shown.map((c, i) => `${currentId === c.id ? `**${i + 1}. ${c.title}（当前）**` : `${i + 1}. ${c.title}`} · ${c.status}`);
  return { text: lines.join('\n') || '（暂无会话）', items };
}

export function createConvoBridge(deps: ConvoBridgeDeps): ConvoBridge {
  const logger = getLogger();

  const bindAndEnter = async (convo: { id: string; title: string; status: string; updated_at: string }, session: FeishuSession, chatId: string): Promise<string> => {
    session.mode = 'convo';
    session.convo_id = convo.id;
    await bindChat(convo.id, convo.title, chatId);
    await setSession(session);
    return `✅ 已进入会话模式，当前绑定「${convo.title}」。直接发言即与 agent 对话；/list 切换 · /new 新建 · /exit 返回任务模式。`;
  };

  return {
    async enter(arg, session, chatId) {
      const convos = await deps.list();
      if (!arg.trim()) {
        if (convos.length) return this.bindAndList(convos[0], convos, session, chatId);
        const convo = await deps.create({ project_id: session.current_project_id });
        return bindAndEnter(convo, session, chatId);
      }
      const hit = convos.find((c) => c.id === arg || c.title.includes(arg));
      if (hit) return bindAndEnter(hit, session, chatId);
      const convo = await deps.create({ title: arg, project_id: session.current_project_id });
      return bindAndEnter(convo, session, chatId);
    },

    async bindAndList(convo: { id: string; title: string; status: string; updated_at: string }, convos: ConvoListItem[], session: FeishuSession, chatId: string): Promise<string> {
      session.mode = 'convo';
      session.convo_id = convo.id;
      await bindChat(convo.id, convo.title, chatId);
      const { text, items } = renderList(convos, convo.id);
      session.last_list = items;
      session.last_list_kind = 'convo';
      await setSession(session);
      return `✅ 已进入会话模式，当前绑定「${convo.title}」。\n${text}\n/switch 序号切换 · /new 新建 · 直接发言继续对话。`;
    },

    async list(session) {
      const convos = await deps.list();
      const { text, items } = renderList(convos, session.convo_id);
      session.last_list = items;
      session.last_list_kind = 'convo';
      await setSession(session);
      return `协作会话列表：\n${text}\n/switch 序号切换 · /new 新建。`;
    },

    async create(title, session, chatId) {
      const convo = await deps.create({ title: title || undefined, project_id: session.current_project_id });
      return bindAndEnter(convo, session, chatId);
    },

    async switchTo(ref, session, chatId) {
      const convos = await deps.list();
      const n = Number(ref);
      const target = Number.isInteger(n) && session.last_list_kind === 'convo' ? session.last_list?.[n - 1] : undefined;
      const hit = (target && convos.find((c) => c.id === target.id)) || convos.find((c) => c.id === ref || c.title.includes(ref));
      if (!hit) return `未找到会话「${ref}」，/list 查看全部。`;
      const bindMsg = await bindAndEnter(hit, session, chatId);
      const msgs = (await busGet<any[]>(`convo:${hit.id}:messages`)) || [];
      const recent = msgs.filter((m) => m.kind === 'text' && m.text).slice(-4);
      const preview = recent.length
        ? `\n最近对话：\n${recent.map((m) => `${m.role === 'user' ? '用户' : m.role === 'assistant' ? '助手' : '系统'}：${String(m.text).replace(/\s+/g, ' ').slice(0, 120)}`).join('\n')}`
        : '';
      return `${bindMsg}${preview}`;
    },

    async send(text, session, chatId) {
      let convoId = session.convo_id;
      if (!convoId) {
        const convo = await deps.create({ title: text.slice(0, 24), project_id: session.current_project_id });
        convoId = convo.id;
        session.mode = 'convo';
        session.convo_id = convoId;
        await setSession(session);
      }
      return this.sendTo(convoId!, text, chatId);
    },

    async sendTo(convoId, text, chatId) {
      await bindChat(convoId, '', chatId || '');
      const r = await deps.send(convoId, text);
      return r.queued ? '已排队：当前回复进行中，这条消息会在本轮结束后处理。' : '已发送，回复完成后推送。';
    },

    async stop(session) {
      if (!session.convo_id) return '当前未绑定会话。';
      await deps.stop(session.convo_id);
      return '✅ 已停止当前回复（排队消息保留）。';
    },

    async handleCardAction(cfg, input) {
      const logger2 = logger;
      const who = input.operatorOpenId || 'unknown';
      let params: Record<string, unknown> | null = input.value && Object.keys(input.value).length ? input.value : null;
      if (!params && input.messageId) params = (await busGet(`feishu:route:${input.messageId}`)) || null;
      if (!params) return;
      const act = String(params.act || '');
      const convoId = String(params.convo_id || '');
      if (act === 'convo_approve') {
        const approvalId = String(params.approval_id || '');
        const action = (params.action === 'always' ? 'always' : params.action === 'reject' ? 'reject' : 'once') as 'once' | 'always' | 'reject';
        const r = await deps.resolveApproval(convoId, approvalId, action);
        const card = buildResultCard(r ? `✅ 已${action === 'once' ? '批准一次' : action === 'always' ? '总是批准' : '拒绝'}` : '⏱ 已处理', [`会话 ${convoId}`]);
        if (input.messageId) await sendCard(cfg, input.chatId || '', card).catch(() => {});
        void logger2;
        return cardResponse(card);
      }
      if (act === 'convo_reply') {
        // 终稿卡上的快速回复：注入会话后 agent 回复会以新卡推送——空响应让表单复位即可
        const text = String(input.formValue?.reply || '').trim();
        if (!text) return cardResponse(buildResultCard('回答为空', ['请输入内容后再提交。']));
        await deps.send(convoId, text);
        await sendText(cfg, input.chatId || '', `🗣 你：${text.slice(0, 200)}`);
        return;
      }
      if (act === 'convo_answer') {
        const askId = String(params.ask_id || '');
        const answer = String(input.formValue?.answer || '').trim();
        if (!answer) return cardResponse(buildResultCard('回答为空', ['请输入内容后再提交。']));
        await deps.answerAsk(convoId, askId, answer);
        return cardResponse(buildResultCard('✅ 已回答', ['agent 将继续执行。']));
      }
      void who;
      return;
    },

    start(cfg) {
      return getBus().subscribe(CHANNELS.DASHBOARD, (envelope: unknown) => {
        const env = envelope as { type?: string; payload?: Record<string, any> } | null;
        const type = env?.type || '';
        const convoId = String(env?.payload?.convo_id || '');
        if (!convoId) return;
        void (async () => {
          const payload = (env?.payload || {}) as Record<string, any>;
          const bound = await busGet<{ chat_id: string; title?: string }>(`feishu:chat:convo:${convoId}`);
          if (!bound?.chat_id) return;
          if (type === 'convo_message') {
            const msg = payload.message as { role?: string; kind?: string; text?: string };
            if (msg?.role !== 'assistant' || msg?.kind !== 'text' || !msg.text) return;
            const title = bound.title || convoId;
            const body = msg.text.length > REPLY_MAX ? `${msg.text.slice(0, REPLY_MAX)}\n\n…（截断，完整内容回面板）` : msg.text;
            // 终稿卡带输入框：回复此卡 = 向该会话发言（不受当前模式影响）
            const card = card2('blue', `💬 ${title}`, [
              md(body),
              form(`cr_${convoId}_${Date.now()}`, [inputField('reply', '回复此会话…'), submitBtn('发送', 'go')]),
              note(`Co-Team · 会话回复 · 引用回复本卡亦可 · ${new Date().toLocaleString()}`),
            ]);
            const messageId = await sendCard(cfg, bound.chat_id, card);
            if (messageId) {
              await busSet(`feishu:route:${messageId}`, { act: 'convo_reply', convo_id: convoId }, ROUTE_TTL);
              await busSet(`feishu:reply:${messageId}`, { kind: 'convo', convo_id: convoId }, ROUTE_TTL);
            }
          } else if (type === 'convo_approval') {
            const approval = env!.payload!.approval as { id: string; command: string; reason?: string; status?: string };
            if (!approval?.id || approval.status !== 'pending') return;
            const card = card2('orange', '⛔ 会话命令待审批', [
              md(`**会话** ${bound.title || convoId}\n**命令** \`${String(approval.command).slice(0, 200)}\`${approval.reason ? `\n**原因** ${approval.reason}` : ''}`),
              btnRow(
                { tag: 'button', text: { tag: 'plain_text', content: '批准一次' }, type: 'primary', size: 'medium', behaviors: [{ type: 'callback', value: { act: 'convo_approve', convo_id: convoId, approval_id: approval.id, action: 'once' } }] },
                { tag: 'button', text: { tag: 'plain_text', content: '总是批准' }, type: 'default', size: 'medium', behaviors: [{ type: 'callback', value: { act: 'convo_approve', convo_id: convoId, approval_id: approval.id, action: 'always' } }] },
              ),
              { tag: 'button', text: { tag: 'plain_text', content: '✖ 拒绝' }, type: 'danger', size: 'medium', behaviors: [{ type: 'callback', value: { act: 'convo_approve', convo_id: convoId, approval_id: approval.id, action: 'reject' } }] },
              note(`Co-Team · 会话审批 · ${new Date().toLocaleString()}`),
            ]);
            const messageId = await sendCard(cfg, bound.chat_id, card);
            if (messageId) await busSet(`feishu:route:${messageId}`, { act: 'convo_approve', convo_id: convoId, approval_id: approval.id }, ROUTE_TTL);
          } else if (type === 'convo_ask') {
            const ask = env!.payload!.ask as { id: string; question: string; status?: string };
            if (!ask?.id || ask.status !== 'pending') return;
            const card = card2('orange', '❓ 会话提问', [
              md(ask.question.slice(0, 800)),
              form(`ca_${convoId}_${ask.id}`, [inputField('answer', '输入你的回答…'), submitBtn('发送', 'go')]),
              note(`Co-Team · 会话提问 · ${new Date().toLocaleString()}`),
            ]);
            const messageId = await sendCard(cfg, bound.chat_id, card);
            if (messageId) await busSet(`feishu:route:${messageId}`, { act: 'convo_answer', convo_id: convoId, ask_id: ask.id }, ROUTE_TTL);
          } else if (type === 'convo_turn_end' && env!.payload!.status !== 'completed') {
            await sendText(cfg, bound.chat_id, `⚠ 会话一轮异常收场（${String(env!.payload!.error_code || env!.payload!.status)}）：${String(env!.payload!.reason || '').slice(0, 200)}`);
          }
        })().catch((e) => logger.warn('Feishu convo push failed', { error: String(e).slice(0, 200), convoId }));
      });
    },
  };
}

const ROUTE_TTL = 7 * 24 * 3600;
