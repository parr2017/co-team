<template>
  <div class="tc">
    <!-- 工具栏：标题 + 实时连接 + 范围切换 + 搜索（一行收齐） -->
    <div class="tc-toolbar">
      <h1>任务中心</h1>
      <span class="live" :class="{ off: !connected }"><i></i>{{ connected ? '实时连接' : '已断开' }}</span>
      <div class="sp"></div>
      <div class="seg" role="tablist" aria-label="任务范围">
        <button :class="{ on: includeProjects }" @click="setScope(true)">全部任务 <b class="mono">{{ scopeCounts.all }}</b></button>
        <button :class="{ on: !includeProjects }" @click="setScope(false)">仅外部下发 <b class="mono">{{ scopeCounts.external }}</b></button>
      </div>
      <div class="search">
        <span class="ic">⌕</span>
        <input
          v-model="keyword"
          placeholder="按任务 ID / 描述关键词搜索"
          @keyup.enter="doSearch"
        />
        <button v-if="keyword" class="clr" title="清空" @click="clearSearch">×</button>
        <kbd v-else>↵</kbd>
      </div>
    </div>

    <!-- 状态统计带：点击过滤列表 -->
    <div class="statbar">
      <button
        v-for="c in statCards"
        :key="c.key"
        class="stat"
        :class="{ on: filterStatus === c.value }"
        @click="toggleFilter(c.value)"
      >
        <span class="rail" :class="c.rail"></span>
        <span class="lbl"><span class="dot" :class="c.rail"></span>{{ c.label }}</span>
        <span class="num mono">{{ c.count }}</span>
        <span class="sub">{{ c.sub }}</span>
      </button>
    </div>

    <QueuePanel />

    <!-- 列表头：结果计数 + 视图切换 -->
    <div class="list-head">
      <span class="res">
        共 <b>{{ total }}</b> 个任务 · 第 <b>{{ currentPage }}</b>/<b>{{ pageCount }}</b> 页 · 口径：<b>{{ includeProjects ? '全部任务' : '仅外部下发' }}</b>
      </span>
      <span class="sp"></span>
      <div class="vswitch">
        <button :class="{ on: viewMode === 'table' }" @click="setViewMode('table')">表格视图</button>
        <button :class="{ on: viewMode === 'card' }" @click="setViewMode('card')">卡片视图</button>
      </div>
    </div>

    <TaskTable
      :tasks="tasks"
      :filter-status="filterStatus"
      :view-mode="viewMode"
      @show-detail="(tid) => emit('show-detail', tid)"
      @show-logs="(tid, nid) => emit('show-logs', tid, nid)"
      @show-dag="(tid) => emit('show-dag', tid)"
      @review="(tid) => emit('review', tid)"
      @clarify="(tid) => emit('clarify', tid)"
      @cancel="(tid) => emit('cancel', tid)"
      @delete="(tid) => emit('delete', tid)"
    />

    <!-- 分页 -->
    <div class="tfoot">
      <span class="info">每页 {{ pageSize }} · 共 {{ total }} 条</span>
      <span class="sp"></span>
      <div v-if="total > pageSize" class="pageno">
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

// ---------- 范围切换（segmented control 带双口径计数）+ 实时连接 ----------

const { connected, includeProjects, setTaskScope } = useDashboard();
const scopeCounts = ref({ all: 0, external: 0 });

function setScope(all: boolean) {
  if (includeProjects.value === all) return;
  onScopeChange(all);
}
function onScopeChange(v: boolean) {
  setTaskScope(v);
  void refreshStats();
}

const stats = ref({ total: 0, running: 0, queued: 0, waiting: 0, pending: 0, done: 0, failed: 0 });
let statTimer: number | null = null;

async function refreshStats() {
  try {
    // 统计口径跟随列表开关；另一口径只拉 total（pageSize=1）供分段切换计数
    const curFilter = includeProjects.value ? {} : { scope: 'external' as const };
    const [main, other] = await Promise.all([
      api.listTasks(1, 200, curFilter),
      includeProjects.value ? api.listTasks(1, 1, { scope: 'external' }) : api.listTasks(1, 1, {}),
    ]);
    const all = main.tasks || [];
    stats.value = {
      total: main.total,
      // 永续开发（2026-09-15）：finalizing（收尾验收）与 interrupted（中断待续跑）都算在途
      running: all.filter((t) => ['running', 'retrying', 'finalizing', 'interrupted'].includes(t.status)).length,
      queued: all.filter((t) => t.status === 'queued').length,
      waiting: all.filter((t) => t.status === 'waiting_approval' || (t.nodes || []).some((n: any) => n.status === 'waiting_approval')).length,
      pending: all.filter((t) => t.status === 'pending' || t.status === 'planned').length,
      // B1（2026-09-17）：completed_with_warnings 计入完成
      done: all.filter((t) => t.status === 'completed' || t.status === 'success' || t.status === 'completed_with_warnings').length,
      failed: all.filter((t) => t.status === 'failed').length,
    };
    scopeCounts.value = {
      all: includeProjects.value ? main.total : other.total,
      external: includeProjects.value ? other.total : main.total,
    };
  } catch { /* server unreachable — keep last snapshot */ }
}

