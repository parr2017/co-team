<script setup lang="ts">
import { computed, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { showFailToast, showToast } from 'vant';
import { api } from '../api';
import type { FsListing, ProjectSummary } from '../api';

const router = useRouter();
const route = useRoute();

const description = ref('');
const workspace = ref('');
const level = ref('standard');
const mainModel = ref('');
const models = ref<{ name: string }[]>([]);
const submitting = ref(false);

// project binding (task can be dispatched into a project)
const projects = ref<ProjectSummary[]>([]);
const projectId = ref('');
const projectName = ref('');

// preset from query (?project_id=xxx&project_name=xxx — the project page's + entry)
if (route.query.project_id) {
  projectId.value = String(route.query.project_id);
  projectName.value = String(route.query.project_name || '');
}

void api.listProjects().then((d) => {
  projects.value = d.projects || [];
  // resolve the name + workspace once projects load if a preset exists
  if (projectId.value) {
    const p = projects.value.find(x => x.id === projectId.value);
    if (p) {
      projectName.value = p.name;
      if (p.workspace && !workspace.value) workspace.value = p.workspace;
    }
  }
}).catch(() => { /* ignore */ });

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
const fsLoading = ref(false);
const fsPath = ref('');
const fsParent = ref<string | null>(null);
const fsDirs = ref<FsListing['dirs']>([]);
const fsShortcuts = ref<FsListing['shortcuts']>([]);
const breadcrumbs = ref<string[]>([]);

const projectColumns = computed(() => [
  { values: ['不关联项目', ...projects.value.map(p => p.name)] },
]);

void api.getModelPool().then((d) => {
  models.value = d.model_pool || [];
}).catch(() => { /* ignore */ });

async function openPicker() {
  showPicker.value = true;
  await loadFs('');
}

async function loadFs(p: string, crumb?: string) {
  fsLoading.value = true;
  try {
    const d = await api.fsList(p);
    fsPath.value = d.path;
    fsParent.value = d.parent;
    fsDirs.value = d.dirs;
    fsShortcuts.value = d.shortcuts || [];
    if (crumb) breadcrumbs.value.push(crumb);
  } catch (e: any) {
    showFailToast(e.message || '读取目录失败');
  } finally {
    fsLoading.value = false;
  }
}

function enterDir(dir: { name: string; path: string }) {
  void loadFs(dir.path, dir.name);
}

function goUp() {
  const crumbs = breadcrumbs.value;
  crumbs.pop();
  void loadFs(fsParent.value || '');
}

function chooseCurrent() {
  if (!fsPath.value) {
    showFailToast('请先进入一个具体目录');
    return;
  }
  workspace.value = fsPath.value;
  showPicker.value = false;
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
    const r = await api.createTask({
      description: description.value.trim(),
      workspace: workspace.value,
      level: level.value,
      main_model_id: mainModel.value || undefined,
      project_id: projectId.value || undefined,
    });
    if (r.status === 'needs_clarification') {
      showToast('需求需澄清');
      router.replace(`/clarify/${r.task_id}`);
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
        <div class="wx-cell link" @click="showProjectPicker = true">
          <van-icon name="apps-o" size="20" color="#07c160" />
          <span class="cell-label">所属项目</span>
          <span class="cell-value">{{ projectName || '不关联项目' }}</span>
          <van-icon name="arrow" size="14" color="#b2b2b2" />
        </div>
        <div class="wx-cell link" @click="openPicker">
          <van-icon name="folder-o" size="20" color="#07c160" />
          <span class="cell-label">工作区目录</span>
          <span class="cell-value">{{ workspace || (projectId ? '跟随项目' : '点击选择') }}</span>
          <van-icon name="arrow" size="14" color="#b2b2b2" />
        </div>
        <div class="wx-cell link" @click="showModelPicker = true">
          <van-icon name="medal-o" size="20" color="#10aeff" />
          <span class="cell-label">主 Agent 模型</span>
          <span class="cell-value">{{ mainModel || '自动选择' }}</span>
          <van-icon name="arrow" size="14" color="#b2b2b2" />
        </div>
      </div>

      <!-- 分级：微信单选 cell 组 -->
      <div class="wx-caption">任务分级</div>
      <div class="wx-group">
        <div
          v-for="l in LEVELS"
          :key="l.value"
          class="wx-cell link"
          @click="level = l.value"
        >
          <span class="cell-label">{{ l.label }}</span>
          <span class="cell-value">{{ l.hint }}</span>
          <van-icon v-if="level === l.value" name="success" size="18" color="#07c160" />
        </div>
      </div>

      <div class="submit">
        <button class="wx-btn" :disabled="submitting" @click="submit">{{ submitting ? '提交中…' : '提交任务' }}</button>
      </div>
    </div>

    <!-- 项目选择 -->
    <van-popup v-model:show="showProjectPicker" position="bottom" round>
      <van-picker
        title="所属项目"
        :columns="projectColumns"
        @confirm="(v: any) => { const name = v[0]; onProjectChosen(name === '不关联项目' ? 'none' : (projects.find(p => p.name === name)?.id || '')); showProjectPicker = false; }"
        @cancel="showProjectPicker = false"
      />
    </van-popup>

    <!-- 模型选择 -->
    <van-popup v-model:show="showModelPicker" position="bottom" round>
      <van-picker
        title="主 Agent 模型"
        :columns="[{ values: ['自动选择', ...models.map((m) => m.name)] }]"
        @confirm="(v: any) => { mainModel = v[0] === '自动选择' ? '' : v[0]; showModelPicker = false; }"
        @cancel="showModelPicker = false"
      />
    </van-popup>

    <!-- 目录级联选择：微信分组列表 -->
    <van-popup v-model:show="showPicker" position="bottom" :style="{ height: '70%' }" round>
      <div class="fs-picker">
        <div class="fs-head">
          <span class="fs-title">选择目录</span>
          <span class="fs-use" @click="chooseCurrent">使用当前目录</span>
        </div>
        <div v-if="fsPath" class="fs-path">{{ fsPath }}</div>
        <div v-if="fsParent" class="wx-cell link fs-up" @click="goUp">
          <van-icon name="arrow-up" size="16" color="#07c160" />
          <span class="cell-label">返回上级</span>
        </div>
        <van-loading v-if="fsLoading" class="fs-loading" />
        <div v-else class="fs-list">
          <div class="wx-group fs-inline-group">
            <div v-for="s in fsShortcuts" :key="s.path" class="wx-cell link" @click="loadFs(s.path)">
              <van-icon name="star-o" size="18" color="#fa9d3b" />
              <span class="cell-label">{{ s.name }}</span>
            </div>
            <div
              v-for="d in fsDirs"
              :key="d.path"
              class="wx-cell link"
              :class="{ chosen: d.path === fsPath }"
              @click="enterDir(d)"
            >
              <van-icon name="folder-o" size="18" color="#07c160" />
              <span class="cell-label">{{ d.name }}</span>
              <van-icon v-if="d.path === fsPath" name="success" size="16" color="#07c160" />
            </div>
          </div>
          <div v-if="!fsDirs.length && !fsShortcuts.length" class="fs-empty">无子目录</div>
        </div>
      </div>
    </van-popup>
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

/* fs picker */
.fs-picker { height: 100%; display: flex; flex-direction: column; padding: 14px 0 0; background: var(--bg); }
.fs-head { display: flex; justify-content: space-between; align-items: center; padding: 0 16px 10px; }
.fs-title { font-size: 17px; font-weight: 600; color: var(--text); }
.fs-use { font-size: 15px; color: var(--accent); }
.fs-path { font-size: 12px; color: var(--wx-blue); padding: 0 16px 8px; word-break: break-all; }
.fs-up { margin: 0 12px; }
.fs-loading { margin: 20px auto; }
.fs-list { flex: 1; overflow-y: auto; -webkit-overflow-scrolling: touch; padding-bottom: 14px; }
.fs-inline-group { margin: 0 12px; }
.fs-empty { text-align: center; color: var(--text-3); padding: 30px 0; }
</style>
