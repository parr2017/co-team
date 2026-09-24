<template>
  <div ref="wrapEl" class="chat-stream" @scroll.passive="onScroll">
    <div v-if="!cards.length" class="empty">该范围暂无执行记录<br />Agent 开始工作后，这里按节点展示工作会话卡</div>

    <template v-for="card in cards" :key="card.nodeId">
      <section
        class="wf-card"
        :class="{
          running: card.running,
          done: card.status === 'completed',
          failed: card.status === 'failed' || card.status === 'cancelled',
        }"
      >
        <!-- 卡头：归属（agent × 节点）+ 状态 + 统计 -->
        <header class="wf-head">
          <AgentAvatar :name="card.system ? 'supervisor' : card.agent" :size="28" />
          <div class="wf-title">
            <span class="wf-node">{{ card.nodeName }}</span>
            <span class="wf-agent mono">{{ card.agent }}</span>
          </div>
          <span v-if="card.status" class="wf-status mono" :class="card.status">{{ statusText(card.status) }}</span>
        </header>
        <div class="wf-meta mono">
          <span v-if="card.models.length" class="wm-model">{{ card.models.join(' → ') }}</span>
          <span v-if="card.acts.length">{{ card.acts.length }} 轮工具</span>
          <span v-if="card.duration">{{ card.duration }}</span>
          <span v-if="card.tokens">{{ fmtTok(card.tokens) }} tok</span>
          <span v-if="card.startHM">始于 {{ card.startHM }}</span>
        </div>

        <!-- 任务简报（折叠） -->
        <details v-if="card.briefs.length" class="wf-fold">
          <summary><span class="car">▸</span>任务简报 · {{ card.briefs.length }} 条</summary>
          <div v-for="b in card.briefs" :key="b.ts" class="wf-brief b-text md" v-html="md(b.text)"></div>
        </details>

        <!-- 执行步骤（默认折叠，运行中展开） -->
        <details v-if="card.acts.length" class="wf-fold" :open="card.running || undefined">
          <summary><span class="car">▸</span>执行了 {{ card.acts.length }} 步工具调用</summary>
          <div v-for="(a, i) in card.acts" :key="a.key" class="act-group">
            <div v-for="(t, ti) in a.tools" :key="ti" class="act-line">
              <span class="act-idx mono">{{ i + 1 }}.{{ ti + 1 }}</span>
              <span class="act-tool mono">{{ t.tool }}</span>
              <span class="act-args mono" :title="t.arg">{{ t.arg || '—' }}</span>
              <span class="pill mono" :class="t.ok ? 'ok' : 'bad'" :title="t.title || ''">{{ t.label }}</span>
            </div>
          </div>
        </details>

        <!-- live：运行中卡片的当前工具行 -->
        <div v-if="card.running" class="wf-live">
          <div v-for="(tl, i) in liveToolRows" :key="i" class="act-line live">
            <span class="act-idx mono">·</span>
            <span class="act-tool mono">{{ tl.tool }}</span>
            <span class="act-args mono">{{ tl.arg }}</span>
            <span class="pill dim">执行中…</span>
          </div>
          <div class="live-hint mono"><span class="spin" />{{ typing?.text || '工作中…' }}</div>
        </div>

        <!-- 过程旁白：换模型/限流/慢成功/错误，默认折叠为摘要 -->
        <details v-if="card.noises.length" class="wf-fold noise" :open="card.status === 'failed' || undefined">
          <summary>
            <span class="car">▸</span>{{ card.system ? '系统动态' : '过程' }} · <span class="noise-sum mono">{{ noiseSummary(card) }}</span>
          </summary>
          <div v-for="(n, i) in card.noises" :key="i" class="noise-row" :class="n.level">
            <span class="n-ts mono">{{ fmtHM(n.ts) }}</span>
            <span class="n-text mono">{{ n.text }}</span>
          </div>
        </details>

        <!-- 结论（final 汇报，重跑节点可能多条，按时间排列） -->
        <div v-for="f in card.finals" :key="f.ts" class="wf-final">
          <div class="final-head mono">
            结论 · {{ fmtHM(f.ts) }}<template v-if="f.model"> · {{ f.model }}</template>
            <template v-if="f.tokens"> · {{ fmtTok(f.tokens) }} tok</template>
          </div>
          <div v-if="isRawToolJson(f.text)" class="file-card">
            <details class="attach">
              <summary class="mono"><el-icon class="file-ico"><Tools /></el-icon>工具调用消息（原始输出已折叠）</summary>
              <pre class="pre mono">{{ f.text.slice(0, 2000) }}</pre>
            </details>
          </div>
          <div v-else class="b-text md" v-html="md(f.text)"></div>
          <div v-if="f.meta?.verification" class="b-verify mono">验证 · {{ f.meta?.verification }}</div>
          <div v-if="(f.meta?.errors || []).length" class="wf-errors mono">✗ {{ (f.meta?.errors || []).join('；') }}</div>
          <div v-if="(f.meta?.changes || []).length" class="chips mono">
            <span v-for="(c, ci) in (f.meta?.changes || []).slice(0, 8)" :key="ci" class="chip">✓ {{ String(c).split(':')[0] }}</span>
            <span v-if="(f.meta?.changes || []).length > 8" class="chip">+{{ (f.meta?.changes || []).length - 8 }}</span>
          </div>
          <div v-if="(f.meta?.commands || []).length" class="wf-cmds mono">commands: {{ (f.meta?.commands || []).join(' | ') }}</div>
          <div class="wf-ops">
            <el-button size="small" link type="primary" @click="emit('openNode', card.nodeId)">节点详情 →</el-button>
          </div>
        </div>

        <!-- 协作条目：交接 / 留言 / 文档 / 提问 / 交付 / 插话 -->
        <template v-for="(o, oi) in card.others" :key="oi">
          <!-- 接力交接：居中发丝线 -->
          <div v-if="o.kind === 'handoff'" class="wf-handoff mono">
            <span class="ho-line" /><span class="ho-text" :title="o.meta?.handoff">{{ o.text }}</span><span class="ho-line" />
          </div>

          <!-- 留言（send_message 延迟派发 / 回复用户） -->
          <div v-else-if="o.kind === 'message'" class="wf-msg" :class="{ direct: o.meta?.direct }">
            <div class="wm-who mono">
              💬 {{ o.agent }}
              <template v-if="o.meta?.direct"> · 回复你<template v-if="o.meta?.round"> · 第 {{ o.meta.round }} 轮</template></template>
              <template v-else-if="o.meta?.to"> → {{ o.meta.to === 'user' ? '用户' : o.meta.to === 'orchestrator' ? '主 Agent' : o.meta.to }}</template>
              <span v-if="o.meta?.undelivered" class="wm-undelivered">未送达</span>
            </div>
            <div class="b-text md" v-html="md(o.text)"></div>
          </div>

          <div v-else-if="o.kind === 'message_received'" class="wf-msg recv">
            <div class="wm-who mono">💬 收到留言 · 自 {{ o.meta?.from || o.agent }}</div>
            <div class="b-text md" v-html="md(o.text)"></div>
          </div>

          <!-- 协同文档更新 -->
          <div v-else-if="o.kind === 'doc'" class="wf-doc mono" @click="openDoc(o)">
            <el-icon class="dc-ico"><Memo /></el-icon>
            <span class="dc-title">docs/{{ o.meta?.doc_type }}.md → v{{ o.meta?.version }}</span>
            <span class="dc-arrow">›</span>
          </div>

          <!-- 交付成果 -->
          <div v-else-if="o.kind === 'deliverable'" class="deliv-card mono" @click="openDeliverable(o)">
            <el-icon class="dc-ico"><Document /></el-icon>
            <span class="dc-body">
              <span class="dc-title">{{ o.node_name }}</span>
              <span class="dc-sub">交付报告 · 统一模板 · 点击阅读</span>
            </span>
            <span class="dc-arrow">›</span>
          </div>

          <!-- 实时提问（可内联回答） -->
          <div v-else-if="o.kind === 'ask'" class="wf-msg ask">
            <div class="wm-who mono">
              ❓ {{ o.agent }} · 提问
              <span v-if="o.meta?.to === 'user' && !answeredAskIds.has(String(o.meta?.ask_id))" class="ask-live mono">等你回答</span>
            </div>
            <div class="b-text md" v-html="md(o.text)"></div>
            <div v-if="o.meta?.to === 'user' && !answeredAskIds.has(String(o.meta?.ask_id))" class="ask-answer">
              <input
                v-model="answerDrafts[String(o.meta?.ask_id)]"
                class="ask-input mono"
                placeholder="输入回答，agent 将立即继续…"
                @keydown.enter="sendAskAnswer(String(o.meta?.ask_id))"
              />
              <el-button size="small" type="primary" :loading="answeringAsk === String(o.meta?.ask_id)" @click="sendAskAnswer(String(o.meta?.ask_id))">回答</el-button>
            </div>
          </div>

          <!-- 实时回答 -->
          <div v-else-if="o.kind === 'answer' && o.meta?.no_answer" class="wf-noise-row mono">⏱ {{ o.text }}</div>
          <div v-else-if="o.kind === 'answer'" class="wf-msg answer">
            <div class="wm-who mono">{{ o.meta?.by === 'user' ? '你' : o.meta?.by || o.agent }} · 回答</div>
            <div class="b-text md" v-html="md(String(o.text || '').replace(/^.*?回答：/, ''))"></div>
          </div>

          <!-- 用户插话：右侧强调行 -->
          <div v-else-if="o.kind === 'intervene'" class="wf-msg me">
            <div v-if="(o.meta?.images || []).length" class="img-grid">
              <el-image
                v-for="(img, i) in (o.meta?.images || []).map((g: any) => g.url)"
                :key="i"
                class="ph"
                :src="img"
                :preview-src-list="(o.meta?.images || []).map((x: any) => x.url)"
                :initial-index="i"
                preview-teleported
                fit="cover"
              />
            </div>
            <div class="b-text md" v-html="md(o.text)"></div>
            <div class="wm-who mono">你 · {{ fmtHM(o.ts) }}</div>
          </div>
        </template>
      </section>
    </template>

    <!-- 悬浮快捷跳转：默认贴底看最新；上翻后可一键回顶/回底（未读计数提示漏掉的条目） -->
    <div v-if="scrollable" class="wf-jump">
      <button class="jump-btn mono" title="回到顶部" @click="jumpTop">最顶</button>
      <button class="jump-btn mono" @click="jumpBottom">
        最底<em v-if="unread" class="jump-badge">{{ unread > 99 ? '99+' : unread }}</em>
      </button>
    </div>

    <!-- 交付成果阅读器：统一模板固定展现 -->
    <el-dialog v-model="deliverableOpen" :title="deliverableView?.title || '阅读器'" width="720px" top="6vh" append-to-body>
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
import { Document, Memo, Tools } from '@element-plus/icons-vue';
import { computed, nextTick, onUnmounted, ref, watch } from 'vue';
import { ElMessage } from 'element-plus';
import { renderMarkdown as mdShared } from '../utils/md';
import { api, type JournalEntry, type TaskGraph } from '../api';
import { onEvent } from '../composables/useDashboard';
import { statusText } from '../utils/events';
import AgentAvatar from './AgentAvatar.vue';

