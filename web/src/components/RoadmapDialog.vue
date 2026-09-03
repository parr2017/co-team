<template>
  <el-dialog :model-value="modelValue" title="开发路线 · Roadmap" width="860px" @open="load" @close="$emit('close')">
    <div v-if="loading" class="empty mono">loading…</div>
    <div v-else-if="error" class="error mono">{{ error }}</div>
    <div v-else class="md-body" v-html="rendered"></div>
    <div v-if="updatedAt" class="meta mono">开发路线.md · 更新于 {{ new Date(updatedAt).toLocaleString() }}</div>
  </el-dialog>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue';
import { marked } from 'marked';
import { api } from '../api';

defineProps<{ modelValue: boolean }>();
defineEmits<{ (e: 'close'): void }>();

const content = ref('');
const updatedAt = ref('');
const loading = ref(false);
const error = ref('');

const rendered = computed(() => marked.parse(content.value, { async: false }) as string);

async function load() {
  loading.value = true;
  error.value = '';
  try {
    const d = await api.roadmap();
    content.value = d.content;
    updatedAt.value = d.updated_at;
  } catch (e: any) {
    error.value = e.message;
  } finally {
    loading.value = false;
  }
}
</script>

<style scoped>
.md-body { max-height: 560px; overflow-y: auto; font-size: 13px; line-height: 1.7; color: var(--ct-text2); }
.md-body :deep(h1), .md-body :deep(h2), .md-body :deep(h3) { color: var(--ct-text); border-bottom: 1px solid var(--ct-border); padding-bottom: 6px; margin: 18px 0 10px; }
.md-body :deep(h1) { font-size: 18px; }
.md-body :deep(h2) { font-size: 15px; }
.md-body :deep(table) { border-collapse: collapse; width: 100%; margin: 10px 0; }
.md-body :deep(th), .md-body :deep(td) { border: 1px solid var(--ct-border); padding: 6px 10px; font-size: 12px; text-align: left; }
.md-body :deep(th) { background: var(--ct-panel2); }
.md-body :deep(code) { font-family: var(--ct-mono); font-size: 11px; background: var(--ct-panel2); border-radius: 3px; padding: 1px 4px; }
.md-body :deep(pre) { background: var(--ct-bg); border: 1px solid var(--ct-border); border-radius: 6px; padding: 10px; overflow-x: auto; }
.md-body :deep(pre code) { background: transparent; padding: 0; }
.md-body :deep(blockquote) { border-left: 3px solid var(--ct-accent); margin: 8px 0; padding: 4px 12px; color: var(--ct-text3); }
.meta { margin-top: 10px; font-size: 10px; color: var(--ct-text3); }
.empty, .error { padding: 40px; text-align: center; }
.error { color: var(--ct-red); }
</style>
