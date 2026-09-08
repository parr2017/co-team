<template>
  <div class="project-view">
    <!-- 项目列表 -->
    <div v-if="!current" class="list-pane">
      <div class="section-head">
        <div class="section-title">项目 / Projects</div>
        <el-button size="small" type="primary" @click="openCreateDialog">+ 新建项目</el-button>
      </div>
      <div v-if="!projects.length" class="empty mono">还没有项目 — 新建一个，agent 会记住这里的一切</div>
      <div v-for="p in projects" :key="p.id" class="project-card" @click="openProject(p.id)">
        <div class="pc-main">
          <div class="pc-name">{{ p.name }}</div>
          <div class="pc-ws mono">{{ p.workspace }}</div>
        </div>
        <div class="pc-stats mono">
          <span class="pc-progress">{{ p.done_count }}/{{ p.task_count }} 任务</span>
          <span v-if="p.issues" class="pc-issues">{{ p.issues }} 问题记录</span>
          <span v-if="p.running" class="pc-running">● 开发中</span>
        </div>
        <div class="pc-bar"><div class="pc-fill" :style="{ width: pct(p) + '%' }"></div></div>
      </div>

      <!-- 新建项目 -->
      <el-dialog v-model="createVisible" title="新建项目" width="560px">
        <el-form label-width="90px" size="small">
          <el-form-item label="项目名"><el-input v-model="form.name" placeholder="如 客户管理系统" @input="prefillWorkspace" /></el-form-item>
          <el-form-item label="工作区">
            <el-input v-model="form.workspace" placeholder="留空 = 项目根目录下自动建独立目录" style="width: 100%" @input="onWorkspaceInput">
              <template #append>
                <el-button @click="dirPickerVisible = true">选择目录</el-button>
              </template>
            </el-input>
            <div class="ws-hint mono" v-if="projectsRootPath">项目根目录：{{ projectsRootPath }} —— 独立目录 + 独立 git 仓库，任务操作仅限该目录</div>
            <div class="ws-warn mono" v-if="workspaceInsideCoteam && !form.allow_self_ref">⚠ 该路径在 co-team 仓库内——请改用项目根目录，或勾选下方自指任务（隔离克隆执行）</div>
          </el-form-item>
          <el-form-item label="描述"><el-input v-model="form.description" placeholder="一句话描述（可选）" /></el-form-item>
          <el-form-item label="初始化">
            <el-checkbox v-model="form.scaffold">生成标准脚手架（docs/src/tests/config 目录 + README/CONTRIBUTING/ARCHITECTURE 文档 + git 初始化）</el-checkbox>
          </el-form-item>
          <el-form-item label="自指任务">
            <el-checkbox v-model="form.allow_self_ref">允许工作区位于 co-team 内（用 co-team 开发 co-team：任务在隔离克隆中执行，不碰主副本）</el-checkbox>
          </el-form-item>
        </el-form>
        <template #footer>
          <el-button size="small" @click="createVisible = false">取消</el-button>
          <el-button size="small" type="primary" :loading="creating" @click="create">创建</el-button>
        </template>
        <DirPickerDialog v-model:show="dirPickerVisible" :start-path="form.workspace" title="选择工作区目录" @pick="form.workspace = $event" />
      </el-dialog>
    </div>

    <!-- 项目工作台（OfficeView） -->
    <div v-else class="detail-pane">
      <OfficeView
        :project-id="current"
        @back="current = null; loadProjects()"
        @open-detail="(id: string) => $emit('open-detail', id)"
        @review="(id: string) => $emit('review', id)"
      />
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { ElMessage } from 'element-plus';
import { api, type ProjectSummary } from '../api';
import OfficeView from './OfficeView.vue';
import DirPickerDialog from './DirPickerDialog.vue';

const emit = defineEmits<{ (e: 'open-detail', taskId: string): void; (e: 'review', taskId: string): void }>();

