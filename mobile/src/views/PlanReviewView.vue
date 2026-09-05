<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { showFailToast, showToast } from 'vant';
import { api, statusLabel } from '../api';
import type { TaskGraph } from '../api';

const route = useRoute();
const router = useRouter();

const taskId = computed(() => String(route.params.id));
const task = ref<TaskGraph | null>(null);
const replanText = ref('');
const showReplan = ref(false);
const executing = ref(false);
const replanning = ref(false);

async function load() {
  try {
    task.value = await api.getTask(taskId.value);
  } catch (e: any) {
    showFailToast(e.message || '任务不存在');
  }
}

watch(taskId, () => void load(), { immediate: true });

const isPlanned = computed(() => task.value?.status === 'planned');

async function start() {
  executing.value = true;
  try {
    await api.executeTask(taskId.value);
    showToast('任务已启动');
    router.replace(`/task/${taskId.value}`);
  } catch (e: any) {
    showFailToast(e.message || '启动失败');
  } finally {
    executing.value = false;
  }
}

async function doReplan() {
  if (!replanText.value.trim()) { showFailToast('请填写调整意见'); return; }
  replanning.value = true;
  try {
    await api.replan(taskId.value, replanText.value.trim());
    showToast('计划已重新生成');
    replanText.value = '';
    showReplan.value = false;
    await load();
  } catch (e: any) {
    showFailToast(e.message || '重新规划失败');
  } finally {
    replanning.value = false;
  }
}

function nodeStatusColor(s: string): string {
  return ({ completed: 'var(--green)', failed: 'var(--red)', running: 'var(--yellow)', retrying: 'var(--yellow)' } as Record<string, string>)[s] || 'var(--text-3)';
}
</script>

<template>
  <div class="page">
    <van-nav-bar title="确认计划" left-arrow fixed placeholder @click-left="router.back()" />

    <div class="content">
      <div v-if="task" class="wx-caption">任务描述</div>
      <div v-if="task" class="wx-group">
        <div class="wx-cell">
          <span class="task-desc">{{ task.description }}</span>
        </div>
        <div class="wx-cell meta-cell">
          <span class="meta">{{ task.nodes.length }} 个节点 · {{ statusLabel(task.status) }}</span>
        </div>
      </div>

      <div v-if="task" class="wx-caption">执行节点</div>
      <div v-if="task" class="wx-group">
        <div v-for="(n, i) in task.nodes" :key="n.id" class="wx-cell node-cell">
          <span class="n-index">{{ i + 1 }}</span>
          <div class="n-body">
            <div class="n-name">
              {{ n.name }}
              <span v-if="n.requires_approval" class="n-flag">需审批</span>
            </div>
            <div class="n-sub">
              <span class="n-agent">{{ n.agent }}</span>
              <span v-if="n.reason" class="n-reason">{{ n.reason }}</span>
            </div>
          </div>
          <span class="n-dot" :style="{ background: nodeStatusColor(n.status) }"></span>
        </div>
      </div>

      <div v-if="isPlanned" class="btns">
        <button class="wx-btn" :disabled="executing" @click="start">{{ executing ? '启动中…' : '确认并启动执行' }}</button>
        <button class="wx-btn wx-btn-plain" @click="showReplan = true">调整计划（重新拆解）</button>
      </div>
      <div v-else class="hint">当前状态：{{ task ? statusLabel(task.status) : '加载中' }}（计划确认页仅用于待确认状态）</div>
    </div>

    <van-popup v-model:show="showReplan" position="bottom" round :style="{ height: '46%' }">
      <div class="replan-panel">
        <div class="r-title">告诉主 Agent 怎么调整</div>
        <van-field
          v-model="replanText"
          type="textarea"
          rows="4"
          autosize
          :border="false"
          placeholder="例如：去掉部署节点；把测试拆成单元测试与集成测试…"
          class="r-input"
        />
        <button class="wx-btn" style="margin-top: 14px" :disabled="replanning" @click="doReplan">{{ replanning ? '生成中…' : '重新生成计划' }}</button>
      </div>
    </van-popup>
  </div>
</template>

<style scoped>
.page { height: 100%; overflow-y: auto; -webkit-overflow-scrolling: touch; background: var(--bg); }
.content { padding-bottom: 30px; }

.task-desc { font-size: 16px; line-height: 1.6; color: var(--text); }
.meta-cell { padding-top: 0; }
.meta { font-size: 13px; color: var(--text-2); }

.n-index { font-size: 15px; font-weight: 700; color: var(--accent); min-width: 22px; }
.n-body { flex: 1; min-width: 0; }
.n-name { font-size: 16px; color: var(--text); margin-bottom: 2px; }
.n-flag {
  font-size: 11px; color: var(--wx-orange);
  border: 1px solid var(--wx-orange); border-radius: 3px; padding: 0 3px; margin-left: 4px;
}
.n-sub { display: flex; gap: 8px; font-size: 12px; color: var(--text-3); }
.n-agent { color: var(--wx-blue); flex-shrink: 0; }
.n-reason {
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.n-dot { width: 9px; height: 9px; border-radius: 50%; flex-shrink: 0; }

.btns { display: flex; flex-direction: column; gap: 12px; margin: 28px 16px 0; }
.hint { font-size: 14px; color: var(--text-3); text-align: center; padding: 28px 16px; }

.replan-panel { padding: 16px; background: var(--bg); }
.r-title { font-size: 17px; font-weight: 600; color: var(--text); margin-bottom: 10px; }
.r-input :deep(.van-field__control) { font-size: 16px; line-height: 1.5; background: var(--panel); border-radius: 6px; padding: 10px; }
</style>
