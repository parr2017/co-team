<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { showDialog, showConfirmDialog, showToast } from 'vant';
import { marked } from 'marked';
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
// M10-A：聊天长按"引用"→ 介入输入框预填
const quoteDraft = ref('');

// ---------- M10-C 澄清答复卡 / 全局目标 / 快照 ----------
const clarifyNode = computed(() => (task.value?.nodes || []).find((n) => n.status === 'waiting_clarify') || null);
const clarifyBrief = ref<any>(null);
const clarifyAnswers = ref<Record<string, string>>({});
const clarifySending = ref(false);
const clarifyLoadedFor = ref('');
watch(clarifyNode, async (n) => {
  if (!n || clarifyLoadedFor.value === `${taskId.value}:${n.id}`) return;
  clarifyLoadedFor.value = `${taskId.value}:${n.id}`;
  clarifyBrief.value = null;
  try {
    const d: any = await api.getNodeClarify(taskId.value, n.id);
    clarifyBrief.value = d.brief || null;
  } catch { /* ignore */ }
});
async function submitClarify() {
  if (!clarifyNode.value) return;
  const answers = Object.entries(clarifyAnswers.value)
    .filter(([, a]) => String(a || '').trim())
    .map(([qi, answer]) => ({ question: clarifyBrief.value?.questions?.[Number(qi)] || '', answer: String(answer).trim() }));
  clarifySending.value = true;
  try {
    await api.clarifyNode(taskId.value, clarifyNode.value.id, { answers, approve: true });
    showToast('已提交，节点继续执行');
    clarifyAnswers.value = {};
    await refresh();
  } catch (e: any) {
    showToast(e?.message || '提交失败');
  } finally {
    clarifySending.value = false;
  }
}

const goalContent = ref('');
async function loadGoal() {
  try {
    const d: any = await api.getTaskGoal(taskId.value);
    goalContent.value = d.content || '';
  } catch { goalContent.value = ''; }
}
const goalEditing = ref(false);
const goalDraft = ref('');
const goalSaving = ref(false);
watch(goalEditing, async (v) => {
  if (!v) return;
  try {
    const d: any = await api.getTaskGoal(taskId.value);
    goalDraft.value = d.content || '';
  } catch { goalDraft.value = ''; }
});
async function saveGoal() {
  goalSaving.value = true;
  try {
    await api.updateTaskGoal(taskId.value, goalDraft.value.trim());
    showToast('全局目标已更新');
    goalEditing.value = false;
  } catch (e: any) {
    showToast(e?.message || '保存失败');
  } finally {
    goalSaving.value = false;
  }
}

const snapshots = ref<any[]>([]);
const snapBusy = ref('');
async function loadSnapshots() {
  try {
    snapshots.value = ((await api.listSnapshots()) as any).snapshots?.filter((s: any) => s.task_id === taskId.value) || [];
  } catch { snapshots.value = []; }
}
async function doRollback(snapshotId: string) {
  try {
    await showConfirmDialog({ title: '回滚确认', message: '工作区与协作状态将回滚到该快照，不可撤销。确定回滚？' });
  } catch { return; }
  snapBusy.value = snapshotId;
  try {
    await api.rollbackSnapshot(taskId.value, snapshotId, true);
    showToast('已回滚');
    await loadSnapshots();
    await refresh();
  } catch (e: any) {
    showToast(e?.message || '回滚失败');
  } finally {
    snapBusy.value = '';
  }
}
// M3 监督者提案
const proposals = ref<any[]>([]);
const acceptanceReport = ref<any>(null);
const deciding = ref('');
const pendingProposals = computed(() => proposals.value.filter((p) => p.status === 'pending'));
async function loadProposals() {
  try {
    proposals.value = (await api.listProposals(taskId.value)).proposals || [];
    acceptanceReport.value = (await api.acceptanceReport(taskId.value)).report;
  } catch { /* ignore */ }
}
async function decideProposal(proposalId: string, approved: boolean) {
  deciding.value = proposalId;
  try {
    await api.decideProposal(taskId.value, proposalId, approved);
    showToast(approved ? '提案已批准并执行' : '提案已拒绝');
    await loadProposals();
    await refresh();
  } catch (e: any) {
    showToast(e?.message || '操作失败');
  } finally {
    deciding.value = '';
  }
}
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

// ---------- A3 合并 · A2 协同文档 · A1 实时产出 ----------
const merging = ref(false);
const docsOpen = ref(false);
const docsList = ref<{ type: string; version: number; updated_by: string; content: string }[]>([]);
const docView = ref<{ title: string; content: string } | null>(null);
const outputOpen = ref(false);
const outputAvailable = ref(false);
const outputFiles = ref<string[]>([]);
const outputFile = ref<{ path: string; content: string } | null>(null);

