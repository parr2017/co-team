/**
 * 协作会话（convo）：单 agent 长对话直接操作项目工作区（对标 opencode/codex 交互模式）。
 *
 * 与任务管线（TaskGraph/DAG/taskQueue）完全解耦：
 * - 每个会话绑定一个项目 workspace，用户指定模型（可中途/逐条消息切换）；
 * - agent 直接读写项目工作区（不建沙箱 worktree）——安全网是「会话首轮自动快照 + 每轮 diff 可见」；
 * - 与任务/其他会话允许并行写同一工作区（用户已拍板接受冲突风险，diff 可见）；
 * - 权限体系与任务系统同源：PermissionPolicy 分级 + commandGuard 敏感命令拦截 + 目录监狱；
 *   approve 场景：非白名单/敏感命令 park 成会话级待审批（批准一次/拒绝/本会话总是允许）；
 * - 插话双模式：排队（默认，turn 间自动消费，多条合并）与打断（abort LLM 流 + 中止在飞命令
 *   + 在飞审批/提问连带作废）；
 * - 模型失败自动沿降级链换模，但显著落「降级卡片」，用户 pin 不变、可一键改回；
 * - 多模态：图片原生 image parts（pinned 模型带 image tag 时）否则回退视觉描述富化；
 *   文件走 multipart 上传落 <ws>/.coteam/user-files/（agent 用 read_file 读取）；
 * - 长对话上下文：静态前缀 + append-only 历史（LLM 视角裁剪最近 HISTORY_MSGS 条），
 *   工具结果以 user 消息追加（同任务管线前缀缓存纪律）。
 *
 * 存储全走 message bus KV（Redis/内存），事件走 dashboard 频道（convo_* 前缀）。
 */
import { busGet, busSet, busDel, busKeys } from './bus';
import { emitProgress, getProject, getProjectMemory } from './store';
import { chat, extractJson, salvageToolCalls, normalizeToolCalls } from './llm';
import type { LlmResponse } from './llm';
import type { ModelPool, ModelEntry } from './scheduler';
import type { Orchestrator } from './orchestrator/orchestrator';
import { CAPACITY_RE } from './orchestrator/orchestrator';
import type { McpManager } from './mcp/manager';
import type { Logger } from './logger';
import type { AgentPlugin } from './agents';
import { applyToolCalls } from './tools';
import { extractReplyStreaming } from './discussion';
import type { KnowledgeToolContext } from './tools';
import { pickSkillsForNode, formatSkillsBlock, formatSkillsCatalog } from './skills';
import { getSkills } from './skills';
import { classifyCommand } from './commandGuard';
import { canExecute, policyFromConfig, executeCommandAsync, type PermissionPolicy } from './sandbox';
import { assertWithinJail, jailViolationMessage } from './workspace';
import { analyzeImages } from './vision';
import { ingestUserImages, renderImagesForContext, type IncomingImage, type StoredImage } from './media';
import { createSnapshot, rollbackSnapshot, getSnapshot } from './snapshot';
import { simpleGit } from 'simple-git';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

// ---------- types ----------

export type ConvoStatus = 'idle' | 'running' | 'waiting_approval' | 'waiting_ask';

export interface Convo {
  id: string;
  title: string;
  project_id?: string;
  workspace: string;
  /** 主 agent 人设（agents/ 目录名），缺省 partner（搭档） */
  agent_id: string;
  /** 用户指定的主模型（model_pool id）；空 = 按 agent tags 自动选 */
  model_id?: string;
  status: ConvoStatus;
  /** 会话级权限覆盖（缺省继承全局 permissions）；仅作用于本会话 */
  policy_level?: string;
  /** 首轮自动快照 id（回滚锚点） */
  snapshot_id?: string;
  /** 长对话自动压缩：upto_id 之前的消息已折叠为摘要（LLM 历史只保留摘要 + 之后的消息） */
  compaction?: { summary: string; upto_id: string; at: string };
  /** 会话步骤清单（LLM 自主维护：write_plan 规划 / update_plan 打勾；UI 胶囊/展开渲染） */
  plan?: { steps: { text: string; status: 'pending' | 'in_progress' | 'done' | 'blocked'; ts: string }[]; updated_at: string };
  /** 模型自动切换（默认关）：关=主模型失败自动重试 10 次后报断连；开=沿降级链自动换模（ZCode 式） */
  auto_switch?: boolean;
  created_at: string;
  updated_at: string;
}

export type ConvoMessageKind = 'text' | 'tool' | 'notice' | 'degrade' | 'approval' | 'ask' | 'file' | 'interrupt' | 'diff';

export interface ConvoMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  kind: ConvoMessageKind;
  text: string;
  ts: string;
  /** 产生这条消息的模型（assistant/degrade） */
  model?: string;
  meta?: Record<string, any>;
}

export interface ConvoApproval {
  id: string;
  command: string;
  ts: string;
  status: 'pending' | 'approved_once' | 'approved_always' | 'rejected';
  resolved_by?: string;
  resolved_at?: string;
}

export interface ConvoAsk {
  id: string;
  question: string;
  ts: string;
  status: 'pending' | 'answered' | 'timeout' | 'cancelled';
  answer?: string;
  answered_at?: string;
}

export interface ConvoDeps {
  orchestrator: Orchestrator;
  pool: ModelPool;
  logger: Logger;
  /** 外部 MCP 服务管理器（缺省=未接入，mcp__ 工具软错误拒绝） */
  mcp?: McpManager;
}

export class ConvoError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

// ---------- configuration (config.yaml `convo:`) ----------

export interface ConvoConfig {
  permissions?: { level?: string; whitelist_commands?: string[]; max_time_sec?: number; allow_sensitive?: boolean };
  exec_timeout_sec?: number;
  max_tool_iter?: number;
  ask_timeout_sec?: number;
  /** 模型自动重试次数（关自动切换时同模型重试次数，默认 10） */
  auto_retry_count?: number;
  /** 重试退避基数毫秒（指数 2^i 封顶 10×base，默认 1000） */
  auto_retry_base_ms?: number;
}

const EXEC_TIMEOUT_SEC = 180;
const MAX_TOOL_ITER = 15;
const ASK_TIMEOUT_MS = 60 * 60 * 1000;
const WALLCLOCK_CAP_MS = 0; // 超时不判死（2026-09-09 纪律）：失败判定只认 llm 层确定性信号
const MAX_MESSAGES = 2000;
const MAX_MESSAGE_LENGTH = 8000;
/** LLM 视角保留的最近消息条数（跨 turn 历史裁剪；更早轮次的结论已反映在 assistant 文本里） */
const HISTORY_MSGS = 30;
/** 流式 delta 节流（与 discussion 同参数） */
const DELTA_MIN_CHARS = 6;
const DELTA_MIN_MS = 150;
const MAX_SPEAKER_MODEL_CHAIN = 3;
const QUICK_RETRY_DELAY_MS = 3000;
/** 自动重试：次数与间隔（指数退避 base×2^i 封顶 10×base）。ZCode 式默认 10 次；测试可注入小值 */
const AUTO_RETRY_COUNT = 10;
const AUTO_RETRY_BASE_MS = 1000;
const AUTO_RETRY_CAP_MS = 10 * AUTO_RETRY_BASE_MS;
/** 404（模型在该供应商不存在）是确定性配置错误：冷却 24h，期间跳过且不重试 */
const MODEL_404_COOLDOWN_MS = 24 * 3600 * 1000;
/** 降级提示静默期：同会话降级到同一模型，10 分钟内不重复落卡 */
const DEGRADE_SILENCE_MS = 10 * 60 * 1000;
/** 404 冷却表（进程级；重启即清，用户改配置后也自然失效） */
const model404Cooldown = new Map<string, number>();
/** 降级静默表：convoId:targetModel -> 上次落卡时间 */
const degradeSilence = new Map<string, number>();
function retryDelayMs(attempt: number): number {
  const cfg = (convoCfg as any).autoRetryBaseMs as number | undefined;
  const base = typeof cfg === 'number' && cfg > 0 ? cfg : AUTO_RETRY_BASE_MS;
  return Math.min(base * 2 ** attempt, base * 10);
}
function is404(reason: string): boolean {
  return /404|model is not found|not found.*model|does not exist/i.test(reason);
}

// ---------- 引擎级自纠错（2026-09-20 二轮修复：嘴炮不死循环） ----------
// 实证：模型上下文被历史嘴炮污染后会持续输出"第一批工具调用已发出"式散文/口头承诺，
// 逼用户手动催"开始了吗"×3。引擎不能等用户当监工——嘴炮输出先自动纠正重试（有界），再采纳。
/** 形态 B 回复中的「正在动手」现在进行时声称（零工具时即为违约信号；窄匹配防误伤"建议先讨论"类回复） */
const ACTION_CLAIM_RE = /(正在(执行|动手|写入|读取|修改|实施|分析|侦查|整理)|这就动手|立刻动手|马上动手|开始执行|第一批[^\n]{0,12}(发出|执行)|已发出|开工)/;
const CORRECTIVE_JSON_MSG = '纠正：你上一条输出是纯文本，违反输出契约（最终输出必须是纯 JSON，禁止 markdown 代码栅栏和散文）。要动手就发 {"tool_calls":[...]}，要收尾就发 {"reply":"..."}。现在重新输出纯 JSON。';
const CORRECTIVE_ACT_MSG = '纠正：你上一条只是口头承诺要动手，但没有发出任何 tool_calls——口头承诺不算执行，用户什么都没看到。现在立刻发 {"tool_calls":[...]}，把你要做的第一批动作直接发出来。如果你其实是在等待用户决策，就用 {"reply":"..."} 明确说明你在等什么，不要声称正在执行。';

const FILE_LIKE_RE = /[\w\-\\/.]+\.(?:txt|md|json|js|mjs|cjs|ts|tsx|jsx|py|vue|css|scss|html|yaml|yml|toml|go|rs|java|sh|sql)/i;

/**
 * 核验回复中的「已创建/已写入 X」声称（2026-09-20 实证：模型会用过去式谎言——"已创建
 * selfcheck.txt"，实际零工具）。声称的文件在工作区不存在 = 可验证的假完成。
 * 引用之前轮次真实落盘的文件不会误伤（文件确实存在）。
 */
