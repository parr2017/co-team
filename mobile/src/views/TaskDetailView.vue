<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { showDialog, showToast } from 'vant';
import { api } from '../api';
import type { TaskGraph, EventEnvelope, NodeDiffResponse } from '../api';
import { useDashboard } from '../composables/useDashboard';
import ChatStream from '../components/ChatStream.vue';
import InterventionInput from '../components/InterventionInput.vue';
import AgentAvatar from '../components/AgentAvatar.vue';
import { describeEvent, statusText, taskStage, type EventView } from '../utils/events';

const route = useRoute();
const router = useRouter();
const { tasks, fetchSingleTask, onEvent } = useDashboard();

const taskId = computed(() => String(route.params.id));
const task = computed<TaskGraph | null>(() => tasks.value[taskId.value] || null);

const tab = ref<'warroom' | 'exec' | 'events'>('warroom');
const selectedAgent = ref('');
const selectedNodeId = ref('');
const events = ref<EventEnvelope[]>([]);
const loadFailed = ref(false);
const notFound = ref(false);
let pollTimer: number | undefined;
let unsub: (() => void) | undefined;

/** WeChat chat-page title: name (member count) */
const title = computed(() => {
  const t = task.value;
  const name = (t?.description || taskId.value).slice(0, 12);
  const count = members.value.length;
  return count ? `${name}(${count})` : name;
});

const progressPct = computed(() => {
  const t = task.value;
  if (!t?.nodes?.length) return 0;
  const done = t.nodes.filter((n) => n.status === 'completed').length;
  return Math.round((done / t.nodes.length) * 100);
});

// 阶段横幅（回答"现在到哪一步了"）
const stageLabel = computed(() => (task.value ? taskStage(task.value.status).label : ''));
const stageFailed = computed(() => task.value?.status === 'failed');

// 任务消耗（Σ 节点 tokens）
const taskTokens = computed(() => (task.value?.nodes || []).reduce((sum, n) => sum + (n.result?.tokens || 0), 0));
function fmtTok(n: number): string {
  return n >= 1000 ? (Math.round(n / 100) / 10) + 'k' : String(n);
}

/** members participating in this task (for the avatar filter strip) */
const members = computed(() => {
  const t = task.value;
  if (!t) return [] as string[];
  return [...new Set(t.nodes.map((n) => n.agent))];
});

const nodeNames = computed<Record<string, string>>(() => {
  const map: Record<string, string> = {};
  for (const n of task.value?.nodes || []) map[n.id] = n.name;
  return map;
});
function nodeName(id?: string): string {
  return (id && nodeNames.value[id]) || '';
}

function eventView(e: EventEnvelope): EventView {
  return describeEvent(e.type, e.payload || {});
}

// 事件 tab：默认隐藏高频心跳（轮次完成/进度广播/聊天流水）
const showAllEvents = ref(false);
const visibleEvents = computed(() =>
  showAllEvents.value ? events.value : events.value.filter((e) => !eventView(e).noisy)
);

// 节点展开内的时间线
function nodeEventsOf(nodeId: string): EventEnvelope[] {
  return events.value.filter((e) => e.payload?.node_id === nodeId);
}

// ---------- 节点代码变更（diff） ----------

const diffNode = ref<{ id: string; name: string } | null>(null);
const diffData = ref<NodeDiffResponse | null>(null);
const diffLoading = ref(false);
const diffOpen = computed({
  get: () => diffNode.value !== null,
  set: (v: boolean) => { if (!v) { diffNode.value = null; diffData.value = null; } },
});

function openDiff(n: { id: string; name: string }) {
  diffNode.value = { id: n.id, name: n.name };
  void loadDiff(n.id);
}

async function loadDiff(nodeId: string) {
  diffLoading.value = true;
  diffData.value = null;
  try {
    diffData.value = await api.nodeDiff(taskId.value, nodeId);
  } catch (e: any) {
    diffData.value = { node_id: nodeId, branch: '', available: false, reason: e.message || '加载失败', patch: '', files: [] };
  } finally {
    diffLoading.value = false;
  }
}