type Entry = JournalEntry & { agent: string };

const props = defineProps<{ taskId: string; filterAgent?: string; filterNodeId?: string }>();
const emit = defineEmits<{ (e: 'openNode', nodeId: string): void }>();
defineExpose({ scrollToBottom: () => scrollToBottom(true) });

const wrapEl = ref<HTMLElement | null>(null);
const entries = ref<Entry[]>([]);
const task = ref<TaskGraph | null>(null);
let stickToBottom = true;
let unsubFns: (() => void)[] = [];
let loadSeq = 0;
// 快捷跳转：流是否可滚动 + 上翻期间积压的未读条目数
const scrollable = ref(false);
const unread = ref(0);

// live：当前执行态（agent_activity / agent_round），驱动运行中卡片的工具行
interface LiveState { agent: string; nodeId: string; text: string; model?: string; toolCalls: { tool: string; arg: string }[] }
const typing = ref<LiveState | null>(null);

// ---------- 工作会话卡模型 ----------

interface ActTool { tool: string; arg: string; label: string; ok: boolean; title?: string }
interface Act { key: string; tools: ActTool[] }
interface Noise { ts: string; text: string; level: 'info' | 'warn' | 'err' }
interface WorkCard {
  nodeId: string;
  nodeName: string;
  agent: string;
  status: string;
  system: boolean;
  agents: string[];
  models: string[];
  acts: Act[];
  noises: Noise[];
  briefs: Entry[];
  finals: Entry[];
  others: Entry[];
  tokens: number;
  firstTs: string;
  lastTs: string;
  startHM: string;
  duration: string;
  running: boolean;
}

