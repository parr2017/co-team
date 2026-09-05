<template>
  <div ref="wrapEl" class="chat-stream" @scroll="onScroll">
    <div v-if="!entries.length && !typingAgent" class="empty mono">暂无对话记录</div>

    <template v-for="(item, i) in renderItems" :key="i">
      <!-- 微信式居中时间条：仅与上一条间隔 >5 分钟时显示 -->
      <div v-if="item.t === 'time'" class="time-divider mono">{{ item.label }}</div>

      <!-- 节点分组头：微信时间条样式（保留模型徽标） -->
      <div v-else-if="item.t === 'node'" class="node-divider">
        <span class="nd-label mono">{{ item.name }}</span>
        <span v-for="m in item.models" :key="m" class="nd-model mono">{{ m }}</span>
      </div>

      <!-- 用户介入：右侧绿色气泡（微信群聊"我"的心智） -->
      <div v-else-if="item.t === 'intervene'" class="row me">
        <div class="me-col">
          <div class="bubble me-b">
            <div class="b-text md" v-html="md(item.entry.text)"></div>
          </div>
        </div>
        <AgentAvatar name="master" :size="36" title="我" class="me-av" />
      </div>

      <!-- 主 Agent：任务简报（左侧，圆角方头像 + 昵称灰字在气泡上方） -->
      <div v-else-if="item.t === 'brief'" class="row them">
        <div class="them-col">
          <div class="who-name mono">主 Agent</div>
          <div class="bubble them-b">
            <div class="b-text md" v-html="md(item.entry.text)"></div>
          </div>
        </div>
        <AgentAvatar name="orchestrator" :size="36" class="av" />
      </div>

      <!-- 主 Agent：工具数据附件（文件消息卡片） -->
      <div v-else-if="item.t === 'tool_results'" class="row them">
        <div class="them-col">
          <div class="who-name mono">主 Agent</div>
          <div class="file-card">
            <details class="attach">
              <summary class="mono"><span class="file-ico">📄</span> 交付工具数据 · {{ (item.entry.meta?.results || []).length }} 项</summary>
              <pre class="pre mono">{{ dump(item.entry.meta?.results) }}</pre>
            </details>
          </div>
        </div>
        <AgentAvatar name="orchestrator" :size="36" class="av" />
      </div>

      <!-- 工具动作行：居中灰色系统消息 -->
      <div v-else-if="item.t === 'round'" class="sys-row">
        <span class="sys-text mono">{{ item.entry.text }}</span>
        <span class="sys-meta mono">{{ item.entry.model }}<template v-if="item.entry.tokens"> · {{ item.entry.tokens }} tok</template></span>
      </div>

      <!-- 子 Agent：最终汇报（左侧气泡 + 昵称） -->
      <div v-else-if="item.t === 'final'" class="row them">
        <div class="them-col">
          <div class="who-name mono">{{ item.agent }}</div>
          <div class="bubble them-b">
            <div class="b-text md" v-html="md(item.entry.text)"></div>
            <div v-if="(item.entry.meta?.changes || []).length" class="chips mono">
              <span v-for="c in (item.entry.meta?.changes || []).slice(0, 6)" :key="c" class="chip">✓ {{ c }}</span>
            </div>
            <details v-if="(item.entry.meta?.files || []).length || (item.entry.meta?.commands || []).length" class="attach">
              <summary class="mono"><span class="file-ico">📄</span> 附件 · {{ (item.entry.meta?.files || []).length }} 文件 / {{ (item.entry.meta?.commands || []).length }} 命令</summary>
              <pre class="pre mono">files: {{ (item.entry.meta?.files || []).join(', ') }}
