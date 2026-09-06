<template>
  <div class="section">
    <div class="section-head">
      <div class="section-title">团队成员 / {{ Object.keys(agents).length }} 位成员</div>
      <div class="section-sub">技能配置与经验储备 · 点击查看成员档案</div>
    </div>
    <div class="agents-grid">
      <div v-for="a in Object.values(agents)" :key="a.name" class="agent-card" @click="$emit('show-detail', a)">
        <div class="agent-top">
          <span class="agent-badge" :data-agent="a.name">{{ badge(a.name) }}</span>
          <div class="agent-id">
            <div class="agent-name mono">
              {{ a.name }}
              <span class="dot" :class="a.status" :title="statusText(a.status)"></span>
            </div>
            <div class="agent-role">{{ a.role || roleOf(a.name) }}</div>
          </div>
        </div>
        <div v-if="profileOf(a.name)?.description" class="agent-desc">{{ profileOf(a.name)?.description }}</div>
        <div class="agent-action" :class="{ idle: !a.currentAction || a.status !== 'running' }">
          {{ a.status === 'running' && a.currentAction ? a.currentAction : a.task ? `上次节点：${a.task.name}` : '空闲中' }}
        </div>
        <div class="agent-skills">
          <template v-if="skillsOf(a.name).length">
            <span v-for="s in skillsOf(a.name).slice(0, 3)" :key="s" class="skill-tag mono">{{ s }}</span>
            <span v-if="skillsOf(a.name).length > 3" class="skill-more mono">+{{ skillsOf(a.name).length - 3 }}</span>
          </template>
          <span v-else class="skill-empty">未配置技能</span>
        </div>
        <div class="agent-stats mono">
          <span>经验 <b>{{ memoryCount(a.name) }}</b> 条</span>
          <span>任务 <b>{{ profileOf(a.name)?.profile?.stats?.total ?? a.taskCount }}</b></span>
          <span>成功 <b>{{ profileOf(a.name)?.profile?.stats?.success ?? 0 }}</b></span>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { api, type AgentProfileInfo } from '../api';
import type { AgentLiveState } from '../composables/useDashboard';
import { onEvent } from '../composables/useDashboard';
import { statusText } from '../utils/events';

const props = defineProps<{ agents: Record<string, AgentLiveState> }>();
defineEmits<{ (e: 'show-detail', agent: AgentLiveState): void }>();

const profiles = ref<Record<string, AgentProfileInfo>>({});
const bindings = ref<Record<string, string[]>>({});

async function loadProfiles() {
  try {
    const d = await api.agentProfiles();
    profiles.value = d.agents || {};
  } catch { /* ignore */ }
}

async function loadSkills() {
  try {
    const d = await api.listSkills();
    bindings.value = d.bindings || {};
  } catch { /* ignore */ }
}

onMounted(() => {
  void loadProfiles();
  void loadSkills();
  // 经验沉淀与节点完成都会改变卡片数据，轻量跟随刷新
  onEvent((msg) => {
    if (['knowledge_deposited', 'node_complete'].includes(msg.type)) void loadProfiles();
  });
});

function profileOf(name: string): AgentProfileInfo | undefined {
  return profiles.value[name];
}
function skillsOf(name: string): string[] {
  return bindings.value[name] || [];
}
function memoryCount(name: string): number {
  return profiles.value[name]?.memory?.length ?? 0;
}

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
</script>

<style scoped>
.agents-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); gap: 10px; }
.agent-card { background: var(--ct-panel); border: 1px solid var(--ct-border); border-radius: 6px; padding: 12px; cursor: pointer; transition: border-color 0.15s; position: relative; }
.agent-card:hover { border-color: var(--ct-border2); }
.agent-top { display: flex; align-items: center; gap: 10px; margin-bottom: 8px; }
.agent-badge {
  width: 34px; height: 34px; border-radius: 4px; flex-shrink: 0;
  display: inline-flex; align-items: center; justify-content: center;
  font-family: var(--ct-mono); font-size: 12px; font-weight: 600;
  background: var(--ct-panel2); color: var(--ct-text2); border: 1px solid var(--ct-border2);
}
.agent-id { min-width: 0; }
.agent-name { font-size: 13px; font-weight: 600; display: flex; align-items: center; gap: 6px; }
.dot { width: 7px; height: 7px; border-radius: 50%; background: var(--ct-text3); flex-shrink: 0; }
.dot.running { background: var(--ct-yellow); animation: card-pulse 1.6s ease-in-out infinite; }
.dot.done { background: var(--ct-green); }
.dot.error { background: var(--ct-red); }
@keyframes card-pulse {
  0%, 100% { box-shadow: 0 0 0 0 rgba(154, 108, 10, 0.35); }
  50% { box-shadow: 0 0 0 4px rgba(154, 108, 10, 0.08); }
}
.agent-role { font-size: 11px; color: var(--ct-text3); }
.agent-desc { font-size: 11px; color: var(--ct-text3); margin-bottom: 8px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.agent-action { font-size: 11px; color: var(--ct-yellow); margin-bottom: 8px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.agent-action.idle { color: var(--ct-text3); }
.agent-skills { display: flex; gap: 4px; flex-wrap: wrap; margin-bottom: 8px; min-height: 20px; }
.skill-tag { font-size: 10px; color: var(--ct-accent); background: var(--ct-bg); border: 1px solid var(--ct-border); border-radius: 3px; padding: 1px 6px; }
.skill-more { font-size: 10px; color: var(--ct-text3); padding: 1px 2px; }
.skill-empty { font-size: 10px; color: var(--ct-text3); font-style: italic; }
.agent-stats { display: flex; gap: 12px; font-size: 11px; color: var(--ct-text3); border-top: 1px solid var(--ct-border-light, var(--ct-border)); padding-top: 8px; }
.agent-stats b { color: var(--ct-text2); font-weight: 600; }
.section-head { margin-bottom: 10px; display: flex; align-items: baseline; gap: 10px; }
.section-sub { font-size: 11px; color: var(--ct-text3); }
</style>
