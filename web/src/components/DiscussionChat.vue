<template>
  <div class="disc-chat">
    <div ref="wrapEl" class="stream" @scroll="onScroll">
      <div v-if="!items.length" class="empty mono">还没有讨论内容——发一条消息，或点「继续讨论」让成员先开个场</div>

      <template v-for="(item, i) in items" :key="i">
        <div v-if="item.t === 'time'" class="time-divider mono">{{ item.label }}</div>

        <!-- 系统消息：居中灰字（轮次结算 / 点名 / 方案 / 转项目 / 沉默提示） -->
        <div v-else-if="item.t === 'system'" class="sys-row"><span class="sys-text mono">{{ item.m.text }}</span></div>

        <!-- 用户发言：右侧绿气泡（微信“我”的心智），补充与方向性修正都从这里进 -->
        <div v-else-if="item.t === 'user'" class="row me">
          <div class="me-col">
            <div class="bubble me-b"><div class="b-text md" v-html="md(item.m.text)"></div></div>
          </div>
          <AgentAvatar name="master" :size="36" title="我" class="me-av" />
        </div>

        <!-- agent 发言：左侧气泡 + 头像；ask_user 高亮 + 待拍板/已回复标签 -->
        <div v-else class="row them">
          <div class="them-col">
            <div class="who-name mono">{{ item.m.from }}</div>
            <div class="bubble them-b" :class="{ ask: item.m.needs_user, answered: item.m.needs_user && item.answered }">
              <div v-if="item.m.needs_user" class="ask-tag mono">{{ item.answered ? '@你 已回复' : '@你 待拍板' }}</div>
              <div class="b-text md" v-html="md(item.m.text)"></div>
            </div>
          </div>
          <AgentAvatar :name="item.m.from" :size="36" class="av" />
        </div>
      </template>

      <!-- 打字指示器：当前被唤起的成员 -->
      <div v-if="thinking" class="row them">
        <div class="them-col">
          <div class="who-name mono">{{ thinking }}</div>
          <div class="bubble them-b typing-b"><span class="dot-t"></span><span class="dot-t"></span><span class="dot-t"></span><span class="typing-label mono">正在思考是否发言…</span></div>
        </div>
        <AgentAvatar :name="thinking" :size="36" class="av" />
      </div>
    </div>

    <!-- 待拍板提示条 -->
    <div v-if="pendingUser" class="pending-bar mono">有成员提出了需要你拍板的问题，回复一条消息即可继续（自动讨论会暂停等待）</div>

    <div class="input-zone">
      <div class="chips-row" v-if="members.length">
        <span class="chip-label mono">@点名（点击插入）：</span>
        <button v-for="m in members" :key="m" class="mention-chip mono" :disabled="status === 'converted'" @click="insertMention(m)">@{{ m }}</button>
      </div>
      <el-input
        v-model="draft"
        type="textarea"
        :rows="2"
        resize="none"
        :disabled="status === 'converted'"
        placeholder="可 @agent 指定发言（@dev 怎么看）；也可随时补充信息或做方向性修正，你的发言对全体成员有约束力"
        @keydown.enter.exact.prevent="sendNow"
      />
      <div class="op-row">
        <el-radio-group v-model="mode" size="small" :disabled="busy || status === 'converted'" @change="onModeChange">
          <el-radio-button value="manual">手动</el-radio-button>
          <el-radio-button value="auto">自动</el-radio-button>
        </el-radio-group>
        <span class="mode-hint mono">{{ mode === 'auto' ? '自动：发一条消息，成员最多自由讨论 3 轮' : '手动：每条消息触发一轮，可点继续讨论' }}</span>
        <div class="ops">
          <el-button v-if="busy" size="small" type="warning" plain @click="stop">停止讨论</el-button>
          <el-button v-else size="small" :disabled="status === 'converted'" @click="moreRound">继续讨论</el-button>
          <el-button size="small" :loading="genLoading" :disabled="status === 'converted'" @click="emit('gen-scheme')">生成方案</el-button>
          <el-button v-if="status !== 'converted'" size="small" type="success" :disabled="!schemeReady" @click="emit('convert')">转为项目开发</el-button>
          <el-button v-else size="small" @click="emit('open-task')">查看开发任务 ›</el-button>
          <el-button size="small" type="primary" :disabled="!draft.trim() || status === 'converted'" @click="sendNow">发送</el-button>
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
import { useDiscussion } from '../composables/useDiscussion';
import AgentAvatar from './AgentAvatar.vue';

