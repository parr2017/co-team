<template>
  <el-config-provider>
    <div class="app-shell">
      <header class="app-header">
        <div class="brand">
          <div class="brand-mark mono">CT</div>
          <div class="brand-text">
            <span class="brand-name">Co-Team</span>
            <span class="brand-sub mono">multi-agent orchestrator</span>
          </div>
        </div>
        <nav class="nav">
          <button class="nav-tab" :class="{ active: page === 'workbench' }" @click="router.push('/workbench')">工作台</button>
          <button class="nav-tab" :class="{ active: page === 'tasks' }" @click="router.push('/tasks')">
            任务中心
            <span v-if="pendingGateCount" class="nav-badge" :title="`${pendingGateCount} 个任务等待你的反馈（审批/澄清/计划评审）`">{{ pendingGateCount }}</span>
          </button>
          <button class="nav-tab" :class="{ active: page === 'approvals' }" @click="router.push('/approvals')">
            审批
            <span v-if="pendingGateCount" class="nav-badge" title="等待你处理的审批/提案/命令/提问">{{ pendingGateCount }}</span>
          </button>
          <button class="nav-tab" :class="{ active: page === 'project' }" @click="router.push('/project')">项目开发</button>
          <button class="nav-tab" :class="{ active: page === 'discuss' }" @click="router.push('/discuss')">
            群组沟通
            <span v-if="discussAlertCount" class="nav-badge" :title="`${discussAlertCount} 个讨论有成员等你拍板`">{{ discussAlertCount }}</span>
          </button>
        </nav>
        <div class="header-right">
          <div class="header-metrics" v-if="status">
            <span class="metric-pill">成本 <b class="mono">${{ status.cost_total.toFixed(4) }}</b></span>
            <span class="metric-pill">Token <b class="mono">{{ status.tokens_total.toLocaleString() }}</b></span>
          </div>
          <span class="conn" :class="{ off: !connected }"><i></i>{{ connected ? '已连接' : '连接中' }}</span>
          <button v-if="page === 'workbench' || page === 'tasks'" class="side-toggle" :title="sideCollapsed ? '展开侧栏' : '收起侧栏'" @click="sideCollapsed = !sideCollapsed">{{ sideCollapsed ? '«' : '»' }}</button>
          <button class="theme-toggle" :title="theme === 'dark' ? '切到亮色' : '切到暗色'" @click="toggle">{{ theme === 'dark' ? '☀' : '☾' }}</button>
        </div>
      </header>

      <div class="layout" :class="{ 'side-hidden': sideCollapsed }" v-if="page === 'workbench'">
        <main class="main">
          <div class="page-toolbar">
            <div class="page-title">工作台</div>
            <div class="page-ops">
              <el-button size="small" @click="roadmapVisible = true">项目路线图</el-button>
              <el-button size="small" @click="logVisible = true">服务日志</el-button>
              <el-button size="small" @click="knowledgeVisible = true">知识库</el-button>
              <el-button size="small" @click="dailyReportVisible = true">
                问题报告
                <span v-if="pendingGateCount" class="btn-badge">{{ pendingGateCount }}</span>
              </el-button>
              <el-button size="small" @click="settingsVisible = true">设置</el-button>
              <el-button size="small" @click="refreshStatus(); metricsRef?.refresh()">刷新状态</el-button>
              <el-button size="small" @click="onReloadAgents">重载 Agent</el-button>
            </div>
          </div>
          <div class="main-inner">
            <ActiveTaskHero @open="detailTaskId = $event" />
            <TaskForm @planned="openReview" @needs-clarify="(tid: string) => openClarify(tid)" />
            <MetricsPanel ref="metricsRef" />
            <section class="section">
              <div class="section-head"><h3 class="sec-h3">最近动态</h3><span class="sec-hint">实时事件流</span></div>
              <div class="panel home-events"><EventLog :events="events" @clear="clearEvents" /></div>
            </section>
          </div>
        </main>
        <aside class="side">
          <AgentCards :agents="agents" @show-detail="detailAgent = $event" />
          <ModelPoolPanel :status="status" @refresh="refreshStatus" />
          <EventLog :events="events" @clear="clearEvents" />
        </aside>
      </div>

      <div class="layout" :class="{ 'side-hidden': sideCollapsed }" v-else-if="page === 'tasks'">
        <main class="main">
          <TaskCenterView
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
            @search="onTaskSearch"
          />
        </main>
        <aside class="side">
          <ModelPoolPanel :status="status" @refresh="refreshStatus" />
        </aside>
      </div>

      <div class="layout" v-else-if="page === 'project'">
        <main class="main">
          <ProjectView @open-detail="detailTaskId = $event" @review="openReview" />
        </main>
      </div>

      <div class="layout flush" v-else-if="page === 'discuss'">
        <main class="main">
          <GroupDiscussionView @open-task="detailTaskId = $event" />
        </main>
      </div>

      <div class="layout" v-else-if="page === 'approvals'">
        <main class="main">
          <div class="page-toolbar">
            <div class="page-title">审批收件箱</div>
          </div>
          <router-view />
        </main>
      </div>

      <AgentDetail :model-value="detailAgent !== null" :agent="detailAgent" @close="detailAgent = null" @open-detail="(tid: string) => { detailAgent = null; detailTaskId = tid; }" />
      <ChatReplay v-model="chatVisible" :task-id="chatTaskId" :node-id="chatNodeId" :task="chatTask" />
      <TaskDagDialog :model-value="dagTaskId !== null" :task="dagTaskId ? tasks[dagTaskId] : null" @close="dagTaskId = null" />
      <SettingsDialog v-model="settingsVisible" :notify-enabled="notifyEnabled" @notify-toggle="onNotifyToggle" @changed="refreshStatus" />
      <PlanReviewDialog :model-value="reviewTaskId !== null" :task-id="reviewTaskId || ''" @close="reviewTaskId = null" @started="onPlanStarted" @cancelled="loadTasks" @changed="loadTasks" />
      <ClarifyDialog :model-value="clarifyTaskId !== null" :task-id="clarifyTaskId || ''" @close="clarifyTaskId = null" @planned="onClarifyPlanned" @cancelled="loadTasks" @changed="loadTasks" />
      <KnowledgeDialog v-model="knowledgeVisible" />
      <DailyReportDialog v-model="dailyReportVisible" @open-task="(tid: string) => { dailyReportVisible = false; detailTaskId = tid; }" />
      <TaskDetailDialog :model-value="detailTaskId !== null" :task-id="detailTaskId || ''" :live-agents="agents" @close="detailTaskId = null" />
      <RoadmapDialog v-model="roadmapVisible" />
      <LogViewerDialog v-model="logVisible" />

      <!-- SEC-P0 Token 门禁：任何 401 全局接管（替代首访/凭据失效的静默空白页） -->
      <el-dialog v-model="tokenGateVisible" title="访问验证" width="420px" append-to-body :close-on-click-modal="false">
        <div class="gate-tip">本系统已启用 API Token 门禁，请输入访问 Token（由管理员下发，仅保存在本浏览器）。</div>
        <el-input v-model="tokenDraft" placeholder="API Token" show-password @keydown.enter="saveTokenGate" />
        <template #footer>
          <el-button size="small" @click="tokenGateVisible = false">稍后再说</el-button>
          <el-button size="small" type="primary" :disabled="!tokenDraft.trim()" @click="saveTokenGate">保存并重连</el-button>
        </template>
      </el-dialog>
    </div>
  </el-config-provider>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, onUnmounted } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { showApiError } from './utils/apiError';
