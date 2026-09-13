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

    <!-- SEC-P0 Token 门禁输入层：不用 van-popup——实测其 leave 过渡类会滞留（transitionend 不触发）导致门禁永不消失，安全门禁必须确定性显隐 -->
    <div v-if="tokenGateVisible" class="gate-mask">
      <div class="gate-panel">
        <div class="gate-title">访问验证</div>
        <div class="gate-tip">本系统已启用 API Token 门禁，请输入访问 Token（由管理员下发，仅保存在本机）。</div>
        <input v-model="tokenDraft" type="password" class="gate-field" placeholder="API Token" @keydown.enter="saveTokenGate" />
        <div class="gate-actions">
          <button class="wx-btn" @click="dismissTokenGate">稍后再说</button>
          <button class="wx-btn gate-save" :disabled="!tokenDraft.trim()" @click="saveTokenGate">保存并重连</button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.app-root { height: 100dvh; display: flex; flex-direction: column; }
.gate-mask { position: fixed; inset: 0; z-index: 2001; background: var(--mask, rgba(0, 0, 0, 0.7)); display: flex; align-items: flex-end; }
.gate-panel {
  width: 100%; background: var(--panel, #1a1c20); border-radius: 16px 16px 0 0;
  padding: 20px 16px calc(20px + env(safe-area-inset-bottom));
}
.gate-title { font-size: 16px; font-weight: 600; color: var(--text); margin-bottom: 6px; }
.gate-tip { font-size: 13px; color: var(--text-2); line-height: 1.6; margin-bottom: 12px; }
.gate-field {
  width: 100%; box-sizing: border-box; background: var(--panel-2, #24262b); border: 1px solid var(--border);
  border-radius: 8px; color: var(--text); font-size: 15px; padding: 10px 12px; outline: none;
}
.gate-actions { display: flex; gap: 10px; margin-top: 12px; }
.gate-actions .wx-btn { flex: 1; }
.gate-save { background: var(--accent); color: #fff; border: none; }
.gate-save:disabled { opacity: 0.5; }
</style>
