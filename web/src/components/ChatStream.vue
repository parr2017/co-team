<template>
  <div ref="wrapEl" class="chat-stream" @scroll="onScroll">
    <div v-if="!entries.length && !typingAgent" class="empty mono">暂无对话记录</div>

    <template v-for="(item, i) in renderItems" :key="i">
      <!-- 节点分组头 -->
      <div v-if="item.t === 'node'" class="node-divider">
        <span class="nd-line"></span>
        <span class="nd-label mono">{{ item.name }}</span>
        <span v-for="m in item.models" :key="m" class="nd-model mono">{{ m }}</span>
        <span class="nd-line"></span>
      </div>

      <!-- 主 Agent：任务简报 -->
      <div v-else-if="item.t === 'brief'" class="row master">
        <div class="avatar master-av mono" title="主 Agent">主</div>
        <div class="bubble master-b">
          <div class="b-head mono"><span class="who">主 Agent</span><span class="b-model mono">{{ item.entry.model || '' }}</span><span class="when">{{ fmt(item.entry.ts) }}</span></div>
          <div class="b-text md" v-html="md(item.entry.text)"></div>
        </div>
      </div>

      <!-- 主 Agent：工具数据附件 -->
      <div v-else-if="item.t === 'tool_results'" class="row master">
        <div class="avatar master-av mono">主</div>
        <div class="bubble master-b slim">
          <div class="b-head mono"><span class="who">主 Agent</span><span class="when">{{ fmt(item.entry.ts) }}</span></div>
          <details class="attach">
            <summary class="mono">📎 交付工具数据 · {{ (item.entry.meta?.results || []).length }} 项</summary>
            <pre class="pre mono">{{ dump(item.entry.meta?.results) }}</pre>
          </details>
        </div>
      </div>

      <!-- 子 Agent：动作行 -->
      <div v-else-if="item.t === 'round'" class="row action">
        <span class="action-line mono">⚙ {{ item.entry.text }}</span>
        <span class="when mono">{{ item.entry.model }}<template v-if="item.entry.tokens"> · {{ item.entry.tokens }} tok</template></span>
      </div>

      <!-- 子 Agent：最终汇报 -->
      <div v-else-if="item.t === 'final'" class="row sub">
        <div class="bubble sub-b">
          <div class="b-head mono"><span class="when">{{ fmt(item.entry.ts) }}</span><span class="b-model mono">{{ item.entry.model || '' }}</span><span class="who">{{ item.agent }}</span></div>
          <div class="b-text md" v-html="md(item.entry.text)"></div>
          <div v-if="(item.entry.meta?.changes || []).length" class="chips mono">
            <span v-for="c in (item.entry.meta?.changes || []).slice(0, 6)" :key="c" class="chip">✓ {{ c }}</span>
          </div>
          <details v-if="(item.entry.meta?.files || []).length || (item.entry.meta?.commands || []).length" class="attach">
            <summary class="mono">📎 附件 · {{ (item.entry.meta?.files || []).length }} 文件 / {{ (item.entry.meta?.commands || []).length }} 命令</summary>
            <pre class="pre mono">files: {{ (item.entry.meta?.files || []).join(', ') }}
commands: {{ (item.entry.meta?.commands || []).join(' | ') }}</pre>
          </details>
        </div>
        <div class="avatar sub-av mono" :title="item.agent">{{ avatarOf(item.agent) }}</div>
      </div>

      <!-- 子 Agent：错误 -->
      <div v-else-if="item.t === 'error'" class="row sub">
        <div class="bubble sub-b fatal">
          <div class="b-head mono"><span class="when">{{ fmt(item.entry.ts) }}</span><span class="who">{{ item.agent }}</span></div>
          <div class="b-error mono">✗ {{ item.entry.text }}</div>
          <details v-if="item.entry.meta?.raw" class="attach">
            <summary class="mono">📎 原始输出</summary>
            <pre class="pre mono">{{ item.entry.meta.raw }}</pre>
          </details>
        </div>
        <div class="avatar sub-av mono err" :title="item.agent">{{ avatarOf(item.agent) }}</div>
      </div>
    </template>

    <!-- 打字指示器：由 WS agent_activity 实时驱动 -->
    <div v-if="typingAgent" class="row sub">
      <div class="bubble sub-b typing-b">
        <span class="dot-t"></span><span class="dot-t"></span><span class="dot-t"></span>
        <span class="typing-label mono">{{ typingAgent }} 工作中{{ typingText ? ` · ${typingText}` : '…' }}</span>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onUnmounted, ref, watch } from 'vue';
import { marked } from 'marked';
import { api, type JournalEntry } from '../api';
import { onEvent } from '../composables/useDashboard';

type Entry = JournalEntry & { agent: string };
type RenderItem = { t: 'node'; name: string; models: string[] } | { t: 'brief' | 'tool_results' | 'round' | 'final' | 'error'; entry: Entry; agent: string };

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