function findFalseFileClaims(reply: string, workspace: string | null): string[] {
  if (!workspace || !reply) return [];
  const claims: string[] = [];
  for (const sent of reply.split(/[\n。；;！!？]/)) {
    if (!/已(经)?(创建|写入|新建|生成|落盘|完成)/.test(sent)) continue;
    const m = sent.match(FILE_LIKE_RE);
    if (!m) continue;
    const rel = m[0].replace(/[`'"]/g, '').replace(/\\/g, '/').replace(/^\.\//, '');
    try {
      const abs = path.resolve(workspace, rel);
      if (!abs.startsWith(path.resolve(workspace)) || !fs.existsSync(abs)) claims.push(rel);
    } catch { /* 相对路径解析失败则忽略 */ }
  }
  return [...new Set(claims)].slice(0, 3);
}

let convoCfg: { policy: PermissionPolicy; execTimeoutSec: number; maxToolIter: number; askTimeoutMs: number; autoRetryCount: number; autoRetryBaseMs: number } = {
  policy: policyFromConfig(undefined),
  execTimeoutSec: EXEC_TIMEOUT_SEC,
  maxToolIter: MAX_TOOL_ITER,
  askTimeoutMs: ASK_TIMEOUT_MS,
  autoRetryCount: AUTO_RETRY_COUNT,
  autoRetryBaseMs: AUTO_RETRY_BASE_MS,
};

export function configureConvo(cfg?: ConvoConfig): void {
  if (!cfg) return;
  if (cfg.permissions) convoCfg.policy = policyFromConfig(cfg.permissions);
  if (typeof cfg.exec_timeout_sec === 'number' && cfg.exec_timeout_sec > 0) convoCfg.execTimeoutSec = Math.min(1800, Math.floor(cfg.exec_timeout_sec));
  if (typeof cfg.max_tool_iter === 'number' && cfg.max_tool_iter > 0) convoCfg.maxToolIter = Math.min(60, Math.floor(cfg.max_tool_iter));
  if (typeof cfg.ask_timeout_sec === 'number' && cfg.ask_timeout_sec > 0) convoCfg.askTimeoutMs = cfg.ask_timeout_sec * 1000;
  if (typeof cfg.auto_retry_count === 'number' && cfg.auto_retry_count > 0) convoCfg.autoRetryCount = Math.min(30, Math.floor(cfg.auto_retry_count));
  if (typeof cfg.auto_retry_base_ms === 'number' && cfg.auto_retry_base_ms > 0) convoCfg.autoRetryBaseMs = Math.min(10_000, Math.floor(cfg.auto_retry_base_ms));
}

export function __getConvoConfig(): typeof convoCfg {
  return convoCfg;
}

// ---------- KV ----------

function convoKey(id: string) { return `convo:${id}`; }
function msgsKey(id: string) { return `convo:${id}:messages`; }
function pendingKey(id: string) { return `convo:${id}:pending`; }
function busyKey(id: string) { return `convo:${id}:busy`; }
function approvalsKey(id: string) { return `convo:${id}:approvals`; }
function alwaysKey(id: string) { return `convo:${id}:always`; }
function asksKey(id: string) { return `convo:${id}:asks`; }
function undoKey(id: string) { return `convo:${id}:undo`; }

function newId(): string {
  return Math.random().toString(36).slice(2, 10);
}

export async function getConvo(id: string): Promise<Convo | null> {
  return busGet<Convo>(convoKey(id));
}

async function saveConvo(c: Convo): Promise<void> {
  c.updated_at = new Date().toISOString();
  await busSet(convoKey(c.id), c);
}

export async function listConvos(): Promise<Convo[]> {
  const keys = (await busKeys('convo:*')).filter((k) => !/:messages$|:pending$|:busy$|:approvals$|:always$|:asks$|:undo$/.test(k));
  const out: Convo[] = [];
  for (const key of keys) {
    const c = await busGet<Convo>(key);
    if (c && typeof c.id === 'string') out.push(c);
  }
  out.sort((a, b) => (b.updated_at || '').localeCompare(a.updated_at || ''));
  return out;
}

export async function getConvoMessages(id: string): Promise<ConvoMessage[]> {
  return (await busGet<ConvoMessage[]>(msgsKey(id))) || [];
}

async function appendConvoMessage(id: string, msg: Omit<ConvoMessage, 'id' | 'ts'> & { ts?: string }): Promise<ConvoMessage> {
  const full: ConvoMessage = { ...msg, id: newId(), ts: msg.ts || new Date().toISOString() } as ConvoMessage;
  const list = (await busGet<ConvoMessage[]>(msgsKey(id))) || [];
  list.push(full);
  await busSet(msgsKey(id), list.slice(-MAX_MESSAGES));
  await emitProgress('convo_message', { convo_id: id, message: full });
  return full;
}

export async function deleteConvo(id: string): Promise<void> {
  for (const key of [convoKey(id), msgsKey(id), pendingKey(id), busyKey(id), approvalsKey(id), alwaysKey(id), asksKey(id), undoKey(id)]) {
    await busDel(key);
  }
}

// ---------- in-flight gates（审批/提问：进程内 resolver，重启即失——会话侧按拒绝/超时收场） ----------

const approvalResolvers = new Map<string, (r: ConvoApproval) => void>();
const askResolvers = new Map<string, (r: ConvoAsk) => void>();
/** convoId → 当前 turn 的 abort 控制器（打断入口） */
const turnAborts = new Map<string, AbortController>();
/** convoId → 本 turn 后台启动的 pid 集合（打断时逐个 kill） */
const turnBgPids = new Map<string, Set<number>>();

async function loadApprovals(id: string): Promise<ConvoApproval[]> {
  return (await busGet<ConvoApproval[]>(approvalsKey(id))) || [];
}

async function loadAsks(id: string): Promise<ConvoAsk[]> {
  return (await busGet<ConvoAsk[]>(asksKey(id))) || [];
}

/** 会话内"总是允许"前缀匹配（用户批准 always 后，同前缀命令不再询问） */
async function sessionAlwaysList(id: string): Promise<string[]> {
  return (await busGet<string[]>(alwaysKey(id))) || [];
}

function matchesAlways(list: string[], command: string): boolean {
  return list.some((p) => command === p || command.startsWith(p + ' ') || command.startsWith(p + '&&') || command.startsWith(p + ';'));
}

// ---------- public API（被 api/convos.ts 调用） ----------

export async function createConvo(deps: ConvoDeps, input: { project_id?: string; title?: string; model_id?: string; agent_id?: string; policy_level?: string }): Promise<Convo> {
  const projectId = input.project_id?.trim() || undefined;
  let workspace = '';
  if (projectId) {
    const proj = await getProject(projectId);
    if (!proj) throw new ConvoError(404, `project not found: ${projectId}`);
    workspace = proj.workspace || '';
    if (!workspace) throw new ConvoError(400, `project ${proj.name} 缺少 workspace，无法开启协作会话`);
  }
  const agentId = input.agent_id?.trim() || 'partner';
  const plugin = deps.orchestrator.plugins.get(agentId);
  if (!plugin) throw new ConvoError(400, `agent 不存在: ${agentId}（可用：${[...deps.orchestrator.plugins.keys()].join('、')}）`);
  if (input.model_id && !deps.pool.getModel(input.model_id)) throw new ConvoError(400, `model not in pool: ${input.model_id}`);
  const convo: Convo = {
    id: newId() + Date.now().toString(36).slice(-4),
    title: (input.title || '').trim().slice(0, 120) || '未命名会话',
    project_id: projectId,
    workspace,
    agent_id: agentId,
    model_id: input.model_id || plugin.modelOverride || undefined,
    status: 'idle',
    policy_level: input.policy_level && isPermissionLevel(input.policy_level) ? input.policy_level : undefined,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
  await busSet(convoKey(convo.id), convo);
  await emitProgress('convo_status', { convo_id: convo.id, status: 'idle', title: convo.title });
  return convo;
}

function isPermissionLevel(v: unknown): v is string {
  return ['plan_only', 'readonly', 'approve_required', 'whitelist_auto', 'full'].includes(String(v));
}

export async function updateConvo(deps: ConvoDeps, id: string, patch: { title?: string; model_id?: string | null; policy_level?: string | null; auto_switch?: boolean }): Promise<Convo> {
  const convo = await getConvo(id);
  if (!convo) throw new ConvoError(404, `convo not found: ${id}`);
  if (patch.title !== undefined) convo.title = (patch.title || '').trim().slice(0, 120) || convo.title;
  if (patch.model_id !== undefined) {
    if (patch.model_id === null || patch.model_id === '') convo.model_id = undefined;
    else {
      if (!deps.pool.getModel(patch.model_id)) throw new ConvoError(400, `model not in pool: ${patch.model_id}`);
      convo.model_id = patch.model_id;
    }
  }
  if (patch.policy_level !== undefined) convo.policy_level = patch.policy_level && isPermissionLevel(patch.policy_level) ? patch.policy_level : undefined;
  if (patch.auto_switch !== undefined) convo.auto_switch = !!patch.auto_switch;
  await saveConvo(convo);
  await emitProgress('convo_status', { convo_id: id, status: convo.status, title: convo.title, model_id: convo.model_id });
  return convo;
}

/**
 * 用户发消息。busy 时按插话模式处理：
 * - queue（默认）：消息照常入库 + 入 pending 队列，当前 turn 结束后自动继续（多条合并）；
 * - interrupt：立即打断当前 turn（abort LLM/命令 + 在飞审批/提问作废），新消息成为下一轮输入。
 */
export async function sendConvoMessage(
  deps: ConvoDeps,
  convoId: string,
  input: { text: string; images?: IncomingImage[]; model_id?: string },
  opts?: { trigger?: boolean },
): Promise<{ queued: boolean }> {
  const convo = await getConvo(convoId);
  if (!convo) throw new ConvoError(404, `convo not found: ${convoId}`);
  const text = (input.text || '').trim();
  if (!text && !input.images?.length) throw new ConvoError(400, 'message text is required');
  if (text.length > MAX_MESSAGE_LENGTH) throw new ConvoError(400, `message too long (>${MAX_MESSAGE_LENGTH})`);

  // 会话状态决定入队：busy 自动排队（打断改为排队消息上的「立即插入」显式操作）
  const busy = !!(await busGet(busyKey(convoId)));

  // 逐条消息模型覆盖（opencode 式）：合法则同步写回会话 pin
  if (input.model_id) {
    if (!deps.pool.getModel(input.model_id)) throw new ConvoError(400, `model not in pool: ${input.model_id}`);
    convo.model_id = input.model_id;
    await saveConvo(convo);
  }

  // 附图：pinned 模型带 image tag → 原生 image parts（跳过描述富化）；否则视觉描述富化（全模型可用）
  let storedImages: StoredImage[] = [];
  if (input.images?.length) {
    const native = modelSupportsImages(resolvePrimary(deps, convo).entry);
    const r = await ingestUserImages(native ? null : deps.pool, input.images, { workspace: convo.workspace || undefined });
    if (r.error) throw new ConvoError(400, r.error);
    storedImages = r.stored;
    if (!storedImages.length) throw new ConvoError(400, '附图处理失败，请重试或改为文字描述');
  }

  await appendConvoMessage(convoId, {
    role: 'user', kind: 'text', text,
    meta: {
      ...(storedImages.length ? { images: storedImages } : {}),
      ...(busy ? { queued: true } : {}),
    },
  });

  if (busy) {
    const q = (await busGet<number[]>(pendingKey(convoId))) || [];
    q.push(Date.now());
    await busSet(pendingKey(convoId), q.slice(-50));
    await emitProgress('convo_queued', { convo_id: convoId, position: q.length });
    return { queued: true };
  }
  if (opts?.trigger === false) return { queued: false };
  triggerConvoTurn(deps, convoId);
  return { queued: false };
}

/**
 * 「立即插入」：打断当前 turn，排队消息立即成为下一轮输入（多条排队合并，无需 per-message 优先级）。
 * 空闲但有排队残留 → 直接触发消费；完全空闲 → no-op。
 */
export async function promoteConvoMessage(deps: ConvoDeps, convoId: string): Promise<{ ok: boolean; promoted: boolean; interrupted: boolean }> {
  const convo = await getConvo(convoId);
  if (!convo) throw new ConvoError(404, `convo not found: ${convoId}`);
  const busy = !!(await busGet(busyKey(convoId)));
  if (busy) {
    await interruptConvo(deps, convoId);
    // turn 收尾 finally 会检测 hasPendingUserInput 重触发——排队消息自动被消费
    return { ok: true, promoted: true, interrupted: true };
  }
  const pending = (await busGet<number[]>(pendingKey(convoId))) || [];
  if (pending.length) {
    await busSet(pendingKey(convoId), []);
    triggerConvoTurn(deps, convoId);
    return { ok: true, promoted: true, interrupted: false };
  }
  return { ok: true, promoted: false, interrupted: false };
}

/** turn 消费排队消息时清除 meta.queued 标记（否则历史回放一直显示"排队中"）。 */
async function clearQueuedFlags(convoId: string): Promise<void> {
  const msgs = await getConvoMessages(convoId);
  let changed = false;
  for (const m of msgs) {
    if (m.role === 'user' && m.meta?.queued) { m.meta.queued = false; changed = true; }
  }
  if (changed) {
    await busSet(msgsKey(convoId), msgs.slice(-MAX_MESSAGES));
    await emitProgress('convo_status', { convo_id: convoId, status: (await getConvo(convoId))?.status || 'idle', queued_cleared: true });
  }
}

/** 模型是否声明了图像输入能力（model_pool tags 含 image）——决定走原生 parts 还是描述富化 */
export function modelSupportsImages(entry: ModelEntry | null): boolean {
  return !!entry && Array.isArray((entry as any).tags) && (entry as any).tags.some((t: unknown) => String(t).toLowerCase() === 'image');
}

function resolvePrimary(deps: ConvoDeps, convo: Convo): { entry: ModelEntry | null; plugin?: AgentPlugin } {
  const plugin = deps.orchestrator.plugins.get(convo.agent_id);
  const pinned = convo.model_id ? deps.pool.getModel(convo.model_id) : null;
  const viaOverride = !pinned && plugin?.modelOverride ? deps.pool.getModel(plugin.modelOverride) : null;
  // 2026-09-20 修复：未 pin 时按 professional_weight 选强模型（normal 加权随机会把并池的
  // priority=1 弱闲聊模型选成主模型，表现为"光回复不干活"）。tags 无匹配时回退全池强模型。
  const entry = pinned || viaOverride || deps.pool.selectStrongModel(plugin?.tags) || deps.pool.selectStrongModel();
  return { entry, plugin };
}

/** Kick the response loop in background（HTTP 立即返回，过程走 WS）。 */
export function triggerConvoTurn(deps: ConvoDeps, convoId: string): void {
  void runResponseLoop(deps, convoId).catch((e) => {
    if ((e as ConvoError)?.status !== 409) deps.logger.error('convo turn failed', { convoId, error: String((e as Error)?.message || e) });
  });
}

async function acquireBusy(convoId: string): Promise<boolean> {
  const existing = await busGet<number>(busyKey(convoId));
  if (existing && Date.now() - existing < 24 * 3600 * 1000) return false; // 24h TTL 兜底进程崩溃遗留
  await busSet(busyKey(convoId), Date.now());
  return true;
}

/**
 * turn 驱动条件：最后一条 assistant 回复之后还存在 user 消息。
 * 以「turn 终点」为边界——assistant 任何卡（text/tool）、以及终局系统消息
 * （interrupt / 断连 degrade / 空输出 notice）都算本轮已收场，不再自动重跑，
 * 否则模型空输出/断连时会对同一条 user 消息无限重驱动烧轮（2026-09-20 修复）。
 * 排队消息靠 pending 队列消费，不依赖这里的"重跑"。
 */
async function hasPendingUserInput(convoId: string): Promise<boolean> {
  const msgs = await getConvoMessages(convoId);
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i];
    if (m.role === 'assistant' && (m.kind === 'text' || m.kind === 'tool')) return false;
    if (m.role === 'system' && m.kind === 'interrupt') return false;
    if (m.role === 'system' && m.kind === 'degrade' && (m.meta as any)?.broken) return false;
    if (m.role === 'system' && m.kind === 'notice' && (m.meta as any)?.turn_complete) return false;
    if (m.role === 'user') return true;
  }
  return false;
}

/** 逐 turn 响应循环：transcript 有未回答的用户输入就继续跑（queue 仅作 busy 计数展示）。 */
export async function runResponseLoop(deps: ConvoDeps, convoId: string): Promise<void> {
  if (!(await acquireBusy(convoId))) throw new ConvoError(409, '该会话有一轮正在进行');
  try {
    for (;;) {
      const q = (await busGet<number[]>(pendingKey(convoId))) || [];
      if (q.length) await busSet(pendingKey(convoId), []);
      // 排队消息 append 在上一轮回复之前，不能只靠 hasPendingUserInput 判定——
      // 本轮 drain 到排队即必跑；无排队时再用 transcript 尾部 user 消息判定（恢复/重触发场景）
      if (q.length) {
        await clearQueuedFlags(convoId);
        await runTurnCore(deps, convoId);
        continue;
      }
      if (!(await hasPendingUserInput(convoId))) break;
      await clearQueuedFlags(convoId);
      await runTurnCore(deps, convoId);
    }
  } finally {
    await busDel(busyKey(convoId));
    // 兜底：turn 收尾瞬间到达的消息不丢（重触发一次；循环未退出则 409 被吞）
    if (await hasPendingUserInput(convoId)) triggerConvoTurn(deps, convoId);
  }
}

/** 停止当前 turn（只停不发）；排队消息保留，下次发消息时继续处理。 */
export async function stopConvo(deps: ConvoDeps, convoId: string): Promise<void> {
  const convo = await getConvo(convoId);
  if (!convo) throw new ConvoError(404, `convo not found: ${convoId}`);
  if (!(await busGet(busyKey(convoId)))) return;
  await interruptConvo(deps, convoId);
}

/** 打断：abort LLM 流与在飞命令 + 作废在飞审批/提问 + kill 本 turn 后台进程。 */
export async function interruptConvo(deps: ConvoDeps, convoId: string): Promise<void> {
  const ctrl = turnAborts.get(convoId);
  if (ctrl) ctrl.abort(new Error('用户打断'));
  // 在飞审批/提问连带作废（内存 resolver 释放 + KV 记录落终态，回放可见）
  const markApprovals = async () => {
    const all = await loadApprovals(convoId);
    let changed = false;
    for (const a of all) {
      if (a.status !== 'pending') continue;
      a.status = 'rejected'; a.resolved_by = 'interrupt'; a.resolved_at = new Date().toISOString(); changed = true;
    }
    if (changed) await busSet(approvalsKey(convoId), all);
  };
  const markAsks = async () => {
    const all = await loadAsks(convoId);
    let changed = false;
    for (const a of all) {
      if (a.status !== 'pending') continue;
      a.status = 'cancelled'; a.answered_at = new Date().toISOString(); changed = true;
    }
    if (changed) await busSet(asksKey(convoId), all);
  };
  await Promise.all([markApprovals(), markAsks()]);
  for (const [approvalId, resolve] of [...approvalResolvers.entries()]) {
    if (!approvalId.startsWith(convoId + ':')) continue;
    approvalResolvers.delete(approvalId);
    resolve({ id: approvalId.split(':')[1], command: '', ts: '', status: 'rejected', resolved_by: 'interrupt', resolved_at: new Date().toISOString() });
  }
  for (const [askId, resolve] of [...askResolvers.entries()]) {
    if (!askId.startsWith(convoId + ':')) continue;
    askResolvers.delete(askId);
    resolve({ id: askId.split(':')[1], question: '', ts: '', status: 'cancelled', answered_at: new Date().toISOString() });
  }
  for (const pid of turnBgPids.get(convoId) || []) killPidTree(pid, convoId);
  turnBgPids.delete(convoId);
}

function killPidTree(pid: number, ws: string): void {
  try {
    if (process.platform === 'win32') {
      spawn(`taskkill /PID ${pid} /T /F`, { shell: true, cwd: ws, stdio: 'ignore' });
    } else {
      process.kill(pid);
    }
  } catch { /* 进程已退出——fine */ }
}

// ---------- turn 核心 ----------

async function runTurnCore(deps: ConvoDeps, convoId: string): Promise<void> {
  const convo = await getConvo(convoId);
  if (!convo) return;
  const { entry: primary, plugin } = resolvePrimary(deps, convo);
  if (!primary) {
    await appendConvoMessage(convoId, { role: 'system', kind: 'notice', text: '模型池无可用模型，本轮未执行——请检查模型池配置或稍后重试。', meta: { turn_complete: true } });
    return;
  }
  const policy: PermissionPolicy = convo.policy_level ? policyFromConfig({ level: convo.policy_level, whitelist_commands: convoCfg.policy.whitelistCommands ?? undefined, max_time_sec: convoCfg.policy.maxTimeSec, allow_sensitive: convoCfg.policy.allow_sensitive }) : convoCfg.policy;
  const abort = new AbortController();
  turnAborts.set(convoId, abort);
  turnBgPids.set(convoId, new Set());
  const turn = { writes: 0, aborted: false };

  const setStatus = async (s: ConvoStatus) => {
    convo.status = s;
    await saveConvo(convo);
    await emitProgress('convo_status', { convo_id: convoId, status: s });
  };
  await setStatus('running');
  void ensureTitle(convo);

  try {
    // 首轮安全网：自动快照（git ref 锚点，回滚 API 凭此还原）
    if (!convo.snapshot_id && convo.workspace && fs.existsSync(path.join(convo.workspace, '.git'))) {
      try {
        const snap = await createSnapshot(convoId, { tag: 'convo-start', workspace: convo.workspace, note: `协作会话「${convo.title}」首轮自动快照` });
        convo.snapshot_id = snap.id;
        await saveConvo(convo);
      } catch (e) {
        deps.logger.warn('convo snapshot failed', { convoId, error: String((e as Error)?.message || e) });
      }
    }

    const system = await buildSystemPrompt(deps, convo, plugin);
    await maybeCompact(deps, convo);
    const history = await buildLlmHistory(convo.id, convo, { nativeImages: modelSupportsImages(primary) });
    const convo_msgs: { role: string; content: string | unknown[] }[] = [{ role: 'system', content: system }, ...history];
    if (!convo_msgs.some((m) => m.role === 'user')) {
      await setStatus('idle');
      return; // 没有待处理的用户输入（不应发生，防御）
    }

    let finalParsed: Record<string, any> | null = null;
    let chosen = primary;
    let turnReasoning = '';
    // 输出契约兜底检测（2026-09-20 修复）：模型未按 JSON 契约输出工具调用/回复而是直接
    // 写了散文——保留其文字（不丢用户要的答案），但必须如实告知本轮"只回复、没干活"，
    // 否则会被静默包装成成功回复，掩盖"光回复不干活"的行为。
    let plainFallback = false;
    let toolRan = false; // 本轮是否执行过工具（散文兜底 notice 只在零工具时才落，避免与事实矛盾）
    // 引擎级自纠错（2026-09-20 二轮）：嘴炮先自动纠正重试一次再采纳，别逼用户手动催
    let proseRetried = false; // 纯散文（extractJson 失败）已纠正重试
    let lazyRetried = false;  // 形态 B 口头承诺动手但零工具已纠正重试

    for (let iter = 0; iter < convoCfg.maxToolIter; iter++) {
      const last = iter === convoCfg.maxToolIter - 1;
      let stream = { acc: '', emitted: 0, lastAt: 0, sid: `${convoId}:t#${iter}` };
      const onDelta = (d: string) => {
        stream.acc += d;
        const cur = extractReplyStreaming(stream.acc);
        if (!cur) return;
        const tail = cur.value.slice(stream.emitted);
        if (!tail) return;
        if (tail.length < DELTA_MIN_CHARS && !cur.done && Date.now() - stream.lastAt < DELTA_MIN_MS) return;
        stream.emitted = cur.value.length;
        stream.lastAt = Date.now();
        void emitProgress('convo_delta', { convo_id: convoId, stream_id: stream.sid, text: tail, done: cur.done });
      };
      if (last) {
        convo_msgs.push({ role: 'user', content: '工具迭代次数已用完：不要再调用工具，立即基于已获得的信息用 reply 给出最终回复（如实说明已完成与未完成的部分）。' });
      }

      let res: LlmResponse;
      try {
        const out = await chatOnModelChain(deps, convo, primary, convo_msgs, abort.signal, onDelta, (sid) => {
          stream = { acc: '', emitted: 0, lastAt: 0, sid };
          return onDelta;
        });
        res = out.res;
        chosen = out.entry;
        turnReasoning = out.reasoning;
      } catch (e: any) {
        if (abort.signal.aborted) { turn.aborted = true; break; }
        const msg = String(e?.message || e);
        // 断连/失败终局卡：引擎已自动重试（关=10 次同模型；开=每模型 3 次×链），到此仍未成功
        await appendConvoMessage(convoId, {
          role: 'system', kind: 'degrade',
          text: convo.auto_switch
            ? `模型链全部不可用（${msg.slice(0, 120)}）——本轮未完成。可切换模型、稍后重试，或检查各供应商状态。`
            : `主模型 ${chosen.name} 调用失败（${msg.slice(0, 120)}）——已自动重试 ${convoCfg.autoRetryCount ?? 10} 次仍未成功。可在会话开启「自动切换模型」，或手动更换模型后重试。`,
          meta: { broken: true, model: chosen.name },
        });
        break;
      }
      finalParsed = extractJson(res.content);
      // 2026-09-20 修复：tool_calls 形状归一化——模型漂移出 {"name":...} / OpenAI 函数风格
      // {"function":{"name":..,"arguments":..}} 时旧 filter 会静默全丢弃，模型以为已调用
      // 工具、用户只看到口头回复（「光回复不干活」根因之一）。
      let calls = normalizeToolCalls(finalParsed?.tool_calls);
      if (!calls.length && !finalParsed && res.content.includes('"tool"')) calls = salvageToolCalls(res.content);
      if (!calls.length && finalParsed?.tool_calls !== undefined) {
        deps.logger.warn('convo tool_calls 全部无法归一化（原始输出前 600 字）', { convoId, content: res.content.slice(0, 600) });
      }

      if (calls.length && !last) {
        void emitProgress('convo_delta', { convo_id: convoId, stream_id: stream.sid, discarded: true });
        const results = await runConvoToolCalls(deps, convo, policy, calls, turn, abort.signal, chosen.name);
        if (turn.aborted) break;
        toolRan = true;
        const records = results.records;
        await appendConvoMessage(convoId, { role: 'assistant', kind: 'tool', text: activityLine(calls, results.results), model: chosen.name, meta: { calls: records } });
        await emitProgress('convo_tool', { convo_id: convoId, calls: calls.map((c) => ({ tool: c.tool, command: c.command, path: c.path })), results: results.results });
        convo_msgs.push({ role: 'assistant', content: res.content });
        convo_msgs.push({ role: 'user', content: `工具执行结果：\n${JSON.stringify(results.results).slice(0, 16000)}\n\n信息足够就用 reply 给用户最终回复；需要继续动手再发 tool_calls。` });
        continue;
      }
      if (calls.length && last) {
        finalParsed = { reply: '（工具迭代次数已用完，剩余动作未能执行。已完成的部分见上方工具记录，请指示我下一轮继续。）' };
      }
      if (!calls.length && !finalParsed) {
        // 输出契约兜底：模型偶尔不守 JSON 直接回纯文本——空判废会丢用户最想要的答案
        const plain = res.content.trim();
        const looksProse = !!plain && !plain.startsWith('{') && !plain.startsWith('```');
        if (looksProse && !proseRetried && !last && !toolRan) {
          // 引擎级自纠错：零工具的纯散文先纠正重试一次，不直接采纳（历史嘴炮污染时模型会
          // 连续散文，直接采纳会把违约写进 transcript 毒化后续轮次）。
          // 工具已执行过的散文收尾是轻微违约，直接采纳不重试（不白烧一次调用）。
          proseRetried = true;
          convo_msgs.push({ role: 'assistant', content: res.content });
          convo_msgs.push({ role: 'user', content: CORRECTIVE_JSON_MSG });
          continue;
        }
        if (looksProse) {
          plainFallback = true;
          finalParsed = { reply: plain.slice(0, MAX_MESSAGE_LENGTH) };
        }
      }
      // 引擎级自纠错：形态 B 嘴炮——零工具 + "正在动手"式声称 或 "已创建 X"假完成（工作区核验）→ 纠正重试一次
      if (!calls.length && finalParsed && !toolRan && !lazyRetried && !last && iter < convoCfg.maxToolIter - 1) {
        const replyText = String(finalParsed.reply || '');
        const falseClaims = findFalseFileClaims(replyText, convo.workspace);
        if (replyText && (ACTION_CLAIM_RE.test(replyText) || falseClaims.length > 0)) {
          lazyRetried = true;
          convo_msgs.push({ role: 'assistant', content: res.content });
          convo_msgs.push({ role: 'user', content: CORRECTIVE_ACT_MSG + (falseClaims.length ? ` 另外你声称已创建/写入的 ${falseClaims.join('、')} 在工作区中并不存在——不要虚构完成状态，实际执行后以工具结果为准。` : '') });
          finalParsed = null; // 本条口头承诺作废，重驱动
          continue;
        }
      }
      break;
    }

    if (turn.aborted) {
      await appendConvoMessage(convoId, { role: 'system', kind: 'interrupt', text: '用户打断了本轮执行；已完成的工作保留在工作区（见 diff），输入新指令继续。' });
    } else if (finalParsed) {
      const reply = String(finalParsed.reply || '').trim().slice(0, MAX_MESSAGE_LENGTH);
      if (reply) {
        const shares = Array.isArray(finalParsed.share_files) ? finalParsed.share_files.map(String).slice(0, 5) : [];
        await appendConvoMessage(convoId, {
          role: 'assistant', kind: 'text', text: reply, model: chosen.name,
          meta: {
            share_files: shares,
            ...(turnReasoning ? { reasoning: turnReasoning.slice(-6000) } : {}),
            ...(plainFallback ? { contract_violation: true } : {}),
          },
        });
        // 散文兜底（2026-09-20 修复）：模型没走 JSON 契约（无 tool_calls / reply 结构）时如实告知。
        // 只在本轮零工具活动时落 notice——工具已真实执行过的轮次，散文收尾只是轻微违约，
        // 落"未执行任何实际改动"会与事实矛盾（E2E 实测误报）。
        if (plainFallback && !toolRan) {
          await appendConvoMessage(convoId, { role: 'system', kind: 'notice', text: `本轮模型未按输出契约返回 JSON（已自动纠正重试${proseRetried ? ' 1 次' : ''}仍未恢复），仅返回了纯文本。以上内容仅为其原话，本轮未执行任何实际改动；如需动手请重发，或更换模型。` });
        }
        // 嘴炮纠正后最终回复仍零工具：落诚实 notice，用户不必信以为真（2026-09-20 实测"已创建"假完成）
        if (lazyRetried && !toolRan) {
          const falseClaims = findFalseFileClaims(reply, convo.workspace);
          await appendConvoMessage(convoId, { role: 'system', kind: 'notice', text: `提醒：本轮模型${falseClaims.length ? `声称已完成的 ${falseClaims.join('、')} 在工作区中不存在` : '声称的工作未经任何工具执行'}——以上回复不可当作完成依据，请以工具记录与 diff 卡为准，或重发指令/更换模型。` });
        }
        for (const p of shares) {
          const rel = p.replace(/\\/g, '/');
          const abs = path.resolve(convo.workspace, rel);
          const ok = convo.workspace && abs.startsWith(path.resolve(convo.workspace)) && fs.existsSync(abs) && fs.statSync(abs).isFile();
          await appendConvoMessage(convoId, {
            role: 'assistant', kind: 'file', text: rel,
            meta: ok ? { path: rel, size: fs.statSync(abs).size, missing: false } : { path: rel, missing: true },
          });
        }
      } else {
        await appendConvoMessage(convoId, { role: 'system', kind: 'notice', text: '本轮输出为空或无法解析——请换个说法重试，或更换模型。', meta: { turn_complete: true } });
      }
    } else {
      // finalParsed 为 null 且未打断（纯空输出，连散文都没有）：必须落终态标记，
      // 否则 hasPendingUserInput 会认为仍有待处理输入，对同一条消息无限重驱动（2026-09-20 修复）
      await appendConvoMessage(convoId, { role: 'system', kind: 'notice', text: '本轮模型无任何输出——请换个说法重试，或更换模型。', meta: { turn_complete: true } });
    }

    // 每轮 diff 卡片：有过文件写入才落（git 仓库才有）
    if (turn.writes > 0 && convo.workspace && fs.existsSync(path.join(convo.workspace, '.git'))) {
      try {
        const g = simpleGit({ baseDir: convo.workspace });
        const status = await g.status(['--porcelain']);
        const files = status.files.slice(0, 12).map((f) => `${f.working_dir} ${f.path}`);
        const patch = (await g.diff([])).slice(-2400);
        await appendConvoMessage(convoId, { role: 'system', kind: 'diff', text: files.join('\n'), meta: { files, patch } });
      } catch { /* 非 git 仓库无 diff */ }
    }
  } finally {
    turnAborts.delete(convoId);
    turnBgPids.delete(convoId);
    await setStatus('idle');
  }
}

// ---------- model chain（降级 + 显著提示） ----------

async function chatOnModelChain(
  deps: ConvoDeps,
  convo: Convo,
  primary: ModelEntry,
  msgs: { role: string; content: string | unknown[] }[],
  signal: AbortSignal,
  onDelta: (d: string) => void,
  onAttempt: (sid: string) => (d: string) => void,
): Promise<{ res: LlmResponse; entry: ModelEntry; reasoning: string }> {
  const autoSwitch = convo.auto_switch === true;
  const perModelRetries = autoSwitch ? 3 : convoCfg.autoRetryCount;

  // 候选链：404 冷却中的模型直接剔除（确定性配置错误，24h 内不再撞）
  const now = Date.now();
  for (const [mid, until] of [...model404Cooldown.entries()]) if (until < now) model404Cooldown.delete(mid);
  let chain = deps.pool
    .fallbackChain(primary, deps.orchestrator.plugins.get(convo.agent_id)?.tags)
    .filter((m) => !model404Cooldown.has(m.id || ''))
    .slice(0, autoSwitch ? MAX_SPEAKER_MODEL_CHAIN : 1);
  // 自动切换关：只用 pin 的主模型（重试 AUTO_RETRY_COUNT 次），不降级
  if (!autoSwitch) chain = [primary];
  // 开：主模型处于 429 冷却（noteCapacityHit）且链上有健康备选 → 从备选起步，静默
  if (autoSwitch && chain.length > 1) {
    const st = deps.pool.getStatus()[primary.id || ''] as { fail_count?: number } | undefined;
    if (st && Number(st.fail_count || 0) > 0 && chain[0].id === primary.id) chain = chain.slice(1);
  }
  if (!chain.length) chain = [primary];

  let lastReason = '';
  let lastSid = '';
  let degradedFrom = '';
  let degradedTo = '';

  const dropStream = (sid: string) => {
    if (sid) void emitProgress('convo_delta', { convo_id: convo.id, stream_id: sid, discarded: true });
  };
  const maybeDegradeCard = async (from: string, to: string, cause: string) => {
    // 2026-09-20 修复：degradeSilence 只增不减——顺手清理超过静默期数倍的老条目，防长期运行内存缓增
    const now = Date.now();
    for (const [k, ts] of [...degradeSilence.entries()]) {
      if (now - ts > DEGRADE_SILENCE_MS * 24) degradeSilence.delete(k);
    }
    const key = `${convo.id}:${to}`;
    const last = degradeSilence.get(key) || 0;
    if (now - last < DEGRADE_SILENCE_MS) return; // 静默期：同目标不重复落卡
    degradeSilence.set(key, now);
    await appendConvoMessage(convo.id, {
      role: 'system', kind: 'degrade',
      text: `主模型 ${from} 不可用（${cause.slice(0, 90)}），已自动降级为 ${to} 继续。`,
      meta: { primary: from, actual: to },
    });
  };

  for (let mi = 0; mi < chain.length; mi++) {
    const entry = chain[mi];
    for (let attempt = 0; attempt < perModelRetries; attempt++) {
      if (signal.aborted) throw new Error('LLM 调用被外部取消');
      try {
        let reasonBuf = '';
        let reasonLastAt = 0;
        const onReason = (d: string) => {
          reasonBuf += d;
          if (d.length >= 24 || Date.now() - reasonLastAt > 1000) {
            reasonLastAt = Date.now();
            void emitProgress('convo_reason', { convo_id: convo.id, text: d });
          }
        };
        lastSid = `${convo.id}#m${mi}a${attempt}`;
        const res = await chat(entry, msgs, undefined, 0.3, signal, WALLCLOCK_CAP_MS, onAttempt(lastSid), { onReason });
        // 成功：从非主模型应答 → 落降级卡（静默期去重）；主模型重试成功 → 落恢复卡
        if (mi > 0) await maybeDegradeCard(primary.name, entry.name, lastReason);
        else if (attempt > 0 && degradedTo === entry.name) {
          await appendConvoMessage(convo.id, { role: 'system', kind: 'degrade', text: `主模型 ${primary.name} 已恢复，本轮起切回继续。`, meta: { recovered: true } });
        }
        return { res, entry, reasoning: reasonBuf };
      } catch (e: any) {
        if (signal.aborted) throw e;
        const reason = String(e?.message || e);
        lastReason = reason;
        dropStream(lastSid); // 清掉本次 attempt 流出的半截内容
        if (is404(reason)) {
          model404Cooldown.set(entry.id || entry.name, Date.now() + MODEL_404_COOLDOWN_MS);
          if (autoSwitch) {
            await appendConvoMessage(convo.id, { role: 'system', kind: 'notice', text: `模型 ${entry.name} 在该供应商不存在（404），已停用 24 小时——请检查模型名或在设置中修正。` });
            break; // 换链上下一个（不重试）
          }
          throw new Error(`模型 ${entry.name} 在该供应商不存在（404）——请检查模型名或更换模型（不重试）`);
        }
        const capacity = CAPACITY_RE.test(reason);
        if (capacity) deps.pool.noteCapacityHit(entry);
        // 重试退避（最后一次不再等）
        if (attempt < perModelRetries - 1) {
          await new Promise((r) => setTimeout(r, retryDelayMs(attempt)));
          continue;
        }
        // 本模型重试耗尽
        if (autoSwitch && mi < chain.length - 1) {
          degradedFrom = degradedFrom || primary.name;
          degradedTo = chain[mi + 1].name;
          break; // 换下一个模型
        }
        throw new Error(`${entry.name} 连续 ${perModelRetries} 次调用失败（${reason.slice(0, 120)}）——模型可能已断开`);
      }
    }
  }
  throw new Error(lastReason || '模型链全部失败');
}

// ---------- system prompt（静态前缀：单 turn 内字节稳定） ----------

async function buildSystemPrompt(deps: ConvoDeps, convo: Convo, plugin?: AgentPlugin): Promise<string> {
  const identity = plugin?.prompt?.trim()
    || '你是「搭档」，与用户结对协作的工程 agent：直接读写项目工作区、执行命令、交付改动。';
  const proj = convo.project_id ? await getProject(convo.project_id) : null;
  const memories = convo.project_id ? await getProjectMemory(convo.project_id, 8) : [];
  const wsBlock = convo.workspace ? `\n## 工作区\n项目根目录（你的工作目录，所有相对路径基于它）：${convo.workspace}${proj ? `\n项目名：${proj.name}` : ''}` : '';

  const scripts: string[] = [];
  if (convo.workspace) {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(convo.workspace, 'package.json'), 'utf-8'));
      for (const [k, v] of Object.entries(pkg.scripts || {})) scripts.push(`  - npm run ${k}: ${v}`);
    } catch { /* 无 package.json */ }
  }

  const allSkills = getSkills();
  const picks = pickSkillsForNode(allSkills, (plugin ?? { skills: [], tags: [] }) as any, convo.title || '协作会话');
  const skillsBlock = [
    formatSkillsCatalog(allSkills),
    picks.length ? `\n与本会话标题相关的技能（建议优先）：\n${formatSkillsBlock(picks)}` : '',
  ].filter(Boolean).join('\n');
  const availableSkills = picks.map((p) => p.skill.name);
  (convo as any).__availableSkills = availableSkills;

  const mcpBlock = deps.mcp ? deps.mcp.toolsIndex(convo.agent_id) : '';

  return `${identity}
# 角色边界
你运行在「协作会话」中：用户在与你结对开发真实项目。你的所有改动**直接落在项目工作区**（没有沙箱合并步骤），因此：
- 改前先看（read_file/list_files），改完必验证（构建/测试/渲染检查）；
- 每轮结束系统会自动落 git diff 卡片给用户审阅；会话首轮已自动创建快照，用户可一键回滚——但你不能依赖回滚，危险操作（删库、重置、覆盖大量文件）必须先与用户确认；
- 该工作区可能同时有其他任务/会话在并行改动，对文件内容做"读-改-写"时要基于刚读到的最新内容。

${wsBlock}
${scripts.length ? `\n## 项目脚本\n${scripts.join('\n')}` : ''}
${memories.length ? `\n## 本项目经验与规范\n${memories.map((m) => `- ${m.text}`).join('\n')}` : ''}
${skillsBlock ? `\n## 技能索引（正文按需 load_skill 拉取）\n${skillsBlock}` : ''}
${mcpBlock ? `\n## 外部 MCP 工具（参数放独立 arguments 字段）\n${mcpBlock}` : ''}