commands: {{ (item.entry.meta?.commands || []).join(' | ') }}</pre>
            </details>
          </div>
        </div>
        <AgentAvatar :name="item.agent" :size="36" class="av" />
      </div>

      <!-- 子 Agent：错误（左侧红色边气泡） -->
      <div v-else-if="item.t === 'error'" class="row them">
        <div class="them-col">
          <div class="who-name mono">{{ item.agent }}</div>
          <div class="bubble them-b fatal">
            <div class="b-error mono">✗ {{ item.entry.text }}</div>
            <details v-if="item.entry.meta?.raw" class="attach">
              <summary class="mono"><span class="file-ico">📄</span> 原始输出</summary>
              <pre class="pre mono">{{ item.entry.meta.raw }}</pre>
            </details>
          </div>
        </div>
        <AgentAvatar :name="item.agent" :size="36" class="av err" />
      </div>
    </template>

    <!-- 打字指示器：左头像 + 灰气泡三点动画 -->
    <div v-if="typingAgent" class="row them">
      <div class="them-col">
        <div class="who-name mono">{{ typingAgent }}</div>
        <div class="bubble them-b typing-b">
          <span class="dot-t"></span><span class="dot-t"></span><span class="dot-t"></span>
          <span class="typing-label mono">{{ typingText || '工作中…' }}</span>
        </div>
      </div>
      <AgentAvatar :name="typingAgent" :size="36" class="av" />
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onUnmounted, ref, watch } from 'vue';
import { marked } from 'marked';
import { api, type JournalEntry } from '../api';
import { onEvent } from '../composables/useDashboard';
import AgentAvatar from './AgentAvatar.vue';

type Entry = JournalEntry & { agent: string };
type RenderItem =
  | { t: 'time'; label: string }
  | { t: 'node'; name: string; models: string[] }
  | { t: 'brief' | 'tool_results' | 'round' | 'final' | 'error' | 'intervene'; entry: Entry; agent: string };

const props = defineProps<{ taskId: string; filterAgent?: string; filterNodeId?: string }>();

const wrapEl = ref<HTMLElement | null>(null);
const entries = ref<Entry[]>([]);
const typingAgent = ref('');
const typingText = ref('');
let stickToBottom = true;
let unsubFns: (() => void)[] = [];

const filtered = computed(() =>
  entries.value.filter((e) => {
    if (props.filterNodeId && e.node_id !== props.filterNodeId) return false;
    if (props.filterAgent && e.agent !== props.filterAgent && e.role !== 'master') return false;
    return true;
  })
);

/** 微信式时间省略：仅与上一条消息间隔超过 5 分钟时插入居中时间条 */
const TIME_GAP_MS = 5 * 60 * 1000;

/** entries grouped by node with sticky headers carrying every model used in the node */
const renderItems = computed<RenderItem[]>(() => {
  const out: RenderItem[] = [];
  let lastNode = '';
  let models: string[] = [];
  let lastTs = 0;
  for (const e of filtered.value) {
    const ts = e.ts ? new Date(e.ts).getTime() : 0;
    if (ts - lastTs > TIME_GAP_MS) out.push({ t: 'time', label: fmtFull(e.ts) });
    lastTs = ts || lastTs;
    if (e.node_id !== lastNode) {
      if (lastNode) out.push({ t: 'node', name: nodeNameOf(lastNode), models });
      lastNode = e.node_id;
      models = [];
    }
    if (e.model && !models.includes(e.model)) models.push(e.model);
    out.push({ t: e.kind, entry: e, agent: e.agent });
  }
  if (lastNode) out.push({ t: 'node', name: nodeNameOf(lastNode), models });
  return out;
});

const nodeNames = ref<Record<string, string>>({});
function nodeNameOf(nodeId: string): string {
  return nodeNames.value[nodeId] || nodeId;
}

watch(
  () => props.taskId,
  () => void load(),
  { immediate: true }
);

async function load() {
  typingAgent.value = '';
  typingText.value = '';
  entries.value = [];
  if (!props.taskId) return;
  try {
    // task meta gives node names for the group headers
    const task = await api.getTask(props.taskId);
    const map: Record<string, string> = {};
    for (const n of task.nodes || []) map[n.id] = n.name;
    nodeNames.value = map;
  } catch {
    /* ignore */
  }
  try {
    const journals = (await api.taskJournals(props.taskId)).journals || {};
    const all: Entry[] = [];
    for (const [agent, list] of Object.entries(journals)) {
      for (const e of list) all.push({ ...e, agent });
    }
    all.sort((a, b) => (a.ts || '').localeCompare(b.ts || ''));
    entries.value = all;
    await nextTick();
    scrollToBottom(true);
  } catch {
    /* ignore */
  }
}

