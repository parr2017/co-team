<template>
  <div>
    <!-- 空态 -->
    <div v-if="!rows.length" class="tt-empty">
      <div class="e-title">暂无任务</div>
      <div class="e-text">当前口径与筛选下没有任务，试试切换范围或清空状态筛选</div>
    </div>

    <!-- ============ 表格视图：行卡（左状态色轨 + 状态药丸 + 失败原因前置） ============ -->
    <template v-else-if="viewMode === 'table'">
      <div class="rows-scroll">
        <div class="rows">
          <div class="thead">
            <span>状态</span><span>任务</span><span>当前 Agent</span><span>进度</span><span>Token</span><span>更新时间</span>
            <span class="th-acts">操作</span>
          </div>

          <div
            v-for="row in rows"
            :key="row.task_id"
            class="trow"
            :class="railClass(row.status)"
            @click="emit('show-detail', row.task_id)"
          >
            <span class="pill" :class="pillClass(row.status)">
              <span v-if="pillClass(row.status) !== 'dim'" class="dot" :class="pillClass(row.status)"></span>{{ statusLabel(row.status) }}
            </span>

            <div class="t-main">
              <div class="t-title" :title="row.description">{{ row.description || '（无描述）' }}</div>
              <div class="t-meta">
                <span class="id mono">{{ row.task_id }}</span>
                <span v-if="row.project_id" class="tag proj">{{ row.project_id }}</span>
                <span class="tag">{{ levelLabel(row.level) }}</span>
                <span class="tag">{{ row.project_id ? '项目任务' : '外部下发' }}</span>
              </div>
              <div v-if="row.error" class="t-err" :title="row.error">{{ row.error }}</div>
            </div>

            <div class="t-agent">
              <template v-if="row.currentAgent">
                <AgentAvatar :name="row.currentAgent" :size="24" :active="['running', 'retrying'].includes(row.status)" />
                <span class="nm mono">{{ row.currentAgent }}</span>
              </template>
              <span v-else class="t-none">—</span>
            </div>

            <div class="t-prog" :title="`${row.done}/${row.total} 节点完成`">
              <div class="pbar"><i :class="{ done: row.percent === 100, bad: row.status === 'failed' }" :style="{ width: row.percent + '%' }"></i></div>
              <div class="prow"><b class="mono">{{ row.percent }}%</b><span class="mono">{{ row.done }}/{{ row.total }} 节点</span></div>
            </div>

            <span v-if="row.tokens" class="t-tok mono">{{ fmtTok(row.tokens) }}</span>
            <span v-else class="t-none mono">—</span>

            <span class="t-time mono">{{ fmtTime(row.updated_at) }}</span>

            <div class="t-acts" @click.stop>
              <button v-if="row.status === 'planned'" class="abtn pri" @click.stop="emit('review', row.task_id)">审核计划</button>
              <button v-else-if="row.status === 'clarifying'" class="abtn pri" @click.stop="emit('clarify', row.task_id)">回复澄清</button>
              <button v-else-if="row.status === 'failed'" class="abtn pri" @click.stop="onRestart(row)">重启</button>
              <button v-else class="abtn pri" @click.stop="emit('show-detail', row.task_id)">详情</button>
              <button class="abtn ghost" @click.stop="emit('show-logs', row.task_id, row.currentNodeId)">日志</button>
              <button v-if="row.status !== 'planned' && row.status !== 'clarifying' && row.status !== 'failed' && canRestart(row.status)" class="abtn ghost" @click.stop="onRestart(row)">重启</button>
              <button v-if="canCancel(row.status)" class="abtn ghost danger" @click.stop="emit('cancel', row.task_id)">取消</button>
              <el-dropdown trigger="click" @command="(cmd: string) => onMore(cmd, row)">
                <button class="abtn ghost t-more" @click.stop>⋯</button>
                <template #dropdown>
                  <el-dropdown-menu>
                    <el-dropdown-item command="dag">拓扑图</el-dropdown-item>
                    <el-dropdown-item command="detail">详情</el-dropdown-item>
                    <el-dropdown-item command="delete" divided>删除任务</el-dropdown-item>
                  </el-dropdown-menu>
                </template>
              </el-dropdown>
            </div>
          </div>
        </div>
      </div>
    </template>

    <!-- ============ 卡片视图 ============ -->
    <div v-else class="cards">
      <div
        v-for="row in rows"
        :key="row.task_id"
        class="card"
        :class="railClass(row.status)"
        @click="emit('show-detail', row.task_id)"
      >
        <div class="c-top">
          <div class="c-head">
            <div class="t-title" :title="row.description">{{ row.description || '（无描述）' }}</div>
            <div class="t-meta">
              <span class="id mono">{{ row.task_id }}</span>
              <span v-if="row.project_id" class="tag proj">{{ row.project_id }}</span>
              <span class="tag">{{ levelLabel(row.level) }}</span>
              <span class="tag">{{ row.project_id ? '项目任务' : '外部下发' }}</span>
            </div>
            <div v-if="row.error" class="t-err" :title="row.error">{{ row.error }}</div>
          </div>
          <span class="pill" :class="pillClass(row.status)">
            <span v-if="pillClass(row.status) !== 'dim'" class="dot" :class="pillClass(row.status)"></span>{{ statusLabel(row.status) }}
          </span>
        </div>

        <div class="c-prog" :title="`${row.done}/${row.total} 节点完成`">
          <div class="pbar"><i :class="{ done: row.percent === 100, bad: row.status === 'failed' }" :style="{ width: row.percent + '%' }"></i></div>
          <div class="prow">
            <b class="mono">{{ row.percent }}%</b>
            <span class="mono">{{ row.done }}/{{ row.total }} 节点<template v-if="row.tokens"> · {{ fmtTok(row.tokens) }} tok</template></span>
          </div>
        </div>

        <div class="c-foot" @click.stop>
          <template v-if="row.currentAgent">
            <AgentAvatar :name="row.currentAgent" :size="22" :active="['running', 'retrying'].includes(row.status)" />
            <span class="nm mono">{{ row.currentAgent }}</span>
          </template>
          <span v-else class="t-none">—</span>
          <span class="sp"></span>
          <span class="t-time mono">{{ fmtTime(row.updated_at) }}</span>
          <button v-if="row.status === 'planned'" class="abtn pri" @click.stop="emit('review', row.task_id)">审核计划</button>
          <button v-else-if="row.status === 'clarifying'" class="abtn pri" @click.stop="emit('clarify', row.task_id)">回复澄清</button>
          <button v-else-if="row.status === 'failed'" class="abtn pri" @click.stop="onRestart(row)">重启</button>
          <button v-else class="abtn pri" @click.stop="emit('show-detail', row.task_id)">详情</button>
          <button class="abtn ghost" @click.stop="emit('show-logs', row.task_id, row.currentNodeId)">日志</button>
          <el-dropdown trigger="click" @command="(cmd: string) => onMore(cmd, row)">
            <button class="abtn ghost t-more" @click.stop>⋯</button>
            <template #dropdown>
              <el-dropdown-menu>
                <el-dropdown-item command="dag">拓扑图</el-dropdown-item>
                <el-dropdown-item command="detail">详情</el-dropdown-item>
                <el-dropdown-item command="delete" divided>删除任务</el-dropdown-item>
              </el-dropdown-menu>
            </template>
          </el-dropdown>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { api, type TaskGraph } from '../api';
