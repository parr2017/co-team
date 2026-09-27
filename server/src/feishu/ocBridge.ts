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
import { getSession, setSession } from './session';
import { sendCard, sendText } from './messageService';
import { buildResultCard, btnRow, card2, cardResponse, form, inputField, md, note, submitBtn } from './cards';
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
}

/** oc 目录 × co-team 项目 合并：会话目录打底（目录名标签），项目覆盖命名并补齐未涉及项目 */
function mergeOcProjects(projects: { name: string; workspace: string }[], dirs: { label: string; workspace: string }[]): { name: string; workspace: string }[] {
  const norm = (d: string) => d.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  const map = new Map<string, { name: string; workspace: string }>();
  for (const d of dirs) map.set(norm(d.workspace), { name: `（会话目录）${d.label}`, workspace: d.workspace });
  for (const p of projects) map.set(norm(p.workspace), { name: p.name, workspace: p.workspace });
  return [...map.values()].slice(0, 14);
}

function buildOcFormCard(state: OcFormState): Record<string, unknown> {
  const elements: import('./cards').CardElement[] = [];
  if (state.title) elements.push(md(`**${state.title.slice(0, 80)}**`));
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
  return card2('orange', `❓ OpenCode 提问 · ${state.instance}`, elements);
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
  /** 会话状态表（busy/idle）——完成通知对账扫描的数据源 */
  sessionStatus?: (instanceId: string) => Promise<Record<string, { type?: string }>>;
  pendingAll: () => { permissions: Record<string, any>[]; questions: Record<string, any>[] };
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
      for (const [key, ts] of [...alive]) {
        if (now - ts < minAgeMs) continue;
        alive.delete(key);
        const [instance, ...rest] = key.split(':');
        const sid = rest.join(':');
        // 同一会话在多实例共享存储时只告警一次；2h 内不重复提醒
        if (pushedSids.has(sid)) continue;
        const dedup = `feishu:oc:stalled:${sid}`;
        if (await busGet(dedup)) { pushedSids.add(sid); continue; }
        await busSet(dedup, 1, 7200);
        pushedSids.add(sid);
        // 上下文：会话标题 + 目录 + 最近指令——让你能判断"该中止还是只是慢"
        const sessions = await deps.listSessions(instance).catch(() => []);
        const meta = sessions.find((s) => s.id === sid);
        const title = meta?.title || sid.slice(0, 12);
        const directory = String(meta?.directory || '');
        const recent = await deps.readRecent(instance, sid, 4).catch(() => []);
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
          { tag: 'button', text: { tag: 'plain_text', content: '忽略（它可能只是在跑长任务）' }, type: 'default', size: 'small', behaviors: [{ type: 'callback', value: { act: 'noop' } }] },
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
          const ok = await deps.answerPermission(instance, sessionId, permissionId, response);
          return ok
            ? reply(`✅ 权限已${response === 'reject' ? '拒绝' : '批准'}`, [`${instance} · ${permissionId}`])
            : reply('⏱ 权限已失效', [`${instance} · ${permissionId} 不在等待中。`]);
        }
        if (act === 'oc_form' || act === 'oc_form_pick') {
          // 提问表单状态机：状态存 feishu:route:{message_id}。
          // act='oc_form'（表单提交）：合并输入框值并提交；act='oc_form_pick'（选项点选）：
          // 记录该题答案，全部作答后自动提交，未答完返回刷新卡（✓ 标记已选）。
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
          const readyToSubmit = (act === 'oc_form' && !missingRequired.length && Object.keys(state.answers).length > 0) || (act === 'oc_form_pick' && allAnswered);
          if (readyToSubmit) {
            const ok = await deps.answerQuestion(state.instance, state.request_id, state.answers);
            return ok
              ? reply('✅ 已提交回答', ['opencode 将继续执行。'])
              : reply('⏱ 提问已失效', [`${state.instance} · ${state.request_id} 不在等待中。`]);
          }
          return cardResponse(buildOcFormCard(state));
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
        // 卡住检测数据源：会话事件刷新活动时间（idle/error 清除——回合已收场）
        const sid0 = deps.eventSessionId(event);
        if (sid0) {
          if (event.type === 'session.idle' || event.type === 'session.error') alive.delete(`${instance}:${sid0}`);
          else alive.set(`${instance}:${sid0}`, Date.now());
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
      for (const p of pending.permissions || []) {
        const pid = String(p.permissionID || p.id || '');
        const instance = String(p.instance || '');
        const sid = String(p.sessionID || p.session_id || p.sessionId || '');
        if (!pid || !instance || !sid) continue;
        const seenKey = `feishu:oc:permseen:${pid}`;
        if (await busGet(seenKey)) continue;
        await busSet(seenKey, 1, 3600);
        // 权限详情（对齐 mobile permDetailOf）：pattern 数组/命令串，metadata 附注
        const pat = Array.isArray(p.pattern) ? p.pattern.join(' , ') : p.pattern;
        const detail = String(pat || p.command || p.title || p.type || '权限请求');
        const meta = p.metadata && typeof p.metadata === 'object' ? JSON.stringify(p.metadata).slice(0, 200) : '';
        const permMd = `**会话** ${sid.slice(0, 12)}\n**请求** ${detail.slice(0, 300)}${meta ? `\n**详情** ${meta}` : ''}`;
        await sendCard(cfg, target.id, card2('orange', `⛔ OpenCode 权限待确认 · ${instance}`, [
          md(permMd),
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
        // question.asked 归一结构：{title, questions:[{key,type,question,options,required}]}
        // 选择题渲染选项按钮（点选即答、✓标记），输入题渲染输入框，全部作答后自动提交
        const fields = (Array.isArray(q.questions) ? q.questions : []) as OcFormField[];
        const state: OcFormState = { act: 'oc_form', instance, request_id: qid, title: String(q.title || ''), fields, answers: {} };
        const card = buildOcFormCard(state);
        const messageId = await sendCard(cfg, target.id, card, target.type);
        if (messageId) await busSet(`feishu:route:${messageId}`, state, BIND_TTL_SEC);
      }
    },
  };
}
