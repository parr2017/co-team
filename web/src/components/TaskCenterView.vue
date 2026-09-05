<template>
  <div class="section">
    <div class="section-head">
      <div class="section-title">任务中心</div>
      <div class="section-actions">
        <el-tag size="small" type="info" class="mono">共 {{ stats.total }} 个任务</el-tag>
      </div>
    </div>

    <!-- status overview: click a chip to filter the table below -->
    <div class="stat-row">
      <button
        v-for="c in chips"
        :key="c.key"
        class="stat-chip"
        :class="{ active: filterStatus === c.value }"
        @click="toggleFilter(c.value)"
      >
        <span class="stat-num mono">{{ c.count }}</span>
        <span class="stat-label">{{ c.label }}</span>
      </button>
    </div>

    <QueuePanel />

    <div class="search-row">
      <el-input
        v-model="keyword"
        size="small"
        clearable
        placeholder="按任务 ID / 描述关键词搜索，回车确认"
        class="search-input"
        @keyup.enter="doSearch"
        @clear="doSearch"
      />
    </div>

    <TaskTable
      :tasks="tasks"
      :filter-status="filterStatus"
      @show-detail="(tid) => emit('show-detail', tid)"
      @show-logs="(tid, nid) => emit('show-logs', tid, nid)"
      @show-dag="(tid) => emit('show-dag', tid)"
      @review="(tid) => emit('review', tid)"
      @clarify="(tid) => emit('clarify', tid)"
      @cancel="(tid) => emit('cancel', tid)"
      @delete="(tid) => emit('delete', tid)"
    />

    <div class="table-foot">
      <el-pagination
        v-if="total > pageSize"
        small
        layout="prev, pager, next"
        :total="total"
        :page-size="pageSize"
        :current-page="currentPage"
        @current-change="(p: number) => emit('page-change', p)"
      />
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { api } from '../api';
import TaskTable from './TaskTable.vue';
import QueuePanel from './QueuePanel.vue';

const props = defineProps<{ tasks: Record<string, any>; total?: number; currentPage?: number; pageSize?: number }>();

const emit = defineEmits<{
  (e: 'show-detail', taskId: string): void;
  (e: 'show-logs', taskId: string, nodeId: string): void;
  (e: 'show-dag', taskId: string): void;
  (e: 'review', taskId: string): void;
  (e: 'clarify', taskId: string): void;
  (e: 'cancel', taskId: string): void;
  (e: 'delete', taskId: string): void;
  (e: 'page-change', page: number): void;
  (e: 'search', keyword: string): void;
}>();

// ---------- status overview (counts across ALL tasks, own lightweight poll) ----------

const stats = ref({ total: 0, running: 0, queued: 0, waiting: 0, pending: 0, done: 0, failed: 0 });
let statTimer: number | null = null;

async function refreshStats() {
  try {
    const d = await api.listTasks(1, 200);
    const all = d.tasks || [];
    stats.value = {
      total: d.total,
      running: all.filter((t) => t.status === 'running' || t.status === 'retrying').length,
      queued: all.filter((t) => t.status === 'queued').length,
      waiting: all.filter((t) => t.status === 'waiting_approval' || (t.nodes || []).some((n: any) => n.status === 'waiting_approval')).length,
      pending: all.filter((t) => t.status === 'pending' || t.status === 'planned').length,
      done: all.filter((t) => t.status === 'completed' || t.status === 'success').length,
      failed: all.filter((t) => t.status === 'failed').length,
    };
  } catch { /* server unreachable — keep last snapshot */ }
}

// ---------- status filter + search ----------

const filterStatus = ref('');
const keyword = ref('');

const chips = computed(() => [
  { key: 'all', label: '全部', count: stats.value.total, value: '' },
  { key: 'running', label: '执行中', count: stats.value.running, value: 'running,retrying' },
  { key: 'queued', label: '排队中', count: stats.value.queued, value: 'queued' },
  { key: 'waiting', label: '待审批', count: stats.value.waiting, value: 'waiting_approval' },
  { key: 'pending', label: '待执行', count: stats.value.pending, value: 'pending,planned' },
  { key: 'done', label: '已完成', count: stats.value.done, value: 'completed,success' },
  { key: 'failed', label: '失败', count: stats.value.failed, value: 'failed' },
]);

function toggleFilter(value: string) {
  filterStatus.value = filterStatus.value === value ? '' : value;
}

function doSearch() {
  emit('search', keyword.value.trim());
}

const total = computed(() => props.total ?? 0);
const currentPage = computed(() => props.currentPage ?? 1);
const pageSize = computed(() => props.pageSize ?? 20);

onMounted(() => {
  refreshStats();
  statTimer = window.setInterval(refreshStats, 5000);
});
onUnmounted(() => {
  if (statTimer !== null) window.clearInterval(statTimer);
});
</script>

<style scoped>
.stat-row { display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: 14px; }
.stat-chip {
  display: flex; flex-direction: column; align-items: flex-start; gap: 2px;
  min-width: 86px; padding: 8px 14px;
  background: var(--ct-panel, var(--el-bg-color));
  border: 1px solid var(--ct-border2, var(--el-border-color));
  border-radius: 8px; cursor: pointer; text-align: left;
  transition: border-color 0.15s ease, background 0.15s ease;
}
.stat-chip:hover { border-color: var(--ct-accent, #3b82f6); }
.stat-chip.active { border-color: var(--ct-accent, #3b82f6); background: var(--ct-accent-soft, rgba(59, 130, 246, 0.08)); }
.stat-num { font-size: 20px; font-weight: 700; color: var(--ct-text, var(--el-text-color-primary)); line-height: 1.1; }
.stat-label { font-size: 12px; color: var(--ct-text3, var(--el-text-color-secondary)); }
.search-row { margin-bottom: 10px; }
.search-input { max-width: 320px; }
.table-foot { display: flex; justify-content: flex-end; margin-top: 10px; }
</style>
