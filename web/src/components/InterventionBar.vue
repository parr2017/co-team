<template>
  <div class="intervention-bar">
    <input
      v-model="draft"
      class="iv-input"
      type="text"
      :placeholder="placeholder"
      :disabled="sending"
      @keydown.enter.prevent="send"
      @keyup.enter.prevent="send"
    />
    <button class="iv-send mono" :disabled="!draft.trim() || sending" @click="send">发送</button>
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue';
import { ElMessage } from 'element-plus';
import { api } from '../api';

const props = defineProps<{ taskId: string; taskStatus?: string }>();
const emit = defineEmits<{ (e: 'sent'): void }>();

const draft = ref('');
const sending = ref(false);

const placeholder = '向 Agent 发送介入指示，将在其下一轮对话注入…';

const RUNNING = ['running', 'pending', 'planned', 'retrying', 'waiting_approval'];

async function send() {
  const message = draft.value.trim();
  if (!message || sending.value) return;
  if (props.taskStatus && !RUNNING.includes(props.taskStatus)) {
    ElMessage.warning(`任务当前状态为 ${props.taskStatus}，不是执行中，介入消息不会被消费`);
    return;
  }
  sending.value = true;
  try {
    const r = await api.interveneTask(props.taskId, message);
    draft.value = '';
    ElMessage.success(r.note || '将在 Agent 下一轮对话注入');
    emit('sent');
  } catch (e: any) {
    ElMessage.error(e.message || '介入发送失败');
  } finally {
    sending.value = false;
  }
}
</script>

<style scoped>
.intervention-bar { display: flex; align-items: center; gap: 8px; padding: 8px 4px 4px; }
.iv-input {
  flex: 1;
  min-width: 0;
  height: 34px;
  padding: 0 12px;
  border: 1px solid var(--ct-border2);
  border-radius: 6px;
  background: var(--ct-panel);
  color: var(--ct-text);
  font-size: 13px;
  outline: none;
}
.iv-input:focus { border-color: var(--ct-accent); }
.iv-input:disabled { opacity: 0.6; }
.iv-send {
  height: 34px;
  padding: 0 18px;
  border: none;
  border-radius: 6px;
  background: #95ec69;
  color: #0b2e13;
  font-size: 13px;
  font-weight: 700;
  cursor: pointer;
  flex-shrink: 0;
}
html.dark .iv-send { background: #3eb575; color: #eafff1; }
.iv-send:disabled { opacity: 0.45; cursor: not-allowed; }
.iv-send:not(:disabled):hover { filter: brightness(1.05); }
</style>
