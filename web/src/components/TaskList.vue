<template>
  <div class="section">
    <div class="section-head">
      <div class="section-title">任务列表</div>
      <el-tag size="small" type="info">{{ Object.keys(tasks).length }} 个任务</el-tag>
    </div>
    <div v-if="!Object.keys(tasks).length" class="empty">暂无任务</div>
    <div v-for="t in sorted" :key="t.task_id" class="task-item">
      <div class="task-header">
        <span class="task-id">{{ t.task_id }} · {{ t.workspace }}</span>
        <span class="task-actions">
          <el-tag :type="statusType(t.status)" size="small">{{ statusLabel(t.status) }}</el-tag>
          <el-button v-if="t.status === 'planned'" size="small" type="primary" @click="$emit('review', t.task_id)">审核计划</el-button>
          <el-button v-if="t.status !== 'planned'" size="small" link type="primary" @click="$emit('show-detail', t.task_id)">详情</el-button>
          <el-button v-if="t.status !== 'planned'" size="small" link type="primary" @click="$emit('show-dag', t.task_id)">拓扑图</el-button>
          <el-button v-if="t.status === 'running' || t.status === 'pending'" size="small" link type="danger" @click="$emit('cancel', t.task_id)">取消</el-button>
        </span>
      </div>
      <div v-if="t.description" class="task-desc">{{ t.description }}</div>
      <div class="progress-track"><div class="progress-fill" :style="{ width: progress(t) + '%' }"></div></div>
      <div class="task-nodes">
        <template v-for="n in t.nodes" :key="n.id">
          <span class="node-tag" :class="n.status" @click="$emit('show-logs', t.task_id, n.id)" title="点击查看对话记录">
            {{ n.name }}: {{ statusLabel(n.status) }}{{ n.retry_count ? ` (重试${n.retry_count})` : '' }}
          </span>
          <el-button v-if="n.status === 'waiting_approval'" class="approve-btn" size="small" type="primary" @click="$emit('approve', t.task_id, n.id)">审批</el-button>
        </template>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import type { TaskGraph } from '../api';

const props = defineProps<{ tasks: Record<string, TaskGraph> }>();
defineEmits<{ (e: 'approve', taskId: string, nodeId: string): void; (e: 'cancel', taskId: string): void; (e: 'show-logs', taskId: string, nodeId: string): void; (e: 'show-dag', taskId: string): void; (e: 'show-detail', taskId: string): void; (e: 'review', taskId: string): void }>();

function progress(t: TaskGraph): number {
  const total = t.nodes?.length || 0;
  if (!total) return 0;
  const done = t.nodes.filter((n) => n.status === 'completed').length;
  return Math.round((done / total) * 100);
}

const sorted = computed(() => Object.values(props.tasks).sort((a, b) => (b.updated_at || '').localeCompare(a.updated_at || '')));

function statusLabel(s: string) {
  return ({ planned: '待确认计划', pending: '待执行', running: '执行中', completed: '已完成', success: '已完成', failed: '失败', waiting_approval: '待审批', retrying: '重试中', cancelled: '已取消' } as Record<string, string>)[s] || s;
}
function statusType(s: string) {
  return ({ success: 'success', completed: 'success', failed: 'danger', running: 'warning', retrying: 'warning', waiting_approval: 'primary', planned: 'primary' } as Record<string, any>)[s] || 'info';
}
</script>

<style scoped>
.empty { text-align: center; padding: 40px; color: var(--ct-text3); }
.task-item { background: var(--el-bg-color); border: 1px solid var(--el-border-color); border-radius: 10px; padding: 14px; margin-bottom: 10px; }
.task-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px; }
.task-id { font-size: 11px; color: var(--ct-text3); font-family: monospace; }
.task-actions { display: flex; gap: 6px; align-items: center; }
.task-desc { font-size: 13px; color: var(--ct-text2); margin-bottom: 10px; }
.task-nodes { display: flex; gap: 6px; flex-wrap: wrap; align-items: center; }
.node-tag { font-size: 11px; padding: 3px 8px; border-radius: 5px; border: 1px solid var(--ct-border2); color: var(--ct-text3); cursor: pointer; }
.node-tag.running, .node-tag.retrying { border-color: var(--ct-yellow); color: var(--ct-yellow); }
.node-tag.completed { border-color: var(--ct-green); color: var(--ct-green); }
.node-tag.failed { border-color: var(--ct-red); color: var(--ct-red); }
.node-tag.waiting_approval { border-color: var(--ct-accent); color: var(--ct-accent); }
.approve-btn { height: 22px; }
.section-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 12px; }
</style>
