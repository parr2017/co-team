/**
 * 群组沟通（group discussion）：用户 + 多 agent 的群聊式项目协作现场。
 *
 * 引擎 v2（2026-09-09 改造，替代"回合制点名 + 纯文本白板"）：
 * - 发言人路由：每轮由一个便宜模型的路由器按"用户最新指示 + 讨论现状"挑选 1-3 位
 *   真正有新东西可说的成员，不再全员按固定顺序串行点名；@点名时只跑被点名者。
 * - 轮内真打断：用户消息随时入库（不再 409 拒收），当前发言者说完即发现新指示、
 *   终止本轮剩余成员并以新消息重新路由。
 * - 组内长手：成员可直接读项目文件、执行命令、启动/停止服务、做小范围代码修改
 *   （单轮 ≤3 文件 / ≤80 行，写前 git checkpoint）并重启验证——"启动项目"这类
 *   诉求在群内闭环，超预算的改动才转任务。工具过程落进讨论流（可折叠活动条），
 *   过程可见即幻觉可审计。
 * - 项目全量背景注入：绑定项目的讨论把项目路径、脚本、全部项目记忆与知识库条目
 *   作为所有成员共享的静态前缀（保推理服务前缀缓存），杜绝"编造路径"。
 * - 流式上屏：发言以 reply 字段增量流式广播（discussion_message_delta），
 *   工具轮结束后正式消息替换。
 *
 * 设计约束：
 * - 讨论不占用 taskQueue 车道（LLM 直调 + 沙箱工具直执）；
 * - 全部状态走 message bus KV（Redis 或内存），天然获得持久化与 WS 通道；
 * - 目录监狱对所有执行/写工具生效：越界绝对路径与 `..` 一律拒绝；
 * - 批量新建文件、架构级改动仍走「生成方案 → 转项目开发」任务管线。
 */
import { busGet, busSet, busDel, busKeys } from './bus';
import { emitProgress, addProjectMemory, addAgentMemory, getAgentMemory, getProjectMemory, saveProject, getProject, getTaskGraph } from './store';
import type { ProjectRecord } from './store';
import { chat, extractJson, stripCodeFence, salvageToolCalls } from './llm';
import type { ModelPool } from './scheduler';
import type { Orchestrator } from './orchestrator/orchestrator';
import type { TaskQueueManager } from './taskQueue';
import type { Logger } from './logger';
import { writeKnowledge, relevantKnowledge, listKnowledge } from './knowledge';
import { scaffoldProject, initGitOnly } from './scaffold';
import { applyToolCalls, applyEdits, checkPage } from './tools';
import { executeCommandAsync, canExecute, policyFromConfig, type PermissionPolicy } from './sandbox';
import { assertWithinJail, jailViolationMessage } from './workspace';
import { discussionTaskDigest } from './discussionBridge';
import { CAPACITY_RE } from './orchestrator/orchestrator';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// ---------- types ----------

export type DiscussionMode = 'manual' | 'auto';
export type DiscussionStatus = 'discussing' | 'converged' | 'converted';

export interface Discussion {
  id: string;
  title: string;
  topic?: string;
  /** participating agent names (validated against the agent registry) */
  members: string[];
  mode: DiscussionMode;
  status: DiscussionStatus;
  /** the accumulated project planning scheme (markdown) */
  scheme: string;
  scheme_version: number;
  /** attached target project (experiences go to its category directly) */
  project_id?: string;
  /** set after convertToProject */
  task_id?: string;
  created_at: string;
  updated_at: string;
}

export interface DiscussionMessage {
  id: string;
  /** 'user' | agent name | 'system' */
  from: string;
  text: string;
  ts: string;
  round?: number;
  /** agents the user @-mentioned in this message */
  mentioned?: string[];
  /** agent raised a question that needs the user's judgement (ask_user) */
  needs_user?: boolean;
  /** system-message rendering hint: 'notice' 轻灰失败提示 / 'card' 居中卡片 */
  kind?: 'notice' | 'card';
  /** agent tool-activity line (🔧 exec …), rendered as a collapsed activity bar */
  tool?: boolean;
  /** user message quoting another message */
  reply_to?: string;
  /** emoji reactions: emoji -> reactor names */
  reactions?: Record<string, string[]>;
  /** M5.2 任务↔群聊互通：bridge_ask 卡片（task_id+ask_id）等结构化附加信息 */
  meta?: Record<string, any>;
  /** 产生这条发言的模型（群聊模型徽标） */
  model?: string;
}

export interface DiscussionDeps {
  orchestrator: Orchestrator;
  pool: ModelPool;
  taskQueue: TaskQueueManager;
  logger: Logger;
}

/** Error carrying an HTTP status so the API layer can map it 1:1. */
export class DiscussionError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

// ---------- constants ----------

const MAX_MESSAGES = 500;
const MAX_MESSAGE_LENGTH = 4000;
/** per user-message trigger: at most this many response rounds (interrupts included) */
const MAX_ROUNDS_PER_TRIGGER = 3;
/** per-round context: keep the window bounded so long discussions don't explode tokens */
const CONTEXT_MESSAGES = 30;
const SCHEME_CONTEXT_CHARS = 3000;
const BUSY_TTL_MS = 10 * 60 * 1000;
/** planAsync tasks poll for 'planned' before auto-run enqueue */
const PLAN_WAIT_TIMEOUT_MS = 10 * 60 * 1000;
const PLAN_WAIT_INTERVAL_MS = 2000;
/** 发言墙钟保险丝：默认关闭（0）——与 2026-09-09「超时不判死」纪律对齐。
 *  实测：推理模型带全量项目上下文 + 工具结果回喂，单轮生成可远超 300s
 *  （launcher 曾被 300s 砍在半路）。失败判定只认 stream_stalled（llm 层
 *  900s 静默 watchdog）与用户「打断并停止」。 */
const SPEAKER_WALLCLOCK_CAP_MS = 0;
/** 幕后辅助调用（路由/主持收敛判定）的墙钟：这类调用没有人在等的正当性 */
const ROUTER_WALLCLOCK_CAP_MS = 60_000;
const MODERATOR_WALLCLOCK_CAP_MS = 90_000;
/** 一次发言内最多工具迭代次数（末次强制以发言收尾；0l7ybpte/p65y6inq 实测
 *  3 次会被侦查用完导致"承诺式收尾"，主动作轮不到执行——放宽到 5） */
const MAX_TOOL_ITER = 5;
/** 群内同步命令的超时（秒）；长驻服务用 exec_background */
const EXEC_TIMEOUT_SEC = 90;
/** 小改预算：单轮发言写 ≤N 文件、合计 ≤M 行，超出引导转任务 */
const WRITE_BUDGET_FILES = 3;
const WRITE_BUDGET_LINES = 80;
const WRITE_MAX_FILE_CHARS = 6000;
/** 路由器单轮最多选出的发言者 */
const MAX_ROUND_SPEAKERS = 3;
/** 流式 delta 节流 */
const DELTA_MIN_CHARS = 6;
const DELTA_MIN_MS = 150;
/** 承诺式收尾检测（p65y6inq 教训："正式启动 UI 开发任务"后 0 工具调用掉球） */
const COMMITMENT_RE = /(?:正式启动|立即启动|马上开始|即刻下发|现在开始|接下来我将|下一步我|我将采取|分[二三四五]步|我将分|马上执行|立即执行)/;

// ---------- discussion-level configuration (config.yaml `discussion:`) ----------

export interface DiscussionConfig {
  permissions?: { level?: string; whitelist_commands?: string[]; max_time_sec?: number };
  max_rounds?: number;
  project_context_char_cap?: number;
}

let discCfg: Required<Pick<DiscussionConfig, 'max_rounds' | 'project_context_char_cap'>> & { policy: PermissionPolicy } = {
  max_rounds: MAX_ROUNDS_PER_TRIGGER,
  project_context_char_cap: 24_000,
  // 缺省：项目目录（监狱）内完全控制——"启动项目/小改重启"在群内闭环的前提。
  policy: { level: 'full', whitelistCommands: null, maxTimeSec: EXEC_TIMEOUT_SEC },
};

/** Wire config.yaml `discussion:` at server boot. */
export function configureDiscussion(cfg?: DiscussionConfig): void {
  if (!cfg) return;
  if (typeof cfg.max_rounds === 'number' && cfg.max_rounds > 0) discCfg.max_rounds = Math.min(10, Math.floor(cfg.max_rounds));
  if (typeof cfg.project_context_char_cap === 'number' && cfg.project_context_char_cap > 0) discCfg.project_context_char_cap = cfg.project_context_char_cap;
  if (cfg.permissions) discCfg.policy = policyFromConfig(cfg.permissions);
}

/** test hook */
export function __getDiscussionConfig(): typeof discCfg {
  return discCfg;
}

// ---------- KV helpers ----------

function discKey(id: string) { return `discussion:${id}`; }
function msgKey(id: string) { return `discussion:${id}:messages`; }
function busyKey(id: string) { return `discussion:${id}:busy`; }
function stopKey(id: string) { return `discussion:${id}:stop`; }

function newId(): string {
  return Math.random().toString(36).slice(2, 10);
}

export async function getDiscussion(id: string): Promise<Discussion | null> {
  return busGet<Discussion>(discKey(id));
}

async function saveDiscussion(d: Discussion): Promise<void> {
  d.updated_at = new Date().toISOString();
  await busSet(discKey(d.id), d);
}

export async function listDiscussions(): Promise<Discussion[]> {
  const keys = (await busKeys('discussion:*')).filter((k) => !k.includes(':messages') && !k.includes(':busy') && !k.includes(':stop'));
  const out: Discussion[] = [];
  for (const key of keys) {
    const d = await busGet<Discussion>(key);
    if (d && typeof d.id === 'string' && Array.isArray(d.members)) out.push(d);
  }
  out.sort((a, b) => (b.updated_at || '').localeCompare(a.updated_at || ''));
  return out;
}

