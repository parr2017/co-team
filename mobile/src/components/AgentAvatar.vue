<script setup lang="ts">
import { computed } from 'vue';

const props = withDefaults(defineProps<{ name: string; size?: number; active?: boolean }>(), {
  size: 38,
  active: false,
});

/** M10-B 企业化：低饱和平面角色色（无渐变、无扫描线），色相区分角色、双主题可读 */
const ROLE_COLORS: Record<string, string> = {
  dev: '#0f766e',
  front: '#3b6fd4',
  test: '#8a6d1d',
  tester: '#8a6d1d',
  review: '#6d5bc7',
  deploy: '#8a6d1d',
  docs: '#2c7a8c',
  refactor: '#b05a7e',
  orchestrator: 'var(--ct-accent)',
};

const FALLBACK_COLORS = ['#0f766e', '#3b6fd4', '#8a6d1d', '#6d5bc7', '#b05a7e', '#2c7a8c'];

const isMaster = computed(() => props.name === 'orchestrator' || props.name === 'master' || props.name === '主 Agent');

// same letter codes as web — dev/deploy both start with "de" and would collide
const AVATAR_CODES: Record<string, string> = { orchestrator: '主', dev: 'dv', deploy: 'dp', docs: 'do', refactor: 'rf', review: 'rv', test: 'te' };

const label = computed(() => {
  if (isMaster.value) return '主';
  const n = props.name || '??';
  return AVATAR_CODES[n] || (n.length >= 2 ? n.slice(0, 2) : n);
});

const background = computed(() => {
  if (isMaster.value) return 'var(--ct-accent)';
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
  border: 1px solid rgba(255, 255, 255, 0.12);
  transition: transform 0.12s ease;
}
.agent-avatar:active { transform: scale(0.94); }
.av-active {
  border-color: var(--ct-accent);
  box-shadow: 0 0 0 1px var(--ct-accent);
}
</style>
