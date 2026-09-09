import { reactive, ref } from 'vue';
import { api, type ConvertDiscussionPayload, type Discussion, type DiscussionDetail, type DiscussionMessage, type KnowledgeEntry, type PostDiscussionPayload } from '../api';
import { useWs } from './useWs';

const { onEvent, onResync } = useWs();

/**
 * Mobile singleton store for group discussions — one WS subscription shared by
 * the list and detail views. Mirrors web/src/composables/useDiscussion.ts
 * （引擎 v2：路由状态、流式气泡、工具活动、emoji 回应、404 自清）。
 */

const list = ref<Discussion[]>([]);
const current = ref<DiscussionDetail | null>(null);
const experiences = ref<KnowledgeEntry[]>([]);
const busy = ref(false);
/** 'router' = 正在决定谁来回复；否则为正在处理的成员名 */
const thinking = ref('');
/** thinking 成员当前动作：thinking | tool_followup | tool */
const activity = ref('');
/** 流式气泡：stream_id -> {agent, round, text} */
const streams = reactive<Record<string, { agent: string; round: number; text: string }>>({});
/** agent 名 → 中文角色名（署名拟人化，全局一次） */
const roles = ref<Record<string, string>>({});
let rolesLoaded = false;
let subscribed = false;
let busyWatchdog: ReturnType<typeof setTimeout> | null = null;

async function loadRoles() {
  if (rolesLoaded) return;
  try {
    const r = await api.listAgentInfos();
    const m: Record<string, string> = {};
    for (const a of r.agents) m[a.name] = a.role || a.description || a.name;
    roles.value = m;
    rolesLoaded = true;
  } catch { /* 拿不到就用 agent id 署名 */ }
}

function armBusy(withWatchdog = true) {
  busy.value = true;
  if (busyWatchdog) clearTimeout(busyWatchdog);
  if (withWatchdog) {
    busyWatchdog = setTimeout(() => {
      busy.value = false;
      thinking.value = '';
    }, 5 * 60 * 1000);
  }
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

function clearBusy() {
  busy.value = false;
  thinking.value = '';
  activity.value = '';
  for (const sid of Object.keys(streams)) delete streams[sid];
  if (busyWatchdog) {
    clearTimeout(busyWatchdog);
    busyWatchdog = null;
  }
}

function subscribe() {
  if (subscribed) return;
  subscribed = true;
  onEvent((msg: any) => {
    const p: Record<string, any> = (msg as any).payload || {};
    const did = p.discussion_id;
    const t = (msg as any).type;
    if (['discussion_started', 'discussion_scheme_updated', 'discussion_converted', 'discussion_ask_user'].includes(t)) void loadList();
    if (!current.value || did !== current.value.id) return;
    reArm();
    if (t === 'discussion_message' && p.message) {
      const m = p.message as DiscussionMessage;
      if (!current.value.messages.some((x) => x.id === m.id)) {
        current.value.messages.push(m);
        current.value.message_count = current.value.messages.length;
      }
      if (m.from === 'user' || m.needs_user) current.value.pending_user = !!m.needs_user;
      if (m.from !== 'user' && m.from !== 'system') {
        for (const sid of Object.keys(streams)) if (sid.includes(`:${m.from}:`)) delete streams[sid];
      }
    } else if (t === 'discussion_message_delta' && p.stream_id) {
      if (p.discarded) {
        delete streams[String(p.stream_id)];
      } else {
        const sid = String(p.stream_id);
        if (!streams[sid]) streams[sid] = { agent: String(p.agent || ''), round: Number(p.round || 0), text: '' };
        streams[sid].text += String(p.text || '');
        if (!busy.value) armBusy();
      }
    } else if (t === 'discussion_tool') {
      thinking.value = String(p.agent || '');
      activity.value = 'tool';
      if (!busy.value) armBusy();
    } else if (t === 'discussion_reacted') {
      const target = current.value.messages.find((x) => x.id === p.message_id);
      if (target) target.reactions = (p.reactions as Record<string, string[]>) || target.reactions;
    } else if (t === 'discussion_round') {
      if (p.phase === 'router') {
        thinking.value = 'router';
        activity.value = '';
        if (!busy.value) armBusy();
      } else if (p.phase === 'speaker') {
        thinking.value = String(p.agent || '');
        activity.value = String(p.activity || 'thinking');
        armBusy(false);
      } else if (p.phase === 'end') {
        clearBusy();
      }
    } else if (['discussion_scheme_updated', 'discussion_status', 'discussion_converted'].includes(t)) {
      void open(current.value.id);
    } else if (t === 'discussion_experience') {
      void loadExperiences(current.value.id);
    } else if (t === 'discussion_ask_user') {
      current.value.pending_user = true;
    }
  });
  // phones resume from background with stale sockets → resync everything
  onResync(() => {
    void loadList();
    if (current.value) void open(current.value.id);
  });
}

async function loadList() {
  try {
    list.value = (await api.listDiscussions()).discussions;
  } catch {
    /* keep last known list */
  }
}

async function loadExperiences(id: string) {
  try {
    experiences.value = (await api.listKnowledge({ source: `discussion:${id}` })).entries;
  } catch {
    experiences.value = [];
  }
}

async function open(id: string) {
  subscribe();
  void loadRoles();
  try {
    const detail = await api.getDiscussion(id);
    current.value = detail;
    // 重进/换设备打开在飞讨论：恢复"成员处理中"指示
    if (detail.busy) armBusy(false);
    void loadExperiences(id);
  } catch {
    // 讨论不存在（已删除/数据丢失）：自清返回列表，界面不再反复打 404
    current.value = null;
    void loadList();
  }
}

async function create(payload: { title: string; topic?: string; members: string[]; mode?: 'manual' | 'auto'; project_id?: string }) {
  const res = await api.createDiscussion(payload);
  await loadList();
  await open(res.discussion.id);
  return res.discussion;
}

/** 发用户消息：busy 期间也受理（服务端循环吸收插话，不再有 409） */
async function send(text: string, opts?: Pick<PostDiscussionPayload, 'reply_to'>) {
  if (!current.value) return;
  const res = await api.postDiscussionMessage(current.value.id, { text, reply_to: opts?.reply_to });
  if (res.message && !current.value.messages.some((m) => m.id === res.message!.id)) {
    current.value.messages.push(res.message);
    current.value.pending_user = false;
  }
  armBusy();
  void loadList();
  return res;
}

/** emoji 轻量回应（不产生消息） */
async function react(messageId: string, emoji: string) {
  if (!current.value) return;
  await api.postDiscussionMessage(current.value.id, { react_to: messageId, emoji });
  const target = current.value.messages.find((m) => m.id === messageId);
  if (target) {
    target.reactions = target.reactions || {};
    const rs = (target.reactions[emoji] = target.reactions[emoji] || []);
    if (!rs.includes('user')) rs.push('user');
  }
}

async function round() {
  if (!current.value) return;
  await api.discussionRound(current.value.id);
  armBusy();
}

async function stop() {
  if (!current.value) return;
  await api.discussionStop(current.value.id).catch(() => undefined);
}

async function generateScheme() {
  if (!current.value) return;
  await api.generateScheme(current.value.id);
  await open(current.value.id);
}

async function saveScheme(scheme: string) {
  if (!current.value) return;
  await api.updateDiscussion(current.value.id, { scheme });
  await open(current.value.id);
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
  await open(current.value.id);
  await loadList();
  return res;
}

export function useDiscussion() {
  subscribe();
  return { list, current, experiences, busy, thinking, activity, streams, roles, loadList, open, create, send, react, round, stop, generateScheme, saveScheme, setMode, remove, convert };
}
