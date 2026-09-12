<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { showToast } from 'vant';
import { api } from '../api';

const props = defineProps<{ taskId: string; taskStatus?: string; prefill?: string }>();
const emit = defineEmits<{ (e: 'sent'): void }>();

const draft = ref('');
const sending = ref(false);

// M10-A：聊天长按"引用"→ 外部预填输入框
watch(() => props.prefill, (v) => {
  if (v) draft.value = v + '\n';
});

/** only live tasks accept interventions (backend enforces the same list) */
const RUNNING = ['running', 'pending', 'planned', 'retrying', 'waiting_approval'];
const canSend = computed(() => !props.taskStatus || RUNNING.includes(props.taskStatus));
const hint = computed(() =>
  props.taskStatus === 'clarifying'
    ? '需求澄清中——回答澄清问题后即可对话'
    : `任务已结束（${props.taskStatus || '?'}）——重启任务后才能发消息`
);

async function send() {
  const message = draft.value.trim();
  if (!message || sending.value) return;
  sending.value = true;
  try {
    const r = await api.interveneTask(props.taskId, message);
    draft.value = '';
    showToast(r.note || '已发送，将在 Agent 下一轮对话注入');
    emit('sent');
  } catch (e: any) {
    showToast(e.message || '发送失败');
  } finally {
    sending.value = false;
  }
}
</script>

<template>
  <div class="iv-input-bar">
    <template v-if="canSend">
      <input
        v-model="draft"
        class="iv-input"
        type="text"
        placeholder="问进度、提醒、提想法——成员会回应"
        :disabled="sending"
        @keydown.enter.prevent="send"
      />
      <button class="iv-send" :disabled="!draft.trim() || sending" @click="send">{{ sending ? '…' : '发送' }}</button>
    </template>
    <div v-else class="iv-hint">{{ hint }}</div>
  </div>
</template>

<style scoped>
.iv-input-bar {
  display: flex; align-items: center; gap: 8px;
  padding: 8px 10px calc(8px + var(--safe-bottom));
  background: var(--panel-2);
  border-top: 1px solid var(--border);
}
.iv-input {
  flex: 1; min-width: 0; height: 38px; padding: 0 14px;
  border: 1px solid var(--border); border-radius: 10px;
  background: var(--panel); color: var(--text); font-size: 16px; outline: none;
  transition: border-color 0.15s ease;
}
.iv-input:focus { border-color: var(--accent); }
.iv-input:disabled { opacity: 0.6; }
.iv-send {
  height: 38px; padding: 0 18px; border: none; border-radius: 10px;
  background: var(--me-bubble); color: var(--me-text);
  font-size: 15px; font-weight: 700; cursor: pointer; flex-shrink: 0;
  transition: transform 0.1s ease, opacity 0.15s ease;
}
.iv-send:disabled { opacity: 0.4; }
.iv-send:not(:disabled):active { transform: scale(0.94); filter: brightness(0.96); }
.iv-hint {
  flex: 1; text-align: center; font-size: 13px; color: var(--text-3);
}
</style>