export async function getMessages(id: string): Promise<DiscussionMessage[]> {
  return (await busGet<DiscussionMessage[]>(msgKey(id))) || [];
}

async function appendMessage(id: string, msg: DiscussionMessage): Promise<DiscussionMessage> {
  const key = msgKey(id);
  const list = (await busGet<DiscussionMessage[]>(key)) || [];
  list.push(msg);
  await busSet(key, list.slice(-MAX_MESSAGES));
  await emitProgress('discussion_message', { discussion_id: id, message: msg });
  return msg;
}

/** Append a centered system line (status changes, notices). */
async function appendSystemMessage(id: string, text: string, round?: number, kind?: DiscussionMessage['kind']): Promise<void> {
  await appendMessage(id, { id: newId(), from: 'system', text, ts: new Date().toISOString(), round, kind });
}

/** M5.2 任务↔群聊互通：任务侧事件以系统通知落进讨论流；meta.bridge_ask 携带可回答的提问卡片。 */
export async function postTaskNotice(id: string, text: string, meta?: Record<string, any>): Promise<void> {
  await appendMessage(id, { id: newId(), from: 'system', text, ts: new Date().toISOString(), kind: meta ? 'card' : 'notice', meta });
}

export async function deleteDiscussion(id: string): Promise<void> {
  await busDel(discKey(id));
  await busDel(msgKey(id));
  await busDel(busyKey(id));
  await busDel(stopKey(id));
}

// ---------- concurrency lock ----------

async function isBusy(id: string): Promise<boolean> {
  const ts = await busGet<number>(busyKey(id));
  return typeof ts === 'number' && Date.now() - ts < BUSY_TTL_MS;
}

async function acquireBusy(id: string): Promise<void> {
  if (await isBusy(id)) throw new DiscussionError(409, '该讨论有一轮正在进行，请稍候');
  await busSet(busyKey(id), Date.now());
}

/** Re-stamp the TTL for the loop holder (never throws, never checks). */
async function stampBusy(id: string): Promise<void> {
  await busSet(busyKey(id), Date.now());
}

// ---------- mentions & pending-question derivation ----------

/**
 * Extract @-mentions from message text. Names may contain CJK so the agent
 * registry can also bind Chinese display names; valid = exact member match,
 * order preserved, duplicates removed.
 */
export function parseMentions(text: string, members: string[]): { mentioned: string[]; invalid: string[] } {
  const mentioned: string[] = [];
  const invalid: string[] = [];
  for (const m of (text || '').matchAll(/@([A-Za-z0-9_\-\u4e00-\u9fff]+)/g)) {
    const name = m[1];
    if (members.includes(name)) {
      if (!mentioned.includes(name)) mentioned.push(name);
    } else if (!invalid.includes(name)) {
      invalid.push(name);
    }
  }
  return { mentioned, invalid };
}

/** True when the latest ask_user message has not been answered by a user message yet. */
export function hasPendingUserQuestion(messages: DiscussionMessage[]): boolean {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.from === 'user') return false;
    if (m.needs_user) return true;
  }
  return false;
}

export function unansweredQuestions(messages: DiscussionMessage[]): DiscussionMessage[] {
  const lastUser = messages.map((m) => m.from).lastIndexOf('user');
  return messages.slice(lastUser + 1).filter((m) => m.needs_user);
}

const countUsers = (ms: DiscussionMessage[]) => ms.filter((m) => m.from === 'user').length;
const lastUserMentions = (ms: DiscussionMessage[]) => {
  for (let i = ms.length - 1; i >= 0; i--) if (ms[i].from === 'user') return ms[i].mentioned || [];
  return [];
};

// ---------- model selection ----------

function pickModel(deps: DiscussionDeps, agent: string) {
  const plugin = deps.orchestrator.plugins.get(agent);
  if (plugin?.modelOverride) {
    const pinned = deps.pool.getModel(plugin.modelOverride);
    if (pinned) return pinned;
  }
  return deps.pool.selectModel(plugin?.tags, 'normal') ?? deps.pool.selectModel(undefined, 'normal');
}

function cheapModel(deps: DiscussionDeps) {
  return deps.pool.selectModel(undefined, 'simple') ?? deps.pool.selectModel(undefined, 'normal');
}

// ---------- static context (项目背景 + 全量经验，所有成员共享前缀) ----------

function renderTranscript(messages: DiscussionMessage[]): string {
  const recent = messages.filter((m) => !m.tool).slice(-CONTEXT_MESSAGES);
  return recent
    .map((m) => {
      const who = m.from === 'user' ? '用户（决策方）' : m.from === 'system' ? '系统' : m.from;
      const ask = m.needs_user ? '[待用户拍板] ' : '';
      return `${who}: ${ask}${m.text}`;
    })
    .join('\n');
}

function readScriptsSummary(ws: string): string {
  try {
    const raw = fs.readFileSync(path.join(ws, 'package.json'), 'utf-8');
    const scripts = JSON.parse(raw)?.scripts;
    if (scripts && typeof scripts === 'object') {
      return Object.entries(scripts).map(([k, v]) => `  - npm run ${k}: ${v}`).join('\n');
    }
  } catch { /* no package.json — fine */ }
  return '';
}

/**
 * 项目背景与全量经验注入（静态前缀：同一讨论的所有轮次/所有成员逐字一致，
 * 保住推理服务前缀缓存）。超预算时按最旧经验丢弃并显式标注，绝不静默截热点。
 */
export async function buildProjectContextBlock(deps: DiscussionDeps, disc: Discussion, messages: DiscussionMessage[]): Promise<string> {
  const parts: string[] = [];
  parts.push(`# 讨论话题\n${disc.title}`);
  if (disc.topic) parts.push(`## 需求背景\n${disc.topic}`);
  if (disc.scheme) parts.push(`## 方案当前版本 v${disc.scheme_version}（摘要）\n${disc.scheme.slice(0, SCHEME_CONTEXT_CHARS)}`);

  if (disc.project_id) {
    const proj = await getProject(disc.project_id);
    if (proj) {
      const bg = [`- 名称：${proj.name}`, `- 目录（绝对路径，所有工具的根，禁止臆测其他路径）：${proj.workspace}`];
      if (proj.description) bg.push(`- 描述：${proj.description}`);
      parts.push(`# 项目背景（本讨论绑定项目，路径与配置以此为准）\n${bg.join('\n')}`);
      const scripts = readScriptsSummary(proj.workspace);
      if (scripts) parts.push(`## 可用 npm scripts\n${scripts}`);
      try {
        const g = await executeCommandAsync('git log --oneline -5', proj.workspace, { level: 'full', whitelistCommands: null, maxTimeSec: 15 });
        if (g.returncode === 0 && g.stdout.trim()) parts.push(`## 最近提交\n${g.stdout.trim().slice(0, 800)}`);
      } catch { /* not a git repo — fine */ }
    }
    const pm = await getProjectMemory(disc.project_id, 500);
    const kn = listKnowledge({ category: 'project', project_id: disc.project_id });
    const all = [
      ...pm.map((m) => ({ src: '记忆', title: '', text: m.text })),
      ...kn.map((k) => ({ src: '知识库', title: k.title, text: k.content.replace(/\s+/g, ' ').slice(0, 300) })),
    ];
    if (all.length) {
      let budget = discCfg.project_context_char_cap;
      const lines: string[] = [];
      let dropped = 0;
      for (let i = all.length - 1; i >= 0; i--) {
        const line = `- 【${all[i].src}】${all[i].title ? `《${all[i].title}》` : ''}${all[i].text}`;
        if (line.length > budget) { dropped = i + 1; break; }
        budget -= line.length;
        lines.unshift(line);
      }
      const head = dropped ? `（按预算省略最旧 ${dropped} 条，可用 grep/read_file 检索项目文件与知识库）\n` : '';
      parts.push(`# 项目全部经验与记忆（共 ${all.length} 条，最新在后）\n${head}${lines.join('\n')}`);
    }
    // M5.2 ①：运行中任务速览——群聊成员据此真实回答"进度怎么样"，而不是 grep 猜
    try {
      const digest = await discussionTaskDigest(disc.project_id);
      if (digest) parts.push(`# 运行中任务速览（实时；用户问进度时以此为准，禁止臆测）\n${digest}`);
    } catch { /* best effort */ }
  } else {
    const query = `${disc.title} ${disc.topic || ''} ${messages.filter((m) => m.from === 'user').slice(-1)[0]?.text || ''}`.trim();
    try {
      const kn = await relevantKnowledge(query, { limit: 3 });
      if (kn.length) parts.push(`## 相关知识库条目\n${kn.map((k) => `- 【${k.title}】${k.content.slice(0, 200)}`).join('\n')}`);
    } catch { /* best-effort */ }
    parts.push('# 项目背景\n本讨论尚未绑定项目目录：无法读写文件或执行命令，成员只能讨论。需要动手请先在讨论设置里挂接项目。');
  }
  return parts.join('\n\n');
}

// ---------- prompts ----------

