<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { showToast, showConfirmDialog } from 'vant';
import { api, statusLabel } from '../api';
import { useTheme } from '../composables/useTheme';
import StatusTag from '../components/StatusTag.vue';
import type { TaskGraph, QueueSnapshot } from '../api';
import { useDashboard } from '../composables/useDashboard';
import AgentAvatar from '../components/AgentAvatar.vue';

defineOptions({ name: 'TaskListView' });

const router = useRouter();
const { theme, toggle } = useTheme();
// M10-C 今日概览 + 审批入口
const sys = ref<any>(null);
let sysTimer: ReturnType<typeof setInterval> | null = null;
onMounted(() => {
  const load = () => void api.status().then((d) => { sys.value = d; }).catch(() => {});
  load();
  sysTimer = setInterval(load, 15000);
});
onUnmounted(() => { if (sysTimer) clearInterval(sysTimer); });
function fmtTok(n: number): string { return n >= 1000000 ? (n / 1000000).toFixed(1) + 'M' : n >= 1000 ? (n / 1000).toFixed(1) + 'k' : String(n); }
const runningCount = computed(() => Object.values(tasks.value).filter((t) => ['running', 'retrying'].includes(t.status)).length);
const humanCount = computed(() => Object.values(tasks.value).filter((t) => ['waiting_approval', 'clarifying'].includes(t.status)).length);
const { loadTasks, tasks } = useDashboard();

const keyword = ref('');
const list = ref<TaskGraph[]>([]);
const total = ref(0);
const page = ref(1);
const loading = ref(false);
const refreshing = ref(false);
const finished = ref(false);
const error = ref('');

const PAGE_SIZE = 20;

const sorted = computed(() => [...list.value].sort((a, b) => (b.updated_at || '').localeCompare(a.updated_at || '')));
const visible = computed(() => sorted.value.filter(matchesFilter));

/** the agent leading this task drives the conversation avatar */
function avatarAgent(t: TaskGraph): string {
  const working = t.nodes.find((n) => ['running', 'retrying', 'waiting_approval'].includes(n.status));
  if (working) return working.agent;
  return t.nodes.find((n) => n.agent !== 'orchestrator')?.agent || 'dev';
}

/** top-right time like the WeChat session list (今天 14:32 / 昨天 / MM月DD日) */
function sessionTime(ts?: string): string {
  if (!ts) return '';
  const d = new Date(ts);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  if (sameDay) return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  const yesterday = new Date(now); yesterday.setDate(now.getDate() - 1);
  if (d.toDateString() === yesterday.toDateString()) return '昨天';
  return `${d.getMonth() + 1}月${d.getDate()}日`;
}

/** red-dot: needs my attention (approval / clarification) */
function needsAttention(t: TaskGraph): boolean {
  return t.status === 'waiting_approval' || t.status === 'waiting_clarify' || t.status === 'clarifying' || t.nodes.some((n) => n.status === 'waiting_approval' || n.status === 'waiting_clarify');
}

// project id → name map so rows can show their project tag
const projectNames = ref<Record<string, string>>({});
void api.listProjects().then((d) => {
  const map: Record<string, string> = {};
  for (const p of d.projects || []) map[p.id] = p.name;
  projectNames.value = map;
}).catch(() => { /* ignore */ });

/** corner badge count: pending approvals + clarification requests */
function badgeCount(t: TaskGraph): number {
  const approvals = t.nodes.filter((n) => n.status === 'waiting_approval').length;
  return (t.status === 'clarifying' ? 1 : 0) + approvals;
}

/** one-line digest under the title, like the last message preview */
function digest(t: TaskGraph): string {
  if (t.status === 'clarifying') return '[需求澄清] 等待你回复澄清问题';
  if (t.status === 'queued') return '[排队中] 等待前面的任务执行完成';
  const n = t.nodes.length;
  const done = t.nodes.filter((x) => x.status === 'completed').length;
  const running = t.nodes.find((x) => ['running', 'retrying'].includes(x.status));
  if (running) return `[执行中] ${running.name} — ${running.agent}`;
  const approval = t.nodes.find((x) => x.status === 'waiting_approval');
  if (approval) return `[待审批] ${approval.name}`;
  if (t.status === 'success') return `[已完成] ${done}/${n} 节点全部通过`;
  if (t.status === 'failed') {
    const failed = t.nodes.find((x) => x.status === 'failed');
    return `[失败] ${failed?.name || n - done} 个节点未通过`;
  }
  if (t.status === 'planned') return `[计划待确认] 共 ${n} 个节点`;
  return `[${statusLabel(t.status)}] ${done}/${n} 节点`;
}

