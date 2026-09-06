<script setup lang="ts">
import { computed, nextTick, onUnmounted, ref, watch } from 'vue';
import { marked } from 'marked';
import { api, type JournalEntry } from '../api';
import { useDashboard } from '../composables/useDashboard';
import AgentAvatar from './AgentAvatar.vue';

type Entry = JournalEntry & { agent: string };
type RenderItem =
  | { t: 'time'; label: string }
  | { t: 'node'; name: string }
  | { t: 'brief' | 'tool_results' | 'round' | 'final' | 'error' | 'intervene' | 'deliverable'; entry: Entry; agent: string };

const props = defineProps<{ taskId: string; filterAgent?: string; filterNodeId?: string }>();

const wrapEl = ref<HTMLElement | null>(null);
const entries = ref<Entry[]>([]);
const typingAgent = ref('');
const typingText = ref('');
let stickToBottom = true;
let unsubFns: (() => void)[] = [];

const { onEvent } = useDashboard();

const filtered = computed(() =>
  entries.value.filter((e) => {
    if (props.filterNodeId && e.node_id !== props.filterNodeId) return false;
    if (props.filterAgent && e.agent !== props.filterAgent && e.role !== 'master') return false;
    return true;
  })
);

const TIME_GAP_MS = 5 * 60 * 1000;

const renderItems = computed<RenderItem[]>(() => {
  const out: RenderItem[] = [];
  let lastNode = '';
  let lastTs = 0;
  for (const e of filtered.value) {
    const ts = e.ts ? new Date(e.ts).getTime() : 0;
    if (ts - lastTs > TIME_GAP_MS) out.push({ t: 'time', label: fmtFull(e.ts) });
    lastTs = ts || lastTs;
    if (e.node_id !== lastNode) {
      if (lastNode) out.push({ t: 'node', name: nodeNameOf(lastNode) });
      lastNode = e.node_id;
    }
    out.push({ t: e.kind, entry: e, agent: e.agent });
  }
  if (lastNode) out.push({ t: 'node', name: nodeNameOf(lastNode) });
  return out;
});

const nodeNames = ref<Record<string, string>>({});

const deliverableView = ref<{ title: string; markdown: string } | null>(null);
const deliverableOpen = computed({
  get: () => deliverableView.value !== null,
  set: (v: boolean) => { if (!v) deliverableView.value = null; },
});
function openDeliverable(entry: JournalEntry) {
  const md = entry.meta?.markdown;
  if (md) {
    deliverableView.value = { title: entry.node_name || entry.node_id, markdown: md };
  } else {
    void api.getDeliverable(props.taskId, entry.node_id).then((d) => {
      deliverableView.value = { title: d.node_name || entry.node_id, markdown: d.markdown };
    }).catch(() => {});
  }
}
function nodeNameOf(nodeId: string): string {
  return nodeNames.value[nodeId] || nodeId;
}

watch(() => props.taskId, () => void load(), { immediate: true });

async function load() {
  typingAgent.value = '';
  typingText.value = '';
  entries.value = [];
  if (!props.taskId) return;
  try {
    const task = await api.getTask(props.taskId);
    const map: Record<string, string> = {};
    for (const n of task.nodes || []) map[n.id] = n.name;
    nodeNames.value = map;
  } catch { /* ignore */ }
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
  } catch { /* ignore */ }
}

