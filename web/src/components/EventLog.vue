<template>
  <div class="section">
    <div class="section-head">
      <div class="section-title">实时事件</div>
      <el-button size="small" link @click="$emit('clear')">清空</el-button>
    </div>
    <div class="log-list">
      <div v-if="!visibleEvents.length" class="log-entry"><span class="log-msg muted">等待事件...</span></div>
      <div v-for="(e, i) in visibleEvents" :key="i" class="log-entry">
        <span class="log-ts">{{ new Date(e.ts).toLocaleTimeString() }}</span>
        <span class="log-dot" :class="view(e).level"></span>
        <span class="log-msg">{{ view(e).text }}</span>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import type { EventItem } from '../composables/useDashboard';
import { describeEvent } from '../utils/events';
import { computed } from 'vue';

const props = defineProps<{ events: EventItem[] }>();
defineEmits<{ (e: 'clear'): void }>();

// ping 是 WS 保活心跳，不是业务事件
const visibleEvents = computed(() => props.events.filter((e) => e.type !== 'ping').slice(0, 80));

function view(e: EventItem) {
  return describeEvent(e.type, e.data);
}
</script>

<style scoped>
.log-list { max-height: 320px; overflow-y: auto; background: var(--ct-bg); border-radius: 8px; border: 1px solid var(--el-border-color); }
.log-entry { padding: 6px 10px; border-bottom: 1px solid var(--el-border-color); font-size: 12px; display: flex; gap: 8px; align-items: baseline; }
.log-ts { color: var(--ct-text3); flex-shrink: 0; font-family: var(--ct-mono); font-size: 10px; }
.log-dot { width: 7px; height: 7px; border-radius: 50%; flex-shrink: 0; align-self: center; background: var(--ct-text3); }
.log-dot.success { background: var(--ct-green); }
.log-dot.warn { background: var(--ct-yellow); }
.log-dot.error { background: var(--ct-red); }
.log-dot.accent { background: var(--ct-accent); }
.log-msg { color: var(--ct-text2); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.muted { color: var(--ct-text3); }
</style>
