<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { api, statusLabel } from '../api';
import type { TaskGraph } from '../api';
import { useDashboard } from '../composables/useDashboard';
import AgentAvatar from '../components/AgentAvatar.vue';

const route = useRoute();
const router = useRouter();
const { onEvent } = useDashboard();

const projectId = computed(() => String(route.params.id));
const projectTasks = ref<TaskGraph[]>([]);
const projectName = ref('');
const loading = ref(true);
const error = ref('');
let unsub: (() => void) | undefined;
let timer: number | undefined;

async function load() {
  error.value = '';
  try {
    const d = await api.getProject(projectId.value);
    projectName.value = d.name;
    projectTasks.value = d.tasks || [];
  } catch (e: any) {
    error.value = e.message || '加载失败';
  } finally {
    loading.value = false;
  }
}

onMounted(() => {
  void load();
  unsub = onEvent((msg) => {
    // any event for one of this project's tasks refreshes the list
    if (msg.payload?.task_id && projectTasks.value.some(t => t.task_id === msg.payload.task_id)) {
      void load();
    }
  });
  timer = window.setInterval(() => {
    if (document.visibilityState === 'visible') void load();
  }, 8000);
});

onUnmounted(() => {
  window.clearInterval(timer);
  unsub?.();
});

const sorted = computed(() => [...projectTasks.value].sort((a, b) => (b.updated_at || '').localeCompare(a.updated_at || '')));

const stats = computed(() => {
  const total = projectTasks.value.length;
  const done = projectTasks.value.filter(t => t.status === 'success').length;
  const running = projectTasks.value.filter(t => ['running', 'retrying', 'waiting_approval', 'pending'].includes(t.status)).length;
  const failed = projectTasks.value.filter(t => t.status === 'failed').length;
  const waitingMe = projectTasks.value.filter(t => ['planned', 'clarifying'].includes(t.status) || t.nodes.some(n => n.status === 'waiting_approval')).length;
  return { total, done, running, failed, waitingMe, pct: total ? Math.round((done / total) * 100) : 0 };
});

function avatarAgent(t: TaskGraph): string {
  const working = t.nodes.find((n) => ['running', 'retrying', 'waiting_approval'].includes(n.status));
  if (working) return working.agent;
  return t.nodes.find((n) => n.agent !== 'orchestrator')?.agent || 'dev';
}

function sessionTime(ts?: string): string {
  if (!ts) return '';
  const d = new Date(ts);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  const yesterday = new Date(now); yesterday.setDate(now.getDate() - 1);
  if (d.toDateString() === yesterday.toDateString()) return '昨天';
  return `${d.getMonth() + 1}月${d.getDate()}日`;
}

function digest(t: TaskGraph): string {
  if (t.status === 'clarifying') return '[需求澄清] 等待你回复澄清问题';
  const n = t.nodes.length;
  const done = t.nodes.filter((x) => x.status === 'completed').length;
  const running = t.nodes.find((x) => ['running', 'retrying'].includes(x.status));
  if (running) return `[执行中] ${running.name} — ${running.agent}`;
  const approval = t.nodes.find((x) => x.status === 'waiting_approval');
  if (approval) return `[待审批] ${approval.name}`;
  if (t.status === 'success') return `[已完成] ${done}/${n} 节点全部通过`;
  if (t.status === 'failed') return `[失败] 有节点未通过`;
  if (t.status === 'planned') return `[计划待确认] 共 ${n} 个节点`;
  return `[${statusLabel(t.status)}] ${done}/${n} 节点`;
}

function openTask(t: TaskGraph) {
  if (t.status === 'clarifying') { router.push(`/clarify/${t.task_id}`); return; }
  if (t.status === 'planned') { router.push(`/plan/${t.task_id}`); return; }
  router.push(`/task/${t.task_id}`);
}

function goCreate() {
  router.push({ path: '/task/new', query: { project_id: projectId.value, project_name: projectName.value } });
}
</script>