// live deltas over WS: journal_append pushes new chat rows; agent_* drives the typing indicator
unsubFns.push(
  onEvent((msg) => {
    const p = msg.payload || {};
    if (p.task_id !== props.taskId) return;
    if (msg.type === 'journal_append' && p.agent && p.entry) {
      const entry = { ...(p.entry as JournalEntry), agent: String(p.agent) };
      insertSorted(entry);
      if (props.filterNodeId && entry.node_id !== props.filterNodeId) return;
      if (props.filterAgent && entry.agent !== props.filterAgent && entry.role !== 'master') return;
      void nextTick(() => scrollToBottom());
    } else if (['agent_activity', 'agent_round'].includes(msg.type) && p.agent) {
      if (props.filterAgent && p.agent !== props.filterAgent) return;
      typingAgent.value = String(p.agent);
      typingText.value = msg.type === 'agent_activity' ? String(p.text || '').slice(0, 60) : `第 ${p.round} 轮对话`;
    } else if (msg.type === 'agent_final' && p.agent) {
      if (typingAgent.value === p.agent) {
        typingAgent.value = '';
        typingText.value = '';
      }
    } else if (['node_error', 'node_cancelled', 'execute_complete', 'execute_failed', 'execute_cancelled'].includes(msg.type)) {
      typingAgent.value = '';
      typingText.value = '';
    }
  })
);

function insertSorted(e: Entry) {
  if (entries.value.some((x) => x.ts === e.ts && x.agent === e.agent && x.kind === e.kind)) return;
  entries.value.push(e);
}

function onScroll() {
  const el = wrapEl.value;
  if (!el) return;
  stickToBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
}

function scrollToBottom(force = false) {
  const el = wrapEl.value;
  if (!el || (!force && !stickToBottom)) return;
  el.scrollTop = el.scrollHeight;
}

function fmtFull(ts: string): string {
  if (!ts) return '';
  const d = new Date(ts);
  const today = new Date();
  const sameDay = d.toDateString() === today.toDateString();
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  if (sameDay) return hm;
  return `${d.getMonth() + 1}月${d.getDate()}日 ${hm}`;
}

function dump(v: unknown): string {
  return JSON.stringify(v, null, 1);
}

/** escape HTML first, then render light markdown (bold / inline code / lists) */
function md(text: string): string {
  if (!text) return '';
  const escaped = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return String(marked.parse(escaped, { async: false, breaks: true }));
}

onUnmounted(() => unsubFns.forEach((u) => u()));
</script>

<style scoped>
.chat-stream { display: flex; flex-direction: column; gap: 10px; padding: 6px 2px; overflow-y: auto; background: var(--ct-bg); }
.empty { color: var(--ct-text3); text-align: center; padding: 24px; font-size: 12px; }

/* 微信式居中时间条 */
.time-divider { text-align: center; font-size: 11px; color: var(--ct-text3); background: var(--ct-panel2); border-radius: 4px; padding: 3px 10px; align-self: center; margin: 6px 0 2px; }

/* 节点分组头：居中标签样式 */
.node-divider { display: flex; align-items: center; justify-content: center; gap: 8px; margin: 10px 0 2px; }
.nd-label { font-size: 11px; color: var(--ct-text3); background: var(--ct-panel2); border-radius: 10px; padding: 2px 12px; }
.nd-model { font-size: 9px; color: var(--ct-accent); border: 1px solid var(--ct-border2); border-radius: 3px; padding: 0 4px; background: var(--ct-panel); }

/* 消息行：Agent 左 / 用户右 */
.row { display: flex; gap: 10px; }
.row.them { justify-content: flex-start; }
.row.me { justify-content: flex-end; }
.them-col { display: flex; flex-direction: column; align-items: flex-start; max-width: 75%; min-width: 0; }
.me-col { display: flex; flex-direction: column; align-items: flex-end; max-width: 75%; min-width: 0; }
.who-name { font-size: 10px; color: var(--ct-text3); margin: 0 2px 3px; }

