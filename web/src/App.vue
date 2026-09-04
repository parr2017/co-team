<template>
  <el-config-provider>
    <div class="app-shell">
      <header class="app-header">
        <div class="logo">
          <span class="logo-mark">co-team</span>
          <span class="logo-env">multi-agent orchestrator</span>
        </div>
        <nav class="nav mono">
          <button class="nav-tab" :class="{ active: page === 'workbench' }" @click="page = 'workbench'">工作台</button>
          <button class="nav-tab" :class="{ active: page === 'project' }" @click="page = 'project'">项目开发</button>
        </nav>
        <div class="header-right">
          <div class="header-metrics mono" v-if="status">
            <span class="metric">tok <b>{{ status.tokens_total.toLocaleString() }}</b></span>
            <span class="metric">cost <b>${{ status.cost_total.toFixed(4) }}</b></span>
          </div>
          <span class="conn" :class="{ off: !connected }"><i></i>{{ connected ? 'connected' : 'connecting' }}</span>
          <button class="theme-toggle mono" @click="toggle">{{ theme === 'dark' ? 'light' : 'dark' }} mode</button>
        </div>
      </header>

      <div class="layout" v-if="page === 'workbench'">
        <main class="main">
          <TaskForm @planned="openReview" @needs-clarify="(tid: string) => openClarify(tid)" />
          <AgentCards :agents="agents" @show-detail="detailAgent = $event" />
          <TaskList
            :tasks="tasks"
            :total="taskTotal"
            :current-page="taskPage"
            :page-size="taskPageSize"
            @approve="onApprove"
            @cancel="onCancel"
            @delete="onDeleteTask"
            @show-logs="openChat"
            @show-dag="dagTaskId = $event"
            @show-detail="detailTaskId = $event"
            @review="openReview"
            @clarify="openClarify"
            @page-change="onTaskPageChange"
 />
          <EventLog :events="events" @clear="clearEvents" />
        </main>
        <aside class="side">
          <ModelPoolPanel :status="status" @refresh="refreshStatus" />
          <MetricsPanel ref="metricsRef" />
            <div class="section">
              <div class="section-title">操作</div>
              <div class="ops">
                <el-button size="small" style="width: 100%" @click="roadmapVisible = true">项目路线图</el-button>
                <el-button size="small" style="width: 100%; margin: 8px 0 0" @click="knowledgeVisible = true">知识库</el-button>
                <el-button size="small" style="width: 100%; margin: 8px 0 0" @click="settingsVisible = true">设置</el-button>
                <el-button size="small" style="width: 100%; margin: 8px 0 0" @click="refreshStatus(); metricsRef?.refresh()">刷新状态</el-button>
                <el-button size="small" style="width: 100%; margin: 8px 0 0" @click="onReloadAgents">重载 Agent</el-button>
              </div>
            </div>
        </aside>
      </div>

      <div class="layout" v-if="page === 'project'">
        <main class="main">
          <ProjectView @open-detail="detailTaskId = $event" @review="openReview" />
        </main>
      </div>

      <AgentDetail :model-value="detailAgent !== null" :agent="detailAgent" @close="detailAgent = null" @open-detail="(tid: string) => { detailAgent = null; detailTaskId = tid; }" />
      <ChatReplay v-model="chatVisible" :task-id="chatTaskId" :node-id="chatNodeId" :task="chatTask" />
      <TaskDagDialog :model-value="dagTaskId !== null" :task="dagTaskId ? tasks[dagTaskId] : null" @close="dagTaskId = null" />
      <SettingsDialog v-model="settingsVisible" @changed="refreshStatus" />
      <PlanReviewDialog :model-value="reviewTaskId !== null" :task-id="reviewTaskId || ''" @close="reviewTaskId = null" @started="onPlanStarted" @cancelled="loadTasks" @changed="loadTasks" />
      <ClarifyDialog :model-value="clarifyTaskId !== null" :task-id="clarifyTaskId || ''" @close="clarifyTaskId = null" @planned="onClarifyPlanned" @cancelled="loadTasks" @changed="loadTasks" />
      <KnowledgeDialog v-model="knowledgeVisible" />
      <TaskDetailDialog :model-value="detailTaskId !== null" :task-id="detailTaskId || ''" :live-agents="agents" @close="detailTaskId = null" />
      <RoadmapDialog v-model="roadmapVisible" />
    </div>
  </el-config-provider>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, onUnmounted } from 'vue';
