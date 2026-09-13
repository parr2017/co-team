<script setup lang="ts">
import { computed, ref } from 'vue';
import { useRoute } from 'vue-router';
import { useDashboard } from './composables/useDashboard';
import { useWs } from './composables/useWs';
import { setApiToken } from './api';
import { tokenGateVisible, resolveTokenGate } from './tokenGate';

const { tasks } = useDashboard();

const route = useRoute();
const activeTab = computed(() => {
  if (route.meta.tab === 'agents') return 'agents';
  if (route.meta.tab === 'projects') return 'projects';
  if (route.meta.tab === 'discussions') return 'discussions';
  return 'tasks';
});
const showTabbar = computed(() => !!route.meta.tab);

// M10-C tabbar 未读徽标：等待人工处理（节点审批/澄清）的任务数
const humanGateCount = computed(() =>
  Object.values(tasks.value).filter((t) => ['waiting_approval', 'clarifying', 'waiting_clarify'].includes(t.status)).length
);

// SEC-P0 Token 门禁：401 → 全局输入层 → 保存后立即以新凭据重连 WS（API 请求各自自动重试）
const tokenDraft = ref('');
function saveTokenGate() {
  const t = tokenDraft.value.trim();
  if (!t) return;
  setApiToken(t);
  tokenDraft.value = '';
  resolveTokenGate(true);
  useWs().forceReconnect();
}
function dismissTokenGate() {
  resolveTokenGate(false);
}
</script>

<template>
  <div class="app-root">
    <router-view v-slot="{ Component }">
      <keep-alive include="TaskListView,AgentsView,ProjectsView,DiscussionListView">
        <component :is="Component" />
      </keep-alive>
    </router-view>
    <van-tabbar v-if="showTabbar" v-model="activeTab" placeholder safe-area-inset-bottom route>
      <van-tabbar-item to="/tasks" name="tasks" icon="chat-o">
        任务
        <template #icon="p">
          <van-badge :content="humanGateCount || ''" :show-zero="false">
            <van-icon :name="'chat-o'" :class="p.active ? 'van-tabbar-item--active' : ''" />
          </van-badge>
        </template>
      </van-tabbar-item>
      <van-tabbar-item to="/discussions" name="discussions" icon="friends-o">沟通</van-tabbar-item>
      <van-tabbar-item to="/projects" name="projects" icon="apps-o">项目</van-tabbar-item>
      <van-tabbar-item to="/agents" name="agents" icon="manager-o">成员</van-tabbar-item>
    </van-tabbar>

    <!-- SEC-P0 Token 门禁输入层 -->
    <van-popup
      :show="tokenGateVisible"
      position="bottom"
      round
      :close-on-click-overlay="false"
      :style="{ padding: '20px 16px', paddingBottom: 'calc(20px + env(safe-area-inset-bottom))' }"
    >
      <div class="gate-title">访问验证</div>
      <div class="gate-tip">本系统已启用 API Token 门禁，请输入访问 Token（由管理员下发，仅保存在本机）。</div>
      <van-field v-model="tokenDraft" type="password" placeholder="API Token" class="gate-field" />
      <div class="gate-actions">
        <van-button size="small" block @click="dismissTokenGate">稍后再说</van-button>
        <van-button size="small" block type="primary" :disabled="!tokenDraft.trim()" @click="saveTokenGate">保存并重连</van-button>
      </div>
    </van-popup>
  </div>
</template>

<style scoped>
.app-root { height: 100dvh; display: flex; flex-direction: column; }
.gate-title { font-size: 16px; font-weight: 600; color: var(--text); margin-bottom: 6px; }
.gate-tip { font-size: 13px; color: var(--text-2); line-height: 1.6; margin-bottom: 12px; }
.gate-field { border: 1px solid var(--border); border-radius: 8px; overflow: hidden; }
.gate-actions { display: flex; gap: 10px; margin-top: 12px; }
</style>