function diffLineClass(line: string): string {
  if (line.startsWith('+++') || line.startsWith('---')) return 'meta';
  if (line.startsWith('+')) return 'add';
  if (line.startsWith('-')) return 'del';
  if (line.startsWith('@@')) return 'hunk';
  if (line.startsWith('diff ') || line.startsWith('index ')) return 'meta';
  return '';
}

const RUNNING_STATES = ['running', 'pending', 'planned', 'retrying', 'waiting_approval'];
const isRunning = computed(() => RUNNING_STATES.includes(task.value?.status || ''));
const canRestart = computed(() => ['failed', 'completed', 'success', 'cancelled'].includes(task.value?.status || ''));

function restart() {
  showDialog({ title: '重启任务', message: '任务将重新进入执行队列（已完成节点会重新执行），确定重启？', showCancelButton: true })
    .then(() => api.executeTask(taskId.value)
      .then(() => { showToast('已重新加入执行队列'); void refresh(); })
      .catch((e) => showToast(e.message)))
    .catch(() => { /* dismissed */ });
}

/** agents currently working (little busy dot on the member strip) */
const busyAgents = computed(() => {
  const s = new Set<string>();
  for (const n of task.value?.nodes || []) {
    if (['running', 'retrying'].includes(n.status)) s.add(n.agent);
  }
  return s;
});

async function refresh() {
  try {
    // direct fetch with error propagation — the store's fetchSingleTask
    // silently swallows 404s, so the page needs its own existence check
    await api.getTask(taskId.value);
    loadFailed.value = false;
    notFound.value = false;
  } catch (e: any) {
    if (String(e.message || '').includes('not found')) notFound.value = true;
    else loadFailed.value = true;
    return; // no point fetching events for a dead task
  }
  await fetchSingleTask(taskId.value);
  try {
    const ev = await api.taskEvents(taskId.value);
    events.value = ev.events;
  } catch { /* ignore */ }
}

watch(taskId, () => {
  selectedAgent.value = '';
  selectedNodeId.value = '';
  tab.value = 'warroom';
  void refresh();
}, { immediate: true });

watch(
  () => task.value?.status,
  () => {
    if (!selectedAgent.value && task.value) {
      const working = task.value.nodes.find((n) => ['running', 'retrying', 'waiting_approval'].includes(n.status));
      if (working) selectedAgent.value = working.agent;
    }
  }
);

unsub = onEvent((msg) => {
  if (msg.payload?.task_id === taskId.value) void fetchSingleTask(taskId.value);
});

// light polling backstop for WS gaps (mobile networks)
pollTimer = window.setInterval(() => {
  if (document.visibilityState === 'visible' && !notFound.value && !loadFailed.value) void refresh();
}, 8000);

onUnmounted(() => {
  window.clearInterval(pollTimer);
  unsub?.();
});

function pickAgent(name: string) {
  selectedAgent.value = selectedAgent.value === name ? '' : name;
}

function pickNode(id: string) {
  selectedNodeId.value = selectedNodeId.value === id ? '' : id;
}

function approve(nodeId: string) {
  api.approveNode(taskId.value, nodeId)
    .then(() => { showToast('已批准，任务恢复执行'); void refresh(); })
    .catch((e) => showToast(e.message));
}

// ---------- agent reassignment (node-level routing override) ----------

const agentOptions = ref<string[]>([]);
const swapVisible = ref(false);
const swapNode = ref<{ id: string; agent: string; name: string } | null>(null);
const swapActions = computed(() => {
  if (!swapNode.value) return [];
  return agentOptions.value
    .filter((a) => a !== 'orchestrator' && a !== swapNode.value!.agent)
    .map((a) => ({ name: a }));
});

function openAgentSwap(n: { id: string; agent: string; name: string }) {
  if (agentOptions.value.filter((a) => a !== 'orchestrator' && a !== n.agent).length === 0) {
    showToast('没有可更换的 Agent');
    return;
  }
  swapNode.value = n;
  swapVisible.value = true;
}