import { useDashboard } from '../composables/useDashboard';
import { statusText } from '../utils/events';
import { fmtDateTime } from '../utils/time';
import AgentAvatar from './AgentAvatar.vue';

interface Row {
  task_id: string;
  description: string;
  project_id?: string | null;
  level?: string | null;
  status: string;
  currentAgent: string;
  currentNodeId: string;
  done: number;
  total: number;
  percent: number;
  tokens: number;
  error: string;
  updated_at: string;
}

const props = defineProps<{ tasks: Record<string, TaskGraph>; filterStatus?: string; viewMode?: 'table' | 'card' }>();

const emit = defineEmits<{
  (e: 'show-detail', taskId: string): void;
  (e: 'show-logs', taskId: string, nodeId: string): void;
  (e: 'show-dag', taskId: string): void;
  (e: 'review', taskId: string): void;
  (e: 'clarify', taskId: string): void;
  (e: 'cancel', taskId: string): void;
  (e: 'delete', taskId: string): void;
}>();

const { loadTasks } = useDashboard();

const rows = computed<Row[]>(() =>
  Object.values(props.tasks)
    .filter((t) => {
      if (!props.filterStatus) return true;
      return props.filterStatus.split(',').includes(t.status);
    })
    .sort((a, b) => (b.updated_at || '').localeCompare(a.updated_at || ''))
    .map((t) => {
      const active = t.nodes.find((n) => ['running', 'retrying', 'waiting_approval'].includes(n.status));
      const last = [...t.nodes].reverse().find((n) => n.agent !== 'orchestrator');
      const done = t.nodes.filter((n) => n.status === 'completed').length;
      const failed = t.nodes.find((n) => n.status === 'failed');
      const cancelled = t.nodes.find((n) => n.status === 'cancelled');
      const interrupted = t.nodes.find((n) => n.status === 'interrupted');
      const error = failed?.error
        || (failed ? `节点「${failed.name}」执行失败` : '')
        || (cancelled ? `下游节点「${cancelled.name}」因上游失败被取消` : '')
        || (interrupted ? `节点「${interrupted.name}」因服务重启中断，将自动续跑` : '');
      return {
        task_id: t.task_id,
        description: t.description || '',
        project_id: t.project_id,
        level: t.level,
        status: t.status,
        currentAgent: (active || last)?.agent || '',
        currentNodeId: (active || last)?.id || '',
        done,
        total: t.nodes.length,
        percent: t.nodes.length ? Math.round((done / t.nodes.length) * 100) : 0,
        tokens: t.nodes.reduce((sum, n) => sum + (n.result?.tokens || 0), 0),
        error,
        updated_at: t.updated_at || '',
      };
    })
);

