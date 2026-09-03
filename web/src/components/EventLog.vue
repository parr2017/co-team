<template>
  <div class="section">
    <div class="section-head">
      <div class="section-title">事件日志</div>
      <el-button size="small" link @click="$emit('clear')">清空</el-button>
    </div>
    <div class="log-list">
      <div v-if="!events.length" class="log-entry"><span class="log-msg muted">等待事件...</span></div>
      <div v-for="(e, i) in events.slice(0, 80)" :key="i" class="log-entry">
        <span class="log-ts">{{ new Date(e.ts).toLocaleTimeString() }}</span>
        <span class="log-type" :class="e.type">{{ e.type }}</span>
        <span class="log-msg">{{ JSON.stringify(e.data).slice(0, 100) }}</span>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import type { EventItem } from '../composables/useDashboard';
defineProps<{ events: EventItem[] }>();
defineEmits<{ (e: 'clear'): void }>();
</script>

<style scoped>
.log-list { max-height: 320px; overflow-y: auto; background: var(--ct-bg); border-radius: 8px; border: 1px solid var(--el-border-color); }
.log-entry { padding: 6px 10px; border-bottom: 1px solid var(--el-border-color); font-size: 11px; font-family: monospace; display: flex; gap: 8px; }
.log-ts { color: var(--ct-text3); flex-shrink: 0; }
.log-type { flex-shrink: 0; font-weight: 500; color: var(--ct-accent); }
.log-type.node_start, .log-type.node_retry { color: var(--ct-yellow); }
.log-type.node_complete, .log-type.execute_complete { color: var(--ct-green); }
.log-type.node_error, .log-type.execute_failed { color: var(--ct-red); }
.log-type.execute_start { color: #3b82f6; }
.log-type.node_waiting_approval, .log-type.node_escalate { color: var(--ct-red); }
.log-msg { color: var(--ct-text2); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.muted { color: var(--ct-text3); }
</style>