import { ElMessage, ElMessageBox } from 'element-plus';
import { api, setApiToken, type StatusResponse } from './api';
import { useDashboard, type AgentLiveState } from './composables/useDashboard';
import { useTheme } from './composables/useTheme';
import { useNotifier } from './composables/useNotifier';
import TaskForm from './components/TaskForm.vue';
import AgentCards from './components/AgentCards.vue';
import TaskCenterView from './components/TaskCenterView.vue';
import EventLog from './components/EventLog.vue';
import ActiveTaskHero from './components/ActiveTaskHero.vue';
import ModelPoolPanel from './components/ModelPoolPanel.vue';
import MetricsPanel from './components/MetricsPanel.vue';
import AgentDetail from './components/AgentDetail.vue';
import ChatReplay from './components/ChatReplay.vue';
import TaskDagDialog from './components/TaskDagDialog.vue';
import SettingsDialog from './components/SettingsDialog.vue';
import PlanReviewDialog from './components/PlanReviewDialog.vue';
import ClarifyDialog from './components/ClarifyDialog.vue';
import KnowledgeDialog from './components/KnowledgeDialog.vue';
import DailyReportDialog from './components/DailyReportDialog.vue';
import TaskDetailDialog from './components/TaskDetailDialog.vue';
import RoadmapDialog from './components/RoadmapDialog.vue';
import LogViewerDialog from './components/LogViewerDialog.vue';
import ProjectView from './components/ProjectView.vue';
import GroupDiscussionView from './components/GroupDiscussionView.vue';
import { useDiscussion } from './composables/useDiscussion';