function showMerge() {
  if (merging.value) return;
  showDialog({ title: '合并成果', message: '先试运行检查冲突（不改任何文件），通过后再确认合并到主分支？', showCancelButton: true })
    .then((r) => {
      if (r !== 'confirm') return;
      merging.value = true;
      api.mergeTask(taskId.value, true)
        .then((res) => {
          merging.value = false;
          if (!res.ok) { showToast(res.message || '试运行未通过'); return; }
          showDialog({ title: '试运行通过', message: res.message + '，确认合并？', showCancelButton: true })
            .then((r2) => {
              if (r2 !== 'confirm') return;
              merging.value = true;
              api.mergeTask(taskId.value, false)
                .then((res2) => {
                  showToast(res2.message || (res2.ok ? '合并成功' : '合并失败'));
                  void refresh();
                })
                .catch((e) => showToast(e.message))
                .finally(() => { merging.value = false; });
            });
        })
        .catch((e) => { merging.value = false; showToast(e.message); });
    });
}

async function openDocs() {
  try {
    const r = await api.taskDocs(taskId.value);
    docsList.value = r.docs || [];
    docsOpen.value = true;
  } catch (e: any) {
    showToast(e.message || '加载协同文档失败');
  }
}

async function openOutput() {
  try {
    const r = await api.taskOutput(taskId.value);
    outputAvailable.value = r.available;
    outputFiles.value = r.files || [];
    outputOpen.value = true;
  } catch (e: any) {
    showToast(e.message || '加载产出失败');
  }
}

