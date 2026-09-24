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
import { chat, extractJson, salvageToolCalls, normalizeToolCalls, LLM_WAIT_GIVEUP_RE } from './llm';
import type { LlmResponse } from './llm';
import type { LlmToolSpec } from './llm';
import { nativeToolsOn, buildConvoTools } from './toolSchema';
import type { ModelPool, ModelEntry } from './scheduler';
import type { Orchestrator } from './orchestrator/orchestrator';
import { CAPACITY_RE } from './orchestrator/orchestrator';
import type { McpManager } from './mcp/manager';
import type { OpencodeBridge } from './opencode/types';
import { isOcTool, runOpencodeTool } from './opencode/ocTools';
import type { Logger } from './logger';
import type { AgentPlugin } from './agents';
import { applyToolCalls, estimateTokens } from './tools';
import { extractReplyStreaming } from './discussion';
import type { KnowledgeToolContext } from './tools';
import { pickSkillsForNode, formatSkillsBlock, formatSkillsCatalog } from './skills';
import { getSkills } from './skills';
import { relevantKnowledge } from './knowledge';
import { distillKnowledgeCandidates } from './distill';
import { classifyCommand, isCommonDevCommand } from './commandGuard';
import { canExecute, policyFromConfig, executeCommandAsync, isPermissionLevel, type PermissionPolicy } from './sandbox';
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
  /** 模型自动切换（默认关）：关=主模型失败自动重试 3 次后报断连；开=沿降级链自动换模（ZCode 式） */
  auto_switch?: boolean;
  /** 工作区被回滚到快照的时间（PH.6 纠正账本）：下一个 turn 注入「旧结果已失效」纠正块后清除 */
  rollback_at?: string;
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
  /** 审批触发原因：whitelist=白名单外/敏感命令；jail_out_of_scope=unrestricted 越界非开发命令 */
  reason?: 'whitelist' | 'jail_out_of_scope';
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
  /** OpenCode 接管桥（缺省=未接入，oc_* 工具软错误拒绝） */
  opencode?: OpencodeBridge;
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
const MAX_TOOL_ITER = 40;
/** 单轮 turn 自动续跑段数：每段 maxToolIter 次工具迭代，段末仍有工具调用则自动续跑（E）。 */
const MAX_TOOL_SEGMENTS = 4;
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
/** 自动重试：次数与间隔（指数退避 base×2^i 封顶 10×base）。默认 3 次——10 次盲重试 × 900s 首
 * token 空闲曾把"正在思考"拖成 2.5 小时黑箱（P0.3），配合等待心跳帧与 llm_wait_giveup 收紧。 */
const AUTO_RETRY_COUNT = 3;
const AUTO_RETRY_BASE_MS = 1000;
const AUTO_RETRY_CAP_MS = 10 * AUTO_RETRY_BASE_MS;
/** convo 单次尝试的首包等待硬上限：600s 内零字节即放弃本次尝试（不进重试——上游无响应，
 * 重试只会同样黑箱）。chunk 流动中的慢生成不受影响（超时不判死纪律只认"无任何数据"）。 */
const CONVO_WAIT_GIVEUP_MS = 10 * 60 * 1000;
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

/**
 * 完成式声称（PH.2 断言门）：零工具轮的回复里宣称「已修复/已完成/已验证/测试通过」——
 * 本轮没有任何 exec/check_page/read 证据支撑，属可拦截的幻觉声称（星瑶 system_prompt.md:34
 * "未经工具结果证实的成功/修复/通过结论"禁令的引擎化）。窄匹配完成/验证类动词，防误伤
 * "建议测试一下/还没完成"类表述。
 */
const COMPLETION_CLAIM_RE = /(已经?|已)(修复|修好|解决|完成|搞定|验证|测试过|跑通)|(?<![如若倘假万期希待果还等再没])(测试|构建|编译|lint|检查|验证)已?通过|已经?通过验证|问题(已经?)?不存在了/;
export { COMPLETION_CLAIM_RE };
const CORRECTIVE_COMPLETE_MSG = '纠正：你上一条声称「已修复/已完成/已验证」，但本轮没有调用任何工具——没有证据的完成声称不可信。要么现在就实际执行（修改文件、跑测试、check_page 渲染验证）用真实结果支撑结论；要么如实说明「尚未执行/未验证」，并给出准备怎么做。';

/**
 * FC 模式意图叙述句（2026-09-20 实测"想改一下ui"会话）：模型执行完工具轮后用正文说
 * "让我检查日志…"——只叙述下一步而不发起工具调用，引擎此前当作最终回复收尾，turn 就断在半路。
 * 窄匹配"让我/我先/接下来我 + 动作动词"句式，防误伤"建议先讨论/我认为"类结论回复。
 */
const INTENT_NARRATION_RE = /(让我(先|再)?(检查|看看|看下|查一下|查看|确认|测试|启动|运行|读取|分析|验证|确认一下)|我先(看看|看下|检查|查一下|确认|分析|验证|读取)|接下来我(会|将|要|再)|(先|再)(看看|看下|查一下|检查一下)|我(来看|去看|来查|去查)看?|稍等[，,]\s*我(先|再)?)/;
const CORRECTIVE_INTENT_MSG = '纠正：你上一条只是用正文叙述了下一步打算（"让我检查…"），但没有发起任何工具调用——叙述不算执行。要继续检查/查看/验证就立刻发起工具调用（read_file / exec / check_page 等）；如果信息已经足够，就给出完整的最终结论（包含你已确认的结果），不要停在"即将做"的半截状态。另外注意：如果用户要的是建议/分析（而非改动），直接基于已有信息给完整建议即可，不要再发起侦查动作。';

/**
 * FC 模式工具活动行回显（2026-09-20 实测）：模型把 "✓ exec「…」exit 0" 这类工具活动行
 * 当作正文回复输出——既不是真实工具调用也不是面向用户的结论。窄匹配行首 ✓/✗ + 「 格式。
 */
