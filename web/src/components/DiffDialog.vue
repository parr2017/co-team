<template>
  <el-dialog :model-value="modelValue" :title="title" width="880px" top="4vh" @close="$emit('close')" @open="load">
    <div v-if="loading" class="mono state">加载 diff…</div>
    <template v-else-if="diff">
      <div v-if="!diff.available" class="mono state">{{ diff.reason || '暂无代码变更' }}</div>
      <template v-else>
        <div class="files mono">
          <div v-for="f in diff.files" :key="f.path" class="file-row">
            <span class="f-path">{{ f.path }}</span>
            <span class="f-ins">+{{ f.insertions }}</span>
            <span class="f-del">−{{ f.deletions }}</span>
          </div>
        </div>
        <pre class="patch mono"><code><span v-for="(line, i) in patchLines" :key="i" class="pl" :class="lineClass(line)">{{ line === '' ? ' ' : line }}
</span></code></pre>
      </template>
    </template>
    <div v-else class="mono state">加载 diff…</div>
    <template #footer>
      <el-button size="small" @click="$emit('close')">关闭</el-button>
    </template>
  </el-dialog>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { api, type NodeDiffResponse } from '../api';

const props = defineProps<{ modelValue: boolean; taskId: string; nodeId: string; nodeName?: string }>();
defineEmits<{ (e: 'close'): void }>();

const diff = ref<NodeDiffResponse | null>(null);
const loading = ref(false);

const title = computed(() => `代码变更 · ${props.nodeName || props.nodeId}`);

const patchLines = computed(() => (diff.value?.patch || '').split('\n'));

function lineClass(line: string): string {
  if (line.startsWith('+++') || line.startsWith('---')) return 'meta';
  if (line.startsWith('+')) return 'add';
  if (line.startsWith('-')) return 'del';
  if (line.startsWith('@@')) return 'hunk';
  if (line.startsWith('diff ') || line.startsWith('index ')) return 'meta';
  return '';
}

async function load() {
  if (!props.nodeId) return;
  loading.value = true;
  diff.value = null;
  try {
    diff.value = await api.nodeDiff(props.taskId, props.nodeId);
  } catch {
    diff.value = { node_id: props.nodeId, branch: '', available: false, reason: '加载失败', patch: '', files: [] };
  } finally {
    loading.value = false;
  }
}

watch(() => [props.modelValue, props.nodeId] as const, ([open]) => {
  if (open) void load();
});
</script>

<style scoped>
.state { color: var(--ct-text3); text-align: center; padding: 32px 0; font-size: 12px; }
.files { display: flex; flex-direction: column; margin-bottom: 10px; border: 1px solid var(--ct-border); border-radius: 6px; overflow: hidden; }
.file-row { display: flex; align-items: center; gap: 10px; padding: 6px 12px; font-size: 11px; border-bottom: 1px solid var(--ct-border); background: var(--ct-panel2); }
.file-row:last-child { border-bottom: none; }
.f-path { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--ct-text2); }
.f-ins { color: var(--ct-green); }
.f-del { color: var(--ct-red); }
.patch { max-height: 56vh; overflow: auto; background: var(--ct-bg); border: 1px solid var(--ct-border); border-radius: 6px; padding: 10px 12px; margin: 0; font-size: 11px; line-height: 1.5; }
.patch code { display: block; font-family: inherit; }
.pl { display: block; white-space: pre-wrap; word-break: break-all; color: var(--ct-text2); }
.pl.add { background: rgba(63, 185, 80, 0.12); color: var(--ct-green); }
.pl.del { background: rgba(229, 83, 75, 0.10); color: var(--ct-red); }
.pl.hunk { color: var(--ct-accent); background: rgba(74, 141, 255, 0.08); }
.pl.meta { color: var(--ct-text3); }
</style>
