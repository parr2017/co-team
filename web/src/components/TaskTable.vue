<template>
  <el-table :data="rows" size="small" class="task-table" empty-text="暂无任务" @row-click="(r: Row) => emit('show-detail', r.task_id)">
    <el-table-column label="任务" min-width="240">
      <template #default="{ row }">
        <div class="t-name" :title="row.description">{{ row.description || '（无描述）' }}</div>
        <div class="t-sub mono">
          <span>{{ row.task_id }}</span>
          <span class="tag">项目</span>
          <span class="tag">{{ levelLabel(row.level) }}</span>
        </div>
      </template>
    </el-table-column>

    <el-table-column label="状态" width="120">
      <template #default="{ row }">
        <div class="statuscell"><span class="dot" :class="statusDot(row.status)"></span>{{ statusLabel(row.status) }}</div>
      </template>
    </el-table-column>

    <el-table-column label="当前 Agent" width="132">
      <template #default="{ row }">
        <div v-if="row.currentAgent" class="t-agent">
          <AgentAvatar :name="row.currentAgent" :size="22" />
          <span class="mono">{{ row.currentAgent }}</span>
        </div>
        <span v-else class="t-dim">—</span>
      </template>
    </el-table-column>

    <el-table-column label="进度" width="150">
      <template #default="{ row }">
        <div class="t-progress" :title="`${row.done}/${row.total} 节点完成`">
          <div class="pbar"><i :style="{ width: row.percent + '%', background: row.percent === 100 ? 'var(--ok)' : 'var(--accent)' }"></i></div>
          <span class="t-progress-text mono">{{ row.percent }}%</span>
        </div>
      </template>
    </el-table-column>

    <el-table-column label="Token" width="90">
      <template #default="{ row }">
        <span v-if="row.tokens" class="mono t-tok">{{ fmtTok(row.tokens) }}</span>
        <span v-else class="t-dim mono">—</span>
      </template>
    </el-table-column>

    <el-table-column label="失败原因" min-width="200" show-overflow-tooltip>
      <template #default="{ row }">
        <span v-if="row.error" class="t-error mono">{{ row.error }}</span>
        <span v-else class="t-dim">—</span>
      </template>
    </el-table-column>

    <el-table-column label="更新时间" width="120">
      <template #default="{ row }">
        <span class="t-dim mono">{{ fmtTime(row.updated_at) }}</span>
      </template>
    </el-table-column>

    <el-table-column label="操作" width="150" fixed="right">
      <template #default="{ row }">
        <div class="acts">
          <button v-if="row.status === 'planned'" class="t-act accent" @click.stop="emit('review', row.task_id)">审核计划</button>
          <button v-else-if="row.status === 'clarifying'" class="t-act accent" @click.stop="emit('clarify', row.task_id)">回复澄清</button>
          <template v-else>
            <button class="t-act accent" @click.stop="emit('show-detail', row.task_id)">详情</button>
            <button class="t-act" @click.stop="emit('show-logs', row.task_id, row.currentNodeId)">日志</button>
            <button v-if="canRestart(row.status)" class="t-act" @click.stop="onRestart(row)">重启</button>
            <button v-if="canCancel(row.status)" class="t-act danger" @click.stop="emit('cancel', row.task_id)">取消</button>
            <el-dropdown trigger="click" @command="(cmd: string) => onMore(cmd, row)">
              <button class="t-act t-more" @click.stop>更多</button>
              <template #dropdown>
                <el-dropdown-menu>
                  <el-dropdown-item command="dag">拓扑图</el-dropdown-item>
                  <el-dropdown-item command="delete" divided>删除任务</el-dropdown-item>
                </el-dropdown-menu>
              </template>
            </el-dropdown>
          </template>
        </div>
      </template>
    </el-table-column>
  </el-table>
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