## 工具指南（全部相对路径基于工作区）
只读侦查： {"tool":"list_files"} | {"tool":"read_file","path":"...","line_start":N,"line_end":M} | {"tool":"read_dir","path":"..."} | {"tool":"grep","pattern":"正则","path":"可选子路径"} | {"tool":"git_log"} | {"tool":"git_diff"} | {"tool":"load_skill","name":"技能名"}
执行命令（同步等待 ≤${convoCfg.execTimeoutSec}s：装依赖、构建、测试、查端口）：
 {"tool":"exec","command":"npm test"}
长驻服务（后台启动返回 pid 与日志路径）： {"tool":"exec_background","command":"npm run dev"}   停止： {"tool":"kill_process","pid":12345}
修改文件（直接写入项目工作区，改前先读）：
 {"tool":"write_file","path":"相对路径","content":"文件全文"} 或 {"tool":"edit_file","path":"相对路径","find":"原文片段","replace":"新片段"}
视觉辅助： {"tool":"screenshot","url":"http://localhost:PORT/","question":"..."} | {"tool":"look_image","path":"相对路径","question":"..."} | 渲染验证 {"tool":"check_page","url":"...","expect":["关键文本"]}
阻塞提问（需要用户拍板才能继续时）： {"tool":"ask_user","question":"问题"}   知识沉淀： {"tool":"write_knowledge","category":"general-tech|project","title":"标题","content":"内容"}
反馈文件给用户（文件卡片，可预览下载）： {"tool":"share_file","path":"相对路径"}
调度子智能体（并行 ≤3，各自独立工具循环；适合并行侦查/评审/测试等分工）： {"tool":"spawn_agent","agent":"dev|review|docs|test|...","task":"明确的子任务描述"}
任务步骤清单（多文件/多验证环节的活先规划再动手，逐步打勾；简单问答不要用）：
 {"tool":"write_plan","steps":["步骤1","步骤2","..."]}   {"tool":"update_plan","index":N,"status":"done|in_progress|blocked"}