// ---------- 状态统计卡 + 过滤 + 搜索 ----------

const filterStatus = ref('');
const keyword = ref('');

const statCards = computed(() => [
  { key: 'all', label: '全部', count: stats.value.total, value: '', rail: 'idle', sub: includeProjects.value ? '当前口径 · 含项目任务' : '当前口径 · 仅外部下发' },
  { key: 'running', label: '执行中', count: stats.value.running, value: 'running,retrying,finalizing,interrupted', rail: 'run', sub: 'running · retrying · 收尾' },
  { key: 'queued', label: '排队中', count: stats.value.queued, value: 'queued', rail: 'idle', sub: 'queued' },
  { key: 'waiting', label: '待审批', count: stats.value.waiting, value: 'waiting_approval', rail: 'warn', sub: '等你拍板' },
  { key: 'pending', label: '待执行', count: stats.value.pending, value: 'pending,planned', rail: 'idle', sub: 'planned · pending' },
  { key: 'done', label: '已完成', count: stats.value.done, value: 'completed,success', rail: 'ok', sub: 'success · 有警告' },
  { key: 'failed', label: '失败', count: stats.value.failed, value: 'failed', rail: 'danger', sub: 'failed' },
]);

function toggleFilter(value: string) {
  filterStatus.value = filterStatus.value === value ? '' : value;
}

function doSearch() {
  emit('search', keyword.value.trim());
}
function clearSearch() {
  keyword.value = '';
  doSearch();
}

// ---------- 视图切换（localStorage 记忆） ----------