const nodeMeta = computed(() => {
  const m = new Map<string, { name: string; status: string; agent: string; started_at?: string; finished_at?: string }>();
  for (const n of task.value?.nodes || []) m.set(n.id, { name: n.name, status: n.status, agent: n.agent, started_at: n.started_at, finished_at: n.finished_at });
  return m;
});

const filtered = computed(() =>
  entries.value.filter((e) => {
    if (props.filterNodeId && e.node_id !== props.filterNodeId) return false;
    if (props.filterAgent && e.agent !== props.filterAgent) return false;
    return true;
  })
);

/** 过程旁白归类（默认折叠的摘要计数） */
function noiseLevel(text: string, kind: string): Noise['level'] {
  if (kind === 'error') return 'err';
  if (/失败|✗|未通过|错误|异常/.test(text)) return 'err';
  if (/⏳|限流|429|🚫|幻觉|↯/.test(text)) return 'warn';
  return 'info';
}

function fmtHM(ts: string): string {
  if (!ts) return '';
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function fmtDur(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${String(s % 60).padStart(2, '0')}s`;
  return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}m`;
}

function fmtTok(n: number): string {
  if (n >= 10000) return `${(n / 1000).toFixed(1)}k`;
  if (n >= 1000) return `${(n / 1000).toFixed(2)}k`;
  return String(n);
}

/** 轮次文本解析为工具名 + 参数：`read_file:lib/main.dart, exec:flutter analyze` */
function parseRoundTools(text: string): { tool: string; arg: string }[] {
  const body = String(text || '').replace(/^请求读取工具:\s*/, '').replace(/^请求工具:\s*/, '');
  if (!body.trim()) return [];
  return body.split(/,\s*/).filter(Boolean).map((seg) => {
    const i = seg.indexOf(':');
    if (i < 0) return { tool: seg.trim(), arg: '' };
    return { tool: seg.slice(0, i).trim(), arg: seg.slice(i + 1).trim() };
  });
}

/** tool_results 的单项 → pill 文案 */
function resultPill(r: any): { label: string; ok: boolean; title: string } {
  if (!r || typeof r !== 'object') return { label: '—', ok: true, title: '' };
  const tool = String(r.tool || r.name || '');
  if (r.needs_approval) return { label: '待审批', ok: false, title: String(r.stderr || '') };
  if (r.ok) {
    const rc = r.returncode;
    if (typeof rc === 'number' && (tool === 'exec' || tool === 'exec_background')) return { label: `exit ${rc}`, ok: rc === 0, title: String(r.stdout || '').slice(0, 300) };
    const size = typeof r.output === 'string' ? r.output.length : 0;
    return { label: size ? `${size} 字符` : '✓', ok: true, title: '' };
  }
  const msg = String(r.error || r.stderr || '').replace(/\s+/g, ' ').slice(0, 60);
  return { label: msg ? `✗ ${msg}` : '✗', ok: false, title: String(r.error || r.stderr || '') };
}

const cards = computed<WorkCard[]>(() => {
  const byNode = new Map<string, WorkCard>();
  const lastAct = new Map<string, Act>();
  // 系统级条目（node_id 为空串或伪 id，如图里不存在的 'intervene'）合并为一张系统卡——
  // supervisor 汇报/orchestrator 系统播报不属于任何节点，套节点卡会冒充"排队中的 orchestrator 节点"
  const SYSTEM_KEY = '__system__';
  for (const e of filtered.value) {
    const isSystem = !nodeMeta.value.has(e.node_id);
    const key = isSystem ? SYSTEM_KEY : e.node_id;
    let card = byNode.get(key);
    if (!card) {
      const meta = nodeMeta.value.get(e.node_id);
      card = {
        nodeId: key,
        nodeName: isSystem ? '系统消息' : (e.node_name || meta?.name || e.node_id),
        agent: isSystem ? '' : (meta?.agent || e.agent),
        status: isSystem ? '' : (meta?.status || (e.kind === 'final' ? 'completed' : 'pending')),
        system: isSystem,
        agents: [],
        models: [], acts: [], noises: [], briefs: [], finals: [], others: [],
        tokens: 0, firstTs: e.ts, lastTs: e.ts, startHM: '', duration: '', running: false,
      };
      byNode.set(key, card);
    }
    if (!card.agents.includes(e.agent)) card.agents.push(e.agent);
    if (!card.firstTs || (e.ts && e.ts < card.firstTs)) card.firstTs = e.ts;
    if (e.ts && e.ts > card.lastTs) card.lastTs = e.ts;
    if (e.model && !card.models.includes(e.model)) card.models.push(e.model);
    card.tokens += e.tokens || 0;

    switch (e.kind) {
      case 'brief':
        card.briefs.push(e);
        break;
      case 'round': {
        if (e.role === 'master') {
          card.noises.push({ ts: e.ts, text: e.text, level: noiseLevel(e.text, 'round') });
        } else {
          const parsed = parseRoundTools(e.text);
          const act: Act = { key: `${e.ts}:${card.acts.length}`, tools: [] };
          const results = [] as any[];
          card.acts.push(act);
          lastAct.set(e.node_id, act);
          // 该轮结果由紧随其后的 tool_results 条目补齐（下一步）
          if (parsed.length) (act as Act & { _pending?: { tool: string; arg: string }[] })._pending = parsed;
        }
        break;
      }
      case 'tool_results': {
        const act = lastAct.get(e.node_id) || (card.acts.length ? card.acts[card.acts.length - 1] : null);
        const results = (e.meta?.results || []) as any[];
        const pending = act ? ((act as Act & { _pending?: { tool: string; arg: string }[] })._pending || []) : [];
        results.forEach((r, ri) => {
          const pill = resultPill(r);
          const p = pending[ri] || {};
          const toolName = p.tool || String(r?.tool || r?.name || `#${ri + 1}`);
          act?.tools.push({ tool: toolName, arg: p.arg || '', label: pill.label, ok: pill.ok, title: pill.title });
        });
        if (act) delete (act as Act & { _pending?: unknown })._pending;
        break;
      }
      case 'final':
        card.finals.push(e);
        break;
      case 'error':
        card.noises.push({ ts: e.ts, text: e.text, level: 'err' });
        break;
      case 'intervene':
        // 送达/接力回执是过程噪音（回队放大会堆积几十条）——进折叠区；用户原话才是卡片内容
        if (e.meta?.delivered || e.meta?.deferred) {
          card.noises.push({ ts: e.ts, text: e.text, level: 'info' });
        } else {
          card.others.push(e);
        }
        break;
      default:
        card.others.push(e);
    }
  }

  // 节点元数据回填：状态 / 起止时间 / 运行中
  for (const card of byNode.values()) {
    if (card.system) card.agent = card.agents.join(' · ');
    const meta = card.system ? undefined : nodeMeta.value.get(card.nodeId);
    const startMs = meta?.started_at ? new Date(meta.started_at).getTime() : card.firstTs ? new Date(card.firstTs).getTime() : 0;
    const endMs = meta?.finished_at ? new Date(meta.finished_at).getTime() : 0;
    if (startMs) {
      card.startHM = fmtHM(new Date(startMs).toISOString());
      if (endMs && endMs >= startMs) card.duration = fmtDur(endMs - startMs);
      else if (!endMs && card.lastTs) {
        const lastMs = new Date(card.lastTs).getTime();
        if (lastMs >= startMs) card.duration = fmtDur(lastMs - startMs);
      }
    }
    card.running = !!typing.value && typing.value.nodeId === card.nodeId && typing.value.agent === card.agent;
  }
  return [...byNode.values()];
});

function noiseSummary(card: WorkCard): string {
  if (card.system) return `${card.noises.length} 条`;
  const buckets: Record<string, number> = { 换模型: 0, 限流: 0, 慢成功: 0, 重试: 0, 错误: 0, 其他: 0 };
  for (const n of card.noises) {
    const t = n.text;
    if (/↯|切换下一候选|降级|幻觉|🐌|⏳|429|限流/.test(t)) {
      if (/⏳|429|限流/.test(t)) buckets.限流++;
      else buckets.换模型++;
    } else if (/✅|软重试/.test(t)) buckets.重试++;
    else if (n.level === 'err') buckets.错误++;
    else buckets.其他++;
  }
  return Object.entries(buckets).filter(([, n]) => n > 0).map(([k, n]) => `${k}×${n}`).join(' · ') || `${card.noises.length} 条`;
}

const liveToolRows = computed(() => {
  if (!typing.value) return [];
  if (typing.value.toolCalls.length) return typing.value.toolCalls;
  const t = typing.value.text;
  if (!t) return [];
  return parseRoundTools(t).map((x) => ({ tool: x.tool, arg: x.arg }));
});

// ---------- M2 实时问答 ----------

const answeredAskIds = computed(() => {
  const ids = new Set<string>();
  for (const e of entries.value) {
    if (e.kind === 'answer' && e.meta?.ask_id) ids.add(String(e.meta.ask_id));
  }
  return ids;
});
const answerDrafts = ref<Record<string, string>>({});
const answeringAsk = ref('');
async function sendAskAnswer(askId: string) {
  const text = (answerDrafts.value[askId] || '').trim();
  if (!text || answeringAsk.value) return;
  answeringAsk.value = askId;
  try {
    await api.answerAsk(props.taskId, askId, text);
    answerDrafts.value[askId] = '';
    ElMessage.success('已回答，agent 将被唤醒继续');
  } catch (e: any) {
    ElMessage.error(e?.message || '回答失败');
  } finally {
    answeringAsk.value = '';
  }
}

// ---------- 交付成果 / 协同文档阅读器 ----------

const deliverableView = ref<{ title: string; markdown: string; nodeId?: string; defects?: { title: string; detail: string; severity?: string }[] } | null>(null);
const deliverableOpen = computed({
  get: () => deliverableView.value !== null,
  set: (v: boolean) => { if (!v) deliverableView.value = null; },
});
function copyDeliverable() {
  if (!deliverableView.value) return;
  void navigator.clipboard?.writeText(deliverableView.value.markdown).then(() => ElMessage.success('已复制 Markdown')).catch(() => ElMessage.error('复制失败'));
}
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
    void api.getDeliverable(props.taskId, entry.node_id).then((d) => {
      deliverableView.value = { title: '交付成果 · ' + (d.node_name || entry.node_id), markdown: d.markdown, nodeId: entry.node_id, defects: d.defects || [] };
    }).catch(() => { ElMessage.error('交付成果加载失败'); });
  }
}
function openDoc(entry: JournalEntry) {
  const content = entry.meta?.content;
  if (content) {
    deliverableView.value = { title: `协同文档 · docs/${entry.meta?.doc_type}.md (v${entry.meta?.version})`, markdown: content };
  }
}