const { agents, tasks, events, connected, taskTotal, taskPage, taskPageSize, loadAgents, loadTasks, reconnectWs, clearEvents } = useDashboard();
const { list: discList, loadList: loadDiscussions } = useDiscussion();

// B5：审批收件箱「去处理/详情」打开任务详情对话框（收件箱是路由组件，对话框宿主在 App.vue）
const onOpenTaskEvent = (e: Event) => {
  const tid = (e as CustomEvent<string>).detail;
  if (tid) detailTaskId.value = tid;
};
window.addEventListener('coteam:open-task', onOpenTaskEvent);
onUnmounted(() => window.removeEventListener('coteam:open-task', onOpenTaskEvent));
const { theme, toggle } = useTheme();
const { enabled: notifyEnabled, setEnabled: setNotifyEnabled } = useNotifier();
const status = ref<StatusResponse | null>(null);
const metricsRef = ref<{ refresh: () => void } | null>(null);
const settingsVisible = ref(false);
// 步骤2：工作台/任务中心右栏可折叠（宽屏满宽自适应）
const sideCollapsed = ref(false);
// B3（2026-09-17）：路由是页面切换的唯一事实源——URL 直达、刷新不丢、前进后退可用
const route = useRoute();
const router = useRouter();
const page = computed(() => (route.name as string) || 'workbench');
const roadmapVisible = ref(false);
const logVisible = ref(false);
const reviewTaskId = ref<string | null>(null);
const detailTaskId = ref<string | null>(null);
const clarifyTaskId = ref<string | null>(null);
const knowledgeVisible = ref(false);
const dailyReportVisible = ref(false);

// feature: 实施前澄清 + 快速反馈 —— 等待人工处理的任务数（审批/澄清/计划评审）作为徽标提醒
const pendingGateCount = computed(
  () => Object.values(tasks).filter((t) => ['waiting_approval', 'waiting_clarify', 'clarifying', 'planned'].includes(t.status)).length
);

// 群组沟通：有待拍板提问的讨论数作为徽标提醒
const discussAlertCount = computed(() => discList.value.filter((d) => d.pending_user).length);

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
    showApiError(e);
  }
}

async function onCancel(taskId: string) {
  try {
    await api.cancelTask(taskId);
    ElMessage.info('取消信号已发送');
  } catch (e: any) {
    showApiError(e);
  }
}

async function onDeleteTask(taskId: string) {
  try {
    await ElMessageBox.confirm(
      `确定删除任务 ${taskId}？任务图、交付成果与协作记录将一并清除，不可恢复。`,
      '删除确认',
      { type: 'warning', confirmButtonText: '删除', cancelButtonText: '取消' }
    );
  } catch {
    return; // 用户取消
  }
  try {
    await api.deleteTask(taskId);
    ElMessage.success('任务已删除');
    await loadTasks(taskPage.value, taskPageSize.value);
  } catch (e: any) {
    showApiError(e);
  }
}

function onTaskPageChange(page: number) {
  void loadTasks(page, taskPageSize.value);
}

function onTaskSearch(keyword: string) {
  // R4: keyword search rides along with the workbench's external-task scope
  void loadTasks(1, taskPageSize.value, { scope: 'external', q: keyword || undefined });
}

async function onReloadAgents() {
  try {
    await api.reloadAgents();
    ElMessage.success('Agent 已重载');
    loadAgents();
  } catch (e: any) {
    showApiError(e);
  }
}

async function onNotifyToggle(v: boolean) {
  const ok = await setNotifyEnabled(v);
  if (ok) ElMessage.success(v ? '桌面通知已开启' : '桌面通知已关闭');
}

