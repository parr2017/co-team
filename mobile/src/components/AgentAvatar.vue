<script setup lang="ts">
import { computed } from 'vue';

const props = withDefaults(defineProps<{ name: string; size?: number; active?: boolean }>(), {
  size: 38,
  active: false,
});

/** tech-console palette: deep gradients with a neon edge per role */
const ROLE_GRADIENTS: Record<string, string> = {
  dev: 'linear-gradient(145deg, #0d9488, #0f766e)',
  test: 'linear-gradient(145deg, #d97706, #b45309)',
  tester: 'linear-gradient(145deg, #d97706, #b45309)',
  review: 'linear-gradient(145deg, #7c3aed, #6d28d9)',
  deploy: 'linear-gradient(145deg, #ea580c, #c2410c)',
  docs: 'linear-gradient(145deg, #0891b2, #0e7490)',
  refactor: 'linear-gradient(145deg, #db2777, #be185d)',
};

const FALLBACK_GRADIENTS = [
  'linear-gradient(145deg, #0d9488, #0f766e)',
  'linear-gradient(145deg, #d97706, #b45309)',
  'linear-gradient(145deg, #7c3aed, #6d28d9)',
  'linear-gradient(145deg, #0891b2, #0e7490)',
  'linear-gradient(145deg, #db2777, #be185d)',
  'linear-gradient(145deg, #0369a1, #075985)',
];

const isMaster = computed(() => props.name === 'orchestrator' || props.name === 'master' || props.name === '主 Agent');

// same letter codes as web — dev/deploy both start with "de" and would collide
const AVATAR_CODES: Record<string, string> = { orchestrator: '主', dev: 'dv', deploy: 'dp', docs: 'do', refactor: 'rf', review: 'rv', test: 'te' };

const label = computed(() => {
  if (isMaster.value) return '主';
  const n = props.name || '??';
  return AVATAR_CODES[n] || (n.length >= 2 ? n.slice(0, 2) : n);
});

const background = computed(() => {
  if (isMaster.value) return 'linear-gradient(145deg, #26e0fb, #0284c7)';
  const key = props.name.toLowerCase();
  for (const [frag, grad] of Object.entries(ROLE_GRADIENTS)) {
    if (key.includes(frag)) return grad;
  }
  let hash = 0;
  for (const ch of props.name || '') hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  return FALLBACK_GRADIENTS[hash % FALLBACK_GRADIENTS.length];
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
    <span class="av-scan"></span>
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
  border: 1px solid rgba(255, 255, 255, 0.14);
  box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.25), 0 2px 8px rgba(0, 0, 0, 0.35);
  transition: transform 0.12s ease;
}
.agent-avatar:active { transform: scale(0.92); }
/* animated scan highlight sweeping across the chip */
.av-scan {
  position: absolute;
  inset: 0;
  background: linear-gradient(115deg, transparent 30%, rgba(255, 255, 255, 0.14) 50%, transparent 70%);
  background-size: 200% 100%;
  animation: wx-scan 3.2s linear infinite;
  pointer-events: none;
}
.av-active {
  border-color: var(--accent);
  box-shadow: 0 0 0 1px var(--accent), var(--glow-accent);
}
</style>
