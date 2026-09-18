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
const models = ref<{ id: string; name: string }[]>([]);
const submitting = ref(false);
const simpleMode = ref(false);
const allowSelfRef = ref(false);

// 白名单命令（o3xmkraj 复盘补齐移动端入口）：逗号/空格分隔，留空跟随全局设置
const whitelistText = ref('');
const whitelistInput = ref('');
const showWhitelistPicker = ref(false);
const COMMON_COMMANDS = ['python', 'pip', 'git', 'npm', 'node', 'flutter', 'dart', 'cargo', 'go', 'java'];
const whitelistList = computed(() => whitelistText.value.split(/[,，\s]+/).map((s) => s.trim()).filter(Boolean));
function openWhitelistPicker() {
  whitelistInput.value = whitelistText.value;
  showWhitelistPicker.value = true;
}
function toggleCommon(cmd: string) {
  const list = whitelistInput.value.split(/[,，\s]+/).map((s) => s.trim()).filter(Boolean);
  const idx = list.indexOf(cmd);
  if (idx >= 0) list.splice(idx, 1); else list.push(cmd);
  whitelistInput.value = list.join(' ');
}
function confirmWhitelist() {
  whitelistText.value = whitelistInput.value.split(/[,，\s]+/).map((s) => s.trim()).filter(Boolean).join(' ');
  showWhitelistPicker.value = false;
}

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
      execution_policy: whitelistList.value.length ? { whitelist_commands: whitelistList.value } : undefined,
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
    <van-nav-bar safe-area-inset-top title="发起任务" left-arrow fixed placeholder @click-left="router.back()" />

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
          <span class="cell-label">所属项目</span>
          <span class="cell-value">{{ projectsFailed ? '加载失败 · 点击重试' : projectsReady ? (projectName || '不关联项目') : '加载中…' }}</span>
          <van-icon v-if="projectsReady && !projectsFailed" name="arrow" size="14" color="var(--text-3)" />
          <van-loading v-else size="14" />
        </div>
        <div class="wx-cell link" @click="showPicker = true">
          <span class="cell-label">工作区目录</span>
          <span class="cell-value">{{ workspace || (projectId ? '跟随项目' : '点击选择') }}</span>
          <van-icon name="arrow" size="14" color="var(--text-3)" />
        </div>
        <div class="wx-cell link" @click="modelsReady ? (showModelPicker = true) : (modelsFailed && retryModels())">
          <span class="cell-label">主 Agent 模型</span>
          <span class="cell-value">{{ modelsFailed ? '加载失败 · 点击重试' : modelsReady ? (mainModel || '自动选择') : '加载中…' }}</span>
          <van-icon v-if="modelsReady && !modelsFailed" name="arrow" size="14" color="var(--text-3)" />
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
      <div v-if="!simpleMode" class="level-seg">
        <button v-for="l in LEVELS" :key="l.value" class="lv-btn" :class="{ on: level === l.value }" @click="level = l.value">{{ l.label }}</button>
      </div>
      <div v-if="!simpleMode" class="lv-hint">{{ LEVELS.find((l) => l.value === level)?.hint || '' }}</div>

      <!-- 白名单命令（高级模式）：按任务技术栈放行命令首词 -->
      <div v-if="!simpleMode" class="wx-group">
        <div class="wx-cell link" @click="openWhitelistPicker">
          <span class="cell-label">白名单命令</span>
          <span class="cell-value">{{ whitelistList.length ? whitelistList.join(' ') : '留空跟随全局设置' }}</span>
          <van-icon name="arrow" size="14" color="var(--text-3)" />
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
        :columns="[{ text: '自动选择', value: '' }, ...models.map((m) => ({ text: m.name, value: m.id }))]"
        @confirm="onModelConfirm"
        @cancel="showModelPicker = false"
      />
    </van-popup>

    <!-- 白名单命令编辑 -->
    <van-popup v-model:show="showWhitelistPicker" position="bottom" round>
      <div style="padding: 16px">
        <div style="font-weight: 600; margin-bottom: 8px">白名单命令</div>
        <van-field v-model="whitelistInput" placeholder="输入命令首词，空格/逗号分隔" clearable />
        <div style="display: flex; flex-wrap: wrap; gap: 8px; margin: 12px 0">
          <span
            v-for="c in COMMON_COMMANDS"
            :key="c"
            class="wl-chip"
            :class="{ on: whitelistInput.split(/[,，\s]+/).includes(c) }"
            @click="toggleCommon(c)"
          >{{ c }}</span>
        </div>
        <button class="wx-btn" @click="confirmWhitelist">确定</button>
      </div>
    </van-popup>

    <!-- 目录级联选择：共享组件 -->
    <DirPicker v-model:show="showPicker" @pick="workspace = $event" />
  </div>
</template>

<style scoped>
.page { height: 100%; overflow-y: auto; -webkit-overflow-scrolling: touch; background: var(--bg); }
.form { padding-bottom: calc(30px + env(safe-area-inset-bottom)); }

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

.wl-chip {
  padding: 4px 12px; border-radius: 14px; font-size: 13px;
  background: var(--panel-2); color: var(--text-2);
  border: 1px solid transparent;
}
.wl-chip.on { background: color-mix(in srgb, var(--ok) 12%, transparent); color: var(--ok); border-color: var(--ok); }

/* 预览稿档级分段（40px rbtn） */
.level-seg { display: flex; gap: 8px; margin: 0 12px 8px; }
.lv-btn { flex: 1; height: 40px; border: 1px solid var(--line-strong); border-radius: var(--r-ctl); background: var(--bg-raised); font-size: 13px; color: var(--text-2); }
.lv-btn.on { border-color: var(--accent-line); background: var(--accent-soft); color: var(--accent); font-weight: 600; }
.lv-hint { margin: 0 12px 12px; font-size: var(--fs-meta); color: var(--text-3); }
</style>