unsubFns.push(
  onEvent((msg) => {
    const p = msg.payload || {};
    if (p.task_id !== props.taskId) return;
    if (msg.type === 'journal_append' && p.agent && p.entry) {
      const entry = { ...(p.entry as JournalEntry), agent: String(p.agent) };
      if (!entries.value.some((x) => x.ts === entry.ts && x.agent === entry.agent && x.kind === entry.kind)) {
        entries.value.push(entry);
      }
      if (props.filterNodeId && entry.node_id !== props.filterNodeId) return;
      if (props.filterAgent && entry.agent !== props.filterAgent && entry.role !== 'master') return;
      void nextTick(() => scrollToBottom());
    } else if (['agent_activity', 'agent_round'].includes(msg.type) && p.agent) {
      if (props.filterAgent && p.agent !== props.filterAgent) return;
      typingAgent.value = String(p.agent);
      typingText.value = msg.type === 'agent_activity' ? String(p.text || '').slice(0, 40) : `第 ${p.round} 轮对话`;
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
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  if (d.toDateString() === today.toDateString()) return hm;
  return `${d.getMonth() + 1}月${d.getDate()}日 ${hm}`;
}

function dump(v: unknown): string {
  return JSON.stringify(v, null, 1);
}

/** 弱模型偶发把 tool_calls JSON 当最终消息输出——折叠为可展开卡片而非大段裸 JSON。 */
function isRawToolJson(text: string): boolean {
  return /"tool_calls"\s*:/.test(text || '') && /^\s*\{/.test(text || '');
}

function md(text: string): string {
  if (!text) return '';
  const escaped = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return String(marked.parse(escaped, { async: false, breaks: true }));
}

onUnmounted(() => unsubFns.forEach((u) => u()));
</script>

<template>
  <div ref="wrapEl" class="chat-stream" @scroll.passive="onScroll">
    <div v-if="!entries.length && !typingAgent" class="empty">
      <van-icon name="chat-o" size="48" color="#d5d5d5" />
      <div class="empty-text">暂无对话记录<br/>Agent 执行后这里会实时显示工作过程</div>
    </div>

    <template v-for="(item, i) in renderItems" :key="i">
      <div v-if="item.t === 'time'" class="time-divider">{{ item.label }}</div>

      <div v-else-if="item.t === 'node'" class="node-divider">{{ item.name }}</div>

      <!-- 用户介入：右侧绿色气泡 -->
      <div v-else-if="item.t === 'intervene'" class="row me">
        <div class="me-col">
          <div class="bubble me-b">
            <div class="b-text md" v-html="md(item.entry.text)"></div>
          </div>
        </div>
        <AgentAvatar name="master" :size="36" />
      </div>

      <!-- 主 Agent 简报 -->
      <div v-else-if="item.t === 'brief'" class="row them">
        <AgentAvatar name="orchestrator" :size="36" />
        <div class="them-col">
          <div class="who-name">主 Agent</div>
          <div class="bubble them-b">
            <div class="b-text md" v-html="md(item.entry.text)"></div>
          </div>
          <div v-if="item.entry.model" class="b-meta mono">{{ item.entry.model }}<template v-if="item.entry.tokens"> · {{ item.entry.tokens }} tok</template></div>
        </div>
      </div>

      <!-- 主 Agent 工具数据（文件卡片） -->
      <div v-else-if="item.t === 'tool_results'" class="row them">
        <AgentAvatar name="orchestrator" :size="36" />
        <div class="them-col">
          <div class="who-name">主 Agent</div>
          <div class="file-card">
            <details>
              <summary>📄 交付工具数据 · {{ (item.entry.meta?.results || []).length }} 项</summary>
              <pre class="pre">{{ dump(item.entry.meta?.results) }}</pre>
            </details>
          </div>
        </div>
      </div>

      <!-- 工具动作行：居中系统消息 -->
      <div v-else-if="item.t === 'round'" class="sys-row">
        <span class="sys-text">{{ item.entry.text }}</span>
        <span class="sys-meta">{{ item.entry.model }}<template v-if="item.entry.tokens"> · {{ item.entry.tokens }} tok</template></span>
      </div>

      <!-- 子 Agent 最终汇报 -->
      <div v-else-if="item.t === 'final'" class="row them">
        <AgentAvatar :name="item.agent" :size="36" />
        <div class="them-col">
          <div class="who-name">{{ item.agent }}</div>
          <div v-if="isRawToolJson(item.entry.text)" class="file-card">
            <details>
              <summary>🔧 工具调用消息（原始输出已折叠）</summary>
              <pre class="pre">{{ item.entry.text.slice(0, 2000) }}</pre>
            </details>
          </div>
          <div v-else class="bubble them-b">
            <div class="b-text md" v-html="md(item.entry.text)"></div>
            <div v-if="item.entry.meta?.verification" class="b-verify mono">验证 · {{ item.entry.meta.verification }}</div>
            <div v-if="(item.entry.meta?.changes || []).length" class="chips">
              <span v-for="c in (item.entry.meta?.changes || []).slice(0, 4)" :key="c" class="chip">✓ {{ c }}</span>
            </div>
            <details v-if="(item.entry.meta?.files || []).length || (item.entry.meta?.commands || []).length">
              <summary>📄 附件 · {{ (item.entry.meta?.files || []).length }} 文件 / {{ (item.entry.meta?.commands || []).length }} 命令</summary>
              <pre class="pre">files: {{ (item.entry.meta?.files || []).join(', ') }}
commands: {{ (item.entry.meta?.commands || []).join(' | ') }}</pre>
            </details>
          </div>
          <div v-if="item.entry.model" class="b-meta mono">{{ item.entry.model }}<template v-if="item.entry.tokens"> · {{ item.entry.tokens }} tok</template></div>
        </div>
      </div>

      <!-- 交付成果卡片：点击弹出统一模板阅读器 -->
      <div v-else-if="item.t === 'deliverable'" class="row them">
        <AgentAvatar :name="item.agent" :size="36" />
        <div class="them-col">
          <div class="who-name">{{ item.agent }} · 交付成果</div>
          <button class="deliv-card" @click="openDeliverable(item.entry)">
            <span class="dc-ico">📄</span>
            <span class="dc-body">
              <span class="dc-title">{{ item.entry.node_name }}</span>
              <span class="dc-sub">交付报告 · 统一模板 · 点击阅读</span>
            </span>
            <span class="dc-arrow">›</span>
          </button>
        </div>
      </div>

      <!-- 子 Agent 错误 -->
      <div v-else-if="item.t === 'error'" class="row them">
        <AgentAvatar :name="item.agent" :size="36" />
        <div class="them-col">
          <div class="who-name">{{ item.agent }}</div>
          <div class="bubble them-b fatal">
            <div class="b-error">✗ {{ item.entry.text }}</div>
            <details v-if="item.entry.meta?.raw">
              <summary>📄 原始输出</summary>
              <pre class="pre">{{ item.entry.meta.raw }}</pre>
            </details>
          </div>
          <div v-if="item.entry.model" class="b-meta mono">{{ item.entry.model }}<template v-if="item.entry.tokens"> · {{ item.entry.tokens }} tok</template></div>
        </div>
      </div>
    </template>

    <!-- typing -->
    <div v-if="typingAgent" class="row them">
      <AgentAvatar :name="typingAgent" :size="36" />
      <div class="them-col">
        <div class="who-name">{{ typingAgent }}</div>
        <div class="bubble them-b typing-b">
          <span class="dot-t"></span><span class="dot-t"></span><span class="dot-t"></span>
          <span class="typing-label">{{ typingText || '工作中…' }}</span>
        </div>
      </div>
    </div>
    <!-- 交付成果阅读器：统一模板固定展现 -->
    <van-popup v-model:show="deliverableOpen" position="bottom" :style="{ height: '82%' }" round>
      <div class="dl-viewer">
        <div class="dl-head">
          <span class="dl-title">交付成果 · {{ deliverableView?.title }}</span>
          <van-icon name="cross" size="18" @click="deliverableOpen = false" />
        </div>
        <div class="dl-body md" v-html="md(deliverableView?.markdown || '')"></div>
      </div>
    </van-popup>
  </div>
</template>

<style scoped>
.chat-stream { flex: 1; min-height: 0; overflow-y: auto; -webkit-overflow-scrolling: touch; padding: 8px 10px; display: flex; flex-direction: column; gap: 10px; }
.empty { display: flex; flex-direction: column; align-items: center; gap: 8px; color: var(--text-3); padding: 48px 20px; }
.empty-text { font-size: 13px; color: var(--text-3); text-align: center; line-height: 1.6; }

/* WeChat centered time pill */
.time-divider {
  text-align: center; font-size: 11px; color: #ffffff;
  align-self: center; margin: 4px 0; padding: 2px 10px;
  background: rgba(0, 0, 0, 0.22); border-radius: 4px;
}
/* node header = secondary time pill */
.node-divider {
  text-align: center; font-size: 11px; color: #ffffff;
  align-self: center; background: rgba(0, 0, 0, 0.22); border-radius: 4px;
  padding: 2px 14px; margin: 8px 0 2px; max-width: 80%;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}

.row { display: flex; gap: 10px; animation: wx-pop-in 0.22s cubic-bezier(0.22, 0.8, 0.36, 1); }
.row.them { justify-content: flex-start; }
.row.me { justify-content: flex-end; }
.them-col { display: flex; flex-direction: column; align-items: flex-start; max-width: 76%; min-width: 0; }
.me-col { display: flex; flex-direction: column; align-items: flex-end; max-width: 76%; min-width: 0; }
.who-name { font-size: 11px; color: var(--text-3); margin: 0 2px 3px; }

.bubble { padding: 10px 12px; border-radius: 12px; font-size: 15px; background: linear-gradient(180deg, rgba(22,32,48,0.92), rgba(17,26,40,0.95)); border: 1px solid rgba(56,189,248,0.16); position: relative; word-break: break-word; box-shadow: var(--shadow-bubble); }
.them-b { border-top-left-radius: 2px; }
.them-b::before {
  content: ''; position: absolute; top: 0; left: -7px;
  border: 4px solid transparent; border-top-color: var(--border); border-right-color: var(--border);
}
.me-b { background: linear-gradient(160deg, #26e0fb, #0284c7); border: none; border-top-right-radius: 2px; color: #04121d; font-weight: 500; box-shadow: 0 0 12px rgba(34,211,238,0.28); }
.me-b::before {
  content: ''; position: absolute; top: 0; right: -7px;
  border: 4px solid transparent; border-top-color: #0284c7; border-left-color: #0284c7;
}
.them-b.fatal { border-color: var(--red); }
.them-b.fatal::before { border-top-color: var(--red); border-right-color: var(--red); }

.b-text { color: var(--text); line-height: 1.6; }
.b-text :deep(p) { margin: 0 0 6px; }
.b-text :deep(p:last-child) { margin-bottom: 0; }
.b-text :deep(code) { font-family: Consolas, monospace; font-size: 13px; background: var(--panel-2); border-radius: 3px; padding: 0 4px; }
.b-text :deep(pre) { background: var(--panel-2); border-radius: 6px; padding: 8px; overflow-x: auto; font-size: 12px; }
.b-text :deep(ul), .b-text :deep(ol) { margin: 4px 0; padding-left: 18px; }
.b-error { color: var(--red); white-space: pre-wrap; font-size: 14px; }
/* 消息级模型与消耗标注 */
.b-meta { font-size: 10px; color: var(--text-3); margin: 2px 2px 0; font-family: Consolas, monospace; }
/* 汇报内的验证行 */
.b-verify { margin-top: 6px; font-size: 12px; color: var(--green); background: rgba(7, 193, 96, 0.08); border-left: 3px solid var(--green); border-radius: 4px; padding: 4px 8px; font-family: Consolas, monospace; }

.file-card { background: rgba(22, 32, 48, 0.85); border: 1px solid rgba(56, 189, 248, 0.14); border-radius: 9px; padding: 7px 10px; }
.chips { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 6px; }
.chip { font-size: 11px; color: var(--green); border: 1px solid rgba(52, 245, 197, 0.25); border-radius: 4px; padding: 1px 6px; background: rgba(52, 245, 197, 0.08); }
details { margin-top: 6px; }
details summary { font-size: 12px; color: var(--text-3); }
.pre { max-height: 200px; overflow: auto; background: rgba(5, 10, 16, 0.75); border: 1px solid var(--border); border-radius: 6px; padding: 8px; margin-top: 4px; font-size: 11px; white-space: pre-wrap; font-family: Consolas, monospace; color: #9fe8f5; }

.sys-row { display: flex; flex-direction: column; align-items: center; gap: 2px; margin: 2px 0; }
.sys-text {
  font-size: 12px; color: #ffffff;
  background: rgba(0, 0, 0, 0.22); border-radius: 4px;
  padding: 2px 12px; max-width: 86%; text-align: center;
}
.sys-meta { font-size: 10px; color: rgba(255, 255, 255, 0.55); }

.typing-b { display: flex; align-items: center; gap: 4px; }
.dot-t { width: 6px; height: 6px; border-radius: 50%; background: var(--text-3); animation: bob 1.2s infinite; }
.dot-t:nth-child(2) { animation-delay: 0.15s; }
.dot-t:nth-child(3) { animation-delay: 0.3s; }
@keyframes bob { 0%, 60%, 100% { transform: translateY(0); opacity: 0.4; } 30% { transform: translateY(-4px); opacity: 1; } }
.typing-label { font-size: 11px; color: var(--text-3); margin-left: 4px; max-width: 60vw; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

/* 交付成果卡片 */
.deliv-card {
  display: flex; align-items: center; gap: 10px;
  padding: 10px 14px; text-align: left;
  background: var(--panel); border: 1px solid var(--border);
  border-left: 3px solid var(--accent);
  border-radius: 10px; cursor: pointer; width: 100%;
  transition: transform 0.1s ease;
}
.deliv-card:active { transform: scale(0.98); background: var(--panel-2); }
.dc-ico { font-size: 20px; }
.dc-body { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.dc-title { font-size: 14px; color: var(--text); font-weight: 600; }
.dc-sub { font-size: 11px; color: var(--text-3); }
.dc-arrow { margin-left: auto; color: var(--text-3); font-size: 18px; }

.dl-viewer { height: 100%; display: flex; flex-direction: column; background: var(--bg); }
.dl-head { display: flex; justify-content: space-between; align-items: center; padding: 14px 16px; border-bottom: 1px solid var(--border); background: var(--panel); }
.dl-title { font-size: 16px; font-weight: 600; color: var(--text); }
.dl-body { flex: 1; min-height: 0; overflow-y: auto; -webkit-overflow-scrolling: touch; padding: 14px 16px; font-size: 15px; line-height: 1.6; }
.dl-body :deep(h1) { font-size: 18px; margin: 4px 0 12px; }
.dl-body :deep(h2) { font-size: 15px; margin: 16px 0 8px; border-bottom: 1px solid var(--border); padding-bottom: 4px; }
.dl-body :deep(table) { border-collapse: collapse; margin: 8px 0; width: 100%; }
.dl-body :deep(th), .dl-body :deep(td) { border: 1px solid var(--border); padding: 5px 10px; font-size: 13px; }
.dl-body :deep(code) { font-family: Consolas, monospace; font-size: 13px; background: var(--panel-2); border-radius: 3px; padding: 0 4px; }
</style>
