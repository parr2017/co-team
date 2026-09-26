<script setup lang="ts">
/**
 * M10-B 统一状态标签：收敛此前 8 套手写 chip/pill/badge。
 * 语义色映射，双主题经 token 自适应。
 */
import { computed } from 'vue';

const props = withDefaults(defineProps<{ status: string; label?: string }>(), { label: '' });

type Tone = 'green' | 'yellow' | 'red' | 'accent' | 'neutral';

const TONE_MAP: Record<string, Tone> = {
  completed: 'green', success: 'green', passed: 'green', done: 'green', ok: 'green', connected: 'green', converted: 'green',
  // B1（2026-09-17）：验收有警告的 tolerant 交付——琥珀色区分于纯成功
  completed_with_warnings: 'yellow',
  running: 'accent', retrying: 'accent', active: 'accent', executing: 'accent', open: 'accent',
  pending: 'neutral', planned: 'neutral', queued: 'neutral', idle: 'neutral', discussing: 'neutral', converged: 'yellow',
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
/* 药丸形统一状态签（与 web 任务中心 pill 同构）：语义 tint + 状态点 + 全圆角 */
.st-tag {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-size: var(--fs-meta);
  font-family: var(--font-mono);
  font-weight: 500;
  line-height: 1;
  height: 21px;
  padding: 0 9px;
  border-radius: 11px;
  border: 1px solid transparent;
  white-space: nowrap;
}
.st-tag::before {
  content: '';
  width: 5px; height: 5px;
  border-radius: 50%;
  background: currentColor;
  flex: none;
}
.st-tag.green { color: var(--ok); background: color-mix(in srgb, var(--ok) 10%, transparent); border-color: color-mix(in srgb, var(--ok) 25%, transparent); }
.st-tag.yellow { color: var(--warn); background: color-mix(in srgb, var(--warn) 10%, transparent); border-color: color-mix(in srgb, var(--warn) 25%, transparent); }
.st-tag.red { color: var(--danger); background: color-mix(in srgb, var(--danger) 10%, transparent); border-color: color-mix(in srgb, var(--danger) 25%, transparent); }
.st-tag.accent { color: var(--accent); background: var(--accent-soft); border-color: var(--accent-line); }
.st-tag.neutral { color: var(--text-2); background: var(--bg-raised); border-color: var(--line); }
</style>
