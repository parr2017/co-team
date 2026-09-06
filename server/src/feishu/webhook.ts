/**
 * Feishu event webhook (feishu_message_flow.md): the single entry point for
 * inbound Feishu pushes — url_verification handshake, optional AES payload
 * decryption, signature check, event dedup, fast 200 + async processing.
 *
 * Free text from a user with a selected project becomes a task in that
 * project; the reply card is bound to the task id and updated in place on
 * lifecycle milestones (via the notify event bus).
 */
import { createDecipheriv } from 'node:crypto';
import type { Context } from 'hono';
import { busGet, busSet, getBus } from '../bus';
import { CHANNELS } from '../types';
import { getLogger } from '../logger';
import type { FeishuConfig } from '../config';
import { verifySignature } from './tokenManager';
import { getSession, setSession } from './session';
import { handleCommand, type CommandDeps, type ProjectOption } from './commands';
import { buildTaskCard, sendCard, sendText, updateCard } from './messageService';

const EVENT_DEDUP_TTL_SEC = 300;

export interface FeishuDeps {
  createTask: (description: string, workspace: string, projectId?: string, opts?: { level?: string }) => Promise<{
    taskId: string;
    needsClarification?: boolean;
    questions?: string[];
  }>;
  enqueue: (taskId: string, projectId: string | null, workspace: string) => Promise<unknown>;
  listProjects: () => Promise<ProjectOption[]>;
  listAgentNames: () => string[];
}

/** True when this event id was already processed (飞书必然重推，需幂等). */
export async function seenEvent(eventId: string | undefined): Promise<boolean> {
  if (!eventId) return false;
  const key = `feishu:event:${eventId}`;
  if (await busGet(key)) return true;
  await busSet(key, 1, EVENT_DEDUP_TTL_SEC);
  return false;
}

export interface FeishuHandler {
  handle: (c: Context) => Promise<Response>;
  processEvent: (body: Record<string, any>) => Promise<void>;
}

