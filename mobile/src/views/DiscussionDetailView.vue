<script setup lang="ts">
import { computed, nextTick, onMounted, reactive, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { showToast } from 'vant';
import { marked } from 'marked';
import { api } from '../api';
import type { ProjectSummary, DiscussionMessage } from '../api';
import { useDiscussion } from '../composables/useDiscussion';
import { agentColor } from '../utils/agentColor';
import { copyText } from '../utils/clipboard';
import AgentAvatar from '../components/AgentAvatar.vue';
import DirPicker from '../components/DirPicker.vue';

defineOptions({ name: 'DiscussionDetailView' });

const route = useRoute();
const router = useRouter();
const { current, experiences, roles, busy, thinking, activity, streams, open, send, react, round, stop, generateScheme, saveScheme, setMode, convert } = useDiscussion();

const discId = computed(() => String(route.params.id));
const draft = ref('');
const stickToBottom = ref(true);
const wrapEl = ref<HTMLElement | null>(null);

const members = computed(() => current.value?.members || []);
const status = computed(() => current.value?.status || 'discussing');
const converted = computed(() => status.value === 'converted');
const pendingUser = computed(() => !!current.value?.pending_user);
const anyStreaming = computed(() => Object.keys(streams).length > 0);

function roleOf(name: string): string {
  if (name === 'user') return '我';
  return roles.value[name] || name;
}
function agentStreaming(agent: string): boolean {
  return Object.values(streams).some((s) => s.agent === agent);
}

// ---------- 消息行模型（与 web DiscussionChat 同构：分组/系统卡片/工具条/引用） ----------

// M5.2 ③：群内直接回答任务的 ask_user 提问
const answeredAskIds = ref<Set<string>>(new Set());
const askDrafts = ref<Record<string, string>>({});
const answeringAsk = ref('');
async function sendAskAnswer(bridge: { task_id: string; ask_id: string }) {
  const text = (askDrafts.value[bridge.ask_id] || '').trim();
  if (!text || answeringAsk.value) return;
  answeringAsk.value = bridge.ask_id;
  try {
    await api.answerAsk(bridge.task_id, bridge.ask_id, text);
    answeredAskIds.value = new Set([...answeredAskIds.value, bridge.ask_id]);
    askDrafts.value[bridge.ask_id] = '';
    showToast('已回答，agent 将继续执行');
  } catch (e: any) {
    showToast(e?.message || '回答失败');
  } finally {
    answeringAsk.value = '';
  }
}

const GROUP_GAP_MS = 3 * 60 * 1000;
const TIME_GAP_MS = 10 * 60 * 1000;
type ChatRow = { type: 'chat'; m: DiscussionMessage; side: 'me' | 'them'; head: boolean; tail: boolean; answered?: boolean; quote?: { who: string; text: string } };
type Row =
  | { type: 'time'; label: string }
  | { type: 'sys'; m: DiscussionMessage }
  | { type: 'tool'; m: DiscussionMessage }
  | ChatRow;

const rows = computed<Row[]>(() => {
  const msgs = current.value?.messages || [];
  const lastUserIdx = msgs.map((m) => m.from).lastIndexOf('user');
  const byId = new Map(msgs.map((m) => [m.id, m]));
  const tsOf = (m: DiscussionMessage) => (m.ts ? new Date(m.ts.replace(' ', 'T')).getTime() : 0);
  const out: Row[] = [];
  let lastTs = 0;
  let prevChat: ChatRow | null = null;
  for (let i = 0; i < msgs.length; i++) {
    const m = msgs[i];
    const ts = tsOf(m);
    if (ts - lastTs > TIME_GAP_MS) { out.push({ type: 'time', label: fmtTime(m.ts) }); prevChat = null; }
    lastTs = ts || lastTs;
    if (m.from === 'system') { out.push({ type: 'sys', m }); prevChat = null; continue; }
    if (m.tool) { out.push({ type: 'tool', m }); continue; }
    const side: 'me' | 'them' = m.from === 'user' ? 'me' : 'them';
    const head = !prevChat || prevChat.m.from !== m.from || ts - tsOf(prevChat.m) > GROUP_GAP_MS;
    const row: ChatRow = {
      type: 'chat', m, side, head, tail: false,
      answered: !!m.needs_user && lastUserIdx > i,
      quote: m.reply_to ? quoteOf(byId.get(m.reply_to)) : undefined,
    };
    if (prevChat) prevChat.tail = !head;
    out.push(row);
    prevChat = row;
  }
  if (prevChat) prevChat.tail = true;
  return out;
});

function quoteOf(src?: DiscussionMessage) {
  if (!src) return undefined;
  return { who: src.from === 'user' ? '我' : roleOf(src.from), text: src.text.slice(0, 40) };
}

function fmtTime(ts: string): string {
  if (!ts) return '';
  const d = new Date(ts.replace(' ', 'T'));
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  return d.toDateString() === new Date().toDateString() ? hm : `${d.getMonth() + 1}月${d.getDate()}日 ${hm}`;
}

function hasReactions(m: DiscussionMessage): boolean {
  return !!m.reactions && Object.keys(m.reactions).length > 0;
}

function md(text: string): string {
  const escaped = (text || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const html = String(marked.parse(escaped, { async: false, breaks: true }));
  return html.replace(/@([A-Za-z0-9_\-\u4e00-\u9fff]+)/g, '<span class="mention">@$1</span>');
}

// ---------- 滚动 ----------
function onScroll() {
  const el = wrapEl.value;
  if (!el) return;
  stickToBottom.value = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
}
function scrollToBottom(force = false) {
  const el = wrapEl.value;
  if (!el || (!force && !stickToBottom.value)) return;
  el.scrollTop = el.scrollHeight;
}
watch(() => [current.value?.messages.length, Object.keys(streams).length, thinking.value], () => void nextTick(() => scrollToBottom()));
onMounted(() => {
  void open(discId.value);
  void nextTick(() => scrollToBottom(true));
});

// ---------- 发送 / 插话 ----------
async function sendNow() {
  const text = draft.value.trim();
  if (!text) return;
  try {
    await send(text, replyTo.value ? { reply_to: replyTo.value } : undefined);
    draft.value = '';
    replyTo.value = null;
    stickToBottom.value = true;
    await nextTick();
    scrollToBottom(true);
  } catch (e: any) {
    showToast(String(e?.message || e));
  }
}

const replyTo = ref<string | null>(null);
const replyPreview = computed(() => {
  const src = (current.value?.messages || []).find((x) => x.id === replyTo.value);
  return src ? `${roleOf(src.from)}：${src.text.slice(0, 24)}` : '';
});

async function onReact(m: DiscussionMessage, emoji: string) {
  if (m.reactions?.[emoji]?.includes('user')) { showToast('已经回应过了'); return; }
  try { await react(m.id, emoji); } catch (e: any) { showToast(String(e?.message || e)); }
}

// ---------- 长按气泡动作面板 ----------
const msgSheet = reactive({ show: false, msg: null as DiscussionMessage | null });
let lpTimer: ReturnType<typeof setTimeout> | null = null;
/** M10-A 长按容差：手指微动 <10px 不取消（此前 1px 移动就 cancel，长按几乎无法触发） */
let lpStartPos: { x: number; y: number } | null = null;
function lpStart(e: TouchEvent, m: DiscussionMessage) {
  const t = e.touches?.[0];
  lpStartPos = t ? { x: t.clientX, y: t.clientY } : null;
  lpTimer = setTimeout(() => {
    msgSheet.msg = m;
    msgSheet.show = true;
  }, 500);
}
function lpMove(e: TouchEvent) {
  if (!lpStartPos || !lpTimer) return;
  const t = e.touches?.[0];
  if (!t) return;
  if (Math.abs(t.clientX - lpStartPos.x) > 10 || Math.abs(t.clientY - lpStartPos.y) > 10) lpCancel();
}
function lpCancel() {
  if (lpTimer) { clearTimeout(lpTimer); lpTimer = null; }
}
/** Vant action-sheet 的 select 事件参数是 action 对象（含 name），不是字符串 */
function msgSheetSelect(action: any) {
  const name = String(action?.name || '');
  const m = msgSheet.msg;
  msgSheet.show = false;
  if (!m || !name) return;
  if (name === 'reply') {
    replyTo.value = m.id;
  } else if (name === 'copy') {
    void copyText(m.text).then((ok) => showToast(ok ? '已复制' : '复制失败（浏览器限制）'));
  } else if (name.startsWith('react:')) {
    void onReact(m, name.slice(6));
  }
}
const msgActions = computed(() => {
  const m = msgSheet.msg;
  return [
    { name: 'reply', text: '↩ 引用回复' },
    { name: 'react:👍', text: m?.reactions?.['👍'] ? '👍 已回应' : '👍 同意' },
    { name: 'react:✅', text: m?.reactions?.['✅'] ? '✅ 已回应' : '✅ 收到/已解决' },
    { name: 'react:👀', text: m?.reactions?.['👀'] ? '👀 已回应' : '👀 在看' },
    { name: 'copy', text: '⧉ 复制' },
  ];
});

// ---------- @点名 ----------
const mentionSheet = ref(false);
const mentionActions = computed(() => members.value.map((m) => ({ name: m, text: `@${m}（${roleOf(m)}）` })));
function pickMention(action: any) {
  const name = String(action?.name || '');
  mentionSheet.value = false;
  if (!name) return;
  draft.value = (draft.value + (draft.value && !draft.value.endsWith(' ') ? ' ' : '') + `@${name} `).slice(0, 4000);
}

// ---------- 成员资料 ----------
const memberSheet = ref(false);

// ---------- 导航右侧操作（popover） ----------
const showOps = ref(false);
const opsActions = computed(() => {
  const list: { text: string }[] = [];
  list.push(busy.value ? { text: '⏹ 打断并停止' } : { text: '▶ 让成员继续' });
  list.push(current.value?.mode === 'auto' ? { text: '🔁 切到手动模式' } : { text: '🔁 切到自动模式' });
  list.push({ text: current.value?.scheme ? `📄 查看方案 v${current.value.scheme_version}` : '📄 生成方案' });
  list.push({ text: converted.value ? '🚀 查看开发任务' : '🚀 转为项目开发' });
  list.push({ text: `💡 沉淀经验${experiences.value.length ? ` (${experiences.value.length})` : ''}` });
  list.push({ text: '👥 群成员' });
  return list;
});
async function onOpsSelect(_action: any, { index }: { index: number }) {
  showOps.value = false;
  const list: { text: string }[] = opsActions.value;
  const label = list[index]?.text || '';
  try {
    if (label.includes('打断并停止')) await stop();
    else if (label.includes('让成员继续')) await round();
    else if (label.includes('切到手动')) await setMode('manual');
    else if (label.includes('切到自动')) await setMode('auto');
    else if (label.includes('生成方案')) {
      genLoading.value = true;
      await generateScheme();
      genLoading.value = false;
      showScheme.value = true;
    } else if (label.includes('查看方案')) showScheme.value = true;
    else if (label.includes('查看开发任务')) router.push(`/task/${current.value!.task_id}`);
    else if (label.includes('转为项目开发')) await openConvert();
    else if (label.includes('沉淀经验')) showExp.value = true;
    else if (label.includes('群成员')) memberSheet.value = true;
  } catch (e: any) {
    showToast(String(e?.message || e));
  }
}

// ---------- 方案弹层 ----------
const showScheme = ref(false);
const genLoading = ref(false);
const schemeEditing = ref(false);
const schemeBuffer = ref('');
function startEdit() {
  schemeBuffer.value = current.value?.scheme || '';
  schemeEditing.value = true;
}
async function saveEdit() {
  try {
    await saveScheme(schemeBuffer.value.trim());
    schemeEditing.value = false;
    showToast('方案已保存为新版本');
  } catch (e: any) {
    showToast(String(e?.message || e));
  }
}

// ---------- 转项目弹层 ----------
const showConvert = ref(false);
const showCvProject = ref(false);
const showCvDir = ref(false);
const converting = ref(false);
const projects = ref<ProjectSummary[]>([]);
const cv = ref({ target: 'new' as 'new' | 'existing', name: '', workspace: '', scaffold: true, project_id: '', auto_run: false });
async function openConvert() {
  const bound = current.value?.project_id || '';
  cv.value = { target: bound ? 'existing' : 'new', name: current.value?.title || '', workspace: '', scaffold: true, project_id: bound, auto_run: false };
  try { projects.value = (await api.listProjects()).projects || []; } catch { /* ignore */ }
  if (!bound) {
    try {
      const r = await api.projectsRoot();
      const slug = (current.value?.title || '').trim().replace(/[\\/:*?"<>|\s]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'project';
      cv.value.workspace = `${(r.root || '').replace(/[\\/]$/, '')}\\${slug}`;
    } catch { /* 拿不到就手填 */ }
  }
  showConvert.value = true;
}
async function doConvert() {
  if (cv.value.target === 'new' && !cv.value.workspace.trim()) { showToast('填写工作区绝对路径'); return; }
  if (cv.value.target === 'existing' && !cv.value.project_id) { showToast('选择要挂入的项目'); return; }
  converting.value = true;
  try {
    const res = await convert({
      target: cv.value.target,
      name: cv.value.name.trim() || undefined,
      workspace: cv.value.workspace.trim() || undefined,
      scaffold: cv.value.scaffold,
      project_id: cv.value.project_id || undefined,
      auto_run: cv.value.auto_run,
    });
    showConvert.value = false;
    showToast('已转项目开发');
    router.push(`/task/${res.task_id}`);
  } catch (e: any) {
    showToast(String(e?.message || e));
  } finally {
    converting.value = false;
  }
}

// ---------- 沉淀经验弹层 ----------
const showExp = ref(false);
</script>

<template>
  <div class="disc-detail">
    <van-nav-bar left-arrow fixed placeholder @click-left="router.back()">
      <template #title>
        <div class="nav-title">{{ current?.title || '群组讨论' }}</div>
        <div class="nav-sub">{{ current ? `${members.length} 人群聊 · ${current.scheme ? `方案 v${current.scheme_version}` : (current.project_id ? '已绑定项目，可动手' : '未绑定项目')} · ${current.mode === 'auto' ? '自动' : '手动'}` : '' }}</div>
      </template>
      <template #right>
        <span class="nav-avs">
          <AgentAvatar v-for="m in members.slice(0, 4)" :key="m" :name="m" :size="22" class="nav-av" :title="roleOf(m)" @click="memberSheet = true" />
        </span>
        <van-popover v-model:show="showOps" :actions="opsActions" placement="bottom-end" @select="onOpsSelect">
          <template #reference><van-icon name="ellipsis" class="nav-op" /></template>
        </van-popover>
      </template>
    </van-nav-bar>

    <div ref="wrapEl" class="stream" @scroll="onScroll">
      <div v-if="!current" class="center-tip">加载中…</div>
      <div v-else-if="!rows.length" class="center-tip">还没有聊天内容<br />发一条消息——成员谁有话说谁上</div>

      <template v-for="(row, i) in rows" :key="row.type === 'time' ? `t${i}${row.label}` : row.type === 'sys' || row.type === 'tool' ? `${row.type}${row.m.id}` : row.m.id">
        <div v-if="row.type === 'time'" class="time-divider">{{ row.label }}</div>

        <div v-else-if="row.type === 'sys'" class="sys-row">
          <!-- M5.2 ③：任务 ask_user 提问卡片——可在群里直接回答 -->
          <div v-if="row.m.kind === 'card' && row.m.meta?.bridge_ask" class="sys-card ask-card">
            <div class="ask-q">{{ row.m.text }}</div>
            <div v-if="!answeredAskIds.has(String(row.m.meta.bridge_ask.ask_id))" class="ask-row">
              <input
                v-model="askDrafts[String(row.m.meta.bridge_ask.ask_id)]"
                class="ask-input"
                placeholder="在群里直接回答，agent 将立即继续…"
                @keydown.enter="sendAskAnswer(row.m.meta.bridge_ask)"
              />
              <van-button size="small" type="primary" :loading="answeringAsk === String(row.m.meta.bridge_ask.ask_id)" @click="sendAskAnswer(row.m.meta.bridge_ask)">回答</van-button>
            </div>
            <div v-else class="ask-done">✓ 已回答，agent 继续执行中</div>
          </div>
          <div v-else-if="row.m.kind === 'card'" class="sys-card">{{ row.m.text }}</div>
          <span v-else-if="row.m.kind === 'notice'" class="sys-notice">{{ row.m.text }}</span>
          <span v-else class="sys-text">{{ row.m.text }}</span>
        </div>

        <div v-else-if="row.type === 'tool'" class="tool-row">
          <span class="tool-text">{{ row.m.text }}</span>
        </div>

        <div v-else class="row" :class="[row.side, { grouped: !row.head }]">
          <div v-if="row.side === 'them'" class="av-slot">
            <AgentAvatar v-if="row.head" :name="row.m.from" :size="32" @click="memberSheet = true" />
          </div>
          <div class="col" :class="row.side === 'me' ? 'col-me' : 'col-them'">
            <div v-if="row.head && row.side === 'them'" class="who">
              <span class="who-role" :style="{ color: row.side === 'them' ? agentColor(row.m.from) : undefined }">{{ roleOf(row.m.from) }}</span>
              <span v-if="row.m.model" class="who-model mono">{{ row.m.model }}</span>
              <span v-if="row.m.needs_user" class="ask-tag" :class="{ answered: row.answered }">{{ row.answered ? '已回复' : '待你拍板' }}</span>
            </div>
            <div
              class="bubble"
              :class="{ ask: row.m.needs_user, answered: row.m.needs_user && row.answered, 'me-b': row.side === 'me', 'them-b': row.side === 'them' }"
              @touchstart="lpStart($event, row.m)"
              @touchend="lpCancel"
              @touchmove="lpMove"
              @contextmenu.prevent="lpCancel(); msgSheet.msg = row.m; msgSheet.show = true"
            >
              <div v-if="row.quote" class="quote-bar">↩ {{ row.quote.who }}：{{ row.quote.text }}</div>
              <div class="b-text" v-html="md(row.m.text)"></div>
            </div>
            <span v-if="row.tail" class="tail-ts">{{ fmtTime(row.m.ts) }}</span>
            <div v-if="hasReactions(row.m)" class="reactions">
              <button
                v-for="(users, emo) in row.m.reactions"
                :key="emo"
                class="react-chip"
                :class="{ mine: users.includes('user') }"
                @click="onReact(row.m, String(emo))"
              >{{ emo }} {{ users.length }}</button>
            </div>
          </div>
        </div>
      </template>

      <!-- 流式发言气泡 -->
      <div v-for="(s, sid) in streams" :key="sid" class="row them">
        <div class="av-slot"><AgentAvatar :name="s.agent" :size="32" /></div>
        <div class="col col-them">
          <div class="who"><span class="who-role" :style="{ color: agentColor(s.agent) }">{{ roleOf(s.agent) }}</span></div>
          <div class="bubble them-b"><span class="b-text">{{ s.text }}</span><span class="caret"></span></div>
        </div>
      </div>

      <div v-if="thinking === 'router' && !anyStreaming" class="router-hint">
        <span class="dot"></span><span class="dot"></span><span class="dot"></span> 正在看消息，决定谁来回复…
      </div>
      <div v-else-if="thinking && thinking !== 'router' && !agentStreaming(thinking)" class="row them">
        <div class="av-slot"><AgentAvatar :name="thinking" :size="32" active /></div>
        <div class="col col-them">
          <div class="bubble them-b typing-b">
            <span class="dot"></span><span class="dot"></span><span class="dot"></span>
            <span class="typing-label">{{ activity === 'tool' ? '正在动手执行…' : activity === 'tool_followup' ? '正在看执行结果…' : '正在输入…' }}</span>
          </div>
        </div>
      </div>
    </div>

    <div v-if="pendingUser" class="pending-bar">有成员需要你拍板，回复一条消息即可继续</div>

    <!-- 底部输入：微信式常驻一条，操作收进右上菜单 -->
    <div class="input-zone">
      <div v-if="replyTo" class="reply-bar">
        <span>↩ 回复「{{ replyPreview }}」</span>
        <span class="rb-x" @click="replyTo = null">×</span>
      </div>
      <div class="input-row">
        <span class="at-btn" @click="mentionSheet = true">＠</span>
        <van-field
          v-model="draft"
          type="textarea"
          rows="1"
          autosize
          max-length="4000"
          :placeholder="busy ? '成员在忙，插话即刻受理' : '说点什么…（@成员点名，或让它动手）'"
          class="input-field"
          @keydown.enter.exact.prevent="sendNow"
        />
        <van-button class="send-btn" round type="primary" size="small" :disabled="!draft.trim() || converted" @click="sendNow">
          {{ busy ? '插话' : '发送' }}
        </van-button>
      </div>
    </div>

    <!-- 长按/右键动作 -->
    <van-action-sheet v-model:show="msgSheet.show" :actions="msgActions" title="消息操作" close-on-click-action cancel-text="取消" @select="msgSheetSelect" />

    <!-- @点名选择 -->
    <van-action-sheet v-model:show="mentionSheet" :actions="mentionActions" title="点名成员（只唤被点名者）" cancel-text="取消" close-on-click-action @select="pickMention" />

    <!-- 群成员 -->
    <van-popup v-model:show="memberSheet" position="bottom" round :style="{ maxHeight: '60%' }">
      <div class="sheet">
        <div class="sheet-head"><span class="sheet-title">群成员</span><span class="sheet-op" @click="memberSheet = false">关闭</span></div>
        <div v-for="m in members" :key="m" class="member-row">
          <AgentAvatar :name="m" :size="36" />
          <div class="member-info">
            <div class="member-role" :style="{ color: agentColor(m) }">{{ roleOf(m) }}</div>
            <div class="member-id">{{ m }}</div>
          </div>
        </div>
      </div>
    </van-popup>

    <!-- 方案弹层 -->
    <van-popup v-model:show="showScheme" position="bottom" round :style="{ height: '80%' }">
      <div class="sheet">
        <div class="sheet-head">
          <span class="sheet-title">项目规划方案 · v{{ current?.scheme_version || 0 }}</span>
          <span class="sheet-op" @click="showScheme = false">关闭</span>
        </div>
        <div v-if="!current?.scheme" class="center-tip">方案尚未生成——点右上菜单「生成方案」</div>
        <template v-else>
          <div v-if="!schemeEditing" class="scheme-md" v-html="md(current.scheme)"></div>
          <van-field v-else v-model="schemeBuffer" type="textarea" rows="18" autosize />
          <div class="sheet-ops">
            <template v-if="schemeEditing">
              <van-button size="small" @click="schemeEditing = false">取消</van-button>
              <van-button size="small" type="primary" @click="saveEdit">保存（版本 +1）</van-button>
            </template>
            <template v-else>
              <van-button size="small" @click="startEdit">人工编辑</van-button>
              <van-button size="small" type="primary" :loading="genLoading" @click="generateScheme().then(() => showToast('方案已重新生成'))">重新生成</van-button>
            </template>
          </div>
        </template>
      </div>
    </van-popup>

    <!-- 转项目弹层 -->
    <van-popup v-model:show="showConvert" position="bottom" round :style="{ maxHeight: '80%' }">
      <div class="sheet">
        <div class="sheet-head"><span class="sheet-title">方案转项目开发</span><span class="sheet-op" @click="showConvert = false">关闭</span></div>
        <van-radio-group v-model="cv.target" direction="horizontal" class="cv-target">
          <van-radio name="new">新建项目</van-radio>
          <van-radio name="existing">挂入已有项目</van-radio>
        </van-radio-group>
        <template v-if="cv.target === 'new'">
          <van-field v-model="cv.name" label="项目名称" placeholder="例如：会员系统" />
          <van-field v-model="cv.workspace" label="工作区" placeholder="绝对路径，或点「选择」浏览">
            <template #button><span class="pick-dir" @click="showCvDir = true">选择</span></template>
          </van-field>
          <van-field label="初始化"><template #input><van-checkbox v-model="cv.scaffold">标准脚手架（目录+文档+git）</van-checkbox></template></van-field>
        </template>
        <van-field v-else label="项目" readonly is-link :model-value="projects.find(p => p.id === cv.project_id)?.name || '选择项目'" @click="showCvProject = true" />
        <van-field label="执行"><template #input><van-checkbox v-model="cv.auto_run">规划完成后直接进队列执行</van-checkbox></template></van-field>
        <div class="cv-note">讨论即澄清：任务不再重复需求澄清；方案、待定事项与沉淀经验随任务交给执行团队。</div>
        <div class="sheet-ops"><van-button block round type="primary" :loading="converting" @click="doConvert">转为项目开发</van-button></div>
      </div>
    </van-popup>
    <van-popup v-model:show="showCvProject" position="bottom" round>
      <van-picker
        :columns="projects.map((p) => ({ text: p.name, value: p.id }))"
        @confirm="({ selectedValues }) => { cv.project_id = String(selectedValues[0] || ''); showCvProject = false; }"
        @cancel="showCvProject = false"
      />
    </van-popup>
    <DirPicker v-model:show="showCvDir" title="选择工作区目录" @pick="cv.workspace = $event" />

    <!-- 沉淀经验弹层 -->
    <van-popup v-model:show="showExp" position="bottom" round :style="{ maxHeight: '70%' }">
      <div class="sheet">
        <div class="sheet-head"><span class="sheet-title">本讨论沉淀经验（{{ experiences.length }}）</span><span class="sheet-op" @click="showExp = false">关闭</span></div>
        <van-empty v-if="!experiences.length" image="search" description="成员发言中的经验/踩坑/决策理由会自动沉淀到这里与知识库" />
        <div v-for="e in experiences" :key="e.id" class="exp-item">
          <div class="exp-title">{{ e.title }}</div>
          <div class="exp-src">来源 {{ e.source }} · {{ (e.updated_at || '').slice(0, 10) }}</div>
          <div class="exp-body">{{ e.content }}</div>
        </div>
      </div>
    </van-popup>
  </div>
</template>

<style scoped>
/* 用 100%（根容器为 100dvh）而非 100vh：地址栏展开时遮挡历史教训 */
.disc-detail { display: flex; flex-direction: column; height: 100%; background: var(--bg); }
.nav-title { font-size: 15px; font-weight: 700; max-width: 56vw; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.nav-sub { font-size: 10px; color: var(--text-3); font-weight: 400; margin-top: 1px; }
.nav-op { font-size: 20px; color: var(--text); margin-left: 10px; }
.nav-avs { display: inline-flex; }
.nav-av { margin-left: -6px; border: 1.5px solid #fff; border-radius: 6px; }
.nav-av:first-child { margin-left: 0; }

.stream { flex: 1; overflow-y: auto; padding: 10px 10px 4px; display: flex; flex-direction: column; gap: 2px; }
.center-tip { text-align: center; color: var(--text-3); font-size: 12px; padding: 40px 20px; line-height: 1.8; }
.time-divider { text-align: center; font-size: 10px; color: #b8bbbd; margin: 10px 0 4px; }

.sys-row { display: flex; justify-content: center; margin: 4px 0; }
.sys-text { font-size: 10px; color: var(--text-3); background: rgba(0, 0, 0, 0.05); border-radius: 10px; padding: 3px 10px; max-width: 88%; text-align: center; }
.sys-notice { font-size: 10px; color: #b0b2b4; font-style: italic; text-align: center; max-width: 88%; }
.sys-card { font-size: 12px; color: var(--text); background: var(--panel); border: 1px solid var(--border); border-radius: 12px; padding: 9px 14px; max-width: 86%; text-align: center; box-shadow: 0 1px 4px rgba(0, 0, 0, 0.05); }
/* M5.2 ③ ask 提问卡片 */
.ask-card { text-align: left; max-width: 90%; border-color: var(--yellow); }
.ask-q { margin-bottom: 8px; white-space: pre-wrap; }
.ask-row { display: flex; gap: 6px; align-items: center; }
.ask-input { flex: 1; min-width: 0; background: var(--panel-2); border: 1px solid var(--border); border-radius: 4px; font-size: 13px; padding: 6px 8px; outline: none; }
.ask-done { font-size: 11px; color: var(--green); margin-top: 4px; }

.tool-row { display: flex; padding-left: 40px; margin: 1px 0; }
.tool-text { font-size: 10px; color: #8a8f94; background: var(--border); border-radius: 6px; padding: 2px 8px; max-width: 80%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

.row { display: flex; gap: 7px; }
.row.me { justify-content: flex-end; }
.row:not(.grouped) { margin-top: 8px; }
.av-slot { width: 32px; flex-shrink: 0; }
.col { display: flex; flex-direction: column; max-width: 78%; min-width: 0; }
.col-them { align-items: flex-start; }
.col-me { align-items: flex-end; }
.who { display: flex; align-items: baseline; gap: 6px; margin: 0 2px 3px; }
.who-role { font-size: 12px; font-weight: 600; color: var(--text-2); }
.who-model { font-size: 9px; color: var(--text-3); background: var(--panel-2); border: 1px solid var(--border); border-radius: 3px; padding: 0 4px; max-width: 120px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ask-tag { font-size: 9px; color: #fff; background: var(--yellow); border-radius: 4px; padding: 1px 5px; }
.ask-tag.answered { background: #c8c9cc; }

.bubble { padding: 9px 12px; border-radius: 15px; font-size: 15px; line-height: 1.55; word-break: break-word; position: relative; }
.me-b { background: var(--bubble-me); color: #0b2e13; border-top-right-radius: 5px; }
.them-b { background: var(--panel); border: 1px solid var(--border); border-top-left-radius: 5px; color: var(--text); }
.them-b.ask { border: 1.5px solid var(--yellow); }
.them-b.answered { border: 1px solid var(--border); }
/* M10-A：气泡文本允许原生长按选择/复制 */
.bubble .b-text { user-select: text; -webkit-user-select: text; }
.b-text :deep(.mention) { color: var(--accent); background: var(--accent-soft); border-radius: 3px; padding: 0 3px; font-weight: 600; }
.b-text :deep(code) { font-size: 12px; background: rgba(125, 125, 125, 0.12); border-radius: 3px; padding: 0 3px; }
.b-text :deep(p) { margin: 0 0 4px; }
.b-text :deep(p:last-child) { margin-bottom: 0; }
.b-text :deep(ul), .b-text :deep(ol) { margin: 2px 0; padding-left: 16px; }
.quote-bar { font-size: 11px; opacity: 0.7; border-left: 2px solid currentColor; padding: 1px 0 1px 6px; margin-bottom: 4px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 100%; }
.tail-ts { font-size: 9px; color: #b8bbbd; margin: 2px 3px 0; }

.reactions { display: flex; gap: 4px; margin: 3px 2px 0; flex-wrap: wrap; }
.react-chip { font-size: 12px; background: var(--panel); border: 1px solid var(--border); border-radius: 10px; padding: 1px 8px; color: var(--text); }
.react-chip.mine { border-color: var(--accent); background: var(--accent-soft); }

.router-hint { align-self: center; font-size: 11px; color: var(--text-3); display: flex; align-items: center; gap: 4px; margin: 8px 0; }
.typing-b { display: flex; align-items: center; gap: 3px; }
.dot { width: 5px; height: 5px; border-radius: 50%; background: #c8c9cc; animation: bob 1.2s infinite; }
.dot:nth-child(2) { animation-delay: 0.15s; }
.dot:nth-child(3) { animation-delay: 0.3s; }
@keyframes bob { 0%, 60%, 100% { transform: translateY(0); opacity: 0.4; } 30% { transform: translateY(-4px); opacity: 1; } }
.typing-label { font-size: 10px; color: var(--text-3); margin-left: 4px; }
.caret { display: inline-block; width: 2px; height: 14px; background: var(--accent); margin-left: 2px; vertical-align: text-bottom; animation: blink 0.9s step-end infinite; }
@keyframes blink { 50% { opacity: 0; } }

.pending-bar { margin: 0 10px 4px; font-size: 11px; color: var(--yellow); border: 1px dashed var(--yellow); border-radius: 8px; padding: 4px 8px; background: var(--panel); }

.input-zone { background: var(--panel-2); border-top: 1px solid var(--border); padding: 6px 8px calc(8px + env(safe-area-inset-bottom)); }
.reply-bar { display: flex; align-items: center; justify-content: space-between; gap: 8px; font-size: 11px; color: var(--text-3); background: var(--panel); border: 1px solid var(--border); border-radius: 8px; padding: 4px 8px; margin-bottom: 5px; }
.rb-x { font-size: 16px; padding: 0 6px; color: #c8c9cc; }
.input-row { display: flex; gap: 7px; align-items: flex-end; }
.at-btn { width: 34px; height: 34px; border-radius: 50%; background: var(--panel); border: 1px solid var(--border); color: var(--accent); font-size: 18px; display: flex; align-items: center; justify-content: center; flex-shrink: 0; }
.input-field { flex: 1; background: var(--panel); border-radius: 18px; padding: 4px 12px; }
.input-field :deep(.van-field__body) { padding: 2px 0; }
.send-btn { flex-shrink: 0; height: 34px; }

.member-row { display: flex; align-items: center; gap: 10px; padding: 9px 0; border-bottom: 1px solid var(--bg); }
.member-role { font-size: 14px; font-weight: 600; }
.member-id { font-size: 11px; color: var(--text-3); }

.sheet { padding: 14px 16px calc(20px + env(safe-area-inset-bottom)); overflow-y: auto; height: 100%; }
.pick-dir { font-size: 13px; color: var(--accent); padding: 2px 8px; border: 1px solid #d4e6ff; border-radius: 4px; background: #f4f8ff; }
.sheet-head { display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px; }
.sheet-title { font-size: 15px; font-weight: 700; }
.sheet-op { font-size: 12px; color: var(--accent); }
.sheet-ops { display: flex; gap: 8px; justify-content: flex-end; margin-top: 14px; }
.scheme-md { font-size: 13px; line-height: 1.65; color: var(--text); }
.scheme-md :deep(h1) { font-size: 16px; margin: 4px 0 8px; }
.scheme-md :deep(h2) { font-size: 14px; margin: 12px 0 4px; border-bottom: 1px solid var(--border); padding-bottom: 3px; }
.cv-target { margin-bottom: 8px; }
.cv-note { font-size: 11px; color: var(--text-3); margin-top: 10px; line-height: 1.6; }
.exp-item { padding: 8px 0; border-bottom: 1px solid var(--bg); }
.exp-title { font-size: 13px; font-weight: 600; }
.exp-src { font-size: 10px; color: var(--text-3); margin: 2px 0; }
.exp-body { font-size: 12px; color: var(--text-2); white-space: pre-wrap; }
</style>