/* 气泡 */
.bubble { padding: 9px 12px; border-radius: 10px; font-size: 13px; background: var(--ct-panel); border: 1px solid var(--ct-border); position: relative; }
/* Agent 气泡：左上三角指向头像 */
.them-b { border-top-left-radius: 2px; }
.them-b::before {
  content: ''; position: absolute; top: 0; left: -7px;
  border: 4px solid transparent; border-top-color: var(--ct-border); border-right-color: var(--ct-border);
}
/* 用户"我"绿气泡：右上三角指向头像 */
.me-b { background: #95ec69; border: none; border-top-right-radius: 2px; color: #0b2e13; }
html.dark .me-b { background: #3eb575; color: #eafff1; }
.me-b::before {
  content: ''; position: absolute; top: 0; right: -7px;
  border: 4px solid transparent; border-top-color: #95ec69; border-left-color: #95ec69;
}
html.dark .me-b::before { border-top-color: #3eb575; border-left-color: #3eb575; }

.them-b.fatal { border-color: var(--ct-red); }
.them-b.fatal::before { border-top-color: var(--ct-red); border-right-color: var(--ct-red); }

.b-text { word-break: break-word; color: var(--ct-text); line-height: 1.65; }
.b-text :deep(p) { margin: 0 0 6px; }
.b-text :deep(p:last-child) { margin-bottom: 0; }
.b-text :deep(code) { font-family: var(--ct-mono); font-size: 11px; background: var(--ct-panel2); border: 1px solid var(--ct-border); border-radius: 3px; padding: 0 4px; }
.b-text :deep(pre) { background: var(--ct-panel2); border: 1px solid var(--ct-border); border-radius: 6px; padding: 8px; overflow-x: auto; font-size: 11px; }
.b-text :deep(ul), .b-text :deep(ol) { margin: 4px 0; padding-left: 18px; }
.b-text :deep(h1), .b-text :deep(h2), .b-text :deep(h3) { font-size: 13px; margin: 6px 0 4px; }
.b-error { color: var(--ct-red); white-space: pre-wrap; font-size: 12px; }

/* 文件消息卡片 */
.file-card { background: var(--ct-panel); border: 1px solid var(--ct-border); border-radius: 8px; padding: 6px 10px; }

.chips { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 6px; }
.chip { font-size: 10px; color: var(--ct-green); border: 1px solid var(--ct-border); border-radius: 3px; padding: 1px 5px; background: var(--ct-bg); }
.attach { margin-top: 6px; }
.attach summary { cursor: pointer; font-size: 10px; color: var(--ct-text3); }
.attach .pre { max-height: 180px; overflow: auto; background: var(--ct-bg); border-radius: 4px; padding: 6px; margin-top: 4px; font-size: 10px; white-space: pre-wrap; }

/* 居中灰色系统消息（工具动作行） */
.sys-row { display: flex; flex-direction: column; align-items: center; gap: 2px; margin: 2px 0; }
.sys-text { font-size: 11px; color: var(--ct-text3); background: var(--ct-panel2); border-radius: 4px; padding: 2px 12px; max-width: 80%; text-align: center; }
.sys-meta { font-size: 9px; color: var(--ct-text3); }

/* typing */
.typing-b { display: flex; align-items: center; gap: 4px; }
.dot-t { width: 6px; height: 6px; border-radius: 50%; background: var(--ct-text3); animation: bob 1.2s infinite; }
.dot-t:nth-child(2) { animation-delay: 0.15s; }
.dot-t:nth-child(3) { animation-delay: 0.3s; }
@keyframes bob { 0%, 60%, 100% { transform: translateY(0); opacity: 0.4; } 30% { transform: translateY(-4px); opacity: 1; } }
.typing-label { font-size: 10px; color: var(--ct-text3); margin-left: 6px; max-width: 420px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
</style>
