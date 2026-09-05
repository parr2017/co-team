<script setup lang="ts">
import { computed } from 'vue';
import { useRoute } from 'vue-router';
import { useDashboard } from './composables/useDashboard';

useDashboard();

const route = useRoute();
const activeTab = computed(() => {
  if (route.meta.tab === 'agents') return 'agents';
  if (route.meta.tab === 'projects') return 'projects';
  return 'tasks';
});
const showTabbar = computed(() => !!route.meta.tab);
</script>

<template>
  <div class="app-root">
    <router-view v-slot="{ Component }">
      <keep-alive include="TaskListView,AgentsView,ProjectsView">
        <component :is="Component" />
      </keep-alive>
    </router-view>
    <van-tabbar v-if="showTabbar" v-model="activeTab" placeholder safe-area-inset-bottom route>
      <van-tabbar-item to="/tasks" name="tasks" icon="chat-o">任务</van-tabbar-item>
      <van-tabbar-item to="/projects" name="projects" icon="apps-o">项目</van-tabbar-item>
      <van-tabbar-item to="/agents" name="agents" icon="friends-o">成员</van-tabbar-item>
    </van-tabbar>
  </div>
</template>

<style scoped>
.app-root { height: 100dvh; display: flex; flex-direction: column; }
</style>
