<template>
  <div class="section">
    <div class="section-head">
      <div class="section-title">任务列表</div>
      <div class="section-actions">
        <el-tag size="small" type="info">{{ total }} 个任务</el-tag>
        <el-pagination
          v-if="total > pageSize"
          small
          layout="prev, pager, next"
          :total="total"
          :page-size="pageSize"
          :current-page="currentPage"
          @current-change="onPageChange"
        />
      </div>
    </div>
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
    <QueuePanel />
    <div v-if="!sorted.length" class="empty">暂无任务</div>
    <div v-for="t in sorted" :key="t.task_id" class="task-item">
      <div class="task-header">
        <span class="task-id">{{ t.task_id }}<el-tag v-if="t.project_id" size="small" type="info" class="task-proj-tag">项目</el-tag></span>
        <span class="task-actions">
          <el-tag v-if="t.level" size="small" :type="levelType(t.level)" effect="plain">{{ levelLabel(t.level) }}</el-tag>
          <el-tag :type="statusType(t.status)" size="small">{{ statusLabel(t.status) }}</el-tag>
          <el-button v-if="t.status === 'planned'" size="small" type="primary" @click="$emit('review', t.task_id)">审核计划</el-button>
          <el-button v-if="t.status === 'clarifying'" size="small" type="warning" @click="$emit('clarify', t.task_id)">回复澄清</el-button>
          <el-button v-if="t.status !== 'planned' && t.status !== 'clarifying'" size="small" link type="primary" @click="$emit('show-detail', t.task_id)">详情</el-button>
          <el-button v-if="t.status !== 'planned' && t.status !== 'clarifying'" size="small" link type="primary" @click="$emit('show-dag', t.task_id)">拓扑图</el-button>
          <el-button v-if="t.status === 'running' || t.status === 'pending' || t.status === 'queued'" size="small" link type="danger" @click="$emit('cancel', t.task_id)">取消</el-button>
          <el-button size="small" link type="danger" @click="$emit('delete', t.task_id)">删除</el-button>
        </span>
      </div>
      <div v-if="t.description" class="task-desc">{{ t.description }}</div>
      <div class="task-time">
        <span v-if="t.created_at">创建: {{ fmtTime(t.created_at) }}</span>
        <span v-if="t.updated_at">更新: {{ fmtTime(t.updated_at) }}</span>
      </div>
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
import { computed, ref } from 'vue';
import type { TaskGraph } from '../api';
import QueuePanel from './QueuePanel.vue';

const props = defineProps<{ tasks: Record<string, TaskGraph>; total?: number; currentPage?: number; pageSize?: number; filterStatus?: string }>();
const emit = defineEmits<{ (e: 'approve', taskId: string, nodeId: string): void; (e: 'cancel', taskId: string): void; (e: 'delete', taskId: string): void; (e: 'show-logs', taskId: string, nodeId: string): void; (e: 'show-dag', taskId: string): void; (e: 'show-detail', taskId: string): void; (e: 'review', taskId: string): void; (e: 'clarify', taskId: string): void; (e: 'page-change', page: number): void; (e: 'search', keyword: string): void }>();

const keyword = ref('');

function doSearch() {
  emit('search', keyword.value.trim());
}

const total = computed(() => props.total ?? Object.keys(props.tasks).length);
const currentPage = computed(() => props.currentPage ?? 1);
const pageSize = computed(() => props.pageSize ?? 20);

function onPageChange(page: number) {
  emit('page-change', page);
}

function progress(t: TaskGraph): number {
  const total = t.nodes?.length || 0;
  if (!total) return 0;
  const done = t.nodes.filter((n) => n.status === 'completed').length;
  return Math.round((done / total) * 100);
}

const sorted = computed(() =>
  Object.values(props.tasks)
    .filter((t) => {
      if (!props.filterStatus) return true;
      // comma-separated status list, e.g. "running,retrying"
      return props.filterStatus.split(',').includes(t.status);
    })
    .sort((a, b) => (b.updated_at || '').localeCompare(a.updated_at || ''))
);

function fmtTime(ts: string): string {
  if (!ts) return '';
  try {
    return new Date(ts).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
  } catch {
    return ts;
  }
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
</script>

<style scoped>
.empty { text-align: center; padding: 40px; color: var(--ct-text3); }
.task-item { background: var(--el-bg-color); border: 1px solid var(--el-border-color); border-radius: 10px; padding: 14px; margin-bottom: 10px; }
.task-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px; }
.task-id { font-size: 11px; color: var(--ct-text3); font-family: monospace; display: flex; align-items: center; gap: 6px; }
.task-proj-tag { transform: scale(0.85); }
.task-actions { display: flex; gap: 6px; align-items: center; }
.task-desc { font-size: 13px; color: var(--ct-text2); margin-bottom: 10px; }
.task-time { font-size: 11px; color: var(--ct-text3); margin-bottom: 8px; display: flex; gap: 16px; }
.task-nodes { display: flex; gap: 6px; flex-wrap: wrap; align-items: center; }
.node-tag { font-size: 11px; padding: 3px 8px; border-radius: 5px; border: 1px solid var(--ct-border2); color: var(--ct-text3); cursor: pointer; }
.node-tag.running, .node-tag.retrying { border-color: var(--ct-yellow); color: var(--ct-yellow); }
.node-tag.completed { border-color: var(--ct-green); color: var(--ct-green); }
.node-tag.failed { border-color: var(--ct-red); color: var(--ct-red); }
.node-tag.waiting_approval { border-color: var(--ct-accent); color: var(--ct-accent); }
.approve-btn { height: 22px; }
.section-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 12px; }
.section-actions { display: flex; align-items: center; gap: 12px; }
.search-row { margin-bottom: 12px; }
.search-input { max-width: 320px; }
</style>
