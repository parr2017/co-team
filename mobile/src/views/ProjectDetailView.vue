<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { showSuccessToast, showFailToast } from 'vant';
import { api, statusLabel } from '../api';
import type { TaskGraph } from '../api';
import { useDashboard } from '../composables/useDashboard';
import AgentAvatar from '../components/AgentAvatar.vue';
import StatusTag from '../components/StatusTag.vue';
import MdView from '../components/MdView.vue';

const route = useRoute();
const router = useRouter();
const { onEvent } = useDashboard();

const projectId = computed(() => String(route.params.id));
const projectTasks = ref<TaskGraph[]>([]);
const projectName = ref('');
const projectKnowledge = ref<{ id: string; title: string; source: string; tags: string[]; content: string; updated_at: string }[]>([]);
/** 知识条目按条独立展开（此前单一布尔控制所有条目，点一条全部开合） */
const expOpenSet = ref<Set<string>>(new Set());
function toggleExp(id: string) {
  const s = new Set(expOpenSet.value);
  if (s.has(id)) s.delete(id); else s.add(id);
  expOpenSet.value = s;
}
const loading = ref(true);
const error = ref('');
let unsub: (() => void) | undefined;
let timer: number | undefined;

async function load() {
  error.value = '';
  try {
    const d = await api.getProject(projectId.value);
    projectName.value = d.name;
    projectTasks.value = d.tasks || [];
    // P1.1 项目档案字段（ProjectRecord 扩展字段可选存在）
    project.value = d as unknown as Record<string, string>;
  } catch (e: any) {
    error.value = e.message || '加载失败';
  }
  try {
    const k = await api.listKnowledge({ category: 'project', project_id: projectId.value });
    projectKnowledge.value = k.entries || [];
  } catch {
    projectKnowledge.value = [];
  }
  loading.value = false;
}

// ---------- P1.1 项目档案（简报 + 结构化字段） ----------
const project = ref<Record<string, string> | null>(null);
const showBriefEdit = ref(false);
const briefSaving = ref(false);
const briefForm = ref<Record<string, string>>({ description: '', tech_stack: '', conventions: '', domain: '', stage: '', audience: '', brief: '' });
const briefGenerating = ref(false);
function openBriefEdit() {
  briefForm.value = {
    description: project.value?.description || '',
    tech_stack: project.value?.tech_stack || '',
    conventions: project.value?.conventions || '',
    domain: project.value?.domain || '',
    stage: project.value?.stage || '',
    audience: project.value?.audience || '',
    brief: project.value?.brief || '',
  };
  showBriefEdit.value = true;
}
async function saveBrief() {
  briefSaving.value = true;
  try {
    await api.updateProject(projectId.value, { ...briefForm.value });
    showSuccessToast('项目档案已保存');
    showBriefEdit.value = false;
    await load();
  } catch (e: any) {
    showFailToast(e.message || '保存失败');
  } finally {
    briefSaving.value = false;
  }
}
async function genBrief() {
  briefGenerating.value = true;
  try {
    const r = await api.generateProjectBrief(projectId.value);
    briefForm.value.brief = r.brief;
    showSuccessToast('简报初稿已生成，可编辑后保存');
  } catch (e: any) {
    showFailToast(e.message || '生成失败');
  } finally {
    briefGenerating.value = false;
  }
}

onMounted(() => {
  void load();
  unsub = onEvent((msg) => {
    // any event for one of this project's tasks refreshes the list
    if (msg.payload?.task_id && projectTasks.value.some(t => t.task_id === msg.payload.task_id)) {
      void load();
    }
  });
  timer = window.setInterval(() => {
    if (document.visibilityState === 'visible') void load();
  }, 8000);
});

onUnmounted(() => {
  window.clearInterval(timer);
  unsub?.();
});

const sorted = computed(() => [...projectTasks.value].sort((a, b) => (b.updated_at || '').localeCompare(a.updated_at || '')));

const stats = computed(() => {
  const total = projectTasks.value.length;
  const done = projectTasks.value.filter(t => t.status === 'success').length;
  const running = projectTasks.value.filter(t => ['running', 'retrying', 'waiting_approval', 'pending'].includes(t.status)).length;
  const failed = projectTasks.value.filter(t => t.status === 'failed').length;
  const waitingMe = projectTasks.value.filter(t => ['planned', 'clarifying'].includes(t.status) || t.nodes.some(n => n.status === 'waiting_approval')).length;
  return { total, done, running, failed, waitingMe, pct: total ? Math.round((done / total) * 100) : 0 };
});

