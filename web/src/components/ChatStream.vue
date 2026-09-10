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

      <!-- 用户介入：右侧绿色气泡（微信群聊"我"的心智）；送达回执/接力为居中灰条（引擎只陈述事实） -->
      <div v-else-if="item.t === 'intervene' && item.entry.meta?.delivered" class="sys-row">
        <span class="sys-text mono ack">✓ {{ item.entry.text }}</span>
      </div>
      <div v-else-if="item.t === 'intervene' && item.entry.meta?.deferred" class="sys-row">
        <span class="sys-text mono relay">↻ {{ item.entry.text }}</span>
      </div>
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
          <div v-if="item.entry.model" class="b-meta mono">{{ item.entry.model }}<template v-if="item.entry.tokens"> · {{ item.entry.tokens }} tok</template></div>
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
          <div v-if="isRawToolJson(item.entry.text)" class="bubble them-b">
            <details class="attach">
              <summary class="mono"><span class="file-ico">🔧</span> 工具调用消息（原始输出已折叠）</summary>
              <pre class="pre mono">{{ item.entry.text.slice(0, 2000) }}</pre>
            </details>
          </div>
          <div v-else class="bubble them-b">
            <div class="b-text md" v-html="md(item.entry.text)"></div>
            <div v-if="item.entry.meta?.verification" class="b-verify mono">验证 · {{ item.entry.meta.verification }}</div>
            <div v-if="(item.entry.meta?.changes || []).length" class="chips mono">
              <span v-for="c in (item.entry.meta?.changes || []).slice(0, 6)" :key="c" class="chip">✓ {{ c }}</span>
            </div>
            <details v-if="(item.entry.meta?.files || []).length || (item.entry.meta?.commands || []).length" class="attach">
              <summary class="mono"><span class="file-ico">📄</span> 附件 · {{ (item.entry.meta?.files || []).length }} 文件 / {{ (item.entry.meta?.commands || []).length }} 命令</summary>
              <pre class="pre mono">files: {{ (item.entry.meta?.files || []).join(', ') }}
commands: {{ (item.entry.meta?.commands || []).join(' | ') }}</pre>
            </details>
          </div>
          <div v-if="item.entry.model" class="b-meta mono">{{ item.entry.model }}<template v-if="item.entry.tokens"> · {{ item.entry.tokens }} tok</template></div>
        </div>
        <AgentAvatar :name="item.agent" :size="36" class="av" />
      </div>

      <!-- 交付成果卡片：点击弹出统一模板阅读器 -->
      <div v-else-if="item.t === 'deliverable'" class="row them">
        <div class="them-col">
          <div class="who-name mono">{{ item.agent }} · 交付成果</div>
          <button class="deliv-card mono" @click="openDeliverable(item.entry)">
            <span class="dc-ico">📄</span>
            <span class="dc-body">
              <span class="dc-title">{{ item.entry.node_name }}</span>
              <span class="dc-sub">交付报告 · 统一模板 · 点击阅读</span>
            </span>
            <span class="dc-arrow">›</span>
          </button>
        </div>
        <AgentAvatar :name="item.agent" :size="36" class="av" />
      </div>

      <!-- Agent 留言（send_message，延迟派发）：左侧气泡，标注收件人；direct=对用户插话的直接回应 -->
      <div v-else-if="item.t === 'message'" class="row them">
        <div class="them-col">
          <div class="who-name mono">
            {{ item.agent }}<template v-if="item.entry.meta?.direct"> · {{ item.entry.node_name }}<template v-if="item.entry.meta?.round"> · 第 {{ item.entry.meta.round }} 轮</template></template><template v-else-if="item.entry.meta?.to"> → {{ item.entry.meta.to === 'user' ? '用户' : (item.entry.meta.to === 'orchestrator' ? '主 Agent' : item.entry.meta.to) }}</template><template v-if="item.entry.meta?.undelivered"> · 未送达</template>
            <span v-if="item.entry.meta?.direct" class="direct-tag mono">回复你</span>
          </div>
          <div class="bubble them-b" :class="{ direct: item.entry.meta?.direct }">
            <div class="b-text md" v-html="md(item.entry.text)"></div>
          </div>
        </div>
        <AgentAvatar :name="item.agent" :size="36" class="av" />
      </div>

      <!-- 协同文档更新卡片：点击弹出阅读器 -->
      <div v-else-if="item.t === 'doc'" class="row them">
        <div class="them-col">
          <div class="who-name mono">{{ item.agent }} · 协同文档</div>
          <button class="deliv-card mono" @click="openDoc(item.entry)">
            <span class="dc-ico">📘</span>
            <span class="dc-body">
              <span class="dc-title">docs/{{ item.entry.meta?.doc_type }}.md → v{{ item.entry.meta?.version }}</span>
              <span class="dc-sub">协同文档更新 · 点击阅读</span>
            </span>
            <span class="dc-arrow">›</span>
          </button>
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
          <div v-if="item.entry.model" class="b-meta mono">{{ item.entry.model }}<template v-if="item.entry.tokens"> · {{ item.entry.tokens }} tok</template></div>
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
    <!-- 交付成果阅读器：统一模板固定展现 -->
    <el-dialog
      v-model="deliverableOpen"
      :title="deliverableView?.title || '阅读器'"
      width="720px"
      top="6vh"
      append-to-body
    >
      <div class="deliverable-md md" v-html="md(deliverableView?.markdown || '')"></div>
      <template #footer>
        <div v-if="deliverableView?.defects?.length" class="defect-convert">
          <span class="mono conv-label">转修复任务：</span>
          <el-button
            v-for="(d, i) in deliverableView.defects"
            :key="i"
            size="small"
            type="primary"
            plain
            :loading="converting === i"
            @click="convertDefect(i)"
          >{{ d.title }}</el-button>
        </div>
        <el-button size="small" @click="copyDeliverable">复制 Markdown</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onUnmounted, ref, watch } from 'vue';
