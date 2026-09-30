/**
 * oc 桥（Step 4）：/oc 进入 OpenCode 模式——绑定实例/会话后自由文本即 prompt，
 * 终稿完成推送回通知聊天；并全局监控【所有实例的所有会话】：完成/失败通知 +
 * 待确认权限/提问审批卡（跨实例聚合，30s 扫描 + 事件驱动）。
 *
 * 通知落点：feishu:oc:notify_chat（/oc 激活时记录）→ 回落审批人私聊。
 * 噪音阀门：config.feishu.oc_watch = all（默认）/ managed / bound。
 * 权限响应 readonly 实例也可用（answerPermission 是 readonly 唯一写操作）。
 */
import { busDel, busGet, busSet, getBus } from '../bus';
import { CHANNELS } from '../types';
import { getLogger } from '../logger';
import type { FeishuConfig } from '../config';
import type { FeishuSession } from './session';
import { getSession, setSession } from './session';
import { sendCard, sendText } from './messageService';
import { btn, buildResultCard, btnRow, card2, cardResponse, collapse, form, inputField, md, note, projectLabelOf, sourceLine, submitBtn } from './cards';
import { clipText, permViewOf } from '@co-team/opencode-sync';
import { buildOcSessionsCard, buildOcModelsCard, buildOcAgentsCard, buildOcInstancesCard, buildProjectPickerCard } from './listCards';
import type { CardActionInput } from './approvalCards';

// ---------- oc 提问表单（question.asked 的飞书化：选择题点选、输入题表单、全答自动提交） ----------

export interface OcFormField {
  key: string;
  type?: string; // input | select | multiselect | number | boolean | external
  question?: string;
  options?: { label?: string; value?: string }[];
  required?: boolean;
}

export interface OcFormState {
  act: 'oc_form';
  instance: string;
  request_id: string;
  title: string;
  fields: OcFormField[];
  answers: Record<string, unknown>;
  /** 展示上下文（来源/实例/项目）——提问卡点选刷新后仍要带着，否则卡上项目名会丢 */
  instanceLabel?: string;
  project?: string;
  sessionTitle?: string;
}

/** oc 目录 × co-team 项目 合并：会话目录打底（目录名标签），项目覆盖命名并补齐未涉及项目 */
function mergeOcProjects(projects: { name: string; workspace: string }[], dirs: { label: string; workspace: string }[]): { name: string; workspace: string }[] {
  const norm = (d: string) => d.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  const map = new Map<string, { name: string; workspace: string }>();
  for (const d of dirs) map.set(norm(d.workspace), { name: `（会话目录）${d.label}`, workspace: d.workspace });
  for (const p of projects) map.set(norm(p.workspace), { name: p.name, workspace: p.workspace });
  return [...map.values()].slice(0, 14);
}

export function buildOcFormCard(state: OcFormState): Record<string, unknown> {
  const elements: import('./cards').CardElement[] = [];
  if (state.title) elements.push(md(`**${state.title.slice(0, 80)}**`));
  // 来源行：OpenCode 外部引擎提的，属于哪个实例/项目/会话——别和 Co-Team 内置 agent 的提问混了
  elements.push(sourceLine('OpenCode', {
    instance: state.instanceLabel || state.instance,
    project: state.project,
    session: state.sessionTitle,
  }));
  const missing: string[] = [];
  const inputEls: import('./cards').CardElement[] = [];
  for (const f of state.fields) {
    const answered = state.answers[f.key] !== undefined;
    if (!answered && f.required) missing.push(f.question || f.key);
    elements.push(md(`${answered ? '✅' : '❔'} ${f.question || f.key}${f.required ? '（必填）' : ''}`));
    const opts = (f.options || []).slice(0, 6);
    if (opts.length) {
      for (const o of opts) {
        const val = o.value ?? o.label ?? '';
        const selected = state.answers[f.key] === val;
        elements.push({
          tag: 'button', text: { tag: 'plain_text', content: `${selected ? '✅ ' : ''}${(o.label || val).slice(0, 24)}` },
          type: selected ? 'primary' : 'default', size: 'small',
          behaviors: [{ type: 'callback', value: { act: 'oc_form_pick', key: f.key, value: val } }],
        });
      }
    } else if (f.type === 'boolean') {
      for (const [label, val] of [['是', true], ['否', false]] as const) {
        const selected = state.answers[f.key] === val;
        elements.push({
          tag: 'button', text: { tag: 'plain_text', content: `${selected ? '✅ ' : ''}${label}` },
          type: selected ? 'primary' : 'default', size: 'small',
          behaviors: [{ type: 'callback', value: { act: 'oc_form_pick', key: f.key, value: val } }],
        });
      }
    } else {
      inputEls.push(inputField(`in_${f.key}`, `回答：${(f.question || f.key).slice(0, 30)}`));
    }
  }
  if (inputEls.length) {
    elements.push(form(`ocform_${state.request_id}`, inputEls.concat([submitBtn('✅ 提交回答', 'go')])));
  } else {
    elements.push({
      tag: 'button', text: { tag: 'plain_text', content: '✅ 提交回答' }, type: 'primary', size: 'medium',
      behaviors: [{ type: 'callback', value: { act: 'oc_form_submit' } }],
    });
  }
  if (missing.length) elements.push(note(`⚠ 必填未作答：${missing.join('、').slice(0, 120)}`));
  elements.push(note(`Co-Team · OpenCode 提问 · ${new Date().toLocaleString()}`));
  return card2('orange', `❓ OpenCode 提问 · ${state.project || state.instance}`, elements);
}