// ---------- 数据加载 / live 事件 ----------

watch(
  () => props.taskId,
  () => void load(),
  { immediate: true }
);

async function load() {
  // 加载序号防竞态：快速切换任务/筛选时，旧请求结果不得回填覆盖新任务
  const seq = ++loadSeq;
  typing.value = null;
  entries.value = [];
  task.value = null;
  if (!props.taskId) return;
  try {
    const t = await api.getTask(props.taskId);
    if (seq !== loadSeq) return;
    task.value = t;
  } catch {
    /* ignore */
  }
  try {
    const journals = (await api.taskJournals(props.taskId)).journals || {};
    if (seq !== loadSeq) return;
    const all: Entry[] = [];
    for (const [agent, list] of Object.entries(journals)) {
      for (const e of list) all.push({ ...e, agent });
    }
    all.sort((a, b) => (a.ts || '').localeCompare(b.ts || ''));
    entries.value = all;
    await nextTick();
    // 打开即落底：卡片渲染会持续长高，退避重试几次直到贴底
    jumpBottom();
    measureScrollable();
  } catch {
    /* ignore */
  }
}

function parseWsToolCalls(calls: unknown): { tool: string; arg: string }[] {
  if (!Array.isArray(calls)) return [];
  return calls.map((c: any) => ({
    tool: String(c?.tool || ''),
    arg: String(c?.path || c?.command || c?.pattern || c?.name || '').slice(0, 80),
  })).filter((x) => x.tool);
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
      if (props.filterAgent && entry.agent !== props.filterAgent) return;
      // 贴底跟随：用户上翻期间积压未读计数，回底后清零
      if (stickToBottom) {
        void nextTick(() => scrollToBottom());
      } else {
        unread.value++;
      }
      measureScrollable();
    } else if (['agent_activity', 'agent_round'].includes(msg.type) && p.agent) {
      if (props.filterAgent && p.agent !== props.filterAgent) return;
      typing.value = {
        agent: String(p.agent),
        nodeId: String(p.node_id || ''),
        text: msg.type === 'agent_activity' ? String(p.text || '') : `第 ${p.round} 轮对话`,
        model: p.model,
        toolCalls: msg.type === 'agent_round' ? parseWsToolCalls(p.tool_calls) : [],
      };
      // live 行会让运行中卡片变高——贴底跟随并重测
      if (stickToBottom) void nextTick(() => scrollToBottom());
      measureScrollable();
    } else if (msg.type === 'agent_final' && p.agent) {
      if (typing.value && typing.value.agent === p.agent) typing.value = null;
    } else if (['node_error', 'node_cancelled', 'execute_complete', 'execute_failed', 'execute_cancelled'].includes(msg.type)) {
      typing.value = null;
    }
  })
);

