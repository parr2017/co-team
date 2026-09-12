<script setup lang="ts">
/**
 * M10-B 统一状态标签：收敛此前 8 套手写 chip/pill/badge。
 * 语义色映射，双主题经 token 自适应。
 */
import { computed } from 'vue';

const props = withDefaults(defineProps<{ status: string; label?: string }>(), { label: '' });

type Tone = 'green' | 'yellow' | 'red' | 'accent' | 'neutral';

const TONE_MAP: Record<string, Tone> = {
  completed: 'green', success: 'green', passed: 'green', done: 'green', ok: 'green', connected: 'green',
  running: 'accent', retrying: 'accent', active: 'accent', executing: 'accent',
  pending: 'neutral', planned: 'neutral', queued: 'neutral', idle: 'neutral', discussing: 'neutral',
  failed: 'red', error: 'red', blocked: 'red', cancelled: 'red',
  waiting_approval: 'yellow', waiting_clarify: 'yellow', clarifying: 'yellow', retrying_budget: 'yellow',
};

const tone = computed<Tone>(() => TONE_MAP[props.status] || 'neutral');
const text = computed(() => props.label || props.status);
</script>

<template>
  <span class="st-tag" :class="tone">{{ text }}</span>
</template>

<style scoped>
.st-tag {
  display: inline-flex;
  align-items: center;
  font-size: var(--fs-xs);
  font-weight: 600;
  line-height: 1;
  padding: 3px 7px;
  border-radius: var(--r-sm);
  white-space: nowrap;
}
.st-tag.green { color: var(--ct-green); background: var(--ct-green-soft); }
.st-tag.yellow { color: var(--ct-yellow); background: var(--ct-yellow-soft); }
.st-tag.red { color: var(--ct-red); background: var(--ct-red-soft); }
.st-tag.accent { color: var(--ct-accent); background: var(--ct-accent-soft); }
.st-tag.neutral { color: var(--text-2); background: var(--panel-2); }
</style>