const viewMode = ref<'table' | 'card'>(localStorage.getItem('tc-view-mode') === 'card' ? 'card' : 'table');
function setViewMode(v: 'table' | 'card') {
  viewMode.value = v;
  localStorage.setItem('tc-view-mode', v);
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

/* ---------- 工具栏 ---------- */
.tc-toolbar { display: flex; align-items: center; gap: 14px; padding: 2px 0 14px; }
.tc-toolbar h1 { font-size: var(--fs-h1); font-weight: 700; letter-spacing: .5px; color: var(--text-1); margin: 0; }
.live {
  display: inline-flex; align-items: center; gap: 6px; font-size: var(--fs-meta); color: var(--text-3);
  border: 1px solid var(--line); border-radius: 20px; padding: 3px 10px;
}
.live i { width: 6px; height: 6px; border-radius: 50%; background: var(--ok); animation: pulse 1.6s infinite; }
.live.off i { background: var(--danger); animation: none; }
@keyframes pulse { 50% { opacity: .3; } }
.tc-toolbar .sp { flex: 1; }

/* 范围分段切换 */
.seg { display: flex; background: var(--bg-inset); border: 1px solid var(--line); border-radius: var(--r-ctl); padding: 2px; }
.seg button {
  height: 26px; padding: 0 12px; border: none; border-radius: 4px; background: none;
  font-size: var(--fs-aux); color: var(--text-2); cursor: pointer; transition: all .15s; white-space: nowrap;
}
.seg button.on { background: var(--bg-panel); color: var(--text-1); box-shadow: var(--shadow-float); font-weight: 600; }
.seg button b { font-family: var(--font-mono); font-weight: 500; font-size: var(--fs-meta); color: var(--text-3); margin-left: 4px; }
.seg button.on b { color: var(--accent); }

/* 搜索框 */
.search { position: relative; width: 300px; }
.search input {
  width: 100%; height: 30px; padding: 0 30px; border: 1px solid var(--line); border-radius: var(--r-ctl);
  background: var(--bg-overlay); color: var(--text-1); font-size: var(--fs-aux); outline: none; transition: border-color .15s;
}
.search input::placeholder { color: var(--text-3); }
.search input:focus { border-color: var(--accent-line); }
.search .ic { position: absolute; left: 9px; top: 7px; color: var(--text-3); font-size: 13px; pointer-events: none; }
.search kbd {
  position: absolute; right: 8px; top: 5px; font-family: var(--font-mono); font-size: 10px; color: var(--text-3);
  border: 1px solid var(--line); border-radius: 4px; padding: 1px 5px; background: var(--bg-inset); pointer-events: none;
}
.search .clr {
  position: absolute; right: 4px; top: 3px; width: 22px; height: 22px; border: none; background: none;
  color: var(--text-3); font-size: 14px; cursor: pointer; border-radius: 4px;
}
.search .clr:hover { color: var(--text-1); background: var(--bg-inset); }

/* ---------- 状态统计卡 ---------- */
.statbar { display: grid; grid-template-columns: repeat(7, 1fr); gap: 10px; margin-bottom: 14px; }
.stat {
  position: relative; padding: 12px 14px 10px; border: 1px solid var(--line); border-radius: var(--r-panel);
  background: var(--bg-panel); cursor: pointer; text-align: left;
  transition: border-color .15s, transform .15s, background .15s;
  overflow: hidden; user-select: none; display: flex; flex-direction: column;
}
.stat:hover { border-color: var(--line-strong); transform: translateY(-1px); }
.stat .rail { position: absolute; left: 0; top: 0; bottom: 0; width: 3px; opacity: .85; }
.rail.run { background: var(--accent); }
.rail.warn { background: var(--warn); }
.rail.ok { background: var(--ok); }
.rail.danger { background: var(--danger); }
.rail.idle { background: var(--line-strong); }
.stat .lbl { font-size: var(--fs-meta); color: var(--text-2); display: flex; align-items: center; gap: 6px; margin-bottom: 6px; }
.stat .num { font-family: var(--font-mono); font-size: 22px; font-weight: 600; line-height: 1; letter-spacing: -.5px; color: var(--text-1); }
.stat .sub { font-size: 10.5px; color: var(--text-3); margin-top: 5px; }
.stat.on { border-color: var(--accent-line); background: linear-gradient(180deg, var(--accent-soft), transparent 130%); }
.stat.on .num { color: var(--accent); }
.dot { width: 6px; height: 6px; border-radius: 50%; flex: none; display: inline-block; background: var(--text-3); }
.dot.run { background: var(--accent); animation: pulse 1.6s infinite; }
.dot.warn { background: var(--warn); }
.dot.ok { background: var(--ok); }
.dot.danger { background: var(--danger); }
.dot.idle { background: var(--text-3); }

/* ---------- 列表头 ---------- */
.list-head { display: flex; align-items: center; gap: 12px; margin: 4px 0 10px; }
.list-head .res { font-size: var(--fs-aux); color: var(--text-3); }
.list-head .res b { font-family: var(--font-mono); color: var(--text-2); font-weight: 500; }
.list-head .sp { flex: 1; }
.vswitch { display: flex; gap: 2px; background: var(--bg-inset); border: 1px solid var(--line); border-radius: var(--r-ctl); padding: 2px; }
.vswitch button { height: 24px; padding: 0 10px; border: none; background: none; border-radius: 4px; font-size: var(--fs-aux); color: var(--text-3); cursor: pointer; }
.vswitch button.on { background: var(--bg-panel); color: var(--text-1); }

/* ---------- 分页 ---------- */
.tfoot { display: flex; align-items: center; gap: 10px; margin-top: 12px; }
.tfoot .info { font-size: var(--fs-aux); color: var(--text-3); }
.tfoot .sp { flex: 1; }
.pageno { display: flex; gap: 5px; }
.pageno button {
  min-width: 27px; height: 27px; padding: 0 6px; border: 1px solid var(--line); border-radius: var(--r-ctl);
  background: var(--bg-panel); color: var(--text-2); font-family: var(--font-mono); font-size: var(--fs-aux); cursor: pointer; transition: all .15s;
}
.pageno button:hover:not(:disabled) { border-color: var(--line-strong); color: var(--text-1); }
.pageno button.on { border-color: var(--accent-line); color: var(--accent); background: var(--accent-soft); font-weight: 600; }
.pageno button:disabled { opacity: .35; cursor: not-allowed; }

/* ---------- 窄屏：统计卡折行 ---------- */
@media (max-width: 1280px) {
  .statbar { grid-template-columns: repeat(4, 1fr); }
}
@media (max-width: 900px) {
  .tc-toolbar { flex-wrap: wrap; }
  .search { width: 100%; }
  .statbar { grid-template-columns: repeat(2, 1fr); }
}
</style>