import { ElMessage } from 'element-plus';
import { api, type StatusResponse } from './api';
import { useDashboard, type AgentLiveState } from './composables/useDashboard';
import { useTheme } from './composables/useTheme';
import TaskForm from './components/TaskForm.vue';
import AgentCards from './components/AgentCards.vue';
import TaskList from './components/TaskList.vue';
import EventLog from './components/EventLog.vue';
import ModelPoolPanel from './components/ModelPoolPanel.vue';
import MetricsPanel from './components/MetricsPanel.vue';
import AgentDetail from './components/AgentDetail.vue';
import ChatReplay from './components/ChatReplay.vue';
import TaskDagDialog from './components/TaskDagDialog.vue';
import SettingsDialog from './components/SettingsDialog.vue';
import PlanReviewDialog from './components/PlanReviewDialog.vue';
import ClarifyDialog from './components/ClarifyDialog.vue';
import KnowledgeDialog from './components/KnowledgeDialog.vue';
import TaskDetailDialog from './components/TaskDetailDialog.vue';
import RoadmapDialog from './components/RoadmapDialog.vue';
import ProjectView from './components/ProjectView.vue';

const { agents, tasks, events, connected, taskTotal, taskPage, taskPageSize, loadAgents, loadTasks, clearEvents } = useDashboard();
const { theme, toggle } = useTheme();
const status = ref<StatusResponse | null>(null);
const metricsRef = ref<{ refresh: () => void } | null>(null);
const settingsVisible = ref(false);
const page = ref<'workbench' | 'project'>('workbench');
const roadmapVisible = ref(false);
const reviewTaskId = ref<string | null>(null);
const detailTaskId = ref<string | null>(null);
const clarifyTaskId = ref<string | null>(null);
const knowledgeVisible = ref(false);

function openReview(taskId: string) {
  reviewTaskId.value = taskId;
  void loadTasks(taskPage.value, taskPageSize.value);
}
function openClarify(taskId: string) {
  clarifyTaskId.value = taskId;
  void loadTasks(taskPage.value, taskPageSize.value);
}
function onClarifyPlanned(taskId: string) {
  clarifyTaskId.value = null;
  void loadTasks(taskPage.value, taskPageSize.value);
  openReview(taskId);
}
function onPlanStarted() {
  reviewTaskId.value = null;
  void loadTasks(taskPage.value, taskPageSize.value);
}

const detailAgent = ref<AgentLiveState | null>(null);
const chatVisible = ref(false);
const chatTaskId = ref('');
const chatNodeId = ref('');
const chatTask = computed(() => tasks[chatTaskId.value] ?? null);
const dagTaskId = ref<string | null>(null);

async function refreshStatus() {
  try {
    status.value = await api.status();
  } catch {
    /* ignore */
  }
}

async function openChat(taskId: string, nodeId: string) {
  chatTaskId.value = taskId;
  chatNodeId.value = nodeId;
  chatVisible.value = true;
}

async function onApprove(taskId: string, nodeId: string) {
  try {
    await api.approveNode(taskId, nodeId);
    ElMessage.success('已批准，任务恢复执行');
  } catch (e: any) {
    ElMessage.error(e.message);
  }
}

async function onCancel(taskId: string) {
  try {
    await api.cancelTask(taskId);
    ElMessage.info('取消信号已发送');
  } catch (e: any) {
    ElMessage.error(e.message);
  }
}

async function onDeleteTask(taskId: string) {
  try {
    await api.deleteTask(taskId);
    ElMessage.success('任务已删除');
    await loadTasks(taskPage.value, taskPageSize.value);
  } catch (e: any) {
    ElMessage.error(e.message);
  }
}

function onTaskPageChange(page: number) {
  void loadTasks(page, taskPageSize.value);
}

async function onReloadAgents() {
  try {
    await api.reloadAgents();
    ElMessage.success('Agent 已重载');
    loadAgents();
  } catch (e: any) {
    ElMessage.error(e.message);
  }
}

let timer: number | undefined;
onMounted(() => {
  refreshStatus();
  timer = window.setInterval(refreshStatus, 8000);
});
onUnmounted(() => window.clearInterval(timer));
</script>

