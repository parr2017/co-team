<script setup lang="ts">
import { computed } from 'vue';

const props = withDefaults(defineProps<{ name: string; size?: number; active?: boolean }>(), {
  size: 38,
  active: false,
});

/** M10-B 企业化：低饱和平面角色色（无渐变、无扫描线），色相区分角色、双主题可读 */
/** 与 web agentColor.ts 同映射（dev/test/review/deploy/docs/refactor/launcher/grader），色值走 --ag-* token */
const ROLE_COLORS: Record<string, string> = {
  dev: 'var(--ag-dev)',
  test: 'var(--ag-test)',
  tester: 'var(--ag-test)',
  review: 'var(--ag-review)',
  deploy: 'var(--ag-deploy)',
  docs: 'var(--ag-docs)',
  refactor: 'var(--ag-refactor)',
  launcher: 'var(--ag-launcher)',
  grader: 'var(--ag-grader)',
  orchestrator: 'var(--ag-launcher)',
};

const FALLBACK_COLORS = ['var(--ag-dev)', 'var(--ag-test)', 'var(--ag-review)', 'var(--ag-deploy)', 'var(--ag-docs)', 'var(--ag-refactor)', 'var(--ag-launcher)', 'var(--ag-fallback)'];

const isMaster = computed(() => props.name === 'orchestrator' || props.name === 'master' || props.name === '主 Agent');

// same letter codes as web — dev/deploy both start with "de" and would collide
const AVATAR_CODES: Record<string, string> = { orchestrator: '主', dev: 'dv', deploy: 'dp', docs: 'do', refactor: 'rf', review: 'rv', test: 'te' };

const label = computed(() => {
  if (isMaster.value) return '主';
  const n = props.name || '??';
  return AVATAR_CODES[n] || (n.length >= 2 ? n.slice(0, 2) : n);
});

const background = computed(() => {
  if (isMaster.value) return 'var(--ag-launcher)';
  const key = props.name.toLowerCase();
  for (const [frag, color] of Object.entries(ROLE_COLORS)) {
    if (key.includes(frag)) return color;
  }
  let hash = 0;
  for (const ch of props.name || '') hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  return FALLBACK_COLORS[hash % FALLBACK_COLORS.length];
});
</script>

<template>
  <div
    class="agent-avatar"
    :class="{ 'av-active': active }"
    :style="{
      width: size + 'px',
      height: size + 'px',
      background,
      fontSize: Math.max(10, Math.round(size * 0.32)) + 'px',
      borderRadius: Math.max(6, Math.round(size * 0.22)) + 'px',
    }"
  >
    <span>{{ label }}</span>
  </div>
</template>

<style scoped>
.agent-avatar {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
  font-weight: 600;
  color: #ffffff;
  flex-shrink: 0;
  user-select: none;
  letter-spacing: 1px;
  overflow: hidden;
  border: 1px solid color-mix(in srgb, #ffffff 14%, transparent);
  transition: transform 0.12s ease;
}
.agent-avatar:active { transform: scale(0.94); }
.av-active {
  border-color: var(--accent);
  box-shadow: 0 0 0 1px var(--accent);
}
</style>