function fmtTok(n: number): string {
  return n >= 1000 ? (Math.round(n / 100) / 10) + 'k' : String(n);
}

const canRestart = (s: string) => ['failed', 'completed', 'success', 'cancelled', 'interrupted'].includes(s);
const canCancel = (s: string) => ['running', 'retrying', 'queued', 'pending', 'waiting_approval', 'waiting_clarify', 'clarifying', 'interrupted', 'finalizing'].includes(s);

async function onRestart(row: Row) {
  try {
    await ElMessageBox.confirm(`确认重启任务 ${row.task_id}？任务将重新进入执行队列（已完成节点会重新执行）。`, '重启任务', {
      confirmButtonText: '重启',
      cancelButtonText: '取消',
      type: 'warning',
    });
  } catch {
    return; // user dismissed
  }
  try {
    await api.executeTask(row.task_id);
    ElMessage.success('已重新加入执行队列');
    void loadTasks();
  } catch (e: any) {
    ElMessage.error(`重启失败: ${e.message || e}`);
  }
}

function onMore(cmd: string, row: Row) {
  if (cmd === 'dag') emit('show-dag', row.task_id);
  else if (cmd === 'detail') emit('show-detail', row.task_id);
  else if (cmd === 'delete') emit('delete', row.task_id);
}

function statusLabel(s: string) {
  return statusText(s);
}

/** 状态药丸分组（统计口径同源：interrupted 算在途） */
function pillClass(s: string): string {
  if (['running', 'retrying', 'finalizing', 'interrupted'].includes(s)) return 'run';
  if (['waiting_approval', 'waiting_clarify', 'clarifying', 'planned'].includes(s)) return 'warn';
  if (['completed', 'success', 'completed_with_warnings'].includes(s)) return 'ok';
  if (s === 'failed') return 'bad';
  return 'dim';
}
/** 行卡左缘 3px 状态色轨 */
function railClass(s: string): string {
  const p = pillClass(s);
  return p === 'dim' ? '' : `st-${p}`;
}
function levelLabel(l?: string | null) {
  return ({ light: '轻量', standard: '标准', heavy: '重量' } as Record<string, string>)[l || ''] || l || '标准';
}
function fmtTime(ts: string): string {
  if (!ts) return '';
  try {
    return fmtDateTime(ts);
  } catch {
    return ts;
  }
}
</script>

