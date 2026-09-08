/**
 * 群组沟通（group discussion）：用户 + 多 agent 的群聊式项目规划讨论。
 *
 * 完整链路：发起讨论 → 自主沟通（每轮全员被唤起、无关者 speak:false 自决沉默，
 * @ 点名者强制发言；agent 遇需用户拍板的事项用 ask_user 提问）→ 生成项目规划
 * 方案 → 一键转项目+开发任务 → 讨论期经验自动沉淀进知识库/项目记忆。
 *
 * 设计约束：
 * - 讨论是任务的前置/旁路阶段，不占用 taskQueue 车道（LLM 直调）；
 * - 全部状态走 message bus KV（Redis 或内存+文件），天然获得持久化与 WS 通道；
 * - agentMessages.ts 的"任务内实时互问"另议（需 DAG suspend/wake），此处不做。
 */
import { busGet, busSet, busDel, busKeys } from './bus';
import { emitProgress, addProjectMemory, addAgentMemory, getAgentMemory, saveProject, getProject, getProjectMemory, getTaskGraph } from './store';
import type { ProjectRecord } from './store';
import { chat, extractJson, stripCodeFence } from './llm';
import type { ModelPool } from './scheduler';
import type { Orchestrator } from './orchestrator/orchestrator';
import type { TaskQueueManager } from './taskQueue';
import type { Logger } from './logger';
import { writeKnowledge, relevantKnowledge } from './knowledge';
import { scaffoldProject, initGitOnly } from './scaffold';
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
const MAX_AUTO_ROUNDS = 3;
/** per-round context: keep the window bounded so 8-member rounds don't explode tokens */
const CONTEXT_MESSAGES = 30;
const SCHEME_CONTEXT_CHARS = 3000;
const BUSY_TTL_MS = 10 * 60 * 1000;
/** planAsync tasks poll for 'planned' before auto-run enqueue */
const PLAN_WAIT_TIMEOUT_MS = 10 * 60 * 1000;
const PLAN_WAIT_INTERVAL_MS = 2000;

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