<template>
  <div class="page">
    <van-nav-bar :title="projectName || '项目'" left-arrow fixed placeholder @click-left="router.back()">
      <template #right>
        <van-icon name="plus" size="22" color="#07c160" @click="goCreate" />
      </template>
    </van-nav-bar>

    <van-loading v-if="loading" class="loading" vertical>加载中…</van-loading>

    <div v-else-if="error" class="err-state">
      <van-icon name="warning-o" size="48" color="#fa9d3b" />
      <div class="err-text">{{ error }}</div>
      <button class="wx-btn err-btn" @click="load">重新加载</button>
    </div>

    <div v-else class="body">
      <!-- 项目进度统计头 -->
      <div class="wx-group stat-card">
        <div class="stat-row">
          <div class="stat-item">
            <div class="stat-num">{{ stats.total }}</div>
            <div class="stat-label">任务</div>
          </div>
          <div class="stat-item ok">
            <div class="stat-num">{{ stats.done }}</div>
            <div class="stat-label">完成</div>
          </div>
          <div class="stat-item run">
            <div class="stat-num">{{ stats.running }}</div>
            <div class="stat-label">执行中</div>
          </div>
          <div class="stat-item bad">
            <div class="stat-num">{{ stats.failed }}</div>
            <div class="stat-label">失败</div>
          </div>
        </div>
        <div class="stat-prog">
          <div class="sp-track"><div class="sp-fill" :style="{ width: stats.pct + '%' }"></div></div>
          <span class="sp-pct">{{ stats.pct }}%</span>
        </div>
        <div v-if="stats.waitingMe" class="stat-waiting">⚠ {{ stats.waitingMe }} 个任务需要你处理（审批/澄清/确认）</div>
      </div>

      <div class="wx-caption">项目任务</div>
      <div class="wx-group task-group">
        <div v-if="!sorted.length" class="t-empty">暂无任务，点右上角 + 下发</div>
        <div v-for="t in sorted" :key="t.task_id" class="session" @click="openTask(t)">
          <div class="s-avatar">
            <AgentAvatar :name="avatarAgent(t)" :size="44" />
          </div>
          <div class="s-body">
            <div class="s-line1">
              <span class="s-title">{{ t.description || t.task_id }}</span>
              <span class="s-time">{{ sessionTime(t.updated_at) }}</span>
            </div>
            <div class="s-line2">
              <span class="s-digest">{{ digest(t) }}</span>
              <span v-if="['running', 'pending', 'retrying'].includes(t.status)" class="s-tag run">执行中</span>
              <span v-else-if="['planned', 'clarifying'].includes(t.status)" class="s-tag wait">待处理</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.page { height: 100%; display: flex; flex-direction: column; background: var(--bg); }
.loading { margin: 60px auto; }

/* the scrollable content region: constrained + own scroller (fixed navbar takes the rest) */
.body {
  flex: 1; min-height: 0;
  overflow-y: auto;
  -webkit-overflow-scrolling: touch;
  padding-bottom: 16px;
}
/* fixed nav-bar renders over content; its translucent blur needs solid backing below */
.page :deep(.van-nav-bar__placeholder) { z-index: 10; }
.page :deep(.van-nav-bar--fixed) { z-index: 11; }

/* stat header: big-number hierarchy like WeChat pay cards */
.stat-card { padding: 18px 16px 16px; }
.stat-row { display: flex; gap: 8px; margin-bottom: 14px; }
.stat-item { flex: 1; text-align: center; }
.stat-num { font-size: 26px; font-weight: 700; color: var(--text); line-height: 1.1; font-variant-numeric: tabular-nums; }
.stat-item.ok .stat-num { color: var(--green); text-shadow: var(--glow-green); }
.stat-item.run .stat-num { color: var(--yellow); text-shadow: var(--glow-orange); }
.stat-item.bad .stat-num { color: var(--red); text-shadow: var(--glow-red); }
.stat-label { font-size: 12px; color: var(--text-3); margin-top: 3px; }
.stat-prog { display: flex; align-items: center; gap: 10px; }
.sp-track { flex: 1; height: 6px; border-radius: 3px; background: var(--panel-2); overflow: hidden; }
.sp-fill { height: 100%; border-radius: 3px; background: linear-gradient(90deg, #22d3ee, #0369a1); box-shadow: 0 0 8px rgba(34, 211, 238, 0.45); transition: width 0.5s ease; }
.sp-pct { font-size: 13px; font-weight: 600; color: var(--text-2); width: 38px; text-align: right; font-variant-numeric: tabular-nums; }
.stat-waiting {
  font-size: 13px; color: var(--wx-orange); margin-top: 12px;
  background: rgba(255, 180, 84, 0.09); border: 1px solid rgba(255, 180, 84, 0.25); border-radius: 8px; padding: 7px 10px;
}

/* project task rows: same session-list rhythm */
.task-group { padding: 0; }
.t-empty { padding: 28px; text-align: center; font-size: 14px; color: var(--text-3); }

.session { display: flex; gap: 13px; padding: 13px 16px; align-items: center; position: relative; transition: background 0.12s ease; }
.session + .session::before {
  content: ''; position: absolute; left: 73px; right: 0; top: 0;
  height: 1px; background: var(--border); transform: scaleY(0.5);
}
.session:active { background: var(--panel-2); }
.s-avatar { flex-shrink: 0; }
.s-body { flex: 1; min-width: 0; }
.s-line1 { display: flex; justify-content: space-between; gap: 10px; align-items: center; }
.s-title { font-size: 16px; color: var(--text); font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.s-time { font-size: 12px; color: var(--text-3); flex-shrink: 0; }
.s-line2 { display: flex; justify-content: space-between; gap: 10px; align-items: center; margin-top: 4px; }
.s-digest { font-size: 13.5px; color: var(--text-2); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; min-width: 0; }
.s-tag { font-size: 11px; font-weight: 500; border-radius: 5px; padding: 2px 7px; flex-shrink: 0; }
.s-tag.run { color: var(--yellow); background: rgba(255, 180, 84, 0.1); border: 1px solid rgba(255, 180, 84, 0.3); }
.s-tag.wait { color: var(--accent); background: var(--accent-soft); border: 1px solid rgba(34, 211, 238, 0.3); }

.err-state { display: flex; flex-direction: column; align-items: center; gap: 8px; padding: 72px 0; }
.err-text { font-size: 14px; color: var(--text-2); }
.err-btn { margin-top: 12px; max-width: 180px; }
</style>
