<template>
  <div class="project-view">
    <!-- 项目列表 -->
    <div v-if="!current" class="list-pane">
      <div class="section-head">
        <div class="section-title">项目 / Projects</div>
        <el-button size="small" type="primary" @click="createVisible = true">+ 新建项目</el-button>
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
          <el-form-item label="项目名"><el-input v-model="form.name" placeholder="如 客户管理系统" /></el-form-item>
          <el-form-item label="工作区"><el-input v-model="form.workspace" placeholder="项目绝对路径，如 D:\projects\cms" /></el-form-item>
          <el-form-item label="描述"><el-input v-model="form.description" placeholder="一句话描述（可选）" /></el-form-item>
        </el-form>
        <template #footer>
          <el-button size="small" @click="createVisible = false">取消</el-button>
          <el-button size="small" type="primary" :loading="creating" @click="create">创建</el-button>
        </template>
      </el-dialog>
    </div>

    <!-- 项目工作台 -->
    <div v-else class="detail-pane">
      <div class="ph">
        <el-button size="small" link @click="current = null">← 项目列表</el-button>
        <div class="ph-main">
          <div class="ph-name">{{ detail?.name }}</div>
          <div class="ph-ws mono">{{ detail?.workspace }} · {{ detail?.done_count ?? 0 }}/{{ detail?.task_count ?? 0 }} 任务 · {{ issueCount }} 条经验</div>
        </div>
        <el-button size="small" type="primary" @click="newTaskVisible = true">发起新任务</el-button>
      </div>

      <div class="pd-grid">
        <!-- 开发历史 -->
        <div class="pd-history">
          <div class="section-title">开发历史</div>
          <div v-if="!detail?.tasks.length" class="empty mono">还没有任务 — 发起新任务开始开发</div>
          <div v-for="t in detail?.tasks || []" :key="t.task_id" class="hist-row">
            <span class="h-status mono" :class="t.status" @click="$emit('open-detail', t.task_id)">{{ statusGlyph(t.status) }}</span>
            <div class="h-body" @click="$emit('open-detail', t.task_id)">
              <div class="h-desc">{{ t.description || t.task_id }}</div>
              <div class="h-meta mono">{{ fmt(t.updated_at) }} · {{ t.nodes.filter((n) => n.status === 'completed').length }}/{{ t.nodes.length }} 节点<span v-if="t.git_commit"> · ⎇ {{ t.git_commit.branch }}</span></div>
            </div>
            <el-button size="small" link type="danger" @click.stop="deleteTask(t.task_id)">删除</el-button>
          </div>
        </div>

        <!-- 项目记忆 -->
        <div class="pd-memory">
          <div class="section-title">项目记忆 <span class="muted">（规范 / 问题 / 解决）</span></div>
          <div class="mem-add">
            <el-input v-model="newMemory" size="small" placeholder="沉淀一条项目规范，如：导出 Excel 用 exceljs" @keydown.enter="addMemory" />
            <el-button size="small" @click="addMemory">记录</el-button>
          </div>
          <div class="mem-list">
            <div v-for="(m, i) in detail?.memory || []" :key="i" class="mem-item" :class="m.kind">
              <span class="mem-kind mono">{{ m.kind === 'manual' ? '规范' : m.text.startsWith('问题') ? '问题' : m.text.startsWith('已解决') ? '解决' : '经验' }}</span>
              <span class="mem-text">{{ m.text }}</span>
              <span v-if="m.ts" class="mem-ts mono">{{ fmtShort(m.ts) }}</span>
            </div>
            <div v-if="!detail?.memory.length" class="empty mono">暂无记忆 — 开发过程中的问题与解决会自动沉淀</div>
          </div>
        </div>
      </div>

      <!-- 发起新任务 -->
      <el-dialog v-model="newTaskVisible" title="发起新任务" width="560px" @open="refreshDetail">
        <el-form label-width="80px" size="small">
          <el-form-item label="任务描述">
            <el-input v-model="taskDesc" type="textarea" :rows="3" placeholder="要开发什么？agent 会带上项目记忆快速上手" />
          </el-form-item>
          <el-form-item label="工作区"><el-input :model-value="detail?.workspace" disabled /></el-form-item>
        </el-form>
        <template #footer>
          <el-button size="small" @click="newTaskVisible = false">取消</el-button>
          <el-button size="small" type="primary" :loading="creatingTask" @click="createTask">生成计划（进入评审）</el-button>
        </template>
      </el-dialog>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { api, type ProjectDetail, type ProjectSummary } from '../api';

const emit = defineEmits<{ (e: 'open-detail', taskId: string): void; (e: 'review', taskId: string): void; (e: 'changed'): void }>();

const projects = ref<ProjectSummary[]>([]);
const current = ref<string | null>(null);
const detail = ref<ProjectDetail | null>(null);
const createVisible = ref(false);
const creating = ref(false);
const newTaskVisible = ref(false);
const creatingTask = ref(false);
const taskDesc = ref('');
const newMemory = ref('');
const form = ref({ name: '', workspace: '', description: '' });
let poll: number | undefined;

