<template>
  <div class="track">
    <div v-for="(n, i) in nodes" :key="n.id" class="station-wrap">
      <div class="rail" :class="{ first: i === 0, last: i === nodes.length - 1 }"></div>
      <div
        class="station"
        :class="[n.status, { selected: n.id === selectedId, running: isRunning(n) }]"
        :data-node="n.id"
        @click="$emit('select', n.id)"
      >
        <div class="dot" :class="n.status"></div>
        <div class="s-main">
          <div class="s-top">
            <span class="s-name">{{ n.name }}</span>
            <span class="s-status" :class="n.status">{{ statusText(n.status) }}</span>
          </div>
          <div class="s-meta mono">
            <span class="agent-badge">{{ badge(n.agent) }} {{ n.agent }}</span>
            <span v-if="n.branch" class="branch">⎇ {{ n.branch.replace('coteam/', '') }}</span>
            <span v-if="dur(n)">{{ dur(n) }}</span>
            <span v-if="n.retry_count" class="retry">重试 ×{{ n.retry_count }}</span>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import type { TaskNode } from '../api';
import { statusText } from '../utils/events';

defineProps<{ nodes: TaskNode[]; selectedId?: string }>();
defineEmits<{ (e: 'select', nodeId: string): void }>();

const CODES: Record<string, string> = { orchestrator: 'OR', dev: 'DV', deploy: 'DP', docs: 'DO', refactor: 'RF', review: 'RV', test: 'TE' };
function badge(agent: string) { return CODES[agent] || agent.slice(0, 2).toUpperCase(); }
function isRunning(n: TaskNode): boolean { return n.status === 'running' || n.status === 'retrying'; }
function dur(n: TaskNode): string {
  if (!n.started_at) return '';
  const end = n.finished_at ? new Date(n.finished_at).getTime() : Date.now();
  const sec = Math.max(0, Math.round((end - new Date(n.started_at).getTime()) / 100) / 10);
  return sec + 's';
}
</script>

<style scoped>
.track { position: relative; display: flex; flex-direction: column; }
.station-wrap { position: relative; padding-left: 26px; }
.rail { position: absolute; left: 9px; top: 0; bottom: 0; width: 2px; background: var(--ct-border); }
.rail.first { top: 26px; }
.rail.last { bottom: auto; height: 26px; }
.station {
  position: relative; display: flex; gap: 10px; align-items: flex-start;
  padding: 9px 12px; margin: 6px 0;
  background: var(--ct-panel); border: 1px solid var(--ct-border); border-radius: 6px;
  cursor: pointer; transition: border-color 0.15s, box-shadow 0.15s;
}
.station:hover { border-color: var(--ct-border2); }
.station.selected { border-color: var(--ct-accent); box-shadow: 0 0 0 2px rgba(47, 111, 237, 0.12); }
.dot { position: absolute; left: -21px; top: 18px; width: 9px; height: 9px; border-radius: 50%; background: var(--ct-text3); border: 2px solid var(--ct-panel); box-sizing: content-box; margin-left: 1px; }
.dot.completed { background: var(--ct-green); }
.dot.running, .dot.retrying { background: var(--ct-yellow); animation: pulse 1.6s ease-in-out infinite; }
.dot.failed { background: var(--ct-red); }
.dot.waiting_approval { background: var(--ct-accent); }
.station.running { border-color: var(--ct-border2); }
@keyframes pulse {
  0%, 100% { box-shadow: 0 0 0 0 rgba(154, 108, 10, 0.35); }
  50% { box-shadow: 0 0 0 5px rgba(154, 108, 10, 0.08); }
}
.s-main { flex: 1; min-width: 0; }
.s-top { display: flex; align-items: baseline; gap: 8px; }
.s-name { font-size: 12px; color: var(--ct-text); font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.s-status { flex-shrink: 0; font-size: 10px; margin-left: auto; }
.s-status.completed { color: var(--ct-green); }
.s-status.running, .s-status.retrying { color: var(--ct-yellow); }
.s-status.failed { color: var(--ct-red); }
.s-status.waiting_approval { color: var(--ct-accent); }
.s-status.pending, .s-status.planned, .s-status.cancelled, .s-status.queued { color: var(--ct-text3); }
.s-meta { display: flex; gap: 8px; align-items: center; margin-top: 4px; font-size: 10px; color: var(--ct-text3); flex-wrap: wrap; }
.agent-badge { border: 1px solid var(--ct-border2); border-radius: 3px; padding: 0 4px; color: var(--ct-text2); }
.branch { color: var(--ct-accent); }
.retry { color: var(--ct-yellow); }
</style>