${mcpBlock ? '外部 MCP 工具： {"tool":"mcp__<服务>__<工具>","arguments":{...}}' : ''}

## 输出契约（最终输出必须是纯 JSON，禁止 markdown 代码栅栏）
A 需要动手：{"tool_calls":[ {"tool":"..."}, ... ]}
   ⚠️ 数组每一项必须以 "tool" 字段开头（如 {"tool":"read_file","path":"a.ts"}）；禁止用 name/function 包裹参数。
B 回复用户：{"reply":"给用户的完整回复（markdown）","share_files":["可选：反馈给用户的文件相对路径"]}
工具结果以 user 消息回喂；信息足够就用 B 收尾，需要继续就发 A。用户随时可能插话（排队/打断），被打断后如实汇报已完成部分。
🚫 最严重违约：用 B 说"即将动手/正在执行/第一步是…"却一个 tool_calls 都不发——口头承诺不算执行，用户只会看到空话。要么此刻就发 A，要么用 B 明确说明你在等待什么、缺什么。

## 行动优先
- 侦查是手段不是目的：需要动手时第一批工具就把关键侦查+主动作发出，不要用"接下来我将…"的口头承诺收尾；
- 长对话纪律：结论与决策尽量落盘（写进文件或 write_knowledge），不要指望"记在上下文里"；
- 收到多环节任务先 write_plan（3~8 步）并把第一步置 in_progress，每完成一步立即 update_plan 打勾——用户在 UI 上实时看进度，绝不允许做完才一次性汇报。`;
}

/** LLM 视角的历史：压缩摘要前置 + 只保留 upto 之后的消息（text/file 类；tool/notice 的结果已反映在后续 assistant 文本里） */
async function buildLlmHistory(convoId: string, convo: Convo, opts?: { nativeImages?: boolean }): Promise<{ role: string; content: string | unknown[] }[]> {
  const all = await getConvoMessages(convoId);
  let msgs = all;
  const chat: { role: string; content: string | unknown[] }[] = [];
  if (convo.compaction) {
    const idx = all.findIndex((m) => m.id === convo.compaction!.upto_id);
    if (idx >= 0) {
      chat.push({ role: 'user', content: `## 此前会话摘要（系统自动压缩，早期历史已折叠）\n${convo.compaction.summary}\n（摘要之后的消息保持原文；仍缺失的信息请用只读工具重新侦查，不要臆测。）` });
      msgs = all.slice(idx + 1);
    }
  }
  for (const m of msgs.slice(-HISTORY_MSGS)) {
    if (m.role === 'user' && m.kind === 'text') {
      const imgs = Array.isArray(m.meta?.images) ? (m.meta.images as StoredImage[]) : [];
      const files = Array.isArray(m.meta?.files) ? (m.meta.files as { name: string; wsPath?: string }[]) : [];
      let text = m.text;
      if (files.length) text += `\n${files.map((f, i) => `[用户上传文件 ${i + 1}: ${f.name}]${f.wsPath ? ` → ${f.wsPath}（用 read_file 读取）` : '（已失效）'}`).join('\n')}`;
      // 原生 image parts：pinned 模型带 image tag 时，把落盘图片读为 dataURL 进 content 数组；
      // 读不到（保留策略清了旧图/非本地）则降级为富化文本
      if (imgs.length && opts?.nativeImages) {
        const parts = nativeImageParts(imgs);
        if (parts) {
          chat.push({ role: 'user', content: [{ type: 'text', text: text || '（用户发来图片）' }, ...parts] });
          continue;
        }
      }
      if (imgs.length) text += `\n${renderImagesForContext(imgs)}`;
      chat.push({ role: 'user', content: text });
    } else if (m.role === 'user' && m.kind === 'file') {
      chat.push({ role: 'user', content: m.text });
    } else if (m.role === 'assistant' && (m.kind === 'text' || m.kind === 'tool')) {
      // 2026-09-20 修复：tool 活动卡（activityLine 摘要）也进 LLM 历史——此前只留 text，
      // 跨轮后模型只能靠自己上轮的最终回复概括去回忆工具结果，弱模型概括不全就"失忆继续聊"。
      // 契约违约的散文回复（contract_violation）不进历史——嘴炮留在上下文里会被模型
      // 当作"我上轮就是这么答的"模式续写，历史越毒越嘴炮（2026-09-20 实证死亡螺旋）。
      if (m.kind === 'text' && (m.meta as any)?.contract_violation) continue;
      chat.push({ role: 'assistant', content: m.text });
    }
  }
  return chat;
}