/** 所有成员共享的 system 前缀：群规 + 真实性纪律 + 工具面 + 输出契约 */
function speakerSystemPrompt(projectCtx: string): string {
  return `# 场景：项目规划群组讨论
你在一个项目规划群聊里，与用户（决策方）和其他专业 agent 共同讨论并动手解决问题。你不是轮流朗诵的嘉宾——像真实的工程同事那样：没新东西就不说话，能动手就直接动手，说完话要兑现。

## 群聊规则（必须遵守）
1. 用户是决策方：用户的补充与方向性指示（含"让某某回答""其他人不要发言"）对全体成员有约束力，必须遵守并优先回应。
2. 自主发言，宁缺毋滥：与当前话题无关、或只能复述/客套时，输出 {"speak": false}。禁止为了出镜而发言。
3. 发言 ≤300 字，给观点、论据、可执行建议；可以直接质疑或补充其他成员，但保持专业克制。
4. 经验沉淀：陈述通用经验/踩坑/决策理由时写进 experience 字段（自动入库）；或用 write_knowledge 工具显式沉淀。
5. 需要用户拍板的事项（方向取舍、资源投入、重大分歧）放进 ask_user 字段；普通疑问不要打扰用户。

## 真实性纪律（最高优先）
- 任何"已完成/已执行/已修改/已启动"的表述，必须由本轮 tool_calls 的真实结果支撑。没有执行过的事，绝不宣称执行过。
- 项目路径、配置、运行状态一律以注入的「项目背景」与工具结果为准，禁止臆测。
- 超出你能力或预算的事（架构级改动、批量新建文件、需要多轮回归的开发）直说"这需要转项目开发任务"，不要在嘴上模拟执行。

## 工具面（可用动作，均限定在项目目录内；未绑定项目时全部不可用）
只读侦查：
 {"tool":"list_files"} | {"tool":"read_file","path":"相对路径"} | {"tool":"read_dir","path":"目录/"} | {"tool":"grep","pattern":"正则","path":"可选子路径"} | {"tool":"git_log"} | {"tool":"git_diff"}
执行命令（同步等待 ≤${EXEC_TIMEOUT_SEC}s：装依赖、build、查端口、健康检查）：
 {"tool":"exec","command":"npm install"}
渲染级验证（前端页面验收必须用它——curl 200 看不见 JS 崩溃；expect 全部命中才算通过）：
 {"tool":"check_page","url":"http://localhost:5123/","expect":["页面应有的文本"]}
长驻服务（后台启动，返回 pid 与日志路径，随后可 exec 查端口 / read_file 看日志）：
 {"tool":"exec_background","command":"npm run dev"}   停止进程： {"tool":"kill_process","pid":12345}
小改代码（单轮 ≤${WRITE_BUDGET_FILES} 个文件、合计 ≤${WRITE_BUDGET_LINES} 行，写前自动 git checkpoint 可回滚）：
 {"tool":"write_file","path":"相对路径","content":"完整新内容"} | {"tool":"edit_file","path":"相对路径","find":"原文片段","replace":"替换片段"}
知识沉淀： {"tool":"write_knowledge","category":"general-tech|project","title":"标题","content":"内容"}
转项目开发（用户已拍板的大改动；自动收敛方案、创建任务并入队，转换后讨论封存）： {"tool":"convert_to_project","auto_run":true}

## 输出契约（最终消息必须是纯 JSON，禁止 markdown 代码栅栏）
两种形态二选一：
A 需要动手时：{"tool_calls":[ {"tool":"..."}, ... ]}
B 发言时：  {"speak": true|false, "reply": "发言内容（≤300字）", "experience": "可选一句话经验", "ask_user": "可选需用户判断的问题"}
工具结果会以用户消息回喂给你：信息够了就用形态 B 汇报真实结果（含命令输出要点/端口/报错原文），需要继续就再发形态 A。启动服务后必须先验证（查端口或读日志）再向用户汇报状态。
## 行动优先（重要）
- 侦查只是手段：如果你的回合里还有该动手的主动作（装依赖/启动/修改/重启），不要以"下一步我将…"的口头承诺收尾——直接用形态 A 把它做完再汇报。
- 迭代预算有限：第一批工具就把最关键的侦查+主动作一起发出（如 npm install + exec_background），减少往返。
- 用户已拍板同意转任务的（如回复"是的/转吧/同意"），直接调用 convert_to_project 完成转换，**绝不允许只口头宣布"正式启动任务"而不调工具**——那等于什么都没发生。

${projectCtx}`;
}

function speakerIdentityPrompt(deps: DiscussionDeps, agent: string, mem: string[]): string {
  const plugin = deps.orchestrator.plugins.get(agent);
  const identity = plugin
    ? `# 你的身份\n你是群组讨论中的「${agent}」Agent（角色：${plugin.role || agent}）。\n${(plugin.prompt || '').slice(0, 1500)}`
    : `# 你的身份\n你是群组讨论中的「${agent}」成员。`;
  const own = mem.length ? `\n# 你过往的经验记忆\n${mem.map((m) => `- ${m}`).join('\n')}` : '';
  return `${identity}${own}`;
}

function roundPrompt(round: number, messages: DiscussionMessage[], firstSubstantive: boolean, interruptNote: string): string {
  const task = firstSubstantive
    ? `## 本轮（第 ${round} 轮）\n围绕话题给出你的初始观点：目标理解、技术选型、风险点、需要用户决策的问题。需要动手侦查就直接调用工具。`
    : `## 本轮（第 ${round} 轮）\n基于讨论记录决定是否发言：有实质补充（含动手执行后的真实结果）就说，没有就输出 {"speak": false}。`;
  return `${interruptNote}# 讨论记录（最近消息）\n${messages.length ? renderTranscript(messages) : '（尚无消息）'}\n\n${task}`;
}

// ---------- streaming reply extractor ----------

/**
 * 从流出的 JSON 文本里增量提取 "reply" 字段的已解码内容。
 * 返回 null=尚未出现该字段；done=字符串已闭合。
 */
export function extractReplyStreaming(text: string): { value: string; done: boolean } | null {
  const keyIdx = text.indexOf('"reply"');
  if (keyIdx < 0) return null;
  let i = text.indexOf(':', keyIdx + 7);
  if (i < 0) return null;
  i++;
  while (i < text.length && /\s/.test(text[i])) i++;
  if (text[i] !== '"') return null;
  i++;
  let out = '';
  for (; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"') return { value: out, done: true };
    if (ch === '\\') {
      const n = text[i + 1];
      if (n === undefined) return { value: out, done: false };
      if (n === 'u') {
        const hex = text.slice(i + 2, i + 6);
        if (hex.length < 4) return { value: out, done: false };
        try { out += String.fromCharCode(parseInt(hex, 16)); } catch { return { value: out, done: false }; }
        i += 5;
      } else {
        const map: Record<string, string> = { n: '\n', t: '\t', r: '\r', '"': '"', '\\': '\\', '/': '/' };
        out += map[n] ?? n;
        i += 1;
      }
      continue;
    }
    out += ch;
  }
  return { value: out, done: false };
}

// ---------- speaker turn (LLM + tool loop + streaming) ----------

interface TurnOutcome {
  spoke: boolean;
  asked: boolean;
  silent: boolean;
  failed?: string;
  /** 本轮是否真实执行过工具（承诺跟进判定依据） */
  toolUsed: boolean;
  /** 发言正文（承诺式收尾检测用） */
  text?: string;
}

interface WriteBudget {
  files: Set<string>;
  lines: number;
  checkpointed: boolean;
  checkpoint?: string;
}

/** git checkpoint before the first write of a speaker turn; returns short hash.
 *  注意：Windows shell 是 cmd.exe，不支持 `||`——三步各自执行，容错非零退出。 */
async function gitCheckpoint(ws: string, discId: string, agent: string): Promise<string> {
  const full: PermissionPolicy = { level: 'full', whitelistCommands: null, maxTimeSec: 30 };
  try {
    await executeCommandAsync('git add -A', ws, full, 20);
    await executeCommandAsync(`git commit -m "coteam: discussion ${discId} pre-write checkpoint (${agent})"`, ws, full, 20);
    const head = await executeCommandAsync('git rev-parse --short HEAD', ws, full, 15);
    return head.returncode === 0 ? head.stdout.trim() : '';
  } catch {
    return '';
  }
}