async function onSwapSelect(action: { name: string }) {
  if (!swapNode.value) return;
  const n = swapNode.value;
  swapVisible.value = false;
  try {
    await api.updateNode(taskId.value, n.id, { agent: action.name });
    showToast(`节点已交给 ${action.name}，后续执行生效`);
    void refresh();
  } catch (e: any) {
    showToast(e.message || '更换失败');
  }
}

let agentRetry = 0;
async function loadAgentOptions() {
  try {
    const names = await api.listAgents();
    agentOptions.value = names;
  } catch {
    if (agentRetry < 3) { agentRetry += 1; setTimeout(() => { void loadAgentOptions(); }, 1500 * agentRetry); }
  }
}
void loadAgentOptions();

function cancel() {
  showDialog({ title: '取消任务', message: '确定取消该任务？', showCancelButton: true })
    .then(() => api.cancelTask(taskId.value).then(() => showToast('取消信号已发送')).catch((e) => showToast(e.message)))
    .catch(() => { /* dismissed */ });
}

function fmtTime(ts: string) {
  try { return new Date(ts).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }); } catch { return ts; }
}

function nodeIcon(status: string): string {
  return ({ completed: 'checked', failed: 'close', running: 'clock-o', retrying: 'replay', waiting_approval: 'edit', cancelled: 'cross' } as Record<string, string>)[status] || 'arrow';
}
</script>

