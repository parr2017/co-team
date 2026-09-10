<template>
  <div class="intervention-bar">
    <textarea
      v-model="draft"
      class="iv-input"
      rows="1"
      :placeholder="placeholder"
      :disabled="sending"
      @keydown.enter.exact.prevent="send"
      @input="autoGrow"
      ref="taEl"
    ></textarea>
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
const taEl = ref<HTMLTextAreaElement | null>(null);

const placeholder = '问进度、提醒、或提新想法——运行中的成员会回应（Enter 发送，Shift+Enter 换行）';

const RUNNING = ['running', 'pending', 'planned', 'retrying', 'waiting_approval'];

function autoGrow() {
  const el = taEl.value;
  if (el) {
    el.style.height = 'auto';
    el.style.height = Math.min(96, el.scrollHeight) + 'px';
  }
}

async function send() {
  const message = draft.value.trim();
  if (!message || sending.value) return;
  if (props.taskStatus && !RUNNING.includes(props.taskStatus)) {
    ElMessage.warning(`任务当前状态为 ${props.taskStatus}，不是执行中，消息不会被消费`);
    return;
  }
  sending.value = true;
  try {
    const r = await api.interveneTask(props.taskId, message);
    draft.value = '';
    if (taEl.value) taEl.value.style.height = 'auto';
    ElMessage.success(r.note || '已送达执行中的成员');
    emit('sent');
  } catch (e: any) {
    ElMessage.error(e.message || '发送失败');
  } finally {
    sending.value = false;
  }
}
</script>

<style scoped>
.intervention-bar { display: flex; align-items: flex-end; gap: 8px; padding: 8px 4px 4px; }
.iv-input {
  flex: 1;
  min-width: 0;
  min-height: 34px;
  padding: 7px 12px;
  border: 1px solid var(--ct-border2);
  border-radius: 8px;
  background: var(--ct-panel);
  color: var(--ct-text);
  font-size: 13px;
  line-height: 1.5;
  outline: none;
  resize: none;
  font-family: inherit;
}
.iv-input:focus { border-color: var(--ct-accent); }
.iv-input:disabled { opacity: 0.6; }
.iv-send {
  height: 34px;
  padding: 0 18px;
  border: none;
  border-radius: 8px;
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
