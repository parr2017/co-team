/**
 * 审批交互卡片（飞书新版 JSON 2.0）：把任务停靠在人工门的推送从纯文本升级为
 * 可点击卡片，飞书群里直接批准/取消，无需回到面板。
 *
 * - 渲染侧：订阅 TASK 事件频道，node_waiting_approval / command_pending_approval /
 *   queue_human_gate 三类停靠事件各渲染一张卡片（带按钮的 2.0 卡片只有应用机器人
 *   才能收回调；按钮必须走 behaviors.callback，旧版卡片回传在长连接下收不到）
 * - 回调侧：card.action.trigger → 白名单校验 → 复刻审批端点副作用（Redis 名单 +
 *   enqueue / cancel 标志 + abort + removePending / resolvePendingCommand）→
 *   卡片原地更新 + journal 审计（谁、何时、批了什么）
 * - 安全：approvers 白名单未配置时卡片不渲染按钮；回调侧二次校验（防御深度）
 * - 回调 3 秒内返回：处理只做 Redis 写与入队，绝不等节点续跑结果，卡片靠
 *   updateCard 异步跟进
 */
import { busGet, busSet, getBus } from '../bus';
import { CHANNELS } from '../types';
import { getLogger } from '../logger';
import { appendJournal } from '../store';
import type { FeishuConfig } from '../config';
import type { TaskGraph } from '../types';
import { sendCard, updateCard } from './messageService';

/** 与 HTTP 审批端点同源的动作原语（由 api 挂载处从 ctx 注入）。 */
export interface ApprovalActionDeps {
  getTaskGraph: (taskId: string) => Promise<TaskGraph | null>;
  /** POST /api/tasks/:taskId/approve/:nodeId 与 /cancel 里的 taskQueue.enqueue */
  enqueue: (taskId: string, projectId: string | null, workspace: string) => Promise<unknown>;
  /** POST /api/tasks/:taskId/cancel 里的 orchestrator.abortTask */
  abortTask: (taskId: string) => void;
  /** POST /api/tasks/:taskId/cancel 里的 taskQueue.removePending */
  removePending: (taskId: string) => Promise<void>;
  /** POST /api/tasks/:taskId/commands/:commandId/approve 里的 orchestrator.resolvePendingCommand */
  resolvePendingCommand: (taskId: string, commandId: string, approved: boolean) => Promise<unknown>;
}

/** card.action.trigger 拍平后的关键字段（由 wsGateway 归一传入）。 */
export interface CardActionInput {
  operatorOpenId: string;
  messageId?: string;
  chatId?: string;
  value: Record<string, unknown> | undefined;
}

// ---------- 卡片 JSON 2.0 构造 ----------

const APPROVAL_EVENT_TTL_SEC = 3600;

function card2(template: string, title: string, elements: Record<string, unknown>[]): Record<string, unknown> {
  return {
    schema: '2.0',
    config: { update_multi: true },
    header: { title: { tag: 'plain_text', content: title }, template },
    body: { elements },
  };
}

function md(content: string): Record<string, unknown> {
  return { tag: 'markdown', content };
}

/**
 * 落款/提示行。注意：2.0 卡片不支持 1.0 的 `note` 标签（实测 230099 unsupported tag note），
 * 用 markdown 元素替代。
 */
function note(content: string): Record<string, unknown> {
  return md(content);
}

function btn(text: string, type: 'primary' | 'default' | 'danger', value: Record<string, unknown>): Record<string, unknown> {
  return {
    tag: 'button',
    text: { tag: 'plain_text', content: text },
    type,
    size: 'medium',
    behaviors: [{ type: 'callback', value }],
  };
}

function btnRow(left: Record<string, unknown>, right: Record<string, unknown>): Record<string, unknown> {
  return {
    tag: 'column_set',
    flex_mode: 'bisect',
    columns: [
      { tag: 'column', width: 'weighted', weight: 1, elements: [left] },
      { tag: 'column', width: 'weighted', weight: 1, elements: [right] },
    ],
  };
}

function actionButtons(deps: { taskId: string; nodeId?: string; commandId?: string }, act: 'node' | 'command'): Record<string, unknown>[] {
  const base = { task_id: deps.taskId };
  if (act === 'node') {
    return [
      btnRow(
        btn('✅ 批准', 'primary', { ...base, node_id: deps.nodeId, act: 'approve_node' }),
        btn('✖ 取消任务', 'danger', { ...base, act: 'cancel_task' }),
      ),
    ];
  }
  return [
    btnRow(
      btn('✅ 批准执行', 'primary', { ...base, command_id: deps.commandId, act: 'approve_command' }),
      btn('✖ 拒绝', 'danger', { ...base, command_id: deps.commandId, act: 'reject_command' }),
    ),
  ];
}

const NO_APPROVERS_NOTE = '未配置审批白名单（config.feishu.approvers），暂不可卡片审批——请在面板操作';

