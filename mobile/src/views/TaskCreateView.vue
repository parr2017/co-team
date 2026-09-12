<script setup lang="ts">
import { computed, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { showFailToast, showToast } from 'vant';
import { api } from '../api';
import type { ProjectSummary } from '../api';
import DirPicker from '../components/DirPicker.vue';

const router = useRouter();
const route = useRoute();

const description = ref('');
const workspace = ref('');
const level = ref('standard');
const mainModel = ref('');
const models = ref<{ name: string }[]>([]);
const submitting = ref(false);
const simpleMode = ref(false);
const allowSelfRef = ref(false);

// project binding (task can be dispatched into a project)
const projects = ref<ProjectSummary[]>([]);
const projectId = ref('');
const projectName = ref('');

// preset from query (?project_id=xxx&project_name=xxx — the project page's + entry)
if (route.query.project_id) {
  projectId.value = String(route.query.project_id);
  projectName.value = String(route.query.project_name || '');
}

const projectsReady = ref(false);
const projectsFailed = ref(false);
let projectsRetries = 0;
async function loadProjects() {
  try {
    const d = await api.listProjects();
    projects.value = d.projects || [];
    projectsReady.value = true;
    projectsFailed.value = false;
    if (projectId.value) {
      const p = projects.value.find(x => x.id === projectId.value);
      if (p) {
        projectName.value = p.name;
        if (p.workspace && !workspace.value) workspace.value = p.workspace;
      }
    }
  } catch {
    // slow mobile network: retry a few times, then let the cell offer a manual retry
    if (projectsRetries < 3) {
      projectsRetries += 1;
      setTimeout(() => { void loadProjects(); }, 2000);
    } else {
      projectsReady.value = true;
      projectsFailed.value = true;
    }
  }
}
function retryProjects() {
  if (projectsRetries >= 3) { projectsRetries = 0; }
  void loadProjects();
}
void loadProjects();

/** choosing a project fills the workspace automatically (its workspace dir) */
function onProjectChosen(id: string) {
  projectId.value = id === 'none' ? '' : id;
  const p = projects.value.find(x => x.id === projectId.value);
  if (p) {
    projectName.value = p.name;
    if (p.workspace) workspace.value = p.workspace;
  } else {
    projectName.value = '';
  }
}

// directory picker state
const showPicker = ref(false);
const showModelPicker = ref(false);
const showProjectPicker = ref(false);

// Vant 4 picker options must be { text, value } objects — the Vant 3 `[{ values: [...] }]`
// shape renders a single blank row (the "agent dropdown is blank" bug)
const projectColumns = computed(() => [
  { text: '不关联项目', value: 'none' },
  ...projects.value.map(p => ({ text: p.name, value: p.id })),
]);

function onProjectConfirm({ selectedOptions }: { selectedOptions: { text: string; value: string }[] }) {
  const opt = selectedOptions?.[0];
  if (opt) onProjectChosen(opt.value || 'none');
  showProjectPicker.value = false;
}

const modelsReady = ref(false);
const modelsFailed = ref(false);
let modelsRetries = 0;
async function loadModels() {
  try {
    const d = await api.getModelPool();
    models.value = d.model_pool || [];
    modelsReady.value = true;
    modelsFailed.value = false;
  } catch {
    if (modelsRetries < 3) {
      modelsRetries += 1;
      setTimeout(() => { void loadModels(); }, 2000);
    } else {
      modelsReady.value = true;
      modelsFailed.value = true;
    }
  }
}
function retryModels() {
  if (modelsRetries >= 3) { modelsRetries = 0; }
  void loadModels();
}
void loadModels();

function onModelConfirm({ selectedOptions }: { selectedOptions: { text: string; value: string }[] }) {
  const opt = selectedOptions?.[0];
  mainModel.value = opt && opt.value ? opt.value : '';
  showModelPicker.value = false;
}

const LEVELS = [
  { value: 'light', label: '轻量', hint: '改注释/小配置级' },
  { value: 'standard', label: '标准', hint: '常规功能开发' },
  { value: 'heavy', label: '重量', hint: '多租户/国际化级' },
];

async function submit() {
  if (!description.value.trim()) { showFailToast('请填写任务描述'); return; }
  if (!workspace.value) { showFailToast('请选择工作区目录'); return; }
  submitting.value = true;
  try {
    // plan_async: the server replies immediately and assesses/plans in the background —
    // phones abort HTTP requests around 60s, which used to kill slow LLM turns
    const r = await api.createTask({
      description: description.value.trim(),
      workspace: workspace.value,
      level: simpleMode.value ? 'standard' : level.value,
      main_model_id: mainModel.value || undefined,
      project_id: projectId.value || undefined,
      profile: simpleMode.value ? 'simple' : undefined,
      allow_self_ref: allowSelfRef.value || undefined,
    });
    if (r.status === 'needs_clarification') {
      showToast('需求需澄清');
      router.replace(`/clarify/${r.task_id}`);
    } else if (r.status === 'pending') {
      showToast(simpleMode.value ? '简单模式：任务已自动开始执行' : '任务已提交，团队评估需求中…');
      router.replace(`/task/${r.task_id}`);
    } else {
      showToast('计划已生成，待确认');
      router.replace(`/plan/${r.task_id}`);
    }
  } catch (e: any) {
    showFailToast(e.message || '创建失败');
  } finally {
    submitting.value = false;
  }
}
</script>

<template>
  <div class="page">
    <van-nav-bar title="发起任务" left-arrow fixed placeholder @click-left="router.back()" />

    <div class="form">
      <!-- 任务描述：微信大输入区 -->
      <div class="wx-caption">任务描述</div>
      <div class="wx-group desc-group">
        <van-field
          v-model="description"
          type="textarea"
          rows="4"
          autosize
          :border="false"
          placeholder="描述要完成的需求（越清晰，澄清越少）…"
          class="desc-input"
        />
      </div>

      <!-- 项目/目录/模型：微信设置 cell -->
      <div class="wx-caption">任务归属</div>
      <div class="wx-group">
        <div class="wx-cell link" @click="projectsReady ? (showProjectPicker = true) : (projectsFailed && retryProjects())">
          <van-icon name="apps-o" size="20" color="var(--green)" />
          <span class="cell-label">所属项目</span>
          <span class="cell-value">{{ projectsFailed ? '加载失败 · 点击重试' : projectsReady ? (projectName || '不关联项目') : '加载中…' }}</span>
          <van-icon v-if="projectsReady && !projectsFailed" name="arrow" size="14" color="#b2b2b2" />
          <van-loading v-else size="14" />
        </div>
        <div class="wx-cell link" @click="showPicker = true">
          <van-icon name="folder-o" size="20" color="var(--green)" />
          <span class="cell-label">工作区目录</span>
          <span class="cell-value">{{ workspace || (projectId ? '跟随项目' : '点击选择') }}</span>
          <van-icon name="arrow" size="14" color="#b2b2b2" />
        </div>
        <div class="wx-cell link" @click="modelsReady ? (showModelPicker = true) : (modelsFailed && retryModels())">
          <van-icon name="medal-o" size="20" color="#10aeff" />
          <span class="cell-label">主 Agent 模型</span>
          <span class="cell-value">{{ modelsFailed ? '加载失败 · 点击重试' : modelsReady ? (mainModel || '自动选择') : '加载中…' }}</span>
          <van-icon v-if="modelsReady && !modelsFailed" name="arrow" size="14" color="#b2b2b2" />
          <van-loading v-else size="14" />
        </div>
      </div>

      <!-- A4 模式档位：简单模式一键直跑 -->
      <div class="wx-caption">执行模式</div>
      <div class="wx-group">
        <div class="wx-cell link" @click="simpleMode = !simpleMode">
          <span class="cell-label">简单模式</span>
          <span class="cell-value">{{ simpleMode ? '自动澄清·自动执行·白名单放行' : '点击开启，提交后直接开跑' }}</span>
          <van-icon v-if="simpleMode" name="success" size="18" color="var(--green)" />
        </div>
      </div>

      <!-- 分级：微信单选 cell 组 -->
      <div v-if="!simpleMode" class="wx-caption">任务分级</div>
      <div v-if="!simpleMode" class="wx-group">
        <div
          v-for="l in LEVELS"
          :key="l.value"
          class="wx-cell link"
          @click="level = l.value"
        >
          <span class="cell-label">{{ l.label }}</span>
          <span class="cell-value">{{ l.hint }}</span>
          <van-icon v-if="level === l.value" name="success" size="18" color="var(--green)" />
        </div>
      </div>

      <!-- 自指任务（工作区在 co-team 内时必开） -->
      <div v-if="!simpleMode" class="wx-caption">高级</div>
      <div v-if="!simpleMode" class="wx-group">
        <div class="wx-cell link" @click="allowSelfRef = !allowSelfRef">
          <span class="cell-label">自指任务</span>
          <span class="cell-value">co-team 开发 co-team：隔离克隆执行，不碰主副本</span>
          <van-icon v-if="allowSelfRef" name="success" size="18" color="var(--green)" />
        </div>
      </div>

      <div class="submit">
        <button class="wx-btn" :disabled="submitting" @click="submit">{{ submitting ? '提交中…' : '提交任务' }}</button>
      </div>
    </div>

    <!-- 项目选择（Vant 4：选项必须是 { text, value } 对象） -->
    <van-popup v-model:show="showProjectPicker" position="bottom" round>
      <van-picker
        title="所属项目"
        :columns="projectColumns"
        @confirm="onProjectConfirm"
        @cancel="showProjectPicker = false"
      />
    </van-popup>

    <!-- 模型选择 -->
    <van-popup v-model:show="showModelPicker" position="bottom" round>
      <van-picker
        title="主 Agent 模型"
        :columns="[{ text: '自动选择', value: '' }, ...models.map((m) => ({ text: m.name, value: m.name }))]"
        @confirm="onModelConfirm"
        @cancel="showModelPicker = false"
      />
    </van-popup>

    <!-- 目录级联选择：共享组件 -->
    <DirPicker v-model:show="showPicker" @pick="workspace = $event" />
  </div>
</template>

<style scoped>
.page { height: 100%; overflow-y: auto; -webkit-overflow-scrolling: touch; background: var(--bg); }
.form { padding-bottom: 30px; }

.desc-group { padding: 0; }
.desc-input { padding: 12px 14px; background: transparent; }
.desc-input :deep(.van-field__control) { font-size: 16px; line-height: 1.6; }

.cell-label { font-size: 16px; color: var(--text); flex: 1; min-width: 0; }
.cell-value {
  font-size: 14px; color: var(--text-2);
  max-width: 45%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.wx-cell.link:active { background: var(--panel-2); }
.wx-cell.chosen { background: var(--panel-2); }

.submit { margin: 28px 16px 0; }
</style>