const props = defineProps<{ tasks: Record<string, TaskGraph>; filterStatus?: string }>();

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
  else if (cmd === 'delete') emit('delete', row.task_id);
}

function statusLabel(s: string) {
  return statusText(s);
}
/** 状态点色（预览样式：点 + 文字替代 tag） */
function statusDot(s: string): string {
  if (['running', 'retrying', 'finalizing'].includes(s)) return 'run';
  if (['waiting_approval', 'waiting_clarify', 'clarifying', 'planned'].includes(s)) return 'warn';
  if (['completed', 'success', 'completed_with_warnings'].includes(s)) return 'ok';
  if (s === 'failed') return 'danger';
  return '';
}
function levelLabel(l: string) {
  return ({ light: '轻量', standard: '标准', heavy: '重量' } as Record<string, string>)[l] || l;
}
function levelType(l: string) {
  return ({ light: 'success', standard: 'info', heavy: 'warning' } as Record<string, any>)[l] || 'info';
}
function fmtTime(ts: string): string {
  if (!ts) return '';
  try {
    return new Date(ts).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
  } catch {
    return ts;
  }
}
</script>

<style scoped>
.task-table { width: 100%; cursor: default; }
/* 状态格：点 + 文字（mono 计量除外） */
.statuscell { display: flex; align-items: center; gap: 7px; font-size: 12.5px; color: var(--text-1); white-space: nowrap; }
.statuscell .dot { width: 6px; height: 6px; border-radius: 50%; flex: none; background: var(--text-3); }
.statuscell .dot.run { background: var(--accent); animation: pulse 1.6s infinite; }
.statuscell .dot.ok { background: var(--ok); }
.statuscell .dot.warn { background: var(--warn); }
.statuscell .dot.danger { background: var(--danger); }
@keyframes pulse { 50% { opacity: .35; } }
.t-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 420px; font-size: 13px; font-weight: 600; color: var(--text-1); line-height: 1.4; }
.t-sub { display: flex; align-items: center; gap: 6px; margin-top: 3px; font-size: var(--fs-meta); color: var(--text-3); }
.task-table .tag { display: inline-flex; align-items: center; height: 16px; padding: 0 6px; border-radius: 4px; flex: none; font-size: var(--fs-meta); font-family: var(--font-mono); color: var(--text-3); background: var(--bg-raised); border: 1px solid var(--line); }
.t-agent { display: flex; align-items: center; gap: 6px; font-size: var(--fs-aux); color: var(--text-2); }
.t-dim { color: var(--text-3); font-size: var(--fs-aux); }
.t-progress { display: flex; align-items: center; gap: 8px; }
.pbar { width: 90px; height: 4px; border-radius: 3px; background: var(--bg-inset); overflow: hidden; flex: none; }
.pbar i { display: block; height: 100%; border-radius: 3px; }
.t-progress-text { font-size: var(--fs-aux); color: var(--text-2); flex-shrink: 0; font-variant-numeric: tabular-nums; }
.t-tok { font-size: var(--fs-aux); color: var(--text-2); font-variant-numeric: tabular-nums; }
.t-error { color: var(--danger); font-size: var(--fs-aux); }
.acts { display: flex; gap: 4px; opacity: .55; transition: opacity .15s; }
.task-table :deep(.el-table__row:hover) .acts,
.acts:focus-within { opacity: 1; }
.t-act {
  border: none; background: none; color: var(--text-2); font-size: var(--fs-aux);
  padding: 2px 5px; border-radius: 4px; cursor: pointer; white-space: nowrap;
}
.t-act:hover { background: var(--bg-raised); color: var(--text-1); }
.t-act.accent { color: var(--accent); }
.t-act.danger { color: var(--danger); }
.t-act.danger:hover { background: color-mix(in srgb, var(--danger) 10%, transparent); color: var(--danger); }
.t-more { margin-left: 4px; }
.task-table :deep(td.el-table__cell) { padding: 9px 0; }
</style>