function pct(p: ProjectSummary): number {
  return p.task_count ? Math.round((p.done_count / p.task_count) * 100) : 0;
}
function statusGlyph(s: string): string {
  return ({ success: '✓', failed: '✗', running: '◐', planned: '◌', pending: '◌', cancelled: '×', waiting_approval: '⏸' } as Record<string, string>)[s] || '·';
}
function fmt(ts: string): string {
  return ts ? new Date(ts).toLocaleString() : '';
}
function fmtShort(ts: string): string {
  if (!ts) return '';
  try {
    return new Date(ts).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
  } catch {
    return ts;
  }
}
const issueCount = computed(() => (detail.value?.memory || []).filter((m) => m.text.startsWith('问题')).length);

async function loadProjects() {
  try {
    projects.value = (await api.listProjects()).projects;
  } catch (e: any) {
    ElMessage.error(e.message);
  }
}

async function openProject(id: string) {
  current.value = id;
  await refreshDetail();
}

async function refreshDetail() {
  if (!current.value) return;
  try {
    detail.value = await api.getProject(current.value);
  } catch (e: any) {
    ElMessage.error(e.message);
  }
}

async function create() {
  if (!form.value.name || !form.value.workspace) {
    ElMessage.warning('填写项目名和工作区');
    return;
  }
  creating.value = true;
  try {
    await api.createProject(form.value.name, form.value.workspace, form.value.description);
    ElMessage.success('项目已创建');
    createVisible.value = false;
    form.value = { name: '', workspace: '', description: '' };
    await loadProjects();
  } catch (e: any) {
    ElMessage.error(e.message);
  } finally {
    creating.value = false;
  }
}

async function createTask() {
  if (!taskDesc.value.trim() || !detail.value) return;
  creatingTask.value = true;
  try {
    const d = await api.createTask(taskDesc.value.trim(), detail.value.workspace, false, current.value!);
    ElMessage.success('计划已生成，进入评审');
    newTaskVisible.value = false;
    taskDesc.value = '';
    emit('review', d.task_id);
    await refreshDetail();
  } catch (e: any) {
    ElMessage.error(e.message);
  } finally {
    creatingTask.value = false;
  }
}

async function addMemory() {
  if (!newMemory.value.trim() || !current.value) return;
  try {
    await api.addProjectMemory(current.value, newMemory.value.trim());
    newMemory.value = '';
    await refreshDetail();
  } catch (e: any) {
    ElMessage.error(e.message);
  }
}

async function deleteTask(taskId: string) {
  try {
    await ElMessageBox.confirm('确定删除该任务？', '删除确认', { type: 'warning' });
  } catch {
    return;
  }
  try {
    await api.deleteTask(taskId);
    ElMessage.success('任务已删除');
    await refreshDetail();
  } catch (e: any) {
    ElMessage.error(e.message);
  }
}

onMounted(() => {
  void loadProjects();
  poll = window.setInterval(() => {
    if (detail.value && detail.value.tasks.some((t) => t.status === 'running')) void refreshDetail();
  }, 5000);
});
onUnmounted(() => window.clearInterval(poll));

defineExpose({ loadProjects, refreshDetail });
</script>

<style scoped>
.empty { color: var(--ct-text3); text-align: center; padding: 30px; font-size: 12px; }
.muted { color: var(--ct-text3); text-transform: none; }
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
.ph { display: flex; align-items: center; gap: 14px; margin-bottom: 16px; }
.ph-name { font-size: 16px; font-weight: 700; color: var(--ct-text); }
.ph-ws { font-size: 11px; color: var(--ct-text3); }
.pd-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; align-items: start; }
.pd-history, .pd-memory { max-height: calc(100vh - 300px); overflow-y: auto; padding-right: 4px; }
.hist-row { display: flex; gap: 10px; padding: 10px 12px; background: var(--ct-panel); border: 1px solid var(--ct-border); border-radius: 8px; margin-bottom: 8px; cursor: pointer; transition: border-color 0.15s; }
.hist-row:hover { border-color: var(--ct-border2); }
.h-status { font-size: 13px; width: 18px; }
.h-status.success { color: var(--ct-green); }
.h-status.failed { color: var(--ct-red); }
.h-status.running { color: var(--ct-yellow); animation: blink 1.2s infinite; }
.h-status.planned { color: var(--ct-accent); }
.h-desc { font-size: 12px; color: var(--ct-text); }
.h-meta { font-size: 10px; color: var(--ct-text3); margin-top: 2px; }
.mem-add { display: flex; gap: 8px; margin-bottom: 10px; }
.mem-add .el-input { flex: 1; }
.mem-item { display: flex; gap: 8px; padding: 6px 8px; border-bottom: 1px dotted var(--ct-border); font-size: 12px; align-items: baseline; }
.mem-kind { flex-shrink: 0; font-size: 10px; padding: 0 5px; border-radius: 3px; border: 1px solid var(--ct-border2); color: var(--ct-text3); }
.mem-item .mem-text { color: var(--ct-text2); flex: 1; }
.mem-ts { flex-shrink: 0; font-size: 10px; color: var(--ct-text3); }
</style>

