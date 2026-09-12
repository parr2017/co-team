<template>
  <div class="disc-chat">
    <div ref="wrapEl" class="stream" @scroll="onScroll">
      <div v-if="!rows.length" class="empty">
        还没有聊天内容——发一条消息试试。成员会像真实同事一样：谁有话说谁上，能动手就直接动手。
      </div>

      <template v-for="(row, i) in rows" :key="rowKey(row, i)">
        <div v-if="row.type === 'time'" class="time-divider">{{ row.label }}</div>

        <!-- 未读分隔线（滚离底部期间到达的新消息起点） -->
        <div v-else-if="row.type === 'unread'" class="unread-divider"><span>{{ newBelow > 0 ? `${newBelow} 条新消息` : '新消息' }}</span></div>

        <!-- 系统：普通小灰条 / notice 更淡 / card 居中卡片 -->
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
              <el-button size="small" type="primary" :loading="answeringAsk === String(row.m.meta.bridge_ask.ask_id)" @click="sendAskAnswer(row.m.meta.bridge_ask)">回答</el-button>
            </div>
            <div v-else class="ask-done">✓ 已回答，agent 继续执行中</div>
          </div>
          <div v-else-if="row.m.kind === 'card'" class="sys-card">{{ row.m.text }}</div>
          <span v-else-if="row.m.kind === 'notice'" class="sys-notice">{{ row.m.text }}</span>
          <span v-else class="sys-text">{{ row.m.text }}</span>
        </div>

        <!-- 工具活动行：🔧 灰条（对齐气泡列，不抢对话视觉） -->
        <div v-else-if="row.type === 'tool'" class="tool-row">
          <span class="tool-text mono">{{ row.m.text }}</span>
        </div>

        <!-- 聊天气泡（用户右 / agent 左；同发送者连续消息分组，仅首条显示头像与名字） -->
        <div v-else class="row" :class="[row.side, { grouped: !row.head }]">
          <!-- 群聊惯例：自己的消息不带头像（微信式） -->
          <div v-if="row.side === 'them'" class="av-slot">
            <AgentAvatar
              v-if="row.head"
              :name="row.m.from"
              :size="34"
              class="av-click"
              :title="roleOf(row.m.from) + ' · ' + row.m.from"
              @click="emit('member-info', row.m.from)"
            />
          </div>
          <div class="col" :class="row.side === 'me' ? 'col-me' : 'col-them'">
            <div v-if="row.head && row.side === 'them'" class="who">
              <span class="who-role" :style="{ color: row.side === 'them' ? agentColor(row.m.from) : undefined }">{{ roleOf(row.m.from) }}</span>
              <span class="who-id mono">{{ row.m.from }}</span>
              <span v-if="row.m.model" class="who-model mono" :title="'模型：' + row.m.model">{{ row.m.model }}</span>
              <span v-if="row.m.needs_user" class="ask-tag" :class="{ answered: row.answered }">{{ row.answered ? '@你 已回复' : '@你 待拍板' }}</span>
            </div>
            <div class="bubble" :class="{ ask: row.m.needs_user, answered: row.m.needs_user && row.answered, 'me-b': row.side === 'me', 'them-b': row.side === 'them' }">
              <div v-if="row.quote" class="quote-bar mono" :title="row.quote.text">↩ {{ row.quote.who }}：{{ row.quote.text }}</div>
              <div class="b-text md" v-html="md(row.m.text)"></div>
              <span class="hover-ts mono">{{ fmtHM(row.m.ts) }}</span>
            </div>
            <span v-if="row.tail" class="tail-ts mono">{{ fmtHM(row.m.ts) }}</span>
            <!-- emoji 回应聚合 -->
            <div v-if="hasReactions(row.m)" class="reactions">
              <button
                v-for="(users, emo) in row.m.reactions"
                :key="emo"
                class="react-chip"
                :class="{ mine: users.includes('user') }"
                @click="onReact(row.m, String(emo))"
              >{{ emo }} <span>{{ users.length }}</span></button>
            </div>
            <!-- 悬停动作条 -->
            <div class="hover-actions" :class="row.side === 'me' ? 'ha-left' : 'ha-right'">
              <button class="ha-btn" title="回应 👍" @click="onReact(row.m, '👍')">👍</button>
              <button class="ha-btn" title="引用回复" @click="startReply(row.m)">↩</button>
              <button class="ha-btn" title="复制" @click="copyText(row.m.text)">⧉</button>
            </div>
          </div>
        </div>
      </template>

      <!-- 流式发言中的气泡（未定稿的实时内容） -->
      <div v-for="(s, sid) in streams" :key="sid" class="row them streaming">
        <div class="av-slot"><AgentAvatar :name="s.agent" :size="34" /></div>
        <div class="col col-them">
          <div class="who"><span class="who-role" :style="{ color: agentColor(s.agent) }">{{ roleOf(s.agent) }}</span><span class="who-id mono">{{ s.agent }}</span></div>
          <div class="bubble them-b"><span class="b-text">{{ s.text }}</span><span class="caret"></span></div>
        </div>
      </div>

      <!-- 路由器决策中（"谁来回"的调度感，代替旧的全员排队） -->
      <div v-if="thinking === 'router' && !anyStreaming" class="router-hint mono">
        <span class="dot-t"></span><span class="dot-t"></span><span class="dot-t"></span> 正在看消息，决定谁来回复…
      </div>

      <!-- 成员打字/动手指示器（该成员已有流式气泡时不重复显示） -->
      <div v-else-if="thinking && thinking !== 'router' && !agentStreaming(thinking)" class="row them">
        <div class="av-slot"><AgentAvatar :name="thinking" :size="34" active /></div>
        <div class="col col-them">
          <div class="bubble them-b typing-b">
            <span class="dot-t"></span><span class="dot-t"></span><span class="dot-t"></span>
            <span class="typing-label">{{ activity === 'tool' ? '正在动手执行…' : activity === 'tool_followup' ? '正在看执行结果…' : '正在输入…' }}</span>
          </div>
        </div>
      </div>
    </div>

    <!-- 新消息胶囊（滚离底部时出现） -->
    <transition name="fade">
      <button v-if="!stick && newBelow > 0" class="new-pill mono" @click="scrollToBottom(true)">↓ {{ newBelow }} 条新消息</button>
    </transition>

    <div v-if="pendingUser" class="pending-bar">有成员提出了需要你拍板的问题，回复一条消息即可继续</div>

    <div class="input-zone">
      <div v-if="replyTo" class="reply-bar mono">
        <span>↩ 回复「{{ replyPreview }}」</span>
        <button class="rb-x" @click="replyTo = null">×</button>
      </div>
      <div class="chips-row" v-if="members.length">
        <span class="chip-label mono">@点名（只唤被点名者）：</span>
        <button v-for="m in members" :key="m" class="mention-chip mono" :disabled="converted" @click="insertMention(m)">@{{ m }}</button>
      </div>
      <el-input
        ref="inputEl"
        v-model="draft"
        type="textarea"
        :rows="2"
        resize="none"
        :disabled="converted"
        :placeholder="busy ? '成员正在处理——插话会即刻受理，当前发言告一段落后优先回应你' : '像群里聊天一样说：可 @成员、可让它动手（如：@launcher 把服务跑起来）、可打断'"
        @keydown.enter.exact.prevent="sendNow"
      />
      <div class="op-row">
        <el-radio-group v-model="mode" size="small" :disabled="converted" @change="onModeChange">
          <el-radio-button value="manual">手动</el-radio-button>
          <el-radio-button value="auto">自动</el-radio-button>
        </el-radio-group>
        <span class="mode-hint mono">{{ mode === 'auto' ? '自动：一条消息驱动多轮，直到成员收敛或你插话' : '手动：你一句它一句，插话即刻受理' }}</span>
        <div class="ops">
          <el-button v-if="busy" size="small" type="warning" plain @click="stop">打断并停止</el-button>
          <el-button v-else size="small" :disabled="converted" @click="moreRound">让成员继续</el-button>
          <el-button size="small" type="primary" :disabled="!draft.trim() || converted" @click="sendNow">{{ busy ? '插话' : '发送' }}</el-button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue';