async function fetchPage(p: number, q = keyword.value) {
  const d = await api.listTasks(p, PAGE_SIZE, q);
  total.value = d.total;
  if (p === 1) list.value = d.tasks;
  else list.value = [...list.value, ...d.tasks];
  finished.value = list.value.length >= d.total;
}

async function onRefresh() {
  try {
    page.value = 1;
    await fetchPage(1);
    void loadTasks(1);
    showToast('已刷新');
  } catch (e: any) {
    error.value = e.message;
  } finally {
    refreshing.value = false;
  }
}

async function onLoad() {
  loading.value = true;
  error.value = '';
  try {
    await fetchPage(page.value);
    page.value += 1;
  } catch (e: any) {
    error.value = e.message;
  } finally {
    loading.value = false;
  }
}

function onSearch() {
  page.value = 1;
  finished.value = false;
  list.value = [];
  void onLoad();
}

function openTask(t: TaskGraph) {
  if (t.status === 'clarifying') { router.push(`/clarify/${t.task_id}`); return; }
  if (t.status === 'planned') { router.push(`/plan/${t.task_id}`); return; }
  router.push(`/task/${t.task_id}`);
}

// ---------- 任务中心: status stats + filter + restart ----------

/** same restartable set as the web TaskTable */
const canRestart = (st: string) => ['failed', 'cancelled', 'success', 'completed'].includes(st);

async function onRestart(t: TaskGraph) {
  try {
    await showConfirmDialog({
      title: '重启任务',
      message: '任务将重新进入执行队列，未完成的节点会重新执行（已完成节点保留）。',
      confirmButtonText: '重启',
      cancelButtonText: '取消',
    });
  } catch {
    return; // user dismissed
  }
  try {
    await api.executeTask(t.task_id);
    showToast('已重新加入执行队列');
    await onRefresh();
  } catch (e: any) {
    showToast(e.message || '重启失败');
  }
}

const statusFilter = ref('');
const stats = ref({ total: 0, running: 0, waiting: 0, failed: 0, done: 0 });

async function refreshStats() {
  try {
    const d = await api.listTasks(1, 200);
    const all = d.tasks || [];
    stats.value = {
      total: d.total,
      running: all.filter((t) => ['running', 'retrying', 'queued'].includes(t.status)).length,
      waiting: all.filter((t) => ['waiting_approval', 'waiting_clarify', 'clarifying', 'planned', 'pending'].includes(t.status)).length,
      failed: all.filter((t) => t.status === 'failed').length,
      done: all.filter((t) => ['success', 'completed'].includes(t.status)).length,
    };
  } catch { /* server unreachable — keep last snapshot */ }
}

const chips = [
  { key: '', label: '全部', get count() { return stats.value.total; } },
  { key: 'running', label: '执行中', get count() { return stats.value.running; } },
  { key: 'waiting', label: '待处理', get count() { return stats.value.waiting; } },
  { key: 'failed', label: '失败', get count() { return stats.value.failed; } },
  { key: 'done', label: '完成', get count() { return stats.value.done; } },
];

function matchesFilter(t: TaskGraph): boolean {
  if (!statusFilter.value) return true;
  if (statusFilter.value === 'running') return ['running', 'retrying', 'queued'].includes(t.status);
  if (statusFilter.value === 'waiting') return ['waiting_approval', 'waiting_clarify', 'clarifying', 'planned', 'pending'].includes(t.status);
  if (statusFilter.value === 'failed') return t.status === 'failed';
  if (statusFilter.value === 'done') return ['success', 'completed'].includes(t.status);
  return true;
}

function toggleFilter(key: string) {
  statusFilter.value = statusFilter.value === key ? '' : key;
}

// ---------- execution queues (project lanes) ----------

const queues = ref<QueueSnapshot[]>([]);
let queueTimer: number | null = null;
const visibleQueues = computed(() => queues.value.filter((q) => q.running_task_id || q.pending.length || q.blocked));

