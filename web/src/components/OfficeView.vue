<template>
  <div class="office">
    <!-- 头部 -->
    <div class="office-head">
      <el-button size="small" link @click="$emit('back')">← 项目列表</el-button>
      <div class="oh-main">
        <div class="oh-name">{{ detail?.name }}</div>
        <div class="oh-sub mono">{{ detail?.workspace }} · {{ doneCount }}/{{ totalCount }} 节点完成 · {{ issueCount }} 条经验</div>
      </div>
      <div class="oh-bar"><div class="oh-fill" :style="{ width: totalCount ? Math.round(doneCount / totalCount * 100) + '%' : '0%' }"></div></div>
      <el-button size="small" type="primary" @click="newTaskVisible = true">发起新任务</el-button>
      <el-button size="small" @click="openCostReport">进度成本表</el-button>
    </div>

    <!-- 进行中工单 -->
    <div v-if="activeTasks.length" class="office-tasks">
      <div class="section-title">进行中工单</div>
      <div v-for="t in activeTasks" :key="t.task_id" class="task-card" @click="$emit('open-detail', t.task_id)">
        <span class="tc-dot" :class="t.status"></span>
        <div class="tc-body">
          <div class="tc-desc">{{ t.description || t.task_id }}</div>
          <div class="tc-nodes mono">
            <span v-for="n in t.nodes" :key="n.id" class="tc-node" :class="n.status">{{ n.name }}<i v-if="n.agent && n.agent !== 'orchestrator'">·{{ n.agent }}</i></span>
          </div>
        </div>
        <span class="tc-enter mono">任务频道 →</span>
      </div>
    </div>

    <!-- 工位网格 -->
    <div class="office-floor">
      <div class="section-title">办公区 <span class="muted">工位实时状态</span></div>
      <div class="seat-grid">
        <div v-for="s in seats" :key="s.key" class="seat" :class="[s.status, { master: s.isMaster }]">
          <!-- 头部：头像 + 名称 + 进度环 -->
          <div class="seat-top">
            <div class="seat-av mono" :class="s.status">{{ s.isMaster ? '主' : avatarOf(s.name) }}</div>
            <div class="seat-id">
              <div class="seat-name">{{ s.name }}</div>
              <div class="seat-role mono">{{ s.role }}</div>
            </div>
            <svg v-if="s.total" class="seat-ring" viewBox="0 0 36 36">
              <circle class="ring-bg" cx="18" cy="18" r="15.5" />
              <circle class="ring-fg" cx="18" cy="18" r="15.5"
                :stroke-dasharray="`${(s.done / s.total * 97.4).toFixed(1)} 97.4`"
                :class="s.status" />
              <text x="18" y="21.5" text-anchor="middle" class="ring-num mono">{{ Math.round(s.done / s.total * 100) }}%</text>
            </svg>
          </div>

          <!-- 状态灯 + 模型 -->
          <div class="seat-lamp-row mono">
            <span class="lamp" :class="s.status"></span>
            <span class="lamp-text">{{ statusText(s.status) }}</span>
            <span v-if="s.model" class="seat-model">{{ s.model }}</span>
          </div>

          <!-- 实时动作 -->
          <div class="seat-action" :title="s.action">{{ s.action }}</div>

          <!-- 输出芯片 -->
          <div v-if="s.changes.length" class="seat-chips mono">
            <span v-for="(c, i) in s.changes" :key="i" class="chip">✓ {{ c }}</span>
          </div>

          <!-- 进入任务频道 -->
          <el-button v-if="s.taskId && s.status !== 'idle'" size="small" link type="primary" @click.stop="$emit('open-detail', s.taskId!)">进入任务频道 →</el-button>
        </div>
      </div>
    </div>

    <!-- 归档任务 -->
    <div v-if="archivedTasks.length" class="office-archive">
      <el-collapse>
        <el-collapse-item :title="`归档任务 (${archivedTasks.length})`" name="archive">
          <div v-for="t in archivedTasks" :key="t.task_id" class="hist-row" @click="$emit('open-detail', t.task_id)">
            <span class="h-status mono" :class="t.status">{{ statusGlyph(t.status) }}</span>
            <div class="h-body">
              <div class="h-desc">{{ t.description || t.task_id }}</div>
              <div class="h-meta mono">{{ fmt(t.updated_at) }} · {{ t.nodes.filter(n => n.status === 'completed').length }}/{{ t.nodes.length }} 节点</div>
            </div>
            <el-button size="small" link type="danger" @click.stop="deleteTask(t.task_id)">删除</el-button>
          </div>
        </el-collapse-item>
      </el-collapse>
    </div>

    <!-- P1.1 项目档案（结构化字段 + 简报，双轨） -->
    <div class="office-memory">
      <el-collapse>
        <el-collapse-item :title="`项目档案（概念/简报${detail?.brief ? ' · 已生成' : ' · 未生成'}）`" name="brief">
          <el-form label-width="70px" size="small" class="brief-form">
            <el-form-item label="一句话"><el-input v-model="editForm.description" placeholder="这个项目是做什么的" /></el-form-item>
            <el-form-item label="技术栈"><el-input v-model="editForm.tech_stack" placeholder="如 Vue3 + TS + Vite" /></el-form-item>
            <el-form-item label="约定"><el-input v-model="editForm.conventions" placeholder="编码/协作约定，分号分隔" /></el-form-item>
            <el-form-item label="领域"><el-input v-model="editForm.domain" placeholder="业务域" /></el-form-item>
            <el-form-item label="阶段"><el-input v-model="editForm.stage" placeholder="原型/开发/维护" /></el-form-item>
            <el-form-item label="受众"><el-input v-model="editForm.audience" placeholder="目标用户" /></el-form-item>
          </el-form>
          <div class="brief-bar">
            <el-button size="small" :loading="briefGenerating" @click="genBrief">AI 生成简报</el-button>
            <el-button size="small" type="primary" :loading="briefSaving" @click="saveBriefForm">保存档案</el-button>
          </div>
          <el-input v-model="editForm.brief" type="textarea" :rows="6" placeholder="项目简报（AI 生成后可编辑；每次任务/会话/讨论前注入作为项目概念基准）" />
          <div v-if="detail?.brief_updated_at" class="brief-ts mono">更新于 {{ fmtShort(detail.brief_updated_at) }}</div>
        </el-collapse-item>
      </el-collapse>
    </div>

    <!-- 项目记忆 -->
    <div class="office-memory">
      <el-collapse>
        <el-collapse-item :title="`项目记忆 (${detail?.memory?.length || 0})`" name="memory">
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
            <div v-if="!detail?.memory?.length" class="empty mono">暂无记忆 — 开发过程中的问题与解决会自动沉淀</div>
          </div>
        </el-collapse-item>
      </el-collapse>
    </div>

    <!-- 项目经验（知识库：群组讨论沉淀 + 任务复盘 + 规划方案） -->
    <div class="office-exp">
      <el-collapse>
        <el-collapse-item :title="`项目经验 · 知识库 (${projectKnowledge.length})`" name="kexp">
          <div v-for="e in projectKnowledge" :key="e.id" class="exp-item">
            <div class="exp-title mono">
              {{ e.title }}
              <span v-for="t in (e.tags || []).filter((x: string) => ['群组讨论', '项目规划方案', '任务复盘'].includes(x))" :key="t" class="exp-tag">{{ t }}</span>
            </div>
            <div class="exp-src mono">来源 {{ e.source }} · {{ (e.updated_at || e.created_at || '').slice(0, 10) }}</div>
            <MdView class="exp-body" :source="e.content" />
          </div>
          <div v-if="!projectKnowledge.length" class="empty mono">暂无条目 — 群组讨论经验、任务复盘与规划方案会自动沉淀到这里</div>
        </el-collapse-item>
      </el-collapse>
    </div>

    <!-- 发起新任务 -->
    <el-dialog v-model="newTaskVisible" title="发起新任务" width="560px">
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

    <!-- 进度成本表 -->
    <el-dialog v-model="costVisible" title="项目进度成果表" width="94%" top="4vh" append-to-body destroy-on-close>
      <div v-if="costReport" class="cost-report">
        <div class="cost-totals mono">
          <span>任务 {{ costReport.totals.tasks }}</span>
          <span>✅ {{ costReport.totals.tasks_success }}</span>
          <span>🔄 {{ costReport.totals.tasks_running }}</span>
          <span>❌ {{ costReport.totals.tasks_failed }}</span>
          <span>节点 {{ costReport.totals.nodes }}（完成 {{ costReport.totals.nodes_completed }} / 失败 {{ costReport.totals.nodes_failed }}）</span>
          <span>重试 {{ costReport.totals.retries }}</span>
          <span>Token {{ costReport.totals.tokens.toLocaleString() }}</span>
          <span>交付成果 {{ costReport.totals.deliverables }}</span>
          <span>总时长 {{ Math.round(costReport.totals.duration_sec / 60) }} 分钟</span>
        </div>
        <el-table :data="costReport.tasks" size="small" border>
          <el-table-column type="expand">
            <template #default="{ row }">
              <el-table :data="row.nodes" size="small" border>
                <el-table-column prop="name" label="节点" min-width="200" show-overflow-tooltip />
                <el-table-column prop="agent" label="Agent" width="90" />
                <el-table-column label="状态" width="100">
                  <template #default="{ row: n }"><el-tag size="small" :type="n.status === 'completed' ? 'success' : n.status === 'failed' ? 'danger' : 'warning'">{{ statusText(n.status) }}</el-tag></template>
                </el-table-column>
                <el-table-column label="重试" width="60"><template #default="{ row: n }">{{ n.retry_count || 0 }}</template></el-table-column>
                <el-table-column prop="model" label="模型" width="140" show-overflow-tooltip />
                <el-table-column label="Token" width="90"><template #default="{ row: n }">{{ n.tokens.toLocaleString() }}</template></el-table-column>
                <el-table-column label="时长" width="80"><template #default="{ row: n }">{{ n.duration_sec }}s</template></el-table-column>
                <el-table-column label="交付成果" width="110">
                  <template #default="{ row: n }">
                    <el-button v-if="n.deliverable" size="small" link type="primary" @click.stop="viewDeliverable(n)">阅读报告</el-button>
                    <span v-else class="mono">—</span>
                  </template>
                </el-table-column>
              </el-table>
            </template>
          </el-table-column>
          <el-table-column prop="description" label="任务" min-width="220" show-overflow-tooltip />
          <el-table-column label="状态" width="110">
            <template #default="{ row }"><el-tag size="small" :type="row.status === 'success' ? 'success' : row.status === 'failed' ? 'danger' : 'warning'">{{ statusText(row.status) }}</el-tag></template>
          </el-table-column>
          <el-table-column prop="level" label="级别" width="80" />
          <el-table-column label="Token" width="100"><template #default="{ row }">{{ row.tokens.toLocaleString() }}</template></el-table-column>
          <el-table-column label="时长" width="90"><template #default="{ row }">{{ Math.round(row.duration_sec / 60) }}m</template></el-table-column>
          <el-table-column label="成果" width="70"><template #default="{ row }">{{ row.nodes.filter((n: any) => n.deliverable).length }}/{{ row.nodes.length }}</template></el-table-column>
        </el-table>
      </div>
      <div v-else class="mono">加载中…</div>
    </el-dialog>

    <!-- 交付成果阅读器：统一模板固定展现 -->
    <el-dialog v-model="delivViewOpen" :title="'交付成果 · ' + (delivView?.node_name || '')" width="720px" top="5vh" append-to-body>
      <MdView class="deliverable-md" :source="delivView?.markdown || ''" />
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { renderMarkdown } from '../utils/md';
import MdView from './MdView.vue';
import { fmtDateTime, relativeTime } from '../utils/time';
import { api, type AgentInfo, type ProjectProgressReport, type ProjectDetail, type TaskGraph, type TaskNode, type KnowledgeEntry } from '../api';
import { useDashboard } from '../composables/useDashboard';

