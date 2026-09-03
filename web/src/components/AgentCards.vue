<template>
  <div class="section">
    <div class="section-head">
      <div class="section-title">Team / {{ Object.keys(agents).length }} agents</div>
    </div>
    <div class="agents-grid">
      <div v-for="a in Object.values(agents)" :key="a.name" class="agent-card" @click="$emit('show-detail', a)">
        <div class="agent-top">
          <span class="agent-badge" :data-agent="a.name">{{ badge(a.name) }}</span>
          <div class="agent-id">
            <div class="agent-name mono">{{ a.name }}</div>
            <div class="agent-role">{{ a.role || roleOf(a.name) }}</div>
          </div>
        </div>
        <div class="agent-status-line">
          <span class="dot" :class="a.status"></span>
          <span class="status-text mono">{{ statusText(a.status) }}</span>
        </div>
        <div class="agent-task" :class="{ empty: !a.task }">{{ taskLine(a) }}</div>
        <div v-if="a.currentAction && a.status === 'running'" class="agent-action mono">{{ a.currentAction }}</div>
        <div v-if="a.model" class="agent-model mono">{{ a.model }}</div>
        <div class="agent-stats mono">
          <span>tasks {{ a.taskCount }}</span>
          <span>changes {{ a.changeCount }}</span>
        </div>
        <div class="progress-track"><div class="progress-fill" :style="{ width: pct(a) + '%' }"></div></div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import type { AgentLiveState } from '../composables/useDashboard';

const props = defineProps<{ agents: Record<string, AgentLiveState> }>();
defineEmits<{ (e: 'show-detail', agent: AgentLiveState): void }>();

const ROLES: Record<string, string> = {
  orchestrator: '编排器',
  dev: '开发',
  review: '审查',
  test: '测试',
  deploy: '运维',
  docs: '文档',
  refactor: '重构',
  qa: '测试',
};
function roleOf(n: string) { return ROLES[n] || n; }
// unique two-letter codes per agent within the current team (de, dp, do, rf, rv, te ...)
const codes = computed(() => {
  const names = Object.keys(props.agents).sort((a, b) => a.localeCompare(b));
  const used = new Set<string>();
  const map: Record<string, string> = {};
  for (const name of names) {
    const letters = name.replace(/[^a-z]/gi, '').toLowerCase() || '??';
    let code = letters.slice(0, 2);
    let i = 2;
    while (used.has(code) && i <= letters.length) {
      code = letters[0] + letters[i];
      i += 1;
    }
    if (used.has(code)) code = letters + letters.length;
    used.add(code);
    map[name] = code.toUpperCase();
  }
  return map;
});
function badge(n: string) { return codes.value[n] || '??'; }
function statusText(s: string) { return ({ idle: 'idle', running: 'running', done: 'done', error: 'error' } as Record<string, string>)[s] || s; }
function taskLine(a: AgentLiveState): string {
  if (a.task) return a.task.name;
  if (a.taskCount) return '休息中 · 上次: ' + (lastOf(a) || '—');
  return 'idle';
}
function lastOf(a: AgentLiveState): string {
  return (a.task && a.task.name) || '';
}
function pct(a: AgentLiveState) { return a.status === 'running' ? 65 : a.status === 'done' ? 100 : 0; }

</script>

<style scoped>
.agents-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(210px, 1fr)); gap: 10px; }
.agent-card { background: var(--ct-panel); border: 1px solid var(--ct-border); border-radius: 6px; padding: 12px; cursor: pointer; transition: border-color 0.15s; position: relative; overflow: hidden; }
.agent-card:hover { border-color: var(--ct-border2); }
.agent-top { display: flex; align-items: center; gap: 10px; margin-bottom: 10px; }
.agent-badge {
  width: 34px; height: 34px; border-radius: 4px; flex-shrink: 0;
  display: inline-flex; align-items: center; justify-content: center;
  font-family: var(--ct-mono); font-size: 12px; font-weight: 600;
  background: var(--ct-panel2); color: var(--ct-text2); border: 1px solid var(--ct-border2);
}
.agent-name { font-size: 13px; font-weight: 600; }
.agent-role { font-size: 11px; color: var(--ct-text3); }
.agent-status-line { display: flex; align-items: center; gap: 6px; margin-bottom: 8px; }
.dot { width: 6px; height: 6px; border-radius: 50%; background: var(--ct-text3); flex-shrink: 0; }
.dot.running { background: var(--ct-yellow); }
.dot.done { background: var(--ct-green); }
.dot.error { background: var(--ct-red); }
.status-text { font-size: 11px; color: var(--ct-text2); }
.agent-task { font-size: 12px; color: var(--ct-text2); background: var(--ct-bg); border: 1px solid var(--ct-border); border-radius: 4px; padding: 6px 8px; min-height: 30px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.agent-task.empty { color: var(--ct-text3); font-style: italic; }
.agent-action { font-size: 10px; color: var(--ct-yellow); margin-top: 4px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.agent-model { font-size: 10px; color: var(--ct-accent); margin-top: 3px; }
.agent-stats { display: flex; gap: 12px; margin-top: 8px; font-size: 11px; color: var(--ct-text3); }
.progress-track { position: absolute; bottom: 0; left: 0; right: 0; height: 2px; background: transparent; }
.progress-fill { height: 100%; background: var(--ct-accent); transition: width 0.5s; }
.section-head { margin-bottom: 10px; }
</style>
