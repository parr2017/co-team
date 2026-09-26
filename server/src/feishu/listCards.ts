/**
 * 交互列表卡（统一构建 + 无状态翻页）：
 * 页大小 6；页码放在按钮 value 里，点击时重新拉取数据渲染该页并以 cardResponse
 * 原地替换整卡——不发新消息、无服务端分页状态、可连续翻。
 *
 * handleListAction 统一处理八类列表动作：
 * tasks_page / convo_list_page / oc_sessions_page / oc_models_page /
 * oc_agents_page / inbox_page / inbox_open / task_detail
 */
import { busGet, busSet } from '../bus';
import { getTaskGraph, getTaskJournals } from '../store';
import type { FeishuConfig } from '../config';
import { sendCard } from './messageService';
import { buildResultCard, card2, cardResponse, md, note, btnRow, type CardElement } from './cards';
import type { CardActionInput } from './approvalCards';

const PAGE_SIZE = 6;
const ROUTE_TTL_SEC = 7 * 24 * 3600;

const STATUS_ICON: Record<string, string> = {
  completed: '✅', success: '✅', completed_with_warnings: '⚠️', running: '🔄', retrying: '🔄',
  failed: '🔴', cancelled: '⚪', clarifying: '❔', planned: '📐', waiting_approval: '⏸',
  waiting_clarify: '⏸', waiting_ask: '⏸', pending: '·', queued: '·', idle: '·',
};
const statusIcon = (s: string) => STATUS_ICON[s] || '·';
const statusColor = (s: string) => (s === 'success' || s === 'completed' ? 'green' : s === 'failed' ? 'red' : s.startsWith('waiting') ? 'orange' : 'blue');

function totalPages(n: number): number {
  return Math.max(1, Math.ceil(n / PAGE_SIZE));
}
function clampPage(page: number, n: number): number {
  return Math.min(Math.max(0, page), totalPages(n) - 1);
}
function pageSlice<T>(items: T[], page: number): T[] {
  return items.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
}

/** 翻页导航行：首页无 ◀、末页无 ▶（仅一页时整行省略）。 */
function navRow(act: string, page: number, pages: number): CardElement {
  const btn = (text: string, target: number): CardElement => ({
    tag: 'button', text: { tag: 'plain_text', content: text }, type: 'default', size: 'small',
    behaviors: [{ type: 'callback', value: { act, page: target } }],
  });
  const blank: CardElement = { tag: 'markdown', content: ' ' };
  return {
    tag: 'column_set', flex_mode: 'trisect',
    columns: [
      { tag: 'column', width: 'weighted', weight: 1, elements: [page > 0 ? btn('◀ 上一页', page - 1) : blank] },
      { tag: 'column', width: 'weighted', weight: 1, elements: [{ tag: 'markdown', content: `**第 ${page + 1}/${pages} 页**` }] },
      { tag: 'column', width: 'weighted', weight: 1, elements: [page < pages - 1 ? btn('下一页 ▶', page + 1) : blank] },
    ],
  };
}

function actionBtn(text: string, value: Record<string, unknown>, type: 'primary' | 'default' | 'danger' = 'default'): CardElement {
  return { tag: 'button', text: { tag: 'plain_text', content: text }, type, size: 'small', behaviors: [{ type: 'callback', value }] };
}

// ---------- 构建器 ----------

export interface TaskListEntry { id: string; description?: string; status: string; project_id?: string | null }

export function buildTaskListCard(tasks: TaskListEntry[], page = 0, scopeHint?: string): Record<string, unknown> {
  const pages = totalPages(tasks.length);
  const p = clampPage(page, tasks.length);
  const elements: CardElement[] = [];
  if (scopeHint) elements.push(md(scopeHint));
  const shown = pageSlice(tasks, p);
  if (!shown.length) elements.push(md('当前项目暂无任务——直接发文本即可发起任务。'));
  for (const t of shown) {
    elements.push(md(`${statusIcon(t.status)} **${t.id}** · ${t.status} · ${(t.description || '').replace(/\s+/g, ' ').slice(0, 36)}`));
    elements.push(actionBtn(`📄 ${t.id} 详情`, { act: 'task_detail', task_id: t.id }));
  }
  if (pages > 1) elements.push(navRow('tasks_page', p, pages));
  elements.push(note(`Co-Team · 任务列表 · /panel 返回面板 · ${new Date().toLocaleString()}`));
  return card2('blue', '📋 最近任务', elements);
}