export function createFeishuHandler(cfg: FeishuConfig, deps: FeishuDeps): FeishuHandler {
  const logger = getLogger();
  const commandDeps: CommandDeps = { listProjects: deps.listProjects, listAgentNames: deps.listAgentNames };

  /** Extract (userId, chatId, text) from a v2 (or lenient v1) message event. */
  function extractMessage(body: Record<string, any>): { userId: string; chatId: string; text: string } | null {
    const v2 = body?.header?.event_type === 'im.message.receive_v1' ? body?.event : null;
    const legacy = !v2 && (body?.event_type === 'message' || body?.type === 'message') ? body?.event ?? body : null;
    const source = v2 || legacy;
    if (!source?.message) return null;
    const userId = source.sender?.sender_id?.open_id || source.sender?.sender_id?.user_id || source.open_id || '';
    const chatId = source.message.chat_id || '';
    let text = '';
    try {
      const content = typeof source.message.content === 'string' ? JSON.parse(source.message.content) : source.message.content;
      text = String(content?.text || '').trim();
    } catch {
      text = '';
    }
    // strip @mention placeholders ("@_user_1 do it" → "do it")
    text = text.replace(/^@\S+\s*/, '').trim();
    if (!userId || !chatId || !text) return null;
    return { userId, chatId, text };
  }

  async function replyAndBindTask(cfgLocal: FeishuConfig, chatId: string, taskId: string, title: string, status: string, detail: string): Promise<void> {
    const messageId = await sendCard(cfgLocal, chatId, buildTaskCard({ taskId, title, status, detail }));
    if (messageId) await busSet(`feishu:card:${taskId}`, { chat_id: chatId, message_id: messageId }, 7 * 24 * 3600);
  }

  async function processEvent(body: Record<string, any>): Promise<void> {
    const msg = extractMessage(body);
    if (!msg) return;
    try {
      let session = await getSession(msg.userId);
      const cmd = await handleCommand(msg.text, session, commandDeps);
      session = cmd.session ?? session;
      if (!cmd.passthrough) {
        if (cmd.reply) await sendText(cfg, msg.chatId, cmd.reply);
        return;
      }

      // free text → task in the session's project
      if (!session.current_project_id) {
        await sendText(cfg, msg.chatId, '请先使用 /project <名称或ID> 选择项目（/list project 查看全部），之后直接发消息即可发起任务。');
        return;
      }
      const project = (await deps.listProjects()).find((p) => p.id === session.current_project_id);
      if (!project) {
        await sendText(cfg, msg.chatId, '当前项目不存在或已删除，请重新 /project 选择。');
        return;
      }

      const { taskId, needsClarification, questions } = await deps.createTask(msg.text, project.workspace, project.id, { level: 'standard' });
      if (needsClarification) {
        await sendText(cfg, msg.chatId, `任务 ${taskId} 需要澄清：\n${(questions || []).map((q, i) => `${i + 1}. ${q}`).join('\n')}\n\n请在 Dashboard 的澄清面板回复。`);
        return;
      }
      await deps.enqueue(taskId, project.id, project.workspace);
      await replyAndBindTask(cfg, msg.chatId, taskId, msg.text.slice(0, 24) || '任务', '已排队', `工作区：${project.workspace}\nAgent 分工与执行进度将在此卡片更新。`);
      await setSession(session);
    } catch (e) {
      logger.warn('Feishu event processing failed', { error: String(e).slice(0, 300) });
      await sendText(cfg, msg.chatId, `处理失败：${String((e as Error).message || e).slice(0, 200)}`).catch(() => {});
    }
  }

  async function handle(c: Context): Promise<Response> {
    const raw = await c.req.text();
    let body: Record<string, any>;
    try {
      body = JSON.parse(raw || '{}');
    } catch {
      return c.json({ code: 400, msg: 'invalid json' }, 400);
    }

    // encrypted mode: decrypt before anything else
    if (cfg.encrypt_key && typeof body.encrypt === 'string') {
      try {
        const key = Buffer.from(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(cfg.encrypt_key)));
        const data = Buffer.from(body.encrypt, 'base64');
        const decipher = createDecipheriv('aes-256-cbc', key, data.subarray(0, 16));
        body = JSON.parse(Buffer.concat([decipher.update(data.subarray(16)), decipher.final()]).toString('utf-8'));
      } catch (e) {
        logger.warn('Feishu payload decryption failed', { error: String(e).slice(0, 200) });
        return c.json({ code: 400, msg: 'decrypt failed' }, 400);
      }
    }

    // url_verification handshake (feishu_api_research.md §3.2)
    if (body?.type === 'url_verification' && body?.challenge) {
      return c.json({ challenge: String(body.challenge) });
    }

    // signature check: sha256(timestamp + nonce + encrypt_key + body)
    const signature = c.req.header('X-Lark-Signature');
    if (cfg.encrypt_key && signature) {
      const ok = verifySignature({
        timestamp: c.req.header('X-Lark-Request-Timestamp') || '',
        nonce: c.req.header('X-Lark-Request-Nonce') || '',
        encryptKey: cfg.encrypt_key,
        body: raw,
        signature,
      });
      if (!ok) return c.json({ code: 403, msg: 'signature mismatch' }, 403);
    }
    // verification_token fallback when no encrypt_key/signature is in play
    if (!cfg.encrypt_key && cfg.verification_token && body?.token && body.token !== cfg.verification_token) {
      return c.json({ code: 403, msg: 'verification token mismatch' }, 403);
    }

    // dedup before the fast 200 — Feishu retries aggressively
    const eventId = body?.header?.event_id || body?.event_id || c.req.header('X-Lark-Request-Id') || undefined;
    if (await seenEvent(eventId)) return c.json({ code: 0 });

    // fast ack, async processing (design: respond within seconds, work in background)
    void processEvent(body).catch(() => {});
    return c.json({ code: 0 });
  }

  // lifecycle milestones update the bound card in place
  getBus().subscribe(CHANNELS.NOTIFY, (envelope: unknown) => {
    const env = envelope as Record<string, any> | null;
    const payload = env?.payload || {};
    const taskId = String(payload.task_id || '');
    if (!taskId) return;
    void (async () => {
      const bound = await busGet<{ chat_id: string; message_id: string }>(`feishu:card:${taskId}`);
      if (!bound) return;
      const status = String(env?.type || payload.status || 'updated');
      await updateCard(cfg, bound.message_id, buildTaskCard({
        taskId,
        title: String(payload.description || taskId).slice(0, 24),
        status,
        detail: String(payload.message || payload.error || ''),
      }));
    })().catch(() => {});
  });

  return { handle, processEvent };
}