function onScroll() {
  const el = wrapEl.value;
  if (!el) return;
  stickToBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
  if (stickToBottom) unread.value = 0;
  scrollable.value = el.scrollHeight - el.clientHeight > 24;
}

function scrollToBottom(force = false) {
  const el = wrapEl.value;
  if (!el) return;
  if (force || stickToBottom) {
    el.scrollTop = el.scrollHeight;
    unread.value = 0;
  }
  scrollable.value = el.scrollHeight - el.clientHeight > 24;
}

/** 打开任务/切 tab 时的默认落点：最新情况在最底部。卡片渲染/图片加载会持续长高，
 *  单帧定位可能差一截——退避重试几次直到贴底。 */
function jumpBottom() {
  stickToBottom = true;
  scrollToBottom(true);
  let tries = 3;
  const retry = () => { if (tries-- > 0) { scrollToBottom(true); setTimeout(retry, 100); } };
  requestAnimationFrame(retry);
}

function jumpTop() {
  const el = wrapEl.value;
  if (!el) return;
  stickToBottom = false;
  el.scrollTop = 0;
  scrollable.value = true;
}

/** 内容尺寸变化后重测可滚动状态（新卡片/live 行都会改变高度） */
function measureScrollable() {
  const el = wrapEl.value;
  if (!el) return;
  scrollable.value = el.scrollHeight - el.clientHeight > 24;
}