export function buildTaskDetailCard(graph: { task_id: string; status: string; description?: string; nodes: { id: string; name: string; status: string }[]; workspace?: string }, journals?: { node_name?: string; text?: string }[]): Record<string, unknown> {
  const elements: CardElement[] = [md(`**${graph.status}** · ${(graph.description || '').replace(/\s+/g, ' ').slice(0, 60)}`)];
  for (const n of graph.nodes.slice(0, 10)) elements.push(md(`${statusIcon(n.status)} ${n.name} · ${n.status}`));
  if (journals?.length) {
    elements.push(md('**—— 最近动态 ——**'));
    for (const j of journals) elements.push(md(`· [${j.node_name || '系统'}] ${String(j.text || '').replace(/\s+/g, ' ').slice(0, 80)}`));
  }
  if (['running', 'retrying', 'pending', 'planned'].includes(graph.status)) {
    elements.push({ tag: 'button', text: { tag: 'plain_text', content: '✖ 取消任务' }, type: 'danger', size: 'medium', behaviors: [{ type: 'callback', value: { act: 'cancel_task', task_id: graph.task_id } }] });
  }
  elements.push(note(`Co-Team · 任务详情 · ${graph.workspace || ''} · ${new Date().toLocaleString()}`));
  return card2(statusColor(graph.status), `📄 任务 ${graph.task_id}`, elements);
}

export function buildConvoListCard(convos: { id: string; title: string; status: string }[], page = 0, currentId?: string): Record<string, unknown> {
  const pages = totalPages(convos.length);
  const p = clampPage(page, convos.length);
  const elements: CardElement[] = [];
  const shown = pageSlice(convos, p);
  if (!shown.length) elements.push(md('（暂无会话）'));
  for (const c of shown) {
    const current = c.id === currentId;
    elements.push(md(`${current ? `**${c.title}（当前）**` : `**${c.title}**`} · ${c.status}`));
    elements.push(actionBtn(current ? '📍 当前会话' : `💬 切换到「${c.title.slice(0, 10)}」`, { act: 'convo_pick', convo_id: c.id }, current ? 'default' : 'primary'));
  }
  if (pages > 1) elements.push(navRow('convo_list_page', p, pages));
  elements.push(note(`Co-Team · 会话列表 · 点按钮切换 · ${new Date().toLocaleString()}`));
  return card2('blue', '💬 协作会话', elements);
}

export function buildOcSessionsCard(instance: string, sessions: { id: string; title?: string }[], page = 0, currentId?: string): Record<string, unknown> {
  const pages = totalPages(sessions.length);
  const p = clampPage(page, sessions.length);
  const elements: CardElement[] = [md(`实例 ${instance}`)];
  const shown = pageSlice(sessions, p);
  if (!shown.length) elements.push(md('（无会话）'));
  for (const s of shown) {
    const current = s.id === currentId;
    elements.push(md(`${current ? `**${s.title || s.id}（当前）**` : `**${s.title || s.id}**`}`));
    elements.push(actionBtn(current ? '📍 当前会话' : '💬 切换到此会话', { act: 'oc_pick_session', instance, session_id: s.id }, current ? 'default' : 'primary'));
  }
  if (pages > 1) elements.push(navRow('oc_sessions_page', p, pages));
  elements.push(note(`Co-Team · OpenCode 会话 · ${new Date().toLocaleString()}`));
  return card2('blue', `🖥 OpenCode 会话 · ${instance}`, elements);
}

export function buildOcModelsCard(models: { id: string; label: string; is_default?: boolean }[], page = 0): Record<string, unknown> {
  const pages = totalPages(models.length);
  const p = clampPage(page, models.length);
  const elements: CardElement[] = [];
  const shown = pageSlice(models, p);
  if (!shown.length) elements.push(md('（实例未提供模型列表）'));
  for (const m of shown) {
    elements.push(md(`**${m.label}**${m.is_default ? '（默认）' : ''}`));
    elements.push(actionBtn(`🧠 切换到 ${m.label.slice(0, 12)}`, { act: 'oc_pick_model', model_id: m.id }, 'default'));
  }
  if (pages > 1) elements.push(navRow('oc_models_page', p, pages));
  elements.push(note(`Co-Team · 模型切换 · ${new Date().toLocaleString()}`));
  return card2('blue', '🧠 OpenCode 模型', elements);
}

