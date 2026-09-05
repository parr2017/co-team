<template>
  <div>
    <div v-for="q in visibleQueues" :key="q.key" class="queue-strip" :class="{ 'queue-blocked': q.blocked }">
      <el-tag size="small" :type="q.blocked ? 'danger' : 'primary'">{{ q.project_id ? `项目队列 ${q.project_id}` : '默认队列' }}</el-tag>
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
import { ElMessage } from 'element-plus';
import { api, type QueueSnapshot } from '../api';

const queues = ref<QueueSnapshot[]>([]);
let queueTimer: number | null = null;
const visibleQueues = computed(() => queues.value.filter((q) => q.running_task_id || q.pending.length || q.blocked));

async function refreshQueues() {
  try {
    queues.value = (await api.queues()).queues;
  } catch { /* server unreachable — keep last snapshot */ }
}

async function onResume(key: string) {
  await api.resumeQueue(key);
  ElMessage.success('队列已恢复，开始执行下一个任务');
  await refreshQueues();
}

async function onClear(key: string) {
  await api.clearQueue(key);
  ElMessage.success('已清空排队任务');
  await refreshQueues();
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
.queue-strip { display: flex; align-items: center; gap: 10px; padding: 8px 12px; margin-bottom: 10px; border: 1px solid var(--ct-border2); border-radius: 8px; flex-wrap: wrap; }
.queue-strip.queue-blocked { border-color: var(--ct-red); }
.queue-info { font-size: 12px; color: var(--ct-text2); }
.queue-reason { font-size: 12px; color: var(--ct-red); flex: 1; }
</style>