export interface OcInstanceLite { id: string; label: string; kind: string; state: string; mode: string; project_root?: string }
export interface OcSessionLite { id: string; title?: string; directory?: string; time?: { updated?: string; created?: string } }

export interface OcBridgeDeps {
  listInstances: () => Promise<OcInstanceLite[]>;
  activeSession: (instanceId: string) => Promise<OcSessionLite | null>;
  listSessions: (instanceId: string) => Promise<OcSessionLite[]>;
  createSession: (instanceId: string, title?: string, directory?: string) => Promise<OcSessionLite | null>;
  sendPrompt: (instanceId: string, sessionId: string, prompt: string) => Promise<{ ok: boolean; error?: string }>;
  abort: (instanceId: string, sessionId: string) => Promise<boolean>;
  listModels: (instanceId: string) => Promise<{ id: string; label: string; is_default?: boolean }[]>;
  switchModel: (instanceId: string, sessionId: string, modelId: string) => Promise<boolean>;
  listAgents?: (instanceId: string) => Promise<{ id: string; label: string }[]>;
  switchAgent: (instanceId: string, sessionId: string, agent: string) => Promise<boolean>;
  readLastReply: (instanceId: string, sessionId: string) => Promise<string | null>;
  /** 会话最近消息（切会话时预览当前内容用） */
  readRecent: (instanceId: string, sessionId: string, limit: number) => Promise<{ role: string; text: string }[]>;
  listProjects: () => Promise<{ id?: string; name: string; workspace: string }[]>;
  /** oc 涉及的所有项目目录（既有会话去重聚合；可选——缺省只用 co-team 项目） */
  workdirs?: () => Promise<{ label: string; workspace: string; instance?: string }[]>;
  /** 会话状态表（busy/idle）——完成通知对账 + 卡住复核的数据源；null = 查不到（实例不可达） */
  sessionStatus?: (instanceId: string) => Promise<Record<string, { type?: string }> | null>;
  pendingAll: () => { permissions: Record<string, any>[]; questions: Record<string, any>[] };
  /**
   * 会话存活核对（推 pending 卡前的最后一道闸）。
   * 事件可能来自实例内存里残留的已删会话——删了会话不等于杀掉内存里的回合，它还会继续吐
   * question.asked/permission.asked，而按 id 读消息只会 404（2026-09-28 幽灵会话反复推卡的根因）。
   * true=活着；false=会话确已不存在（不推）；null=探针不可用/未知错误（不拦截，保持原行为）。
   */
  sessionAlive?: (instanceId: string, sessionId: string) => Promise<boolean | null>;
  answerPermission: (instanceId: string, sessionId: string, permissionId: string, response: 'once' | 'always' | 'reject') => Promise<boolean>;
  answerQuestion: (instanceId: string, requestID: string, answers: string[][] | Record<string, unknown>) => Promise<boolean>;
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
  /** [v2] 进入卡：实例 + 会话点选（无参 /oc 渲染） */
  enterCard(arg: string, session: FeishuSession, chatId: string): Promise<Record<string, unknown>>;
  /** [v2] /new 命令的选择卡（项目+会话点选） */
  newCard(session: FeishuSession): Promise<Record<string, unknown>>;
  /** [v2] 会话列表交互卡（点按钮切换） */
  listSessionsCard(session: FeishuSession): Promise<Record<string, unknown>>;
  /** [v2] 模型列表交互卡（点按钮切换） */
  modelsCard(session: FeishuSession): Promise<Record<string, unknown>>;
  /** [v2] Agent 列表交互卡（点按钮切换） */
  agentsCard(session: FeishuSession): Promise<Record<string, unknown>>;
  handleCardAction(cfg: FeishuConfig, input: CardActionInput): Promise<Record<string, unknown> | void>;
  start(cfg: FeishuConfig): () => void;
  /** 单次权限/提问扫描（start 的 30s 定时器即循环调用它；独立导出便于测试） */
  scanPendingOnce(cfg: FeishuConfig): Promise<void>;
  /** 单次卡住检测（有活动但 N 分钟无事件 → 推提醒卡并清除跟踪） */
  scanStalled(cfg: FeishuConfig, minAgeMs?: number): Promise<void>;
  /** [v2] busy→idle 对账扫描（兜底：事件丢了也能补推完成通知） */
  scanReconcile(cfg: FeishuConfig): Promise<void>;
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

/** 折叠阈值：资源条数 / 单条长度超过任一就进折叠面板（面板在老租户可能被拒，只用于真放不下的内容） */
const PERM_FOLD_MAX = 5;
const PERM_FOLD_LEN = 300;

/**
 * OpenCode 权限申请卡（实时推送与 /inbox 共用）。
 * 内容一律经 permViewOf 归一：v2 真载荷是 {action, resources, save, message}，
 * 早前按 v1 的 {title, pattern, command, type} 取值导致卡片永远只显示「权限请求」。
 */
export function buildOcPermissionCard(p: Record<string, any>, ctx: {
  instance: string;
  instanceLabel?: string;
  sessionId: string;
  sessionTitle?: string;
  directory?: string;
  /** co-team 项目名（会话目录 → 项目表解析；缺省回落目录名） */
  project?: string;
}): Record<string, unknown> {
  const view = permViewOf(p);
  const instance = ctx.instance || String(p.instance || '');
  const who = ctx.instanceLabel || instance;
  const sid = ctx.sessionId || String(p.sessionID || '');
  const project = String(ctx.project || '') || projectLabelOf(ctx.directory, []);
  const lines = view
    ? view.lines.map((l) => `**${l.label}** ${l.value}`)
    : [`**动作** ${String(p.title || p.type || '权限请求').slice(0, 120)}`];

  // 会话上下文：批准"写文件/跑命令"之前得知道是哪个会话在哪个项目里干的
  const sessionBits = [ctx.sessionTitle || `会话 ${sid.slice(0, 12)}`, ctx.directory].filter(Boolean);
  lines.push(`**会话** ${sessionBits.join(' · ')}`);

  const elems: import('./cards').CardElement[] = [
    // 来源行放最前：这张卡是 OpenCode 外部引擎提的，别和 Co-Team 内置 agent 的审批混了
    sourceLine('OpenCode', { instance: who, project }),
    md(lines.join('\n')),
  ];

  // 放不下的部分进折叠面板：全量资源 + metadata 剩余项
  const rest: import('./cards').CardElement[] = [];
  const heavy = view ? view.resources.length > PERM_FOLD_MAX || view.resources.some((r) => r.length > PERM_FOLD_LEN) : false;
  if (heavy && view) {
    rest.push(md(view.resources.slice(0, 40).map((r, i) => `${i + 1}. ${r.slice(0, 800)}`).join('\n')));
  }
  if (view?.extra) rest.push(md(`更多细节：${view.extra}`));
  if (rest.length) elems.push(collapse(heavy ? `全部目标（${view?.resources.length} 项）` : '更多细节', rest));

  const pid = String(p.id || p.permissionID || '');
  const brief = view ? clipText(view.summary, 60) : '';
  elems.push(btnRow(
    btn('✅ 批准一次', 'primary', { act: 'oc_perm', instance, session_id: sid, permission_id: pid, response: 'once', brief }),
    btn(view?.alwaysRule ? `总是批准（记住 ${clipText(view.alwaysRule, 24)}）` : '总是批准', 'default', { act: 'oc_perm', instance, session_id: sid, permission_id: pid, response: 'always', brief }),
  ));
  elems.push(btn('✖ 拒绝', 'danger', { act: 'oc_perm', instance, session_id: sid, permission_id: pid, response: 'reject', brief }));
  elems.push(note(`Co-Team · OpenCode 权限 · ${new Date().toLocaleString()}`));
  return card2('orange', `⛔ 权限待确认 · ${view?.label || '权限请求'} · ${project || who}`, elems);
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

  const notifyTarget = (chatId?: string) => notifyChat(cfg0(), chatId);

  /** 项目表（极简挂载可能不提供）：拿不到就退回目录名，卡上绝不因此少一行 */
  const projectsOf = async (): Promise<{ name: string; workspace: string }[]> => {
    try { return (await deps.listProjects()) || []; } catch { return []; }
  };

  /** 完成推送（事件驱动与对账扫描共用）：按 sid+updated 去重——同回合双通道只推一次 */
  async function pushCompletionOnce(cfg: FeishuConfig, target: { id: string; type: 'chat_id' | 'open_id' }, instance: string, sid: string, failed: boolean, noQuickReply = false): Promise<boolean> {
    const sessions = await deps.listSessions(instance).catch(() => null);
    const meta = (sessions || []).find((s) => s.id === sid);
    const updated = String(meta?.time?.updated || '');
    const dedupKey = `feishu:oc:compushed:${sid}`;
    const lastPushed = (await busGet<string>(dedupKey).catch(() => null)) || '';
    if (updated && lastPushed === updated) return false;
    await busSet(dedupKey, updated || String(Date.now()), 7200);
    const title = meta?.title || sid.slice(0, 12);
    const directory = String(meta?.directory || '');
    const recent = await deps.readRecent(instance, sid, 4).catch(() => []);
    const lastUser = recent.filter((m) => m.role === 'user').map((m) => m.text.replace(/\s+/g, ' ')).at(-1) || '';
    const replyText = (await deps.readLastReply(instance, sid).catch(() => null)) || '';
    const body = replyText
      ? replyText.length > 2400 ? `${replyText.slice(0, 2400)}\n\n…（截断，完整内容回面板）` : replyText
      : `会话 ${sid.slice(0, 12)} ${failed ? '执行出错' : '执行完成'}（无文本输出）`;
    const card = card2(failed ? 'red' : 'green', `🖥 OpenCode · ${instance} · ${failed ? '出错' : '已完成'}`, [
      md(`**会话** ${title}\n**目录** ${directory || '（未知）'}\n${body}`),
      ...(noQuickReply ? [] : [form(`ocr_${instance}_${sid}_${Date.now()}`, [inputField('reply', '继续此会话…'), submitBtn('发送', 'go')])]),
      note(`Co-Team · OpenCode 完成${deps.instanceKind(instance) === 'attached-desktop' ? '（桌面实例）' : ''} · 引用回复本卡亦可 · ${new Date().toLocaleString()}`),
    ]);
    const messageId = await sendCard(cfg, target.id, card, target.type);
    logger.info('oc completion push result', { instance, sid: sid.slice(0, 16), ok: !!messageId, target: target.id, target_type: target.type, updated });
    if (messageId) {
      await busSet(`feishu:route:${messageId}`, { act: 'oc_reply', instance, session_id: sid }, BIND_TTL_SEC);
      await busSet(`feishu:reply:${messageId}`, { kind: 'oc', instance, session_id: sid }, BIND_TTL_SEC);
    }
    return true;
  }

  /** 会话活动时间（内存态：oc_event 到达即刷新；session.idle 清除）——卡住检测的数据源 */
  const alive = new Map<string, number>();
  const OC_STALL_MS = 10 * 60 * 1000;
  /** 「忽略」记录的存活上限：够覆盖当前这轮长任务；到点即使仍无新活动也恢复提醒 */
  const STALL_IGNORE_SEC = 12 * 3600;

  /**
   * 上电白名单：只有这些事件能证明「回合正在跑」（session.status 还要求 status.type==='busy'）。
   * 生命周期事件（session.created/session.updated）不上电——建了却没发过指令的空会话永远等不到
   * session.idle 清除，10 分钟后必然误报（2026-09-28 rpc-probe 空会话连环误报的根因）。
   */
  const OC_ARM_TYPES = new Set([
    'session.status',
    'message.updated',
    'message.part.updated',
    'message.part.delta',
    'message.part.removed',
    'session.compacted',
  ]);

  /** 收场白名单：在等人作答/等审批，不是卡住；人答完后事件会重新上电 */
  const OC_SETTLE_TYPES = new Set(['question.asked', 'permission.asked']);

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

    async enterCard(arg, session, chatId) {
      const instances = await deps.listInstances();
      let bound = '';
      if (arg.trim()) {
        bound = (instances.find((i) => i.id === arg || i.label.includes(arg)) || instances[0] || { id: '' }).id;
      } else {
        bound = (instances.find((i) => i.state === 'running' || i.state === 'connected') || instances[0] || { id: '' }).id;
      }
      session.mode = 'oc';
      session.oc_instance = bound;
      const active = bound ? await deps.activeSession(bound).catch(() => null) : null;
      session.oc_session = active?.id || (bound ? (await deps.listSessions(bound).catch(() => []))[0]?.id || '' : '');
      await setSession(session);
      await notifyChat(cfg0(), chatId);
      const sessions = bound ? await deps.listSessions(bound).catch(() => []) : [];
      session.last_list = sessions.map((s) => ({ id: s.id, label: s.title || s.id }));
      session.last_list_kind = 'oc_session';
      await setSession(session);
      return buildOcInstancesCard(instances, bound || undefined, sessions, session.oc_session || undefined);
    },

    async newCard(session) {
      const instances = await deps.listInstances();
      const bound = session.oc_instance || '';
      const projects = await deps.listProjects().catch(() => []);
      const dirs = (await deps.workdirs?.().catch(() => [])) || [];
      const merged = mergeOcProjects(projects, dirs);
      const sessions = bound ? await deps.listSessions(bound).catch(() => []) : [];
      return buildOcInstancesCard(instances, bound || undefined, sessions, session.oc_session || undefined) as any;
    },

    async listSessionsCard(session) {
      const sessions = await deps.listSessions(session.oc_instance || '').catch(() => []);
      session.last_list = sessions.map((s) => ({ id: s.id, label: s.title || s.id }));
      session.last_list_kind = 'oc_session';
      await setSession(session);
      return buildOcSessionsCard(session.oc_instance || '', sessions, 0, session.oc_session);
    },

    async modelsCard(session) {
      const models = await deps.listModels(session.oc_instance || '').catch(() => []);
      session.last_list = models.map((m) => ({ id: m.id, label: m.label }));
      session.last_list_kind = 'model';
      await setSession(session);
      return buildOcModelsCard(models, 0);
    },

    async agentsCard(session) {
      let agents = deps.listAgents ? await deps.listAgents(session.oc_instance || '').catch(() => []) : [];
      if (!agents.length) agents = [{ id: 'build', label: 'build（默认执行）' }, { id: 'plan', label: 'plan（只读规划）' }];
      session.last_list = agents.map((a) => ({ id: a.id, label: a.label }));
      session.last_list_kind = 'agent';
      await setSession(session);
      return buildOcAgentsCard(agents, 0);
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

    async scanStalled(cfg, minAgeMs = OC_STALL_MS) {
      cfgRef = cfg;
      const target = await notifyChat(cfg0());
      if (!target) return;
      const now = Date.now();
      const pushedSids = new Set<string>();
      // 状态表按实例查一次（复核 B 用）；null = 查不到（实例不可达），此时保持原行为不误杀真卡住
      const statusCache = new Map<string, Record<string, { type?: string }> | null>();
      const statusOf = async (instance: string): Promise<Record<string, { type?: string }> | null> => {
        if (!deps.sessionStatus) return null;
        if (!statusCache.has(instance)) statusCache.set(instance, await deps.sessionStatus(instance).catch(() => null));
        return statusCache.get(instance)!;
      };
      for (const [key, ts] of [...alive]) {
        if (now - ts < minAgeMs) continue;
        alive.delete(key);
        const [instance, ...rest] = key.split(':');
        const sid = rest.join(':');
        // 同一会话在多实例共享存储时只告警一次；2h 内不重复提醒
        if (pushedSids.has(sid)) continue;
        // 复核 A：会话里必须真的有消息——「建了但没发过指令」的空会话不上卡（误报根因，且不烧去重键）
        const recent = await deps.readRecent(instance, sid, 4).catch(() => []);
        if (!recent.length) continue;
        // 复核 B：此刻必须仍在跑——不在表里 / 明确 idle 说明回合已收场（idle 事件丢了也不该报卡住）。
        // 口径与 manager.activeSession 一致（非 idle 即在跑）：2.0.16 实测该表用 'running'、事件面用
        // 'busy'，写死 'busy' 会让复核永远不通过（scanReconcile 就是踩了这个坑）。
        const status = await statusOf(instance);
        if (status) {
          const st0 = String(status[sid]?.type || '');
          if (!st0 || st0 === 'idle') continue;
        }
        const dedup = `feishu:oc:stalled:${sid}`;
        if (await busGet(dedup)) { pushedSids.add(sid); continue; }
        // 显式忽略（卡上「忽略」按钮）：只压掉「忽略时刻之前」这段静默——本条不再提醒；
        // 之后会话再有新活动（ts 被事件刷新到忽略时刻之后）照常提醒，不是把整个会话静音。
        const ignoredAt = Number((await busGet<number>(`feishu:oc:stalled:ignore:${instance}:${sid}`).catch(() => null)) || 0);
        if (ignoredAt && ts <= ignoredAt) continue;
        await busSet(dedup, 1, 7200);
        pushedSids.add(sid);
        // 上下文：会话标题 + 目录 + 最近指令——让你能判断"该中止还是只是慢"
        const sessions = await deps.listSessions(instance).catch(() => []);
        const meta = sessions.find((s) => s.id === sid);
        const title = meta?.title || sid.slice(0, 12);
        const directory = String(meta?.directory || '');
        const lastUser = recent.filter((m) => m.role === 'user').map((m) => m.text.replace(/\s+/g, ' ')).at(-1) || '';
        await sendCard(cfg, target.id, card2('orange', `🐢 OpenCode 疑似卡住 · ${title.slice(0, 24)}`, [
          md(`**会话** ${title}
**目录** ${directory || '（未知）'}
**最近指令** ${lastUser.slice(0, 120) || '（无记录）'}
已 **${Math.round((now - ts) / 60000)} 分钟**无任何输出。`),
          btnRow(
            { tag: 'button', text: { tag: 'plain_text', content: '💬 切换到此会话' }, type: 'primary', size: 'small', behaviors: [{ type: 'callback', value: { act: 'oc_pick_session', instance, session_id: sid } }] },
            { tag: 'button', text: { tag: 'plain_text', content: '中止执行' }, type: 'danger', size: 'small', behaviors: [{ type: 'callback', value: { act: 'oc_abort', instance, session_id: sid } }] },
          ),
          { tag: 'button', text: { tag: 'plain_text', content: '忽略（它可能只是在跑长任务）' }, type: 'default', size: 'small', behaviors: [{ type: 'callback', value: { act: 'oc_stall_ignore', instance, session_id: sid } }] },
          note(`Co-Team · 卡住检测 · ${instance} · ${new Date().toLocaleString()}`),
        ]), target.type);
      }
    },

    async scanReconcile(cfg) {
      cfgRef = cfg;
      const target = await notifyTarget();
      if (!target) return;
      const busySeen = ((await busGet<Record<string, boolean>>('feishu:oc:busyseen').catch(() => null)) || {}) as Record<string, boolean>;
      for (const inst of await deps.listInstances()) {
        if (inst.state !== 'connected' && inst.state !== 'running') continue;
        const status = await deps.sessionStatus?.(inst.id).catch(() => null);
        if (!status) continue;
        for (const [sid, st] of Object.entries(status)) {
          const busy = String((st as any)?.type || '') === 'busy';
          const k = `${inst.id}:${sid}`;
          if (busy) { busySeen[k] = true; continue; }
          if (!busySeen[k]) continue;
          delete busySeen[k];
          // busy→idle 迁移：上一轮还在跑、这轮已收场——对账补推完成卡
          await pushCompletionOnce(cfg, target, inst.id, sid, false);
        }
      }
      await busSet('feishu:oc:busyseen', busySeen, 7200);
    },

    async handleCardAction(cfg, input) {
      const who = input.operatorOpenId || 'unknown';
      let params: Record<string, unknown> | null = input.value && Object.keys(input.value).length ? input.value : null;
      if (!params && input.messageId) params = (await busGet(`feishu:route:${input.messageId}`)) || null;
      if (!params) return;
      const act = String(params.act || '');
      const reply = async (title: string, lines: string[]): Promise<Record<string, unknown>> => {
        // 结果卡只随响应帧返回（原地替换被点的卡）；不再额外 sendCard——会双份显示
        return cardResponse(buildResultCard(title, lines));
      };
      try {
        if (!cfg.approvers?.length || !cfg.approvers.includes(who)) {
          return reply('无权操作', [`操作人 ${who} 不在审批白名单内。`]);
        }
        if (act === 'oc_pick_instance') {
          // 进入卡上的实例按钮：切绑实例 + 自动绑定其活动会话 + 推最近对话预览
          const instance = String(params.instance || '');
          if (!instance) return reply('参数缺失', ['未指定实例。']);
          const session = await getSession(input.operatorOpenId);
          const msg = await bindInstance(instance, session, input.chatId || '');
          const sid = session.oc_session || '';
          const recent = sid ? await deps.readRecent(instance, sid, 4).catch(() => []) : [];
          const preview = recent.length ? `\n最近对话：\n${recent.map((m) => `${m.role === 'user' ? '用户' : '助手'}：${m.text.replace(/\s+/g, ' ').slice(0, 120)}`).join('\n')}` : '';
          await sendText(cfg, input.chatId || '', `${msg}${preview}`);
          return; // 进入卡保留可继续点
        }
        if (act === 'oc_new_page') {
          // 项目选择卡翻页：重拉数据渲染该页（页码在按钮 value 里，无状态）
          const session = await getSession(input.operatorOpenId);
          const projects = await deps.listProjects().catch(() => []);
          const dirs = (await deps.workdirs?.().catch(() => [])) || [];
          return cardResponse(buildProjectPickerCard('oc', mergeOcProjects(projects, dirs), session.oc_instance || String(params.instance || ''), Number(input.value?.page || 0) || 0));
        }
        if (act === 'oc_new_pick') {
          // 新建先选项目：co-team 项目 + oc 既有会话涉及的目录（去重合并，项目名优先）
          const projects = await deps.listProjects().catch(() => []);
          const dirs = (await deps.workdirs?.().catch(() => [])) || [];
          return cardResponse(buildProjectPickerCard('oc', mergeOcProjects(projects, dirs), String(params.instance || '')));
        }
        if (act === 'oc_new_proj') {
          const session = await getSession(input.operatorOpenId);
          const instance = String(params.instance || session.oc_instance || '');
          const workspace = String(params.workspace || '');
          if (!instance || !workspace) return reply('参数缺失', ['先 /oc 进入并选择实例。']);
          const s = await deps.createSession(instance, undefined, workspace).catch(() => null);
          if (!s) return reply('⚠ 新建失败', ['实例可能不在线，稍后再试。']);
          session.mode = 'oc';
          session.oc_instance = instance;
          session.oc_session = s.id;
          await setSession(session);
          return reply(`✅ 已新建会话（项目：${String(params.project || '')}）`, [
            `${instance} · ${s.id.slice(0, 12)}`,
            '直接输入需求即可——agent 将在该项目工作区内执行。',
          ]);
        }
        if (act === 'oc_pick_session') {
          const session = await getSession(input.operatorOpenId);
          const instance = String(params.instance || session.oc_instance || '');
          const sid = String(params.session_id || '');
          session.mode = 'oc';
          session.oc_instance = instance;
          session.oc_session = sid;
          await setSession(session);
          const recent = await deps.readRecent(instance, sid, 4).catch(() => []);
          const preview = recent.length ? `\n最近对话：\n${recent.map((m) => `${m.role === 'user' ? '用户' : '助手'}：${m.text.replace(/\s+/g, ' ').slice(0, 120)}`).join('\n')}` : '';
          await sendText(cfg, input.chatId || '', `✅ 已切换到会话 ${sid.slice(0, 12)}。${preview}\n直接输入需求。`);
          return;
        }
        if (act === 'oc_pick_model') {
          const session = await getSession(input.operatorOpenId);
          const modelId = String(params.model_id || '');
          const ok = await deps.switchModel(session.oc_instance || '', session.oc_session || '', modelId);
          return ok
            ? cardResponse(buildResultCard('✅ 已切换模型', [modelId]))
            : cardResponse(buildResultCard('⚠ 切换失败', [modelId]));
        }
        if (act === 'oc_pick_agent') {
          const session = await getSession(input.operatorOpenId);
          const agentId = String(params.agent || '');
          const ok = await deps.switchAgent(session.oc_instance || '', session.oc_session || '', agentId);
          return ok
            ? cardResponse(buildResultCard('✅ 已切换 Agent', [agentId]))
            : cardResponse(buildResultCard('⚠ 切换失败', [agentId]));
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
        if (act === 'oc_abort') {
          const instance = String(params.instance || '');
          const sessionId = String(params.session_id || '');
          const ok = await deps.abort(instance, sessionId);
          return ok
            ? reply('✅ 已中止', [`${instance} · ${sessionId.slice(0, 12)}`])
            : reply('⏱ 会话已结束', [`${instance} · ${sessionId.slice(0, 12)}`]);
        }
        if (act === 'oc_perm') {
          const instance = String(params.instance || '');
          const sessionId = String(params.session_id || '');
          const permissionId = String(params.permission_id || '');
          const response = (params.response === 'always' ? 'always' : params.response === 'reject' ? 'reject' : 'once') as 'once' | 'always' | 'reject';
          // 回执带上申请内容（按钮 value 里的 brief）——否则批完只剩一串 id
          const brief = String(params.brief || '');
          const ok = await deps.answerPermission(instance, sessionId, permissionId, response);
          return ok
            ? reply(`✅ 权限已${response === 'reject' ? '拒绝' : '批准'}`, [brief || `${instance} · ${permissionId}`])
            : reply('⏱ 权限已失效', [brief ? `${brief}（${instance}）不在等待中。` : `${instance} · ${permissionId} 不在等待中。`]);
        }
        if (act === 'oc_form' || act === 'oc_form_submit' || act === 'oc_form_pick') {
          // 提问表单状态机：状态存 feishu:route:{message_id}。
          // act='oc_form'（表单提交）：合并输入框值并提交；act='oc_form_submit'（纯选择题的
          // 提交按钮，按钮 value 只有 act，状态同样从路由取）；act='oc_form_pick'（选项点选）：
          // 记录该题答案，全部作答后自动提交，未答完返回刷新卡（✓ 标记已选）。
          const submitAct = act === 'oc_form' || act === 'oc_form_submit';
          const state: OcFormState | null = act === 'oc_form'
            ? (params as unknown as OcFormState)
            : (input.messageId ? await busGet<OcFormState>(`feishu:route:${input.messageId}`).catch(() => null) : null);
          if (!state || (state as any).act !== 'oc_form') return reply('表单已过期', ['/inbox 重新获取。']);
          if (act === 'oc_form_pick') {
            state.answers[String((input.value as any).key || '')] = (input.value as any).value;
          }
          if (input.formValue) {
            for (const f of state.fields) {
              const v = String(input.formValue?.[`in_${f.key}`] ?? '').trim();
              if (v) state.answers[f.key] = f.type === 'number' ? Number(v) : v;
            }
          }
          if (input.messageId) await busSet(`feishu:route:${input.messageId}`, state, BIND_TTL_SEC).catch(() => {});
          const allAnswered = state.fields.length > 0 && state.fields.every((f) => state.answers[f.key] !== undefined);
          const missingRequired = state.fields.filter((f) => f.required && state.answers[f.key] === undefined);
          const readyToSubmit = (submitAct && !missingRequired.length && Object.keys(state.answers).length > 0) || (act === 'oc_form_pick' && allAnswered);
          if (readyToSubmit) {
            const ok = await deps.answerQuestion(state.instance, state.request_id, state.answers);
            return ok
              ? reply('✅ 已提交回答', ['opencode 将继续执行。'])
              : reply('⏱ 提问已失效', [`${state.instance} · ${state.request_id} 不在等待中。`]);
          }
          return cardResponse(buildOcFormCard(state));
        }
        if (act === 'oc_stall_ignore') {
          // 「忽略」= 这轮静默不再提醒（不是把这个会话静音）：记下忽略时刻，之后有新活动照常提醒
          const instance = String(params.instance || '');
          const sid = String(params.session_id || '');
          if (!instance || !sid) return reply('参数缺失', ['未指定会话。']);
          await busSet(`feishu:oc:stalled:ignore:${instance}:${sid}`, Date.now(), STALL_IGNORE_SEC);
          // 会话级去重键一并撤掉——否则忽略之后的新一轮卡住会被旧去重键吃掉，违背「有新活动继续提醒」
          await busDel(`feishu:oc:stalled:${sid}`).catch(() => {});
          return reply('✅ 已忽略本次卡住提醒', [`${sid.slice(0, 12)} 之后再有新活动（并重新静默）仍会提醒。`]);
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
        // 卡住检测数据源：只认「回合真的在跑」的事件（见 OC_ARM_TYPES / OC_SETTLE_TYPES）
        const sid0 = deps.eventSessionId(event);
        if (sid0) {
          const key0 = `${instance}:${sid0}`;
          const statusType = String(((event.properties as Record<string, any> | undefined)?.status as { type?: unknown } | undefined)?.type ?? '');
          if (
            event.type === 'session.idle' ||
            event.type === 'session.error' ||
            OC_SETTLE_TYPES.has(event.type) ||
            (event.type === 'session.status' && statusType && statusType !== 'busy')
          ) {
            alive.delete(key0);
          } else if (OC_ARM_TYPES.has(event.type)) {
            alive.set(key0, Date.now());
          }
        }
        if (event.type !== 'session.idle' && event.type !== 'session.error') return;
        void (async () => {
          const sid = deps.eventSessionId(event);
          if (!sid) return;
          const dedup = `feishu:oc:idle:${instance}:${sid}:${event.id || ''}`;
          if (await busGet(dedup)) return;
          await busSet(dedup, 1, 20);
          const target = await notifyTarget();
          if (!target) { logger2.warn('oc completion push skipped: no notify target', { instance, sid: sid.slice(0, 16) }); return; }
          // 会话归属解析：目录与实例 project_root 匹配的执行器才是“家”；无匹配则完成卡不带快速回复
          const sessions0 = await deps.listSessions(instance).catch(() => null);
          const sdir = String(((sessions0 || []).find((s) => s.id === sid) || ({} as any)).directory || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
          let exec = '';
          for (const i2 of await deps.listInstances()) {
            if (sdir && String(i2.project_root || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase() === sdir) { exec = i2.id; break; }
          }
          if (!exec) exec = instance;
          await pushCompletionOnce(cfg, target, exec, sid, event.type === 'session.error', !sdir || !exec);
        })().catch((e) => logger2.warn('Feishu oc completion push failed', { error: String(e).slice(0, 200), instance }));
      });

      // 权限/提问：30s 扫描跨实例 pending 聚合（对齐 clarifyTimeout 扫描器模式）
      const timer = setInterval(() => {
        void this.scanPendingOnce(cfg).catch((e) => logger2.warn('Feishu oc pending scan failed', { error: String(e).slice(0, 200) }));
        void this.scanStalled(cfg).catch((e) => logger2.warn('Feishu oc stall scan failed', { error: String(e).slice(0, 200) }));
        void this.scanReconcile(cfg).catch((e) => logger2.warn('Feishu oc reconcile failed', { error: String(e).slice(0, 200) }));
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
      if (!(pending.permissions || []).length && !(pending.questions || []).length) return;
      // 卡上要标「哪个实例/项目」——实例表与项目表每轮只查一次（30s 一轮，空转不查）
      const insts = await deps.listInstances().catch(() => [] as OcInstanceLite[]);
      const projects = await projectsOf();
      const sessCache = new Map<string, OcSessionLite[]>();
      const sessionsOf = async (instance: string): Promise<OcSessionLite[]> => {
        if (!sessCache.has(instance)) sessCache.set(instance, await deps.listSessions(instance).catch(() => [] as OcSessionLite[]));
        return sessCache.get(instance)!;
      };
      // 存活核对按「实例:会话」每轮只探一次；跳过时不烧去重键——下一轮再试，会话真回来还会提醒
      const aliveCache = new Map<string, boolean | null>();
      const aliveOf = async (instance: string, sid: string): Promise<boolean | null> => {
        if (!deps.sessionAlive || !sid) return null;
        const key = `${instance}:${sid}`;
        if (!aliveCache.has(key)) aliveCache.set(key, await deps.sessionAlive(instance, sid).catch(() => null));
        return aliveCache.get(key)!;
      };
      for (const p of pending.permissions || []) {
        const pid = String(p.permissionID || p.id || '');
        const instance = String(p.instance || '');
        const sid = String(p.sessionID || p.session_id || p.sessionId || '');
        if (!pid || !instance || !sid) continue;
        if ((await aliveOf(instance, sid)) === false) continue;
        const seenKey = `feishu:oc:permseen:${pid}`;
        if (await busGet(seenKey)) continue;
        await busSet(seenKey, 1, 3600);
        // 会话上下文：实例中文名 + 会话标题/目录 + 项目名
        const inst = insts.find((i) => i.id === instance);
        const sess = (await sessionsOf(instance)).find((s) => s.id === sid);
        await sendCard(cfg, target.id, buildOcPermissionCard(p, {
          instance,
          instanceLabel: inst?.label,
          sessionId: sid,
          sessionTitle: sess?.title,
          directory: sess?.directory,
          project: projectLabelOf(sess?.directory, projects),
        }), target.type);
      }
      for (const q of pending.questions || []) {
        const qid = String(q.requestID || q.id || '');
        const instance = String(q.instance || '');
        const sid = String(q.sessionID || q.session_id || '');
        if (!qid || !instance) continue;
        if ((await aliveOf(instance, sid)) === false) continue;
        const seenKey = `feishu:oc:qseen:${qid}`;
        if (await busGet(seenKey)) continue;
        await busSet(seenKey, 1, 3600);
        // question.asked 归一结构：{title, questions:[{key,type,question,options,required}]}
        // 选择题渲染选项按钮（点选即答、✓标记），输入题渲染输入框，全部作答后自动提交
        const fields = (Array.isArray(q.questions) ? q.questions : []) as OcFormField[];
        const sess = sid ? (await sessionsOf(instance)).find((s) => s.id === sid) : undefined;
        const state: OcFormState = {
          act: 'oc_form', instance, request_id: qid, title: String(q.title || ''), fields, answers: {},
          instanceLabel: insts.find((i) => i.id === instance)?.label || instance,
          project: projectLabelOf(sess?.directory, projects),
          sessionTitle: sess?.title,
        };
        const card = buildOcFormCard(state);
        const messageId = await sendCard(cfg, target.id, card, target.type);
        if (messageId) await busSet(`feishu:route:${messageId}`, state, BIND_TTL_SEC);
      }
    },
  };
}