/** Run one batch of the speaker's tool calls; returns per-call result summaries. */
async function runSpeakerToolCalls(
  deps: DiscussionDeps,
  disc: Discussion,
  agent: string,
  calls: Record<string, any>[],
  budget: WriteBudget,
): Promise<unknown[]> {
  const results: unknown[] = [];
  const proj = disc.project_id ? await getProject(disc.project_id) : null;
  const ws = proj?.workspace || '';

  const roSet = new Set(['list_files', 'read_file', 'read_dir', 'grep', 'git_log', 'git_diff', 'write_knowledge', 'check_page']);
  const roCalls = calls.filter((c) => roSet.has(String(c.tool || '').toLowerCase()));
  // check_page 不碰文件系统（只渲染 localhost），未绑定项目也可用；其余只读工具需要工作目录
  const roNeedsWs = roCalls.filter((c) => String(c.tool || '').toLowerCase() !== 'check_page');
  let roResults: unknown[] = [];
  if (roCalls.length) {
    if (roNeedsWs.length === 0 || ws) {
      roResults = await applyToolCalls(ws, roCalls as any, { agent, project_id: disc.project_id });
    } else {
      for (const c of roCalls) {
        if (String(c.tool || '').toLowerCase() === 'check_page') {
          roResults.push({ tool: 'check_page', ...(await checkPage(String(c.url || ''), Array.isArray(c.expect) ? c.expect.map(String) : undefined)) });
        } else {
          roResults.push({ tool: c.tool, ok: false, error: '本讨论未绑定项目目录，无法读写执行；请建议用户先挂接项目' });
        }
      }
    }
  }
  let roIdx = 0;

  for (const call of calls) {
    const name = String(call.tool || '').toLowerCase();
    if (roSet.has(name)) {
      results.push(roResults[roIdx++]);
      continue;
    }
    if (!ws) {
      results.push({ tool: name, ok: false, error: '本讨论未绑定项目目录，无法执行；请建议用户先在讨论设置挂接项目' });
      continue;
    }
    try {
      if (name === 'exec' || name === 'exec_command' || name === 'run_command') {
        const command = String(call.command || '').trim();
        if (!command) { results.push({ tool: 'exec', ok: false, error: 'command 不能为空' }); continue; }
        if (!canExecute(discCfg.policy, command)) { results.push({ tool: 'exec', ok: false, error: `命令不在群内执行白名单（策略 ${discCfg.policy.level}）` }); continue; }
        const jail = assertWithinJail(command, ws);
        if (!jail.ok) { results.push({ tool: 'exec', ok: false, error: jailViolationMessage(jail.violations, ws) }); continue; }
        const r = await executeCommandAsync(command, ws, discCfg.policy, EXEC_TIMEOUT_SEC);
        results.push({
          tool: 'exec', command, allowed: r.allowed, returncode: r.returncode,
          stdout: r.stdout.slice(-2000), stderr: r.stderr.slice(-1500),
        });
      } else if (name === 'exec_background' || name === 'start_process') {
        const command = String(call.command || '').trim();
        if (!command) { results.push({ tool: 'exec_background', ok: false, error: 'command 不能为空' }); continue; }
        if (!canExecute(discCfg.policy, command)) { results.push({ tool: 'exec_background', ok: false, error: `命令不在群内执行白名单（策略 ${discCfg.policy.level}）` }); continue; }
        const jail = assertWithinJail(command, ws);
        if (!jail.ok) { results.push({ tool: 'exec_background', ok: false, error: jailViolationMessage(jail.violations, ws) }); continue; }
        const logDir = path.join(ws, '.coteam-logs');
        fs.mkdirSync(logDir, { recursive: true });
        const logPath = path.join(logDir, `${new Date().toISOString().replace(/[:.]/g, '-')}-${Math.random().toString(36).slice(2, 6)}.log`);
        const fd = fs.openSync(logPath, 'a');
        const proc = spawn(command, { cwd: ws, shell: true, detached: true, stdio: ['ignore', fd, fd] });
        proc.unref();
        fs.closeSync(fd);
        results.push({
          tool: 'exec_background', ok: true, pid: proc.pid, command,
          log: path.relative(ws, logPath).replace(/\\/g, '/'),
          note: '已后台启动（不代表成功）。请等待数秒后用 exec 查端口/curl，或 read_file 查看日志确认真实状态。',
        });
      } else if (name === 'kill_process') {
        const pid = Number(call.pid);
        if (!Number.isInteger(pid) || pid <= 0) { results.push({ tool: 'kill_process', ok: false, error: 'pid 必须是正整数' }); continue; }
        if (process.platform === 'win32') {
          const r = await executeCommandAsync(`taskkill /PID ${pid} /T /F`, ws, { level: 'full', whitelistCommands: null, maxTimeSec: 20 }, 15);
          results.push({ tool: 'kill_process', ok: r.returncode === 0, pid, detail: (r.stdout + r.stderr).slice(-300) });
        } else {
          try { process.kill(pid); results.push({ tool: 'kill_process', ok: true, pid }); }
          catch (e: any) { results.push({ tool: 'kill_process', ok: false, pid, error: String(e?.message || e) }); }
        }
      } else if (name === 'write_file') {
        const rel = String(call.path || '').trim();
        if (!rel || path.isAbsolute(rel) || rel.split(/[\\/]/).includes('..')) { results.push({ tool: 'write_file', ok: false, error: 'path 必须是项目目录内的相对路径' }); continue; }
        const content = Array.isArray(call.content) ? call.content.join('\n') : String(call.content ?? '');
        if (!content.trim()) { results.push({ tool: 'write_file', ok: false, error: 'content 不能为空' }); continue; }
        if (content.length > WRITE_MAX_FILE_CHARS) { results.push({ tool: 'write_file', ok: false, error: `单文件超 ${WRITE_MAX_FILE_CHARS} 字符，属大改动，请转任务` }); continue; }
        const block = checkWriteBudget(budget, rel, content.split('\n').length);
        if (block) { results.push({ tool: 'write_file', ok: false, error: block }); continue; }
        await ensureCheckpoint(deps, disc, agent, ws, budget);
        try {
          fs.mkdirSync(path.dirname(path.resolve(ws, rel)), { recursive: true });
          fs.writeFileSync(path.resolve(ws, rel), content, 'utf-8');
          budget.files.add(rel);
          budget.lines += content.split('\n').length;
          results.push({ tool: 'write_file', ok: true, path: rel, bytes: content.length, checkpoint: budget.checkpoint });
        } catch (e: any) {
          results.push({ tool: 'write_file', ok: false, error: String(e?.message || e).slice(0, 200) });
        }
      } else if (name === 'edit_file') {
        const rel = String(call.path || '').trim();
        if (!rel || path.isAbsolute(rel) || rel.split(/[\\/]/).includes('..')) { results.push({ tool: 'edit_file', ok: false, error: 'path 必须是项目目录内的相对路径' }); continue; }
        const rep = String(call.replace ?? '');
        const block = checkWriteBudget(budget, rel, rep.split('\n').length);
        if (block) { results.push({ tool: 'edit_file', ok: false, error: block }); continue; }
        await ensureCheckpoint(deps, disc, agent, ws, budget);
        const { edited, failures } = applyEdits(ws, [{ path: rel, find: String(call.find ?? ''), replace: rep }]);
        if (edited.length) {
          budget.files.add(rel);
          budget.lines += rep.split('\n').length;
          results.push({ tool: 'edit_file', ok: true, path: rel, checkpoint: budget.checkpoint });
        } else {
          results.push({ tool: 'edit_file', ok: false, error: (failures[0] || '编辑未命中') });
        }
      } else if (name === 'convert_to_project' || name === 'convert_task') {
        // 用户已拍板的大改动：agent 自己走完 方案收敛→转任务→入队，不再"口头宣布正式启动"后掉球
        if (!disc.project_id) {
          results.push({ tool: 'convert_to_project', ok: false, error: '本讨论未绑定项目目录，无法转任务；需要新建项目的请让用户在界面「转为项目开发」操作（需要选目录）' });
          continue;
        }
        const live = await getDiscussion(disc.id);
        if (!live || live.status === 'converted') {
          results.push({ tool: 'convert_to_project', ok: false, error: '讨论已转项目或已不存在' });
          continue;
        }
        try {
          if (!live.scheme.trim()) await generateScheme(deps, disc.id);
          const autoRun = call.auto_run !== false;
          const res = await convertToProject(deps, disc.id, { target: 'existing', project_id: disc.project_id, auto_run: autoRun }, (w) => w);
          results.push({
            tool: 'convert_to_project', ok: true, task_id: res.task_id, project_id: res.project_id, auto_run: autoRun,
            note: '开发任务已创建' + (autoRun ? '并入队执行' : '待规划评审') + '；讨论已封存，后续沟通走任务介入通道。请在发言里向用户汇报任务 id。',
          });
        } catch (e: any) {
          results.push({ tool: 'convert_to_project', ok: false, error: String(e?.message || e).slice(0, 300) });
        }
      } else {
        results.push({ tool: name, ok: false, error: `群内不允许的工具: ${name}（大改动请用 convert_to_project 转项目任务）` });
      }
    } catch (e: any) {
      // 软错误回喂纪律：一次工具异常绝不炸毁整次发言
      results.push({ tool: name, ok: false, error: String(e?.message || e).slice(0, 200) });
    }
  }
  return results;
}

function checkWriteBudget(budget: WriteBudget, rel: string, newLines: number): string | null {
  if (!budget.files.has(rel) && budget.files.size >= WRITE_BUDGET_FILES) {
    return `单轮最多小改 ${WRITE_BUDGET_FILES} 个文件，改动范围超出群内小改范畴——请建议用户生成方案并转项目开发任务`;
  }
  if (budget.lines + newLines > WRITE_BUDGET_LINES) {
    return `单轮小改预算（≤${WRITE_BUDGET_LINES} 行）已用完——剩余改动请转项目开发任务`;
  }
  return null;
}

async function ensureCheckpoint(deps: DiscussionDeps, disc: Discussion, agent: string, ws: string, budget: WriteBudget): Promise<void> {
  if (budget.checkpointed) return;
  budget.checkpointed = true;
  budget.checkpoint = await gitCheckpoint(ws, disc.id, agent);
  void deps;
}

/** one tool activity line per batch, persisted into the transcript for auditability */
function toolActivityLine(calls: Record<string, any>[], results: unknown[]): string {
  const segs: string[] = [];
  for (let i = 0; i < calls.length && segs.length < 4; i++) {
    const r: any = results[i] || {};
    const t = String(calls[i].tool || '?');
    if (t === 'exec' || t === 'exec_command' || t === 'run_command') segs.push(`exec「${String(calls[i].command || '').slice(0, 60)}」exit ${r.returncode ?? '?'}`);
    else if (t === 'exec_background' || t === 'start_process') segs.push(`后台启动「${String(calls[i].command || '').slice(0, 50)}」pid ${r.pid ?? '?'}`);
    else if (t === 'kill_process') segs.push(`停止进程 ${calls[i].pid}${r.ok ? '' : ' 失败'}`);
    else if (t === 'write_file') segs.push(r.ok ? `写入 ${r.path}${r.checkpoint ? `（checkpoint ${r.checkpoint}）` : ''}` : `写 ${calls[i].path} 失败`);
    else if (t === 'edit_file') segs.push(r.ok ? `修改 ${r.path}${r.checkpoint ? `（checkpoint ${r.checkpoint}）` : ''}` : `改 ${calls[i].path} 失败`);
    else if (t === 'write_knowledge') segs.push(r.ok ? '沉淀知识' : '沉淀知识失败');
    else if (t === 'convert_to_project' || t === 'convert_task') segs.push(r.ok ? `转项目开发任务 ${r.task_id}${r.auto_run ? '（已入队）' : ''}` : '转任务失败');
    else segs.push(t);
  }
  const more = calls.length > 4 ? ` 等 ${calls.length} 项` : '';
  return `🔧 ${segs.join(' · ')}${more}`;
}