/** 弱模型偶发把 tool_calls JSON 当最终消息输出——折叠为可展开卡片而非大段裸 JSON。 */
function isRawToolJson(text: string): boolean {
  return /"tool_calls"\s*:/.test(text || '') && /^\s*\{/.test(text || '');
}

function md(text: string): string {
  return mdShared(text);
}

onUnmounted(() => unsubFns.forEach((u) => u()));
</script>

<style scoped>
.chat-stream { display: flex; flex-direction: column; gap: 10px; padding: 6px 2px; overflow-y: auto; background: var(--bg-page); }
.empty { color: var(--text-3); text-align: center; padding: 24px; font-size: var(--fs-aux); line-height: 1.8; }

/* 悬浮快捷跳转：sticky 吸附滚动视口底部——上翻时浮在可见区底部，滚到底时贴在最后一张卡下 */
.wf-jump { position: sticky; bottom: 8px; margin-top: auto; align-self: flex-end; z-index: 5; display: flex; gap: 6px; }
.jump-btn { font-size: var(--fs-meta); color: var(--text-2); background: var(--bg-raised); border: 1px solid var(--line-strong); border-radius: 12px; padding: 3px 10px; cursor: pointer; }
.jump-btn:hover { color: var(--accent); border-color: var(--accent); }
.jump-badge { font-style: normal; margin-left: 4px; font-size: 10px; color: var(--accent-text); background: var(--accent); border-radius: 8px; padding: 0 5px; }

/* ---------- 工作会话卡 ---------- */
.wf-card { background: var(--bg-panel); border: 1px solid var(--line); border-radius: 10px; padding: 10px 12px; display: flex; flex-direction: column; gap: 8px; }
.wf-card.running { border-color: var(--accent); box-shadow: 0 0 0 1px color-mix(in srgb, var(--accent) 30%, transparent); }
.wf-card.done { border-left: 3px solid var(--ok); }
.wf-card.failed { border-left: 3px solid var(--danger); }

.wf-head { display: flex; align-items: center; gap: 8px; }
.wf-title { display: flex; align-items: baseline; gap: 8px; min-width: 0; flex: 1; }
.wf-node { font-size: 13px; font-weight: 600; color: var(--text-1); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.wf-agent { font-size: var(--fs-meta); color: var(--text-3); }
.wf-status { font-size: var(--fs-meta); flex-shrink: 0; padding: 1px 8px; border-radius: 9px; border: 1px solid var(--line); color: var(--text-3); }
.wf-status.completed { color: var(--ok); border-color: color-mix(in srgb, var(--ok) 35%, transparent); }
.wf-status.failed, .wf-status.cancelled { color: var(--danger); border-color: color-mix(in srgb, var(--danger) 35%, transparent); }
.wf-status.running, .wf-status.retrying { color: var(--accent-text); background: var(--accent); border-color: var(--accent); }
.wf-status.waiting_clarify, .wf-status.waiting_approval { color: var(--warn); border-color: color-mix(in srgb, var(--warn) 35%, transparent); }

.wf-meta { display: flex; flex-wrap: wrap; gap: 4px 10px; font-size: var(--fs-meta); color: var(--text-3); }
.wm-model { color: var(--accent); }

/* ---------- 折叠区（简报 / 执行步骤 / 过程旁白） ---------- */
.wf-fold { border: 1px solid var(--line); border-radius: 6px; background: var(--bg-raised); }
.wf-fold > summary { cursor: pointer; list-style: none; display: flex; align-items: center; gap: 6px; padding: 5px 10px; font-size: var(--fs-aux); color: var(--text-2); }
.wf-fold > summary::-webkit-details-marker { display: none; }
.wf-fold .car { display: inline-block; transition: transform 0.12s ease; color: var(--text-3); font-size: 10px; }
.wf-fold[open] .car { transform: rotate(90deg); }
.noise-sum { color: var(--text-3); }

.wf-brief { padding: 2px 10px 8px; font-size: var(--fs-aux); max-height: 220px; overflow-y: auto; }

.act-group { border-top: 1px dashed var(--line); padding: 4px 10px 6px; display: flex; flex-direction: column; gap: 2px; }
.act-line { display: flex; align-items: center; gap: 8px; font-size: var(--fs-meta); min-width: 0; }
.act-idx { color: var(--text-3); flex-shrink: 0; width: 30px; text-align: right; }
.act-tool { color: var(--accent); flex-shrink: 0; }
.act-args { color: var(--text-2); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; min-width: 0; }
.pill { flex-shrink: 0; font-size: var(--fs-meta); border-radius: 3px; padding: 0 5px; border: 1px solid var(--line); color: var(--text-3); }
.pill.ok { color: var(--ok); border-color: color-mix(in srgb, var(--ok) 30%, transparent); }
.pill.bad { color: var(--danger); border-color: color-mix(in srgb, var(--danger) 35%, transparent); }
.pill.dim { color: var(--text-3); }

.wf-live { padding: 4px 10px 6px; border-top: 1px dashed var(--line); display: flex; flex-direction: column; gap: 2px; }
.act-line.live .act-tool { color: var(--accent); }
.live-hint { display: flex; align-items: center; gap: 6px; font-size: var(--fs-meta); color: var(--text-3); margin-top: 2px; }
.spin { width: 9px; height: 9px; border-radius: 50%; border: 2px solid var(--accent); border-top-color: transparent; animation: wf-spin 0.8s linear infinite; flex-shrink: 0; }
@keyframes wf-spin { to { transform: rotate(360deg); } }

.noise-row { display: flex; gap: 8px; padding: 2px 10px; font-size: var(--fs-meta); }
.noise-row .n-ts { color: var(--text-3); flex-shrink: 0; }
.noise-row .n-text { color: var(--text-2); }
.noise-row.warn .n-text { color: var(--warn); }
.noise-row.err .n-text { color: var(--danger); }

/* ---------- 结论区 ---------- */
.wf-final { border-top: 1px solid var(--line); padding-top: 8px; display: flex; flex-direction: column; gap: 6px; }
.final-head { font-size: var(--fs-meta); color: var(--text-3); }
.b-text { word-break: break-word; color: var(--text-1); line-height: 1.65; font-size: 13px; }
.b-text :deep(p) { margin: 0 0 6px; }
.b-text :deep(p:last-child) { margin-bottom: 0; }
.b-text :deep(code) { font-family: var(--font-mono); font-size: var(--fs-meta); background: var(--bg-raised); border: 1px solid var(--line); border-radius: 3px; padding: 0 4px; }
.b-text :deep(pre) { background: var(--bg-raised); border: 1px solid var(--line); border-radius: 6px; padding: 8px; overflow-x: auto; font-size: var(--fs-meta); }
.b-text :deep(ul), .b-text :deep(ol) { margin: 4px 0; padding-left: 18px; }
.b-text :deep(h1), .b-text :deep(h2), .b-text :deep(h3) { font-size: 13px; margin: 6px 0 4px; }
.b-verify { font-size: var(--fs-meta); color: var(--ok); background: var(--bg-raised); border-left: 3px solid var(--ok); border-radius: 4px; padding: 4px 8px; }
.wf-errors { font-size: var(--fs-meta); color: var(--danger); white-space: pre-wrap; }
.chips { display: flex; flex-wrap: wrap; gap: 4px; }
.chip { font-size: var(--fs-meta); color: var(--ok); border: 1px solid var(--line); border-radius: 3px; padding: 1px 5px; background: var(--bg-page); }
.wf-cmds { font-size: var(--fs-meta); color: var(--text-3); word-break: break-all; }
.wf-ops { display: flex; justify-content: flex-end; }

/* ---------- 协作条目 ---------- */
.wf-handoff { display: flex; align-items: center; gap: 8px; font-size: var(--fs-meta); color: var(--accent); }
.ho-line { flex: 1; height: 1px; background: var(--line-strong); }
.ho-text { max-width: 70%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

.wf-msg { border-left: 3px solid var(--accent); background: var(--bg-raised); border-radius: 0 6px 6px 0; padding: 6px 10px; display: flex; flex-direction: column; gap: 3px; }
.wf-msg.recv { border-left-color: var(--text-3); }
.wf-msg.answer { border-left-color: var(--ok); }
.wf-msg.ask { border-left-color: var(--warn); }
.wf-msg.direct { border-left-color: var(--accent); box-shadow: 0 0 0 1px color-mix(in srgb, var(--accent) 25%, transparent); }
.wm-who { font-size: var(--fs-meta); color: var(--text-3); }
.wm-undelivered { color: var(--warn); }
.wf-msg.me { border-left: none; border-right: 3px solid var(--accent); border-radius: 6px 0 0 6px; background: color-mix(in srgb, var(--accent) 7%, var(--bg-raised)); align-items: flex-end; text-align: right; }
.img-grid { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 6px; }
.img-cell { width: 84px; height: 84px; border-radius: 6px; border: 1px solid var(--line); }
.ask-live { font-size: var(--fs-meta); color: var(--accent-text); background: var(--warn); border-radius: 3px; padding: 1px 5px; margin-left: 6px; vertical-align: 1px; animation: ask-pulse 1.6s ease-in-out infinite; }
@keyframes ask-pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.45; } }
.ask-answer { display: flex; gap: 6px; margin-top: 6px; align-items: center; }
.ask-input { flex: 1; background: var(--bg-panel); border: 1px solid var(--line); border-radius: 4px; color: var(--text-1); font-size: var(--fs-aux); padding: 5px 8px; outline: none; min-width: 0; }
.ask-input:focus { border-color: var(--accent); }

.wf-noise-row { font-size: var(--fs-meta); color: var(--text-3); padding: 2px 4px; }

.wf-doc { display: flex; align-items: center; gap: 8px; font-size: var(--fs-aux); color: var(--text-2); background: var(--bg-raised); border: 1px solid var(--line); border-radius: 6px; padding: 6px 10px; cursor: pointer; }
.wf-doc:hover { border-color: var(--accent); }
.wf-doc .dc-title { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; }
.wf-doc .dc-arrow, .deliv-card .dc-arrow { margin-left: auto; color: var(--text-3); }

/* 交付成果卡片 */
.deliv-card {
  display: flex; align-items: center; gap: 10px;
  padding: 10px 14px;
  background: var(--bg-panel);
  border: 1px solid var(--line-strong);
  border-left: 3px solid var(--accent);
  border-radius: 10px;
  cursor: pointer;
  text-align: left;
  width: 100%;
  transition: border-color 0.12s ease, transform 0.1s ease;
}
.deliv-card:hover { border-color: var(--accent); }
.deliv-card:active { transform: scale(0.98); }
.dc-ico { font-size: 18px; color: var(--accent); flex-shrink: 0; }
.dc-body { display: flex; flex-direction: column; gap: 2px; min-width: 0; flex: 1; }
.dc-title { font-size: 13px; color: var(--text-1); font-weight: 600; }
.dc-sub { font-size: var(--fs-meta); color: var(--text-3); }

/* 原始 tool_calls JSON 折叠 */
.file-card { background: var(--bg-raised); border: 1px solid var(--line); border-radius: 6px; padding: 6px 10px; }
.attach summary { cursor: pointer; font-size: var(--fs-meta); color: var(--text-3); }
.attach .pre { max-height: 180px; overflow: auto; background: var(--bg-page); border-radius: 4px; padding: 6px; margin-top: 4px; font-size: var(--fs-meta); white-space: pre-wrap; }

/* 交付阅读器 */
.deliverable-md { max-height: 62vh; overflow-y: auto; }
.defect-convert { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-bottom: 8px; }
.conv-label { font-size: var(--fs-meta); color: var(--text-3); }
.deliverable-md :deep(h1) { font-size: 17px; margin: 4px 0 10px; }
.deliverable-md :deep(h2) { font-size: 14px; margin: 14px 0 6px; border-bottom: 1px solid var(--line); padding-bottom: 4px; }
.deliverable-md :deep(table) { border-collapse: collapse; margin: 8px 0; }
.deliverable-md :deep(th), .deliverable-md :deep(td) { border: 1px solid var(--line); padding: 4px 10px; font-size: var(--fs-aux); }
</style>