async function refreshQueues() {
  try {
    queues.value = await api.queues();
  } catch { /* server unreachable — keep last snapshot */ }
}

async function onResume(key: string) {
  await api.resumeQueue(key);
  showToast('队列已恢复');
  await refreshQueues();
}

async function onClear(key: string) {
  await api.clearQueue(key);
  showToast('已清空排队任务');
  await refreshQueues();
}

onMounted(() => {
  refreshQueues();
  refreshStats();
  queueTimer = window.setInterval(() => { refreshQueues(); refreshStats(); }, 5000);
});
onUnmounted(() => {
  if (queueTimer !== null) window.clearInterval(queueTimer);
});
</script>

<template>
  <div class="page">
    <van-nav-bar title="Co-Team" fixed placeholder>
      <template #right>
        <van-icon
          :name="theme === 'dark' ? 'bulb-o' : 'lock'"
          size="20"
          color="var(--text-2)"
          style="margin-right: 14px"
          @click="toggle()"
        />
        <van-icon name="plus" size="22" color="var(--ct-accent)" @click="router.push('/task/new')" />
      </template>
    </van-nav-bar>

    <div class="ov-bar">
      <div class="ov-item">
        <span class="ov-num">{{ runningCount }}</span>
        <span class="ov-label">执行中</span>
      </div>
      <div class="ov-item" :class="{ alert: humanCount > 0 }" @click="router.push('/approvals')">
        <span class="ov-num">{{ humanCount }}</span>
        <span class="ov-label">待我处理</span>
      </div>
      <div class="ov-item">
        <span class="ov-num mono">{{ sys?.tokens_total != null ? fmtTok(sys.tokens_total) : '—' }}</span>
        <span class="ov-label">Token</span>
      </div>
      <div class="ov-item">
        <span class="ov-num mono">{{ sys?.cost_total != null ? '¥' + Number(sys.cost_total).toFixed(2) : '—' }}</span>
        <span class="ov-label">成本</span>
      </div>
      <div class="ov-item approve" @click="router.push('/approvals')">
        <van-icon name="passed" size="20" />
        <span class="ov-label">审批</span>
      </div>
    </div>

    <van-search
      v-model="keyword"
      placeholder="搜索"
      shape="round"
      background="transparent"
      @search="onSearch"
    />

    <!-- 任务中心 status chips: tap to filter the session list -->
    <div class="stat-row">
      <button
        v-for="c in chips"
        :key="c.key"
        class="stat-chip"
        :class="{ active: statusFilter === c.key }"
        @click="toggleFilter(c.key)"
      >
        <span class="stat-num mono">{{ c.count }}</span>
        <span class="stat-label">{{ c.label }}</span>
      </button>
    </div>

    <!-- execution queues: one lane per project, blocked lanes wait for the user -->
    <div v-for="q in visibleQueues" :key="q.key" class="queue-strip" :class="{ 'queue-blocked': q.blocked }">
      <div class="q-head">
        <span class="q-tag" :class="{ bad: q.blocked }">{{ q.project_id ? '项目队列' : '默认队列' }}</span>
        <span class="q-info mono">
          {{ q.running_task_id ? `执行中: ${q.running_task_id}` : '空闲' }}<template v-if="q.pending.length"> · 排队 {{ q.pending.length }}</template>
        </span>
        <van-button v-if="q.blocked" size="mini" type="primary" @click="onResume(q.key)">恢复</van-button>
        <van-button v-if="q.pending.length" size="mini" plain @click="onClear(q.key)">清空</van-button>
      </div>
      <div v-if="q.blocked" class="q-reason">{{ q.blocked_reason }}</div>
    </div>

    <!-- pull-refresh must NOT be the scroll container itself (Vant swallows
         touch scrolling when overflow:auto sits on the same node) -->
    <van-pull-refresh v-model="refreshing" class="pull-wrap" @refresh="onRefresh">
      <div class="pull">
        <van-list
          v-model:loading="loading"
          :finished="finished"
          :error="!!error"
          :error-text="error"
          finished-text="没有更多了"
          @load="onLoad"
        >
          <div v-if="!visible.length && finished" class="empty">
            <van-icon name="chat-o" size="52" color="var(--text-3)" />
            <div class="empty-title">暂无任务</div>
            <div class="empty-text">点右上角 + 发起第一个任务</div>
          </div>

          <!-- WeChat session-list rows -->
          <div v-for="t in visible" :key="t.task_id" class="session" @click="openTask(t)">
            <div class="s-avatar">
              <AgentAvatar :name="avatarAgent(t)" :size="48" />
              <span v-if="badgeCount(t)" class="s-badge">{{ badgeCount(t) > 99 ? '99+' : badgeCount(t) }}</span>
              <span v-else-if="needsAttention(t)" class="s-dot"></span>
            </div>
            <div class="s-body">
              <div class="s-line1">
                <span class="s-title">{{ t.description || t.task_id }}</span>
                <span class="s-time">{{ sessionTime(t.updated_at) }}</span>
              </div>
              <div class="s-line2">
                <span class="s-digest" :class="{ unread: needsAttention(t) }">{{ digest(t) }}</span>
                <span class="s-meta">
                  <van-button
                    v-if="canRestart(t.status)"
                    size="mini"
                    plain
                    type="primary"
                    class="s-restart"
                    @click.stop="onRestart(t)"
                  >重启</van-button>
                  <StatusTag
                    v-if="t.status === 'running' || t.status === 'retrying'"
                    status="running"
                    label="执行中"
                    class="wx-pulse"
                  />
                  <StatusTag v-else-if="t.status === 'queued'" status="queued" label="排队中" />
                  <StatusTag v-else-if="t.status === 'waiting_approval' || t.status === 'clarifying' || t.status === 'planned'" :status="t.status" label="待处理" />
                  <StatusTag v-else-if="t.status === 'failed'" status="failed" label="失败" />
                  <StatusTag v-else-if="t.status === 'success'" status="success" label="完成" />
                  <span v-if="t.project_id && projectNames[t.project_id]" class="s-proj">{{ projectNames[t.project_id] }}</span>
                </span>
              </div>
            </div>
            <van-icon class="s-chevron" name="arrow" size="15" color="var(--text-3)" />
          </div>
        </van-list>
      </div>
    </van-pull-refresh>
  </div>