/**
 * One speaker's turn: static-prefix messages + tool loop + streamed reply.
 * Returns whether the agent spoke / asked / stayed silent.
 */
async function runSpeakerTurn(
  deps: DiscussionDeps,
  disc: Discussion,
  agent: string,
  round: number,
  messages: DiscussionMessage[],
  projectCtx: string,
  identity: string,
  forced: boolean,
  firstSubstantive: boolean,
  interruptNote: string,
): Promise<TurnOutcome> {
  const entry = pickModel(deps, agent);
  if (!entry) {
    deps.logger.warn('discussion round: no model available for agent, skipped', { discId: disc.id, agent });
    return { spoke: false, asked: false, silent: true, failed: '无可用模型', toolUsed: false };
  }
  const sys = speakerSystemPrompt(projectCtx);
  const convo: { role: string; content: string }[] = [
    { role: 'system', content: sys },
    { role: 'user', content: identity },
    { role: 'user', content: roundPrompt(round, messages, firstSubstantive, interruptNote) },
  ];

  const budget: WriteBudget = { files: new Set(), lines: 0, checkpointed: false };
  let parsed: Record<string, any> | null = null;
  let toolUsed = false;

  for (let iter = 0; iter < MAX_TOOL_ITER; iter++) {
    const last = iter === MAX_TOOL_ITER - 1;
    // streaming deltas for the final (non-tool) reply；每次重试用新 stream sid，旧片段以 discarded 清掉
    let stream = { acc: '', emitted: 0, lastAt: 0, sid: `${disc.id}:${agent}:r${round}#${iter}#0` };
    const onDelta = (d: string) => {
      stream.acc += d;
      const cur = extractReplyStreaming(stream.acc);
      if (!cur) return;
      const tail = cur.value.slice(stream.emitted);
      if (!tail) return;
      if (tail.length < DELTA_MIN_CHARS && !cur.done && Date.now() - stream.lastAt < DELTA_MIN_MS) return;
      stream.emitted = cur.value.length;
      stream.lastAt = Date.now();
      void emitProgress('discussion_message_delta', { discussion_id: disc.id, agent, round, stream_id: stream.sid, text: tail, done: cur.done });
    };
    if (last) {
      convo.push({ role: 'user', content: '工具迭代次数已用完：不要再调用工具，立即用形态 B 基于已获得的信息给出你的发言（如实反映已执行与未执行的部分）。' });
    }
    let res;
    // M5.2 补课（用户实测反馈）：429/错误不再一击即溃——容量错误按任务管线同款退避（20s/40s 两次），
    // 其他错误快重试一次。重试过程以系统 notice 落进讨论流，过程可见。
    for (let attempt = 0; ; attempt++) {
      stream = { acc: '', emitted: 0, lastAt: 0, sid: `${disc.id}:${agent}:r${round}#${iter}#${attempt}` };
      try {
        await emitProgress('discussion_round', { discussion_id: disc.id, round, phase: 'speaker', agent, activity: iter === 0 ? 'thinking' : 'tool_followup' });
        // 每一轮 LLM 调用都流式：工具轮会以 discarded 事件清掉误显示的片段
        res = await chat(entry, convo, undefined, 0.3, undefined, SPEAKER_WALLCLOCK_CAP_MS, onDelta);
        break;
      } catch (e) {
        const reason = String((e as Error)?.message || e);
        void emitProgress('discussion_message_delta', { discussion_id: disc.id, agent, round, stream_id: stream.sid, discarded: true });
        const capacity = CAPACITY_RE.test(reason);
        if (capacity && attempt < 2) {
          const waitSec = 20 * (attempt + 1);
          await appendMessage(disc.id, { id: newId(), from: 'system', round, kind: 'notice', text: `⏳ ${agent} 遇到模型限流（429），${waitSec}s 后自动重试（第 ${attempt + 1}/2 次）`, ts: new Date().toISOString() });
          await new Promise((r) => setTimeout(r, waitSec * 1000));
          continue;
        }
        if (!capacity && attempt < 1) {
          await appendMessage(disc.id, { id: newId(), from: 'system', round, kind: 'notice', text: `⏳ ${agent} 的模型调用出错（${reason.slice(0, 80)}），3s 后自动重试一次`, ts: new Date().toISOString() });
          await new Promise((r) => setTimeout(r, 3000));
          continue;
        }
        return { spoke: false, asked: false, silent: true, failed: reason, toolUsed };
      }
    }
    parsed = extractJson(res.content);
    let calls: Record<string, any>[] = Array.isArray(parsed?.tool_calls) ? parsed.tool_calls.filter((c: any) => c && typeof c.tool === 'string') : [];
    if (!calls.length && !parsed && res.content.includes('"tool"')) {
      calls = salvageToolCalls(res.content);
    }
    if (calls.length && !last) {
      void emitProgress('discussion_message_delta', { discussion_id: disc.id, agent, round, stream_id: stream.sid, discarded: true });
      toolUsed = true;
      const results = await runSpeakerToolCalls(deps, disc, agent, calls, budget);
      const line = toolActivityLine(calls, results);
      await appendMessage(disc.id, { id: newId(), from: agent, text: line, ts: new Date().toISOString(), round, tool: true, model: entry.name });
      await emitProgress('discussion_tool', { discussion_id: disc.id, agent, round, calls: calls.map((c) => ({ tool: c.tool, command: c.command, path: c.path })), results });
      // M5.2 ④：同一批工具 ≥2 次失败时提示转任务——讨论的工具面（≤90s 命令、≤80 行小改）有天花板
      const failedCalls = results.filter((r) => (r as Record<string, any>)?.ok === false).length;
      if (failedCalls >= 2) {
        await appendMessage(disc.id, {
          id: newId(), from: 'system', round,
          text: `⚙️ ${agent} 本批工具连续失败 ${failedCalls} 次——若超出讨论的工具能力（需要大量改代码、装依赖、跑长任务），建议用 convert_to_project 转任务处理，别在群里硬磨。`,
          ts: new Date().toISOString(), kind: 'notice',
        });
      }
      convo.push({ role: 'assistant', content: res.content });
      convo.push({ role: 'user', content: `## 工具执行结果（第 ${iter + 1} 批）\n${JSON.stringify(results).slice(0, 12000)}\n\n信息足够就用形态 B 发言汇报真实结果；需要继续动手再发形态 A。` });
      continue;
    }
    if (calls.length && last) {
      // shouldn't happen after the "no more tools" nudge; honor as silence-with-honesty
      parsed = { speak: true, reply: '（我尝试继续调用工具但本轮执行机会已用完，剩余动作未完成，请让我下一轮继续）' };
    }
    break;
  }

  if (!parsed) {
    if (forced) {
      // 被点名者的诚实告知直接以发言形态出现（不再叠加失败 notice）
      await appendMessage(disc.id, { id: newId(), from: agent, text: '（被点名发言但输出无法解析，本轮未能给出观点）', ts: new Date().toISOString(), round });
      return { spoke: true, asked: false, silent: false, toolUsed };
    }
    return { spoke: false, asked: false, silent: true, failed: '输出无法解析', toolUsed };
  }
  // forced speakers must speak: a weak model returning speak:false is nudged once
  if (forced && parsed.speak !== true) {
    const retry = await chat(entry, [...convo, { role: 'user', content: '注意：用户直接 @ 了你提问，你必须给出实质性发言（speak=true）。' }], undefined, 0.3, undefined, SPEAKER_WALLCLOCK_CAP_MS)
      .catch(() => null);
    if (retry) parsed = extractJson(retry.content) || parsed;
  }
  if (parsed.speak !== true) {
    return { spoke: false, asked: false, silent: true, toolUsed };
  }
  const reply = String(parsed.reply || '').trim().slice(0, MAX_MESSAGE_LENGTH);
  const askUser = String(parsed.ask_user || '').trim();
  const experience = String(parsed.experience || '').trim();
  if (!reply && !askUser) {
    return { spoke: false, asked: false, silent: true, toolUsed };
  }
  const msg: DiscussionMessage = {
    id: newId(),
    from: agent,
    text: [reply, askUser ? `【需要你拍板】${askUser}` : ''].filter(Boolean).join('\n\n'),
    ts: new Date().toISOString(),
    round,
    needs_user: !!askUser,
    model: entry.name,
  };
  await appendMessage(disc.id, msg);
  void emitProgress('discussion_message_delta', { discussion_id: disc.id, agent, round, stream_id: `${disc.id}:${agent}:r${round}#*`, discarded: true });
  if (experience) {
    await depositExperience(deps, disc.id, agent, experience).catch((e) =>
      deps.logger.warn('discussion experience deposit failed', { discId: disc.id, agent, error: String(e) })
    );
  }
  if (askUser) {
    await emitProgress('discussion_ask_user', { discussion_id: disc.id, agent, question: askUser, round });
    const { notify } = await import('./notify');
    notify('discussion_ask_user', { discussion_id: disc.id }, `[Co-Team] 群组讨论「${disc.title}」中 ${agent} 需要你拍板：${askUser.slice(0, 80)}`);
    return { spoke: true, asked: true, silent: false, toolUsed, text: msg.text };
  }
  return { spoke: true, asked: false, silent: false, toolUsed, text: msg.text };
}

// ---------- speaker router ----------

/**
 * Decide who speaks this round. @-mentions are honored literally (mention-only
 * rounds — "其他人不要发言" style instructions are satisfied by construction);
 * otherwise a cheap model picks 1..3 members with something new to say.
 * Router failure falls back to the legacy all-members rotation.
 */
