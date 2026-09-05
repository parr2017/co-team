<template>
  <el-table :data="rows" size="small" class="task-table" empty-text="暂无任务" @row-click="(r: Row) => emit('show-detail', r.task_id)">
    <el-table-column label="任务" min-width="240">
      <template #default="{ row }">
        <div class="t-name">{{ row.description || '（无描述）' }}</div>
        <div class="t-sub mono">
          <span>{{ row.task_id }}</span>
          <el-tag v-if="row.project_id" size="small" type="info" class="t-mini-tag">项目</el-tag>
          <el-tag v-if="row.level" size="small" effect="plain" :type="levelType(row.level)" class="t-mini-tag">{{ levelLabel(row.level) }}</el-tag>
        </div>
      </template>
    </el-table-column>

    <el-table-column label="状态" width="96">
      <template #default="{ row }">
        <el-tag :type="statusType(row.status)" size="small">{{ statusLabel(row.status) }}</el-tag>
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
        <div class="t-progress">
          <el-progress :percentage="row.percent" :stroke-width="6" :show-text="false" />
          <span class="t-progress-text mono">{{ row.done }}/{{ row.total }}</span>
        </div>
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

    <el-table-column label="操作" width="210" fixed="right">
      <template #default="{ row }">
        <el-button v-if="row.status === 'planned'" size="small" type="primary" link @click.stop="emit('review', row.task_id)">审核计划</el-button>
        <el-button v-else-if="row.status === 'clarifying'" size="small" type="warning" link @click.stop="emit('clarify', row.task_id)">回复澄清</el-button>
        <template v-else>
          <el-button size="small" type="primary" link @click.stop="emit('show-detail', row.task_id)">详情</el-button>
          <el-button size="small" type="primary" link @click.stop="emit('show-logs', row.task_id, row.currentNodeId)">日志</el-button>
          <el-button
            v-if="canRestart(row.status)"
            size="small"
            type="primary"
            link
            @click.stop="onRestart(row)"
          >重启</el-button>
          <el-button
            v-if="canCancel(row.status)"
            size="small"
            type="danger"
            link
            @click.stop="emit('cancel', row.task_id)"
          >取消</el-button>
          <el-dropdown trigger="click" @command="(cmd: string) => onMore(cmd, row)">
            <el-button size="small" type="primary" link class="t-more" @click.stop>更多</el-button>
            <template #dropdown>
              <el-dropdown-menu>
                <el-dropdown-item command="dag">拓扑图</el-dropdown-item>
                <el-dropdown-item command="delete" divided>删除任务</el-dropdown-item>
              </el-dropdown-menu>
            </template>
          </el-dropdown>
        </template>
      </template>
    </el-table-column>
  </el-table>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { api, type TaskGraph } from '../api';
import { useDashboard } from '../composables/useDashboard';
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
      const error = failed?.error
        || (failed ? `节点「${failed.name}」执行失败` : '')
        || (cancelled ? `下游节点「${cancelled.name}」因上游失败被取消` : '');
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
        error,
        updated_at: t.updated_at || '',
      };
    })
);

const canRestart = (s: string) => ['failed', 'completed', 'success', 'cancelled'].includes(s);
const canCancel = (s: string) => ['running', 'retrying', 'queued', 'pending', 'waiting_approval'].includes(s);

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
  return ({ planned: '待确认计划', clarifying: '需求需澄清', pending: '待执行', queued: '排队中', running: '执行中', completed: '已完成', success: '已完成', failed: '失败', waiting_approval: '待审批', retrying: '重试中', cancelled: '已取消' } as Record<string, string>)[s] || s;
}
function statusType(s: string) {
  return ({ success: 'success', completed: 'success', failed: 'danger', running: 'warning', retrying: 'warning', waiting_approval: 'primary', planned: 'primary', clarifying: 'warning', queued: 'info' } as Record<string, any>)[s] || 'info';
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
.t-name { font-size: 13px; font-weight: 500; color: var(--ct-text); line-height: 1.4; }
.t-sub { display: flex; align-items: center; gap: 6px; margin-top: 3px; font-size: 11px; color: var(--ct-text3); }
.t-mini-tag { transform: scale(0.85); }
.t-agent { display: flex; align-items: center; gap: 6px; font-size: 12px; color: var(--ct-text2); }
.t-dim { color: var(--ct-text3); font-size: 12px; }
.t-progress { display: flex; align-items: center; gap: 8px; }
.t-progress { --el-fill-color-blank: transparent; }
.t-progress :deep(.el-progress) { flex: 1; }
.t-progress-text { font-size: 11px; color: var(--ct-text3); flex-shrink: 0; }
.t-error { color: var(--ct-red); font-size: 12px; }
.t-more { margin-left: 12px; }
</style>