let timer: number | undefined;
onMounted(() => {
  refreshStatus();
  void loadDiscussions();
  timer = window.setInterval(refreshStatus, 8000);
  window.addEventListener('coteam:unauthorized', onUnauthorized);
});
onUnmounted(() => {
  window.clearInterval(timer);
  window.removeEventListener('coteam:unauthorized', onUnauthorized);
});

// SEC-P0 Token 门禁：401 → 弹窗收 token → 保存后热重连 WS + 全量重拉
const tokenGateVisible = ref(false);
const tokenDraft = ref('');
function onUnauthorized() {
  if (!tokenGateVisible.value) {
    tokenDraft.value = '';
    tokenGateVisible.value = true;
    ElMessage.warning('API Token 缺失或已失效，请输入访问 Token');
  }
}
async function saveTokenGate() {
  const t = tokenDraft.value.trim();
  if (!t) return;
  setApiToken(t);
  tokenGateVisible.value = false;
  reconnectWs();
  await Promise.all([refreshStatus(), loadAgents(), loadTasks(taskPage.value, taskPageSize.value)]);
  ElMessage.success('Token 已保存，数据已重新加载');
}
</script>

<style>
/* ============================================================
   设计 token 见 styles/tokens.css（main.ts 全局引入，暗=橙/亮=蓝随 html.dark 切换）
   这里只做 Element Plus 全量映射与全局基础样式。
   ============================================================ */
