<template>
  <el-dialog :model-value="modelValue" title="成员档案" width="680px" @open="load" @close="$emit('close')">
    <template v-if="agent">
      <div class="p-head">
        <span class="p-avatar mono">{{ badge }}</span>
        <div class="p-id"><div class="p-name mono">{{ agent.name }}</div></div>
      </div>
      <div class="p-section-title mono">当前状态</div>
      <div class="p-value">
        <template v-if="agent.task">
          正在执行 <b>{{ agent.task.name }}</b>
          <div v-if="agent.currentAction" class="p-action mono">⚙ {{ agent.currentAction }}</div>
          <div v-if="agent.model" class="p-model mono">模型: {{ agent.model }}</div>
          <div v-if="agent.task.error" class="p-err mono">错误: {{ agent.task.error }}</div>
        </template>
        <span v-else class="p-muted">休息中{{ lastTaskDesc ? ' · 上次任务: ' + lastTaskDesc : '' }}</span>
      </div>

      <div class="p-section-title mono">使用模型</div>
      <div class="p-value mono">{{ profile?.profile?.last_model || agent.model || '尚未执行过任务（执行时由模型池按任务复杂度调度）' }}</div>

      <div class="p-section-title mono">能力与职责</div>
      <div class="p-value">
        <div>{{ agentDesc || '—' }}</div>
        <div class="p-tags mono">{{ (profile?.tags || []).join(' · ') }}</div>
      </div>

      <div class="p-section-title mono">经验记忆</div>
      <div class="p-value">
        <div v-if="(profile?.memory || []).length">
          <div v-for="(m, i) in profile!.memory" :key="i" class="p-memory mono">› {{ m }}</div>
        </div>
        <span v-else class="p-muted">暂无经验记忆（随任务完成自动积累）</span>
      </div>

      <div class="p-section-title mono">近期任务</div>
      <div class="p-value">
        <div v-if="(profile?.profile?.tasks || []).length">
          <div v-for="(t, i) in [...(profile?.profile?.tasks || [])].reverse().slice(0, 8)" :key="i" class="p-task mono">
            <span class="pt-status" :class="t.status">{{ t.status === 'completed' ? '✓' : '✗' }}</span>
            {{ t.description.slice(0, 36) }} — {{ t.node }}
          </div>
        </div>
        <span v-else class="p-muted">还没有执行记录</span>
      </div>
    </template>
  </el-dialog>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue';
import { api } from '../api';
import type { AgentLiveState } from '../composables/useDashboard';

const props = defineProps<{ modelValue: boolean; agent: AgentLiveState | null }>();
defineEmits<{ (e: 'close'): void }>();

const profile = ref<any>(null);
const lastTaskDesc = ref('');

const ROLES: Record<string, string> = { orchestrator: '任务编排器', dev: '开发工程师', review: '代码审查员', test: '测试工程师', deploy: '运维工程师', docs: '文档工程师', refactor: '重构专家' };
const roleFallback = computed(() => ROLES[props.agent?.name || ''] || props.agent?.name || '');
const badge = computed(() => (props.agent?.name || '??').replace(/[^a-z]/gi, '').slice(0, 2).toUpperCase());
const color = computed(() => {
  const s = props.agent?.status;
  if (s === 'running') return 'var(--ct-yellow)';
  if (s === 'done') return 'var(--ct-green)';
  if (s === 'error') return 'var(--ct-red)';
  return 'var(--ct-text3)';
});
const statusText = computed(() => (({ idle: '空闲', running: '工作中', done: '已完成', error: '出错' } as Record<string, string>)[props.agent?.status || 'idle']) || props.agent?.status);
const agentDesc = computed(() => profile.value?.description || '');

async function load() {
  if (!props.agent) return;
  lastTaskDesc.value = props.agent.task?.name || '';
  try {
    const d = await api.agentProfiles();
    profile.value = d.agents[props.agent.name] || null;
    if (!lastTaskDesc.value && profile.value?.tasks?.length) {
      lastTaskDesc.value = [...profile.value.tasks].reverse()[0].description;
    }
  } catch {
    profile.value = null;
  }
}
</script>

<style scoped>
.p-head { display: flex; align-items: center; gap: 14px; }
.p-avatar { width: 52px; height: 52px; border-radius: 8px; border: 2px solid; display: flex; align-items: center; justify-content: center; font-size: 16px; font-weight: 700; background: var(--ct-panel2); color: var(--ct-text); }
.p-name { font-size: 17px; font-weight: 700; }
.p-role { font-size: 12px; color: var(--ct-text3); }
.p-exp { color: var(--ct-text3); }
.p-section-title { font-size: 10px; color: var(--ct-text3); text-transform: uppercase; letter-spacing: 0.6px; margin: 14px 0 6px; }
.p-value { background: var(--ct-bg); border-radius: 6px; padding: 10px 12px; font-size: 12px; color: var(--ct-text2); }
.p-action { color: var(--ct-yellow); margin-top: 4px; }
.p-model { color: var(--ct-accent); margin-top: 4px; }
.p-err { color: var(--ct-red); margin-top: 4px; }
.p-muted { color: var(--ct-text3); }
.p-tags { color: var(--ct-text3); margin-top: 4px; }
.p-memory { padding: 1px 0; font-size: 11px; color: var(--ct-text2); }
.p-task { padding: 2px 0; font-size: 11px; }
.pt-status.completed { color: var(--ct-green); }
.pt-status.failed { color: var(--ct-red); }
</style>