/** Append a centered system line (round tallies, status changes) — silent for pending-question derivation. */
async function appendSystemMessage(id: string, text: string, round?: number): Promise<void> {
  await appendMessage(id, { id: newId(), from: 'system', text, ts: new Date().toISOString(), round });
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

// ---------- model selection for a discussion speaker ----------

function pickModel(deps: DiscussionDeps, agent: string) {
  const plugin = deps.orchestrator.plugins.get(agent);
  if (plugin?.modelOverride) {
    const pinned = deps.pool.getModel(plugin.modelOverride);
    if (pinned) return pinned;
  }
  return deps.pool.selectModel(plugin?.tags, 'normal') ?? deps.pool.selectModel(undefined, 'normal');
}

/** Render the recent discussion window for the prompt (with speaker + round tags). */
function renderTranscript(messages: DiscussionMessage[]): string {
  const recent = messages.slice(-CONTEXT_MESSAGES);
  return recent
    .map((m) => {
      const who = m.from === 'user' ? '用户（决策方）' : m.from === 'system' ? '系统' : m.from;
      const tag = m.round ? `第${m.round}轮 ` : '';
      const ask = m.needs_user ? '[待用户拍板] ' : '';
      return `${tag}${who}: ${ask}${m.text}`;
    })
    .join('\n');
}

// ---------- the round engine ----------

export interface RoundResult {
  round: number;
  speakers: string[];
  silent: string[];
  asked_user: string[];
  all_silent?: boolean;
}

function speakerSystemPrompt(deps: DiscussionDeps, agent: string, forced: boolean): string {
  const plugin = deps.orchestrator.plugins.get(agent);
  const identity = plugin
    ? `# 身份\n你是群组讨论中的「${agent}」Agent（角色：${plugin.role || agent}）。\n${(plugin.prompt || '').slice(0, 1500)}`
    : `# 身份\n你是群组讨论中的「${agent}」成员。`;
  return `${identity}

# 场景：项目规划群组讨论
你在一个项目规划群聊里，与用户（决策方）和其他专业 agent 共同讨论、打磨一份项目规划方案。
## 群聊规则（必须遵守）
1. 用户是决策方：用户的补充与方向性修正对全体成员有约束力，必须遵守并呼应其最新指示。
2. 自主发言，宁缺毋滥：如果你与当前讨论内容无关、或没有实质性补充（复述他人、客套、无信息量），输出 speak=false 保持沉默。禁止为了出镜而发言。
3. 发言 ≤300 字，给观点、论据、可执行建议；可以直接质疑或补充其他成员的观点，但保持专业克制。
4. 经验沉淀：当你陈述一条通用经验、项目踩坑或关键决策理由时，把它用一两句话写进 experience 字段（没有则留空）。这些经验会自动沉淀到项目知识库。
5. 需要用户拍板的事项（方向取舍、资源投入、重大分歧）放进 ask_user 字段，问题清晰可附建议选项；普通疑问不要打扰用户，不要滥用。
${forced ? '6. 你已被用户 @ 点名，本轮必须发言（speak 必须为 true）。' : ''}
## 输出契约
最终消息必须是纯 JSON（禁止 markdown 代码栅栏），字段：
{"speak": true | false, "reply": "发言内容（speak=true 时必填，≤300字）", "experience": "可选：一句话经验", "ask_user": "可选：需要用户判断的问题"}`;
}

async function speakerUserPrompt(deps: DiscussionDeps, disc: Discussion, messages: DiscussionMessage[], agent: string, round: number, firstSubstantive: boolean): Promise<string> {
  const parts: string[] = [];
  parts.push(`## 讨论话题\n${disc.title}`);
  if (disc.topic) parts.push(`## 需求背景\n${disc.topic}`);
  if (disc.scheme) parts.push(`## 方案当前版本 v${disc.scheme_version}（摘要）\n${disc.scheme.slice(0, SCHEME_CONTEXT_CHARS)}`);
  if (disc.project_id) {
    const pm = await getProjectMemory(disc.project_id, 10);
    if (pm.length) parts.push(`## 本项目开发规范与经验\n${pm.map((m) => `- ${m.text}`).join('\n')}`);
  }
  const query = `${disc.title} ${disc.topic || ''} ${messages.filter((m) => m.from === 'user').slice(-1)[0]?.text || ''}`.trim();
  try {
    const kn = await relevantKnowledge(query, { project_id: disc.project_id, limit: 3 });
    if (kn.length) parts.push(`## 相关知识库条目\n${kn.map((k) => `- 【${k.title}】${k.content.slice(0, 200)}`).join('\n')}`);
  } catch {
    /* knowledge search is best-effort */
  }
  const mem = await getAgentMemory(agent, 5);
  if (mem.length) parts.push(`## 你过往的经验记忆\n${mem.map((m) => `- ${m}`).join('\n')}`);
  parts.push(`## 讨论记录（最近消息）\n${messages.length ? renderTranscript(messages) : '（尚无消息）'}`);
  parts.push(
    firstSubstantive
      ? `## 本轮（第 ${round} 轮）\n请各位围绕话题给出初始观点：目标理解、技术选型建议、风险点、需要用户决策的问题。`
      : `## 本轮（第 ${round} 轮）\n请基于讨论记录决定是否发言：有实质补充就说，没有就保持沉默。`
  );
  return parts.join('\n\n');
}

/**
 * Run one discussion round: every member is invoked in order (later speakers see
 * earlier replies of the same round); each self-decides speak/ask_user/experience.
 * `forced` = @-mentioned agents that must speak (others still self-decide).
 */
export async function runDiscussionRound(deps: DiscussionDeps, discId: string, opts?: { forced?: string[]; roundNo?: number }): Promise<RoundResult> {
  await acquireBusy(discId);
  try {
    return await runRoundCore(deps, discId, opts);
  } finally {
    await busDel(busyKey(discId));
  }
}

/** Round body without lock handling — callers (runDiscussionRound / runAutoDiscussion) hold the lock. */
async function runRoundCore(deps: DiscussionDeps, discId: string, opts?: { forced?: string[]; roundNo?: number }): Promise<RoundResult> {
  const disc = await getDiscussion(discId);
  if (!disc) throw new DiscussionError(404, `discussion not found: ${discId}`);
  if (disc.status === 'converted') throw new DiscussionError(400, '讨论已转为项目，不能再发起发言');
  await stampBusy(discId);
  {
    const messages = await getMessages(discId);
    const round = opts?.roundNo ?? (messages.reduce((acc, m) => Math.max(acc, m.round || 0), 0) + 1);
    const firstSubstantive = !messages.some((m) => m.from !== 'system');
    const speakers: string[] = [];
    const silent: string[] = [];
    const asked: string[] = [];

    for (const agent of disc.members) {
      // cooperative stop between speakers (user pressed 停止, or discussion deleted)
      if (await busGet(stopKey(discId))) break;
      if (!(await getDiscussion(discId))) break;
      const forced = opts?.forced?.includes(agent) === true;
      // per-speaker heartbeat so chat surfaces can show who is being invoked right now
      await emitProgress('discussion_round', { discussion_id: discId, round, phase: 'speaker', agent });
      const entry = pickModel(deps, agent);
      if (!entry) {
        deps.logger.warn('discussion round: no model available for agent, skipped', { discId, agent });
        silent.push(agent);
        continue;
      }
      let parsed: Record<string, any> | null = null;
      try {
        const userMsg = await speakerUserPrompt(deps, disc, await getMessages(discId), agent, round, firstSubstantive);
        // honor agent.yaml `timeout` (seconds) like the orchestrator does — a stalled
        // upstream must abort at the agent's budget, not the 600s global default
        const plugin = deps.orchestrator.plugins.get(agent);
        const res = await chat(entry, [
          { role: 'system', content: speakerSystemPrompt(deps, agent, forced) },
          { role: 'user', content: userMsg },
        ], undefined, 0.3, undefined, (plugin?.timeout || 300) * 1000);
        parsed = extractJson(res.content);
        // forced speakers must speak: a weak model returning speak:false is nudged once
        if (forced && (!parsed || parsed.speak !== true)) {
          const retry = await chat(entry, [
            { role: 'system', content: speakerSystemPrompt(deps, agent, true) },
            { role: 'user', content: userMsg + '\n\n注意：用户直接 @ 了你提问，你必须给出实质性发言（speak=true）。' },
          ], undefined, 0.3, undefined, (plugin?.timeout || 300) * 1000);
          parsed = extractJson(retry.content);
        }
      } catch (e) {
        // honest degradation: a failed call counts as silence, never a fabricated reply
        deps.logger.warn('discussion speaker call failed', { discId, agent, error: String((e as Error)?.message || e) });
        silent.push(agent);
        continue;
      }
      if (!parsed) {
        // unparseable output from a non-forced agent is silence; a forced one gets an honest notice
        if (forced) {
          await appendMessage(discId, { id: newId(), from: agent, text: '（被点名发言但输出无法解析，本轮未能给出观点）', ts: new Date().toISOString(), round });
          silent.push(agent);
        } else {
          silent.push(agent);
        }
        continue;
      }
      if (parsed.speak !== true) {
        silent.push(agent);
        // experience/ask_user still honored when the agent chose to stay silent? No —
        // silence must be total; otherwise "silence" would still spam the knowledge base.
        continue;
      }
      const reply = String(parsed.reply || '').trim().slice(0, MAX_MESSAGE_LENGTH);
      const askUser = String(parsed.ask_user || '').trim();
      const experience = String(parsed.experience || '').trim();
      if (reply || askUser) {
        const msg: DiscussionMessage = {
          id: newId(),
          from: agent,
          text: [reply, askUser ? `【需要你拍板】${askUser}` : ''].filter(Boolean).join('\n\n'),
          ts: new Date().toISOString(),
          round,
          needs_user: !!askUser,
        };
        await appendMessage(discId, msg);
        speakers.push(agent);
        if (askUser) {
          asked.push(agent);
          await emitProgress('discussion_ask_user', { discussion_id: discId, agent, question: askUser, round });
          const { notify } = await import('./notify');
          notify('discussion_ask_user', { discussion_id: discId }, `[Co-Team] 群组讨论「${disc.title}」中 ${agent} 需要你拍板：${askUser.slice(0, 80)}`);
        }
      } else {
        silent.push(agent);
      }
      if (experience && speakers.includes(agent)) {
        await depositExperience(deps, discId, agent, experience).catch((e) =>
          deps.logger.warn('discussion experience deposit failed', { discId, agent, error: String(e) })
        );
      }
    }

    const stopped = await busGet(stopKey(discId));
    const tally = [`第 ${round} 轮`];
    if (speakers.length) tally.push(`发言：${speakers.join('、')}`);
    if (silent.length) tally.push(`未发言：${silent.join('、')}`);
    if (asked.length) tally.push(`待 ${asked.join('、')} 向用户提问已发出`);
    await appendSystemMessage(discId, tally.join(' · '), round);
    disc.updated_at = new Date().toISOString();
    await saveDiscussion(disc);
    await emitProgress('discussion_round', { discussion_id: discId, round, phase: 'end', speakers, silent, asked_user: asked });
    return { round, speakers, silent, asked_user: asked, all_silent: speakers.length === 0 && !stopped };
  }
}

// ---------- auto mode: moderator-driven loop ----------

/** Moderator decides whether the discussion still has open points worth another round. */
async function moderatorCheck(deps: DiscussionDeps, disc: Discussion, lastResult: RoundResult): Promise<boolean> {
  const entry = deps.pool.selectModel(undefined, 'simple');
  if (!entry) return false;
  const messages = await getMessages(disc.id);
  try {
    const res = await chat(entry, [
      {
        role: 'system',
        content: '你是项目规划群聊的主持人。判断讨论是否还有必要进行下一轮：如果各成员仍在补充新信息/存在未解决的分歧，继续；如果观点已重复、无新信息或已收敛，停止。只输出 JSON：{"continue": true|false, "reason": "一句话"}',
      },
      { role: 'user', content: `话题：${disc.title}\n最近消息：\n${renderTranscript(messages)}\n\n刚结束第 ${lastResult.round} 轮。` },
    ], undefined, 0);
    const parsed = extractJson(res.content);
    return parsed?.continue === true;
  } catch {
    return false;
  }
}

/**
 * Auto-mode loop: rounds until the moderator converges, the member count caps out
 * (MAX_AUTO_ROUNDS per trigger), everyone falls silent, or an ask_user pauses it
 * for the user's decision. The busy lock is held across the whole loop.
 */
export async function runAutoDiscussion(deps: DiscussionDeps, discId: string, opts?: { forced?: string[] }): Promise<void> {
  const disc = await getDiscussion(discId);
  if (!disc) throw new DiscussionError(404, `discussion not found: ${discId}`);
  await acquireBusy(discId);
  await busDel(stopKey(discId));
  try {
    for (let i = 0; i < MAX_AUTO_ROUNDS; i++) {
      if (await busGet(stopKey(discId))) {
        await busDel(stopKey(discId));
        break;
      }
      const res = await runRoundCore(deps, discId, { forced: i === 0 ? opts?.forced : undefined });
      const msgs = await getMessages(discId);
      if (hasPendingUserQuestion(msgs)) {
        // an agent asked the user something: pause the loop until the user replies
        await appendSystemMessage(discId, '自动讨论已暂停，等待你的回答后继续', res.round);
        await emitProgress('discussion_status', { discussion_id: discId, waiting_user: true });
        break;
      }
      if (res.all_silent) {
        await appendSystemMessage(discId, '全员沉默，讨论暂无新进展——可补充信息继续，或生成方案', res.round);
        break;
      }
      const live = await getDiscussion(discId);
      if (!live) break;
      if (!(await moderatorCheck(deps, live, res))) break;
    }
  } finally {
    await busDel(busyKey(discId));
  }
}

// ---------- scheme generation ----------

/** Converge the discussion into a structured project planning scheme (markdown). */
export async function generateScheme(deps: DiscussionDeps, discId: string): Promise<Discussion> {
  const disc = await getDiscussion(discId);
  if (!disc) throw new DiscussionError(404, `discussion not found: ${discId}`);
  const messages = await getMessages(discId);
  const substantive = messages.filter((m) => m.from !== 'system');
  if (substantive.length < 2) throw new DiscussionError(400, '讨论内容太少（至少需要 2 条发言），请继续讨论后再生成方案');
  const entry = deps.pool.selectModel(undefined, 'complex') ?? deps.pool.selectModel(undefined, 'normal');
  if (!entry) throw new DiscussionError(503, '模型池无可用模型');

  const pending = unansweredQuestions(messages);
  const allTranscript = messages
    .filter((m) => m.from !== 'system')
    .map((m) => `${m.round ? `第${m.round}轮 ` : ''}${m.from === 'user' ? '用户（决策方）' : m.from}: ${m.needs_user ? '[提问] ' : ''}${m.text}`)
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
  await appendSystemMessage(discId, `项目规划方案 v${disc.scheme_version} 已生成`);
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
  await appendSystemMessage(discId, `已转为${opts.target === 'new' ? '新建' : '已有'}项目「${project.name}」并创建开发任务 ${taskId}${kn.updated ? '（方案已更新知识库条目）' : '（方案已沉淀知识库）'}`);
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
  await appendSystemMessage(disc.id, `群组讨论开始 · 成员：${disc.members.join('、')} · ${disc.mode === 'auto' ? '自动模式' : '手动模式'}${disc.project_id ? ` · 挂入项目 ${disc.project_id}` : ''}`);
  await emitProgress('discussion_started', { discussion_id: disc.id, title: disc.title, members: disc.members, mode: disc.mode });
  return disc;
}

/** Busy probe for the API layer: reject user triggers while a round is in flight. */
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
    await appendSystemMessage(disc.id, `项目规划方案 v${disc.scheme_version} 已由用户编辑更新`);
    await emitProgress('discussion_scheme_updated', { discussion_id: disc.id, version: disc.scheme_version });
  }
  await saveDiscussion(disc);
  return disc;
}