interface Seat {
  key: string;
  name: string;
  role: string;
  isMaster: boolean;
  status: 'working' | 'waiting' | 'error' | 'idle';
  action: string;
  model: string;
  changes: string[];
  done: number;
  total: number;
  taskDesc: string;
  taskId: string | null;
}

const props = defineProps<{ projectId: string }>();
const emit = defineEmits<{ (e: 'back'): void; (e: 'open-detail', taskId: string): void; (e: 'review', taskId: string): void }>();

const { agents } = useDashboard();
const detail = ref<ProjectDetail | null>(null);
/** 项目经验：知识库 category=project 条目（群组讨论沉淀 / 任务复盘 / 规划方案） */
const projectKnowledge = ref<KnowledgeEntry[]>([]);
async function loadProjectKnowledge() {
  try {
    projectKnowledge.value = (await api.listKnowledge({ category: 'project', project_id: props.projectId, limit: 100 })).entries;
  } catch { projectKnowledge.value = []; }
}
const agentDefs = ref<AgentInfo[]>([]);
const newTaskVisible = ref(false);
const costVisible = ref(false);
const costReport = ref<ProjectProgressReport | null>(null);
async function openCostReport() {
  costVisible.value = true;
  try { costReport.value = await api.projectReport(props.projectId); } catch { costReport.value = null; }
}
const delivViewOpen = ref(false);
const delivView = ref<{ node_name: string; markdown: string } | null>(null);
function viewDeliverable(n: { deliverable: { node_name: string; markdown: string } | null }) {
  if (n.deliverable) {
    delivView.value = n.deliverable;
    delivViewOpen.value = true;
  }
}

