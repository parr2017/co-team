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
import { getTaskGraph, pushIntervention, appendJournal, emitProgress } from '../store';
import { notify } from '../notify';
import type { FeishuConfig } from '../config';
import { verifySignature } from './tokenManager';
import { getSession, setSession } from './session';
import { handleCommand, type CommandDeps, type ProjectOption } from './commands';
import type { ConvoBridge } from './convoBridge';
import type { OcBridge } from './ocBridge';
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
  /** 可选：/tasks 指令的任务查询（未提供则指令回复未启用） */
  listTasks?: () => Promise<{ id: string; description: string; status: string; project_id: string | null }[]>;
  /** 可选：/queue 指令的队列快照 */
  listQueue?: () => Promise<{ key: string; running_task_id: string | null; pending: unknown[]; blocked: boolean; blocked_reason: string }[]>;
  /** 可选：/status 附带的网关连接状态 */
  gatewayStatus?: () => string;
  /** 可选：/metrics 成本/成功率摘要 [v2] */
  metrics?: () => Promise<string>;
  /** 可选：/task <id> 单任务进度摘要 [v2] */
  taskSummary?: (taskId: string) => Promise<string>;
  /** 可选：convo 桥 [v2] */
  convo?: ConvoBridge;
  /** 可选：oc 桥 [v2] */
  oc?: OcBridge;
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
  const commandDeps: CommandDeps = {
    listProjects: deps.listProjects,
    listAgentNames: deps.listAgentNames,
    ...(deps.listTasks ? { listTasks: deps.listTasks } : {}),
    ...(deps.listQueue ? { listQueue: deps.listQueue } : {}),
    ...(deps.gatewayStatus ? { gatewayStatus: deps.gatewayStatus } : {}),
    ...(deps.metrics ? { metrics: deps.metrics } : {}),
    ...(deps.taskSummary ? { taskSummary: deps.taskSummary } : {}),
    ...(deps.convo ? { convo: deps.convo } : {}),
    ...(deps.oc ? { oc: deps.oc } : {}),
  };

  /** Extract (userId, chatId, text, parentId) from a v2 (or lenient v1) message event. */
  function extractMessage(body: Record<string, any>): { userId: string; chatId: string; text: string; parentId: string } | null {
    const v2 = body?.header?.event_type === 'im.message.receive_v1' ? body?.event : null;
    const legacy = !v2 && (body?.event_type === 'message' || body?.type === 'message') ? body?.event ?? body : null;
    const source = v2 || legacy;
    if (!source?.message) return null;
    const userId = source.sender?.sender_id?.open_id || source.sender?.sender_id?.user_id || source.open_id || '';
    const chatId = source.message.chat_id || '';
    const parentId = String(source.message.parent_id || '');
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
    return { userId, chatId, text, parentId };
  }

  /** 复刻 POST /api/tasks/:taskId/intervene（api/index.ts:560-602）核心副作用（图片富化仅在 API 层）。 */
  async function interveneTask(taskId: string, text: string, by: string): Promise<void> {
    const graph = await getTaskGraph(taskId);
    if (!graph) throw new Error('task not found');
    // failed 任务也放行：retry 提案批准后队列中的消息会被消费注入（对齐 intervene 端点）
    if (!['running', 'pending', 'planned', 'retrying', 'waiting_approval', 'failed'].includes(graph.status)) {
      throw new Error(`任务不可插话（status: ${graph.status}）`);
    }
    const item = await pushIntervention(taskId, text);
    await appendJournal(taskId, 'orchestrator', {
      role: 'master', kind: 'intervene', text, ts: item.ts,
      node_id: 'intervene', node_name: `用户介入(${by})`, meta: { intervention_id: item.id },
    });
    await emitProgress('user_intervened', { task_id: taskId, message: text.slice(0, 500), intervention_id: item.id });
    notify('user_intervened', { task_id: taskId }, `[Co-Team] 用户向任务 ${taskId} 发送介入指示：${text.slice(0, 80)}`);
  }

  async function replyAndBindTask(cfgLocal: FeishuConfig, chatId: string, taskId: string, title: string, status: string, detail: string): Promise<void> {
    const messageId = await sendCard(cfgLocal, chatId, buildTaskCard({ taskId, title, status, detail }));
    if (messageId) {
      await busSet(`feishu:card:${taskId}`, { chat_id: chatId, message_id: messageId }, 7 * 24 * 3600);
      // 反向索引：回复任务卡消息 = 中途插话（processEvent 的 parent_id 路由）
      await busSet(`feishu:cardmsg:${messageId}`, taskId, 7 * 24 * 3600);
    }
  }

  async function processEvent(body: Record<string, any>): Promise<void> {
    const msg = extractMessage(body);
    if (!msg) return;
    // 回复任务卡消息 = 中途插话（intervention）——先于指令处理
    if (msg.parentId) {
      const linked = await busGet<string>(`feishu:cardmsg:${msg.parentId}`);
      if (linked) {
        try {
          await interveneTask(linked, msg.text, msg.userId);
          await sendText(cfg, msg.chatId, '已插话：将在 Agent 下一轮对话注入。');
        } catch (e) {
          await sendText(cfg, msg.chatId, `插话失败：${String((e as Error).message || e).slice(0, 120)}`);
        }
        return;
      }
    }
    try {
      let session = await getSession(msg.userId);
      const cmd = await handleCommand(msg.text, session, commandDeps, msg.chatId);
      session = cmd.session ?? session;
      if (!cmd.passthrough) {
        if (cmd.reply) await sendText(cfg, msg.chatId, cmd.reply);
        return;
      }

      // 自由文本按窗口主题路由（v2）：convo=会话发言 / oc=prompt / task=建任务
      const mode = session.mode || 'task';
      if (mode === 'convo' && commandDeps.convo) {
        await sendText(cfg, msg.chatId, await commandDeps.convo.send(msg.text, session, msg.chatId));
        return;
      }
      if (mode === 'oc' && commandDeps.oc) {
        await sendText(cfg, msg.chatId, await commandDeps.oc.send(msg.text, session, msg.chatId));
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

      // P1.4 入站留存：飞书里说的需求细节/偏好此前只进任务描述字符串，会话上下文完全丢失——
      // 现在环形缓冲留存（最近 50 条），供后续把聊天上下文关联进任务/简报生成
      try {
        const inbox = (await busGet<{ ts: string; user: string; text: string; project_id: string }[]>('feishu:inbound')) || [];
        inbox.push({ ts: new Date().toISOString(), user: msg.userId, text: msg.text.slice(0, 500), project_id: project.id });
        await busSet('feishu:inbound', inbox.slice(-50), 30 * 24 * 3600);
      } catch { /* 留存失败不阻塞任务创建 */ }

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
