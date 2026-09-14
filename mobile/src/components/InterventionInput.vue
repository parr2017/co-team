<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { showToast } from 'vant';
import { api } from '../api';

const props = defineProps<{ taskId: string; taskStatus?: string; prefill?: string }>();
const emit = defineEmits<{ (e: 'sent'): void }>();

const draft = ref('');
const sending = ref(false);
// 用户附图：随介入消息提交（服务端生成视觉描述，注入 agent 下一轮）
const pendingImages = ref<{ url?: string; name?: string; dataUrl?: string; file?: File }[]>([]);
const imgInputEl = ref<HTMLInputElement | null>(null);

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

const ACCEPT = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/bmp']);

function pickImages() {
  imgInputEl.value?.click();
}

async function onPickImages(e: Event) {
  const input = e.target as HTMLInputElement;
  const files = [...(input.files || [])];
  input.value = '';
  for (const f of files) {
    if (pendingImages.value.length >= 3) { showToast('最多附 3 张图'); break; }
    if (!ACCEPT.has(f.type)) { showToast(`${f.name}：不支持的图片类型`); continue; }
    if (f.size > 10 * 1024 * 1024) { showToast(`${f.name} 超过 10MB`); continue; }
    const dataUrl = await new Promise<string>((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(String(r.result));
      r.onerror = () => reject(new Error('read failed'));
      r.readAsDataURL(f);
    }).catch(() => { showToast(`${f.name} 读取失败`); return ''; });
    if (!dataUrl) continue;
    pendingImages.value = [...pendingImages.value, { url: dataUrl, name: f.name, dataUrl }];
  }
}

function imagePayload() {
  return pendingImages.value
    .filter((p) => p.dataUrl)
    .map((p) => ({ name: p.name || 'image', dataUrl: p.dataUrl as string }));
}

async function send() {
  const message = draft.value.trim();
  const imgs = imagePayload();
  if ((!message && !imgs.length) || sending.value) return;
  sending.value = true;
  try {
    const r = await api.interveneTask(props.taskId, message, imgs.length ? imgs : undefined);
    draft.value = '';
    pendingImages.value = [];
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
      <span class="iv-clip" @click="pickImages">📷</span>
      <input
        v-model="draft"
        class="iv-input"
        type="text"
        placeholder="问进度、提醒、提想法——可发图"
        :disabled="sending"
        @keydown.enter.prevent="send"
      />
      <button class="iv-send" :disabled="(!draft.trim() && !pendingImages.length) || sending" @click="send">{{ sending ? '…' : '发送' }}</button>
      <van-uploader
        v-if="pendingImages.length"
        v-model="pendingImages"
        :max-count="3"
        :deletable="true"
        :show-upload="false"
        class="iv-uploader"
      />
      <input ref="imgInputEl" type="file" accept="image/png,image/jpeg,image/webp,image/gif,image/bmp" multiple hidden @change="onPickImages" />
    </template>
    <div v-else class="iv-hint">{{ hint }}</div>
  </div>
</template>

<style scoped>
.iv-input-bar {
  position: relative;
  display: flex; align-items: center; gap: 8px;
  padding: 8px 10px calc(8px + var(--safe-bottom));
  background: var(--panel-2);
  border-top: 1px solid var(--border);
}
.iv-clip {
  width: 34px; height: 34px; border-radius: 50%; flex-shrink: 0;
  display: flex; align-items: center; justify-content: center;
  background: var(--panel); border: 1px solid var(--border);
  color: var(--accent); font-size: 17px;
}
.iv-uploader { position: absolute; left: 10px; bottom: 100%; padding: 4px 0; }
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
