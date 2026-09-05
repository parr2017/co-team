<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { api } from '../api';
import type { ProjectSummary } from '../api';

defineOptions({ name: 'ProjectsView' });

const router = useRouter();
const projects = ref<ProjectSummary[]>([]);
const loading = ref(true);
const error = ref('');

async function load() {
  loading.value = true;
  error.value = '';
  try {
    const d = await api.listProjects();
    projects.value = d.projects || [];
  } catch (e: any) {
    error.value = e.message || '加载失败';
  } finally {
    loading.value = false;
  }
}

onMounted(() => void load());

function donePct(p: ProjectSummary): number {
  return p.task_count ? Math.round((p.done_count / p.task_count) * 100) : 0;
}

function open(p: ProjectSummary) {
  router.push(`/project/${p.id}`);
}
</script>

<template>
  <div class="page">
    <van-nav-bar title="项目" fixed placeholder />

    <van-pull-refresh :model-value="false" class="pull-wrap" @refresh="load">
      <div class="pull">
      <van-loading v-if="loading" class="loading" vertical>加载中…</van-loading>

      <div v-else-if="error" class="err-state">
        <van-icon name="warning-o" size="48" color="#fa9d3b" />
        <div class="err-text">{{ error }}</div>
        <button class="wx-btn err-btn" @click="load">重新加载</button>
      </div>

      <div v-else-if="!projects.length" class="empty">
        <van-icon name="apps-o" size="52" class="wx-float" color="var(--text-3)" />
        <div class="empty-title">暂无项目</div>
        <div class="empty-text">在桌面端「项目开发」页可创建项目</div>
      </div>

      <template v-else>
        <div class="wx-caption">共 {{ projects.length }} 个项目</div>
        <div class="wx-group">
          <div
            v-for="p in projects"
            :key="p.id"
            class="wx-cell proj-cell"
            @click="open(p)"
          >
            <div class="p-icon" :class="{ running: p.running }">
              <span class="p-initial">{{ p.name.slice(0, 1) }}</span>
              <span v-if="p.running" class="p-dot"></span>
            </div>
            <div class="p-body">
              <div class="p-name">{{ p.name }}</div>
              <div class="p-sub">
                {{ p.task_count }} 个任务 · 完成 {{ p.done_count }}
                <template v-if="p.issues"> · {{ p.issues }} 问题</template>
              </div>
              <div class="p-prog">
                <div class="p-track"><div class="p-fill" :style="{ width: donePct(p) + '%' }"></div></div>
                <span class="p-pct">{{ donePct(p) }}%</span>
              </div>
            </div>
            <van-icon name="arrow" size="14" color="#b2b2b2" />
          </div>
        </div>
        <div class="wx-caption hint">项目创建与设置在桌面端进行，这里监控进度与下发任务</div>
      </template>
      </div>
    </van-pull-refresh>
  </div>
</template>

<style scoped>
.page { height: 100%; display: flex; flex-direction: column; background: var(--bg); }
.pull-wrap { flex: 1; min-height: 0; overflow: hidden; }
.pull { height: 100%; overflow-y: auto; -webkit-overflow-scrolling: touch; }
.loading { margin: 60px auto; }

.proj-cell { padding: 15px 16px; }
.proj-cell:active { background: var(--panel-2); }

.p-icon {
  position: relative; width: 46px; height: 46px; border-radius: 11px;
  background: linear-gradient(145deg, #26e0fb, #0284c7);
  color: #04121d; display: flex; align-items: center; justify-content: center;
  font-size: 19px; font-weight: 800; flex-shrink: 0;
  border: 1px solid rgba(255, 255, 255, 0.18);
  box-shadow: 0 0 14px rgba(34, 211, 238, 0.3);
  overflow: visible;
}
.p-icon.running {
  background: linear-gradient(145deg, #ffcf87, #ff9a3d);
  box-shadow: var(--glow-orange);
}
.p-dot {
  position: absolute; top: -2px; right: -2px; width: 10px; height: 10px;
  border-radius: 50%; background: var(--red);
  box-shadow: var(--glow-red);
  animation: wx-pulse 1.6s ease-in-out infinite;
}
.p-body { flex: 1; min-width: 0; }
.p-name { font-size: 16.5px; font-weight: 600; color: var(--text); margin-bottom: 4px; }
.p-sub { font-size: 12.5px; color: var(--text-2); margin-bottom: 7px; }
.p-prog { display: flex; align-items: center; gap: 8px; }
.p-track { flex: 1; height: 5px; border-radius: 3px; background: var(--panel-2); overflow: hidden; }
.p-fill { height: 100%; border-radius: 3px; background: linear-gradient(90deg, #22d3ee, #0369a1); box-shadow: 0 0 8px rgba(34, 211, 238, 0.45); transition: width 0.5s ease; }
.p-pct { font-size: 12px; font-weight: 600; color: var(--text-2); width: 36px; text-align: right; }

.empty { display: flex; flex-direction: column; align-items: center; gap: 6px; padding: 72px 0; }
.empty-title { font-size: 16px; color: var(--text-2); font-weight: 600; margin-top: 6px; }
.empty-text { font-size: 13px; color: var(--text-3); text-align: center; line-height: 1.6; }
.err-state { display: flex; flex-direction: column; align-items: center; gap: 8px; padding: 72px 0; }
.err-text { font-size: 14px; color: var(--text-2); }
.err-btn { margin-top: 12px; max-width: 180px; }
.hint { text-align: center; padding-bottom: 16px; }
</style>