export function buildOcAgentsCard(agents: { id: string; label: string }[], page = 0): Record<string, unknown> {
  const pages = totalPages(agents.length);
  const p = clampPage(page, agents.length);
  const elements: CardElement[] = [];
  for (const a of pageSlice(agents, p)) {
    elements.push(md(`**${a.label}**`));
    elements.push(actionBtn(`🤖 切换到 ${a.label.slice(0, 12)}`, { act: 'oc_pick_agent', agent: a.id }));
  }
  if (pages > 1) elements.push(navRow('oc_agents_page', p, pages));
  elements.push(note(`Co-Team · Agent 切换 · ${new Date().toLocaleString()}`));
  return card2('blue', '🤖 OpenCode Agent', elements);
}

/** /oc 进入卡：实例按钮 + 绑定实例的会话按钮（当前项打标）。 */
export function buildOcInstancesCard(instances: { id: string; label: string; kind: string; state: string; mode: string }[], boundId: string | undefined, sessions: { id: string; title?: string }[], boundSession: string | undefined): Record<string, unknown> {
  const elements: CardElement[] = [];
  const instBtns = instances.slice(0, 3).map((i) => ({
    tag: 'button', text: { tag: 'plain_text', content: `${boundId === i.id ? '✓ ' : ''}${i.id}` }, type: boundId === i.id ? 'default' as const : 'primary' as const, size: 'medium',
    behaviors: [{ type: 'callback', value: { act: 'oc_pick_instance', instance: i.id } }],
  }));
  if (instBtns.length === 2) elements.push(btnRow(instBtns[0], instBtns[1]));
  else instBtns.forEach((b) => elements.push(b));
  const shown = sessions.slice(0, 6);
  if (shown.length) elements.push(md(`**会话（${boundId || ''}）：**`));
  for (const s of shown) {
    const current = s.id === boundSession;
    elements.push(md(`${current ? `**${s.title || s.id}（当前）**` : `**${s.title || s.id}**`}`));
    elements.push(actionBtn(current ? '📍 当前会话' : '💬 切换到此会话', { act: 'oc_pick_session', instance: boundId || '', session_id: s.id }, current ? 'default' : 'primary'));
  }
  elements.push(note(`Co-Team · OpenCode · 点按钮切换 · 直接输入需求发往当前会话 · ${new Date().toLocaleString()}`));
  return card2('blue', '🖥 OpenCode', elements);
}

/** /convo 进入卡：会话按钮（当前项打标）。 */
export function buildConvoEnterCard(convos: { id: string; title: string; status: string }[], boundId: string | undefined): Record<string, unknown> {
  const elements: CardElement[] = [];
  const shown = convos.slice(0, 6);
  if (!shown.length) elements.push(md('（暂无会话，已为你新建）'));
  for (const c of shown) {
    const current = c.id === boundId;
    elements.push(md(`${current ? `**${c.title}（当前）**` : `**${c.title}**`} · ${c.status}`));
    elements.push(actionBtn(current ? '📍 当前会话' : `💬 切换到「${c.title.slice(0, 10)}」`, { act: 'convo_pick', convo_id: c.id }, current ? 'default' : 'primary'));
  }
  elements.push(note(`Co-Team · 会话列表 · 直接发言发往当前会话 · ${new Date().toLocaleString()}`));
  return card2('blue', '💬 协作会话', elements);
}

export function buildInboxListCard(items: { kind: string; title: string }[], page = 0): Record<string, unknown> {
  const pages = totalPages(items.length);
  const p = clampPage(page, items.length);
  const LABELS: Record<string, string> = {
    node_approval: '节点审批', command_approval: '命令审批', ask_user: '阻塞提问', proposal: '监督提案',
    clarify: '需求澄清', node_clarify: '开工确认', convo_approval: '会话审批', convo_ask: '会话提问',
    oc_perm: 'OC 权限', oc_question: 'OC 提问', daily: '每日报告',
  };
  const elements: CardElement[] = [];
  const shown = pageSlice(items, p);
  if (!shown.length) elements.push(md('✅ 没有等你拍板的事。'));
  for (const it of shown) {
    elements.push(md(`[${LABELS[it.kind] || it.kind}] ${it.title}`));
    elements.push(actionBtn('▶ 处理', { act: 'inbox_open', index: items.indexOf(it) >= 0 ? items.indexOf(it) : 0 }));
  }
  if (pages > 1) elements.push(navRow('inbox_page', p, pages));
  elements.push(note(`Co-Team · 待拍板收件箱 · ${new Date().toLocaleString()}`));
  return card2('orange', '📥 待拍板收件箱', elements);
}