</template>

<style scoped>
.page { height: 100%; display: flex; flex-direction: column; background: var(--bg); }
/* pull-refresh wraps WITHOUT scrolling; the inner .pull is the touch scroller */
.pull-wrap { flex: 1; min-height: 0; overflow: hidden; }
.pull { height: 100%; overflow-y: auto; -webkit-overflow-scrolling: touch; }

.empty { display: flex; flex-direction: column; align-items: center; gap: 6px; padding: 72px 0 48px; }
.empty-title { font-size: 16px; color: var(--text-2); font-weight: 600; margin-top: 6px; }
.empty-text { font-size: 13px; color: var(--text-3); }

/* WeChat session row: breathing space, two-line rhythm, quiet chevron */
.session {
  display: flex; gap: 13px;
  padding: 13px 16px 13px 16px;
  background: var(--panel);
  position: relative;
  align-items: center;
  transition: background 0.12s ease;
  border-bottom: 1px solid rgba(56, 189, 248, 0.07);
}
.session + .session::before {
  content: ''; position: absolute;
  left: 77px; right: 0; top: 0;
  height: 1px; background: var(--border);
  transform: scaleY(0.5);
}
.session:active { background: rgba(34, 211, 238, 0.05); }

.s-avatar { position: relative; flex-shrink: 0; }
.s-badge {
  position: absolute; top: -5px; right: -9px;
  min-width: 18px; height: 18px; padding: 0 5px;
  border-radius: 10px; background: var(--red); color: #fff;
  font-size: 11px; font-weight: 600; line-height: 18px; text-align: center;
  box-shadow: 0 0 0 2.5px var(--panel);
}
.s-dot {
  position: absolute; top: -1px; right: -1px;
  width: 10px; height: 10px; border-radius: 50%;
  background: var(--red); box-shadow: 0 0 0 2.5px var(--panel);
}