export async function routeSpeakers(
  deps: DiscussionDeps,
  disc: Discussion,
  messages: DiscussionMessage[],
  forced?: string[],
  firstSubstantive = false,
): Promise<{ speakers: string[]; reason: string; fallback: boolean }> {
  const mentions = (forced || []).filter((a) => disc.members.includes(a));
  if (mentions.length) {
    return { speakers: mentions, reason: '用户点名优先', fallback: false };
  }
  const entry = cheapModel(deps);
  if (!entry) return { speakers: [...disc.members], reason: '无可用模型，回退全员轮转', fallback: true };
  const latestUser = [...messages].reverse().find((m) => m.from === 'user');
  try {
    const res = await chat(entry, [
      {
        role: 'system',
        content: `你是群聊调度路由器，负责决定本轮哪些成员发言、按什么顺序。规则：
1. 严格执行用户最新指示：用户点名某人则只选该人；用户说其他人不要发言则绝不选中其他人。
2. 只选对当前话题真正有新信息/能动手解决问题的成员，优先 1 人，最多 ${MAX_ROUND_SPEAKERS} 人；复述、客套、无信息量的成员不选。
3. ${firstSubstantive ? '这是开场轮：选择最相关的至多 2-3 位成员给出初始观点（不必全员）。' : '没有成员有新增内容时返回空数组。'}
可选成员：${disc.members.join('、')}
只输出纯 JSON：{"speakers":["成员名"],"reason":"一句话理由"}`,
      },
      {
        role: 'user',
        content: `话题：${disc.title}\n${latestUser ? `用户最新指示：${latestUser.text.slice(0, 500)}` : '（用户尚未发言）'}\n讨论记录：\n${renderTranscript(messages).slice(-4000) || '（空）'}`,
      },
    // 路由/主持是幕后辅助调用：宁可判错（回退全员轮转/停止）也不能让用户等它——
    // 推理模型可能长时间只吐 reasoning_content 不出正文（glm-5.3-flash 实测），
    // 这类流按"任意 chunk 活着"永不触发 stalled，必须自带短墙钟。
    ], undefined, 0, undefined, ROUTER_WALLCLOCK_CAP_MS);
    const parsed = extractJson(res.content);
    const picked = Array.isArray(parsed?.speakers)
      ? [...new Set(parsed.speakers.map(String))].filter((s) => disc.members.includes(s)).slice(0, MAX_ROUND_SPEAKERS)
      : null;
    if (!picked) throw new Error('router output unparseable');
    return { speakers: picked, reason: String(parsed?.reason || ''), fallback: false };
  } catch (e) {
    deps.logger.warn('discussion router failed, fallback to full rotation', { discId: disc.id, error: String((e as Error)?.message || e) });
    return { speakers: [...disc.members], reason: '路由失败回退全员轮转', fallback: true };
  }
}

// ---------- the round engine ----------

export interface RoundResult {
  round: number;
  speakers: string[];
  silent: string[];
  asked_user: string[];
  all_silent?: boolean;
  /** a user message arrived mid-round: remaining speakers were cut */
  interrupted_by_user?: boolean;
  /** speakers that promised action without executing any tool this round */
  commitments?: string[];
}

/**
 * Run one discussion round: the router picks speakers (mention-only when the
 * user named someone), each speaker may run a tool loop before replying.
 * A mid-round user message cuts the remaining speakers (真打断).
 */
async function runRoundCore(deps: DiscussionDeps, discId: string, opts?: { forced?: string[]; roundNo?: number; startUserCount?: number; interruptNote?: string }): Promise<RoundResult & { latest_user_mentions?: string[] }> {
  const disc = await getDiscussion(discId);
  if (!disc) throw new DiscussionError(404, `discussion not found: ${discId}`);
  if (disc.status === 'converted') throw new DiscussionError(400, '讨论已转为项目，不能再发起发言');
  await stampBusy(discId);

  const messages = await getMessages(discId);
  const round = opts?.roundNo ?? (messages.reduce((acc, m) => Math.max(acc, m.round || 0), 0) + 1);
  const firstSubstantive = !messages.some((m) => m.from !== 'system');
  const startUserCount = opts?.startUserCount ?? countUsers(messages);
  const projectCtx = await buildProjectContextBlock(deps, disc, messages);

  const route = await routeSpeakers(deps, disc, messages, opts?.forced, firstSubstantive);
  await emitProgress('discussion_round', { discussion_id: discId, round, phase: 'router', speakers: route.speakers, reason: route.reason, fallback: route.fallback });

  const speakers: string[] = [];
  const silent: string[] = [];
  const asked: string[] = [];
  const commitments: string[] = [];
  let interrupted = false;

  for (const agent of route.speakers) {
    if (await busGet(stopKey(discId))) break;
    {
      const live = await getDiscussion(discId);
      if (!live || live.status === 'converted') break; // 转任务后讨论即封存，剩余成员不再发言
    }
    const forced = opts?.forced?.includes(agent) === true;
    // re-read fresh transcript each speaker (later speakers see earlier replies)
    const fresh = await getMessages(discId);
    if (countUsers(fresh) > startUserCount) {
      interrupted = true;
      break;
    }
    const mem = await getAgentMemory(agent, 5).catch(() => [] as string[]);
    const identity = speakerIdentityPrompt(deps, agent, mem);
    const out = await runSpeakerTurn(deps, disc, agent, round, fresh, projectCtx, identity, forced, firstSubstantive, opts?.interruptNote || '');
    if (out.failed) {
      silent.push(agent);
      await appendSystemMessage(discId, `「${agent}」本轮发言未完成：${out.failed}`, round, 'notice');
      continue;
    }
    if (out.silent) {
      silent.push(agent);
      continue;
    }
    if (out.spoke) speakers.push(agent);
    if (out.asked) asked.push(agent);
    // 承诺式收尾检测：说了"正式启动/接下来我将…"却没调用任何工具 → 记名，由响应循环追问一轮
    if (out.spoke && !out.toolUsed && out.text && COMMITMENT_RE.test(out.text)) commitments.push(agent);
  }

  const stopped = await busGet(stopKey(discId));
  // 轮末 touch 必须基于最新状态重读：轮中 convert_to_project 可能已改写 status/task_id，
  // 用轮初的 stale 对象整键覆盖会把"已转项目"打回 discussing（lost update 实测教训）
  const liveAtEnd = await getDiscussion(discId);
  if (liveAtEnd) {
    liveAtEnd.updated_at = new Date().toISOString();
    await saveDiscussion(liveAtEnd);
  }
  await emitProgress('discussion_round', {
    discussion_id: discId, round, phase: 'end', speakers, silent, asked_user: asked,
    interrupted_by_user: interrupted && !stopped,
  });
  return {
    round, speakers, silent, asked_user: asked,
    all_silent: speakers.length === 0 && !interrupted && !stopped,
    interrupted_by_user: interrupted && !stopped,
    latest_user_mentions: interrupted ? lastUserMentions(await getMessages(discId)) : undefined,
    commitments: commitments.length ? commitments : undefined,
  };
}

/** Single round (the 「继续讨论」 button and tests). */
export async function runDiscussionRound(deps: DiscussionDeps, discId: string, opts?: { forced?: string[]; roundNo?: number }): Promise<RoundResult> {
  await acquireBusy(discId);
  try {
    return await runRoundCore(deps, discId, opts);
  } finally {
    await busDel(busyKey(discId));
  }
}

// ---------- moderator (auto mode convergence) ----------

async function moderatorCheck(deps: DiscussionDeps, disc: Discussion, lastResult: RoundResult): Promise<boolean> {
  const entry = cheapModel(deps);
  if (!entry) return false;
  const messages = await getMessages(disc.id);
  try {
    const res = await chat(entry, [
      {
        role: 'system',
        content: '你是项目规划群聊的主持人。判断讨论是否还有必要进行下一轮：如果各成员仍在补充新信息/存在未解决的分歧/还有未完成的动手验证，继续；如果观点已重复、无新信息或已收敛，停止。只输出 JSON：{"continue": true|false, "reason": "一句话"}',
      },
      { role: 'user', content: `话题：${disc.title}\n最近消息：\n${renderTranscript(messages)}\n\n刚结束第 ${lastResult.round} 轮。` },
    ], undefined, 0, undefined, MODERATOR_WALLCLOCK_CAP_MS);
    const parsed = extractJson(res.content);
    return parsed?.continue === true;
  } catch {
    return false;
  }
}

/**
 * The response loop behind a user message: rounds until agents converge, the
 * user keeps steering (mid-round interruptions re-route), or the cap is hit.
 * Busy lock is held across the loop; user messages never blocked (the API lets
 * the in-flight loop drain them — see the drain check in triggerRound).
 */