const creatingTask = ref(false);
const taskDesc = ref('');
const newMemory = ref('');
let pollTimer: number | undefined;
let refreshDebounce: number | undefined;
let unsubFn: (() => void) | undefined;

// computed — 终态之外都算进行中（queued/retrying/waiting_clarify/clarifying 等中间态不再凭空消失）
const TERMINAL_STATUSES = ['completed', 'success', 'failed', 'cancelled'];
const activeTasks = computed(() =>
  (detail.value?.tasks || []).filter(t => !TERMINAL_STATUSES.includes(t.status))
);
const archivedTasks = computed(() =>
  (detail.value?.tasks || []).filter(t => TERMINAL_STATUSES.includes(t.status))
);
const doneCount = computed(() => (detail.value?.tasks || []).reduce((s, t) => s + t.nodes.filter(n => n.status === 'completed').length, 0));
const totalCount = computed(() => (detail.value?.tasks || []).reduce((s, t) => s + t.nodes.length, 0));
const issueCount = computed(() => (detail.value?.memory || []).filter(m => m.text.startsWith('问题')).length);

function statusGlyph(s: string): string {
  return ({ success: '✓', completed: '✓', failed: '✗', running: '◐', planned: '◌', pending: '◌', cancelled: '×', waiting_approval: '⏸' } as Record<string, string>)[s] || '·';
}