<style scoped>
/* ---------- 空态 ---------- */
.tt-empty { display: flex; flex-direction: column; align-items: center; gap: 6px; padding: 56px 0 48px; border: 1px dashed var(--line); border-radius: var(--r-panel); }
.e-title { font-size: var(--fs-sub); color: var(--text-2); font-weight: 600; }
.e-text { font-size: var(--fs-aux); color: var(--text-3); }

/* ---------- 表格视图：行卡 ---------- */
.rows-scroll { overflow-x: auto; }
.rows { display: flex; flex-direction: column; gap: 6px; min-width: 1080px; }
.thead, .trow {
  display: grid; align-items: center; gap: 14px;
  grid-template-columns: 104px minmax(300px, 1.7fr) 150px 160px 84px 96px minmax(150px, auto);
}
.thead { padding: 2px 16px; font-size: var(--fs-meta); color: var(--text-3); }
.thead .th-acts { text-align: right; }
.trow {
  padding: 11px 16px; border: 1px solid var(--line); border-radius: var(--r-ctl); background: var(--bg-panel);
  cursor: pointer; transition: border-color .15s, background .15s, transform .12s, box-shadow .15s;
}
.trow:hover { border-color: var(--line-strong); background: var(--bg-raised); transform: translateY(-1px); box-shadow: var(--shadow-float); }
.trow.st-run { border-left: 3px solid var(--accent); }
.trow.st-warn { border-left: 3px solid var(--warn); }
.trow.st-bad { border-left: 3px solid var(--danger); }
.trow.st-ok { border-left: 3px solid color-mix(in srgb, var(--ok) 55%, transparent); }

/* ---------- 状态药丸 ---------- */
.pill {
  display: inline-flex; align-items: center; gap: 6px; height: 24px; padding: 0 10px; border-radius: 12px;
  font-size: var(--fs-meta); white-space: nowrap; border: 1px solid var(--line);
  background: var(--bg-inset); color: var(--text-2);
}
.pill.run { background: var(--accent-soft); border-color: var(--accent-line); color: var(--accent); font-weight: 600; }
.pill.warn { background: color-mix(in srgb, var(--warn) 13%, transparent); border-color: color-mix(in srgb, var(--warn) 40%, transparent); color: var(--warn); font-weight: 600; }
.pill.bad { background: color-mix(in srgb, var(--danger) 12%, transparent); border-color: color-mix(in srgb, var(--danger) 40%, transparent); color: var(--danger); font-weight: 600; }
.pill.ok { background: color-mix(in srgb, var(--ok) 12%, transparent); border-color: color-mix(in srgb, var(--ok) 40%, transparent); color: var(--ok); }
.pill.dim { color: var(--text-3); }
.dot { width: 6px; height: 6px; border-radius: 50%; flex: none; display: inline-block; background: var(--text-3); }
.dot.run { background: var(--accent); animation: pulse 1.6s infinite; }
.dot.warn { background: var(--warn); }
.dot.bad { background: var(--danger); }
.dot.ok { background: var(--ok); }
@keyframes pulse { 50% { opacity: .3; } }

