<template>
  <div>
    <div v-for="q in visibleQueues" :key="q.key" class="queue-strip" :class="{ 'queue-blocked': q.blocked }">
      <el-tag size="small" :type="q.blocked ? 'danger' : 'primary'">{{ queueLabel(q) }}</el-tag>
      <span class="queue-info mono">
        {{ q.running_task_id ? `执行中: ${q.running_task_id}` : '空闲' }}
        <template v-if="q.pending.length"> · 排队 {{ q.pending.length }}: {{ q.pending.map((e) => e.task_id).join('、') }}</template>
      </span>
      <span v-if="q.blocked" class="queue-reason">{{ q.blocked_reason }}</span>
      <el-button v-if="q.blocked" size="small" type="primary" @click="onResume(q.key)">恢复执行</el-button>
      <el-button v-if="q.pending.length" size="small" plain @click="onClear(q.key)">清空排队</el-button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { api, type QueueSnapshot } from '../api';

const queues = ref<QueueSnapshot[]>([]);
let queueTimer: number | null = null;
const visibleQueues = computed(() => queues.value.filter((q) => q.running_task_id || q.pending.length || q.blocked));

// 车道键按工作区（Phase 1）：绑项目的显示项目名，纯工作区车道显示目录名
function queueLabel(q: QueueSnapshot): string {
  if (q.project_id) return `项目队列 ${q.project_id}`;
  const base = (q.workspace || '').replace(/\\/g, '/').split('/').filter(Boolean).pop();
  return base ? `工作区队列 ${base}` : '工作区队列';
}

async function refreshQueues() {
  try {
    queues.value = (await api.queues()).queues;
  } catch { /* server unreachable — keep last snapshot */ }
}

async function onResume(key: string) {
  try {
    await api.resumeQueue(key);
    ElMessage.success('队列已恢复，开始执行下一个任务');
    await refreshQueues();
  } catch (e: any) {
    ElMessage.error(e.message || '恢复失败');
  }
}

async function onClear(key: string) {
  // 破坏性操作：清空后排队任务不再自动执行，需二次确认
  try {
    await ElMessageBox.confirm('确定清空该队列的所有排队任务？清空后需手动重新执行。', '清空排队', { type: 'warning' });
  } catch {
    return;
  }
  try {
    await api.clearQueue(key);
    ElMessage.success('已清空排队任务');
    await refreshQueues();
  } catch (e: any) {
    ElMessage.error(e.message || '清空失败');
  }
}

onMounted(() => {
  refreshQueues();
  queueTimer = window.setInterval(refreshQueues, 5000);
});
onUnmounted(() => {
  if (queueTimer !== null) window.clearInterval(queueTimer);
});
</script>

<style scoped>
.queue-strip { display: flex; align-items: center; gap: 10px; padding: 8px 12px; margin-bottom: 10px; border: 1px solid var(--line-strong); border-radius: 8px; flex-wrap: wrap; }
.queue-strip.queue-blocked { border-color: var(--danger); }
.queue-info { font-size: var(--fs-aux); color: var(--text-2); }
.queue-reason { font-size: var(--fs-aux); color: var(--danger); flex: 1; }
</style>