import { ElMessage } from 'element-plus';
import { marked } from 'marked';
import type { DiscussionMessage } from '../api';
import { api } from '../api';
import { useDiscussion } from '../composables/useDiscussion';
import { agentColor } from '../utils/agentColor';
import AgentAvatar from './AgentAvatar.vue';

const emit = defineEmits<{ (e: 'member-info', agent: string): void }>();

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
    ElMessage.success('已回答，agent 将继续执行');
  } catch (e: any) {
    ElMessage.error(e?.message || '回答失败');
  } finally {
    answeringAsk.value = '';
  }
}

const { current, busy, thinking, activity, streams, send, react, round, stop, setMode, roles } = useDiscussion();

const members = computed(() => current.value?.members || []);
const converted = computed(() => (current.value?.status || 'discussing') === 'converted');
const pendingUser = computed(() => !!current.value?.pending_user);
const anyStreaming = computed(() => Object.keys(streams).length > 0);
const draft = ref('');
const wrapEl = ref<HTMLElement | null>(null);
const inputEl = ref<{ focus: () => void } | null>(null);
let stickToBottom = true;
const stick = ref(true);
const newBelow = ref(0);
const unreadStartId = ref<string | null>(null);
const replyTo = ref<string | null>(null);

function agentStreaming(agent: string): boolean {
  return Object.values(streams).some((s) => s.agent === agent);
}

