<template>
  <el-dialog :model-value="modelValue" title="Agent 详情" width="640px" @close="$emit('close')">
    <template v-if="agent">
      <div class="detail-header">
        <div class="agent-avatar big" :style="{ background: color }">{{ badge }}</div>
        <div>
          <div class="name">{{ agent.name }}</div>
          <div class="role">{{ agent.role }}</div>
        </div>
        <el-tag size="small" style="margin-left: auto">{{ statusText }}</el-tag>
      </div>
      <div v-if="agent.task?.taskId" style="margin-top: 10px; text-align: right">
        <el-button size="small" type="primary" plain @click="$emit('open-detail', agent.task!.taskId)">查看执行详情</el-button>
      </div>
      <div class="section-title" style="margin-top: 16px">当前任务</div>
      <div class="value">
        <template v-if="agent.task">
          <b>{{ agent.task.name }}</b>
          <div v-if="agent.task.error" style="color: var(--el-color-danger)">错误: {{ agent.task.error }}</div>
        </template>
        <span v-else class="muted">暂无任务</span>
      </div>
      <div class="section-title" style="margin-top: 12px">文件变更</div>
      <div class="value">
        <div v-if="agent.changes.length">
          <div v-for="c in agent.changes" :key="c" class="change">[ok] {{ c }}</div>
        </div>
        <span v-else class="muted">暂无变更</span>
      </div>
      <div class="section-title" style="margin-top: 12px">活动记录</div>
      <el-timeline style="padding-left: 4px">
        <el-timeline-item v-for="(h, i) in agent.history.slice(0, 15)" :key="i" :timestamp="new Date(h.ts).toLocaleTimeString()" :type="tlType(h.type)">
          {{ h.text }}
        </el-timeline-item>
      </el-timeline>
    </template>
  </el-dialog>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import type { AgentLiveState } from '../composables/useDashboard';

const props = defineProps<{ modelValue: boolean; agent: AgentLiveState | null }>();
defineEmits<{ (e: 'close'): void; (e: 'open-detail', taskId: string): void }>();

const META: Record<string, { icon: string; color: string }> = {
  orchestrator: { icon: '🧠', color: 'linear-gradient(135deg,var(--ct-accent),#4f46e5)' },
  dev: { icon: '💻', color: 'linear-gradient(135deg,#3b82f6,#2563eb)' },
  review: { icon: '🔍', color: 'linear-gradient(135deg,var(--ct-yellow),#d97706)' },
  test: { icon: '🧪', color: 'linear-gradient(135deg,var(--ct-green),#059669)' },
  deploy: { icon: '🚀', color: 'linear-gradient(135deg,var(--ct-red),#db2777)' },
  docs: { icon: '📝', color: 'linear-gradient(135deg,#06b6d4,#0891b2)' },
  refactor: { icon: '♻️', color: 'linear-gradient(135deg,#a855f7,#7c3aed)' },
};
const badge = computed(() => (props.agent?.name || '??').replace(/[^a-z]/gi, '').slice(0, 2).toUpperCase());
const color = computed(() => META[props.agent?.name || '']?.color || 'linear-gradient(135deg,var(--ct-text3),#475569)');
const statusText = computed(() => ({ idle: '空闲', running: '工作中', done: '已完成', error: '出错' })[props.agent?.status || 'idle'] || props.agent?.status);
function tlType(t: string) {
  return t.includes('error') ? 'danger' : t.includes('complete') ? 'success' : t.includes('start') ? 'warning' : 'info';
}
</script>

<style scoped>
.detail-header { display: flex; align-items: center; gap: 14px; }
.agent-avatar.big { width: 52px; height: 52px; border-radius: 12px; display: flex; align-items: center; justify-content: center; font-size: 26px; }
.name { font-size: 18px; font-weight: 700; }
.role { font-size: 13px; color: var(--ct-text3); }
.value { background: var(--ct-bg); border-radius: 8px; padding: 12px; font-size: 13px; color: var(--ct-text2); }
.change { padding: 2px 0; }
.muted { color: var(--ct-text3); }
</style>