/* flatten element-plus：全量映射到新 token（浅色变量用 color-mix 向面板底色调和，双主题通用） */
:root, html.dark {
  --el-bg-color: var(--bg-panel);
  --el-bg-color-overlay: var(--bg-raised);
  --el-bg-color-page: var(--bg-page);
  --el-fill-color: var(--bg-inset);
  --el-fill-color-light: var(--bg-inset);
  --el-fill-color-lighter: var(--bg-inset);
  --el-fill-color-extra-light: var(--bg-inset);
  --el-fill-color-dark: var(--bg-raised);
  --el-fill-color-darker: var(--line);
  --el-fill-color-blank: var(--bg-panel);
  --el-border-color: var(--line-strong);
  --el-border-color-light: var(--line);
  --el-border-color-lighter: var(--line);
  --el-border-color-extra-light: var(--line);
  --el-border-color-dark: var(--line-strong);
  --el-border-color-darker: var(--line-strong);
  --el-text-color-primary: var(--text-1);
  --el-text-color-regular: var(--text-2);
  --el-text-color-secondary: var(--text-3);
  --el-text-color-placeholder: var(--text-3);
  --el-text-color-disabled: var(--text-3);
  --el-color-primary: var(--accent);
  --el-color-primary-dark-2: color-mix(in srgb, var(--accent) 80%, #000);
  --el-color-primary-light-3: color-mix(in srgb, var(--accent) 70%, var(--bg-panel));
  --el-color-primary-light-5: color-mix(in srgb, var(--accent) 50%, var(--bg-panel));
  --el-color-primary-light-7: color-mix(in srgb, var(--accent) 30%, var(--bg-panel));
  --el-color-primary-light-8: color-mix(in srgb, var(--accent) 20%, var(--bg-panel));
  --el-color-primary-light-9: var(--accent-soft);
  --el-color-success: var(--ok);
  --el-color-success-dark-2: color-mix(in srgb, var(--ok) 80%, #000);
  --el-color-success-light-3: color-mix(in srgb, var(--ok) 70%, var(--bg-panel));
  --el-color-success-light-5: color-mix(in srgb, var(--ok) 50%, var(--bg-panel));
  --el-color-success-light-7: color-mix(in srgb, var(--ok) 30%, var(--bg-panel));
  --el-color-success-light-8: color-mix(in srgb, var(--ok) 20%, var(--bg-panel));
  --el-color-success-light-9: color-mix(in srgb, var(--ok) 12%, var(--bg-panel));
  --el-color-warning: var(--warn);
  --el-color-warning-dark-2: color-mix(in srgb, var(--warn) 80%, #000);
  --el-color-warning-light-3: color-mix(in srgb, var(--warn) 70%, var(--bg-panel));
  --el-color-warning-light-5: color-mix(in srgb, var(--warn) 50%, var(--bg-panel));
  --el-color-warning-light-7: color-mix(in srgb, var(--warn) 30%, var(--bg-panel));
  --el-color-warning-light-8: color-mix(in srgb, var(--warn) 20%, var(--bg-panel));
  --el-color-warning-light-9: color-mix(in srgb, var(--warn) 12%, var(--bg-panel));
  --el-color-danger: var(--danger);
  --el-color-error: var(--danger);
  --el-color-danger-dark-2: color-mix(in srgb, var(--danger) 80%, #000);
  --el-color-danger-light-3: color-mix(in srgb, var(--danger) 70%, var(--bg-panel));
  --el-color-danger-light-5: color-mix(in srgb, var(--danger) 50%, var(--bg-panel));
  --el-color-danger-light-7: color-mix(in srgb, var(--danger) 30%, var(--bg-panel));
  --el-color-danger-light-8: color-mix(in srgb, var(--danger) 20%, var(--bg-panel));
  --el-color-danger-light-9: color-mix(in srgb, var(--danger) 12%, var(--bg-panel));
  --el-border-radius-base: var(--r-ctl);
  --el-border-radius-small: 4px;
  --el-font-family: var(--font-ui);
  --el-font-size-base: 13px;
  --el-box-shadow: var(--shadow-float);
  --el-box-shadow-light: var(--shadow-float);
  --el-box-shadow-lighter: 0 4px 12px rgba(0, 0, 0, 0.18);
}
html, body { height: 100%; overflow: hidden; }
body { margin: 0; background: var(--bg-page); color: var(--text-1); font: var(--fs-body)/1.6 var(--font-ui); -webkit-font-smoothing: antialiased; }
::-webkit-scrollbar { width: 9px; height: 9px; }
::-webkit-scrollbar-thumb { background: var(--line-strong); border-radius: 5px; border: 2px solid transparent; background-clip: content-box; }
::-webkit-scrollbar-track { background: transparent; }
* { scrollbar-width: thin; scrollbar-color: var(--line-strong) transparent; }
.mono { font-family: var(--font-mono); }
.app-shell { height: 100vh; display: flex; flex-direction: column; overflow: hidden; }
/* 顶栏（44px）：品牌位 + 产品化 tab + 指标 pill */
.app-header {
  flex-shrink: 0; z-index: 50; height: 44px; padding: 0 16px;
  display: flex; align-items: center; justify-content: space-between; gap: 20px;
  background: var(--bg-panel); border-bottom: 1px solid var(--line);
}
.brand { display: flex; align-items: center; gap: 9px; min-width: 200px; }
.brand-mark {
  width: 22px; height: 22px; border-radius: var(--r-ctl); flex: none;
  background: var(--accent); color: var(--accent-text);
  display: grid; place-items: center; font-size: 11px; font-weight: 700;
}
.brand-text { display: flex; align-items: baseline; gap: 8px; }
.brand-name { font-size: var(--fs-body); font-weight: 700; letter-spacing: .01em; color: var(--text-1); }
.brand-sub { font-size: var(--fs-meta); color: var(--text-3); }
.nav { display: flex; gap: 2px; height: 100%; }
.nav-tab {
  position: relative; display: flex; align-items: center; gap: 7px; padding: 0 14px;
  font-family: var(--font-ui); font-size: 13.5px; color: var(--text-2);
  background: transparent; border: none; cursor: pointer;
  transition: color .15s;
}
.nav-tab.active { color: var(--text-1); }
.nav-tab.active::after {
  content: ""; position: absolute; left: 12px; right: 12px; bottom: -1px; height: 2px;
  background: var(--accent); border-radius: 2px 2px 0 0;
}
.nav-tab:hover { color: var(--text-1); }
.nav-badge {
  min-width: 16px; height: 16px; padding: 0 4px; border-radius: 8px;
  background: var(--accent); color: var(--accent-text);
  font-family: var(--font-mono); font-size: 11px; font-weight: 700;
  display: grid; place-items: center;
}
.btn-badge { display: inline-block; min-width: 16px; text-align: center; font-size: var(--fs-meta); color: var(--accent-text); background: var(--accent); border-radius: 8px; padding: 0 4px; margin-left: 4px; }
.header-right { margin-left: auto; display: flex; align-items: center; gap: 14px; }
.header-metrics { display: flex; gap: 14px; }
.metric-pill { display: flex; align-items: baseline; gap: 6px; color: var(--text-3); font-size: var(--fs-meta); }
.metric-pill b { color: var(--text-2); font-family: var(--font-mono); font-weight: 600; font-size: var(--fs-aux); }
.conn { display: inline-flex; align-items: center; gap: 6px; font-size: var(--fs-meta); color: var(--ok); }
.conn i { width: 6px; height: 6px; border-radius: 50%; background: var(--ok); }
.conn.off { color: var(--danger); }
.conn.off i { background: var(--danger); }
.side-toggle, .theme-toggle {
  width: 26px; height: 26px; display: grid; place-items: center;
  color: var(--text-3); background: transparent; border: 1px solid transparent; border-radius: var(--r-ctl);
  font-size: 13px; cursor: pointer; transition: color .15s, border-color .15s, background .15s;
}
.side-toggle:hover, .theme-toggle:hover { color: var(--text-1); background: var(--bg-raised); border-color: var(--line); }
/* 满宽工作区：main 自适应 + 右栏固定宽可折叠（替代 1fr/340px 栅格与 1180px 居中） */
.layout { flex: 1; min-height: 0; min-width: 0; display: flex; overflow: hidden; }
.layout .main { flex: 1; min-width: 0; overflow-y: auto; padding: 20px 24px; }
.layout .side {
  width: var(--side-w); flex: none; overflow-y: auto; padding: 16px;
  border-left: 1px solid var(--line); background: var(--bg-panel);
}
.layout.side-hidden .side { display: none; }
.layout.flush > .main { padding: 0; overflow: hidden; }
.page-toolbar { display: flex; align-items: center; gap: 12px; margin-bottom: 16px; }
.main-inner { max-width: 1560px; margin: 0 auto; }
.sec-h3 { font-size: var(--fs-title); font-weight: 700; color: var(--text-1); }
.sec-hint { font-size: var(--fs-meta); color: var(--text-3); }
.section-head { display: flex; align-items: baseline; gap: 6px; margin-bottom: 12px; }
.home-events { padding: 6px 10px; }
.page-title { font-size: var(--fs-sub); font-weight: 600; color: var(--text-1); }
.page-ops { margin-left: auto; display: flex; gap: 4px; }
.el-dialog__body { max-height: calc(88vh - 110px); overflow-y: auto; }
.section { margin-bottom: 24px; }
.section-title { font-family: var(--font-mono); font-size: var(--fs-meta); font-weight: 500; color: var(--text-3); text-transform: uppercase; letter-spacing: 0.6px; margin-bottom: 10px; }
.panel { background: var(--bg-panel); border: 1px solid var(--line); border-radius: var(--r-panel); padding: 14px; margin-bottom: 16px; }
.el-dialog {
  border: 1px solid var(--line-strong) !important; border-radius: var(--r-panel) !important;
  box-shadow: var(--shadow-float) !important;
}
.el-dialog__title { font-family: var(--font-mono); font-size: 13px !important; }
.gate-tip { font-size: var(--fs-aux); color: var(--text-2); line-height: 1.6; margin-bottom: 10px; }
.el-button { border-radius: var(--r-ctl) !important; font-weight: 400 !important; }
.el-table { --el-table-border-color: var(--line); --el-table-bg-color: var(--bg-panel); --el-table-tr-bg-color: var(--bg-panel); --el-table-header-bg-color: var(--bg-raised); }
/* 表格语言（预览稿）：th = 11px mono 大写字距；td 13px；行 hover 用 token */
.el-table th.el-table__cell > .cell {
  font-family: var(--font-mono); font-size: var(--fs-meta); font-weight: 600;
  letter-spacing: 0.06em; text-transform: uppercase; color: var(--text-3);
}
.el-table { font-size: 13px; }
.el-table--small { font-size: 13px; }
.el-table--enable-row-hover .el-table__body tr:hover > td.el-table__cell { background: color-mix(in srgb, var(--bg-raised) 70%, transparent); }
.el-tag { border-radius: 4px !important; font-family: var(--font-mono); }
/* ==== 预览稿：设置 overlay 形态 + EP 全局微调 ==== */
.settings-dialog { max-width: 92vw; border-radius: var(--r-float) !important; }
.el-overlay:has(.settings-dialog) { backdrop-filter: blur(2px); background: color-mix(in srgb, var(--bg-page) 72%, transparent); }
.el-tabs__item.is-active { font-weight: 600; }
.el-switch { --el-switch-on-color: var(--accent); }
.el-switch .el-switch__core { min-width: 34px; height: 19px; border-radius: 10px; }
.el-switch .el-switch__core .el-switch__action { width: 15px; height: 15px; }

/* ==== 企业级 Markdown 排版（.md 全局生效——交付阅读器/文档/聊天气泡） ==== */
.md { line-height: 1.65; }
.md h1, .md h2, .md h3, .md h4 {
  color: var(--text-1); font-weight: 700; line-height: 1.3;
  margin: 1.2em 0 0.5em; padding-bottom: 4px;
  border-bottom: 1px solid var(--line);
}
.md h1 { font-size: 1.35em; } .md h2 { font-size: 1.2em; } .md h3 { font-size: 1.08em; border-bottom: none; } .md h4 { font-size: 1em; border-bottom: none; }
.md > *:first-child { margin-top: 0; }
.md p { margin: 0.5em 0; }
.md code {
  font-family: var(--font-mono); font-size: 0.88em;
  background: var(--bg-inset); border: 1px solid var(--line);
  border-radius: 4px; padding: 1px 5px;
}
.md pre {
  background: var(--bg-inset); border: 1px solid var(--line);
  border-radius: var(--r-ctl); padding: 10px 12px; overflow-x: auto; margin: 0.6em 0;
}
.md pre code { background: none; border: none; padding: 0; font-size: var(--fs-aux); line-height: 1.5; }
.md table { border-collapse: collapse; margin: 0.6em 0; width: 100%; font-size: 0.92em; }
.md th, .md td { border: 1px solid var(--line); padding: 5px 9px; text-align: left; }
.md th { background: var(--bg-inset); font-weight: 600; }
.md tr:nth-child(even) td { background: var(--bg-inset); }
.md ul, .md ol { padding-left: 1.4em; margin: 0.5em 0; }
.md li { margin: 0.25em 0; }
.md blockquote { border-left: 3px solid var(--accent); margin: 0.6em 0; padding: 2px 12px; color: var(--text-2); background: var(--bg-inset); border-radius: 0 4px 4px 0; }
.md a { color: var(--accent); }
.md hr { border: none; border-top: 1px solid var(--line); margin: 1em 0; }
.md img { max-width: 100%; }
.md del, .md s { color: var(--text-3); }

/* 代码块工具条 + 表格横滚包裹（utils/md.ts 生成结构） */
.md-code { margin: 0.6em 0; border: 1px solid var(--line); border-radius: var(--r-ctl); overflow: hidden; }
.md-code-bar { display: flex; align-items: center; justify-content: space-between; padding: 3px 10px; background: var(--bg-inset); border-bottom: 1px solid var(--line); }
.md-code-lang { font-size: var(--fs-meta); color: var(--text-3); text-transform: uppercase; letter-spacing: 0.5px; }
.md-copy { border: none; background: transparent; color: var(--accent); font-size: var(--fs-meta); cursor: pointer; padding: 1px 4px; border-radius: 3px; }
.md-copy:hover { background: var(--bg-page); }
.md-code pre { margin: 0; padding: 10px 12px; overflow-x: auto; background: var(--bg-page); }
.md-code pre code { display: block; }
.md-twrap { overflow-x: auto; margin: 0.6em 0; }
.md-twrap table { margin: 0; }

/* highlight.js 令牌色：跟随双主题变量，不引第三方主题 CSS */
.md .hljs-keyword, .md .hljs-selector-tag, .md .hljs-built_in, .md .hljs-tag { color: var(--accent); }
.md .hljs-string, .md .hljs-attr, .md .hljs-template-variable, .md .hljs-addition { color: var(--ok); }
.md .hljs-comment, .md .hljs-quote, .md .hljs-deletion { color: var(--text-3); font-style: italic; }
.md .hljs-number, .md .hljs-literal, .md .hljs-symbol, .md .hljs-bullet { color: var(--warn); }
.md .hljs-title, .md .hljs-function, .md .hljs-name, .md .hljs-section { color: var(--ok); }
.md .hljs-variable, .md .hljs-attribute, .md .hljs-params { color: var(--text-1); }
.md .hljs-type, .md .hljs-class, .md .hljs-meta { color: var(--danger); }
</style>

