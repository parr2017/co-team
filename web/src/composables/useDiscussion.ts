import { reactive, ref } from 'vue';
import { api, type ConvertDiscussionPayload, type Discussion, type DiscussionDetail, type DiscussionMessage, type KnowledgeEntry, type PostDiscussionPayload } from '../api';
import { onEvent } from './useDashboard';

// ---------- module-level singleton store (one WS subscription for all discussion views) ----------

const list = ref<Discussion[]>([]);
const current = ref<DiscussionDetail | null>(null);
const experiences = ref<KnowledgeEntry[]>([]);
/** agent 名 → 中文角色名（气泡署名拟人化用，全局加载一次） */
const roles = ref<Record<string, string>>({});
let rolesLoaded = false;
async function loadRoles() {
  if (rolesLoaded) return;
  try {
    const r = await api.listAgents();
    const m: Record<string, string> = {};
    for (const a of r.agents) m[a.name] = a.role || a.description || a.name;
    roles.value = m;
    rolesLoaded = true;
  } catch { /* 拿不到角色就退回 agent id 署名 */ }
}
/** a round is in flight for the CURRENT discussion (server holds the busy lock) */
const busy = ref(false);
/** agent currently being invoked ('' = idle; 'router' = deciding who replies) */
const thinking = ref('');
/** P0.3/P0.7 等待/重试可见化：当前群聊的瞬时等待说明（"已等待 Xs / 第 N 次重试"） */
const waitNote = ref('');
/** what the current speaker is doing: thinking | tool_followup */
const activity = ref('');
/** streaming bubbles: stream_id -> {agent, round, text} */
const streams = reactive<Record<string, { agent: string; round: number; text: string }>>({});
/** 实时工具批次（P1-2 工作流条目）：agent → 最近一批 discussion_tool 的 calls+results（干完后由持久化的 meta.calls 接管） */
const liveTools = reactive<Record<string, { agent: string; calls: any[]; results: any[]; ts: number }>>({});
/** 成员活动（并行协作呈现）：agent → thinking | tool | tool_followup；'' = 空闲 */
const memberActivity = reactive<Record<string, string>>({});
const error = ref('');
let subscribed = false;
let busyWatchdog: ReturnType<typeof setTimeout> | null = null;

function armBusyWatchdog() {
  busy.value = true;
  if (busyWatchdog) clearTimeout(busyWatchdog);
  // rounds can take minutes; any live event re-arms, the watchdog only fires on total silence
  busyWatchdog = setTimeout(() => {
    busy.value = false;
    thinking.value = '';
  }, 5 * 60 * 1000);
}

function reArm() {
  if (busy.value && busyWatchdog) {
    clearTimeout(busyWatchdog);
    busyWatchdog = setTimeout(() => {
      busy.value = false;
      thinking.value = '';
    }, 5 * 60 * 1000);
  }
}

function clearAgentStreams(agent: string) {
  for (const sid of Object.keys(streams)) {
    if (streams[sid].agent === agent) delete streams[sid];
  }
}