import { ElMessage } from 'element-plus';
import { marked } from 'marked';
import { api, type JournalEntry } from '../api';
import { onEvent } from '../composables/useDashboard';
import AgentAvatar from './AgentAvatar.vue';

type Entry = JournalEntry & { agent: string };
type RenderItem =
  | { t: 'time'; label: string }
  | { t: 'node'; name: string; models: string[] }
  | { t: 'brief' | 'tool_results' | 'round' | 'final' | 'error' | 'intervene' | 'deliverable' | 'message' | 'doc'; entry: Entry; agent: string };

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

const deliverableView = ref<{ title: string; markdown: string; nodeId?: string; defects?: { title: string; detail: string; severity?: string }[] } | null>(null);
const deliverableOpen = computed({
  get: () => deliverableView.value !== null,
  set: (v: boolean) => { if (!v) deliverableView.value = null; },
});
function copyDeliverable() {
  if (deliverableView.value) void navigator.clipboard?.writeText(deliverableView.value.markdown);
}
// P0-2: convert a defect from the open deliverable into a fix task
const converting = ref<number | null>(null);
async function convertDefect(defectIndex: number) {
  const view = deliverableView.value;
  if (!view?.nodeId) return;
  converting.value = defectIndex;
  try {
    const r = await api.convertDefect(props.taskId, view.nodeId, defectIndex, false);
    if (r.status === 'needs_clarification') {
      ElMessage.warning(`修复任务 ${r.fix_task_id} 已创建，等待需求澄清后执行`);
    } else {
      ElMessage.success(`修复任务 ${r.fix_task_id} 已创建（回链至「${view.title}」）`);
    }
  } catch (e: any) {
    ElMessage.error(`转化失败: ${e.message || e}`);
  } finally {
    converting.value = null;
  }
}
function openDeliverable(entry: JournalEntry) {
  const md = entry.meta?.markdown;
  if (md) {
    deliverableView.value = { title: '交付成果 · ' + (entry.node_name || entry.node_id), markdown: md, nodeId: entry.node_id, defects: entry.meta?.defects || [] };
  } else {
    // journal cap may have evicted the body — fetch on demand
    void api.getDeliverable(props.taskId, entry.node_id).then((d) => {
      deliverableView.value = { title: '交付成果 · ' + (d.node_name || entry.node_id), markdown: d.markdown, nodeId: entry.node_id, defects: d.defects || [] };
    }).catch(() => {});
  }
}
/** 协同文档更新卡片：正文随 journal 落盘（截断 16KB），点击即读 */
function openDoc(entry: JournalEntry) {
  const content = entry.meta?.content;
  if (content) {
    deliverableView.value = { title: `协同文档 · docs/${entry.meta?.doc_type}.md (v${entry.meta?.version})`, markdown: content };
  }
}

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
/* 消息级模型与消耗标注 */
.b-meta { font-size: 10px; color: var(--ct-text3); margin: 2px 2px 0; }
/* 汇报内的验证行 */
.b-verify { margin-top: 6px; font-size: 11px; color: var(--ct-green); background: var(--ct-panel2); border-left: 3px solid var(--ct-green); border-radius: 4px; padding: 4px 8px; }
.attach { margin-top: 6px; }
.attach summary { cursor: pointer; font-size: 10px; color: var(--ct-text3); }
.attach .pre { max-height: 180px; overflow: auto; background: var(--ct-bg); border-radius: 4px; padding: 6px; margin-top: 4px; font-size: 10px; white-space: pre-wrap; }