/** 把 StoredImage 引用读为 OpenAI 兼容的 image_url parts；全部可读才返回（部分可读也返回可读的）。 */
function nativeImageParts(imgs: StoredImage[]): unknown[] | null {
  const { mediaDir } = require('./media') as typeof import('./media');
  const IMAGE_MEDIA: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp' };
  const parts: unknown[] = [];
  for (const img of imgs) {
    try {
      const file = path.join(mediaDir(), path.basename(img.url));
      if (!fs.existsSync(file)) continue;
      const ext = path.extname(file).toLowerCase();
      const mime = IMAGE_MEDIA[ext];
      if (!mime) continue;
      const b64 = fs.readFileSync(file).toString('base64');
      parts.push({ type: 'image_url', image_url: { url: `data:${mime};base64,${b64}` } });
    } catch { /* 单图失败跳过 */ }
  }
  return parts.length ? parts : null;
}

// ---------- 工具执行 ----------

interface ToolRunResult { results: unknown[]; records: { tool: string; args_summary?: string; output_gist?: string; ok?: boolean; mcp?: { server: string; tool: string } }[] }

/** 模型常见工具名幻觉 → 真实工具（实测 Qwen3.6/DeepSeek 会混用 opencode/codex 风格命名） */
const TOOL_ALIASES: Record<string, string> = {
  list_directory: 'read_dir', list_dir: 'read_dir', ls: 'read_dir', dir: 'read_dir', list: 'list_files',
  read: 'read_file', cat: 'read_file', open_file: 'read_file',
  write: 'write_file', create_file: 'write_file', edit: 'edit_file', apply_patch: 'edit_file',
  bash: 'exec', shell: 'exec', terminal: 'exec', run: 'exec', execute: 'exec', run_command_line: 'exec',
  search: 'grep', grep_search: 'grep', find: 'grep',
  spawn_subagent: 'spawn_agent', task: 'spawn_agent', delegate: 'spawn_agent',
  view_image: 'look_image', browse: 'check_page', fetch_page: 'check_page',
};

async function runConvoToolCalls(
  deps: ConvoDeps,
  convo: Convo,
  policy: PermissionPolicy,
  calls: Record<string, any>[],
  turn: { writes: number; aborted: boolean },
  signal: AbortSignal,
  modelName: string,
): Promise<ToolRunResult> {
  const results: unknown[] = [];
  const records: ToolRunResult['records'] = [];
  const roSet = new Set(['list_files', 'read_file', 'read_dir', 'grep', 'git_log', 'git_diff', 'write_knowledge', 'load_skill', 'check_page', 'screenshot', 'look_image']);
  const availableSkills: string[] = (convo as any).__availableSkills || [];
  const knowledgeCtx: KnowledgeToolContext = { agent: convo.agent_id, project_id: convo.project_id, availableSkills };
  const vision = { analyze: (prompt: string, images: { base64: string; mediaType: string }[]) => analyzeImages(deps.pool, prompt, images) };

  const argsSummary = (c: Record<string, any>): string => {
    const v = c.command || c.path || c.pattern || c.url || c.name || c.question || '';
    return String(v).slice(0, 120);
  };

  // spawn_agent 批量前置：同批可带多个 spawn（≤3 并发），结果按调用序插入，剩余调用照常执行
  const spawnCalls = calls.filter((c) => String(c.tool || '').toLowerCase() === 'spawn_agent');
  const nonSpawnCalls = calls.filter((c) => String(c.tool || '').toLowerCase() !== 'spawn_agent');
  const spawnFirst = spawnCalls.length > 0;
  if (spawnFirst) {
    const sem = createSpawnSemaphore(3);
    const spawnResults = await Promise.all(spawnCalls.map(async (call) => {
      await sem.acquire();
      try {
        if (signal.aborted) return { call, r: { tool: 'spawn_agent', ok: false, error: '用户打断了本轮执行' } as Record<string, any> };
        const r = await runSubAgent(deps, convo, policy, String(call.agent || ''), String(call.task || ''), turn, signal);
        return { call, r };
      } finally {
        sem.release();
      }
    }));
    for (const { call, r } of spawnResults) {
      results.push(r);
      records.push({ tool: 'spawn_agent', args_summary: `${call.agent || '?'} · ${String(call.task || '').slice(0, 80)}`, output_gist: gist(r), ok: (r as any)?.ok !== false });
    }
  }

  for (const call of nonSpawnCalls) {
    if (signal.aborted) { turn.aborted = true; results.push({ tool: call.tool, ok: false, error: '用户打断了本轮执行' }); continue; }
    // 常见工具名幻觉纠偏（实测 Qwen3.6 会写 list_directory / bash 等）：归一到真实工具，避免整轮空转
    const rawName = String(call.tool || '').toLowerCase();
    const name = (TOOL_ALIASES as Record<string, string>)[rawName] || rawName;
    if (name !== rawName) call.tool = name;
    try {
      if (roSet.has(name)) {
        const r = await applyToolCalls(convo.workspace, [call as any], knowledgeCtx, policy);
        results.push(r[0]);
        records.push({ tool: name, args_summary: argsSummary(call), output_gist: gist(r[0]), ok: (r[0] as any)?.ok !== false });
        continue;
      }
      if (name.startsWith('mcp__')) {
        const bridge = deps.mcp;
        if (!bridge) { results.push({ tool: name, ok: false, error: '本系统未接入 MCP 服务' }); continue; }
        const rest = name.slice('mcp__'.length);
        const sep = rest.indexOf('__');
        const server = sep > 0 ? rest.slice(0, sep) : '';
        const toolName = sep > 0 ? rest.slice(sep + 2) : '';
        if (!server || !toolName) { results.push({ tool: name, ok: false, error: '工具名格式必须是 mcp__<服务>__<工具>' }); continue; }
        let args = (call as { arguments?: unknown }).arguments;
        if (!args || typeof args !== 'object' || Array.isArray(args)) {
          const { tool: _t, arguments: _a, ...flat } = call as Record<string, unknown>;
          args = flat;
        }
        try {
          const r = await bridge.callTool(convo.agent_id, server, toolName, args as Record<string, unknown>);
          results.push({ tool: name, ok: r.ok, server, ...(r.ok ? { output: r.text, ...(r.truncated ? { truncated: true } : {}) } : { error: r.error }) });
          records.push({ tool: name, args_summary: argsSummary(call),           output_gist: r.ok ? (r.text || '').slice(0, 200) : (r.error || '').slice(0, 200), ok: r.ok, mcp: { server, tool: toolName } });
        } catch (e: any) {
          results.push({ tool: name, ok: false, server, error: String(e?.message || e).slice(0, 200) });
        }
        continue;
      }
      if (name === 'exec' || name === 'exec_command' || name === 'run_command') {
        const r = await convoExec(deps, convo, policy, String(call.command || '').trim(), signal, false);
        results.push(r); records.push({ tool: 'exec', args_summary: argsSummary(call), output_gist: gist(r), ok: (r as any)?.ok !== false });
        continue;
      }
      if (name === 'exec_background' || name === 'start_process') {
        const r = await convoExec(deps, convo, policy, String(call.command || '').trim(), signal, true);
        results.push(r); records.push({ tool: 'exec_background', args_summary: argsSummary(call), output_gist: gist(r), ok: (r as any)?.ok !== false });
        continue;
      }
      if (name === 'kill_process') {
        const pid = Number(call.pid);
        if (!Number.isInteger(pid) || pid <= 0) { results.push({ tool: 'kill_process', ok: false, error: 'pid 必须是正整数' }); continue; }
        killPidTree(pid, convo.workspace || process.cwd());
        results.push({ tool: 'kill_process', ok: true, pid });
        records.push({ tool: 'kill_process', args_summary: String(pid), ok: true });
        continue;
      }
      if (name === 'write_file' || name === 'edit_file') {
        const r = await convoWrite(deps, convo, policy, call);
        if ((r as any)?.ok !== false) turn.writes++;
        results.push(r); records.push({ tool: name, args_summary: argsSummary(call), output_gist: gist(r), ok: (r as any)?.ok !== false });
        continue;
      }
      if (name === 'ask_user') {
        const question = String(call.question || '').trim().slice(0, 2000);
        if (!question) { results.push({ tool: 'ask_user', ok: false, error: 'question 不能为空' }); continue; }
        const r = await convoAsk(deps, convo, question);
        results.push(r); records.push({ tool: 'ask_user', args_summary: question.slice(0, 120), output_gist: gist(r), ok: (r as any)?.ok !== false });
        continue;
      }
      if (name === 'write_plan') {
        const steps = Array.isArray(call.steps) ? call.steps.map((x: unknown) => String(x).trim().slice(0, 200)).filter(Boolean).slice(0, 10) : [];
        if (!steps.length) { results.push({ tool: name, ok: false, error: 'steps 不能为空（3~8 条为宜）' }); continue; }
        const cur = await getConvo(convo.id);
        if (!cur) { results.push({ tool: name, ok: false, error: '会话不存在' }); continue; }
        cur.plan = { steps: steps.map((t) => ({ text: t, status: 'pending' as const, ts: new Date().toISOString() })), updated_at: new Date().toISOString() };
        await saveConvo(cur);
        await emitProgress('convo_plan', { convo_id: convo.id, plan: cur.plan });
        results.push({ tool: name, ok: true, steps: steps.length, note: '已创建步骤清单——每完成一步必须 update_plan 打勾。' });
        records.push({ tool: name, args_summary: steps.join(' / ').slice(0, 120), output_gist: `规划 ${steps.length} 步`, ok: true });
        continue;
      }
      if (name === 'update_plan') {
        const idx = Number(call.index);
        const status = String(call.status || '');
        if (!Number.isInteger(idx) || idx < 0) { results.push({ tool: name, ok: false, error: 'index 必须是非负整数' }); continue; }
        if (!['done', 'in_progress', 'blocked'].includes(status)) { results.push({ tool: name, ok: false, error: 'status 必须是 done | in_progress | blocked' }); continue; }
        const cur = await getConvo(convo.id);
        const steps = cur?.plan?.steps;
        if (!cur || !steps) { results.push({ tool: name, ok: false, error: '尚无步骤清单——先 write_plan' }); continue; }
        if (idx >= steps.length) { results.push({ tool: name, ok: false, error: `index 越界（共 ${steps.length} 步）` }); continue; }
        steps[idx].status = status as 'done' | 'in_progress' | 'blocked';
        steps[idx].ts = new Date().toISOString();
        cur.plan!.updated_at = steps[idx].ts;
        // 自动推进：置 done 后将下一个 pending 步置 in_progress（UI 无需等模型二次调用）
        if (status === 'done') {
          const next = steps.find((x) => x.status === 'pending');
          if (next) next.status = 'in_progress';
        }
        await saveConvo(cur);
        await emitProgress('convo_plan', { convo_id: convo.id, plan: cur.plan });
        const done = steps.filter((x) => x.status === 'done').length;
        results.push({ tool: name, ok: true, progress: `${done}/${steps.length}` });
        records.push({ tool: name, args_summary: `${idx + 1}. ${steps[idx].text}`.slice(0, 120), output_gist: `进度 ${done}/${steps.length}`, ok: true });
        continue;
      }
      if (name === 'share_file') {
        const rel = String(call.path || '').trim().replace(/\\/g, '/');
        const abs = convo.workspace ? path.resolve(convo.workspace, rel) : '';
        const ok = !!rel && !!convo.workspace && abs.startsWith(path.resolve(convo.workspace)) && fs.existsSync(abs) && fs.statSync(abs).isFile();
        if (!ok) { results.push({ tool: 'share_file', ok: false, path: rel, error: '文件不存在或越界（目录监狱）' }); continue; }
        await appendConvoMessage(convo.id, { role: 'assistant', kind: 'file', text: rel, meta: { path: rel, size: fs.statSync(abs).size } });
        results.push({ tool: 'share_file', ok: true, path: rel });
        records.push({ tool: 'share_file', args_summary: rel, ok: true });
        continue;
      }
      results.push({ tool: name, ok: false, error: `会话内不允许的工具: ${name}` });
      records.push({ tool: name, args_summary: argsSummary(call), output_gist: `会话内不允许的工具: ${name}`, ok: false });
    } catch (e: any) {
      // 软错误纪律：一次工具异常绝不炸毁整个 turn
      results.push({ tool: call.tool, ok: false, error: String(e?.message || e).slice(0, 200) });
    }
  }
  return { results, records };
}