<style>:root {
  --ct-bg: #f5f6f8;
  --ct-panel: #ffffff;
  --ct-panel2: #eef0f3;
  --ct-border: #e2e4e8;
  --ct-border2: #cfd2d8;
  --ct-text: #191c20;
  --ct-text2: #494e56;
  --ct-text3: #878d96;
  --ct-accent: #2f6fed;
  --ct-green: #178a3e;
  --ct-yellow: #9a6c0a;
  --ct-red: #cc3f38;
  --ct-mono: 'JetBrains Mono', 'SF Mono', 'Cascadia Code', Consolas, monospace;
  --el-font-family: -apple-system, 'Segoe UI', Roboto, sans-serif;
}
html.dark {
  --ct-bg: #0b0c0e;
  --ct-panel: #111214;
  --ct-panel2: #17181b;
  --ct-border: #26272c;
  --ct-border2: #33353b;
  --ct-text: #d7dae0;
  --ct-text2: #9aa0aa;
  --ct-text3: #666b75;
  --ct-accent: #4a8dff;
  --ct-green: #3fb950;
  --ct-yellow: #d29922;
  --ct-red: #e5534b;
}
/* flatten element-plus */
:root, html.dark {
  --el-bg-color: var(--ct-panel);
  --el-bg-color-overlay: var(--ct-panel2);
  --el-bg-color-page: var(--ct-bg);
  --el-border-color: var(--ct-border);
  --el-border-color-light: var(--ct-border);
  --el-border-color-lighter: var(--ct-border);
  --el-fill-color-blank: var(--ct-panel);
  --el-fill-color-light: var(--ct-panel2);
  --el-text-color-primary: var(--ct-text);
  --el-text-color-regular: var(--ct-text2);
  --el-color-primary: var(--ct-accent);
  --el-color-success: var(--ct-green);
  --el-color-danger: var(--ct-red);
  --el-color-warning: var(--ct-yellow);
}
html, body { height: 100%; overflow: hidden; }
body { margin: 0; background: var(--ct-bg); color: var(--ct-text); font-family: -apple-system, 'Segoe UI', Roboto, sans-serif; font-size: 13px; }
::-webkit-scrollbar { width: 8px; height: 8px; }
::-webkit-scrollbar-thumb { background: var(--ct-border2); border-radius: 4px; }
::-webkit-scrollbar-thumb:hover { background: var(--ct-text3); }
::-webkit-scrollbar-track { background: transparent; }
* { scrollbar-width: thin; scrollbar-color: var(--ct-border2) transparent; }
.mono { font-family: var(--ct-mono); }
.app-shell { height: 100vh; display: flex; flex-direction: column; overflow: hidden; }
.app-header {
  flex-shrink: 0; z-index: 50; height: 48px; padding: 0 20px;
  display: flex; align-items: center; justify-content: space-between; gap: 16px;
  background: var(--ct-panel); border-bottom: 1px solid var(--ct-border);
}
.logo { display: flex; align-items: baseline; gap: 10px; }
.logo-mark { font-family: var(--ct-mono); font-size: 14px; font-weight: 600; color: var(--ct-text); }
.logo-env { font-family: var(--ct-mono); font-size: 11px; color: var(--ct-text3); }
.nav { display: flex; gap: 4px; margin-left: 24px; }
.nav-tab { font-family: var(--ct-mono); font-size: 12px; color: var(--ct-text3); background: transparent; border: none; border-bottom: 2px solid transparent; padding: 6px 10px; cursor: pointer; }
.nav-tab.active { color: var(--ct-text); border-bottom-color: var(--ct-accent); }
.nav-tab:hover { color: var(--ct-text); }
.header-right { display: flex; align-items: center; gap: 14px; }
.header-metrics { display: flex; gap: 14px; font-size: 11px; color: var(--ct-text3); }
.header-metrics b { color: var(--ct-text2); font-weight: 500; }
.conn { display: inline-flex; align-items: center; gap: 6px; font-family: var(--ct-mono); font-size: 11px; color: var(--ct-green); }
.conn i { width: 6px; height: 6px; border-radius: 50%; background: var(--ct-green); }
.conn.off { color: var(--ct-red); }
.conn.off i { background: var(--ct-red); }
.theme-toggle { font-family: var(--ct-mono); font-size: 11px; color: var(--ct-text3); background: var(--ct-panel2); border: 1px solid var(--ct-border); border-radius: 4px; padding: 4px 10px; cursor: pointer; }
.theme-toggle:hover { color: var(--ct-text); border-color: var(--ct-border2); }
.layout { flex: 1; min-height: 0; display: grid; grid-template-columns: 1fr 340px; overflow: hidden; }
.main { overflow-y: auto; padding: 20px 24px; border-right: 1px solid var(--ct-border); }
.side { overflow-y: auto; padding: 16px; }
.el-dialog__body { max-height: calc(88vh - 110px); overflow-y: auto; }
.section { margin-bottom: 24px; }
.section-title { font-family: var(--ct-mono); font-size: 11px; font-weight: 500; color: var(--ct-text3); text-transform: uppercase; letter-spacing: 0.6px; margin-bottom: 10px; }
.panel { background: var(--ct-panel); border: 1px solid var(--ct-border); border-radius: 6px; padding: 14px; margin-bottom: 16px; }
.el-dialog { border: 1px solid var(--ct-border2) !important; border-radius: 6px !important; }
.el-dialog__title { font-family: var(--ct-mono); font-size: 13px !important; }
.el-button { border-radius: 4px !important; font-weight: 400 !important; }
.el-table { --el-table-border-color: var(--ct-border); --el-table-bg-color: var(--ct-panel); --el-table-tr-bg-color: var(--ct-panel); --el-table-header-bg-color: var(--ct-panel2); }
.el-tag { border-radius: 3px !important; font-family: var(--ct-mono); }
</style>
