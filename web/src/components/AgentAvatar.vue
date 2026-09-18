<template>
  <div class="agent-avatar" :class="[`av-${colorClass}`, { 'av-active': active, 'av-master': isMaster }]" :style="{ width: size + 'px', height: size + 'px', fontSize: Math.max(10, Math.round(size * 0.3)) + 'px' }" :title="title">
    <span>{{ label }}</span>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';

const props = withDefaults(defineProps<{ name: string; size?: number; active?: boolean; title?: string }>(), {
  size: 36,
  active: false,
});

/** role color mapping per the WeChat-ification spec; master agent overrides with the brand blue */
const ROLE_COLORS: Record<string, string> = {
  dev: 'green',
  test: 'yellow',
  tester: 'yellow',
  review: 'purple',
  deploy: 'orange',
  docs: 'cyan',
  refactor: 'pink',
};

const isMaster = computed(() => props.name === 'orchestrator' || props.name === '主 Agent');

const label = computed(() => {
  if (isMaster.value) return '主';
  return (props.name || '??').slice(0, 2);
});

const colorClass = computed(() => {
  if (isMaster.value) return 'master';
  const key = props.name.toLowerCase();
  for (const [frag, cls] of Object.entries(ROLE_COLORS)) {
    if (key.includes(frag)) return cls;
  }
  // deterministic fallback from a name hash so colors stay stable per agent
  const palette = ['green', 'yellow', 'purple', 'orange', 'cyan', 'pink'];
  let hash = 0;
  for (const ch of props.name || '') hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  return palette[hash % palette.length];
});
</script>

<style scoped>
.agent-avatar {
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 8px;
  font-weight: 600;
  color: #fff;
  flex-shrink: 0;
  user-select: none;
  letter-spacing: 0.5px;
}
.av-master { background: var(--ag-launcher); }
.av-green { background: var(--ag-dev); }
.av-yellow { background: var(--ag-test); }
.av-purple { background: var(--ag-review); }
.av-orange { background: var(--ag-deploy); }
.av-cyan { background: var(--ag-docs); }
.av-pink { background: var(--ag-refactor); }
.av-active { outline: 3px solid var(--accent); outline-offset: 1px; }
</style>