function gist(r: unknown): string {
  if (!r || typeof r !== 'object') return '';
  const o = r as Record<string, any>;
  if (o.error) return String(o.error).slice(0, 200);
  const body = o.output || o.analysis || o.content || o.stdout || o.body || o.text || '';
  return String(body).replace(/\s+/g, ' ').slice(0, 200);
}

function activityLine(calls: Record<string, any>[], results: unknown[]): string {
  const segs: string[] = [];
  calls.forEach((c, i) => {
    const t = String(c.tool || '').toLowerCase();
    const r = (results[i] || {}) as Record<string, any>;
    const ok = r.ok !== false;
    if (t === 'exec' || t === 'exec_command' || t === 'run_command') segs.push(`${ok ? '✓' : '✗'} exec「${String(c.command || '').slice(0, 50)}」${r.returncode !== undefined ? `exit ${r.returncode}` : ''}`);
    else if (t === 'exec_background') segs.push(`${ok ? '✓' : '✗'} 后台启动「${String(c.command || '').slice(0, 40)}」pid ${r.pid ?? '?'}`);
    else if (t === 'kill_process') segs.push(`停止进程 ${c.pid}${ok ? '' : ' 失败'}`);
    else if (t === 'write_file' || t === 'edit_file') segs.push(`${ok ? '✓' : '✗'} ${ok ? '写入' : '写入失败'} ${String(r.path || c.path || '').slice(0, 40)}`);
    else if (t === 'ask_user') segs.push('向用户提问');
    else if (t === 'share_file') segs.push(`反馈文件 ${String(c.path || '').slice(0, 40)}`);
    else if (t === 'spawn_agent') segs.push(`子智能体 ${c.agent || '?'}${!ok ? ' 失败' : r.summary ? ` · ${String(r.summary).slice(0, 30)}` : ''}`);
    else if (t === 'write_plan') segs.push(`${!ok ? '✗ 规划失败' : `规划 ${r.steps || '?'} 步`}`);
    else if (t === 'update_plan') segs.push(`${!ok ? '✗ 打勾失败' : `进度 ${r.progress || '?'}`}`);
    else if (t.startsWith('mcp__')) segs.push(`${ok ? '✓' : '✗'} MCP ${t.slice(5)}${ok ? '' : ' 失败'}`);
    else segs.push(`${ok ? '✓' : '✗'} ${t}`);
  });
  return segs.join(' · ') || '（无工具调用）';
}

/** exec / exec_background：权限分级 → 敏感/strict 拦截 → 审批 park → 执行（含监狱与超时） */
async function convoExec(deps: ConvoDeps, convo: Convo, policy: PermissionPolicy, command: string, signal: AbortSignal, background: boolean): Promise<Record<string, any>> {
  const tool = background ? 'exec_background' : 'exec';
  if (!command) return { tool, ok: false, error: 'command 不能为空' };
  if (!convo.workspace) return { tool, ok: false, error: '会话未绑定项目工作区，无法执行命令' };
  if (policy.level === 'plan_only' || policy.level === 'readonly') return { tool, ok: false, error: `会话权限为 ${policy.level}，不允许执行命令；请用户在会话设置调整权限级别` };
  const cls = classifyCommand(command);
  if (cls.strict) return { tool, ok: false, sensitive: true, error: `绝对禁止的命令（${cls.reasons.join('、')}）——任何配置下都不允许执行` };

  const always = await sessionAlwaysList(convo.id);
  const needApproval = !canExecute(policy, command) || (cls.sensitive && !policy.allow_sensitive);
  if (needApproval && !matchesAlways(always, command)) {
    const verdict = await parkForApproval(deps, convo, command);
    if (verdict.status === 'rejected') return { tool, ok: false, error: '用户拒绝执行该命令' };
    if (verdict.status === 'approved_always') {
      const list = await sessionAlwaysList(convo.id);
      list.push(command);
      await busSet(alwaysKey(convo.id), list.slice(-30));
    }
  }

  if (background) {
    const logDir = path.join(convo.workspace, '.coteam-logs');
    fs.mkdirSync(logDir, { recursive: true });
    const logPath = path.join(logDir, `${new Date().toISOString().replace(/[:.]/g, '-')}-${Math.random().toString(36).slice(2, 6)}.log`);
    const fd = fs.openSync(logPath, 'a');
    const proc = spawn(command, { cwd: convo.workspace, shell: true, detached: true, stdio: ['ignore', fd, fd] });
    proc.unref();
    fs.closeSync(fd);
    const pids = turnBgPids.get(convo.id);
    if (proc.pid && pids) pids.add(proc.pid);
    return {
      tool, ok: true, pid: proc.pid, command,
      log: path.relative(convo.workspace, logPath).replace(/\\/g, '/'),
      note: '已后台启动（不代表成功）。等待数秒后用 exec 查端口/curl，或 read_file 看日志确认真实状态。',
    };
  }
  // 审批通过（once/always）= 用户的白名单授权：按完全控制执行（监狱与 strict 拦截仍生效）
  const execPolicy: PermissionPolicy = needApproval
    ? { level: 'full', whitelistCommands: null, maxTimeSec: policy.maxTimeSec, allow_sensitive: policy.allow_sensitive }
    : policy;
  const r = await executeCommandAsync(command, convo.workspace, execPolicy, convoCfg.execTimeoutSec, signal);
  return {
    tool, ok: r.allowed, command, returncode: r.returncode,
    stdout: r.stdout.slice(-3000), stderr: r.stderr.slice(-1500),
    ...(r.allowed ? {} : { error: r.stderr || 'command not allowed' }),
  };
}

/** 审批 park：落库 + 事件 + 阻塞等待用户裁决（once/always/reject；打断/删除会话连带拒绝） */
async function parkForApproval(deps: ConvoDeps, convo: Convo, command: string): Promise<ConvoApproval> {
  const rec: ConvoApproval = { id: newId(), command, ts: new Date().toISOString(), status: 'pending' };
  const list = await loadApprovals(convo.id);
  list.push(rec);
  await busSet(approvalsKey(convo.id), list.slice(-50));
  const cur = await getConvo(convo.id);
  if (cur) { cur.status = 'waiting_approval'; await saveConvo(cur); await emitProgress('convo_status', { convo_id: convo.id, status: 'waiting_approval' }); }
  await emitProgress('convo_approval', { convo_id: convo.id, approval: rec });
  await appendConvoMessage(convo.id, { role: 'system', kind: 'approval', text: command, meta: { approval_id: rec.id, command, status: 'pending' } });

  const verdict = await new Promise<ConvoApproval>((resolve) => {
    let settled = false;
    const done = (r: ConvoApproval) => { if (settled) return; settled = true; clearTimeout(timer); approvalResolvers.delete(convo.id + ':' + rec.id); resolve(r); };
    const timer = setTimeout(() => {
      rec.status = 'rejected';
      void (async () => {
        const all = await loadApprovals(convo.id);
        const found = all.find((a) => a.id === rec.id);
        if (found && found.status === 'pending') { found.status = 'rejected'; found.resolved_by = 'timeout'; await busSet(approvalsKey(convo.id), all); }
      })();
      done({ ...rec, status: 'rejected', resolved_by: 'timeout', resolved_at: new Date().toISOString() });
    }, convoCfg.askTimeoutMs);
    approvalResolvers.set(convo.id + ':' + rec.id, done);
  });

  const cur2 = await getConvo(convo.id);
  if (cur2) { cur2.status = 'running'; await saveConvo(cur2); await emitProgress('convo_status', { convo_id: convo.id, status: 'running' }); }
  return verdict;
}

/** 审批裁决入口（API 调用）。 */
export async function resolveConvoApproval(deps: ConvoDeps, convoId: string, approvalId: string, action: 'once' | 'reject' | 'always'): Promise<ConvoApproval | null> {
  const all = await loadApprovals(convoId);
  const rec = all.find((a) => a.id === approvalId);
  if (!rec || rec.status !== 'pending') throw new ConvoError(404, `待审批命令不存在或已处理: ${approvalId}`);
  rec.status = action === 'reject' ? 'rejected' : action === 'always' ? 'approved_always' : 'approved_once';
  rec.resolved_by = 'user';
  rec.resolved_at = new Date().toISOString();
  await busSet(approvalsKey(convoId), all);
  // 更新消息卡状态（回放可见终态）
  const msgs = await getConvoMessages(convoId);
  const msg = [...msgs].reverse().find((m) => m.kind === 'approval' && m.meta?.approval_id === approvalId);
  if (msg?.meta) {
    msg.meta.status = rec.status;
    await busSet(msgsKey(convoId), msgs);
  }
  approvalResolvers.get(convoId + ':' + approvalId)?.(rec);
  return rec;
}