const FC_ECHO_RE = /^\s*[✓✗]\s*\S+?[「(]/;
const CORRECTIVE_ECHO_MSG = '纠正：你上一条输出的是工具执行记录的回显（"✓ exec「…」"样式），不是面向用户的回复，也没有真正发起工具调用。要么此刻发起真实的工具调用（工具通道），要么给出面向用户的完整结论（说明结果、建议与依据）。不要伪造工具输出。';

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

/**
 * 局部写（2026-09-20 并发覆盖修复）：重读最新 → 只合并目标字段 → 保存。
 * turn 运行期的 setStatus/快照/ensureTitle 此前用 turn 开始时的旧对象整体
 * saveConvo——用户并发改的 policy_level/title/auto_switch 被旧值覆盖回去
 * （实测"改完权限显示还是旧的"）。turn 内所有局部写一律走此函数。
 */
async function patchConvo(id: string, patch: Partial<Convo>): Promise<void> {
  const cur = await getConvo(id);
  if (!cur) return;
  for (const [k, v] of Object.entries(patch)) {
    if (v !== undefined) (cur as any)[k] = v;
  }
  await saveConvo(cur);
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
  // P1.4 删除前强制归档：有实质内容且绑定项目的会话，删除时把对话摘要沉淀为
  // low-confidence 知识条目——结论与决策不随会话删除而蒸发（用户可在知识库治理中裁决）
  try {
    const convo = await getConvo(id);
    const msgs = await getConvoMessages(id);
    const substantive = msgs.filter((m) => (m.role === 'user' && m.kind === 'text') || (m.role === 'assistant' && m.kind === 'text'));
    if (convo?.project_id && substantive.length >= 6) {
      const { writeKnowledge } = await import('./knowledge');
      const digest = substantive.slice(-30)
        .map((m) => `${m.role === 'user' ? '用户' : '助手'}: ${String(m.text || '').slice(0, 200)}`)
        .join('\n')
        .slice(0, 4000);
      writeKnowledge({
        title: `会话归档：${convo.title.slice(0, 40)}`,
        content: `本会话删除前自动归档（${new Date().toISOString()}，共 ${substantive.length} 条对话）。\n\n${digest}`,
        category: 'project',
        project_id: convo.project_id,
        tags: ['会话归档'],
        source: `convo:${id}`,
        confidence: 'low',
      });
    }
  } catch { /* 归档失败不阻塞删除 */ }
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
    // stale 兜底路径已复位 busy；ctrl 路径 abort 未即时生效时 busy 仍在，
    // 交由 turn 收尾 finally 消费排队——此时强制删锁会造成双 turn 并发，不做
    if (!(await busGet(busyKey(convoId))) && (await hasPendingUserInput(convoId))) triggerConvoTurn(deps, convoId);
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
  // P0.6 池隔离：任务管线冷却全灭时忽略冷却兜底选型——对话宁撞一次也不集体哑火。
  const entry = pinned || viaOverride
    || deps.pool.selectStrongModel(plugin?.tags)
    || deps.pool.selectStrongModel()
    || deps.pool.selectStrongModel(plugin?.tags, { ignoreCooldown: true })
    || deps.pool.selectStrongModel(undefined, { ignoreCooldown: true });
  return { entry, plugin };
}

/** Kick the response loop in background（HTTP 立即返回，过程走 WS）。 */
export function triggerConvoTurn(deps: ConvoDeps, convoId: string): void {
  void runResponseLoop(deps, convoId).catch((e) => {
    if ((e as ConvoError)?.status !== 409) deps.logger.error('convo turn failed', { convoId, error: String((e as Error)?.message || e) });
  });
}

/** busy 标记 TTL：正常 turn 由 finally 删除；此处只作崩溃遗留的兜底，10 分钟足够。 */
const CONVO_BUSY_TTL_MS = 10 * 60 * 1000;

async function acquireBusy(convoId: string): Promise<boolean> {
  const existing = await busGet<number>(busyKey(convoId));
  if (existing && Date.now() - existing < CONVO_BUSY_TTL_MS) return false;
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

/** 会话状态写回（runTurnCore 之外的复位入口用）。 */
async function setConvoStatus(convoId: string, s: ConvoStatus): Promise<void> {
  const convo = await getConvo(convoId);
  if (!convo || convo.status === s) return;
  convo.status = s;
  await saveConvo(convo);
  await emitProgress('convo_status', { convo_id: convoId, status: s });
}

/** 在飞审批/提问连带作废（内存 resolver 释放 + KV 记录落终态，回放可见）。 */
async function markInterruptedGates(convoId: string): Promise<void> {
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
}

/** 停止当前 turn（只停不发）；排队消息保留，下次发消息时继续处理。 */
export async function stopConvo(deps: ConvoDeps, convoId: string): Promise<void> {
  const convo = await getConvo(convoId);
  if (!convo) throw new ConvoError(404, `convo not found: ${convoId}`);
  if (!(await busGet(busyKey(convoId)))) return;
  await interruptConvo(deps, convoId);
}

/**
 * 打断：abort LLM 流与在飞命令 + 作废在飞审批/提问 + kill 本 turn 后台进程。
 * stale 兜底（2026-09-20）：进程重启/崩溃后 turnAborts 内存空而 busyKey 残留——
 * 此前 interruptConvo 是静默 no-op，插话/停止毫无反应、状态永远"运行中"。
 * 现在复位为空闲、落打断卡并重驱动排队消息（插话立即生效）。
 */
export async function interruptConvo(deps: ConvoDeps, convoId: string): Promise<void> {
  const ctrl = turnAborts.get(convoId);
  if (!ctrl && (await busGet(busyKey(convoId)))) {
    // stale turn：内存无属主，KV 锁残留 → 复位 + 可见提示 + 消费排队。
    // 卡片必须是 notice（非 turn 终态）——interrupt 卡会被 hasPendingUserInput
    // 视为"本轮已收场"，把排在它后面的排队用户消息吞掉，导致插话永远不被消费。
    await busDel(busyKey(convoId));
    await setConvoStatus(convoId, 'idle');
    await markInterruptedGates(convoId);
    await appendConvoMessage(convoId, { role: 'system', kind: 'notice', text: '检测到上一进程遗留的挂起轮次，已复位为空闲；排队消息将继续处理。', meta: { stale_reset: true } });
    if (await hasPendingUserInput(convoId)) triggerConvoTurn(deps, convoId);
    return;
  }
  if (ctrl) ctrl.abort(new Error('用户打断'));
  await markInterruptedGates(convoId);
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

/**
 * Server startup：上一进程死在 turn 中途会遗留 busyKey（此前 TTL 24h，会卡住会话一整天）
 * 与卡死的 running 状态——启动即清扫（镜像 clearStaleDiscussionLocks / restoreStaleTaskHeads）。
 * 返回清扫的会话数。
 */
export async function clearStaleConvoLocks(logger?: { info(msg: string, meta?: unknown): void }): Promise<number> {
  const busyKeys = await busKeys('convo:*:busy');
  const cleared = new Set<string>();
  for (const k of busyKeys) {
    const id = k.replace(/^convo:/, '').replace(/:busy$/, '');
    await busDel(k);
    cleared.add(id);
  }
  for (const id of cleared) {
    const convo = await getConvo(id);
    if (convo && convo.status !== 'idle') {
      convo.status = 'idle';
      await saveConvo(convo);
      await emitProgress('convo_status', { convo_id: id, status: 'idle' });
    }
  }
  if (cleared.size) logger?.info('cleared stale convo busy locks', { count: cleared.size });
  return cleared.size;
}

// ---------- turn 核心 ----------

/** 会话级权限：从最新 convo 实时解析（A：用户中途切权限对在飞轮次即时生效，
 *  不再沿用 turn 开始时的快照——此前"改完权限 agent 仍报 plan_only"的根因）。 */
async function resolveConvoPolicy(convoId: string): Promise<PermissionPolicy> {
  const cur = await getConvo(convoId);
  if (!cur?.policy_level) return convoCfg.policy;
  return policyFromConfig({
    level: cur.policy_level,
    whitelist_commands: convoCfg.policy.whitelistCommands ?? undefined,
    max_time_sec: convoCfg.policy.maxTimeSec,
    allow_sensitive: convoCfg.policy.allow_sensitive,
  });
}

async function runTurnCore(deps: ConvoDeps, convoId: string): Promise<void> {
  const convo = await getConvo(convoId);
  if (!convo) return;
  // P0.1 终态事件：每个 turn 恰好发一个 convo_turn_end（completed|failed|cancelled + error_code）。
  // 异常回合绝不发 completed——前端以收到终态帧为唯一解锁条件，不靠 WS 断开/超时猜。
  let turnEnd: { status: 'completed' | 'failed' | 'cancelled'; error_code?: string; reason?: string } | null = null;
  const { entry: primary, plugin } = resolvePrimary(deps, convo);
  if (!primary) {
    await appendConvoMessage(convoId, { role: 'system', kind: 'notice', text: '模型池无可用模型，本轮未执行——请检查模型池配置或稍后重试。', meta: { turn_complete: true } });
    await emitProgress('convo_turn_end', { convo_id: convoId, status: 'failed', error_code: 'no_model', reason: '模型池无可用模型' });
    return;
  }
  const policy: PermissionPolicy = convo.policy_level ? policyFromConfig({ level: convo.policy_level, whitelist_commands: convoCfg.policy.whitelistCommands ?? undefined, max_time_sec: convoCfg.policy.maxTimeSec, allow_sensitive: convoCfg.policy.allow_sensitive }) : convoCfg.policy;
  const abort = new AbortController();
  turnAborts.set(convoId, abort);
  turnBgPids.set(convoId, new Set());
  const turn = { writes: 0, aborted: false };
  // P0.5 busy 心跳：turn 期间每 60s 刷新 busy 锁时间戳（此前只依赖 finally 删锁 +
  // 10min TTL——合法长 turn 会被并发触发误判"锁过期"造成双 turn；进程崩溃则心跳自然过期）
  const busyStamp = setInterval(() => { void busSet(busyKey(convoId), Date.now()).catch(() => undefined); }, 60_000);

  const setStatus = async (s: ConvoStatus) => {
    // 局部写：重读最新再合并，不用 turn 开始时的旧对象整体覆盖（并发修改保护）
    await patchConvo(convoId, { status: s });
    await emitProgress('convo_status', { convo_id: convoId, status: s });
  };
  await setStatus('running');
  void ensureTitle(convo);

  try {
    // 首轮安全网：自动快照（git ref 锚点，回滚 API 凭此还原）
    if (!convo.snapshot_id && convo.workspace && fs.existsSync(path.join(convo.workspace, '.git'))) {
      try {
        const snap = await createSnapshot(convoId, { tag: 'convo-start', workspace: convo.workspace, note: `协作会话「${convo.title}」首轮自动快照` });
        await patchConvo(convoId, { snapshot_id: snap.id });
      } catch (e) {
        deps.logger.warn('convo snapshot failed', { convoId, error: String((e as Error)?.message || e) });
      }
    }

    const system = await buildSystemPrompt(deps, convo, plugin, policy.level);
    // PH.6 回滚纠正账本：注入后立即清除标记（纠正块只注入回滚后的第一个 turn）
    if (convo.rollback_at) {
      const live = await getConvo(convoId);
      if (live) { delete live.rollback_at; await saveConvo(live); }
    }
    await maybeCompact(deps, convo);
    const history = await buildLlmHistory(convo.id, convo, { nativeImages: modelSupportsImages(primary) });
    const convo_msgs: { role: string; content: string | unknown[] }[] = [{ role: 'system', content: system }, ...history];
    if (!convo_msgs.some((m) => m.role === 'user')) {
      turnEnd = { status: 'completed', reason: 'no_pending_input' };
      await setStatus('idle');
      return; // 没有待处理的用户输入（不应发生，防御）
    }

    let finalParsed: Record<string, any> | null = null;
    let chosen = primary;
    let turnReasoning = '';
    // 原生 function calling（opencode/ZCode 同款工具通道，2026-09-20）：工具调用走供应商
    // tool_calls 结构化字段，正文即回复——不存在"模型没按 JSON 输出→解析失败→烧纠正重试"。
    // llm.native_tools=false 时整体回退 JSON 文本契约路径。
    const fc = nativeToolsOn();
    // 工具集在每轮迭代内按"最新权限"重建（C：plan_only 不暴露 exec/write；A：中途切 full
    // 当轮即可获得执行工具）——故不在此处一次性构建。
    // 输出契约兜底检测（2026-09-20 修复）：模型未按 JSON 契约输出工具调用/回复而是直接
    // 写了散文——保留其文字（不丢用户要的答案），但必须如实告知本轮"只回复、没干活"，
    // 否则会被静默包装成成功回复，掩盖"光回复不干活"的行为。
    let plainFallback = false;
    let toolRan = false; // 本轮是否执行过工具（散文兜底 notice 只在零工具时才落，避免与事实矛盾）
    // 引擎级自纠错（2026-09-20 二轮）：嘴炮先自动纠正重试一次再采纳，别逼用户手动催
    let proseRetried = false; // 纯散文（extractJson 失败）已纠正重试
    let lazyRetried = false;  // 形态 B 口头承诺动手但零工具已纠正重试
    let intentRetried = false; // FC 意图叙述句（"让我检查…"）已纠正重试
    let echoRetried = false;   // FC 工具活动行回显（"✓ exec「…」"）已纠正重试
    let planPolicyNoticed = false; // C：plan_only/readonly 拦截已落 notice（每次 turn 至多一次）

    // 单轮 turn 分 MAX_TOOL_SEGMENTS 段自动续跑（E）：每段预算 convoCfg.maxToolIter；
    // 段末仍有工具调用则落 notice 并继续下一段，只有最后一段的最后一次迭代才注入"停止语"。
    const totalToolIter = convoCfg.maxToolIter * MAX_TOOL_SEGMENTS;
    for (let iter = 0; iter < totalToolIter; iter++) {
      const last = iter === totalToolIter - 1;
      const segBoundary = !last && (iter + 1) % convoCfg.maxToolIter === 0;
      // A：每轮迭代按最新会话权限重算（用户中途切权限即时生效）
      const effPolicy = await resolveConvoPolicy(convoId);
      // C：按最新权限过滤工具（plan_only 不暴露 exec/write）
      const fcTools = fc ? buildConvoTools({ mcp: deps.mcp, agentId: plugin?.name || convo.agent_id, execTimeoutSec: convoCfg.execTimeoutSec ?? 180, level: effPolicy.level }) : undefined;
      let stream = { acc: '', emitted: 0, lastAt: 0, sid: `${convoId}:t#${iter}` };
      const onDelta = (d: string) => {
        stream.acc += d;
        // FC 路径正文即回复，直接流式上屏；JSON 契约路径从 reply 键之后抽取
        const cur = fc ? { value: stream.acc, done: false } : extractReplyStreaming(stream.acc);
        if (!cur) return;
        const tail = cur.value.slice(stream.emitted);
        if (!tail) return;
        if (tail.length < DELTA_MIN_CHARS && !cur.done && Date.now() - stream.lastAt < DELTA_MIN_MS) return;
        stream.emitted = cur.value.length;
        stream.lastAt = Date.now();
        void emitProgress('convo_delta', { convo_id: convoId, stream_id: stream.sid, text: tail, done: cur.done });
      };
      if (last) {
        convo_msgs.push({ role: 'user', content: fc
          ? '工具迭代次数已用完：不要再调用工具，立即基于已获得的信息给出最终回复（如实说明已完成与未完成的部分）。'
          : '工具迭代次数已用完：不要再调用工具，立即基于已获得的信息用 reply 给出最终回复（如实说明已完成与未完成的部分）。' });
      }

      let res: LlmResponse;
      try {
        const out = await chatOnModelChain(deps, convo, primary, convo_msgs, abort.signal, onDelta, (sid) => {
          stream = { acc: '', emitted: 0, lastAt: 0, sid };
          return onDelta;
        }, fcTools ? { tools: fcTools } : undefined);
        res = out.res;
        chosen = out.entry;
        turnReasoning = out.reasoning;
      } catch (e: any) {
        if (abort.signal.aborted) { turn.aborted = true; break; }
        const msg = String(e?.message || e);
        // 断连/失败终局卡：引擎已自动重试（关=3 次同模型；开=每模型 3 次×链），到此仍未成功
        turnEnd = { status: 'failed', error_code: 'model_chain_failed', reason: msg.slice(0, 160) };
        await appendConvoMessage(convoId, {
          role: 'system', kind: 'degrade',
          text: convo.auto_switch
            ? `模型链全部不可用（${msg.slice(0, 120)}）——本轮未完成。可切换模型、稍后重试，或检查各供应商状态。`
            : `主模型 ${chosen.name} 调用失败（${msg.slice(0, 120)}）——已自动重试 ${convoCfg.autoRetryCount ?? 3} 次仍未成功。可在会话开启「自动切换模型」，或手动更换模型后重试。`,
          meta: { broken: true, model: chosen.name },
        });
        break;
      }
      let calls: Record<string, any>[];
      if (fc) {
        // FC 路径：工具调用优先来自供应商 tool_calls；正文即回复，不做纠正重试。
        // 兜底：模型仍把 tool_calls/reply JSON 写进正文时照常解析（不白烧调用）。
        calls = normalizeToolCalls(res.toolCalls) as Record<string, any>[];
        if (!calls.length) {
          const parsedContent = extractJson(res.content);
          if (Array.isArray(parsedContent?.tool_calls) && parsedContent.tool_calls.length) {
            calls = normalizeToolCalls(parsedContent.tool_calls);
            finalParsed = null;
          } else if (typeof parsedContent?.reply === 'string' && parsedContent.reply.trim()) {
            finalParsed = { reply: parsedContent.reply, ...(Array.isArray(parsedContent.share_files) ? { share_files: parsedContent.share_files } : {}) };
          }
          if (!calls.length && !finalParsed && res.content.includes('"tool"')) {
            calls = salvageToolCalls(res.content);
            finalParsed = null;
          }
        }
        if (!calls.length && !finalParsed) {
          const plain = res.content.trim();
          if (plain) finalParsed = { reply: plain.slice(0, MAX_MESSAGE_LENGTH) };
          else finalParsed = null;
        }
      } else {
        finalParsed = extractJson(res.content);
        // 2026-09-20 修复：tool_calls 形状归一化——模型漂移出 {"name":...} / OpenAI 函数风格
        // {"function":{"name":..,"arguments":..}} 时旧 filter 会静默全丢弃，模型以为已调用
        // 工具、用户只看到口头回复（「光回复不干活」根因之一）。
        calls = normalizeToolCalls(finalParsed?.tool_calls);
        if (!calls.length && !finalParsed && res.content.includes('"tool"')) calls = salvageToolCalls(res.content);
        if (!calls.length && finalParsed?.tool_calls !== undefined) {
          deps.logger.warn('convo tool_calls 全部无法归一化（原始输出前 600 字）', { convoId, content: res.content.slice(0, 600) });
        }
      }

      if (calls.length && !last) {
        void emitProgress('convo_delta', { convo_id: convoId, stream_id: stream.sid, discarded: true });
        // FC 叙述不丢弃（2026-09-20 实测 learn-english 会话）：模型常在同一次响应里输出
        // 叙述正文 + tool_calls——此前正文被 discarded 清掉（"内容出来马上折叠进执行步骤"），
        // 现在先固化为 text 消息上屏再落工具卡（LLM 历史原本就含此正文，纯上屏行为修复）
        if (fc && res.content.trim()) {
          await appendConvoMessage(convoId, { role: 'assistant', kind: 'text', text: res.content, model: chosen.name });
        }
        // 工具批次开始即推送（此前整批跑完才发 convo_tool——执行全程用户看不到任何进度）
        await emitProgress('convo_tool_start', { convo_id: convoId, calls: calls.map((c) => ({ tool: c.tool, command: c.command, path: c.path })) });
        const results = await runConvoToolCalls(deps, convo, effPolicy, calls, turn, abort.signal, chosen.name);
        if (turn.aborted) break;
        toolRan = true;
        // C：权限直接拒绝（plan_only/readonly）时落一次显式 notice，让用户一眼看到是权限问题
        if (!planPolicyNoticed && results.results.some((r) => {
          const err = String((r as { error?: string })?.error || '');
          return err.includes('不允许执行命令') || err.includes('不允许修改文件');
        })) {
          planPolicyNoticed = true;
          await appendConvoMessage(convoId, {
            role: 'system', kind: 'notice',
            text: `当前会话权限为 ${effPolicy.level}（${effPolicy.level === 'plan_only' ? '只出方案' : '只读'}）：命令/写入被拒绝。请在会话顶部把权限切到「目录内完全控制」或「改动需审批」后再继续。`,
            meta: { policy_blocked: true, level: effPolicy.level },
          });
        }
        const records = results.records;
        await appendConvoMessage(convoId, { role: 'assistant', kind: 'tool', text: activityLine(calls, results.results), model: chosen.name, meta: { calls: records } });
        await emitProgress('convo_tool', { convo_id: convoId, calls: calls.map((c) => ({ tool: c.tool, command: c.command, path: c.path })), results: results.results });
        convo_msgs.push({ role: 'assistant', content: res.content });
        convo_msgs.push({ role: 'user', content: `工具执行结果：\n${JSON.stringify(results.results).slice(0, 16000)}\n\n${fc ? '信息足够就给出给用户的最终回复（正文直接输出，不要再包 JSON）；需要继续动手再调用工具。' : '信息足够就用 reply 给用户最终回复；需要继续动手再发 tool_calls。'}` });
        // E：段末仍有工具调用 → 自动续跑下一段（不逼用户手动"继续"）
        if (segBoundary) {
          await appendConvoMessage(convoId, {
            role: 'system', kind: 'notice',
            text: `已达单段迭代上限（${convoCfg.maxToolIter} 次），任务尚未收尾，自动继续下一段（共 ${MAX_TOOL_SEGMENTS} 段）。`,
            meta: { auto_continue: true, segment: Math.floor(iter / convoCfg.maxToolIter) + 1 },
          });
        }
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
          await appendConvoMessage(convoId, { role: 'system', kind: 'notice', text: '模型本轮未按 JSON 契约输出（返回了纯文本），引擎已自动纠正重试。', meta: { retry: 'prose', original: plain.slice(0, 400) } });
          convo_msgs.push({ role: 'assistant', content: res.content });
          convo_msgs.push({ role: 'user', content: CORRECTIVE_JSON_MSG });
          continue;
        }
        if (looksProse) {
          plainFallback = true;
          finalParsed = { reply: plain.slice(0, MAX_MESSAGE_LENGTH) };
        }
      }
      // 引擎级自纠错：形态 B 嘴炮——零工具 + "正在动手"式声称 / "已创建 X"假完成（工作区核验）
      // / "已修复·已验证·测试通过"完成声称（PH.2 断言门）→ 纠正重试一次
      if (!calls.length && finalParsed && !toolRan && !lazyRetried && !last) {
        const replyText = String(finalParsed.reply || '');
        const falseClaims = findFalseFileClaims(replyText, convo.workspace);
        const completeClaim = COMPLETION_CLAIM_RE.test(replyText);
        if (replyText && (ACTION_CLAIM_RE.test(replyText) || falseClaims.length > 0 || completeClaim)) {
          lazyRetried = true;
          await appendConvoMessage(convoId, { role: 'system', kind: 'notice', text: falseClaims.length
            ? `模型口头声称完成但工作区不存在 ${falseClaims.join('、')}——引擎已自动纠正重试。`
            : completeClaim
              ? '模型声称「已完成/已验证」但本轮未执行任何工具——引擎已自动纠正重试。'
              : '模型口头承诺动手但未调用任何工具——引擎已自动纠正重试。', meta: { retry: 'lazy' } });
          convo_msgs.push({ role: 'assistant', content: res.content });
          const corrective = falseClaims.length
            ? CORRECTIVE_ACT_MSG + ` 另外你声称已创建/写入的 ${falseClaims.join('、')} 在工作区中并不存在——不要虚构完成状态，实际执行后以工具结果为准。`
            : completeClaim ? CORRECTIVE_COMPLETE_MSG : CORRECTIVE_ACT_MSG;
          convo_msgs.push({ role: 'user', content: corrective });
          finalParsed = null; // 本条口头承诺作废，重驱动
          continue;
        }
      }
      // FC 模式意图叙述门（2026-09-20 实测"想改一下ui"会话）：模型执行完工具轮后用正文
      // 说"让我检查日志…"——只叙述下一步而不发起工具调用，引擎此前当作最终回复收尾，
      // turn 断在半路。纠正重试一次（有界），让模型要么发起工具、要么给完整结论。
      // 工具活动行回显（"✓ exec「…」"）同门处理——既非工具调用也非有效结论。
      if (fc && !calls.length && finalParsed && !last) {
        const replyText = String(finalParsed.reply || '');
        const isEcho = FC_ECHO_RE.test(replyText);
        const bounded = isEcho ? echoRetried : intentRetried;
        if (replyText && (isEcho || INTENT_NARRATION_RE.test(replyText)) && !bounded) {
          if (isEcho) echoRetried = true; else intentRetried = true;
          await appendConvoMessage(convoId, { role: 'system', kind: 'notice', text: isEcho
            ? '模型输出了工具记录回显而非有效回复——引擎已自动纠正重试。'
            : '模型只叙述了下一步打算但未发起工具调用——引擎已自动纠正重试。', meta: { retry: isEcho ? 'echo' : 'intent', original: replyText.slice(0, 200) } });
          convo_msgs.push({ role: 'assistant', content: res.content });
          convo_msgs.push({ role: 'user', content: isEcho ? CORRECTIVE_ECHO_MSG : CORRECTIVE_INTENT_MSG });
          finalParsed = null;
          continue;
        }
        // 有界纠正仍回显/叙述：采纳但落醒目 warn notice，用户不必当真
        if (replyText && (isEcho || INTENT_NARRATION_RE.test(replyText))) {
          plainFallback = true;
        }
      }
      break;
    }

    if (turn.aborted) {
      turnEnd = { status: 'cancelled', error_code: 'interrupted', reason: '用户打断' };
      await appendConvoMessage(convoId, { role: 'system', kind: 'interrupt', text: '用户打断了本轮执行；已完成的工作保留在工作区（见 diff），输入新指令继续。' });
    } else if (finalParsed) {
      const reply = String(finalParsed.reply || '').trim().slice(0, MAX_MESSAGE_LENGTH);
      if (reply) {
        turnEnd = { status: 'completed' };
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
        // 嘴炮/断言纠正后最终回复仍零工具：落诚实 notice，用户不必信以为真（2026-09-20 实测"已创建"假完成）
        if (lazyRetried && !toolRan) {
          const falseClaims = findFalseFileClaims(reply, convo.workspace);
          const stillClaiming = COMPLETION_CLAIM_RE.test(reply);
          await appendConvoMessage(convoId, { role: 'system', kind: 'notice', text: `提醒：本轮模型${falseClaims.length ? `声称已完成的 ${falseClaims.join('、')} 在工作区中不存在` : stillClaiming ? '声称「已完成/已验证」但未执行任何验证工具' : '声称的工作未经任何工具执行'}——以上回复不可当作完成依据，请以工具记录与 diff 卡为准，或重发指令/更换模型。` });
        }
        // P1.4 经验候选卡（半自动沉淀）：有实质结论时后台提炼 0-1 条候选，用户确认才入库
        if (reply.length >= 150 && convo.project_id) {
          void (async () => {
            try {
              const msgs = await getConvoMessages(convoId);
              const lastUser = [...msgs].reverse().find((m) => m.role === 'user' && m.kind === 'text');
              const candidates = await distillKnowledgeCandidates(
                deps.pool,
                `用户输入：${String(lastUser?.text || '').slice(0, 1500)}\n\n助手结论：${reply.slice(0, 2000)}`,
                '协作会话',
                deps.logger,
              );
              for (const cand of candidates.slice(0, 1)) {
                await appendConvoMessage(convoId, {
                  role: 'system', kind: 'notice',
                  text: `💡 经验候选：${cand.title}\n${cand.content}`,
                  meta: { knowledge_candidate: { ...cand, project_id: convo.project_id, source: `convo:${convoId}` } },
                });
              }
            } catch { /* 候选提炼失败不影响会话 */ }
          })();
        }
        for (const p of shares) {
          const rel = p.replace(/\\/g, '/');
          const abs = path.resolve(convo.workspace, rel);
          const ok = convo.workspace && (policy.jailBypass || abs.startsWith(path.resolve(convo.workspace))) && fs.existsSync(abs) && fs.statSync(abs).isFile();
          await appendConvoMessage(convoId, {
            role: 'assistant', kind: 'file', text: rel,
            meta: ok ? { path: rel, size: fs.statSync(abs).size, missing: false } : { path: rel, missing: true },
          });
        }
      } else {
        turnEnd = { status: 'failed', error_code: 'empty_output', reason: '本轮输出为空或无法解析' };
        await appendConvoMessage(convoId, { role: 'system', kind: 'notice', text: '本轮输出为空或无法解析——请换个说法重试，或更换模型。', meta: { turn_complete: true } });
      }
    } else {
      // finalParsed 为 null 且未打断（纯空输出，连散文都没有）：必须落终态标记，
      // 否则 hasPendingUserInput 会认为仍有待处理输入，对同一条消息无限重驱动（2026-09-20 修复）
      turnEnd = { status: 'failed', error_code: 'empty_output', reason: '本轮模型无任何输出' };
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
    clearInterval(busyStamp);
    turnAborts.delete(convoId);
    turnBgPids.delete(convoId);
    // P0.1：终态帧恰好一个——异常路径（未显式设置 turnEnd）按 completed 收口前先兜底判 failed
    if (!turnEnd) turnEnd = { status: 'failed', error_code: 'turn_abnormal_exit', reason: 'turn 未显式收口' };
    await emitProgress('convo_turn_end', { convo_id: convoId, status: turnEnd.status, ...(turnEnd.error_code ? { error_code: turnEnd.error_code } : {}), ...(turnEnd.reason ? { reason: turnEnd.reason } : {}) });
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
  opts?: { tools?: LlmToolSpec[] },
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
        const res = await chat(entry, msgs, undefined, 0.3, signal, WALLCLOCK_CAP_MS, onAttempt(lastSid), {
          onReason,
          ...(opts?.tools?.length ? { tools: opts.tools } : {}),
          // P0.3：首包等待硬上限（600s 零字节放弃）+ 等待心跳帧（≥120s 每 30s 一次）
          waitGiveUpMs: CONVO_WAIT_GIVEUP_MS,
          onWaitNotice: (info) => { void emitProgress('convo_waiting', { convo_id: convo.id, waited_sec: info.waitedSec, kind: info.kind, model: entry.name }); },
        });
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
        if (LLM_WAIT_GIVEUP_RE.test(reason)) {
          // P0.3：首包等待硬上限是确定性"上游无响应"——不进重试也不换模（重试只会同样黑箱），
          // 立即把明确原因抛给终局卡。
          void emitProgress('convo_retry', { convo_id: convo.id, attempt: attempt + 1, model: entry.name, reason: reason.slice(0, 120), fatal: true });
          throw new Error(`${entry.name} 首包等待超时（${reason.replace(/^.*llm_wait_giveup\(/, '').replace(/\).*$/, '')}）——上游无任何响应，已放弃本次尝试。请检查该供应商状态或更换模型。`);
        }
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
        // P0.3：重试/换模全程可见（此前 900s×10 次零反馈是"正在思考"黑箱的主因）
        void emitProgress('convo_retry', { convo_id: convo.id, attempt: attempt + 1, max: perModelRetries, model: entry.name, reason: reason.slice(0, 120) });
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

async function buildSystemPrompt(deps: ConvoDeps, convo: Convo, plugin?: AgentPlugin, policyLevel?: string): Promise<string> {
  const fc = nativeToolsOn();
  const identity = plugin?.prompt?.trim()
    || '你是「搭档」，与用户结对协作的工程 agent：直接读写项目工作区、执行命令、交付改动。';
  const proj = convo.project_id ? await getProject(convo.project_id) : null;
  const memories = convo.project_id ? await getProjectMemory(convo.project_id, 8) : [];
  const wsBlock = convo.workspace ? `\n## 工作区\n项目根目录（你的工作目录，所有相对路径基于它）：${convo.workspace}${proj ? `\n项目名：${proj.name}` : ''}` : '';
  // P1.1 项目简报注入（概念基准；无简报退化注入结构化字段）
  const briefBlock = proj?.brief
    ? `\n## 项目简报（概念基准，与现场冲突时以实际侦查为准）\n${proj.brief.slice(0, 2000)}`
    : proj && (proj.tech_stack || proj.conventions || proj.domain)
      ? `\n## 项目要点\n${[proj.tech_stack && `- 技术栈：${proj.tech_stack}`, proj.conventions && `- 约定：${proj.conventions}`, proj.domain && `- 领域：${proj.domain}`, proj.stage && `- 阶段：${proj.stage}`].filter(Boolean).join('\n')}`
      : '';

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
  const ocBlock = deps.opencode ? deps.opencode.toolsIndex(convo.agent_id) : '';

  // PH.6 回滚纠正账本（星瑶 turn_undo/prompt_context.py 同款语义）：历史消息不改字节，
  // 用纠正块向前宣告"旧结果已失效"——回滚后注入一次，turn 结束即清除。
  const rollbackBlock = convo.rollback_at
    ? `\n## ⚠️ 回滚纠正（必须遵守）\n本会话工作区已于 ${convo.rollback_at} 回滚到首轮快照。此前历史消息中对文件状态的描述**已全部失效**——继续任何工作前必须用 read_file 重新读取磁盘文件，不要盲信历史 diff、旧结论或旧行号。\n`
    : '';

  return `${identity}
# 角色边界
你运行在「协作会话」中：用户在与你结对开发真实项目。你的所有改动**直接落在项目工作区**（没有沙箱合并步骤），因此：
- 改前先看（read_file/list_files），改完必验证（构建/测试/渲染检查）；
- 每轮结束系统会自动落 git diff 卡片给用户审阅；会话首轮已自动创建快照，用户可一键回滚——但你不能依赖回滚，危险操作（删库、重置、覆盖大量文件）必须先与用户确认；
- 该工作区可能同时有其他任务/会话在并行改动，对文件内容做"读-改-写"时要基于刚读到的最新内容。
${rollbackBlock}
${wsBlock}
${briefBlock}
${scripts.length ? `\n## 项目脚本\n${scripts.join('\n')}` : ''}
${memories.length ? `\n## 本项目经验与规范\n${memories.map((m) => `- ${m.text}`).join('\n')}` : ''}
${skillsBlock ? `\n## 技能索引（正文按需 load_skill 拉取）\n${skillsBlock}` : ''}
${mcpBlock && !fc ? `\n## 外部 MCP 工具（参数放独立 arguments 字段）\n${mcpBlock}` : ''}
${ocBlock ? `\n## 外部 OpenCode 实例（可接管/派活的运行时；模型归属见实例描述）\n${ocBlock}` : ''}
${policyLevel === 'plan_only'
  ? `\n## 当前权限：plan_only（只出方案）\n本会话**不能执行命令、不能写文件**（工具会被直接拒绝、白耗迭代）。请只做只读侦查与规划，把方案讲清楚；需要真正动手时，明确提示用户在会话设置把权限切到「目录内完全控制」或「改动需审批」。`
  : policyLevel === 'readonly'
    ? `\n## 当前权限：readonly（只读）\n本会话**不能写文件**（写入会被拒绝）；可执行白名单内的只读命令。需要改动时提示用户调整权限。`
    : policyLevel === 'unrestricted'
      ? `\n## 当前权限：unrestricted（无边界）\n命令与读取**已解除目录监狱**：可以执行越界命令、读取项目目录外文件。其中**常见开发命令（node/java/npm/bash/python/git 等）越界可直接执行**；**其他越界命令会转人工审批**。**写/删文件仍只能作用于项目目录内**（write_file/edit_file 越界会被拒）。请极度谨慎，操作外部路径前先说明意图。`
      : ''}

${fc ? `## 工具（原生工具通道：直接发起工具调用，参数按工具声明传入；全部相对路径基于工作区）
只读侦查：list_files | read_file(path[,line_start,line_end]) | read_dir(path) | grep(pattern[,path]) | git_log | git_diff | load_skill(name)
执行命令：exec(command)（同步等待 ≤${convoCfg.execTimeoutSec}s） | exec_background(command)（长驻，返回 pid 与日志路径） | kill_process(pid)
修改文件：write_file(path, content)（改前先读） | edit_file(path, find, replace)
视觉辅助：screenshot(url[,question]) | look_image(path[,question]) | 渲染验证 check_page(url, expect)
阻塞提问 ask_user(question)（需要用户拍板才能继续时） | 知识沉淀 write_knowledge(category, title, content)
反馈文件 share_file(path) | 调度子智能体 spawn_agent(agent, task)（并行 ≤3）
步骤清单：write_plan(steps) | update_plan(index, status)${ocBlock ? `\nOpenCode 接管（把子任务外包给外部 opencode 执行或接管其会话；instance 用上面的实例 id）：oc_instances | oc_create_session | oc_send | oc_run_task(instance, prompt[, models 降级链]) | oc_read | oc_abort | oc_revert | oc_diff | oc_permission` : ''}` : `## 工具指南（全部相对路径基于工作区）
只读侦查： {"tool":"list_files"} | {"tool":"read_file","path":"...","line_start":N,"line_end":M} | {"tool":"read_dir","path":"..."} | {"tool":"grep","pattern":"正则","path":"可选子路径"} | {"tool":"git_log"} | {"tool":"git_diff"} | {"tool":"load_skill","name":"技能名"}
执行命令（同步等待 ≤${convoCfg.execTimeoutSec}s：装依赖、构建、测试、查端口）：
 {"tool":"exec","command":"npm test"}
长驻服务（后台启动返回 pid 与日志路径）： {"tool":"exec_background","command":"npm run dev"}   停止： {"tool":"kill_process","pid":12345}
修改文件（直接写入项目工作区，改前先读）：
 {"tool":"write_file","path":"相对路径","content":"文件全文"} 或 {"tool":"edit_file","path":"相对路径","find":"原文片段","replace":"新片段"}
视觉辅助： {"tool":"screenshot","url":"http://localhost:PORT/","question":"..."} | {"tool":"look_image","path":"相对路径","question":"..."} | 渲染验证 {"tool":"check_page","url":"...","expect":["关键文本"]}
阻塞提问（需要用户拍板才能继续时）： {"tool":"ask_user","question":"问题"}   知识沉淀： {"tool":"write_knowledge","category":"general-tech|project|feedback|decision|reference","title":"标题","content":"内容"}
反馈文件给用户（文件卡片，可预览下载）： {"tool":"share_file","path":"相对路径"}
调度子智能体（并行 ≤3，各自独立工具循环；适合并行侦查/评审/测试等分工）： {"tool":"spawn_agent","agent":"dev|review|docs|test|...","task":"明确的子任务描述"}
任务步骤清单（多文件/多验证环节的活先规划再动手，逐步打勾；简单问答不要用）：
 {"tool":"write_plan","steps":["步骤1","步骤2","..."]}   {"tool":"update_plan","index":N,"status":"done|in_progress|blocked"}
${mcpBlock ? '外部 MCP 工具： {"tool":"mcp__<服务>__<工具>","arguments":{...}}' : ''}`}

${fc ? `## 输出方式
- 需要动手：直接发起工具调用（工具通道，不要把工具调用写进正文文字）；
- 回复用户：正文直接输出 markdown 回复即可，不要再包 JSON。
- 工具结果以 user 消息回喂；信息足够就收尾回复，需要继续就发起下一批工具调用。用户随时可能插话（排队/打断），被打断后如实汇报已完成部分。
- 🚫 最严重违约：正文说"即将动手/正在执行/第一步是…"却一个工具调用都不发——口头承诺不算执行，用户只会看到空话。要么此刻就发起工具调用，要么明确说明你在等待什么、缺什么。` : `## 输出契约（最终输出必须是纯 JSON，禁止 markdown 代码栅栏）
A 需要动手：{"tool_calls":[ {"tool":"..."}, ... ]}
   ⚠️ 数组每一项必须以 "tool" 字段开头（如 {"tool":"read_file","path":"a.ts"}）；禁止用 name/function 包裹参数。
B 回复用户：{"reply":"给用户的完整回复（markdown）","share_files":["可选：反馈给用户的文件相对路径"]}
工具结果以 user 消息回喂；信息足够就用 B 收尾，需要继续就发 A。用户随时可能插话（排队/打断），被打断后如实汇报已完成部分。
🚫 最严重违约：用 B 说"即将动手/正在执行/第一步是…"却一个 tool_calls 都不发——口头承诺不算执行，用户只会看到空话。要么此刻就发 A，要么用 B 明确说明你在等待什么、缺什么。`}

## 证据纪律（最高优先，防幻觉）
1. 对本项目的一切事实断言（技术栈、依赖、文件内容、函数位置、行号、配置、历史结论），必须来自你本轮或可见上下文中真实读过的工具结果；没读过 → 先用只读工具核实，或明确说「这一点我未核实」。
2. 未经工具结果证实的「已修复/已完成/已验证/测试通过」类结论，禁止写进给用户的回复——要么先验证再宣布，要么如实说明未验证。
3. 不知道就直说「我不确定/需要查一下」，禁止编造路径、行号、API 或项目约定。
4. 引用早期被折叠的会话历史（压缩摘要之前的内容）前，必须重新侦查确认——摘要可能不完整。
5. 与项目经验/规范相关的问题，优先对照上方「本项目经验与规范」与知识检索结果作答；命中时注明依据，未命中且超出一般常识时明说「项目知识库没有相关记录，以下基于一般经验，建议核实」。

## 行动优先
- 侦查是手段不是目的：需要动手时第一批工具就把关键侦查+主动作发出，不要用"接下来我将…"的口头承诺收尾；
- 咨询/执行分流（2026-09-20 实测"想改一下ui"会话）：用户要**建议/分析/评估/方案**（"有什么建议吗/怎么看待/评估一下"）→ 少量关键侦查（读相关文件，≤5 轮）后直接给完整结论，**不要启动服务/跑构建/探活**（那些是为验证改动服务的，用户此刻要的是建议）；用户要**改/加/修/建**（"改一下/加个/修好"）→ 才进入执行路径（写文件/起服务/验证）；
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
  const ocBridge = deps.opencode;
  if (ocBridge) knowledgeCtx.opencode = ocBridge;

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
      if (isOcTool(name)) {
        // OpenCode 接管工具（oc_*）：派活给外部 opencode 实例 / 接管其会话。
        // 门控（实例白名单/档位/allow_shell）在 OpencodeManager 内，异常软收口。
        const ocBridge = deps.opencode;
        if (!ocBridge) { results.push({ tool: name, ok: false, error: '本会话未接入 OpenCode 实例（config.yaml 的 opencode.instances 未配置或本 agent 未绑定）' }); continue; }
        const r = await runOpencodeTool(ocBridge, convo.agent_id, call);
        results.push(r);
        records.push({ tool: name, args_summary: argsSummary(call), output_gist: gist(r), ok: (r as any)?.ok !== false });
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
        const plan = { steps: steps.map((t) => ({ text: t, status: 'pending' as const, ts: new Date().toISOString() })), updated_at: new Date().toISOString() };
        await patchConvo(convo.id, { plan });
        await emitProgress('convo_plan', { convo_id: convo.id, plan });
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
        await patchConvo(convo.id, { plan: cur.plan });
        await emitProgress('convo_plan', { convo_id: convo.id, plan: cur.plan });
        const done = steps.filter((x) => x.status === 'done').length;
        results.push({ tool: name, ok: true, progress: `${done}/${steps.length}` });
        records.push({ tool: name, args_summary: `${idx + 1}. ${steps[idx].text}`.slice(0, 120), output_gist: `进度 ${done}/${steps.length}`, ok: true });
        continue;
      }
      if (name === 'share_file') {
        const rel = String(call.path || '').trim().replace(/\\/g, '/');
        const abs = convo.workspace ? path.resolve(convo.workspace, rel) : '';
        const ok = !!rel && !!convo.workspace && (policy.jailBypass || abs.startsWith(path.resolve(convo.workspace))) && fs.existsSync(abs) && fs.statSync(abs).isFile();
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
    else if (t.startsWith('oc_')) segs.push(`${ok ? '✓' : '✗'} OpenCode ${t.slice(3)}${c.session ? ` · ${String(c.session).slice(0, 8)}` : ''}${ok && r.session ? ` → ${String(r.session).slice(0, 8)}` : ''}${ok ? '' : ' 失败'}`);
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
  // full = 会话目录内完全控制（2026-09-20 实测 learn-english 会话）：除 strict 绝对禁止外
  // 全部放行——敏感门也豁免。unrestricted（无边界）= 命令监狱解除：越界的常见开发命令
  // （node/java/npm/bash/python/git 等）直接执行；其余越界命令转人工审批（见下）。
  // 目录监狱与 strict 拦截在 full 下仍生效。
  const needApproval = policy.level !== 'full' && policy.level !== 'unrestricted' && (!canExecute(policy, command) || (cls.sensitive && !policy.allow_sensitive));
  if (needApproval && !matchesAlways(always, command)) {
    const verdict = await parkForApproval(deps, convo, command, 'whitelist');
    if (verdict.status === 'rejected') return { tool, ok: false, error: '用户拒绝执行该命令' };
    if (verdict.status === 'approved_always') {
      const list = await sessionAlwaysList(convo.id);
      list.push(command);
      await busSet(alwaysKey(convo.id), list.slice(-30));
    }
  }

  // unrestricted：命令监狱已解除——越界命令记审计日志（保持现状）；常见开发命令直接放行，
  // 其余越界命令转人工审批。
  if (policy.jailBypass) {
    const jail = assertWithinJail(command, convo.workspace);
    if (!jail.ok) {
      deps.logger.warn('convo unrestricted 越界命令', { convoId: convo.id, command: command.slice(0, 200), violations: jail.violations.slice(0, 5), dev: isCommonDevCommand(command) });
      if (!isCommonDevCommand(command) && !matchesAlways(always, command)) {
        const verdict = await parkForApproval(deps, convo, command, 'jail_out_of_scope');
        if (verdict.status === 'rejected') return { tool, ok: false, error: '用户拒绝越界命令' };
        if (verdict.status === 'approved_always') {
          const list = await sessionAlwaysList(convo.id);
          list.push(command);
          await busSet(alwaysKey(convo.id), list.slice(-30));
        }
      }
    }
  }

  if (background) {
    // 目录监狱：非 unrestricted 时后台命令同样受限（此前后台分支漏检 jail，2026-09-21 修复）
    if (!policy.jailBypass) {
      const jail = assertWithinJail(command, convo.workspace);
      if (!jail.ok) return { tool, ok: false, error: jailViolationMessage(jail.violations, convo.workspace) };
    }
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
    ? { level: 'full', whitelistCommands: null, maxTimeSec: policy.maxTimeSec, allow_sensitive: policy.allow_sensitive, jailBypass: policy.jailBypass }
    : policy;
  const r = await executeCommandAsync(command, convo.workspace, execPolicy, convoCfg.execTimeoutSec, signal);
  return {
    tool, ok: r.allowed, command, returncode: r.returncode,
    stdout: r.stdout.slice(-3000), stderr: r.stderr.slice(-1500),
    ...(r.allowed ? {} : { error: r.stderr || 'command not allowed' }),
  };
}

/** 审批 park：落库 + 事件 + 阻塞等待用户裁决（once/always/reject；打断/删除会话连带拒绝） */
async function parkForApproval(deps: ConvoDeps, convo: Convo, command: string, reason: 'whitelist' | 'jail_out_of_scope' = 'whitelist'): Promise<ConvoApproval> {
  const rec: ConvoApproval = { id: newId(), command, ts: new Date().toISOString(), status: 'pending', reason };
  const list = await loadApprovals(convo.id);
  list.push(rec);
  await busSet(approvalsKey(convo.id), list.slice(-50));
  const cur = await getConvo(convo.id);
  await patchConvo(convo.id, { status: 'waiting_approval' });
  await emitProgress('convo_status', { convo_id: convo.id, status: 'waiting_approval' });
  await emitProgress('convo_approval', { convo_id: convo.id, approval: rec });
  await appendConvoMessage(convo.id, { role: 'system', kind: 'approval', text: command, meta: { approval_id: rec.id, command, status: 'pending', reason } });

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
  await patchConvo(convo.id, { status: 'running' });
  await emitProgress('convo_status', { convo_id: convo.id, status: 'running' });
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
  await patchConvo(convo.id, { status: 'waiting_ask' });
  await emitProgress('convo_status', { convo_id: convo.id, status: 'waiting_ask' });
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
  await patchConvo(convo.id, { status: 'running' });
  await emitProgress('convo_status', { convo_id: convo.id, status: 'running' });

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

/** 触发阈值（P2.5 token 化）：锚点后消息条数 ≥60 或估算 token ≥ 0.5×主模型窗口即压缩 */
const COMPACTION_THRESHOLD = 60;
const COMPACTION_TOKEN_RATIO = 0.5;
const COMPACTION_KEEP_RAW = 10;
const COMPACTION_CAP_MS = 60_000;
/** 压缩失败 notice 的限频（≥6h 才再提醒一次，防刷屏） */
const COMPACTION_FAIL_NOTICE_MS = 6 * 3600 * 1000;

/**
 * 长对话自动压缩（M5 / P2.5 修复版）：锚点后消息超阈值（条数或 token 水位）→ LLM 把
 * 「锚点后 ~ 最近 10 条」折叠为结构化摘要，追加进 compaction 锚点（下一 turn 的 LLM
 * 历史 = 摘要 + 锚点后消息）。尽力而为：失败落限频 notice（用户可见，不再静默），
 * 绝不阻塞正常对话。
 */
async function maybeCompact(deps: ConvoDeps, convo: Convo): Promise<void> {
  try {
    const msgs = await getConvoMessages(convo.id);
    const uptoIdx = convo.compaction ? msgs.findIndex((m) => m.id === convo.compaction!.upto_id) : -1;
    const pending = msgs.length - (uptoIdx + 1);
    const pendingText = msgs.slice(uptoIdx + 1).map((m) => m.text).join('\n');
    const { entry: primary } = resolvePrimary(deps, convo);
    const tokenCap = primary?.context_length ? Math.floor(primary.context_length * COMPACTION_TOKEN_RATIO) : 24000;
    const pendingTokens = estimateTokens(pendingText);
    if (pending < COMPACTION_THRESHOLD && pendingTokens < tokenCap) return;
    const slice = msgs.slice(uptoIdx + 1, msgs.length - COMPACTION_KEEP_RAW);
    if (slice.length < 10) return;
    const { entry } = resolvePrimary(deps, convo);
    if (!entry) return;
    // P2.5 双截断修复：每条 240→400 字符；整体截断改为保头+保尾（中段 marker）——
    // 旧实现 .slice(-24000) 尾切会把"用户最初的目标与决策"整段丢掉
    const perMsg = 400;
    let transcript = slice
      .map((m) => `${m.role}/${m.kind}: ${m.text.replace(/\s+/g, ' ').slice(0, perMsg)}`)
      .join('\n');
    if (transcript.length > 40000) {
      const headKeep = 26000;
      const tailKeep = 13000;
      transcript = `${transcript.slice(0, headKeep)}\n…[中段 ${transcript.length - headKeep - tailKeep} 字符压缩输入已省略，正文仍在会话流中]…\n${transcript.slice(-tailKeep)}`;
    }
    const res = await chat(entry, [
      { role: 'system', content: '你是会话压缩器。把协作会话的早期历史压缩为后续对话可续用的结构化中文摘要（≤1200 字），必须保留：用户的目标与全部决策、已完成的改动（文件/命令/结果）、未完成事项、关键约定与教训。只输出摘要正文。' },
      { role: 'user', content: `${convo.compaction ? `此前已有摘要（请在此基础上合并）：\n${convo.compaction.summary}\n\n` : ''}以下是待压缩的历史：\n${transcript}` },
    ], undefined, 0.2, undefined, COMPACTION_CAP_MS);
    const summary = res.content.trim().slice(0, 4000);
    if (!summary) return;
    const compaction = { summary, upto_id: slice[slice.length - 1].id, at: new Date().toISOString() };
    await patchConvo(convo.id, { compaction });
    await appendConvoMessage(convo.id, { role: 'system', kind: 'notice', text: `长对话自动压缩：${slice.length} 条早期消息已折叠为摘要（最近 ${COMPACTION_KEEP_RAW} 条保持原文），上下文规模得到控制。` });
    deps.logger.info('convo compaction done', { convoId: convo.id, folded: slice.length, pendingTokens });
  } catch (e) {
    const msg = String((e as Error)?.message || e);
    deps.logger.warn('convo compaction skipped', { convoId: convo.id, error: msg.slice(0, 160) });
    // P2.5 失败可见：限频落 notice（压缩连续失败用户有权知道，而不是摘要悄悄过期）
    try {
      const failKey = `convo:${convo.id}:compaction_fail_notice`;
      const last = (await busGet<string>(failKey)) || '';
      if (!last || Date.now() - new Date(last).getTime() > COMPACTION_FAIL_NOTICE_MS) {
        await busSet(failKey, new Date().toISOString(), 7 * 24 * 3600);
        await appendConvoMessage(convo.id, { role: 'system', kind: 'notice', text: `长对话压缩失败（${msg.slice(0, 80)}）——历史暂时保持原文，上下文占用会继续增长；若对话变慢可开新会话（fork 可携带摘要）。` });
      }
    } catch { /* 通知失败不追踪 */ }
  }
}

/** 标题自动生成（首轮）：取首条用户消息前 24 字。 */
async function ensureTitle(convo: Convo): Promise<void> {
  if (convo.title !== '未命名会话') return;
  const msgs = await getConvoMessages(convo.id);
  const firstUser = msgs.find((m) => m.role === 'user' && m.kind === 'text' && m.text.trim());
  if (!firstUser) return;
  const title = firstUser.text.replace(/\s+/g, ' ').trim().slice(0, 24) || convo.title;
  // 局部写：重读最新再合并，避免覆盖用户并发修改的 policy_level 等字段
  await patchConvo(convo.id, { title });
  await emitProgress('convo_status', { convo_id: convo.id, status: convo.status, title });
}

/** fork：按消息锚点复制出新会话（工作区/模型/人设/压缩锚点随迁，快照重新累计）。
 *  权限默认重置为「继承全局」（D：避免副本继承源会话的 plan_only 而继续卡死）；
 *  显式传 resetPolicy:false 才保留源权限。 */
export async function forkConvo(deps: ConvoDeps, id: string, opts?: { message_id?: string; title?: string; resetPolicy?: boolean }): Promise<Convo> {
  const src = await getConvo(id);
  if (!src) throw new ConvoError(404, `convo not found: ${id}`);
  const msgs = await getConvoMessages(id);
  let upto = msgs.length - 1;
  if (opts?.message_id) {
    const i = msgs.findIndex((m) => m.id === opts.message_id);
    if (i < 0) throw new ConvoError(400, `message not found: ${opts.message_id}`);
    upto = i;
  }
  const resetPolicy = opts?.resetPolicy !== false;
  const copy: Convo = {
    ...src,
    policy_level: resetPolicy ? undefined : src.policy_level,
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
  // PH.6：标记回滚时间——下一个 turn 的 system prompt 注入纠正账本（runTurnCore 注入后清除）
  const live = await getConvo(convoId);
  if (live) { live.rollback_at = new Date().toISOString(); await saveConvo(live); }
  await appendConvoMessage(convoId, { role: 'system', kind: 'notice', text: `已回滚到会话首轮快照（${snap.created_at}）——工作区改动已还原。历史消息中的文件结果已失效，下轮对话我会先重新读取磁盘再动手。` });
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

  // PH.4 事实包：子 agent 此前零项目上下文——断言全靠编。注入最小事实集（项目记忆 top3
  // + 与子任务相关的知识条目 top2）+ 证据纪律，让子 agent "有据可依、无据明说"。
  const factLines: string[] = [];
  try {
    if (convo.project_id) {
      const facts = await getProjectMemory(convo.project_id, 3);
      for (const f of facts) factLines.push(`- 【项目记忆】${f.text.slice(0, 160)}`);
    }
    const kn = await relevantKnowledge(`${agentName} ${task}`, { limit: 2, project_id: convo.project_id }).catch(() => []);
    for (const k of kn) factLines.push(`- 【知识库《${k.title}》】${k.content.replace(/\s+/g, ' ').slice(0, 160)}`);
  } catch { /* best-effort：事实包失败不阻塞子任务 */ }

  const sys = `${plugin.prompt?.trim() || `你是「${agentName}」agent。`}
# 角色
你是被主 agent（搭档）通过 spawn_agent 调度的子智能体，在项目工作区执行一个明确的子任务。完成后用 reply 给出简洁的中文摘要（做了什么、结果如何、关键发现），不要向用户提问——有障碍就如实写进摘要。

# 证据纪律（防幻觉）
- 摘要里的每个结论必须基于你真实调用过的工具结果；没查到的就说「未核实」，禁止编造路径/行号/结论。
- 下方"相关事实"仅供参考（可能过时），动手前以实际侦查为准。

${factLines.length ? `# 相关事实（主 agent 项目记忆与知识库，可能过时）\n${factLines.join('\n')}\n` : ''}
# 工作区
${convo.workspace || '（无绑定工作区）'}
${plugin.skills?.length ? `\n# 绑定技能（正文用 load_skill 拉取）\n${plugin.skills.join('、')}` : ''}

## 工具（相对路径基于工作区）
${nativeToolsOn()
    ? '工具通过供应商 tool_calls 通道直接调用（不要把工具调用写进正文文字）；单轮可并发多个调用。'
    : '侦查：{"tool":"list_files"} | {"tool":"read_file","path":"..","line_start":N,"line_end":M} | {"tool":"grep","pattern":".."} | {"tool":"git_diff"}\n执行：{"tool":"exec","command":".."}（≤${convoCfg.execTimeoutSec}s） | {"tool":"exec_background","command":".."} | {"tool":"kill_process","pid":N}\n写入：{"tool":"write_file","path":"..","content":".."} | {"tool":"edit_file","path":"..","find":"..","replace":".."}\n技能/知识：{"tool":"load_skill","name":".."} | {"tool":"write_knowledge","category":"project","title":"..","content":".."}'}
${deps.mcp ? `\n## 外部 MCP 工具\n${deps.mcp.toolsIndex(agentName)}` : ''}

## 输出契约
${nativeToolsOn()
    ? '需要动手就发起 tool_calls（供应商工具通道）；工作已完成就直接输出正文摘要（不再包 JSON）。'
    : '纯 JSON，禁止代码栅栏：A 动手：{"tool_calls":[...]}   B 收尾：{"reply":"子任务摘要"}'}
工具结果以 user 消息回喂。`; 

  const msgs: { role: string; content: string | unknown[] }[] = [
    { role: 'system', content: sys },
    { role: 'user', content: `## 子任务\n${task.trim().slice(0, 6000)}` },
  ];

  const startTs = Date.now();
  await appendConvoMessage(convo.id, { role: 'assistant', kind: 'tool', text: `子智能体 ${agentName} 开始：${task.trim().slice(0, 60)}`, model: primary.name, meta: { subagent: agentName, phase: 'start', task: task.trim().slice(0, 200) } });

  let summary = '';
  const stepLines: string[] = [];
  const subFailures: string[] = []; // PH.4：子任务期间任何工具失败都记录——"嘴上成功但工具有失败"不允许以 ok 回传
  let summaryNudged = false;       // PH.4：结果过短时补写一次（有界）
  try {
    for (let iter = 0; iter < SUB_MAX_ITER; iter++) {
      if (signal.aborted) { turn.aborted = true; break; }
      const last = iter === SUB_MAX_ITER - 1;
      const fc = nativeToolsOn();
      const fcTools = fc ? buildConvoTools({ mcp: deps.mcp, agentId: plugin?.name || convo.agent_id, execTimeoutSec: convoCfg.execTimeoutSec ?? 180, level: policy.level }) : undefined;
      if (last) msgs.push({ role: 'user', content: fc
        ? '工具迭代次数已用完：不要再调用工具，立即基于已获得的信息给出子任务摘要（如实说明已完成与未完成的部分）。'
        : '工具迭代次数已用完：不要再调用工具，立即用 reply 基于已获得的信息给出子任务摘要（如实说明已完成与未完成的部分）。' });
      let res: LlmResponse;
      let used = chain[0];
      try {
        res = await chat(chain[0], msgs, undefined, 0.3, signal, SUB_WALLCLOCK_CAP_MS, undefined, fcTools ? { tools: fcTools } : undefined);
      } catch (e: any) {
        if (signal.aborted) break;
        const reason = String(e?.message || e);
        const next = chain[1];
        if (!next) { summary = `子任务中断：模型调用失败（${reason.slice(0, 120)}）`; break; }
        await appendConvoMessage(convo.id, { role: 'system', kind: 'notice', text: `子智能体 ${agentName}：${chain[0].name} 调用失败，切换 ${next.name}。` });
        try {
          res = await chat(next, msgs, undefined, 0.3, signal, SUB_WALLCLOCK_CAP_MS, undefined, fcTools ? { tools: fcTools } : undefined);
          used = next;
        } catch (e2: any) {
          if (signal.aborted) break;
          summary = `子任务中断：模型链全部失败（${String(e2?.message || e2).slice(0, 120)}）`;
          break;
        }
      }
      // 原生 function calling：工具优先来自供应商 tool_calls；正文 JSON/纯散文兜底
      let calls = fc ? (normalizeToolCalls(res.toolCalls) as Record<string, any>[]) : [];
      const parsed = extractJson(res.content);
      if (!calls.length) {
        calls = normalizeToolCalls(parsed?.tool_calls);
        if (!calls.length && !parsed && res.content.includes('"tool"')) calls = salvageToolCalls(res.content);
      }
      if (calls.length && !last) {
        const sub = await runSubToolCalls(deps, convo, plugin, policy, calls, turn, signal);
        stepLines.push(...sub.lines);
        for (const rec of sub.records) {
          if (rec && typeof rec === 'object' && (rec as any).ok === false) {
            subFailures.push(`${String((rec as any).tool || '工具')}: ${String((rec as any).error || (rec as any).output_gist || '失败').slice(0, 100)}`);
          }
        }
        await appendConvoMessage(convo.id, { role: 'assistant', kind: 'tool', text: sub.line, model: used.name, meta: { subagent: agentName, calls: sub.records } });
        msgs.push({ role: 'assistant', content: res.content });
        msgs.push({ role: 'user', content: `工具执行结果：\n${JSON.stringify(sub.results).slice(0, 12000)}\n\n${fc ? '信息足够就直接输出子任务摘要（正文，不再包 JSON）；需要继续再发起工具调用。' : '信息足够就 reply 收尾；需要继续再发 tool_calls。'}` });
        continue;
      }
      summary = String(parsed?.reply || res.content || '').trim().slice(0, 4000) || '（子任务无输出）';
      // PH.4：结果过短（敷衍摘要）→ 补写一轮（有界一次），别让主 agent 拿到空话当结论。
      // 阈值 60 字：一句话事实性摘要放行，纯"完成了"式空话才触发补写
      if (!last && !summaryNudged && summary.length < 60 && !signal.aborted) {
        summaryNudged = true;
        msgs.push({ role: 'assistant', content: res.content });
        msgs.push({ role: 'user', content: '你的摘要太简短，主 agent 无法据此判断子任务成果。请补充：具体做了什么改动/查到什么结论、验证方式与结果、关键发现或障碍。重新用 reply 给出完整摘要（如实说明未完成部分）。' });
        continue;
      }
      break;
    }
  } finally {
    if (!summary) summary = signal.aborted ? '子任务被用户打断，已完成部分保留在工作区。' : '子任务达到迭代上限未给出摘要。';
    // PH.4：失败明细并入最终摘要（done 卡与主循环工具结果共用同一 summary）
    if (subFailures.length) summary = `${summary}\n\n⚠️ 子任务期间有 ${subFailures.length} 次工具执行失败：${subFailures.slice(0, 3).join('；')}`;
    await appendConvoMessage(convo.id, {
      role: 'assistant', kind: 'tool',
      text: `子智能体 ${agentName} 完成（${Math.round((Date.now() - startTs) / 1000)}s · ${stepLines.length} 步）：${summary.slice(0, 80)}`,
      model: primary.name,
      meta: { subagent: agentName, phase: 'done', summary, steps: stepLines.slice(-20) },
    });
  }
  return {
    tool: 'spawn_agent',
    // PH.4：工具失败污染完成态——有失败记录就不许以 ok 回传（星瑶 tools.py:3239-3243 同语义）
    ok: !signal.aborted && subFailures.length === 0,
    agent: agentName,
    summary,
    steps: stepLines.length,
    ...(subFailures.length ? { tool_failures: subFailures } : {}),
  };
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
  if (deps.opencode) knowledgeCtx.opencode = deps.opencode;
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
      if (isOcTool(name)) {
        // OpenCode 接管工具（oc_*）：子 agent 也可派活/接管；门控在 manager 内，异常软收口。
        const ocBridge = deps.opencode;
        if (!ocBridge) { results.push({ tool: name, ok: false, error: '本会话未接入 OpenCode 实例（未配置或本 agent 未绑定）' }); continue; }
        const r = await runOpencodeTool(ocBridge, plugin.name, call);
        results.push(r);
        records.push({ tool: name, args_summary: String(call.prompt || call.instance || '').slice(0, 120), output_gist: gist(r), ok: (r as any)?.ok !== false });
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