/* ---------- 主列 ---------- */
.t-main, .c-head { min-width: 0; }
.t-title {
  font-size: var(--fs-sub); font-weight: 600; color: var(--text-1);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.t-meta { display: flex; align-items: center; gap: 8px; margin-top: 4px; font-size: var(--fs-meta); color: var(--text-3); }
.t-meta .id { font-family: var(--font-mono); }
.tag {
  font-size: 10px; padding: 1px 6px; border-radius: 4px; border: 1px solid var(--line);
  color: var(--text-3); background: var(--bg-inset); white-space: nowrap; flex: none;
}
.tag.proj { color: var(--ag-launcher); border-color: color-mix(in srgb, var(--ag-launcher) 38%, transparent); }
.t-err {
  margin-top: 4px; font-size: var(--fs-meta); color: var(--danger); font-family: var(--font-mono);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}

/* ---------- Agent 列 ---------- */
.t-agent { display: flex; align-items: center; gap: 8px; min-width: 0; }
.t-agent .nm { font-family: var(--font-mono); font-size: var(--fs-aux); color: var(--text-2); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.t-none { color: var(--text-3); font-size: var(--fs-aux); }

/* ---------- 进度列 ---------- */
.t-prog, .c-prog { min-width: 0; }
.pbar { height: 5px; border-radius: 3px; background: var(--bg-inset); overflow: hidden; }
.pbar i { display: block; height: 100%; border-radius: 3px; background: var(--accent); transition: width .3s; }
.pbar i.done { background: var(--ok); }
.pbar i.bad { background: var(--danger); }
.prow { display: flex; justify-content: space-between; font-family: var(--font-mono); font-size: 10.5px; color: var(--text-3); margin-top: 5px; }
.prow b { color: var(--text-2); font-weight: 500; }

/* ---------- token / 时间 ---------- */
.t-tok { font-family: var(--font-mono); font-size: var(--fs-aux); color: var(--text-2); }
.t-time { font-family: var(--font-mono); font-size: var(--fs-aux); color: var(--text-3); }

/* ---------- 操作列：主操作常驻 + 次操作半透明 hover 提亮 ---------- */
.t-acts { display: flex; gap: 6px; justify-content: flex-end; flex-wrap: nowrap; }
.abtn {
  height: 26px; padding: 0 11px; border: 1px solid var(--line-strong); border-radius: var(--r-ctl);
  background: var(--bg-panel); color: var(--text-2); font-size: var(--fs-aux); cursor: pointer;
  transition: all .15s; white-space: nowrap;
}
.abtn:hover { color: var(--text-1); border-color: var(--accent-line); background: var(--accent-soft); }
.abtn.pri { background: var(--accent); border-color: var(--accent); color: var(--accent-text); font-weight: 600; }
.abtn.pri:hover { filter: brightness(1.08); color: var(--accent-text); }
.abtn.ghost { opacity: .42; }
.trow:hover .abtn.ghost, .card:hover .abtn.ghost, .t-acts:focus-within .abtn.ghost { opacity: 1; }
.abtn.ghost.danger:hover { color: var(--danger); border-color: color-mix(in srgb, var(--danger) 45%, transparent); background: color-mix(in srgb, var(--danger) 10%, transparent); }
.t-more { padding: 0 8px; }

/* ---------- 卡片视图 ---------- */
.cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(400px, 1fr)); gap: 12px; }
.card {
  border: 1px solid var(--line); border-radius: var(--r-panel); background: var(--bg-panel); padding: 14px 16px;
  cursor: pointer; transition: border-color .15s, transform .12s, box-shadow .15s;
}
.card:hover { border-color: var(--line-strong); transform: translateY(-1px); box-shadow: var(--shadow-float); }
.card.st-run { border-left: 3px solid var(--accent); }
.card.st-warn { border-left: 3px solid var(--warn); }
.card.st-bad { border-left: 3px solid var(--danger); }
.card.st-ok { border-left: 3px solid color-mix(in srgb, var(--ok) 55%, transparent); }
.card .c-top { display: flex; align-items: flex-start; gap: 10px; }
.card .c-top .pill { margin-left: auto; flex: none; }
.card .t-title { white-space: normal; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; line-height: 1.35; }
.card .t-meta { flex-wrap: wrap; }
.card .c-prog { margin: 12px 0 10px; }
.card .c-foot { display: flex; align-items: center; gap: 8px; border-top: 1px solid var(--line); padding-top: 10px; }
.card .c-foot .sp { flex: 1; }
.card .c-foot .nm { font-family: var(--font-mono); font-size: var(--fs-aux); color: var(--text-2); }
</style>
