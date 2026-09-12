<script setup lang="ts">
import { computed } from 'vue';
import { useRoute } from 'vue-router';
import { useDashboard } from './composables/useDashboard';

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
  </div>
</template>

<style scoped>
.app-root { height: 100dvh; display: flex; flex-direction: column; }
</style>
