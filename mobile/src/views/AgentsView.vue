<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { api, type AgentProfileSummary } from '../api';
import { useDashboard } from '../composables/useDashboard';
import AgentAvatar from '../components/AgentAvatar.vue';

defineOptions({ name: 'AgentsView' });

const router = useRouter();
const { agents, tasks, connected } = useDashboard();

const profiles = ref<Record<string, AgentProfileSummary>>({});
const bindings = ref<Record<string, string[]>>({});

onMounted(async () => {
  try {
    const d = await api.agentProfiles();
    profiles.value = d.agents || {};
  } catch { /* ignore */ }
  try {
    const d = await api.listSkills();
    bindings.value = d.bindings || {};
  } catch { /* ignore */ }
});

function skillsOf(name: string): string[] {
  return bindings.value[name] || [];
}
function memoryCount(name: string): number {
  return profiles.value[name]?.memory?.length ?? 0;
}

const GROUP_LABELS: Record<string, string> = {
  orchestrator: '主 Agent',
  dev: '开发组',
  test: '测试组',
  review: '审查组',
  deploy: '部署组',
  docs: '文档组',
  refactor: '重构组',
};

function groupOf(name: string): string {
  const lower = name.toLowerCase();
  for (const key of Object.keys(GROUP_LABELS)) {
    if (lower.includes(key)) return GROUP_LABELS[key];
  }
  return '其他成员';
}

/** contact-book sections: group label → member cards, ordered like the WeChat address book */
const sections = computed(() => {
  const list = Object.values(agents.value).sort((a, b) => a.name.localeCompare(b.name));
  const map = new Map<string, typeof list>();
  for (const a of list) {
    const g = a.name === 'orchestrator' ? '主 Agent' : groupOf(a.name);
    if (!map.has(g)) map.set(g, []);
    map.get(g)!.push(a);
  }
  // 主 Agent first, 其他成员 last
  const order = ['主 Agent', ...Object.values(GROUP_LABELS).filter((v) => v !== '主 Agent'), '其他成员'];
  return [...map.entries()].sort((x, y) => order.indexOf(x[0]) - order.indexOf(y[0]));
});

/** live per-agent task load from the task store */
function currentTaskOf(name: string): string {
  for (const t of Object.values(tasks.value)) {
    if (['running', 'retrying', 'waiting_approval'].includes(t.status)) {
      const node = t.nodes.find((n) => n.agent === name && ['running', 'retrying'].includes(n.status));
      if (node) return node.name;
    }
  }
  return '';
}

function taskCountOf(name: string): number {
  return Object.values(tasks.value).filter((t) => t.nodes.some((n) => n.agent === name && n.status === 'completed')).length;
}

function isBusy(name: string): boolean {
  return !!currentTaskOf(name);
}

function goTaskOf(name: string) {
  for (const t of Object.values(tasks.value)) {
    if (t.nodes.some((n) => n.agent === name && ['running', 'retrying', 'waiting_approval'].includes(n.status))) {
      router.push(`/task/${t.task_id}`);
      return;
    }
  }
}
</script>

<template>
  <div class="page">
    <van-nav-bar title="团队成员" fixed placeholder>
      <template #right>
        <span class="conn-dot" :class="{ off: !connected }"></span>
      </template>
    </van-nav-bar>

    <div class="book">
      <template v-for="[group, members] in sections" :key="group">
        <div class="group-label">{{ group }}</div>
        <div class="wx-group">
          <div
            v-for="a in members"
            :key="a.name"
            class="wx-cell member"
            :class="{ busy: isBusy(a.name) }"
            @click="goTaskOf(a.name)"
          >
            <div class="m-avatar">
              <AgentAvatar :name="a.name" :size="40" />
              <span v-if="isBusy(a.name)" class="m-dot"></span>
            </div>
            <div class="m-body">
              <div class="m-name">{{ a.name }}</div>
              <div class="m-desc">
              <span v-if="isBusy(a.name)" class="m-busy-text wx-pulse">{{ currentTaskOf(a.name) }}</span>
              <span v-else>空闲</span>
            </div>
              <div v-if="skillsOf(a.name).length" class="m-skills mono">
                <span v-for="s in skillsOf(a.name).slice(0, 2)" :key="s" class="m-skill">{{ s }}</span>
                <span v-if="skillsOf(a.name).length > 2" class="m-skill-more">+{{ skillsOf(a.name).length - 2 }}</span>
              </div>
            </div>
            <div class="m-meta">
              <span v-if="a.model" class="m-model">{{ a.model }}</span>
              <span class="m-count">经验 {{ memoryCount(a.name) }} 条</span>
              <span v-if="taskCountOf(a.name)" class="m-count">{{ taskCountOf(a.name) }} 节点</span>
            </div>
          </div>
        </div>
      </template>
      <div v-if="!sections.length" class="empty">
        <van-icon name="friends-o" size="52" color="var(--text-3)" />
        <div class="empty-text">加载中…</div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.page { height: 100%; display: flex; flex-direction: column; background: var(--bg); }
.conn-dot { width: 10px; height: 10px; border-radius: 50%; background: var(--green); display: inline-block;  animation: wx-pulse 1.6s ease-in-out infinite; }
.conn-dot.off { background: var(--red);  }

.book { flex: 1; min-height: 0; overflow-y: auto; -webkit-overflow-scrolling: touch; padding-bottom: 20px; }

.group-label {
  font-size: 13px; color: var(--text-2);
  padding: 12px 20px 5px; letter-spacing: 0.3px;
}

.member:active { background: var(--panel-2); }

.m-avatar { position: relative; flex-shrink: 0; }
.m-dot {
  position: absolute; top: -1px; right: -1px;
  width: 10px; height: 10px; border-radius: 50%;
  background: var(--yellow); 
  animation: wx-pulse 1.6s ease-in-out infinite;
}
.m-body { flex: 1; min-width: 0; }
.m-name { font-size: 16px; font-weight: 500; color: var(--text); margin-bottom: 3px; }
.m-desc {
  font-size: 13px; color: var(--text-3);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.m-busy-text { color: var(--wx-orange); }
.m-skills { display: flex; gap: 4px; margin-top: 4px; flex-wrap: wrap; }
.m-skill { font-size: 10px; color: var(--wx-blue); background: rgba(76, 194, 255, 0.08); border: 1px solid rgba(76, 194, 255, 0.22); border-radius: 4px; padding: 0 5px; }
.m-skill-more { font-size: 10px; color: var(--text-3); }
.m-meta { display: flex; flex-direction: column; align-items: flex-end; gap: 4px; flex-shrink: 0; }
.m-model { font-size: 11px; color: var(--wx-blue); background: rgba(76, 194, 255, 0.08); border: 1px solid rgba(76, 194, 255, 0.22); border-radius: 5px; padding: 2px 7px; }
.m-count { font-size: 11px; color: var(--text-3); font-variant-numeric: tabular-nums; }

.empty { display: flex; flex-direction: column; align-items: center; gap: 10px; padding: 72px 0; }
.empty-text { font-size: 14px; color: var(--text-3); }
</style>