const emit = defineEmits<{ (e: 'gen-scheme'): void; (e: 'convert'): void; (e: 'open-task'): void }>();

const { current, busy, thinking, send, round, stop, setMode } = useDiscussion();

const members = computed(() => current.value?.members || []);
const status = computed(() => current.value?.status || 'discussing');
const pendingUser = computed(() => !!current.value?.pending_user);
const schemeReady = computed(() => !!current.value?.scheme?.trim());
const draft = ref('');
const genLoading = ref(false);
const mode = ref<'manual' | 'auto'>('manual');
const wrapEl = ref<HTMLElement | null>(null);
let stickToBottom = true;

type ChatItem =
  | { t: 'time'; label: string }
  | { t: 'system' | 'user' | 'agent'; m: DiscussionMessage; answered?: boolean };

const TIME_GAP_MS = 5 * 60 * 1000;

/** 微信式时间省略 + ask_user 消息的「已回复」派生（最后一条 ask_user 之后是否有用户消息） */
const items = computed<ChatItem[]>(() => {
  const msgs = current.value?.messages || [];
  const lastUserIdx = msgs.map((m) => m.from).lastIndexOf('user');
  const out: ChatItem[] = [];
  let lastTs = 0;
  for (let i = 0; i < msgs.length; i++) {
    const m = msgs[i];
    const ts = m.ts ? new Date(m.ts.replace(' ', 'T')).getTime() : 0;
    if (ts - lastTs > TIME_GAP_MS) out.push({ t: 'time', label: fmtFull(m.ts) });
    lastTs = ts || lastTs;
    const t = m.from === 'user' ? 'user' : m.from === 'system' ? 'system' : 'agent';
    out.push({ t, m, answered: !!m.needs_user && lastUserIdx > i });
  }
  return out;
});

function fmtFull(ts: string): string {
  if (!ts) return '';
  const d = new Date(ts.replace(' ', 'T'));
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  if (sameDay) return hm;
  return `${d.getMonth() + 1}月${d.getDate()}日 ${hm}`;
}

/** escape first (XSS), then light markdown, then @token highlight */
function md(text: string): string {
  if (!text) return '';
  const escaped = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const html = String(marked.parse(escaped, { async: false, breaks: true }));
  return html.replace(/@([A-Za-z0-9_\-\u4e00-\u9fff]+)/g, '<span class="mention">@$1</span>');
}

async function sendNow() {
  const text = draft.value.trim();
  if (!text) return;
  try {
    await send(text);
    draft.value = '';
    await nextTick();
    scrollToBottom(true);
  } catch (e: any) {
    ElMessage.error(String(e?.message || e));
  }
}

async function moreRound() {
  await round();
}

async function onModeChange(v: any) {
  await setMode(v === 'auto' ? 'auto' : 'manual');
  ElMessage.success(v === 'auto' ? '已切到自动模式：下次发言起成员自动多轮讨论' : '已切到手动模式');
}

function insertMention(name: string) {
  draft.value = (draft.value + (draft.value && !draft.value.endsWith(' ') ? ' ' : '') + `@${name} `).slice(0, 4000);
}

function onScroll() {
  const el = wrapEl.value;
  if (!el) return;
  stickToBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
}

function scrollToBottom(force = false) {
  const el = wrapEl.value;
  if (!el || (!force && !stickToBottom)) return;
  el.scrollTop = el.scrollHeight;
}

watch(
  () => [current.value?.id, current.value?.messages.length, thinking.value],
  () => void nextTick(() => scrollToBottom())
);
watch(() => current.value?.id, (id) => {
  if (id) {
    mode.value = current.value?.mode || 'manual';
    stickToBottom = true;
    void nextTick(() => scrollToBottom(true));
  }
});
</script>

<style scoped>
.disc-chat { display: flex; flex-direction: column; height: 100%; min-height: 0; background: var(--ct-bg); }
.stream { flex: 1; display: flex; flex-direction: column; gap: 10px; padding: 10px 8px; overflow-y: auto; }
.empty { color: var(--ct-text3); text-align: center; padding: 40px 20px; font-size: 12px; }

.time-divider { text-align: center; font-size: 11px; color: var(--ct-text3); background: var(--ct-panel2); border-radius: 4px; padding: 3px 10px; align-self: center; margin: 6px 0 2px; }