/** 节点审批卡：waiting_approval 停靠（含自修改门禁）。 */
export function buildNodeApprovalCard(payload: { taskId: string; nodeId: string; name?: string; reason?: string; approvers: boolean }): Record<string, unknown> {
  const title = `⛔ 节点等待审批：${payload.name || payload.nodeId}`;
  const elements: Record<string, unknown>[] = [
    md(`**任务** ${payload.taskId}\n**节点** ${payload.nodeId}${payload.reason ? `\n**原因** ${payload.reason}` : ''}`),
  ];
  if (payload.approvers) elements.push(...actionButtons({ taskId: payload.taskId, nodeId: payload.nodeId }, 'node'));
  else elements.push(note(NO_APPROVERS_NOTE));
  elements.push(note(`Co-Team · 节点审批 · ${new Date().toLocaleString()}`));
  return card2('orange', title, elements);
}

/** 命令审批卡：approve_required 策略停靠（每条命令一组批准/拒绝）。 */
export async function buildCommandApprovalCard(taskId: string, approvers: boolean, max = 5): Promise<Record<string, unknown> | null> {
  const queue = (await busGet<{ id: string; node_name: string; command: string; ts: string }[]>(`task:pending_commands:${taskId}`)) || [];
  if (!queue.length) return null;
  const shown = queue.slice(0, max);
  const elements: Record<string, unknown>[] = [md(`**任务** ${taskId}\n**待审命令** ${queue.length} 条`)];
  for (const item of shown) {
    elements.push(md(`\`${item.command.slice(0, 160)}\`\n节点：${item.node_name}`));
    if (approvers) elements.push(...actionButtons({ taskId, commandId: item.id }, 'command'));
  }
  if (queue.length > shown.length) elements.push(note(`其余 ${queue.length - shown.length} 条命令请在面板处理`));
  if (!approvers) elements.push(note(NO_APPROVERS_NOTE));
  elements.push(note(`Co-Team · 命令审批 · ${new Date().toLocaleString()}`));
  return card2('orange', '⛔ 命令等待审批', elements);
}

/** 人工门提示卡（车道阻塞/环境修复类）：信息 + 取消任务按钮。 */
export function buildQueueGateCard(payload: { taskId: string; message?: string; approvers: boolean }): Record<string, unknown> {
  const elements: Record<string, unknown>[] = [
    md(`**任务** ${payload.taskId}${payload.message ? `\n${payload.message}` : ''}`),
  ];
  if (payload.approvers) elements.push(btn('✖ 取消任务', 'danger', { task_id: payload.taskId, act: 'cancel_task' }));
  else elements.push(note(NO_APPROVERS_NOTE));
  elements.push(note(`Co-Team · 人工门 · ${new Date().toLocaleString()}`));
  return card2('red', '⛔ 任务停靠人工门', elements);
}

/** 处理结果卡（原地替换审批卡）。 */
function buildResultCard(title: string, lines: string[]): Record<string, unknown> {
  return card2(
    title.includes('拒绝') || title.includes('取消') ? 'red' : 'green',
    title,
    [...lines.map((l) => md(l)), note(`Co-Team · ${new Date().toLocaleString()}`)],
  );
}

// ---------- 渲染侧：TASK 频道订阅 ----------

export function startApprovalCards(cfg: FeishuConfig, deps: ApprovalActionDeps): () => void {
  const logger = getLogger();
  const canApprove = !!cfg.approvers?.length;
  if (!canApprove) logger.warn('Feishu approval cards: no approvers whitelist configured — cards render without buttons', {});

  // 同一停靠位一小时内只发一张卡（调度器每轮循环可能重复广播 node_waiting_approval）
  const seen = async (key: string): Promise<boolean> => {
    const k = `feishu:approval_card:${key}`;
    if (await busGet(k)) return true;
    await busSet(k, 1, APPROVAL_EVENT_TTL_SEC);
    return false;
  };

  return getBus().subscribe(CHANNELS.TASK, (envelope: unknown) => {
    const env = envelope as { type?: string; payload?: Record<string, unknown> } | null;
    const type = env?.type || '';
    const payload = env?.payload || {};
    void (async () => {
      const taskId = String(payload.task_id || '');
      if (!taskId) return;
      const chatId = await resolveTaskChat(taskId);
      if (!chatId) return; // 面板创建的任务没有飞书会话绑定，不推卡
      if (type === 'node_waiting_approval') {
        const nodeId = String(payload.node_id || '');
        if (!nodeId || (await seen(`${taskId}:${nodeId}`))) return;
        const card = buildNodeApprovalCard({ taskId, nodeId, name: payload.name ? String(payload.name) : undefined, reason: payload.reason ? String(payload.reason) : undefined, approvers: canApprove });
        await sendCard(cfg, chatId, card);
      } else if (type === 'command_pending_approval') {
        if (await seen(`${taskId}:commands`)) return;
        const card = await buildCommandApprovalCard(taskId, canApprove);
        if (card) await sendCard(cfg, chatId, card);
      } else if (type === 'queue_human_gate') {
        if (await seen(`${taskId}:gate`)) return;
        const card = buildQueueGateCard({ taskId, message: payload.message ? String(payload.message) : undefined, approvers: canApprove });
        await sendCard(cfg, chatId, card);
      }
    })().catch((e) => logger.warn('Feishu approval card render failed', { error: String(e).slice(0, 300) }));
  });
}