<template>
  <div class="page">
    <van-nav-bar :title="title" left-arrow fixed placeholder @click-left="router.back()">
      <template #right>
        <span v-if="isRunning" class="nav-status running" @click="cancel">取消</span>
        <span v-else-if="canRestart" class="nav-status running" @click="restart">重启</span>
        <!-- 状态与进度不在 nav 右侧展示：长文本会与居中标题重叠，完整信息见"执行详情"tab -->
      </template>
    </van-nav-bar>

    <!-- 任务不存在/已删除：明确错误态，替代无限 loading -->
    <template v-if="task">
      <!-- 状态引导条：planned/clarifying 的下一步操作直达（微信"聊天置顶提示条"心智） -->
      <div v-if="task.status === 'planned'" class="action-bar">
        <span class="ab-text">计划已生成，确认后开始执行</span>
        <button class="ab-btn" @click="router.push(`/plan/${taskId}`)">去确认</button>
      </div>
      <div v-else-if="task.status === 'clarifying'" class="action-bar">
        <span class="ab-text">Agent 需要你回复澄清问题</span>
        <button class="ab-btn" @click="router.push(`/clarify/${taskId}`)">去回复</button>
      </div>

      <van-tabs v-model:active="tab" class="tabs" sticky :offset-top="46" line-width="24px">
        <!-- 作战室：微信聊天页 -->
        <van-tab title="聊天" name="warroom">
          <div class="warroom">
            <!-- 阶段条：现在到哪一步 -->
            <div class="stage-strip">
              <span class="ss-state" :class="task.status">{{ stageLabel }}</span>
              <span class="ss-count mono">{{ progressPct }}% · {{ task.nodes.filter((n) => n.status === 'completed').length }}/{{ task.nodes.length }} 节点<template v-if="taskTokens"> · {{ fmtTok(taskTokens) }} tok</template></span>
              <div class="ss-bar"><div class="ss-fill" :class="{ failed: stageFailed }" :style="{ width: progressPct + '%' }"></div></div>
            </div>
            <div class="member-strip">
              <div
                v-for="m in members"
                :key="m"
                class="member"
                :class="{ active: selectedAgent === m }"
                @click="pickAgent(m)"
              >
                <AgentAvatar :name="m" :size="42" :active="selectedAgent === m" />
                <span class="m-name">{{ m }}</span>
                <span v-if="busyAgents.has(m)" class="m-busy"></span>
              </div>
              <div v-if="!members.length" class="no-members">
                <template v-if="task.status === 'clarifying'">需求澄清中，回复后开始规划</template>
                <template v-else-if="task.status === 'planned'">计划待确认，确认后开始执行</template>
                <template v-else>暂无成员</template>
              </div>
            </div>
            <ChatStream :task-id="taskId" :filter-agent="selectedAgent || undefined" />
            <InterventionInput :task-id="taskId" :task-status="task.status" />
          </div>
        </van-tab>

        <!-- 执行详情：微信分组列表 -->
        <van-tab title="执行详情" name="exec">
          <div class="exec">
            <div class="exec-progress wx-group">
              <div class="wx-cell prog-cell">
                <span class="prog-label">{{ statusText(task.status) }}</span>
                <div class="prog-track"><div class="prog-fill" :style="{ width: progressPct + '%' }"></div></div>
                <span class="prog-num">{{ progressPct }}%</span>
              </div>
            </div>

            <div class="wx-group">
              <div
                v-for="n in task.nodes"
                :key="n.id"
                class="wx-cell node-cell"
                :class="n.status"
                @click="pickNode(n.id)"
              >
                <van-icon
                  :name="nodeIcon(n.status)"
                  :size="18"
                  :color="n.status === 'completed' ? '#07c160' : n.status === 'failed' ? '#fa5151' : '#b2b2b2'"
                />
                <div class="n-body">
                  <div class="n-name">{{ n.name }}</div>
                  <div class="n-sub">
                    <span class="n-agent">{{ n.agent }}</span>
                    <span class="n-st" :class="n.status">{{ statusText(n.status) }}</span>
                    <span v-if="n.retry_count" class="n-retry">重试{{ n.retry_count }}</span>
                  </div>
                </div>
                <van-button
                  v-if="n.status === 'waiting_approval'"
                  size="small"
                  round
                  type="primary"
                  @click.stop="approve(n.id)"
                >审批</van-button>
                <van-icon v-else name="arrow" size="14" color="#b2b2b2" />

                <div v-if="selectedNodeId === n.id" class="n-detail">
                  <div class="n-obs mono">
                    <span>{{ n.result?.model || '模型未记录' }}</span>
                    <span v-if="n.result?.tokens"> · {{ fmtTok(n.result.tokens) }} tok</span>
                    <button v-if="n.branch" class="n-diff-btn" @click.stop="openDiff({ id: n.id, name: n.name })">查看代码变更</button>
                  </div>
                  <div v-if="n.status !== 'completed' && agentOptions.length" class="n-swap" @click.stop="openAgentSwap(n)">
                    <span class="n-swap-label">当前 Agent: <b class="mono">{{ n.agent }}</b></span>
                    <van-button size="mini" plain type="primary">更换 Agent</van-button>
                  </div>
                  <div v-if="n.error" class="n-error">✗ {{ n.error }}</div>
                  <div v-if="n.result?.summary" class="n-summary">{{ n.result.summary }}</div>
                  <div v-if="n.result?.verification" class="n-verify">验证 · {{ n.result.verification }}</div>
                  <div v-if="(n.result?.changes || []).length" class="n-changes">
                    <div v-for="c in n.result!.changes!.slice(0, 8)" :key="c" class="change">✓ {{ c }}</div>
                  </div>
                  <div v-if="n.result?.report" class="n-report">
                    <div class="r-title">测试报告 · {{ n.result.report.framework || 'tests' }} · {{ n.result.report.attempts || 0 }} 轮</div>
                    <div class="r-line">{{ n.result.report.summary || '' }}</div>
                    <div v-for="(f, i) in (n.result.report.failures || []).slice(0, 5)" :key="i" class="r-fail">✗ {{ f.name }}: {{ (f.message || '').slice(0, 100) }}</div>
                  </div>
                  <div v-if="nodeEventsOf(n.id).length" class="n-timeline">
                    <div class="nt-title">时间线</div>
                    <div v-for="(e, i) in nodeEventsOf(n.id)" :key="i" class="nt-row">
                      <span class="nt-time mono">{{ fmtTime(e.ts || '') }}</span>
                      <span class="nt-dot" :class="eventView(e).level"></span>
                      <span class="nt-text" :class="eventView(e).level">{{ eventView(e).text }}</span>
                    </div>
                  </div>
                  <ChatStream :task-id="taskId" :filter-node-id="n.id" class="node-chat" />
                </div>
              </div>
            </div>
          </div>
        </van-tab>

        <!-- 事件：中文化时间线，默认隐藏高频心跳 -->
        <van-tab title="事件" name="events">
          <div class="events">
            <div class="ev-toolbar">
              <span class="ev-count mono">显示 {{ visibleEvents.length }} / {{ events.length }} 条</span>
              <span class="ev-toggle" @click="showAllEvents = !showAllEvents">
                <span class="ev-toggle-dot" :class="{ on: showAllEvents }"></span>{{ showAllEvents ? '显示全部' : '仅关键事件' }}
              </span>
            </div>
            <div class="wx-group">
              <div v-for="(e, i) in visibleEvents" :key="i" class="wx-cell event-row">
                <span class="e-time mono">{{ fmtTime(e.ts || '') }}</span>
                <span class="e-dot" :class="eventView(e).level"></span>
                <div class="e-body">
                  <span class="e-text" :class="eventView(e).level">{{ eventView(e).text }}</span>
                  <div class="e-chips">
                    <span v-if="nodeName(e.payload?.node_id)" class="e-node">{{ nodeName(e.payload?.node_id) }}</span>
                    <span v-if="e.payload?.agent" class="e-agent mono">{{ e.payload.agent }}</span>
                  </div>
                </div>
              </div>
            </div>
            <div v-if="!visibleEvents.length" class="empty">
              <van-icon name="clock-o" size="56" color="#b2b2b2" />
              <div class="empty-text">暂无事件</div>
            </div>
          </div>
        </van-tab>
      </van-tabs>
    </template>
    <!-- 任务不存在/已删除：明确错误态，替代无限 loading -->
    <div v-else-if="notFound" class="err-state">
      <van-icon name="info-o" size="56" color="#b2b2b2" />
      <div class="err-title">任务不存在或已被删除</div>
      <div class="err-sub">它可能刚被清理——回到任务列表刷新后重试</div>
      <button class="wx-btn err-btn" @click="router.replace('/tasks')">返回任务列表</button>
    </div>
    <!-- 其他加载失败（网络等）：可重试 -->
    <div v-else-if="loadFailed" class="err-state">
      <van-icon name="warning-o" size="56" color="#fa9d3b" />
      <div class="err-title">加载失败</div>
      <div class="err-sub">无法连接服务器获取任务详情</div>
      <button class="wx-btn err-btn" @click="loadFailed = false; void refresh()">重新加载</button>
    </div>
    <van-loading v-else class="loading" vertical>加载中…</van-loading>

    <!-- 换 Agent：节点转交其他成员（此前重复绑定了两个 sheet，第二个无 @select 导致选中无效） -->
    <van-action-sheet
      v-model:show="swapVisible"
      :actions="swapActions"
      cancel-text="取消"
      close-on-click-action
      title="交给哪位成员"
      @select="onSwapSelect"
    />
    <!-- 节点代码变更阅读器 -->
    <van-popup v-model:show="diffOpen" position="bottom" :style="{ height: '80%' }" round>
      <div class="dl-viewer">
        <div class="dl-head">
          <span class="dl-title">代码变更 · {{ diffNode?.name }}</span>
          <van-icon name="cross" size="18" @click="diffOpen = false" />
        </div>
        <div class="dl-body">
          <div v-if="diffLoading" class="dl-state mono">加载 diff…</div>
          <template v-else-if="diffData">
            <div v-if="!diffData.available" class="dl-state mono">{{ diffData.reason || '暂无代码变更' }}</div>
            <template v-else>
              <div class="dl-files mono">
                <div v-for="f in diffData.files" :key="f.path" class="dl-file">
                  <span class="df-path">{{ f.path }}</span>
                  <span class="df-ins">+{{ f.insertions }}</span>
                  <span class="df-del">−{{ f.deletions }}</span>
                </div>
              </div>
              <pre class="dl-patch mono"><code><span v-for="(line, i) in (diffData.patch || '').split('\n')" :key="i" class="pl" :class="diffLineClass(line)">{{ line === '' ? ' ' : line }}