// ---------- 动作分发 ----------

export interface ListActionDeps {
  /** /tasks 数据（已含 project_id 供会话内过滤） */
  listTasks: () => Promise<TaskListEntry[]>;
  getSession: (userId: string) => Promise<{ mode?: string; current_project_id?: string; convo_id?: string; oc_instance?: string; oc_session?: string }>;
  convoList: () => Promise<{ id: string; title: string; status: string }[]>;
  ocListSessions?: (instanceId: string) => Promise<{ id: string; title?: string }[]>;
  ocListModels?: (instanceId: string) => Promise<{ id: string; label: string; is_default?: boolean }[]>;
  ocListAgents?: (instanceId: string) => Promise<{ id: string; label: string }[]>;
  /** 收件箱 1h 缓存读取 */
  inboxLoad: (userId: string) => Promise<{ kind: string; title: string; card: Record<string, unknown>; route?: Record<string, unknown> }[] | null>;
}

const LIST_ACTS = new Set([
  'tasks_page', 'convo_list_page', 'oc_sessions_page', 'oc_models_page', 'oc_agents_page',
  'inbox_page', 'inbox_open', 'task_detail',
]);

export function isListAction(act: string): boolean {
  return LIST_ACTS.has(act);
}

export async function handleListAction(cfg: FeishuConfig, deps: ListActionDeps, input: CardActionInput): Promise<Record<string, unknown> | void> {
  const value = input.value || {};
  const act = String(value.act || '');
  const page = Number(value.page || 0) || 0;
  const reply = (title: string, lines: string[]): Record<string, unknown> => cardResponse(buildResultCard(title, lines));
  try {
    switch (act) {
      case 'tasks_page': {
        const session = await deps.getSession(input.operatorOpenId);
        const all = await deps.listTasks();
        const tasks = session.current_project_id ? all.filter((t) => t.project_id === session.current_project_id) : all;
        return cardResponse(buildTaskListCard(tasks, page));
      }
      case 'convo_list_page': {
        const session = await deps.getSession(input.operatorOpenId);
        const convos = await deps.convoList();
        return cardResponse(buildConvoListCard(convos, page, session.convo_id));
      }
      case 'oc_sessions_page': {
        const session = await deps.getSession(input.operatorOpenId);
        const instance = session.oc_instance || '';
        const sessions = (await deps.ocListSessions?.(instance)) || [];
        return cardResponse(buildOcSessionsCard(instance, sessions, page, session.oc_session));
      }
      case 'oc_models_page': {
        const session = await deps.getSession(input.operatorOpenId);
        const models = (await deps.ocListModels?.(session.oc_instance || '')) || [];
        return cardResponse(buildOcModelsCard(models, page));
      }
      case 'oc_agents_page': {
        const session = await deps.getSession(input.operatorOpenId);
        const agents = (await deps.ocListAgents?.(session.oc_instance || '')) || [];
        return cardResponse(buildOcAgentsCard(agents, page));
      }
      case 'inbox_page': {
        const items = (await deps.inboxLoad(input.operatorOpenId)) || [];
        return cardResponse(buildInboxListCard(items, page));
      }
      case 'inbox_open': {
        const items = (await deps.inboxLoad(input.operatorOpenId)) || [];
        const idx = Number(value.index);
        const item = Number.isInteger(idx) ? items[idx] : undefined;
        if (!item) return reply('条目已过期', ['/inbox 重新聚合。']);
        const messageId = await sendCard(cfg, input.chatId || '', item.card);
        if (messageId && item.route) await busSet(`feishu:route:${messageId}`, item.route, ROUTE_TTL_SEC);
        return; // 收件箱卡保留
      }
      case 'task_detail': {
        const taskId = String(value.task_id || '');
        const graph = await getTaskGraph(taskId);
        if (!graph) return reply('任务不存在', [taskId]);
        const journals = await getTaskJournals(taskId).catch(() => ({}));
        const flat = Object.values(journals).flat().sort((a, b) => (b.ts || '').localeCompare(a.ts || '')).slice(0, 3);
        return cardResponse(buildTaskDetailCard(graph, flat));
      }
      default:
        return;
    }
  } catch (e) {
    return reply('⚠ 操作失败', [String((e as Error).message || e).slice(0, 200)]);
  }
}