function avatarAgent(t: TaskGraph): string {
  const working = t.nodes.find((n) => ['running', 'retrying', 'waiting_approval'].includes(n.status));
  if (working) return working.agent;
  return t.nodes.find((n) => n.agent !== 'orchestrator')?.agent || 'dev';
}

function sessionTime(ts?: string): string {
  if (!ts) return '';
  const d = new Date(ts);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  const yesterday = new Date(now); yesterday.setDate(now.getDate() - 1);
  if (d.toDateString() === yesterday.toDateString()) return '昨天';
  return `${d.getMonth() + 1}月${d.getDate()}日`;
}

function digest(t: TaskGraph): string {
  if (t.status === 'clarifying') return '[需求澄清] 等待你回复澄清问题';
  const n = t.nodes.length;
  const done = t.nodes.filter((x) => x.status === 'completed').length;
  const running = t.nodes.find((x) => ['running', 'retrying'].includes(x.status));
  if (running) return `[执行中] ${running.name} — ${running.agent}`;
  const approval = t.nodes.find((x) => x.status === 'waiting_approval');
  if (approval) return `[待审批] ${approval.name}`;
  if (t.status === 'success') return `[已完成] ${done}/${n} 节点全部通过`;
  if (t.status === 'failed') return `[失败] 有节点未通过`;
  if (t.status === 'planned') return `[计划待确认] 共 ${n} 个节点`;
  return `[${statusLabel(t.status)}] ${done}/${n} 节点`;
}

function openTask(t: TaskGraph) {
  if (t.status === 'clarifying') { router.push(`/clarify/${t.task_id}`); return; }
  if (t.status === 'planned') { router.push(`/plan/${t.task_id}`); return; }
  router.push(`/task/${t.task_id}`);
}

function goCreate() {
  router.push({ path: '/task/new', query: { project_id: projectId.value, project_name: projectName.value } });
}
</script>

