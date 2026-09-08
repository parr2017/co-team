import { ref } from 'vue';
import { api, type ConvertDiscussionPayload, type Discussion, type DiscussionDetail, type DiscussionMessage, type KnowledgeEntry } from '../api';
import { useWs } from './useWs';

const { onEvent, onResync } = useWs();

/**
 * Mobile singleton store for group discussions — one WS subscription shared by
 * the list and detail views. Mirrors web/src/composables/useDiscussion.ts.
 */

const list = ref<Discussion[]>([]);
const current = ref<DiscussionDetail | null>(null);
const experiences = ref<KnowledgeEntry[]>([]);
const busy = ref(false);
const thinking = ref('');
let subscribed = false;
let busyWatchdog: ReturnType<typeof setTimeout> | null = null;

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

function clearBusy() {
  busy.value = false;
  thinking.value = '';
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
    if (t === 'discussion_message' && current.value && did === current.value.id) {
      const m = p.message as DiscussionMessage;
      if (!current.value.messages.some((x) => x.id === m.id)) {
        current.value.messages.push(m);
        current.value.message_count = current.value.messages.length;
      }
      if (m.from === 'user' || m.needs_user) current.value.pending_user = !!m.needs_user;
      void loadList();
    } else if (t === 'discussion_round' && current.value && did === current.value.id) {
      if (p.phase === 'speaker') {
        thinking.value = String(p.agent || '');
        armBusy(false);
      } else if (p.phase === 'end') {
        clearBusy();
        void loadList();
      }
    } else if (['discussion_scheme_updated', 'discussion_status', 'discussion_converted'].includes(t) && current.value && did === current.value.id) {
      void open(current.value.id);
      void loadList();
    } else if (t === 'discussion_experience' && current.value && did === current.value.id) {
      void loadExperiences(current.value.id);
    } else if (t === 'discussion_started') {
      void loadList();
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
  try {
    current.value = await api.getDiscussion(id);
    void loadExperiences(id);
  } catch {
    current.value = null;
  }
}

async function create(payload: { title: string; topic?: string; members: string[]; mode?: 'manual' | 'auto'; project_id?: string }) {
  const res = await api.createDiscussion(payload);
  await loadList();
  await open(res.discussion.id);
  return res.discussion;
}

async function send(text: string) {
  if (!current.value) return;
  const res = await api.postDiscussionMessage(current.value.id, text);
  if (!current.value.messages.some((m) => m.id === res.message.id)) {
    current.value.messages.push(res.message);
    current.value.pending_user = false;
  }
  armBusy();
  void loadList();
  return res;
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
  return { list, current, experiences, busy, thinking, loadList, open, create, send, round, stop, generateScheme, saveScheme, setMode, remove, convert };
}