.row { display: flex; gap: 10px; }
.row.them { justify-content: flex-start; }
.row.me { justify-content: flex-end; }
.them-col { display: flex; flex-direction: column; align-items: flex-start; max-width: 75%; min-width: 0; }
.me-col { display: flex; flex-direction: column; align-items: flex-end; max-width: 75%; min-width: 0; }
.who-name { font-size: 10px; color: var(--ct-text3); margin: 0 2px 3px; }

.bubble { padding: 9px 12px; border-radius: 10px; font-size: 13px; background: var(--ct-panel); border: 1px solid var(--ct-border); position: relative; }
.them-b { border-top-left-radius: 2px; }
.them-b::before { content: ''; position: absolute; top: 0; left: -7px; border: 4px solid transparent; border-top-color: var(--ct-border); border-right-color: var(--ct-border); }
.me-b { background: #95ec69; border: none; border-top-right-radius: 2px; color: #0b2e13; }
html.dark .me-b { background: #3eb575; color: #eafff1; }
.me-b::before { content: ''; position: absolute; top: 0; right: -7px; border: 4px solid transparent; border-top-color: #95ec69; border-left-color: #95ec69; }
html.dark .me-b::before { border-top-color: #3eb575; border-left-color: #3eb575; }

/* ask_user：accent 高亮边框 + 待拍板标签；用户回复后降为已回复灰标签 */
.them-b.ask { border-color: var(--ct-accent); box-shadow: 0 0 0 1px var(--ct-accent); }
.ask-tag { align-self: flex-start; font-size: 10px; color: #fff; background: var(--ct-accent); border-radius: 3px; padding: 1px 6px; margin-bottom: 5px; }
.them-b.answered .ask-tag { background: var(--ct-text3); }

.b-text { word-break: break-word; color: var(--ct-text); line-height: 1.65; }
.b-text :deep(p) { margin: 0 0 6px; }
.b-text :deep(p:last-child) { margin-bottom: 0; }
.b-text :deep(code) { font-family: var(--ct-mono); font-size: 11px; background: var(--ct-panel2); border: 1px solid var(--ct-border); border-radius: 3px; padding: 0 4px; }
.b-text :deep(ul), .b-text :deep(ol) { margin: 4px 0; padding-left: 18px; }
.b-text :deep(strong) { font-weight: 600; }
.b-text :deep(.mention) { color: var(--ct-accent); background: var(--ct-panel2); border-radius: 3px; padding: 0 3px; font-weight: 600; }

.sys-row { display: flex; justify-content: center; margin: 2px 0; }
.sys-text { font-size: 11px; color: var(--ct-text3); background: var(--ct-panel2); border-radius: 4px; padding: 2px 12px; max-width: 85%; text-align: center; }

.typing-b { display: flex; align-items: center; gap: 4px; }
.dot-t { width: 6px; height: 6px; border-radius: 50%; background: var(--ct-text3); animation: bob 1.2s infinite; }
.dot-t:nth-child(2) { animation-delay: 0.15s; }
.dot-t:nth-child(3) { animation-delay: 0.3s; }
@keyframes bob { 0%, 60%, 100% { transform: translateY(0); opacity: 0.4; } 30% { transform: translateY(-4px); opacity: 1; } }
.typing-label { font-size: 10px; color: var(--ct-text3); margin-left: 6px; }

.pending-bar { margin: 0 8px 6px; font-size: 11px; color: var(--ct-accent); border: 1px dashed var(--ct-accent); border-radius: 6px; padding: 5px 10px; }

.input-zone { border-top: 1px solid var(--ct-border); background: var(--ct-panel); padding: 8px; display: flex; flex-direction: column; gap: 6px; }
.chips-row { display: flex; flex-wrap: wrap; align-items: center; gap: 4px; }
.chip-label { font-size: 10px; color: var(--ct-text3); }
.mention-chip { font-size: 11px; color: var(--ct-accent); background: var(--ct-bg); border: 1px solid var(--ct-border2); border-radius: 10px; padding: 1px 8px; cursor: pointer; }
.mention-chip:hover:not(:disabled) { border-color: var(--ct-accent); }
.mention-chip:disabled { opacity: 0.4; cursor: default; }
.op-row { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.mode-hint { font-size: 10px; color: var(--ct-text3); }
.ops { margin-left: auto; display: flex; gap: 6px; flex-wrap: wrap; }
</style>