<template>
  <div class="page">
    <van-nav-bar safe-area-inset-top :title="projectName || '项目'" left-arrow fixed placeholder @click-left="router.back()">
      <template #right>
        <span class="rep-link" @click="router.push('/project/' + projectId + '/report')">成果表</span>
        <van-icon name="plus" size="22" color="var(--green)" @click="goCreate" />
      </template>
    </van-nav-bar>

    <van-loading v-if="loading" class="loading" vertical>加载中…</van-loading>

    <div v-else-if="error" class="err-state">
      <van-icon name="warning-o" size="48" color="var(--yellow)" />
      <div class="err-text">{{ error }}</div>
      <button class="wx-btn err-btn" @click="load">重新加载</button>
    </div>

    <div v-else class="body">
      <!-- 项目进度统计头 -->
      <div class="wx-group stat-card">
        <div class="stat-row">
          <div class="stat-item">
            <div class="stat-num">{{ stats.total }}</div>
            <div class="stat-label">任务</div>
          </div>
          <div class="stat-item ok">
            <div class="stat-num">{{ stats.done }}</div>
            <div class="stat-label">完成</div>
          </div>
          <div class="stat-item run">
            <div class="stat-num">{{ stats.running }}</div>
            <div class="stat-label">执行中</div>
          </div>
          <div class="stat-item bad">
            <div class="stat-num">{{ stats.failed }}</div>
            <div class="stat-label">失败</div>
          </div>
        </div>
        <div class="stat-prog">
          <div class="sp-track"><div class="sp-fill" :style="{ width: stats.pct + '%' }"></div></div>
          <span class="sp-pct">{{ stats.pct }}%</span>
        </div>
        <div v-if="stats.waitingMe" class="stat-waiting">⚠ {{ stats.waitingMe }} 个任务需要你处理（审批/澄清/确认）</div>
      </div>

      <!-- P1.1 项目档案（简报 + 结构化字段，双端一致） -->
      <div class="wx-caption">项目档案</div>
      <div class="wx-group">
        <div class="brief-card" @click="openBriefEdit">
          <div class="brief-head">
            <span class="brief-lb">项目简报{{ project?.brief_updated_at ? ' · ' + (project.brief_updated_at || '').slice(5, 10) + ' 更新' : '' }}</span>
            <span class="brief-edit">编辑</span>
          </div>
          <div v-if="project?.brief" class="brief-body">{{ project.brief.slice(0, 160) }}{{ project.brief.length > 160 ? '…' : '' }}</div>
          <div v-else class="brief-body dim">未生成 — 点「编辑」用 AI 从项目材料生成，也可手填结构化字段</div>
          <div v-if="project?.tech_stack || project?.conventions || project?.domain" class="brief-fields">
            <span v-if="project?.tech_stack" class="exp-tag">{{ project.tech_stack }}</span>
            <span v-if="project?.domain" class="exp-tag">{{ project.domain }}</span>
            <span v-if="project?.stage" class="exp-tag">{{ project.stage }}</span>
          </div>
        </div>
      </div>

      <div class="wx-caption">项目任务</div>
      <div class="wx-group task-group">
        <div v-if="!sorted.length" class="t-empty">暂无任务，点右上角 + 下发</div>
          <div v-for="t in sorted" :key="t.task_id" class="session" @click="openTask(t)">
          <div class="s-avatar">
            <AgentAvatar :name="avatarAgent(t)" :size="44" />
          </div>
          <div class="s-body">
            <div class="s-line1">
              <span class="s-title">{{ t.description || t.task_id }}</span>
              <span class="s-time">{{ sessionTime(t.updated_at) }}</span>
            </div>
            <div class="s-line2">
              <span class="s-digest">{{ digest(t) }}</span>
              <StatusTag v-if="t.status" :status="t.status" :label="statusLabel(t.status)" />
            </div>
          </div>
        </div>
      </div>

      <div class="wx-caption">项目经验 · 知识库 ({{ projectKnowledge.length }})</div>
      <div class="wx-group exp-group">
        <div v-if="!projectKnowledge.length" class="t-empty">暂无条目 — 群组讨论经验与任务复盘会自动沉淀到这里</div>
        <div v-for="e in projectKnowledge" :key="e.id" class="exp-item" @click="toggleExp(e.id)">
          <div class="s-line1">
            <span class="exp-title">{{ e.title }}</span>
            <span class="s-time">{{ (e.updated_at || '').slice(5, 10) }}</span>
          </div>
          <div v-if="e.tags?.length" class="exp-tags"><span v-for="tg in e.tags.slice(0, 4)" :key="tg" class="exp-tag">{{ tg }}</span></div>
          <MdView v-if="expOpenSet.has(e.id)" class="exp-body" :source="e.content" />
        </div>
      </div>
    </div>

    <!-- P1.1 项目档案编辑（双端一致） -->
    <van-popup v-model:show="showBriefEdit" position="bottom" round :style="{ maxHeight: '85%' }">
      <div class="brief-editor">
        <div class="be-title">项目档案</div>
        <van-cell-group inset>
          <van-field v-model="briefForm.description" label="一句话" placeholder="这个项目是做什么的" />
          <van-field v-model="briefForm.tech_stack" label="技术栈" placeholder="如 Vue3 + TS" />
          <van-field v-model="briefForm.conventions" label="约定" placeholder="编码/协作约定" />
          <van-field v-model="briefForm.domain" label="领域" placeholder="业务域" />
          <van-field v-model="briefForm.stage" label="阶段" placeholder="原型/开发/维护" />
          <van-field v-model="briefForm.audience" label="受众" placeholder="目标用户" />
        </van-cell-group>
        <div class="be-bar">
          <van-button size="small" :loading="briefGenerating" @click="genBrief">AI 生成简报</van-button>
        </div>
        <van-field
          v-model="briefForm.brief"
          type="textarea"
          rows="6"
          autosize
          label="简报"
          label-align="top"
          placeholder="项目简报（AI 生成后可编辑；每次任务/会话/讨论前注入）"
        />
        <div class="be-bar save">
          <van-button size="small" type="primary" :loading="briefSaving" @click="saveBrief">保存档案</van-button>
        </div>
      </div>
    </van-popup>
  </div>
</template>

<style scoped>
.page { height: 100%; display: flex; flex-direction: column; background: var(--bg); }
.loading { margin: 60px auto; }

/* the scrollable content region: constrained + own scroller (fixed navbar takes the rest) */
.body {
  flex: 1; min-height: 0;
  overflow-y: auto;
  -webkit-overflow-scrolling: touch;
  padding-bottom: 16px;
}
/* fixed nav-bar renders over content; its translucent blur needs solid backing below */
.page :deep(.van-nav-bar__placeholder) { z-index: 10; }
.page :deep(.van-nav-bar--fixed) { z-index: 11; }

/* stat header: big-number hierarchy like WeChat pay cards */
.stat-card { padding: 18px 16px 16px; }