function renderMd(text: string): string {
  const escaped = (text || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return String(marked.parse(escaped, { async: false, breaks: true }));
}

async function viewOutputFile(path: string) {
  try {
    outputFile.value = await api.taskOutputFile(taskId.value, path);
  } catch (e: any) {
    showToast(e.message || '读取文件失败');
  }
}

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
  void loadProposals();
  void loadGoal();
  void loadSnapshots();
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

// P0-2: convert a structured defect into a fix task with a backlink
const converting = ref('');
function convertDefect(nodeId: string, defectIndex: number) {
  converting.value = nodeId + ':' + defectIndex;
  api.convertDefect(taskId.value, nodeId, defectIndex, false)
    .then((r) => {
      showToast(r.status === 'needs_clarification' ? `修复任务 ${r.fix_task_id} 已创建，待澄清后执行` : `修复任务 ${r.fix_task_id} 已创建`);
      void refresh();
    })
    .catch((e) => showToast(e.message || '转化失败'))
    .finally(() => { converting.value = ''; });
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
      <div v-else-if="task.status === 'success'" class="action-bar">
        <span class="ab-text">成果已交付</span>
        <button class="ab-btn" @click="showMerge">合并</button>
        <button class="ab-btn" @click="openDocs">文档</button>
        <button class="ab-btn" @click="openOutput">产出</button>
      </div>

      <van-tabs v-model:active="tab" class="tabs" sticky :offset-top="46" line-width="24px">
        <!-- 任务频道：微信聊天页 -->
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
                <template v-else-if="task.status === 'pending' && !task.nodes.length">团队评估需求中，请稍候…</template>
                <template v-else>暂无成员</template>
              </div>
            </div>
            <ChatStream :task-id="taskId" :filter-agent="selectedAgent || undefined" @quote="quoteDraft = $event" @open-node="pickNode" />
            <InterventionInput :task-id="taskId" :task-status="task.status" :prefill="quoteDraft" />
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

            <!-- M10-C 澄清答复卡：waiting_clarify 节点从手机解堵 -->
            <div v-if="clarifyNode" class="wx-group">
              <div class="wx-cell">
                <div class="sup-title">节点「{{ clarifyNode.name }}」等待澄清确认</div>
                <div v-if="clarifyBrief" class="cl-brief">{{ clarifyBrief.approach }}</div>
                <div v-if="clarifyBrief?.questions?.length" class="cl-q">
                  <div v-for="(q, qi) in clarifyBrief.questions" :key="qi" class="cl-q-row">
                    <div class="cl-q-text">{{ Number(qi) + 1 }}. {{ q }}</div>
                    <input v-model="clarifyAnswers[String(qi)]" class="cl-a" placeholder="你的回答…" />
                  </div>
                </div>
                <div class="cl-actions">
                  <van-button size="small" type="primary" :loading="clarifySending" @click="submitClarify">确认并继续</van-button>
                  <van-button size="small" plain @click="router.push(`/clarify/${taskId}`)">完整澄清页</van-button>
                </div>
              </div>
            </div>

            <!-- M10-C 全局目标：查看/编辑 -->
            <div class="wx-group">
              <div class="wx-cell">
                <div class="sup-title">全局目标</div>
                <div class="goal-text">{{ goalContent || '（未设置）' }}</div>
                <div v-if="goalEditing" class="cl-actions">
                  <textarea v-model="goalDraft" class="goal-area" rows="3"></textarea>
                  <van-button size="small" type="primary" :loading="goalSaving" @click="saveGoal">保存</van-button>
                  <van-button size="small" plain @click="goalEditing = false">取消</van-button>
                </div>
                <van-button v-else size="small" plain @click="goalEditing = true">编辑</van-button>
              </div>
            </div>

            <!-- M10-C 快照：列表 + 一键回滚（二次确认） -->
            <div class="wx-group">
              <div class="wx-cell">
                <div class="sup-title">快照</div>
                <div v-if="snapshots.length" class="snap-list">
                  <div v-for="s in snapshots.slice(0, 5)" :key="s.id" class="snap-row">
                    <span class="mono">{{ s.tag }} · {{ fmtTime(s.created_at) }}</span>
                    <van-button size="mini" plain :loading="snapBusy === s.id" @click="doRollback(s.id)">回滚</van-button>
                  </div>
                </div>
                <div v-else class="cl-note">暂无快照</div>
              </div>
            </div>

            <div v-if="acceptanceReport" class="wx-group">
              <div class="wx-cell">
                <div class="sup-title">最终验收报告 · {{ (acceptanceReport.platforms || []).join('/') }}</div>
                <div v-for="item in acceptanceReport.items" :key="item.id" class="acc-item">
                  <span class="acc-badge" :class="item.status">{{ item.status === 'done' ? '✓' : item.status === 'failed' ? '✗' : '…' }}</span>
                  <div class="acc-body">
                    <div class="acc-req">{{ item.requirement }}</div>
                    <div class="acc-note">{{ item.evidence || item.audit_note || (item.evidence_type + ' · 待人工裁决') }}</div>
                  </div>
                </div>
                <div class="acc-note">E2E: {{ acceptanceReport.e2e?.note }}</div>
              </div>
            </div>

            <div v-if="pendingProposals.length" class="wx-group">
              <div class="wx-cell">
                <div class="sup-title">监督者提案 · 待批准</div>
                <div v-for="p in pendingProposals" :key="p.id" class="sup-row">
                  <span class="sup-reason">{{ p.reason || p.type }}</span>
                  <div class="sup-actions">
                    <van-button size="small" round type="primary" :loading="deciding === p.id" @click="decideProposal(p.id, true)">批准</van-button>
                    <van-button size="small" round :loading="deciding === p.id" @click="decideProposal(p.id, false)">拒绝</van-button>
                  </div>
                </div>
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
                  :color="n.status === 'completed' ? 'var(--green)' : n.status === 'failed' ? 'var(--red)' : '#b2b2b2'"
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
                  <div v-if="(n.result?.defects || []).length" class="n-defects">
                    <div class="d-card-title">发现未修复的缺陷（{{ n.result!.defects!.length }}）</div>
                    <div v-for="(d, i) in n.result!.defects" :key="i" class="d-item">
                      <div class="d-head">
                        <span class="d-sev" :class="d.severity || 'low'">{{ d.severity || 'low' }}</span>
                        <span class="d-title">{{ d.title }}</span>
                      </div>
                      <div class="d-detail">{{ d.detail }}</div>
                      <van-button size="mini" plain type="primary" :loading="converting === n.id + ':' + i" @click.stop="convertDefect(n.id, i)">转修复任务</van-button>
                    </div>
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
      <van-icon name="warning-o" size="56" color="var(--yellow)" />
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

    <!-- A2 协同文档列表 -->
    <van-popup v-model:show="docsOpen" position="bottom" :style="{ height: '70%' }" round>
      <div class="dl-viewer">
        <div class="dl-head">
          <span class="dl-title">协同文档（SSOT）</span>
          <van-icon name="cross" size="18" @click="docsOpen = false" />
        </div>
        <div class="dl-body">
          <div v-if="!docsList.length" class="dl-state">暂无协同文档</div>
          <div v-for="d in docsList" :key="d.type" class="docs-row" @click="docView = { title: `docs/${d.type}.md（v${d.version}）`, content: d.content }">
            <span class="docs-name">📘 docs/{{ d.type }}.md · v{{ d.version }}</span>
            <span class="docs-meta">{{ d.updated_by }}</span>
          </div>
        </div>
      </div>
    </van-popup>

    <!-- A2 文档内容查看 -->
    <van-popup :show="!!docView" position="bottom" :style="{ height: '82%' }" round @update:show="(v: boolean) => { if (!v) docView = null; }">
      <div class="dl-viewer">
        <div class="dl-head">
          <span class="dl-title">{{ docView?.title }}</span>
          <van-icon name="cross" size="18" @click="docView = null" />
        </div>
        <div class="dl-body md" v-html="renderMd(docView?.content || '')"></div>
      </div>
    </van-popup>

    <!-- A1 实时产出视图 -->
    <van-popup v-model:show="outputOpen" position="bottom" :style="{ height: '80%' }" round>
      <div class="dl-viewer">
        <div class="dl-head">
          <span class="dl-title">实时产出（沙箱 · 只读）</span>
          <van-icon name="cross" size="18" @click="outputOpen = false" />
        </div>
        <div class="dl-body">
          <div v-if="!outputAvailable" class="dl-state">沙箱已清理或任务未在沙箱中执行</div>
          <template v-else>
            <div v-if="outputFile" class="out-file">
              <div class="docs-name mono">{{ outputFile.path }}</div>
              <pre class="out-pre">{{ outputFile.content }}</pre>
            </div>
            <div class="out-list">
              <div v-for="f in outputFiles" :key="f" class="docs-row" @click="viewOutputFile(f)">
                <span class="docs-name">📄 {{ f }}</span>
              </div>
              <div v-if="!outputFiles.length" class="dl-state">暂无文件</div>
            </div>
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

.tabs { flex: 1; min-height: 0; display: flex; flex-direction: column; background: var(--bg); }
.tabs :deep(.van-tabs__content) { flex: 1; min-height: 0; }
.tabs :deep(.van-tab__panel) { height: 100%; }
.tabs :deep(.van-tabs__line) { border-radius: 2px; }

/* 状态引导条：暖色但不刺眼 */
.action-bar {
  display: flex; align-items: center; justify-content: space-between; gap: 10px;
  padding: 10px 16px;
  background: var(--ct-yellow-soft); border-bottom: 1px solid var(--border);
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

/* M5 验收报告 */
.acc-item { display: flex; gap: 8px; align-items: flex-start; padding: 4px 0; }
.acc-badge { font-weight: 700; flex-shrink: 0; }
.acc-badge.done { color: var(--green); }
.acc-badge.failed { color: var(--red); }
.acc-badge.open { color: var(--yellow); }
.acc-body { min-width: 0; flex: 1; }
.acc-req { font-size: 12px; }
.acc-note { font-size: 11px; opacity: 0.7; }

/* M3 监督者提案 */
.sup-title { font-size: 12px; font-weight: 600; color: var(--yellow); margin-bottom: 6px; }
.sup-row { display: flex; justify-content: space-between; align-items: center; gap: 8px; padding: 4px 0; }
.sup-reason { font-size: 12px; flex: 1; min-width: 0; }
.sup-actions { display: flex; gap: 4px; flex-shrink: 0; }
.ss-count { font-size: 11px; color: var(--text-3); flex-shrink: 0; font-variant-numeric: tabular-nums; }
.ss-bar { flex: 1; height: 4px; border-radius: 2px; background: var(--panel-2); overflow: hidden; }
.ss-fill { height: 100%; border-radius: 2px; background: var(--accent); transition: width 0.4s ease; }
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
.prog-fill { height: 100%; border-radius: 3px; background: var(--accent); transition: width 0.4s ease; }
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
.n-defects { background: var(--panel-2); border-radius: 9px; padding: 11px 12px; margin-bottom: 10px; }
.d-card-title { font-size: 13px; font-weight: 600; color: var(--text-2); margin-bottom: 8px; }
.d-item { padding: 6px 0; border-bottom: 1px dotted var(--border); }
.d-item:last-child { border-bottom: none; }
.d-head { display: flex; align-items: center; gap: 6px; }
.d-sev { font-size: 10px; border: 1px solid currentColor; border-radius: 3px; padding: 0 5px; flex-shrink: 0; }
.d-sev.high { color: var(--red); }
.d-sev.medium { color: var(--wx-orange); }
.d-sev.low { color: var(--text-3); }
.d-title { font-size: 13px; font-weight: 600; color: var(--text); }
.d-detail { font-size: 12px; color: var(--text-2); margin: 4px 0 6px; line-height: 1.5; white-space: pre-wrap; }
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

.docs-row { display: flex; align-items: center; justify-content: space-between; padding: 10px 4px; border-bottom: 1px solid var(--border); }
.docs-name { font-size: 13px; color: var(--text); }
.docs-meta { font-size: 11px; color: var(--text-3); }
.out-list { margin-top: 10px; }
.out-file { margin-bottom: 10px; }
.out-pre { max-height: 260px; overflow: auto; background: rgba(5, 10, 16, 0.75); border: 1px solid var(--border); border-radius: 8px; padding: 10px; font-size: 11px; white-space: pre-wrap; color: #9fe8f5; }
.empty { display: flex; flex-direction: column; align-items: center; gap: 6px; padding: 72px 0; }
.empty-text { font-size: 13px; color: var(--text-3); }
</style>