function subscribe() {
  if (subscribed) return;
  subscribed = true;
  onEvent((msg) => {
    const p: Record<string, any> = msg.payload || {};
    const did = p.discussion_id;
    if (!current.value || did !== current.value.id) {
      // still track list-level events
      if (['discussion_started', 'discussion_scheme_updated', 'discussion_converted', 'discussion_ask_user', 'discussion_convert_resolved'].includes(msg.type)) void loadList();
      return;
    }
    reArm();
    if (msg.type === 'discussion_message' && p.message) {
      const m = p.message as DiscussionMessage;
      if (!current.value.messages.some((x) => x.id === m.id)) {
        current.value.messages.push(m);
        current.value.message_count = current.value.messages.length;
      }
      if (m.from === 'user' || m.needs_user) current.value.pending_user = !!m.needs_user;
      if (m.from !== 'user' && m.from !== 'system') {
        // 正式消息上屏：该成员的流式气泡让位（含跨轮的 * 清理）
        for (const sid of Object.keys(streams)) if (sid.includes(`:${m.from}:`)) delete streams[sid];
      }
      void loadList();
    } else if (msg.type === 'discussion_message_delta' && p.stream_id) {
      if (p.discarded) {
        delete streams[String(p.stream_id)];
      } else {
        const sid = String(p.stream_id);
        if (!streams[sid]) streams[sid] = { agent: String(p.agent || ''), round: Number(p.round || 0), text: '' };
        streams[sid].text += String(p.text || '');
        if (!busy.value) armBusyWatchdog();
      }
    } else if (msg.type === 'discussion_tool') {
      // P1-2 工作流条目：实时工具批次进 liveTools（树形渲染）；持久化由 meta.calls 接管
      const agent = String(p.agent || '');
      thinking.value = agent;
      activity.value = 'tool';
      memberActivity[agent] = 'tool';
      liveTools[agent] = {
        agent,
        calls: Array.isArray(p.calls) ? p.calls : [],
        results: Array.isArray(p.results) ? p.results : [],
        ts: Date.now(),
      };
    } else if (msg.type === 'discussion_reacted') {
      const target = current.value.messages.find((x) => x.id === p.message_id);
      if (target) target.reactions = (p.reactions as Record<string, string[]>) || target.reactions;
    } else if (msg.type === 'discussion_reason') {
      // P0.7：推理流到达即证明"活着"——续期看门狗（不再 5 分钟熄灯），不打扰正文
      reArm();
    } else if (msg.type === 'discussion_retry') {
      // P0.3：换模/重试过程可见（此前 20s/40s 退避期完全静默）
      waitNote.value = `${String(p.agent || '')}：模型 ${String(p.model || '')} 调用失败${p.next ? `，切换 ${String(p.next)}` : `，第 ${Number(p.attempt || 1)} 次重试`}`;
      reArm();
    } else if (msg.type === 'discussion_waiting') {
      // P0.3：首包等待心跳（≥120s 每 30s 一条）
      waitNote.value = `${String(p.agent || '')} 已等待 ${Number(p.waited_sec || 0)}s（模型 ${String(p.model || '')} 响应中）`;
      reArm();
    } else if (msg.type === 'discussion_round') {
      if (p.phase === 'router') {
        thinking.value = 'router';
        activity.value = '';
      } else if (p.phase === 'queued') {
        // P2-4 并行发言：并发槽满时排队中状态可见
        memberActivity[String(p.agent || '')] = 'queued';
      } else if (p.phase === 'speaker') {
        thinking.value = String(p.agent || '');
        activity.value = String(p.activity || 'thinking');
        memberActivity[String(p.agent || '')] = String(p.activity || 'thinking');
        armBusyOnce();
      } else if (p.phase === 'end') {
        busy.value = false;
        thinking.value = '';
        activity.value = '';
        waitNote.value = '';
        for (const sid of Object.keys(streams)) delete streams[sid];
        for (const k of Object.keys(memberActivity)) delete memberActivity[k];
        for (const k of Object.keys(liveTools)) delete liveTools[k];
        if (busyWatchdog) { clearTimeout(busyWatchdog); busyWatchdog = null; }
        void loadList();
      }
    } else if (msg.type === 'discussion_convert_resolved') {
      // 转任务确认卡已拍板：本地回写卡片状态 + 重拉详情（status 可能已变 converted）
      const target = current.value.messages.find((x) => x.id === p.message_id);
      if (target?.meta?.convert_confirm) target.meta.convert_confirm = { ...target.meta.convert_confirm, state: p.state, task_id: p.task_id };
      void open(current.value.id, true);
      void loadList();
    } else if (['discussion_scheme_updated', 'discussion_status', 'discussion_converted'].includes(msg.type)) {
      void open(current.value.id, true);
      void loadList();
    } else if (msg.type === 'discussion_experience') {
      void loadExperiences(current.value.id);
    } else if (msg.type === 'discussion_ask_user') {
      current.value.pending_user = true;
      void loadList();
    } else if (msg.type === 'discussion_started') {
      void loadList();
    }
  });
}

/** mark busy while waiting for speakers (no reset of the watchdog) */
function armBusyOnce() {
  if (!busy.value) {
    busy.value = true;
    if (busyWatchdog) clearTimeout(busyWatchdog);
    busyWatchdog = setTimeout(() => {
      busy.value = false;
      thinking.value = '';
    }, 5 * 60 * 1000);
  }
}

async function loadList() {
  try {
    list.value = (await api.listDiscussions()).discussions;
  } catch (e: any) {
    error.value = String(e?.message || e);
  }
}

async function loadExperiences(id: string) {
  try {
    experiences.value = (await api.listKnowledge({ source: `discussion:${id}`, limit: 100 })).entries;
  } catch {
    experiences.value = [];
  }
}