const seats = computed<Seat[]>(() => {
  const allTasks = detail.value?.tasks || [];
  const actives = activeTasks.value;
  const list: Seat[] = [];

  // master seat
  const mergeRunning = actives.some(t => t.nodes.some(n => n.agent === 'orchestrator' && ['running', 'retrying'].includes(n.status)));
  list.push({
    key: '__master', name: '主 Agent', role: '项目经理 · 调度与合并', isMaster: true,
    status: actives.length ? 'working' : 'idle',
    action: mergeRunning ? '合并分支…' : actives.length ? `管理 ${agentDefs.value.length} 个工位 · 监督执行` : '待命',
    model: '模型池调度', changes: [],
    done: doneCount.value, total: totalCount.value,
    taskDesc: actives[0]?.description || '', taskId: actives[0]?.task_id || null,
  });

  // per-agent seats
  for (const def of agentDefs.value) {
    let foundNode: TaskNode | null = null;
    let foundTask: TaskGraph | null = null;

    // find running/waiting node in any active task (latest first)
    outer: for (const t of [...actives].reverse()) {
      for (const n of [...t.nodes].reverse()) {
        if (n.agent === def.name && ['running', 'retrying', 'waiting_approval'].includes(n.status)) {
          foundNode = n; foundTask = t; break outer;
        }
      }
    }

    // if nothing active, check for recent failure
    if (!foundNode) {
      for (const t of [...allTasks].reverse()) {
        const n = [...t.nodes].reverse().find(x => x.agent === def.name && x.status === 'failed');
        if (n) { foundNode = n; foundTask = t; break; }
      }
    }

    const liveA = agents[def.name];
    let status: Seat['status'] = 'idle';
    let action = liveA?.currentAction || '';

    if (foundNode?.status === 'waiting_approval') {
      status = 'waiting'; action = '等待人工审批';
    } else if (foundNode && ['running', 'retrying'].includes(foundNode.status)) {
      status = 'working'; action = action || `执行: ${foundNode.name}`;
    } else if (foundNode?.status === 'failed') {
      status = 'error'; action = '上次执行失败，等待重试';
    } else if (liveA?.status === 'running') {
      status = 'working';
    }

    if (status === 'idle') {
      action = (liveA?.status === 'done' && action) ? `最近: ${action}` : '';
    }

    const isActive = status === 'working' || status === 'waiting';
    const progressTask = foundTask && isActive ? foundTask : null;
    const model = (status !== 'idle' && liveA?.model) || def.modelOverride || '';
    const changes = isActive
      ? (foundNode?.result?.changes || []).slice(0, 2)
      : (liveA?.changes || []).slice(0, 2);

    list.push({
      key: def.name, name: def.name, role: def.role, isMaster: false,
      status, action: action || '待命', model, changes,
      done: progressTask ? progressTask.nodes.filter(n => n.status === 'completed').length : 0,
      total: progressTask ? progressTask.nodes.length : 0,
      taskDesc: foundTask?.description || '',
      taskId: foundTask?.task_id || foundNode?.task_id || null,
    });
  }

  return list;
});

