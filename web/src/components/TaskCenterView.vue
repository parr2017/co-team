<template>
  <div class="tc">
    <div class="tc-head">
      <h1>任务中心</h1>
      <span class="cnt mono">共 {{ stats.total }} · 执行中 {{ stats.running }}</span>
      <div class="spacer"></div>
      <el-tooltip content="开启后列表、徽标与统计涵盖项目开发下的任务（关闭则只列外部下发的任务，默认开启）" placement="top">
        <el-checkbox :model-value="includeProjects" size="small" @change="onScopeChange">包含项目任务</el-checkbox>
      </el-tooltip>
    </div>

    <!-- status overview: click a chip to filter the table below -->
    <div class="chipbar">
      <button
        v-for="c in chips"
        :key="c.key"
        class="chip"
        :class="{ on: filterStatus === c.value }"
        @click="toggleFilter(c.value)"
      >
        <span v-if="c.dot" class="dot" :class="c.dot"></span>
        <span>{{ c.label }}</span>
        <span class="n mono">{{ c.count }}</span>
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
      <div v-if="total > pageSize" class="pageno">
        <span>每页 {{ pageSize }}</span>
        <button :disabled="currentPage <= 1" @click="emit('page-change', currentPage - 1)">‹</button>
        <button v-for="p in pageList" :key="p" :class="{ on: p === currentPage }" @click="emit('page-change', p)">{{ p }}</button>
        <button :disabled="currentPage >= pageCount" @click="emit('page-change', currentPage + 1)">›</button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { api } from '../api';
import { useDashboard } from '../composables/useDashboard';
import TaskTable from './TaskTable.vue';
import QueuePanel from './QueuePanel.vue';

const pageCount = computed(() => Math.max(1, Math.ceil((props.total || 0) / (props.pageSize || 20))));
const pageList = computed(() => {
  const cur = props.currentPage || 1;
  const out: number[] = [];
  for (let p = Math.max(1, cur - 2); p <= Math.min(pageCount.value, cur + 2); p++) out.push(p);
  return out;
});

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

// ---------- status overview (counts matching the table's external scope, own lightweight poll) ----------

const { includeProjects, setTaskScope } = useDashboard();
function onScopeChange(v: any) {
  setTaskScope(!!v);
  void refreshStats();
}

const stats = ref({ total: 0, running: 0, queued: 0, waiting: 0, pending: 0, done: 0, failed: 0 });
let statTimer: number | null = null;

async function refreshStats() {
  try {
    // 统计口径跟随列表开关（外部任务 / 全部任务）
    const d = await api.listTasks(1, 200, includeProjects.value ? {} : { scope: 'external' });
    const all = d.tasks || [];
    stats.value = {
      total: d.total,
      // 永续开发（2026-09-15）：finalizing（收尾验收）与 interrupted（中断待续跑）都算在途
      running: all.filter((t) => ['running', 'retrying', 'finalizing', 'interrupted'].includes(t.status)).length,
      queued: all.filter((t) => t.status === 'queued').length,
      waiting: all.filter((t) => t.status === 'waiting_approval' || (t.nodes || []).some((n: any) => n.status === 'waiting_approval')).length,
      pending: all.filter((t) => t.status === 'pending' || t.status === 'planned').length,
      // B1（2026-09-17）：completed_with_warnings 计入完成
      done: all.filter((t) => t.status === 'completed' || t.status === 'success' || t.status === 'completed_with_warnings').length,
      failed: all.filter((t) => t.status === 'failed').length,
    };
  } catch { /* server unreachable — keep last snapshot */ }
}

// ---------- status filter + search ----------

const filterStatus = ref('');
const keyword = ref('');

const chips = computed(() => [
  { key: 'all', label: '全部', count: stats.value.total, value: '', dot: '' },
  { key: 'running', label: '执行中', count: stats.value.running, value: 'running,retrying,finalizing,interrupted', dot: 'run' },
  { key: 'queued', label: '排队中', count: stats.value.queued, value: 'queued', dot: '' },
  { key: 'waiting', label: '待审批', count: stats.value.waiting, value: 'waiting_approval', dot: 'warn' },
  { key: 'pending', label: '待执行', count: stats.value.pending, value: 'pending,planned', dot: '' },
  { key: 'done', label: '已完成', count: stats.value.done, value: 'completed,success', dot: 'ok' },
  { key: 'failed', label: '失败', count: stats.value.failed, value: 'failed', dot: 'danger' },
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
  statTimer = window.setInterval(() => {
    if (document.visibilityState !== 'visible') return;
    void refreshStats();
  }, 30_000);
});
onUnmounted(() => {
  if (statTimer !== null) window.clearInterval(statTimer);
});
</script>

<style scoped>
/* 满宽自适应 + 1560px 行宽上限（宽屏 ≠ 信息无限铺开） */
.tc { max-width: 1560px; margin: 0 auto; }
.tc-head { display: flex; align-items: baseline; gap: 14px; margin-bottom: 14px; }
.tc-head h1 { font-size: var(--fs-h2); font-weight: 700; color: var(--text-1); margin: 0; }
.tc-head .cnt { font-size: var(--fs-aux); color: var(--text-3); }
.tc-head .spacer { flex: 1; }

/* 状态过滤 chips（预览样式：点 + 文字 + mono 计数） */
.chipbar { display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: 14px; }
.chip {
  display: inline-flex; align-items: center; gap: 7px; height: 28px; padding: 0 12px;
  border: 1px solid var(--line); border-radius: var(--r-ctl); background: var(--bg-panel);
  font-size: 12.5px; color: var(--text-2); cursor: pointer; transition: border-color .15s, color .15s, background .15s;
}
.chip:hover { border-color: var(--line-strong); color: var(--text-1); }
.chip.on { border-color: var(--accent-line); background: var(--accent-soft); color: var(--text-1); }
.chip .n { font-size: 11.5px; color: var(--text-3); }
.chip.on .n { color: var(--accent); }
.dot { width: 6px; height: 6px; border-radius: 50%; flex: none; }
.dot.ok { background: var(--ok); }
.dot.warn { background: var(--warn); }
.dot.danger { background: var(--danger); }
.dot.run { background: var(--accent); animation: pulse 1.6s infinite; }
@keyframes pulse { 50% { opacity: .35; } }

.search-row { margin-bottom: 10px; }
.search-input { max-width: 320px; }
.table-foot { display: flex; justify-content: flex-end; margin-top: 10px; }
.pageno { display: flex; justify-content: flex-end; gap: 6px; padding-top: 14px; color: var(--text-3); font-size: 12.5px; align-items: center; }
.pageno button { width: 26px; height: 26px; border: 1px solid var(--line); border-radius: var(--r-ctl); color: var(--text-2); font-family: var(--font-mono); font-size: 12px; background: none; cursor: pointer; }
.pageno button:hover:not(:disabled) { border-color: var(--line-strong); color: var(--text-1); }
.pageno button.on { border-color: var(--accent-line); color: var(--accent); background: var(--accent-soft); }
.pageno button:disabled { opacity: .4; cursor: not-allowed; }
</style>