async function open(id: string, keepScroll = false) {
  subscribe();
  void loadRoles();
  try {
    const detail = await api.getDiscussion(id);
    current.value = detail;
    // resume indicator when opening a discussion whose round is still running
    if (detail.busy || busy.value) armBusyOnce();
    if (!keepScroll) {
      thinking.value = '';
      activity.value = '';
      waitNote.value = '';
      for (const sid of Object.keys(streams)) delete streams[sid];
      for (const k of Object.keys(memberActivity)) delete memberActivity[k];
      for (const k of Object.keys(liveTools)) delete liveTools[k];
    }
    void loadExperiences(id);
  } catch (e: any) {
    // 讨论已不存在（被删除/数据丢失）：自清，不再让界面反复打 404
    if (String(e?.message || e).includes('404') || String(e?.message || e).includes('not found')) {
      current.value = null;
      void loadList();
      return;
    }
    error.value = String(e?.message || e);
  }
}

async function create(payload: { title: string; topic?: string; members: string[]; mode?: 'manual' | 'auto'; project_id?: string }) {
  error.value = '';
  const res = await api.createDiscussion(payload);
  await loadList();
  await open(res.discussion.id);
  return res.discussion;
}

/** 发送用户消息（引擎 v2：busy 期间也受理——服务端循环会消化插话，不再有 409） */
async function send(text: string, opts?: Pick<PostDiscussionPayload, 'reply_to' | 'images'>) {
  if (!current.value) return;
  error.value = '';
  try {
    const res = await api.postDiscussionMessage(current.value.id, { text, reply_to: opts?.reply_to, images: opts?.images });
    if (res.message && !current.value.messages.some((m) => m.id === res.message!.id)) {
      current.value.messages.push(res.message);
      current.value.pending_user = false;
    }
    if (res.queued) armBusyOnce(); // 循环在飞：它会吸收这条插话，保持 busy 呈现
    else armBusyWatchdog();
    void loadList();
    return res;
  } catch (e: any) {
    error.value = String(e?.message || e);
    throw e;
  }
}

/** emoji 轻量回应（不产生消息、不催发言） */
async function react(messageId: string, emoji: string) {
  if (!current.value) return;
  try {
    await api.postDiscussionMessage(current.value.id, { react_to: messageId, emoji });
    const target = current.value.messages.find((m) => m.id === messageId);
    if (target) {
      target.reactions = target.reactions || {};
      const rs = (target.reactions[emoji] = target.reactions[emoji] || []);
      if (!rs.includes('user')) rs.push('user');
    }
  } catch (e: any) {
    error.value = String(e?.message || e);
    throw e;
  }
}

async function round() {
  if (!current.value) return;
  error.value = '';
  try {
    await api.discussionRound(current.value.id);
    armBusyWatchdog();
  } catch (e: any) {
    error.value = String(e?.message || e);
  }
}

async function stop() {
  if (!current.value) return;
  await api.discussionStop(current.value.id).catch(() => undefined);
}

async function generateScheme() {
  if (!current.value) return;
  error.value = '';
  try {
    await api.generateScheme(current.value.id);
    await open(current.value.id, true);
  } catch (e: any) {
    error.value = String(e?.message || e);
    throw e;
  }
}

async function saveScheme(scheme: string) {
  if (!current.value) return;
  await api.updateDiscussion(current.value.id, { scheme });
  await open(current.value.id, true);
}

async function setMode(mode: 'manual' | 'auto') {
  if (!current.value) return;
  await api.updateDiscussion(current.value.id, { mode });
  current.value.mode = mode;
  void loadList();
}

async function remove(id: string) {
  await api.deleteDiscussion(id);
  if (current.value?.id === id) current.value = null;
  await loadList();
}

async function convert(payload: ConvertDiscussionPayload) {
  if (!current.value) throw new Error('未选择讨论');
  const res = await api.convertDiscussion(current.value.id, payload);
  await open(current.value.id, true);
  await loadList();
  return res;
}

/** P0.4：WS 重连补拉（useDashboard 广播 coteam:discussion-resync）——此前讨论断线后卡片永远陈旧 */
function hookResync() {
  if (typeof window === 'undefined' || (window as any).__coteamDiscResyncHooked) return;
  (window as any).__coteamDiscResyncHooked = true;
  window.addEventListener('coteam:discussion-resync', () => {
    if (current.value) void open(current.value.id, true);
    void loadList();
  });
}

export function useDiscussion() {
  subscribe();
  hookResync();
  return { list, current, experiences, busy, thinking, activity, waitNote, streams, liveTools, memberActivity, roles, error, loadList, open, create, send, react, round, stop, generateScheme, saveScheme, setMode, remove, convert };
}