function statusText(s: Seat['status']): string {
  return ({ working: '工作中', waiting: '等待审批', error: '出错', idle: '空闲' })[s] || s;
}

// same letter codes as BranchGraph/PipelineTrack — dev/deploy both start with "de",
// so raw initials collide (dev showed "DE" like deploy)
const AVATAR_CODES: Record<string, string> = { orchestrator: 'OR', dev: 'DV', deploy: 'DP', docs: 'DO', refactor: 'RF', review: 'RV', test: 'TE' };

function avatarOf(name: string): string {
  return AVATAR_CODES[name] || (name || '??').replace(/[^a-z]/gi, '').slice(0, 2).toUpperCase() || '??';
}

function fmt(ts: string): string {
  return fmtDateTime(ts);
}

function fmtShort(ts: string): string {
  return relativeTime(ts);
}

// data loading
async function refreshDetail() {
  if (!props.projectId) return;
  try { detail.value = await api.getProject(props.projectId); } catch { /* ignore */ }
  await loadProjectKnowledge();
}

async function loadAgents() {
  try {
    const d = await api.listAgents();
    agentDefs.value = d.agents;
  } catch { /* ignore */ }
}

async function createTask() {
  if (!taskDesc.value.trim() || !detail.value) return;
  creatingTask.value = true;
  try {
    const d = await api.createTask(taskDesc.value.trim(), detail.value.workspace, false, props.projectId);
    ElMessage.success('计划已生成，进入评审');
    newTaskVisible.value = false;
    taskDesc.value = '';
    emit('review', d.task_id);
    await refreshDetail();
  } catch (e: any) { ElMessage.error(e.message); } finally { creatingTask.value = false; }
}