/** ask_user：落库 + 事件 + 阻塞等待回答（打断/删除会话连带取消）。 */
async function convoAsk(deps: ConvoDeps, convo: Convo, question: string): Promise<Record<string, any>> {
  const rec: ConvoAsk = { id: newId(), question, ts: new Date().toISOString(), status: 'pending' };
  const list = await loadAsks(convo.id);
  list.push(rec);
  await busSet(asksKey(convo.id), list.slice(-100));
  const cur = await getConvo(convo.id);
  if (cur) { cur.status = 'waiting_ask'; await saveConvo(cur); await emitProgress('convo_status', { convo_id: convo.id, status: 'waiting_ask' }); }
  await emitProgress('convo_ask', { convo_id: convo.id, ask: rec });
  await appendConvoMessage(convo.id, { role: 'assistant', kind: 'ask', text: question, meta: { ask_id: rec.id, status: 'pending' } });

  const answer = await new Promise<ConvoAsk>((resolve) => {
    let settled = false;
    const done = (r: ConvoAsk) => { if (settled) return; settled = true; clearTimeout(timer); askResolvers.delete(convo.id + ':' + rec.id); resolve(r); };
    const timer = setTimeout(() => {
      rec.status = 'timeout';
      void (async () => {
        const all = await loadAsks(convo.id);
        const found = all.find((a) => a.id === rec.id);
        if (found && found.status === 'pending') { found.status = 'timeout'; await busSet(asksKey(convo.id), all); }
      })();
      done({ ...rec, status: 'timeout', answered_at: new Date().toISOString() });
    }, convoCfg.askTimeoutMs);
    askResolvers.set(convo.id + ':' + rec.id, done);
  });

  const cur2 = await getConvo(convo.id);
  if (cur2) { cur2.status = 'running'; await saveConvo(cur2); await emitProgress('convo_status', { convo_id: convo.id, status: 'running' }); }

  if (answer.status === 'answered' && answer.answer) return { tool: 'ask_user', ok: true, answer: answer.answer };
  return { tool: 'ask_user', ok: true, answer: '', note: answer.status === 'timeout' ? '超时未回答——请基于合理假设继续，并在回复中明确写出的假设。' : '用户未回答——请基于合理假设继续，并在回复中明确写出的假设。' };
}

/** 提问回答入口（API 调用）。 */
export async function answerConvoAsk(deps: ConvoDeps, convoId: string, askId: string, answer: string): Promise<ConvoAsk | null> {
  const all = await loadAsks(convoId);
  const rec = all.find((a) => a.id === askId);
  if (!rec || rec.status !== 'pending') throw new ConvoError(404, `提问不存在或已处理: ${askId}`);
  rec.status = 'answered';
  rec.answer = String(answer || '').slice(0, 2000);
  rec.answered_at = new Date().toISOString();
  await busSet(asksKey(convoId), all);
  const msgs = await getConvoMessages(convoId);
  const msg = [...msgs].reverse().find((m) => m.kind === 'ask' && m.meta?.ask_id === askId);
  if (msg?.meta) {
    msg.meta.status = 'answered';
    msg.meta.answer = rec.answer;
    await busSet(msgsKey(convoId), msgs);
  }
  askResolvers.get(convoId + ':' + askId)?.(rec);
  return rec;
}

/** write_file/edit_file：监狱校验 + 写前取证（undo 记录）+ applyToolCalls 执行。
 *  2026-09-20 修复：权限一律用会话级 policy（与 convoExec 同源），不再错用全局 convoCfg.policy。 */
async function convoWrite(deps: ConvoDeps, convo: Convo, policy: PermissionPolicy, call: Record<string, any>): Promise<Record<string, any>> {
  const name = String(call.tool || '').toLowerCase();
  if (!convo.workspace) return { tool: name, ok: false, error: '会话未绑定项目工作区，无法写文件' };
  if (policy.level === 'plan_only' || policy.level === 'readonly') {
    return { tool: name, ok: false, error: `会话权限为 ${policy.level}，不允许修改文件；请用户调整会话权限` };
  }
  const rel = String(call.path || '').trim();
  const abs = path.resolve(convo.workspace, rel);
  if (!rel || !abs.startsWith(path.resolve(convo.workspace))) return { tool: name, ok: false, path: rel, error: '路径为空或越界（目录监狱）' };
  const prevExists = fs.existsSync(abs) && fs.statSync(abs).isFile();
  const prevContent = prevExists ? fs.readFileSync(abs, 'utf-8') : null;
  const r = await applyToolCalls(convo.workspace, [call as any], { agent: convo.agent_id, project_id: convo.project_id }, policy);
  const rr: any = r[0] || {};
  if (rr.ok === false) return rr;
  let diff = '';
  try {
    const g = simpleGit({ baseDir: convo.workspace });
    if (await g.checkIsRepo()) diff = (await g.diff(['--', rel])).slice(-1600);
  } catch { /* 非 git 仓库 */ }
  const undoId = newId();
  const undoList = (await busGet<any[]>(undoKey(convo.id))) || [];
  undoList.push({ undo_id: undoId, file: rel, prev_content: prevContent, ts: new Date().toISOString() });
  await busSet(undoKey(convo.id), undoList.slice(-100));
  return { ...rr, tool: name, ok: true, path: rel, undo_id: undoId, ...(diff ? { diff } : {}), note: '已直接写入项目工作区；diff 见本轮改动卡片。' };
}

// ---------- 长对话打磨：自动压缩 / 标题生成 / fork / 文件搜索 ----------

/** 触发阈值：compaction 锚点之后的消息条数；压缩时保留最近 KEEP_RAW 条原文 */
const COMPACTION_THRESHOLD = 60;
const COMPACTION_KEEP_RAW = 10;
const COMPACTION_CAP_MS = 60_000;

/**
 * 长对话自动压缩（M5）：锚点后消息超阈值 → LLM 把「锚点后 ~ 最近 10 条」折叠为结构化摘要，
 * 追加进 compaction 锚点（下一 turn 的 LLM 历史 = 摘要 + 锚点后消息）。尽力而为：
 * 失败静默跳过（下一 turn 再试），绝不阻塞正常对话。
 */
async function maybeCompact(deps: ConvoDeps, convo: Convo): Promise<void> {
  try {
    const msgs = await getConvoMessages(convo.id);
    const uptoIdx = convo.compaction ? msgs.findIndex((m) => m.id === convo.compaction!.upto_id) : -1;
    const pending = msgs.length - (uptoIdx + 1);
    if (pending < COMPACTION_THRESHOLD) return;
    const slice = msgs.slice(uptoIdx + 1, msgs.length - COMPACTION_KEEP_RAW);
    if (slice.length < 10) return;
    const { entry } = resolvePrimary(deps, convo);
    if (!entry) return;
    const transcript = slice
      .map((m) => `${m.role}/${m.kind}: ${m.text.replace(/\s+/g, ' ').slice(0, 240)}`)
      .join('\n')
      .slice(-24000);
    const res = await chat(entry, [
      { role: 'system', content: '你是会话压缩器。把协作会话的早期历史压缩为后续对话可续用的结构化中文摘要（≤1200 字），必须保留：用户的目标与全部决策、已完成的改动（文件/命令/结果）、未完成事项、关键约定与教训。只输出摘要正文。' },
      { role: 'user', content: `${convo.compaction ? `此前已有摘要（请在此基础上合并）：\n${convo.compaction.summary}\n\n` : ''}以下是待压缩的历史：\n${transcript}` },
    ], undefined, 0.2, undefined, COMPACTION_CAP_MS);
    const summary = res.content.trim().slice(0, 4000);
    if (!summary) return;
    convo.compaction = { summary, upto_id: slice[slice.length - 1].id, at: new Date().toISOString() };
    await saveConvo(convo);
    await appendConvoMessage(convo.id, { role: 'system', kind: 'notice', text: `长对话自动压缩：${slice.length} 条早期消息已折叠为摘要（最近 ${COMPACTION_KEEP_RAW} 条保持原文），上下文规模得到控制。` });
    deps.logger.info('convo compaction done', { convoId: convo.id, folded: slice.length });
  } catch (e) {
    deps.logger.warn('convo compaction skipped', { convoId: convo.id, error: String((e as Error)?.message || e) });
  }
}

/** 标题自动生成（首轮）：取首条用户消息前 24 字。 */
async function ensureTitle(convo: Convo): Promise<void> {
  if (convo.title !== '未命名会话') return;
  const msgs = await getConvoMessages(convo.id);
  const firstUser = msgs.find((m) => m.role === 'user' && m.kind === 'text' && m.text.trim());
  if (!firstUser) return;
  convo.title = firstUser.text.replace(/\s+/g, ' ').trim().slice(0, 24) || convo.title;
  await saveConvo(convo);
  await emitProgress('convo_status', { convo_id: convo.id, status: convo.status, title: convo.title });
}

/** fork：按消息锚点复制出新会话（工作区/模型/人设/压缩锚点随迁，快照重新累计）。 */
export async function forkConvo(deps: ConvoDeps, id: string, opts?: { message_id?: string; title?: string }): Promise<Convo> {
  const src = await getConvo(id);
  if (!src) throw new ConvoError(404, `convo not found: ${id}`);
  const msgs = await getConvoMessages(id);
  let upto = msgs.length - 1;
  if (opts?.message_id) {
    const i = msgs.findIndex((m) => m.id === opts.message_id);
    if (i < 0) throw new ConvoError(400, `message not found: ${opts.message_id}`);
    upto = i;
  }
  const copy: Convo = {
    ...src,
    id: newId() + Date.now().toString(36).slice(-4),
    title: (opts?.title || `${src.title}（副本）`).slice(0, 120),
    status: 'idle',
    snapshot_id: undefined,
    compaction: src.compaction && msgs.findIndex((m) => m.id === src.compaction!.upto_id) <= upto ? src.compaction : undefined,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
  await busSet(convoKey(copy.id), copy);
  await busSet(msgsKey(copy.id), msgs.slice(0, upto + 1));
  await emitProgress('convo_status', { convo_id: copy.id, status: 'idle', title: copy.title, forked_from: id });
  return copy;
}

/** @引用文件模糊搜索：遍历工作区（跳过依赖/构建/协作产物目录），按子串过滤。 */
export async function searchConvoFiles(deps: ConvoDeps, convoId: string, q: string, limit = 20): Promise<{ files: string[]; total: number }> {
  const convo = await getConvo(convoId);
  if (!convo) throw new ConvoError(404, `convo not found: ${convoId}`);
  const ws = convo.workspace;
  if (!ws || !fs.existsSync(ws)) return { files: [], total: 0 };
  const SKIP = new Set(['node_modules', '.git', '.coteam', '.coteam-logs', 'dist', 'build', '.next', '__pycache__', '.venv', 'venv']);
  const all: string[] = [];
  const walk = (dir: string, depth: number): void => {
    if (all.length >= 4000 || depth > 8) return;
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (all.length >= 4000) return;
      if (e.name.startsWith('.') && e.name !== '.env.example') continue;
      if (SKIP.has(e.name)) continue;
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) walk(abs, depth + 1);
      else if (e.isFile()) all.push(path.relative(ws, abs).replace(/\\/g, '/'));
    }
  };
  walk(ws, 0);
  const needle = (q || '').trim().toLowerCase();
  const files = (needle ? all.filter((f) => f.toLowerCase().includes(needle)) : all).slice(0, limit);
  return { files, total: all.length };
}

// ---------- 会话生命周期辅助 ----------

/** 会话当前待审批命令（API 详情用）。 */
export function listPendingApprovals(convoId: string): Promise<ConvoApproval[]> {
  return loadApprovals(convoId).then((l) => l.filter((a) => a.status === 'pending'));
}

/** 会话当前待回答提问（API 详情用）。 */
export function listPendingAsks(convoId: string): Promise<ConvoAsk[]> {
  return loadAsks(convoId).then((l) => l.filter((a) => a.status === 'pending'));
}

/** 文件上传后的消息卡片（role=user 的 file 消息；LLM 历史按路径提示读取）。 */
export async function appendConvoFileMessage(deps: ConvoDeps, convoId: string, files: { id: string; name: string; url: string; wsPath?: string; size: number }[]): Promise<void> {
  await appendConvoMessage(convoId, { role: 'user', kind: 'file', text: files.map((f) => f.name).join('、'), meta: { files } });
}

/** 启动恢复：最后一条是用户消息且无 busy 的会话，重新驱动 turn（服务重启不丢用户的话）。 */
export async function resumeOrphanedConvos(deps: ConvoDeps): Promise<number> {
  let n = 0;
  for (const convo of await listConvos()) {
    if (await busGet(busyKey(convo.id))) continue;
    const msgs = await getConvoMessages(convo.id);
    const last = msgs[msgs.length - 1];
    if (last && last.role === 'user') {
      deps.logger.info('convo resume: re-driving unanswered user turn', { convoId: convo.id });
      triggerConvoTurn(deps, convo.id);
      n++;
    }
  }
  return n;
}

/** 会话级 diff（API）：工作区 git 状态 + patch。 */
export async function getConvoDiff(convoId: string): Promise<{ files: string[]; patch: string; git: boolean }> {
  const convo = await getConvo(convoId);
  if (!convo) throw new ConvoError(404, `convo not found: ${convoId}`);
  if (!convo.workspace || !fs.existsSync(path.join(convo.workspace, '.git'))) return { files: [], patch: '', git: false };
  const g = simpleGit({ baseDir: convo.workspace });
  const status = await g.status(['--porcelain']);
  const files = status.files.map((f) => `${f.working_dir} ${f.path}`);
  const patch = (await g.diff([])).slice(-20000);
  return { files, patch, git: true };
}

