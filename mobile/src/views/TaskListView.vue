<script setup lang="ts">
import { computed, ref } from 'vue';
import { useRouter } from 'vue-router';
import { showToast } from 'vant';
import { api, statusLabel } from '../api';
import type { TaskGraph } from '../api';
import { useDashboard } from '../composables/useDashboard';
import AgentAvatar from '../components/AgentAvatar.vue';

defineOptions({ name: 'TaskListView' });

const router = useRouter();
const { loadTasks } = useDashboard();

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
  return t.status === 'waiting_approval' || t.status === 'clarifying' || t.nodes.some((n) => n.status === 'waiting_approval');
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
</script>

<template>
  <div class="page">
    <van-nav-bar title="Co-Team" fixed placeholder>
      <template #right>
        <van-icon name="plus" size="22" color="#07c160" @click="router.push('/task/new')" />
      </template>
    </van-nav-bar>

    <van-search
      v-model="keyword"
      placeholder="搜索"
      shape="round"
      background="transparent"
      @search="onSearch"
    />

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
          <div v-if="!sorted.length && finished" class="empty">
            <van-icon name="chat-o" size="52" class="wx-float" color="var(--text-3)" />
            <div class="empty-title">暂无任务</div>
            <div class="empty-text">点右上角 + 发起第一个任务</div>
          </div>

          <!-- WeChat session-list rows -->
          <div v-for="t in sorted" :key="t.task_id" class="session" @click="openTask(t)">
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
                  <span
                    v-if="t.status === 'running' || t.status === 'retrying'"
                    class="s-pill run wx-pulse"
                  >执行中</span>
                  <span v-else-if="t.status === 'waiting_approval' || t.status === 'clarifying' || t.status === 'planned'" class="s-pill wait">待处理</span>
                  <span v-else-if="t.status === 'failed'" class="s-pill bad">失败</span>
                  <span v-else-if="t.status === 'success'" class="s-pill ok">完成</span>
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
  background: linear-gradient(180deg, rgba(17, 26, 40, 0.92), rgba(13, 20, 31, 0.95));
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
</style>