async function addMemory() {
  if (!newMemory.value.trim() || !props.projectId) return;
  try {
    await api.addProjectMemory(props.projectId, newMemory.value.trim());
    newMemory.value = '';
    await refreshDetail();
  } catch (e: any) { ElMessage.error(e.message); }
}

// ---------- P1.1 项目档案（结构化字段 + 简报） ----------
const briefGenerating = ref(false);
const briefSaving = ref(false);
const editForm = ref<Record<string, string>>({});
function syncEditForm() {
  const d = detail.value;
  editForm.value = {
    description: d?.description || '',
    tech_stack: d?.tech_stack || '',
    conventions: d?.conventions || '',
    domain: d?.domain || '',
    stage: d?.stage || '',
    audience: d?.audience || '',
    brief: d?.brief || '',
  };
}
watch(() => detail.value?.brief_updated_at, () => syncEditForm());
async function saveBriefForm() {
  if (!props.projectId) return;
  briefSaving.value = true;
  try {
    await api.updateProject(props.projectId, { ...editForm.value });
    ElMessage.success('项目档案已保存');
    await refreshDetail();
  } catch (e: any) { ElMessage.error(e.message); } finally { briefSaving.value = false; }
}
async function genBrief() {
  if (!props.projectId) return;
  briefGenerating.value = true;
  try {
    const r = await api.generateProjectBrief(props.projectId);
    editForm.value.brief = r.brief;
    ElMessage.success('简报初稿已生成（可编辑后保存）');
    await refreshDetail();
  } catch (e: any) { ElMessage.error(e.message); } finally { briefGenerating.value = false; }
}

async function deleteTask(taskId: string) {
  try { await ElMessageBox.confirm('确定删除该任务？', '删除确认', { type: 'warning' }); } catch { return; }
  try { await api.deleteTask(taskId); ElMessage.success('任务已删除'); await refreshDetail(); } catch (e: any) { ElMessage.error(e.message); }
}

// polling + WS
function scheduleRefresh() {
  window.clearTimeout(refreshDebounce);
  refreshDebounce = window.setTimeout(() => void refreshDetail(), 600);
}

onMounted(async () => {
  await Promise.all([refreshDetail(), loadAgents()]);
  // poll while any task is active
  pollTimer = window.setInterval(() => {
    if (activeTasks.value.length) void refreshDetail();
  }, 4000);
  // subscribe to WS events
  unsubFn = useDashboard().onEvent((msg) => {
    const p = msg.payload || {};
    if (p.project_id === props.projectId || (detail.value?.tasks || []).some(t => t.task_id === p.task_id)) {
      if (['node_start', 'node_complete', 'node_error', 'node_waiting_approval', 'execute_start', 'execute_complete', 'execute_failed', 'execute_cancelled', 'agent_final'].includes(msg.type)) {
        scheduleRefresh();
      }
    }
  });
});

onUnmounted(() => {
  window.clearInterval(pollTimer);
  window.clearTimeout(refreshDebounce);
  unsubFn?.();
});

defineExpose({ refreshDetail, loadAgents });
</script>

<style scoped>
.office { display: flex; flex-direction: column; gap: 20px; }
.brief-form { margin-bottom: 10px; }
.brief-bar { display: flex; gap: 8px; margin-bottom: 8px; }
.brief-ts { margin-top: 6px; font-size: 10.5px; color: var(--text-3); }
.office-head { display: flex; align-items: center; gap: 14px; }
.oh-main { flex: 1; min-width: 0; }
.oh-name { font-size: 16px; font-weight: 700; color: var(--text-1); }
.oh-sub { font-size: 11px; color: var(--text-3); margin-top: 2px; }
.oh-bar { flex: 0 0 120px; height: 6px; background: var(--bg-raised); border-radius: 3px; overflow: hidden; }
.oh-fill { height: 100%; background: var(--accent); transition: width 0.5s; }