/** 回滚到会话首轮快照。 */
export async function rollbackConvo(deps: ConvoDeps, convoId: string): Promise<SnapshotRollbackLite> {
  const convo = await getConvo(convoId);
  if (!convo) throw new ConvoError(404, `convo not found: ${convoId}`);
  if (!convo.snapshot_id) throw new ConvoError(400, '该会话没有首轮快照（会话创建早于快照功能，或非 git 项目）');
  const snap = await getSnapshot(convo.snapshot_id);
  if (!snap) throw new ConvoError(404, `snapshot not found: ${convo.snapshot_id}`);
  const r = await rollbackSnapshot(convo.snapshot_id, { confirmed: true });
  await appendConvoMessage(convoId, { role: 'system', kind: 'notice', text: `已回滚到会话首轮快照（${snap.created_at}）——工作区改动已还原。` });
  return { ok: r.ok, snapshot_id: r.snapshot_id, git_action: r.git_action, details: r.details };
}

export interface SnapshotRollbackLite {
  ok: boolean;
  snapshot_id: string;
  git_action: string;
  details: string[];
}

// ---------- spawn_agent：主 agent 自由调度的子 agent 协同 ----------

const SUB_MAX_ITER = 12;
const SUB_WALLCLOCK_CAP_MS = 0;

function createSpawnSemaphore(width: number) {
  let active = 0;
  const waiters: (() => void)[] = [];
  return {
    async acquire(): Promise<void> {
      if (active < width) { active++; return; }
      await new Promise<void>((resolve) => waiters.push(resolve));
      active++;
    },
    release(): void {
      active = Math.max(0, active - 1);
      const next = waiters.shift();
      if (next) next();
    },
  };
}

/**
 * 子 agent 执行：该 agent 的人设（prompt.md）+ 绑定技能索引 + MCP 白名单 + 只读/执行/写文件
 * 工具面（无 ask_user/share_file——用户交互是主 agent 的职责），独立工具循环 ≤12 轮，
 * 模型按 agent 配置（model_override → tags 自动选）。活动以嵌套工具卡直播进主会话，
 * 最终摘要作为 spawn_agent 工具结果回注主循环。权限继承主会话策略（监狱/审批照常）。
 */
async function runSubAgent(
  deps: ConvoDeps,
  convo: Convo,
  policy: PermissionPolicy,
  agentName: string,
  task: string,
  turn: { writes: number; aborted: boolean },
  signal: AbortSignal,
): Promise<Record<string, any>> {
  const plugin = deps.orchestrator.plugins.get(agentName);
  if (!plugin) {
    return { tool: 'spawn_agent', ok: false, error: `agent 不存在: ${agentName}（可用：${[...deps.orchestrator.plugins.keys()].join('、')}）` };
  }
  if (!task.trim()) return { tool: 'spawn_agent', ok: false, error: 'task 不能为空' };

  const primary = (plugin.modelOverride ? deps.pool.getModel(plugin.modelOverride) : null)
    || deps.pool.selectStrongModel(plugin.tags)
    || deps.pool.selectStrongModel();
  if (!primary) return { tool: 'spawn_agent', ok: false, error: '模型池无可用模型' };
  const chain = deps.pool.fallbackChain(primary, plugin.tags).slice(0, MAX_SPEAKER_MODEL_CHAIN);

  const sys = `${plugin.prompt?.trim() || `你是「${agentName}」agent。`}
# 角色
你是被主 agent（搭档）通过 spawn_agent 调度的子智能体，在项目工作区执行一个明确的子任务。完成后用 reply 给出简洁的中文摘要（做了什么、结果如何、关键发现），不要向用户提问——有障碍就如实写进摘要。

# 工作区
${convo.workspace || '（无绑定工作区）'}
${plugin.skills?.length ? `\n# 绑定技能（正文用 load_skill 拉取）\n${plugin.skills.join('、')}` : ''}

## 工具（相对路径基于工作区）
侦查：{"tool":"list_files"} | {"tool":"read_file","path":"..","line_start":N,"line_end":M} | {"tool":"grep","pattern":".."} | {"tool":"git_diff"}
执行：{"tool":"exec","command":".."}（≤${convoCfg.execTimeoutSec}s） | {"tool":"exec_background","command":".."} | {"tool":"kill_process","pid":N}
写入：{"tool":"write_file","path":"..","content":".."} | {"tool":"edit_file","path":"..","find":"..","replace":".."}
技能/知识：{"tool":"load_skill","name":".."} | {"tool":"write_knowledge","category":"project","title":"..","content":".."}
${deps.mcp ? `\n## 外部 MCP 工具\n${deps.mcp.toolsIndex(agentName)}` : ''}

## 输出契约（纯 JSON，禁止代码栅栏）
A 动手：{"tool_calls":[...]}   B 收尾：{"reply":"子任务摘要"}
工具结果以 user 消息回喂。`; 

  const msgs: { role: string; content: string | unknown[] }[] = [
    { role: 'system', content: sys },
    { role: 'user', content: `## 子任务\n${task.trim().slice(0, 6000)}` },
  ];

  const startTs = Date.now();
  await appendConvoMessage(convo.id, { role: 'assistant', kind: 'tool', text: `子智能体 ${agentName} 开始：${task.trim().slice(0, 60)}`, model: primary.name, meta: { subagent: agentName, phase: 'start', task: task.trim().slice(0, 200) } });

  let summary = '';
  const stepLines: string[] = [];
  try {
    for (let iter = 0; iter < SUB_MAX_ITER; iter++) {
      if (signal.aborted) { turn.aborted = true; break; }
      const last = iter === SUB_MAX_ITER - 1;
      if (last) msgs.push({ role: 'user', content: '工具迭代次数已用完：不要再调用工具，立即用 reply 基于已获得的信息给出子任务摘要（如实说明已完成与未完成部分）。' });
      let res: LlmResponse;
      let used = chain[0];
      try {
        res = await chat(chain[0], msgs, undefined, 0.3, signal, SUB_WALLCLOCK_CAP_MS);
      } catch (e: any) {
        if (signal.aborted) break;
        const reason = String(e?.message || e);
        const next = chain[1];
        if (!next) { summary = `子任务中断：模型调用失败（${reason.slice(0, 120)}）`; break; }
        await appendConvoMessage(convo.id, { role: 'system', kind: 'notice', text: `子智能体 ${agentName}：${chain[0].name} 调用失败，切换 ${next.name}。` });
        try {
          res = await chat(next, msgs, undefined, 0.3, signal, SUB_WALLCLOCK_CAP_MS);
          used = next;
        } catch (e2: any) {
          if (signal.aborted) break;
          summary = `子任务中断：模型链全部失败（${String(e2?.message || e2).slice(0, 120)}）`;
          break;
        }
      }
      const parsed = extractJson(res.content);
      let calls = normalizeToolCalls(parsed?.tool_calls);
      if (!calls.length && !parsed && res.content.includes('"tool"')) calls = salvageToolCalls(res.content);
      if (calls.length && !last) {
        const sub = await runSubToolCalls(deps, convo, plugin, policy, calls, turn, signal);
        stepLines.push(...sub.lines);
        await appendConvoMessage(convo.id, { role: 'assistant', kind: 'tool', text: sub.line, model: used.name, meta: { subagent: agentName, calls: sub.records } });
        msgs.push({ role: 'assistant', content: res.content });
        msgs.push({ role: 'user', content: `工具执行结果：\n${JSON.stringify(sub.results).slice(0, 12000)}\n\n信息足够就 reply 收尾；需要继续再发 tool_calls。` });
        continue;
      }
      summary = String(parsed?.reply || res.content || '').trim().slice(0, 4000) || '（子任务无输出）';
      break;
    }
  } finally {
    if (!summary) summary = signal.aborted ? '子任务被用户打断，已完成部分保留在工作区。' : '子任务达到迭代上限未给出摘要。';
    await appendConvoMessage(convo.id, {
      role: 'assistant', kind: 'tool',
      text: `子智能体 ${agentName} 完成（${Math.round((Date.now() - startTs) / 1000)}s · ${stepLines.length} 步）：${summary.slice(0, 80)}`,
      model: primary.name,
      meta: { subagent: agentName, phase: 'done', summary, steps: stepLines.slice(-20) },
    });
  }
  return { tool: 'spawn_agent', ok: !signal.aborted, agent: agentName, summary, steps: stepLines.length };
}

/** 子 agent 的工具执行面：只读 + exec/写文件 + load_skill + write_knowledge + mcp（按子 agent 白名单）。 */
async function runSubToolCalls(
  deps: ConvoDeps,
  convo: Convo,
  plugin: AgentPlugin,
  policy: PermissionPolicy,
  calls: Record<string, any>[],
  turn: { writes: number; aborted: boolean },
  signal: AbortSignal,
): Promise<{ results: unknown[]; records: { tool: string; args_summary?: string; output_gist?: string; ok?: boolean; mcp?: { server: string; tool: string } }[]; line: string; lines: string[] }> {
  const results: unknown[] = [];
  const records: { tool: string; args_summary?: string; output_gist?: string; ok?: boolean; mcp?: { server: string; tool: string } }[] = [];
  const knowledgeCtx: KnowledgeToolContext = { agent: plugin.name, project_id: convo.project_id, availableSkills: plugin.skills || [] };
  const roSet = new Set(['list_files', 'read_file', 'read_dir', 'grep', 'git_log', 'git_diff', 'write_knowledge', 'load_skill', 'check_page', 'screenshot', 'look_image']);
  const segs: string[] = [];
  const lines: string[] = [];
  for (const call of calls) {
    if (signal.aborted) { turn.aborted = true; break; }
    const name = String(call.tool || '').toLowerCase();
    try {
      if (roSet.has(name)) {
        const r = await applyToolCalls(convo.workspace, [call as any], knowledgeCtx, policy);
        results.push(r[0]);
        records.push({ tool: name, args_summary: String(call.command || call.path || call.pattern || call.name || '').slice(0, 120), output_gist: gist(r[0]), ok: (r[0] as any)?.ok !== false });
        segs.push(`${(r[0] as any)?.ok !== false ? '✓' : '✗'} ${name}${call.path ? `(${String(call.path).slice(0, 30)})` : ''}`);
        lines.push(`${name} ${String(call.path || call.pattern || '').slice(0, 60)}`);
        continue;
      }
      if (name.startsWith('mcp__')) {
        const bridge = deps.mcp;
        if (!bridge) { results.push({ tool: name, ok: false, error: '本系统未接入 MCP 服务' }); continue; }
        const rest = name.slice('mcp__'.length);
        const sep = rest.indexOf('__');
        const server = sep > 0 ? rest.slice(0, sep) : '';
        const toolName = sep > 0 ? rest.slice(sep + 2) : '';
        let args = (call as { arguments?: unknown }).arguments;
        if (!args || typeof args !== 'object' || Array.isArray(args)) {
          const { tool: _t, arguments: _a, ...flat } = call as Record<string, unknown>;
          args = flat;
        }
        const r = await bridge.callTool(plugin.name, server, toolName, (args || {}) as Record<string, unknown>);
        results.push({ tool: name, ok: r.ok, server, ...(r.ok ? { output: r.text } : { error: r.error }) });
        records.push({ tool: name, args_summary: '', output_gist: r.ok ? (r.text || '').slice(0, 200) : (r.error || '').slice(0, 200), ok: r.ok, mcp: { server, tool: toolName } });
        segs.push(`${r.ok ? '✓' : '✗'} MCP ${name.slice(5)}`);
        continue;
      }
      if (name === 'exec' || name === 'exec_command' || name === 'run_command' || name === 'exec_background' || name === 'start_process' || name === 'kill_process') {
        const r = name === 'kill_process'
          ? (killPidTree(Number(call.pid) || 0, convo.workspace || process.cwd()), { tool: name, ok: true, pid: call.pid })
          : await convoExec(deps, convo, policy, String(call.command || '').trim(), signal, name === 'exec_background' || name === 'start_process');
        results.push(r);
        records.push({ tool: name, args_summary: String(call.command || call.pid || '').slice(0, 120), output_gist: gist(r), ok: (r as any)?.ok !== false });
        segs.push(`${(r as any)?.ok !== false ? '✓' : '✗'} ${name === 'kill_process' ? 'kill' : 'exec'}「${String(call.command || '').slice(0, 36)}」`);
        lines.push(`exec ${String(call.command || '').slice(0, 60)}`);
        continue;
      }
      if (name === 'write_file' || name === 'edit_file') {
        const r = await convoWrite(deps, convo, policy, call);
        if ((r as any)?.ok !== false) turn.writes++;
        results.push(r);
        records.push({ tool: name, args_summary: String(call.path || '').slice(0, 120), output_gist: gist(r), ok: (r as any)?.ok !== false });
        segs.push(`${(r as any)?.ok !== false ? '✓' : '✗'} 写入 ${String(call.path || '').slice(0, 30)}`);
        lines.push(`写入 ${String(call.path || '').slice(0, 60)}`);
        continue;
      }
      results.push({ tool: name, ok: false, error: `子智能体不允许的工具: ${name}（用户交互类请回报主 agent）` });
    } catch (e: any) {
      results.push({ tool: call.tool, ok: false, error: String(e?.message || e).slice(0, 200) });
    }
  }
  return { results, records, line: segs.join(' · ') || '（无动作）', lines };
}
