import { ref } from 'vue';
import { api, type ConvertDiscussionPayload, type Discussion, type DiscussionDetail, type DiscussionMessage, type KnowledgeEntry } from '../api';
import { onEvent } from './useDashboard';

// ---------- module-level singleton store (one WS subscription for all discussion views) ----------

const list = ref<Discussion[]>([]);
const current = ref<DiscussionDetail | null>(null);
const experiences = ref<KnowledgeEntry[]>([]);
/** a round is in flight for the CURRENT discussion (server holds the busy lock) */
const busy = ref(false);
/** agent currently being invoked (typing indicator), cleared at round end */
const thinking = ref('');
const error = ref('');
let subscribed = false;
let busyWatchdog: ReturnType<typeof setTimeout> | null = null;

function armBusyWatchdog() {
  busy.value = true;
  if (busyWatchdog) clearTimeout(busyWatchdog);
  // a round can take minutes; if the end event is ever lost the UI must not hang forever
  busyWatchdog = setTimeout(() => {
    busy.value = false;
    thinking.value = '';
  }, 5 * 60 * 1000);
}

function subscribe() {
  if (subscribed) return;
  subscribed = true;
  onEvent((msg) => {
    const p: Record<string, any> = msg.payload || {};
    const did = p.discussion_id;
    if (msg.type === 'discussion_message' && current.value && did === current.value.id) {
      const m = p.message as DiscussionMessage;
      if (!current.value.messages.some((x) => x.id === m.id)) {
        current.value.messages.push(m);
        current.value.message_count = current.value.messages.length;
      }
      if (m.from === 'user' || m.needs_user) current.value.pending_user = !!m.needs_user;
      void loadList();
    } else if (msg.type === 'discussion_round' && current.value && did === current.value.id) {
      if (p.phase === 'speaker') {
        thinking.value = String(p.agent || '');
        armBusyOnce();
      } else if (p.phase === 'end') {
        busy.value = false;
        thinking.value = '';
        if (busyWatchdog) { clearTimeout(busyWatchdog); busyWatchdog = null; }
        void loadList();
      }
    } else if (['discussion_scheme_updated', 'discussion_status', 'discussion_converted'].includes(msg.type) && current.value && did === current.value.id) {
      void open(current.value.id, true);
      void loadList();
    } else if (msg.type === 'discussion_experience' && current.value && did === current.value.id) {
      void loadExperiences(current.value.id);
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
  try {
    const detail = await api.getDiscussion(id);
    current.value = detail;
    // resume indicator when opening a discussion whose round is still running
    if (busy.value) armBusyOnce();
    if (!keepScroll) thinking.value = '';
    void loadExperiences(id);
  } catch (e: any) {
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

async function send(text: string) {
  if (!current.value) return;
  error.value = '';
  try {
    const res = await api.postDiscussionMessage(current.value.id, text);
    if (!current.value.messages.some((m) => m.id === res.message.id)) {
      current.value.messages.push(res.message);
      current.value.pending_user = false;
    }
    // @-mentioned agents + others may still chime in: a round starts server-side regardless
    armBusyWatchdog();
    void loadList();
    return res;
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

export function useDiscussion() {
  subscribe();
  return { list, current, experiences, busy, thinking, error, loadList, open, create, send, round, stop, generateScheme, saveScheme, setMode, remove, convert };
}