export async function runResponseLoop(deps: DiscussionDeps, discId: string, opts: { forced?: string[]; auto: boolean }): Promise<void> {
  const disc = await getDiscussion(discId);
  if (!disc) throw new DiscussionError(404, `discussion not found: ${discId}`);
  await acquireBusy(discId);
  await busDel(stopKey(discId));
  let lastSeenUsers = countUsers(await getMessages(discId));
  try {
    let forced = opts.forced;
    let interruptNote = '';
    for (let i = 0; i < discCfg.max_rounds; i++) {
      if (await busGet(stopKey(discId))) {
        await busDel(stopKey(discId));
        break;
      }
      const startCount = countUsers(await getMessages(discId));
      const res = await runRoundCore(deps, discId, { forced, startUserCount: startCount, interruptNote });
      lastSeenUsers = countUsers(await getMessages(discId));
      const msgs = await getMessages(discId);
      if (hasPendingUserQuestion(msgs)) {
        await appendSystemMessage(discId, '自动讨论已暂停，等待你的回答后继续', res.round);
        await emitProgress('discussion_status', { discussion_id: discId, waiting_user: true });
        break;
      }
      {
        const liveNow = await getDiscussion(discId);
        if (!liveNow || liveNow.status === 'converted') break; // 转任务成功，讨论封存
      }
      if (res.interrupted_by_user) {
        // 用户中途补充了新指示：立即以最新指示重新路由下一轮
        forced = res.latest_user_mentions?.length ? res.latest_user_mentions : undefined;
        interruptNote = '# 注意\n用户在上一轮中途补充了新指示（见讨论记录最后一条用户消息），本轮必须优先回应它。\n\n';
        continue;
      }
      if (res.commitments?.length) {
        // 承诺跟进：只点名承诺者，本轮必须兑现动作或如实说明做不到——不许再空口承诺
        forced = res.commitments;
        interruptNote = '# 追问\n你上一轮承诺了行动（见讨论记录你的最后一条发言）却没有调用任何工具，等于什么都没发生。本轮必须：能做的直接用形态 A 执行（大改动且用户已同意转任务就调 convert_to_project）；做不到的如实说明原因并给出用户可操作的下一步。禁止再次只口头承诺。\n\n';
        continue;
      }
      if (res.all_silent) {
        await appendSystemMessage(discId, '成员们暂无新进展——可补充信息继续，或生成方案', res.round);
        break;
      }
      if (!opts.auto) break;
      const live = await getDiscussion(discId);
      if (!live) break;
      if (!(await moderatorCheck(deps, live, res))) break;
    }
  } finally {
    await busDel(busyKey(discId));
  }
  // post-release drain: a user message that slipped in right before release
  const fresh = await getMessages(discId);
  if (countUsers(fresh) > lastSeenUsers && (await getDiscussion(discId))) {
    void runResponseLoop(deps, discId, { forced: lastUserMentions(fresh), auto: opts.auto }).catch(
      (e) => {
        if ((e as DiscussionError)?.status !== 409) deps.logger.error('discussion drain failed', { discId, error: String((e as Error)?.message || e) });
      }
    );
  }
}

/** Auto-mode loop (kept as an export for the API/tests; manual mode uses 1 round + interrupts). */
export async function runAutoDiscussion(deps: DiscussionDeps, discId: string, opts?: { forced?: string[] }): Promise<void> {
  await runResponseLoop(deps, discId, { forced: opts?.forced, auto: true });
}

// ---------- scheme generation ----------

/** Converge the discussion into a structured project planning scheme (markdown). */
export async function generateScheme(deps: DiscussionDeps, discId: string): Promise<Discussion> {
  const disc = await getDiscussion(discId);
  if (!disc) throw new DiscussionError(404, `discussion not found: ${discId}`);
  const messages = await getMessages(discId);
  const substantive = messages.filter((m) => m.from !== 'system' && !m.tool);
  if (substantive.length < 2) throw new DiscussionError(400, '讨论内容太少（至少需要 2 条发言），请继续讨论后再生成方案');
  const entry = deps.pool.selectModel(undefined, 'complex') ?? deps.pool.selectModel(undefined, 'normal');
  if (!entry) throw new DiscussionError(503, '模型池无可用模型');

  const pending = unansweredQuestions(messages);
  const allTranscript = messages
    .filter((m) => m.from !== 'system')
    .map((m) => `${m.from === 'user' ? '用户（决策方）' : m.from}: ${m.needs_user ? '[提问] ' : ''}${m.text}`)
    .join('\n');

  const res = await chat(entry, [
    {
      role: 'system',
      content: `你是项目规划主持人，负责把多 agent 群聊的讨论收敛为一份结构化的《项目规划方案》（Markdown）。要求：
1. 忠实整合讨论中的共识与用户的方向性指示，剔除闲聊；有分歧的地方在「风险与对策」或「待定事项」中如实标注。
2. 用户的补充与修正优先级最高。
3. 必须包含章节：# 项目规划方案：<标题>、## 背景与目标、## 范围与功能清单、## 技术方案、## 里程碑与任务拆分建议、## 风险与对策、## 经验与决策摘要（标注贡献该经验的成员）、## 待定事项（需要用户决策的问题；没有则写"无"）。
4. 直接输出 Markdown 正文，不要任何代码栅栏包裹、不要解释性开场白。`,
    },
    {
      role: 'user',
      content: `话题：${disc.title}\n${disc.topic ? `需求背景：${disc.topic}\n` : ''}${pending.length ? `其中以下提问用户尚未回答，列入待定事项：\n${pending.map((p) => `- ${p.from}: ${p.text}`).join('\n')}\n` : ''}讨论记录：\n${allTranscript.slice(0, 30000)}`,
    },
  ], undefined, 0.2);

  disc.scheme = stripCodeFence(res.content).trim() || disc.scheme;
  disc.scheme_version += 1;
  if (disc.status !== 'converted') disc.status = 'converged';
  await saveDiscussion(disc);
  await appendSystemMessage(discId, `项目规划方案 v${disc.scheme_version} 已生成`, undefined, 'card');
  await emitProgress('discussion_scheme_updated', { discussion_id: discId, version: disc.scheme_version });
  if (disc.project_id) {
    await addProjectMemory(disc.project_id, `[群组讨论「${disc.title}」] 方案 v${disc.scheme_version} 定稿，详见知识库条目「项目规划方案：${disc.title}」`, 'auto').catch(() => undefined);
  }
  return disc;
}

// ---------- experience deposition ----------

/** Write one agent's discussion experience into the knowledge base + its own memory. */
export async function depositExperience(deps: DiscussionDeps, discId: string, agent: string, text: string): Promise<{ id: string; updated: boolean } | null> {
  const clean = (text || '').trim();
  if (!clean) return null;
  const disc = await getDiscussion(discId);
  if (!disc) return null;
  // 去重：同一讨论内已沉淀过相同/包含关系的经验不再刷库（实测同句曾入库 4 次）
  const key = clean.slice(0, 40);
  const existing = listKnowledge({}).filter((e) => e.source === `discussion:${discId}`);
  if (existing.some((e) => e.content.replace(/\s+/g, '').includes(key.replace(/\s+/g, '')))) {
    deps.logger.debug?.('discussion experience deduped', { discId, agent });
    return null;
  }
  const firstLine = clean.split('\n')[0].replace(/^#+\s*/, '');
  const title = (firstLine || `群组讨论经验：${disc.title}`).slice(0, 40);
  const result = writeKnowledge({
    title,
    content: `${clean}\n\n> 来源：群组讨论「${disc.title}」· 发言成员 ${agent} · ${new Date().toISOString().slice(0, 10)}`,
    category: disc.project_id ? 'project' : 'general-tech',
    project_id: disc.project_id,
    tags: ['群组讨论', agent],
    source: `discussion:${discId}`,
  });
  await addAgentMemory(agent, `（群组讨论「${disc.title}」）${clean.slice(0, 200)}`);
  await emitProgress('discussion_experience', { discussion_id: discId, agent, title, knowledge_id: result.id });
  deps.logger.info('discussion experience deposited', { discId, agent, title });
  return result;
}

// ---------- scheme → project + development task ----------

export interface ConvertOptions {
  target: 'new' | 'existing';
  /** new project */
  name?: string;
  workspace?: string;
  scaffold?: boolean;
  /** existing project */
  project_id?: string;
  /** enqueue the created task immediately after planning finishes */
  auto_run?: boolean;
  /** absolute-path check duplicated from the API layer (validateWorkspace) */
}

async function waitForPlannedThenEnqueue(deps: DiscussionDeps, taskId: string, projectId: string, workspace: string): Promise<void> {
  const deadline = Date.now() + PLAN_WAIT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const graph = await getTaskGraph(taskId);
    if (!graph) return;
    if (graph.status === 'planned') {
      await deps.taskQueue.enqueue(taskId, projectId, workspace).catch((e) => deps.logger.warn('discussion convert enqueue failed', { taskId, error: String(e) }));
      return;
    }
    // planning failed or task went terminal — nothing to enqueue
    if (['failed', 'cancelled', 'success', 'completed'].includes(graph.status)) return;
    await new Promise((r) => setTimeout(r, PLAN_WAIT_INTERVAL_MS));
  }
  deps.logger.warn('discussion convert: task planning did not finish in time, auto-run skipped', { taskId });
}

/**
 * Convert the converged scheme into a project + development task.
 * The discussion IS the requirement clarification, so the task skips it and lands
 * in `planned` (reviewable) — auto_run additionally queues it once planning ends.
 */