const projects = ref<ProjectSummary[]>([]);
const current = ref<string | null>(null);
const createVisible = ref(false);
const dirPickerVisible = ref(false);
const creating = ref(false);
const form = ref({ name: '', workspace: '', description: '', scaffold: true, allow_self_ref: false });
/** 服务端项目根目录（GET /api/projects/root）；co-team 仓库根用于前端即时提示 */
const projectsRootPath = ref('');
const coteamRoot = ref('');
const workspaceInsideCoteam = computed(() => {
  const ws = (form.value.workspace || '').replace(/\\/g, '/').toLowerCase();
  const root = coteamRoot.value.replace(/\\/g, '/').toLowerCase();
  return !!root && (ws === root || ws.startsWith(root + '/'));
});

/** 项目名变化时预填 <root>/<slug>（用户手改过的不覆盖） */
let wsTouched = false;
function prefillWorkspace() {
  if (wsTouched || !projectsRootPath.value) return;
  const slug = (form.value.name || '').trim().replace(/[\\/:*?"<>|\s]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'project';
  form.value.workspace = `${projectsRootPath.value.replace(/[\\/]$/, '')}\\${slug}`;
}
function onWorkspaceInput() { wsTouched = true; }

async function openCreateDialog() {
  wsTouched = false;
  form.value = { name: '', workspace: '', description: '', scaffold: true, allow_self_ref: false };
  createVisible.value = true;
  if (!projectsRootPath.value) {
    try {
      const r = await api.projectsRoot();
      projectsRootPath.value = r.root;
      const m = r.root.match(/^(.*?)[\\/]projects$/i);
      coteamRoot.value = m ? m[1] + '\\co-team' : '';
    } catch { /* 拿不到根目录就退回手填 */ }
  }
}

function pct(p: ProjectSummary): number {
  return p.task_count ? Math.round((p.done_count / p.task_count) * 100) : 0;
}

async function loadProjects() {
  try { projects.value = (await api.listProjects()).projects; } catch (e: any) { ElMessage.error(e.message); }
}

function openProject(id: string) { current.value = id; }

async function create() {
  if (!form.value.name) { ElMessage.warning('填写项目名'); return; }
  creating.value = true;
  try {
    const d = await api.createProject({
      name: form.value.name,
      workspace: form.value.workspace || undefined,
      description: form.value.description || undefined,
      scaffold: form.value.scaffold,
      allow_self_ref: form.value.allow_self_ref,
    });
    if (d.scaffold) {
      ElMessage.success(`项目已创建，脚手架完成：${d.scaffold.dirs.length} 个目录、${d.scaffold.files.length} 份文档${d.scaffold.git_initialized ? '、git 已初始化' : ''}`);
    } else {
      ElMessage.success('项目已创建');
    }
    createVisible.value = false;
    form.value = { name: '', workspace: '', description: '', scaffold: true, allow_self_ref: false };
    await loadProjects();
  } catch (e: any) { ElMessage.error(e.message); } finally { creating.value = false; }
}

onMounted(() => void loadProjects());

defineExpose({ loadProjects });
</script>

<style scoped>
.empty { color: var(--ct-text3); text-align: center; padding: 30px; font-size: 12px; }
.project-card { position: relative; background: var(--ct-panel); border: 1px solid var(--ct-border); border-radius: 8px; padding: 14px 16px; margin-bottom: 10px; cursor: pointer; transition: border-color 0.15s; overflow: hidden; }
.project-card:hover { border-color: var(--ct-border2); }
.pc-name { font-size: 14px; font-weight: 600; color: var(--ct-text); }
.pc-ws { font-size: 11px; color: var(--ct-text3); margin: 2px 0 6px; }
.pc-stats { display: flex; gap: 12px; font-size: 11px; color: var(--ct-text2); }
.pc-issues { color: var(--ct-yellow); }
.pc-running { color: var(--ct-green); animation: blink 1.2s infinite; }
@keyframes blink { 50% { opacity: 0.4; } }
.pc-bar { position: absolute; left: 0; bottom: 0; height: 2px; width: 100%; background: var(--ct-panel2); }
.pc-fill { height: 100%; background: var(--ct-accent); transition: width 0.5s; }
.ws-hint { font-size: 10px; color: var(--ct-text3); margin-top: 3px; }
.ws-warn { font-size: 10px; color: var(--ct-orange, #e6a23c); margin-top: 3px; }
</style>