/* task cards */
.office-tasks { }
.task-card { display: flex; align-items: center; gap: 12px; background: var(--bg-panel); border: 1px solid var(--line); border-radius: 8px; padding: 12px 14px; margin-bottom: 8px; cursor: pointer; transition: border-color 0.15s; }
.task-card:hover { border-color: var(--line-strong); }
.tc-dot { width: 10px; height: 10px; border-radius: 50%; flex-shrink: 0; }
.tc-dot.running, .tc-dot.planned, .tc-dot.pending { background: var(--ok); animation: blink 1.2s infinite; }
.tc-dot.waiting_approval { background: var(--warn); animation: blink 1.2s infinite; }
.tc-dot.failed { background: var(--danger); }
.tc-body { flex: 1; min-width: 0; }
.tc-desc { font-size: 13px; color: var(--text-1); font-weight: 500; margin-bottom: 4px; }
.tc-nodes { display: flex; gap: 4px; flex-wrap: wrap; }
.tc-node { font-size: 10px; padding: 2px 6px; border-radius: 3px; border: 1px solid var(--line-strong); color: var(--text-3); }
.tc-node.running, .tc-node.retrying { border-color: var(--warn); color: var(--warn); }
.tc-node.completed { border-color: var(--ok); color: var(--ok); }
.tc-node.failed { border-color: var(--danger); color: var(--danger); }
.tc-node.waiting_approval { border-color: var(--accent); color: var(--accent); }
.tc-enter { font-size: 11px; color: var(--accent); flex-shrink: 0; }

/* workstation grid */
.seat-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 12px; }
.seat { background: var(--bg-panel); border: 1px solid var(--line); border-radius: 8px; padding: 14px; transition: border-color 0.15s, box-shadow 0.15s; }
.seat:hover { border-color: var(--line-strong); }
.seat.master { border-left: 3px solid var(--accent); }
.seat.working { box-shadow: 0 0 0 1px var(--ok); }
.seat.waiting { box-shadow: 0 0 0 1px var(--warn); }
.seat.error { box-shadow: 0 0 0 1px var(--danger); }
.seat.idle { opacity: 0.65; }