/* 交付成果卡片 */
.deliv-card {
  display: flex; align-items: center; gap: 10px;
  padding: 10px 14px;
  background: var(--ct-panel);
  border: 1px solid var(--ct-border2);
  border-left: 3px solid var(--ct-accent);
  border-radius: 10px;
  cursor: pointer;
  text-align: left;
  transition: border-color 0.12s ease, transform 0.1s ease;
}
.deliv-card:hover { border-color: var(--ct-accent); }
.deliv-card:active { transform: scale(0.98); }
.dc-ico { font-size: 20px; }
.dc-body { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.dc-title { font-size: 13px; color: var(--ct-text); font-weight: 600; }
.dc-sub { font-size: 11px; color: var(--ct-text3); }
.dc-arrow { margin-left: auto; color: var(--ct-text3); font-size: 18px; }
.deliverable-md { max-height: 62vh; overflow-y: auto; }
.defect-convert { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-bottom: 8px; }
.conv-label { font-size: 11px; color: var(--ct-text3); }
.deliverable-md :deep(h1) { font-size: 17px; margin: 4px 0 10px; }
.deliverable-md :deep(h2) { font-size: 14px; margin: 14px 0 6px; border-bottom: 1px solid var(--ct-border); padding-bottom: 4px; }
.deliverable-md :deep(table) { border-collapse: collapse; margin: 8px 0; }
.deliverable-md :deep(th), .deliverable-md :deep(td) { border: 1px solid var(--ct-border); padding: 4px 10px; font-size: 12px; }

/* 居中灰色系统消息（工具动作行） */
.sys-row { display: flex; flex-direction: column; align-items: center; gap: 2px; margin: 2px 0; }
.sys-text { font-size: 11px; color: var(--ct-text3); background: var(--ct-panel2); border-radius: 4px; padding: 2px 12px; max-width: 80%; text-align: center; }
/* 群聊化：送达回执/接力灰条 + direct 回复气泡强调 */
.sys-text.ack { color: #178a3e; background: rgba(23, 138, 62, 0.08); border: 1px solid rgba(23, 138, 62, 0.25); }
.sys-text.relay { color: #b8860b; background: rgba(184, 134, 11, 0.08); border: 1px solid rgba(184, 134, 11, 0.25); }
.direct-tag { font-size: 9px; color: #fff; background: var(--ct-accent); border-radius: 3px; padding: 1px 5px; margin-left: 6px; vertical-align: 1px; }
.bubble.them-b.direct { border-color: var(--ct-accent); box-shadow: 0 0 0 1px rgba(24, 144, 255, 0.25); }
.sys-meta { font-size: 9px; color: var(--ct-text3); }

/* typing */
.typing-b { display: flex; align-items: center; gap: 4px; }
.dot-t { width: 6px; height: 6px; border-radius: 50%; background: var(--ct-text3); animation: bob 1.2s infinite; }
.dot-t:nth-child(2) { animation-delay: 0.15s; }
.dot-t:nth-child(3) { animation-delay: 0.3s; }
@keyframes bob { 0%, 60%, 100% { transform: translateY(0); opacity: 0.4; } 30% { transform: translateY(-4px); opacity: 1; } }
.typing-label { font-size: 10px; color: var(--ct-text3); margin-left: 6px; max-width: 420px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
</style>
