<template>
  <div class="track">
    <div v-for="(n, i) in nodes" :key="n.id" class="station-wrap">
      <div class="rail" :class="{ first: i === 0, last: i === nodes.length - 1 }"></div>
      <div class="station" :class="n.status" :data-node="n.id" @click="$emit('select', n.id)">
        <div class="stamp mono" :class="n.status">{{ stamp(n) }}</div>
        <div class="s-name">{{ n.name }}</div>
        <div class="s-meta mono">
          <span class="agent-badge">{{ badge(n.agent) }}</span>
          <span v-if="n.branch" class="branch">{{ n.branch.replace('coteam/', '') }}</span>
          <span v-if="dur(n)">{{ dur(n) }}</span>
          <span v-if="n.retry_count" class="retry">↻{{ n.retry_count }}</span>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import type { TaskNode } from '../api';

defineProps<{ nodes: TaskNode[] }>();
defineEmits<{ (e: 'select', nodeId: string): void }>();

const CODES: Record<string, string> = { orchestrator: 'OR', dev: 'DV', deploy: 'DP', docs: 'DO', refactor: 'RF', review: 'RV', test: 'TE' };
function badge(agent: string) { return CODES[agent] || agent.slice(0, 2).toUpperCase(); }
function stamp(n: TaskNode): string {
  if (n.status === 'completed') return 'PASSED';
  if (n.status === 'failed') return 'FAILED';
  if (n.status === 'running') return 'RUNNING';
  if (n.status === 'retrying') return `RETRY#${n.retry_count + 1}`;
  if (n.status === 'waiting_approval') return 'AWAIT OK';
  if (n.status === 'cancelled') return 'SKIP';
  if (n.status === 'planned') return 'PLAN';
  return 'QUEUED';
}
function dur(n: TaskNode): string {
  if (!n.started_at) return '';
  const end = n.finished_at ? new Date(n.finished_at).getTime() : Date.now();
  const sec = Math.max(0, Math.round((end - new Date(n.started_at).getTime()) / 100) / 10);
  return sec + 's';
}
</script>

<style scoped>
.track { position: relative; display: flex; flex-direction: column; gap: 2px; }
.station-wrap { position: relative; padding-left: 26px; }
.rail { position: absolute; left: 9px; top: 0; bottom: 0; width: 2px; background: var(--ct-border2); }
.rail.first { top: 22px; }
.rail.last { bottom: auto; height: 22px; }
.station { position: relative; padding: 8px 10px; margin: 6px 0; background: var(--ct-panel); border: 1px solid var(--ct-border); border-radius: 6px; cursor: pointer; transition: border-color 0.15s; }
.station:hover { border-color: var(--ct-border2); }
.station::before { content: ''; position: absolute; left: -20px; top: 50%; transform: translateY(-50%); width: 8px; height: 8px; border-radius: 50%; background: var(--ct-text3); border: 2px solid var(--ct-panel); }
.station.completed::before { background: var(--ct-green); }
.station.running::before, .station.retrying::before { background: var(--ct-yellow); }
.station.failed::before { background: var(--ct-red); }
.station.waiting_approval::before { background: var(--ct-accent); }
.stamp { display: inline-block; font-size: 9px; font-weight: 700; letter-spacing: 1px; padding: 1px 5px; border: 1px solid currentColor; border-radius: 2px; transform: rotate(-4deg); margin-bottom: 4px; }
.stamp.completed { color: var(--ct-green); }
.stamp.running, .stamp.retrying { color: var(--ct-yellow); }
.stamp.failed { color: var(--ct-red); }
.stamp.waiting_approval { color: var(--ct-accent); }
.stamp.pending, .stamp.planned, .stamp.cancelled { color: var(--ct-text3); }
.s-name { font-size: 12px; color: var(--ct-text); }
.s-meta { display: flex; gap: 8px; align-items: center; margin-top: 4px; font-size: 10px; color: var(--ct-text3); flex-wrap: wrap; }
.agent-badge { border: 1px solid var(--ct-border2); border-radius: 2px; padding: 0 3px; color: var(--ct-text2); }
.branch { color: var(--ct-accent); }
.retry { color: var(--ct-yellow); }
</style>