export async function convertToProject(deps: DiscussionDeps, discId: string, opts: ConvertOptions, validateWorkspace: (ws: string) => string): Promise<{ project_id: string; task_id: string }> {
  const disc = await getDiscussion(discId);
  if (!disc) throw new DiscussionError(404, `discussion not found: ${discId}`);
  if (disc.status === 'converted') throw new DiscussionError(400, '该讨论已转为项目，不能重复转换');
  if (!disc.scheme.trim()) throw new DiscussionError(400, '请先生成项目规划方案，再转为项目开发');

  let project: ProjectRecord;
  if (opts.target === 'new') {
    if (!opts.name?.trim()) throw new DiscussionError(400, '新建项目需要 name');
    const workspace = validateWorkspace(opts.workspace || '');
    project = { id: newId(), name: opts.name.trim(), workspace, description: `[群组讨论] ${disc.title}`, created_at: new Date().toISOString() };
    await saveProject(project);
    try {
      if (opts.scaffold) await scaffoldProject(workspace, { name: project.name, description: project.description });
      else await initGitOnly(workspace);
    } catch (e) {
      deps.logger.warn('discussion convert project init failed (project still created)', { projectId: project.id, error: String((e as Error)?.message || e) });
    }
  } else {
    if (!opts.project_id) throw new DiscussionError(400, '挂入已有项目需要 project_id');
    const existing = await getProject(opts.project_id);
    if (!existing) throw new DiscussionError(404, `project not found: ${opts.project_id}`);
    project = existing;
  }

  const messages = await getMessages(discId);
  const pending = unansweredQuestions(messages);
  const description = [
    disc.scheme,
    `\n[来源] 本任务由群组讨论「${disc.title}」讨论沉淀生成，方案即需求基线；讨论中各成员的结论与项目记忆为准。`,
    pending.length ? `\n[待定事项——以下问题用户尚未拍板，执行到相关决策点时先按方案默认取向推进并在产出中标注]\n${pending.map((p) => `- ${p.from}: ${p.text}`).join('\n')}` : '',
  ].join('\n');

  // scheme itself becomes a project-category knowledge entry (cross-task reusable)
  const kn = writeKnowledge({
    title: `项目规划方案：${disc.title}`,
    content: disc.scheme,
    category: 'project',
    project_id: project.id,
    tags: ['项目规划方案', '群组讨论'],
    source: `discussion:${discId}`,
  });
  await addProjectMemory(project.id, `[群组讨论「${disc.title}」定稿] 方案 v${disc.scheme_version} 已转项目开发（任务见知识库条目「项目规划方案：${disc.title}」${pending.length ? `；${pending.length} 个待定事项` : ''}）`, 'auto');

  const { taskId } = await deps.orchestrator.createTask(description, project.workspace, project.id, { skipClarification: true, planAsync: true });
  disc.project_id = disc.project_id || project.id;
  disc.task_id = taskId;
  disc.status = 'converted';
  await saveDiscussion(disc);
  await appendSystemMessage(discId, `已转为${opts.target === 'new' ? '新建' : '已有'}项目「${project.name}」并创建开发任务 ${taskId}${kn.updated ? '（方案已更新知识库条目）' : '（方案已沉淀知识库）'}`, undefined, 'card');
  await emitProgress('discussion_converted', { discussion_id: discId, project_id: project.id, task_id: taskId });
  await emitProgress('discussion_status', { discussion_id: discId, status: 'converted' });
  if (opts.auto_run) {
    void waitForPlannedThenEnqueue(deps, taskId, project.id, project.workspace).catch((e) =>
      deps.logger.warn('discussion auto-run wait failed', { taskId, error: String(e) })
    );
  }
  return { project_id: project.id, task_id: taskId };
}

// ---------- discussion lifecycle ----------

export async function createDiscussion(deps: DiscussionDeps, input: { title: string; topic?: string; members: string[]; mode?: DiscussionMode; project_id?: string }): Promise<Discussion> {
  const title = (input.title || '').trim();
  if (!title) throw new DiscussionError(400, 'title is required');
  if (!Array.isArray(input.members) || input.members.length === 0) throw new DiscussionError(400, '至少选择一个讨论成员');
  const unknown = input.members.filter((m) => !deps.orchestrator.plugins.has(m));
  if (unknown.length) throw new DiscussionError(400, `未知成员（不在 agent 注册表）：${unknown.join('、')}`);
  if (input.project_id && !(await getProject(input.project_id))) throw new DiscussionError(404, `project not found: ${input.project_id}`);
  const disc: Discussion = {
    id: newId(),
    title,
    topic: input.topic?.trim() || undefined,
    members: [...new Set(input.members)],
    mode: input.mode === 'auto' ? 'auto' : 'manual',
    status: 'discussing',
    scheme: '',
    scheme_version: 0,
    project_id: input.project_id,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
  await busSet(discKey(disc.id), disc);
  await appendSystemMessage(disc.id, `群组讨论开始 · 成员：${disc.members.join('、')}${disc.project_id ? ' · 已绑定项目，成员可直接读写项目' : ''}`);
  await emitProgress('discussion_started', { discussion_id: disc.id, title: disc.title, members: disc.members, mode: disc.mode });
  return disc;
}

/** Busy probe for the API layer: user messages are never rejected, but the UI
 *  wants to know a round is already draining them (queued vs fresh trigger). */
export async function isDiscussionBusy(id: string): Promise<boolean> {
  return isBusy(id);
}

/**
 * Server startup: a previous process may have died mid-round and left `busy`/`stop`
 * keys behind; with no owner to release them they would wedge discussions for the
 * full TTL. Clear them (mirrors sweepInterruptedTasks for tasks).
 */
export async function clearStaleDiscussionLocks(logger?: { info(msg: string, meta?: unknown): void }): Promise<number> {
  const keys = (await busKeys('discussion:*:busy')).concat(await busKeys('discussion:*:stop'));
  for (const k of keys) await busDel(k);
  if (keys.length) logger?.info('cleared stale discussion locks', { count: keys.length });
  return keys.length;
}

/** Edit mode/title or manually overwrite the scheme (counts as a new version). */
export async function updateDiscussion(id: string, patch: { mode?: DiscussionMode; title?: string; scheme?: string }): Promise<Discussion> {
  const disc = await getDiscussion(id);
  if (!disc) throw new DiscussionError(404, `discussion not found: ${id}`);
  if (patch.mode === 'manual' || patch.mode === 'auto') disc.mode = patch.mode;
  if (patch.title?.trim()) disc.title = patch.title.trim();
  if (typeof patch.scheme === 'string' && patch.scheme.trim() !== disc.scheme) {
    disc.scheme = patch.scheme;
    disc.scheme_version += 1;
    await appendSystemMessage(disc.id, `项目规划方案 v${disc.scheme_version} 已由用户编辑更新`, undefined, 'card');
    await emitProgress('discussion_scheme_updated', { discussion_id: disc.id, version: disc.scheme_version });
  }
  await saveDiscussion(disc);
  return disc;
}

export interface UserPostOptions {
  /** quote another message id */
  reply_to?: string;
  /** react to a message instead of (or besides) posting text */
  react_to?: string;
  emoji?: string;
}

/** Post a user message (the user is the decision-maker; its direction fixes bind all members). */
export async function postUserMessage(
  deps: DiscussionDeps,
  discId: string,
  text: string,
  opts?: UserPostOptions,
): Promise<{ message: DiscussionMessage | null; mentioned: string[] }> {
  const disc = await getDiscussion(discId);
  if (!disc) throw new DiscussionError(404, `discussion not found: ${discId}`);
  if (disc.status === 'converted') throw new DiscussionError(400, '讨论已转为项目，请通过任务介入通道继续沟通');
  const clean = (text || '').trim();

  // 轻量回应：emoji reaction（不产生新消息、不触发发言轮）——用户用行动代替催促
  if (opts?.react_to && !clean) {
    const emoji = (opts.emoji || '👍').trim().slice(0, 8);
    const key = msgKey(discId);
    const list = (await busGet<DiscussionMessage[]>(key)) || [];
    const target = list.find((m) => m.id === opts.react_to);
    if (!target) throw new DiscussionError(404, `message not found: ${opts.react_to}`);
    target.reactions = target.reactions || {};
    const reactors = (target.reactions[emoji] = target.reactions[emoji] || []);
    if (!reactors.includes('user')) reactors.push('user');
    await busSet(key, list.slice(-MAX_MESSAGES));
    await emitProgress('discussion_reacted', { discussion_id: discId, message_id: target.id, emoji, reactions: target.reactions });
    return { message: null, mentioned: [] };
  }

  if (!clean) throw new DiscussionError(400, 'message text is required');
  if (clean.length > MAX_MESSAGE_LENGTH) throw new DiscussionError(400, `message too long (>${MAX_MESSAGE_LENGTH})`);
  const { mentioned, invalid } = parseMentions(clean, disc.members);
  if (invalid.length) throw new DiscussionError(400, `@ 了不在讨论中的成员：${invalid.join('、')}；有效成员：${disc.members.join('、')}`);
  let reply_to: string | undefined;
  if (opts?.reply_to) {
    const list = await getMessages(discId);
    if (!list.some((m) => m.id === opts.reply_to)) throw new DiscussionError(400, `reply_to 消息不存在：${opts.reply_to}`);
    reply_to = opts.reply_to;
  }
  const msg = await appendMessage(discId, {
    id: newId(),
    from: 'user',
    text: clean,
    ts: new Date().toISOString(),
    mentioned: mentioned.length ? mentioned : undefined,
    reply_to,
  });
  // 不再有"点名 XX 发言"的 system 印章：路由器按用户指示选人（点名=只跑被点名者）
  return { message: msg, mentioned };
}

/**
 * Kick the response loop after a user message, in background (HTTP returns
 * immediately; progress streams over WS). If a loop is already running, it
 * drains the message itself (busy 409 here is expected, not an error).
 */
export function triggerRound(deps: DiscussionDeps, disc: Discussion, mentioned: string[]): void {
  const run = () => runResponseLoop(deps, disc.id, { forced: mentioned.length ? mentioned : undefined, auto: disc.mode === 'auto' });
  void run().catch((e) => {
    if ((e as DiscussionError)?.status !== 409) deps.logger.error('discussion round failed', { discId: disc.id, error: String((e as Error)?.message || e) });
  });
}

/**
 * 启动恢复：上一进程在轮中途被杀/重启时，"最后一条是用户消息"的讨论意味着
 * 这句话永远没人接（实测：服务重启打断在飞轮，用户两次追问石沉大海）。
 * 扫描这些讨论并重新驱动响应循环——用户的话不能丢。
 */
export async function resumeOrphanedDiscussions(deps: DiscussionDeps): Promise<number> {
  let n = 0;
  for (const disc of await listDiscussions()) {
    if (disc.status === 'converted') continue;
    if (await isBusy(disc.id)) continue;
    const msgs = await getMessages(disc.id);
    const last = msgs[msgs.length - 1];
    if (last && last.from === 'user') {
      deps.logger.info('discussion resume: re-driving unanswered user turn', { discId: disc.id, lastUserMsg: last.ts });
      triggerRound(deps, disc, last.mentioned || []);
      n++;
    }
  }
  if (n) deps.logger.info('discussion resume sweep done', { resumed: n });
  return n;
}

export async function requestStop(deps: DiscussionDeps, discId: string): Promise<void> {
  const disc = await getDiscussion(discId);
  if (!disc) throw new DiscussionError(404, `discussion not found: ${discId}`);
  await busSet(stopKey(discId), 1);
  await appendSystemMessage(discId, '用户请求停止自动讨论');
}