.s-body { flex: 1; min-width: 0; }
.s-line1 { display: flex; justify-content: space-between; align-items: center; gap: 10px; }
.s-title {
  font-size: 16.5px; color: var(--text); font-weight: 500; line-height: 1.35;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.s-time { font-size: 12px; color: var(--text-3); flex-shrink: 0; margin-top: 1px; }
.s-line2 { display: flex; justify-content: space-between; align-items: center; gap: 10px; margin-top: 4px; }
.s-digest {
  font-size: 13.5px; color: var(--text-2); line-height: 1.4;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; min-width: 0;
}
.s-digest.unread { color: var(--text); }

/* status meta cluster on the right of line 2 */
.s-meta { display: flex; align-items: center; gap: 6px; flex-shrink: 0; }
.s-pill {
  font-size: 11px; font-weight: 500; border-radius: 5px; padding: 2px 7px; line-height: 1.4;
}
.s-pill.run { color: var(--yellow); background: rgba(255, 180, 84, 0.1); border: 1px solid rgba(255, 180, 84, 0.3); }
.s-pill.queue { color: var(--text-3); background: rgba(148, 163, 184, 0.1); border: 1px solid rgba(148, 163, 184, 0.3); }
.s-pill.wait { color: var(--accent); background: var(--accent-soft); border: 1px solid rgba(34, 211, 238, 0.3); }
.s-pill.bad { color: var(--red); background: rgba(255, 93, 110, 0.1); border: 1px solid rgba(255, 93, 110, 0.3); }
.s-pill.ok { color: var(--green); background: rgba(52, 245, 197, 0.08); border: 1px solid rgba(52, 245, 197, 0.28); }
.s-proj {
  font-size: 11px; color: var(--wx-blue); background: rgba(76, 194, 255, 0.08);
  border: 1px solid rgba(76, 194, 255, 0.22);
  border-radius: 5px; padding: 2px 7px; max-width: 96px;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.s-chevron { flex-shrink: 0; opacity: 0.55; }

.stat-row { display: flex; gap: 7px; padding: 0 12px 8px; overflow-x: auto; }
.stat-chip {
  display: flex; flex-direction: column; align-items: flex-start; gap: 1px;
  min-width: 58px; padding: 5px 11px;
  background: rgba(17, 26, 40, 0.6);
  border: 1px solid var(--border);
  border-radius: 9px; cursor: pointer; text-align: left;
  transition: border-color 0.15s ease, background 0.15s ease;
}
.stat-chip.active { border-color: var(--accent); background: var(--accent-soft); }
.stat-num { font-size: 16px; font-weight: 700; color: var(--text); line-height: 1.1; }
.stat-label { font-size: 11px; color: var(--text-3); }
.s-restart { height: 22px; padding: 0 9px; border-radius: 6px; font-weight: 500; }

/* queue strips between search and the session list */
.queue-strip {
  margin: 0 12px 8px;
  padding: 9px 12px;
  border: 1px solid var(--border);
  border-radius: 10px;
  background: rgba(17, 26, 40, 0.6);
}
.queue-strip.queue-blocked { border-color: var(--red); }
.q-head { display: flex; align-items: center; gap: 8px; }
.q-tag {
  font-size: 11px; font-weight: 600; padding: 2px 8px; border-radius: 5px;
  color: var(--accent); background: var(--accent-soft);
  border: 1px solid rgba(34, 211, 238, 0.3);
}
.q-tag.bad { color: var(--red); background: rgba(255, 93, 110, 0.1); border-color: rgba(255, 93, 110, 0.3); }
.q-info { flex: 1; min-width: 0; font-size: 12px; color: var(--text-2); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.q-reason { margin-top: 6px; font-size: 12px; color: var(--red); line-height: 1.4; }
</style>

<style scoped>
.ov-bar { display: flex; align-items: stretch; gap: 8px; padding: 8px 16px 4px; }
.ov-item { flex: 1; background: var(--panel); border: 1px solid var(--border); border-radius: var(--r-md); padding: 8px 6px; display: flex; flex-direction: column; align-items: center; gap: 2px; }
.ov-item.approve { flex: 0 0 64px; color: var(--ct-accent); justify-content: center; }
.ov-item.alert .ov-num { color: var(--ct-yellow); }
.ov-num { font-size: var(--fs-lg); font-weight: 700; color: var(--text); }
.ov-label { font-size: var(--fs-xs); color: var(--text-3); }
</style>