function roleOf(name: string): string {
  if (name === 'user') return '我';
  return roles.value[name] || name;
}

// ---------- 行模型：分组 / 系统 / 工具 / 时间 / 未读 ----------
type ChatRow = { type: 'chat'; m: DiscussionMessage; side: 'me' | 'them'; head: boolean; tail: boolean; answered?: boolean; quote?: { who: string; text: string } };
type Row =
  | { type: 'time'; label: string }
  | { type: 'unread' }
  | { type: 'sys'; m: DiscussionMessage }
  | { type: 'tool'; m: DiscussionMessage }
  | ChatRow;

const GROUP_GAP_MS = 3 * 60 * 1000;
const TIME_GAP_MS = 10 * 60 * 1000;

const rows = computed<Row[]>(() => {
  const msgs = current.value?.messages || [];
  const lastUserIdx = msgs.map((m) => m.from).lastIndexOf('user');
  const byId = new Map(msgs.map((m) => [m.id, m]));
  const tsOf = (m: DiscussionMessage) => (m.ts ? new Date(m.ts.replace(' ', 'T')).getTime() : 0);

  const out: Row[] = [];
  let lastTs = 0;
  let prevChat: ChatRow | null = null;
  let pendingUnread = !!unreadStartId.value && msgs.some((m) => m.id === unreadStartId.value);

  for (let i = 0; i < msgs.length; i++) {
    const m = msgs[i];
    const ts = tsOf(m);
    if (ts - lastTs > TIME_GAP_MS) { out.push({ type: 'time', label: fmtFull(m.ts) }); prevChat = null; }
    lastTs = ts || lastTs;
    if (pendingUnread && m.id === unreadStartId.value) { out.push({ type: 'unread' }); pendingUnread = false; }
    if (m.from === 'system') { out.push({ type: 'sys', m }); prevChat = null; continue; }
    if (m.tool) { out.push({ type: 'tool', m }); continue; } // 工具行不打断分组节奏

    const side: 'me' | 'them' = m.from === 'user' ? 'me' : 'them';
    const head = !prevChat || prevChat.m.from !== m.from || ts - tsOf(prevChat.m) > GROUP_GAP_MS;
    const row: ChatRow = {
      type: 'chat', m, side, head, tail: false,
      answered: !!m.needs_user && lastUserIdx > i,
      quote: m.reply_to ? quoteOf(byId.get(m.reply_to)) : undefined,
    };
    if (prevChat) prevChat.tail = !head; // 上一组到此为止 → 上一条是组尾
    out.push(row);
    prevChat = row;
  }
  if (prevChat) prevChat.tail = true;
  return out;
});

function quoteOf(src?: DiscussionMessage) {
  if (!src) return undefined;
  return { who: src.from === 'user' ? '我' : roleOf(src.from), text: src.text.slice(0, 60) };
}

function rowKey(row: Row, i: number): string {
  if (row.type === 'time') return `t${i}${row.label}`;
  if (row.type === 'unread') return 'unread';
  return `${row.type}:${row.m.id}`;
}

function hasReactions(m: DiscussionMessage): boolean {
  return !!m.reactions && Object.keys(m.reactions).length > 0;
}