.seat-top { display: flex; align-items: center; gap: 10px; margin-bottom: 8px; }
.seat-av { width: 36px; height: 36px; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-size: 12px; font-weight: 700; flex-shrink: 0; }
.seat-av.working { background: var(--ok); color: #fff; }
.seat-av.waiting { background: var(--warn); color: #fff; }
.seat-av.error { background: var(--danger); color: #fff; }
.seat-av.idle { background: var(--bg-raised); color: var(--text-3); }
.seat.master .seat-av { background: var(--accent); color: #fff; }

.seat-id { flex: 1; min-width: 0; }
.seat-name { font-size: 13px; font-weight: 600; color: var(--text-1); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.seat-role { font-size: 10px; color: var(--text-3); margin-top: 1px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

/* SVG progress ring */
.seat-ring { width: 36px; height: 36px; flex-shrink: 0; transform: rotate(-90deg); }
.ring-bg { fill: none; stroke: var(--bg-raised); stroke-width: 3; }
.ring-fg { fill: none; stroke: var(--ok); stroke-width: 3; stroke-linecap: round; transition: stroke-dasharray 0.5s; }
.ring-fg.working { stroke: var(--ok); }
.ring-fg.waiting { stroke: var(--warn); }
.ring-fg.error { stroke: var(--danger); }
.ring-fg.idle { stroke: var(--text-3); }
.ring-num { font-size: 8px; fill: var(--text-2); transform: rotate(90deg); transform-origin: 18px 18px; }

/* lamp */
.seat-lamp-row { display: flex; align-items: center; gap: 6px; font-size: 10px; color: var(--text-3); margin-bottom: 4px; }
.lamp { width: 6px; height: 6px; border-radius: 50%; flex-shrink: 0; }
.lamp.working { background: var(--ok); animation: blink 1.2s infinite; }
.lamp.waiting { background: var(--warn); animation: blink 1.2s infinite; }
.lamp.error { background: var(--danger); }
.lamp.idle { background: var(--text-3); }
.lamp-text { color: var(--text-3); }
.seat-model { margin-left: auto; color: var(--accent); border: 1px solid var(--line-strong); border-radius: 3px; padding: 0 4px; font-size: 9px; }

.seat-action { font-size: 11px; color: var(--text-2); margin-bottom: 6px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.seat-chips { display: flex; flex-wrap: wrap; gap: 3px; margin-bottom: 6px; }
.chip { font-size: 9px; color: var(--ok); border: 1px solid var(--line); border-radius: 3px; padding: 1px 4px; background: var(--bg-page); }

/* archived */
.office-archive { }
.hist-row { display: flex; gap: 10px; padding: 10px 12px; background: var(--bg-panel); border: 1px solid var(--line); border-radius: 8px; margin-bottom: 8px; cursor: pointer; transition: border-color 0.15s; }
.hist-row:hover { border-color: var(--line-strong); }
.h-status { font-size: 13px; width: 18px; }
.h-status.success, .h-status.completed { color: var(--ok); }
.h-status.failed { color: var(--danger); }
.h-status.running { color: var(--warn); animation: blink 1.2s infinite; }
.h-status.planned { color: var(--accent); }
.h-body { flex: 1; min-width: 0; }
.h-desc { font-size: 12px; color: var(--text-1); }
.h-meta { font-size: 10px; color: var(--text-3); margin-top: 2px; }

/* memory */
.office-memory { }
.mem-add { display: flex; gap: 8px; margin-bottom: 10px; }
.mem-add .el-input { flex: 1; }
.mem-item { display: flex; gap: 8px; padding: 6px 8px; border-bottom: 1px dotted var(--line); font-size: 12px; align-items: baseline; }
.mem-kind { flex-shrink: 0; font-size: 10px; padding: 0 5px; border-radius: 3px; border: 1px solid var(--line-strong); color: var(--text-3); }
.mem-text { color: var(--text-2); flex: 1; }
.mem-ts { flex-shrink: 0; font-size: 10px; color: var(--text-3); }

/* 项目经验 · 知识库 */
.office-exp { margin-top: 4px; }
.exp-item { padding: 8px 6px; border-bottom: 1px dotted var(--line); }
.exp-item:last-child { border-bottom: none; }
.exp-title { font-size: 12px; font-weight: 600; color: var(--text-1); display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.exp-tag { font-size: 9px; font-weight: 400; color: var(--accent); border: 1px solid var(--accent); border-radius: 3px; padding: 0 4px; }
.exp-src { font-size: 10px; color: var(--text-3); margin: 2px 0; }
.exp-body { font-size: 11px; color: var(--text-2); line-height: 1.6; }

.empty { color: var(--text-3); text-align: center; padding: 30px; font-size: 12px; }
.muted { color: var(--text-3); text-transform: none; font-weight: 400; }
@keyframes blink { 50% { opacity: 0.4; } }
.cost-totals { display: flex; flex-wrap: wrap; gap: 14px; font-size: 12px; color: var(--text-2); margin-bottom: 12px; }
.cost-totals span { background: var(--bg-raised); border-radius: 4px; padding: 3px 10px; }
.deliverable-md { max-height: 62vh; overflow-y: auto; }
.deliverable-md :deep(h1) { font-size: 17px; margin: 4px 0 10px; }
.deliverable-md :deep(h2) { font-size: 14px; margin: 14px 0 6px; border-bottom: 1px solid var(--line); padding-bottom: 4px; }
.deliverable-md :deep(table) { border-collapse: collapse; margin: 8px 0; }
.deliverable-md :deep(th), .deliverable-md :deep(td) { border: 1px solid var(--line); padding: 4px 10px; font-size: 12px; }
</style>