/* P1.1 项目档案卡 */
.brief-card { padding: 12px 14px; }
.brief-head { display: flex; justify-content: space-between; align-items: center; }
.brief-lb { font-size: var(--fs-aux); color: var(--text-2); font-weight: 600; }
.brief-edit { font-size: var(--fs-aux); color: var(--accent); }
.brief-body { font-size: var(--fs-aux); color: var(--text-3); margin-top: 5px; line-height: 1.5; }
.brief-body.dim { color: var(--text-3); opacity: 0.75; }
.brief-fields { display: flex; flex-wrap: wrap; gap: 5px; margin-top: 7px; }
.brief-editor { padding: 14px 0 20px; max-height: 80vh; overflow-y: auto; }
.be-title { font-size: 15px; font-weight: 600; text-align: center; padding: 4px 0 10px; }
.be-bar { padding: 10px 16px 4px; display: flex; gap: 8px; }
.be-bar.save { justify-content: flex-end; padding-bottom: 12px; }
.stat-row { display: flex; gap: 8px; margin-bottom: 14px; }
.stat-item { flex: 1; text-align: center; }
.stat-num { font-size: 26px; font-weight: 700; color: var(--text); line-height: 1.1; font-variant-numeric: tabular-nums; }
.stat-label { font-size: var(--fs-aux); color: var(--text-3); margin-top: 3px; }
.stat-prog { display: flex; align-items: center; gap: 10px; }
.sp-track { flex: 1; height: 6px; border-radius: 3px; background: var(--panel-2); overflow: hidden; }
.sp-fill { height: 100%; border-radius: 3px; background: var(--accent); transition: width 0.4s ease; }
.sp-pct { font-size: 13px; font-weight: 600; color: var(--text-2); width: 38px; text-align: right; font-variant-numeric: tabular-nums; }
.stat-waiting {
  font-size: 13px; color: var(--wx-orange); margin-top: 12px;
  background: color-mix(in srgb, var(--warn) 9%, transparent); border: 1px solid color-mix(in srgb, var(--warn) 25%, transparent); border-radius: 8px; padding: 7px 10px;
}

/* project task rows: same session-list rhythm */
.task-group { padding: 0; }
.t-empty { padding: 28px; text-align: center; font-size: 14px; color: var(--text-3); }

.session { display: flex; gap: 13px; padding: 13px 16px; align-items: center; position: relative; transition: background 0.12s ease; }
.session + .session::before {
  content: ''; position: absolute; left: 73px; right: 0; top: 0;
  height: 1px; background: var(--border); transform: scaleY(0.5);
}
.session:active { background: var(--panel-2); }
.s-avatar { flex-shrink: 0; }
.s-body { flex: 1; min-width: 0; }
.s-line1 { display: flex; justify-content: space-between; gap: 10px; align-items: center; }
.s-title { font-size: 16px; color: var(--text); font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.s-time { font-size: var(--fs-aux); color: var(--text-3); flex-shrink: 0; }
.s-line2 { display: flex; justify-content: space-between; gap: 10px; align-items: center; margin-top: 4px; }
.s-digest { font-size: 13.5px; color: var(--text-2); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; min-width: 0; }
.s-tag { font-size: var(--fs-meta); font-weight: 500; border-radius: 5px; padding: 2px 7px; flex-shrink: 0; }
.s-tag.run { color: var(--yellow); background: color-mix(in srgb, var(--warn) 10%, transparent); border: 1px solid color-mix(in srgb, var(--warn) 30%, transparent); }
.s-tag.wait { color: var(--accent); background: var(--accent-soft); border: 1px solid var(--accent-line); }

.err-state { display: flex; flex-direction: column; align-items: center; gap: 8px; padding: 72px 0; }
.err-text { font-size: 14px; color: var(--text-2); }
.err-btn { margin-top: 12px; max-width: 180px; }

/* 项目经验（知识库条目） */
.exp-group { padding: 0 16px; }
.exp-item { padding: 12px 0; border-bottom: 1px solid var(--border); }
.exp-item:last-child { border-bottom: none; }
.exp-title { font-size: 15px; color: var(--text); font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.exp-tags { display: flex; gap: 5px; margin-top: 4px; flex-wrap: wrap; }
.exp-tag { font-size: var(--fs-meta); color: var(--accent); background: var(--accent-soft); border: 1px solid var(--accent-line); border-radius: 4px; padding: 0 5px; }
.exp-body { margin-top: 6px; font-size: 13px; color: var(--text-2); line-height: 1.6; }
</style>