</span></code></pre>
            </template>
          </template>
        </div>
      </div>
    </van-popup>
  </div>
</template>

<style scoped>
.page { height: 100%; display: flex; flex-direction: column; background: var(--bg); }
.loading { margin: auto; }

/* 404 / 加载失败态 */
.err-state {
  flex: 1; display: flex; flex-direction: column;
  align-items: center; justify-content: center; gap: 8px;
  padding: 0 40px;
}
.err-title { font-size: 17px; font-weight: 600; color: var(--text); margin-top: 8px; }
.err-sub { font-size: 13px; color: var(--text-3); text-align: center; line-height: 1.6; }
.err-btn { margin-top: 24px; max-width: 200px; }

/* nav right status/取消 */
.nav-status { font-size: 14px; color: var(--text-2); font-variant-numeric: tabular-nums; }
.nav-status.running { color: var(--red); text-shadow: var(--glow-red); }

.tabs { flex: 1; min-height: 0; display: flex; flex-direction: column; background: var(--bg); }
.tabs :deep(.van-tabs__content) { flex: 1; min-height: 0; }
.tabs :deep(.van-tab__panel) { height: 100%; }
.tabs :deep(.van-tabs__line) { border-radius: 2px; }

/* 状态引导条：暖色但不刺眼 */
.action-bar {
  display: flex; align-items: center; justify-content: space-between; gap: 10px;
  padding: 10px 16px;
  background: linear-gradient(90deg, rgba(255,180,84,0.12), rgba(255,180,84,0.05)); border-bottom: 1px solid rgba(255, 180, 84, 0.2);
  border-bottom: 1px solid var(--border);
  flex-shrink: 0;
}
.ab-text { font-size: 13.5px; color: var(--wx-orange); font-weight: 500; }
.ab-btn {
  border: none; border-radius: 14px; padding: 4px 16px;
  background: var(--accent); color: #fff; font-size: 13px; font-weight: 600;
  flex-shrink: 0;
  transition: transform 0.1s ease;
}
.ab-btn:active { transform: scale(0.95); background: var(--accent-press); }