/**
 * 审批卡发到哪个会话：取任务绑定的飞书会话（@机器人建任务时 replyAndBindTask
 * 写入 bus 的 feishu:card:${taskId}），没有绑定（面板建的任务）则不推送。
 */
async function resolveTaskChat(taskId: string): Promise<string | null> {
  const bound = await busGet<{ chat_id: string; message_id: string }>(`feishu:card:${taskId}`);
  return bound?.chat_id || null;
}

// ---------- 回调侧：card.action.trigger ----------

/**
 * 处理卡片按钮点击，返回要随响应帧带回的结果卡片。
 * 必须返回卡片本体：空响应会让飞书把卡片回滚到点击前状态（实测），把
 * updateCard 的结果覆盖掉——"已批准"状态会丢失。
 */
export async function handleCardAction(cfg: FeishuConfig, deps: ApprovalActionDeps, input: CardActionInput): Promise<Record<string, unknown> | void> {
  const logger = getLogger();
  const value = input.value || {};
  const act = String(value.act || '');
  const taskId = String(value.task_id || '');
  const who = input.operatorOpenId || 'unknown';

  const reply = async (title: string, lines: string[]): Promise<Record<string, unknown>> => {
    const card = buildResultCard(title, lines);
    if (input.messageId) await updateCard(cfg, input.messageId, card).catch(() => false);
    // 卡片回调响应体必须包装为 { card: { type: 'raw', data: <卡片JSON> } }——
    // 裸卡片 JSON 会被飞书当成空响应，卡片回滚到点击前状态（实测），updateCard 的结果被覆盖
    return { card: { type: 'raw', data: card } };
  };

  try {
    if (!taskId || !act) {
      return reply('无效操作', ['卡片参数缺失，请在面板操作。']);
    }

    // 白名单二次校验：卡片没配按钮时本就不会有点击；配了也要拦名单外的人
    if (!cfg.approvers?.length || !cfg.approvers.includes(who)) {
      logger.warn('Feishu card action rejected by approver whitelist', { who, act, taskId });
      return reply('无权操作', [`操作人 ${who} 不在审批白名单（config.feishu.approvers）内。`]);
    }

    if (act === 'approve_node') {
      const nodeId = String(value.node_id || '');
      const graph = await deps.getTaskGraph(taskId);
      const nodeName = graph?.nodes.find((n) => n.id === nodeId)?.name || nodeId;
      await appendJournal(taskId, 'orchestrator', {
        role: 'master', kind: 'brief',
        text: `[飞书审批] ${who} 批准节点「${nodeName}」，任务重新入队`,
        ts: new Date().toISOString(), node_id: nodeId, node_name: nodeName,
      });
      // 与 POST /api/tasks/:taskId/approve/:nodeId 同副作用
      const approvals = (await busGet<string[]>(`task:approvals:${taskId}`)) || [];
      if (!approvals.includes(nodeId)) approvals.push(nodeId);
      await busSet(`task:approvals:${taskId}`, approvals);
      const ws = graph?.workspace || '';
      await deps.enqueue(taskId, graph?.project_id ?? null, ws);
      return reply(`✅ 已批准：${nodeName}`, [`任务 ${taskId} 已重新入队续跑。`, `操作人 ${who}`]);
    } else if (act === 'cancel_task') {
      const graph = await deps.getTaskGraph(taskId);
      if (!graph) {
        return reply('任务不存在', [`任务 ${taskId} 不存在或已清理。`]);
      }
      await appendJournal(taskId, 'orchestrator', {
        role: 'master', kind: 'brief',
        text: `[飞书审批] ${who} 取消任务`,
        ts: new Date().toISOString(), node_id: '', node_name: '',
      });
      // 与 POST /api/tasks/:taskId/cancel 同副作用
      await busSet(`task:cancel:${taskId}`, true);
      deps.abortTask(taskId);
      await deps.removePending(taskId);
      return reply('✖ 已取消任务', [`任务 ${taskId} 已取消。`, `操作人 ${who}`]);
    } else if (act === 'approve_command' || act === 'reject_command') {
      const commandId = String(value.command_id || '');
      const approved = act === 'approve_command';
      await appendJournal(taskId, 'orchestrator', {
        role: 'master', kind: 'brief',
        text: `[飞书审批] ${who} ${approved ? '批准' : '拒绝'}命令 ${commandId}`,
        ts: new Date().toISOString(), node_id: '', node_name: '',
      });
      await deps.resolvePendingCommand(taskId, commandId, approved);
      return reply(approved ? '✅ 已批准执行' : '✖ 已拒绝', [`任务 ${taskId} · 命令 ${commandId}`, `操作人 ${who}`]);
    } else {
      return reply('未知操作', [`act=${act}`]);
    }
  } catch (e) {
    logger.warn('Feishu card action failed', { error: String(e).slice(0, 300), act, taskId });
    return reply('⚠ 处理失败', [String((e as Error).message || e).slice(0, 200), '命令可能已被处理，请在面板确认。']).catch(() => undefined);
  }
}
