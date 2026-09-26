<template>
  <div class="queues">
    <div v-for="q in visibleQueues" :key="q.key" class="queue" :class="{ blocked: q.blocked }">
      <span class="lane"><i></i>{{ queueLabel(q) }}</span>
      <span class="q-info mono">
        <template v-if="q.running_task_id">执行中 <em>{{ q.running_task_id }}</em></template>
        <template v-else>空闲</template>
      </span>
      <span v-if="q.pending.length" class="q-info mono">· 排队 {{ q.pending.length }}: {{ q.pending.map((e) => e.task_id).join('、') }}</span>
      <span v-if="q.blocked" class="q-reason">⛔ {{ q.blocked_reason }}</span>
      <span class="sp"></span>
      <button v-if="q.blocked" class="qbtn pri" @click="onResume(q.key)">恢复执行</button>
      <button v-if="q.pending.length" class="qbtn" @click="onClear(q.key)">清空排队</button>
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
.queues { display: flex; flex-direction: column; gap: 8px; margin-bottom: 14px; }
.queue {
  display: flex; align-items: center; gap: 12px; padding: 9px 14px;
  border: 1px solid var(--line); border-radius: var(--r-ctl); background: var(--bg-panel); flex-wrap: wrap;
}
.queue.blocked {
  border-color: color-mix(in srgb, var(--danger) 45%, var(--line));
  background: linear-gradient(90deg, color-mix(in srgb, var(--danger) 10%, transparent), transparent 40%), var(--bg-panel);
}
.lane { display: inline-flex; align-items: center; gap: 7px; font-size: var(--fs-aux); font-weight: 600; color: var(--text-1); }
.lane i { width: 8px; height: 8px; border-radius: 2px; background: var(--ag-launcher); flex: none; }
.q-info { font-family: var(--font-mono); font-size: var(--fs-meta); color: var(--text-2); }
.q-info em { font-style: normal; color: var(--accent); }
.q-reason { font-size: var(--fs-aux); color: var(--danger); }
.sp { flex: 1; }
.qbtn {
  height: 24px; padding: 0 10px; border: 1px solid var(--line-strong); border-radius: var(--r-ctl);
  background: none; color: var(--text-2); font-size: var(--fs-aux); cursor: pointer; transition: all .15s;
}
.qbtn:hover { color: var(--text-1); border-color: var(--accent-line); }
.qbtn.pri { background: var(--accent); border-color: var(--accent); color: var(--accent-text); font-weight: 600; }
.qbtn.pri:hover { filter: brightness(1.08); color: var(--accent-text); }
</style>