/* warroom = WeChat chat page */
.warroom { height: 100%; display: flex; flex-direction: column; background: var(--bg); }
/* 阶段条 */
.stage-strip { display: flex; align-items: center; gap: 10px; padding: 8px 16px; background: rgba(17, 26, 40, 0.92); border-bottom: 1px solid var(--border); flex-shrink: 0; }
.ss-state { font-size: 13px; font-weight: 600; color: var(--text-2); flex-shrink: 0; }
.ss-state.running, .ss-state.retrying { color: var(--wx-orange); }
.ss-state.completed, .ss-state.success { color: var(--green); }
.ss-state.failed { color: var(--red); }
.ss-state.waiting_approval { color: var(--accent); }
.ss-count { font-size: 11px; color: var(--text-3); flex-shrink: 0; font-variant-numeric: tabular-nums; }
.ss-bar { flex: 1; height: 4px; border-radius: 2px; background: var(--panel-2); overflow: hidden; }
.ss-fill { height: 100%; border-radius: 2px; background: linear-gradient(90deg, #22d3ee, #0369a1); transition: width 0.5s ease; }
.ss-fill.failed { background: var(--red); }
.member-strip {
  display: flex; gap: 18px; overflow-x: auto;
  padding: 12px 16px;
  background: rgba(17, 26, 40, 0.92);
  border-bottom: 1px solid var(--border);
  flex-shrink: 0;
  -webkit-overflow-scrolling: touch;
}
.member { display: flex; flex-direction: column; align-items: center; gap: 5px; flex-shrink: 0; position: relative; }
.member:active { opacity: 0.6; }
.m-name { font-size: 11px; color: var(--text-3); }
.member.active .m-name { color: var(--accent); font-weight: 600; }
.m-busy {
  position: absolute; top: 1px; right: 7px;
  width: 9px; height: 9px; border-radius: 50%;
  background: var(--yellow);
  box-shadow: var(--glow-orange);
  animation: wx-pulse 1.6s ease-in-out infinite;
}
.no-members {
  font-size: 13px; color: var(--text-3); align-self: center; padding: 8px 0;
}

/* exec = WeChat grouped list */
.exec { padding: 10px 0 16px; overflow-y: auto; -webkit-overflow-scrolling: touch; height: 100%; }
.prog-cell { gap: 10px; }
.prog-label { font-size: 13px; color: var(--text-2); flex-shrink: 0; font-weight: 500; }
.prog-track { flex: 1; height: 5px; border-radius: 3px; background: var(--panel-2); overflow: hidden; }
.prog-fill { height: 100%; border-radius: 3px; background: linear-gradient(90deg, #22d3ee, #0369a1); box-shadow: 0 0 8px rgba(34, 211, 238, 0.45); transition: width 0.5s ease; }
.prog-num { font-size: 13px; font-weight: 600; color: var(--text-2); width: 42px; text-align: right; font-variant-numeric: tabular-nums; }

.node-cell { flex-wrap: wrap; align-items: center; padding: 14px 16px; }
.node-cell:active { background: var(--panel-2); }
.n-body { flex: 1; min-width: 0; }
.n-name {
  font-size: 16px; font-weight: 500; color: var(--text); line-height: 1.35;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.n-sub { display: flex; gap: 8px; margin-top: 3px; font-size: 12px; color: var(--text-3); align-items: center; }
.n-st.completed { color: var(--green); }
.n-st.failed { color: var(--red); }
.n-st.running, .n-st.retrying { color: var(--wx-orange); }
.n-st.waiting_approval { color: var(--accent); }
.n-retry { color: var(--wx-orange); }

.n-detail { flex-basis: 100%; margin-top: 10px; border-top: 1px solid var(--border); padding-top: 12px; animation: wx-pop-in 0.2s ease; }
.n-obs { display: flex; align-items: center; gap: 6px; font-size: 12px; color: var(--text-3); background: var(--panel-2); border-radius: 8px; padding: 7px 10px; margin-bottom: 8px; }
.n-diff-btn { margin-left: auto; border: none; background: transparent; color: var(--wx-blue); font-size: 12px; font-weight: 600; padding: 2px 4px; }
.n-diff-btn:active { opacity: 0.6; }
.n-swap { display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 8px 10px; margin-bottom: 8px; border: 1px solid var(--border); border-radius: 8px; background: var(--panel-2); }
.n-swap-label { font-size: 12px; color: var(--text-2); }
.n-error { color: var(--red); font-size: 14px; margin-bottom: 8px; white-space: pre-wrap; line-height: 1.5; }
.n-summary { font-size: 14px; color: var(--text-2); margin-bottom: 8px; white-space: pre-wrap; line-height: 1.55; }
.change { font-size: 13px; color: var(--green); margin-bottom: 3px; }
.n-report { background: var(--panel-2); border-radius: 9px; padding: 11px 12px; margin-bottom: 10px; }
.r-title { font-size: 13px; font-weight: 600; color: var(--text-2); margin-bottom: 5px; }
.r-line { font-size: 12.5px; color: var(--text-3); margin-bottom: 5px; line-height: 1.5; }
.r-fail { font-size: 12.5px; color: var(--red); margin-bottom: 3px; line-height: 1.45; }
.node-chat {
  height: 320px; background: var(--bg); border-radius: 10px;
  margin-top: 8px; overflow: hidden; display: flex; flex-direction: column;
}

/* 节点内时间线 */
.n-timeline { margin: 8px 0; border-top: 1px dashed var(--border); padding-top: 8px; }
.nt-title { font-size: 12px; font-weight: 600; color: var(--text-3); margin-bottom: 5px; }
.nt-row { display: flex; align-items: baseline; gap: 7px; padding: 3px 0; font-size: 12.5px; }
.nt-time { font-size: 10.5px; color: var(--text-3); flex-shrink: 0; font-variant-numeric: tabular-nums; }
.nt-dot { width: 6px; height: 6px; border-radius: 50%; flex-shrink: 0; align-self: center; background: var(--text-3); }
.nt-dot.success { background: var(--green); }
.nt-dot.warn { background: var(--wx-orange); }
.nt-dot.error { background: var(--red); }
.nt-dot.accent { background: var(--accent); }
.nt-text { color: var(--text-2); min-width: 0; }
.nt-text.success { color: var(--green); }
.nt-text.error { color: var(--red); }

/* events = 中文化事件流 */
.events { padding: 10px 0 16px; height: 100%; overflow-y: auto; -webkit-overflow-scrolling: touch; }
.ev-toolbar { display: flex; align-items: center; justify-content: space-between; padding: 2px 16px 8px; }
.ev-count { font-size: 11px; color: var(--text-3); }
.ev-toggle { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; color: var(--text-2); }
.ev-toggle-dot { width: 26px; height: 15px; border-radius: 8px; background: var(--panel-2); border: 1px solid var(--border); position: relative; }
.ev-toggle-dot::after { content: ''; position: absolute; top: 1px; left: 1px; width: 11px; height: 11px; border-radius: 50%; background: var(--text-3); transition: transform 0.15s; }
.ev-toggle-dot.on { background: rgba(7, 193, 96, 0.25); border-color: var(--green); }
.ev-toggle-dot.on::after { transform: translateX(11px); background: var(--green); }
.event-row { flex-wrap: wrap; align-items: baseline; gap: 6px; padding: 11px 16px; }
.e-time { font-size: 11px; color: var(--text-3); font-variant-numeric: tabular-nums; flex-shrink: 0; }
.e-dot { width: 7px; height: 7px; border-radius: 50%; flex-shrink: 0; align-self: center; background: var(--text-3); }
.e-dot.success { background: var(--green); }
.e-dot.warn { background: var(--wx-orange); }
.e-dot.error { background: var(--red); }
.e-dot.accent { background: var(--accent); }
.e-body { flex-basis: 100%; display: flex; flex-direction: column; gap: 3px; }
.e-text { font-size: 13.5px; color: var(--text-2); line-height: 1.5; }
.e-text.success { color: var(--green); }
.e-text.error { color: var(--red); }
.e-chips { display: flex; gap: 6px; flex-wrap: wrap; }
.e-node { font-size: 11px; color: var(--wx-blue); background: rgba(76, 194, 255, 0.08); border: 1px solid rgba(76, 194, 255, 0.2); border-radius: 4px; padding: 0 6px; }
.e-agent { font-size: 11px; color: var(--text-3); border: 1px solid var(--border); border-radius: 4px; padding: 0 6px; }

/* diff 阅读器 */
.dl-viewer { height: 100%; display: flex; flex-direction: column; background: var(--bg); }
.dl-head { display: flex; justify-content: space-between; align-items: center; padding: 14px 16px; border-bottom: 1px solid var(--border); background: var(--panel); }
.dl-title { font-size: 15px; font-weight: 600; color: var(--text); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dl-body { flex: 1; min-height: 0; overflow-y: auto; -webkit-overflow-scrolling: touch; padding: 12px 14px; }
.dl-state { text-align: center; color: var(--text-3); font-size: 13px; padding: 40px 0; }
.dl-files { display: flex; flex-direction: column; border: 1px solid var(--border); border-radius: 8px; overflow: hidden; margin-bottom: 10px; }
.dl-file { display: flex; align-items: center; gap: 8px; padding: 6px 10px; font-size: 11px; border-bottom: 1px solid var(--border); background: var(--panel-2); }
.dl-file:last-child { border-bottom: none; }
.df-path { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--text-2); }
.df-ins { color: var(--green); }
.df-del { color: var(--red); }
.dl-patch { margin: 0; background: rgba(5, 10, 16, 0.75); border: 1px solid var(--border); border-radius: 8px; padding: 10px; font-size: 11px; line-height: 1.5; overflow-x: auto; }
.dl-patch code { display: block; font-family: inherit; }
.pl { display: block; white-space: pre-wrap; word-break: break-all; color: var(--text-2); }
.pl.add { background: rgba(7, 193, 96, 0.12); color: var(--green); }
.pl.del { background: rgba(250, 81, 81, 0.10); color: var(--red); }
.pl.hunk { color: var(--wx-blue); background: rgba(76, 194, 255, 0.08); }
.pl.meta { color: var(--text-3); }

.empty { display: flex; flex-direction: column; align-items: center; gap: 6px; padding: 72px 0; }
.empty-text { font-size: 13px; color: var(--text-3); }
</style>