/** entries grouped by node with sticky headers carrying every model used in the node */
const renderItems = computed<RenderItem[]>(() => {
  const out: RenderItem[] = [];
  let lastNode = '';
  let models: string[] = [];
  for (const e of filtered.value) {
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

function avatarOf(agent: string): string {
  return (agent || '??').replace(/[^a-z]/gi, '').slice(0, 2).toUpperCase() || '??';
}

function fmt(ts: string): string {
  return ts ? new Date(ts).toLocaleTimeString() : '';
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
.chat-stream { display: flex; flex-direction: column; gap: 8px; padding: 2px; overflow-y: auto; }
.empty { color: var(--ct-text3); text-align: center; padding: 24px; font-size: 12px; }
.node-divider { display: flex; align-items: center; gap: 8px; margin: 10px 0 2px; }
.nd-line { flex: 1; height: 1px; background: var(--ct-border); }
.nd-label { font-size: 10px; color: var(--ct-text3); letter-spacing: 0.5px; }
.nd-model { font-size: 9px; color: var(--ct-accent); border: 1px solid var(--ct-border2); border-radius: 3px; padding: 0 4px; }
.row { display: flex; }
.row.master { justify-content: flex-start; }
.row.sub { justify-content: flex-end; }
.row.action { justify-content: center; align-items: center; }
.avatar { width: 32px; height: 32px; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-size: 11px; font-weight: 700; flex-shrink: 0; align-self: flex-end; margin-bottom: 10px; }
.master-av { background: var(--ct-accent); color: #fff; align-self: flex-start; }
.sub-av { background: var(--ct-panel2); border: 2px solid var(--ct-green); color: var(--ct-text); }
.sub-av.err { border-color: var(--ct-red); }
.bubble { max-width: 86%; padding: 10px 12px; border-radius: 10px; font-size: 13px; }
.master-b { background: var(--ct-panel2); border-left: 3px solid var(--ct-accent); border-radius: 2px 10px 10px 10px; }
.sub-b { background: var(--ct-panel); border: 1px solid var(--ct-border); border-right: 3px solid var(--ct-green); border-radius: 10px 2px 10px 10px; }
.sub-b.fatal { border-right-color: var(--ct-red); }
.b-head { display: flex; justify-content: space-between; align-items: center; gap: 10px; font-size: 10px; color: var(--ct-text3); margin-bottom: 4px; }
.who { color: var(--ct-text2); font-weight: 700; }
.b-model { color: var(--ct-accent); border: 1px solid var(--ct-border2); border-radius: 3px; padding: 0 4px; font-size: 9px; }
.when { font-size: 10px; color: var(--ct-text3); }
.b-text { word-break: break-word; color: var(--ct-text); line-height: 1.65; }
.b-text :deep(p) { margin: 0 0 6px; }
.b-text :deep(p:last-child) { margin-bottom: 0; }
.b-text :deep(code) { font-family: var(--ct-mono); font-size: 11px; background: var(--ct-panel2); border: 1px solid var(--ct-border); border-radius: 3px; padding: 0 4px; }
.b-text :deep(pre) { background: var(--ct-panel2); border: 1px solid var(--ct-border); border-radius: 6px; padding: 8px; overflow-x: auto; font-size: 11px; }
.b-text :deep(ul), .b-text :deep(ol) { margin: 4px 0; padding-left: 18px; }
.b-text :deep(h1), .b-text :deep(h2), .b-text :deep(h3) { font-size: 13px; margin: 6px 0 4px; }
.b-error { color: var(--ct-red); white-space: pre-wrap; font-size: 12px; }
.chips { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 6px; }
.chip { font-size: 10px; color: var(--ct-green); border: 1px solid var(--ct-border); border-radius: 3px; padding: 1px 5px; background: var(--ct-bg); }
.attach { margin-top: 6px; }
.attach summary { cursor: pointer; font-size: 10px; color: var(--ct-text3); }
.attach .pre { max-height: 180px; overflow: auto; background: var(--ct-bg); border-radius: 4px; padding: 6px; margin-top: 4px; font-size: 10px; white-space: pre-wrap; }
.action-line { font-size: 11px; color: var(--ct-yellow); background: var(--ct-panel2); border: 1px dashed var(--ct-border2); border-radius: 4px; padding: 2px 10px; }
.typing-b { display: flex; align-items: center; gap: 4px; }
.dot-t { width: 6px; height: 6px; border-radius: 50%; background: var(--ct-text3); animation: bob 1.2s infinite; }
.dot-t:nth-child(2) { animation-delay: 0.15s; }
.dot-t:nth-child(3) { animation-delay: 0.3s; }
@keyframes bob { 0%, 60%, 100% { transform: translateY(0); opacity: 0.4; } 30% { transform: translateY(-4px); opacity: 1; } }
.typing-label { font-size: 10px; color: var(--ct-text3); margin-left: 6px; max-width: 420px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
</style>