function fmtHM(ts: string): string {
  if (!ts) return '';
  const d = new Date(ts.replace(' ', 'T'));
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function fmtFull(ts: string): string {
  if (!ts) return '';
  const d = new Date(ts.replace(' ', 'T'));
  const hm = fmtHM(ts);
  if (d.toDateString() === new Date().toDateString()) return hm;
  return `${d.getMonth() + 1}月${d.getDate()}日 ${hm}`;
}

/** escape first (XSS), then light markdown, then @token highlight */
function md(text: string): string {
  if (!text) return '';
  const escaped = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const html = String(marked.parse(escaped, { async: false, breaks: true }));
  return html.replace(/@([A-Za-z0-9_\-\u4e00-\u9fff]+)/g, '<span class="mention">@$1</span>');
}

// ---------- 交互 ----------
async function sendNow() {
  const text = draft.value.trim();
  if (!text) return;
  try {
    await send(text, replyTo.value ? { reply_to: replyTo.value } : undefined);
    draft.value = '';
    replyTo.value = null;
    await nextTick();
    scrollToBottom(true);
  } catch (e: any) {
    ElMessage.error(String(e?.message || e));
  }
}

async function moreRound() {
  await round();
}

async function onReact(m: DiscussionMessage, emoji: string) {
  if (m.reactions?.[emoji]?.includes('user')) return;
  await react(m.id, emoji).catch(() => undefined);
}

function startReply(m: DiscussionMessage) {
  replyTo.value = m.id;
  void nextTick(() => inputEl.value?.focus());
}

const replyPreview = computed(() => {
  const src = (current.value?.messages || []).find((x) => x.id === replyTo.value);
  return src ? `${roleOf(src.from)}：${src.text.slice(0, 40)}` : '';
});

function copyText(text: string) {
  void navigator.clipboard?.writeText(text).then(
    () => ElMessage.success('已复制'),
    () => undefined
  );
}

async function onModeChange(v: any) {
  await setMode(v === 'auto' ? 'auto' : 'manual');
  ElMessage.success(v === 'auto' ? '已切到自动模式：一条消息驱动多轮' : '已切到手动模式');
}

function insertMention(name: string) {
  draft.value = (draft.value + (draft.value && !draft.value.endsWith(' ') ? ' ' : '') + `@${name} `).slice(0, 4000);
  void nextTick(() => inputEl.value?.focus());
}

// ---------- 滚动 / 未读 ----------
function onScroll() {
  const el = wrapEl.value;
  if (!el) return;
  stickToBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  stick.value = stickToBottom;
  if (stickToBottom) {
    newBelow.value = 0;
    if (unreadStartId.value) {
      const msgs = current.value?.messages || [];
      const idx = msgs.findIndex((m) => m.id === unreadStartId.value);
      if (idx < 0 || msgs.length - idx <= 2) unreadStartId.value = null;
    }
  }
}

function scrollToBottom(force = false) {
  const el = wrapEl.value;
  if (!el || (!force && !stickToBottom)) return;
  el.scrollTop = el.scrollHeight;
  newBelow.value = 0;
}

watch(
  () => current.value?.messages.length ?? 0,
  (len, old) => {
    if (typeof old === 'number' && len > old && !stickToBottom) newBelow.value += len - old;
    void nextTick(() => scrollToBottom());
  }
);

watch(
  () => Object.keys(streams).length,
  () => void nextTick(() => scrollToBottom())
);

watch(() => [thinking.value, activity.value] as const, () => void nextTick(() => scrollToBottom()));

// 切换讨论：重置未读锚点（打开时最后一条之后到达的都算新）
watch(() => current.value?.id, (id) => {
  if (!id) return;
  const msgs = current.value?.messages || [];
  unreadStartId.value = msgs.length ? msgs[msgs.length - 1].id : null;
  replyTo.value = null;
  stickToBottom = true;
  void nextTick(() => scrollToBottom(true));
});
</script>

<style scoped>
.disc-chat { display: flex; flex-direction: column; height: 100%; min-height: 0; background: var(--ct-bg); position: relative; }
.stream { flex: 1; display: flex; flex-direction: column; gap: 2px; padding: 12px 10px; overflow-y: auto; }
.empty { color: var(--ct-text3); text-align: center; padding: 48px 24px; font-size: 12px; line-height: 2; }

.time-divider { text-align: center; font-size: 10px; color: var(--ct-text3); margin: 10px 0 6px; opacity: 0.85; }

.unread-divider { display: flex; align-items: center; gap: 8px; margin: 8px 0; color: #e5484d; font-size: 10px; }
.unread-divider::before, .unread-divider::after { content: ''; flex: 1; height: 1px; background: rgba(229, 72, 77, 0.35); }

/* ---------- 系统形态 ---------- */
.sys-row { display: flex; justify-content: center; margin: 4px 0; }
.sys-text { font-size: 11px; color: var(--ct-text3); background: var(--ct-panel2); border-radius: 10px; padding: 3px 12px; max-width: 85%; text-align: center; }
.sys-notice { font-size: 10px; color: var(--ct-text3); font-style: italic; opacity: 0.8; }
.sys-card { font-size: 12px; color: var(--ct-text); background: var(--ct-panel); border: 1px solid var(--ct-border2); border-radius: 10px; padding: 8px 16px; max-width: 80%; text-align: center; box-shadow: 0 1px 4px rgba(0, 0, 0, 0.04); }
/* M5.2 ③ ask 提问卡片 */
.ask-card { text-align: left; max-width: 86%; border-color: var(--ct-orange, #fa8c16); }
.ask-q { margin-bottom: 8px; white-space: pre-wrap; }
.ask-row { display: flex; gap: 6px; align-items: center; }
.ask-input { flex: 1; min-width: 0; background: var(--ct-panel2); border: 1px solid var(--ct-border); border-radius: 4px; color: var(--ct-text); font-size: 12px; padding: 5px 8px; outline: none; }
.ask-input:focus { border-color: var(--ct-accent); }
.ask-done { font-size: 11px; color: var(--ct-green); margin-top: 4px; }

/* ---------- 工具活动行 ---------- */
.tool-row { display: flex; padding-left: 44px; margin: 1px 0; }
.tool-text { font-size: 10px; color: var(--ct-text3); background: var(--ct-panel2); border-radius: 6px; padding: 2px 8px; max-width: 75%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

/* ---------- 气泡行 ---------- */
.row { display: flex; gap: 8px; position: relative; }
.row.them { justify-content: flex-start; }
.row.me { justify-content: flex-end; }
.row:not(.grouped) { margin-top: 8px; }
.av-slot { width: 34px; flex-shrink: 0; }
.av-click { cursor: pointer; }
.col { display: flex; flex-direction: column; max-width: min(72%, 620px); min-width: 0; position: relative; }
.col-them { align-items: flex-start; }
.col-me { align-items: flex-end; }

.who { display: flex; align-items: baseline; gap: 6px; margin: 0 2px 3px; }
.who-role { font-size: 12px; font-weight: 600; }
.who-id { font-size: 10px; color: var(--ct-text3); }
.who-model { font-size: 9px; color: var(--ct-text3); background: var(--ct-panel2); border: 1px solid var(--ct-border2); border-radius: 3px; padding: 0 4px; max-width: 140px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ask-tag { font-size: 10px; color: #fff; background: var(--ct-accent); border-radius: 4px; padding: 1px 6px; }
.ask-tag.answered { background: var(--ct-text3); }

.bubble { padding: 9px 12px; border-radius: 14px; font-size: 13px; position: relative; line-height: 1.65; }
.them-b { background: var(--ct-panel); border: 1px solid var(--ct-border); border-top-left-radius: 4px; }
.me-b { background: #95ec69; border-top-right-radius: 4px; color: #0b2e13; }
html.dark .me-b { background: #3eb575; color: #eafff1; }
.them-b.ask { border-color: var(--ct-accent); box-shadow: 0 0 0 1px var(--ct-accent); }
.them-b.answered { border-color: var(--ct-border); box-shadow: none; }

.hover-ts { position: absolute; top: -14px; right: 4px; font-size: 9px; color: var(--ct-text3); opacity: 0; transition: opacity 0.15s; pointer-events: none; }
.row.me .hover-ts { right: auto; left: 4px; }
.row:hover .hover-ts { opacity: 1; }
.tail-ts { font-size: 9px; color: var(--ct-text3); margin: 2px 4px 0; }

.quote-bar { font-size: 10px; opacity: 0.75; border-left: 2px solid currentColor; padding: 2px 0 2px 6px; margin-bottom: 4px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 100%; }

.reactions { display: flex; gap: 4px; margin: 3px 2px 0; flex-wrap: wrap; }
.react-chip { font-size: 11px; background: var(--ct-panel2); border: 1px solid var(--ct-border); border-radius: 10px; padding: 0 7px; cursor: pointer; color: var(--ct-text); }
.react-chip.mine { border-color: var(--ct-accent); background: var(--ct-panel); }

.hover-actions { position: absolute; top: 14px; display: none; gap: 2px; z-index: 2; }
.ha-right { left: calc(100% + 8px); }
.ha-left { right: calc(100% + 8px); }
.row:hover .hover-actions { display: flex; }
.row.streaming .hover-actions { display: none !important; }
.ha-btn { border: 1px solid var(--ct-border); background: var(--ct-panel); border-radius: 6px; font-size: 11px; padding: 1px 6px; cursor: pointer; color: var(--ct-text3); }
.ha-btn:hover { color: var(--ct-text); border-color: var(--ct-border2); }

.b-text { word-break: break-word; color: var(--ct-text); }
.me-b .b-text { color: inherit; }
.b-text :deep(p) { margin: 0 0 6px; }
.b-text :deep(p:last-child) { margin-bottom: 0; }
.b-text :deep(code) { font-family: var(--ct-mono); font-size: 11px; background: var(--ct-panel2); border: 1px solid var(--ct-border); border-radius: 3px; padding: 0 4px; }
.b-text :deep(ul), .b-text :deep(ol) { margin: 4px 0; padding-left: 18px; }
.b-text :deep(strong) { font-weight: 600; }
.b-text :deep(.mention) { color: var(--ct-accent); background: var(--ct-panel2); border-radius: 3px; padding: 0 3px; font-weight: 600; }

/* ---------- 流式/打字状态 ---------- */
.row.streaming .bubble { opacity: 0.92; }
.caret { display: inline-block; width: 2px; height: 14px; background: var(--ct-accent); margin-left: 2px; vertical-align: text-bottom; animation: blink 0.9s step-end infinite; }
@keyframes blink { 50% { opacity: 0; } }
.router-hint { align-self: center; font-size: 11px; color: var(--ct-text3); display: flex; align-items: center; gap: 4px; margin: 8px 0; }
.typing-b { display: flex; align-items: center; gap: 4px; }
.dot-t { width: 5px; height: 5px; border-radius: 50%; background: var(--ct-text3); animation: bob 1.2s infinite; }
.dot-t:nth-child(2) { animation-delay: 0.15s; }
.dot-t:nth-child(3) { animation-delay: 0.3s; }
@keyframes bob { 0%, 60%, 100% { transform: translateY(0); opacity: 0.4; } 30% { transform: translateY(-4px); opacity: 1; } }
.typing-label { font-size: 10px; color: var(--ct-text3); margin-left: 6px; }

/* ---------- 新消息胶囊 ---------- */
.new-pill { position: absolute; right: 16px; bottom: 150px; z-index: 5; border: 1px solid var(--ct-border2); background: var(--ct-panel); color: var(--ct-accent); border-radius: 14px; font-size: 11px; padding: 4px 12px; cursor: pointer; box-shadow: 0 2px 10px rgba(0, 0, 0, 0.12); }
.fade-enter-active, .fade-leave-active { transition: opacity 0.18s; }
.fade-enter-from, .fade-leave-to { opacity: 0; }

.pending-bar { margin: 0 10px 6px; font-size: 11px; color: var(--ct-accent); border: 1px dashed var(--ct-accent); border-radius: 8px; padding: 5px 10px; }

/* ---------- 输入区 ---------- */
.input-zone { border-top: 1px solid var(--ct-border); background: var(--ct-panel); padding: 8px; display: flex; flex-direction: column; gap: 6px; }
.reply-bar { display: flex; align-items: center; justify-content: space-between; gap: 8px; font-size: 11px; color: var(--ct-text3); background: var(--ct-bg); border: 1px solid var(--ct-border); border-radius: 8px; padding: 4px 8px; }
.rb-x { border: none; background: none; color: var(--ct-text3); font-size: 14px; cursor: pointer; }
.chips-row { display: flex; flex-wrap: wrap; align-items: center; gap: 4px; }
.chip-label { font-size: 10px; color: var(--ct-text3); }
.mention-chip { font-size: 11px; color: var(--ct-accent); background: var(--ct-bg); border: 1px solid var(--ct-border2); border-radius: 10px; padding: 1px 8px; cursor: pointer; }
.mention-chip:hover:not(:disabled) { border-color: var(--ct-accent); }
.mention-chip:disabled { opacity: 0.4; cursor: default; }
.op-row { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.mode-hint { font-size: 10px; color: var(--ct-text3); }
.ops { margin-left: auto; display: flex; gap: 6px; flex-wrap: wrap; }
.mono { font-family: var(--ct-mono); }
</style>