/** Post a user message (the user is the decision-maker; its direction fixes bind all members). */
export async function postUserMessage(deps: DiscussionDeps, discId: string, text: string): Promise<{ message: DiscussionMessage; mentioned: string[] }> {
  const disc = await getDiscussion(discId);
  if (!disc) throw new DiscussionError(404, `discussion not found: ${discId}`);
  if (disc.status === 'converted') throw new DiscussionError(400, '讨论已转为项目，请通过任务介入通道继续沟通');
  const clean = (text || '').trim();
  if (!clean) throw new DiscussionError(400, 'message text is required');
  if (clean.length > MAX_MESSAGE_LENGTH) throw new DiscussionError(400, `message too long (>${MAX_MESSAGE_LENGTH})`);
  const { mentioned, invalid } = parseMentions(clean, disc.members);
  if (invalid.length) throw new DiscussionError(400, `@ 了不在讨论中的成员：${invalid.join('、')}；有效成员：${disc.members.join('、')}`);
  const msg = await appendMessage(discId, {
    id: newId(),
    from: 'user',
    text: clean,
    ts: new Date().toISOString(),
    mentioned: mentioned.length ? mentioned : undefined,
  });
  if (mentioned.length) {
    // 点名可见：其他成员知道用户强制了谁发言（它们仍可自决补充）
    await appendSystemMessage(discId, `用户点名 ${mentioned.join('、')} 发言（必须回应；其他成员可自行决定是否补充）`);
  }
  return { message: msg, mentioned };
}

/**
 * Kick the round loop after a user message, in background (HTTP returns immediately;
 * progress streams over WS). Busy conflict → 409 before this is ever called.
 */
export function triggerRound(deps: DiscussionDeps, disc: Discussion, mentioned: string[]): void {
  const forced = mentioned.length ? mentioned : undefined;
  const run = disc.mode === 'auto' ? runAutoDiscussion(deps, disc.id, { forced }) : runDiscussionRound(deps, disc.id, { forced });
  void run.catch((e) => deps.logger.error('discussion round failed', { discId: disc.id, error: String((e as Error)?.message || e) }));
}

export async function requestStop(deps: DiscussionDeps, discId: string): Promise<void> {
  const disc = await getDiscussion(discId);
  if (!disc) throw new DiscussionError(404, `discussion not found: ${discId}`);
  await busSet(stopKey(discId), 1);
  await appendSystemMessage(discId, '用户请求停止自动讨论');
}
