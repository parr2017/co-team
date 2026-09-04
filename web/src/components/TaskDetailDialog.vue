<template>
  <el-dialog :model-value="modelValue" title="任务详情" width="94%" style="max-width: 1320px" top="3vh" @open="onOpen" @close="onClose">
    <div v-if="task" class="detail">
      <!-- 顶部任务元信息 -->
      <div class="meta">
        <div class="meta-main">
          <div class="desc">{{ task.description || task.task_id }}</div>
          <div class="mono meta-sub">
            {{ task.task_id }} · {{ task.workspace }} ·
            {{ completedCount }}/{{ task.nodes.length }} 节点
            <template v-if="task.git_commit"> · ⎇ {{ task.git_commit.branch }}</template>
          </div>
        </div>
        <div class="progress">
          <div class="progress-fill" :style="{ width: progressPct + '%' }"></div>
        </div>
      </div>

      <el-tabs v-model="tab">
        <!-- 作战室 -->
        <el-tab-pane label="作战室" name="warroom">
          <div class="warroom">
            <div class="wr-left">
              <CollabGraph :task="task" :selected-agent="selectedAgent || undefined" @select="selectAgent" />
              <div class="wr-hint mono">点击成员查看其实时对话流 · 主 Agent 居中分配与回收</div>
            </div>
            <div class="wr-right">
              <div class="live-head mono">
                <span class="live-agent">{{ selectedAgent || '选择成员' }}</span>
                <span v-if="selectedLive?.model" class="live-model">{{ selectedLive.model }}</span>
                <span v-if="selectedLive?.currentAction" class="live-action">{{ selectedLive.currentAction }}</span>
              </div>
              <div class="live-chat">
                <ChatStream
                  :task-id="taskId"
                  :filter-agent="selectedAgent || undefined"
                />
              </div>
            </div>
          </div>
        </el-tab-pane>

        <!-- 执行详情（轨道图 + 归档时间线 + 分支） -->
        <el-tab-pane label="执行详情" name="exec">
          <div class="body-grid">
            <div class="left">
              <PipelineTrack :nodes="task.nodes" @select="selectNodeId" />
              <div v-if="branches.length" class="branches mono">
                <div class="sub-title mono">branches</div>
                <div v-for="b in branches" :key="b.name" class="branch-row">
                  <span class="b-name">{{ b.name }}</span>
                  <span class="b-commit">{{ b.commit }}</span>
                </div>
              </div>
            </div>
            <div class="right">
              <template v-if="selected">
                <div class="node-head mono">
                  <span class="stamp" :class="selected.status">{{ selected.status }}</span>
                  <span class="n-name">{{ selected.name }}</span>
                  <span class="n-meta">[{{ selected.agent }}]{{ selected.branch ? ' ⎇' + selected.branch : '' }}{{ dur(selected) }}</span>
                </div>
                <div v-if="selected.reason" class="reason">💡 {{ selected.reason }}</div>
                <div v-if="selected.error" class="error mono">✗ {{ selected.error }}</div>
                <div v-if="selected.result?.summary" class="summary">{{ selected.result.summary }}</div>
                <div v-if="selected.result?.changes?.length" class="changes mono">
                  <div v-for="c in selected.result.changes" :key="c" class="change">✓ {{ c }}</div>
                </div>
                <div class="sub-title mono">timeline</div>
                <el-timeline style="padding-left: 2px">
                  <el-timeline-item v-for="(e, i) in nodeEvents" :key="i" :timestamp="fmt(e.ts)" :type="tlType(e.type)">
                    {{ e.type }}<span v-if="e.payload.error" class="tl-err"> — {{ e.payload.error }}</span>
                  </el-timeline-item>
                </el-timeline>
                <div class="sub-title mono">conversation</div>
                <ChatStream
                  :task-id="taskId"
                  :filter-node-id="selected.id"
                />
              </template>
              <div v-else class="empty mono">← 在轨道图上选择一个节点</div>
            </div>
          </div>
        </el-tab-pane>

        <!-- 归档时间线（全部事件） -->
        <el-tab-pane :label="`事件归档 (${events.length})`" name="archive">
          <el-timeline style="padding-left: 2px; margin-top: 4px">
            <el-timeline-item v-for="(e, i) in events" :key="i" :timestamp="fmt(e.ts)" :type="tlType(e.type)">
              <span class="tl-type mono">{{ e.type }}</span>
              <span v-if="e.payload.node_id" class="tl-node mono"> #{{ e.payload.node_id }}</span>
              <span v-if="e.payload.summary" class="tl-sum"> {{ e.payload.summary }}</span>
              <span v-if="e.payload.error" class="tl-err"> {{ e.payload.error }}</span>
              <span v-if="e.payload.agent && e.payload.text" class="tl-sum"> {{ e.payload.agent }}: {{ e.payload.text }}</span>
            </el-timeline-item>
          </el-timeline>
        </el-tab-pane>

        <!-- 管理：进度 / 主Agent模型 / 全局目标 / 快照回滚 -->
        <el-tab-pane label="管理" name="manage">
          <div class="manage">
            <div class="mg-card">
              <div class="mg-title mono">PROGRESS · 实时进度</div>
              <div v-if="progress" class="mg-body">
                <div class="mg-progress">
                  <el-progress :percentage="progress.percent" :stroke-width="10" />
                </div>
                <div class="mg-line mono">
                  {{ progress.completed }}/{{ progress.total }} 节点 · 状态 {{ progress.status }}
                  <template v-if="progress.eta_sec !== undefined"> · 预计剩余 {{ Math.ceil(progress.eta_sec / 60) }} 分钟</template>
                </div>
                <div v-if="progress.current_nodes.length" class="mg-line">
                  进行中: <el-tag v-for="n in progress.current_nodes" :key="n.id" size="small" type="warning" class="mg-tag">{{ n.name }} ({{ n.agent }})</el-tag>
                </div>
              </div>
              <div v-else class="mg-empty mono">加载中...</div>
            </div>

            <div class="mg-card">
              <div class="mg-title mono">MAIN AGENT MODEL · 主 Agent 模型（锁定）</div>
              <div class="mg-body mg-row">
                <span class="mg-model mono">{{ task.main_model_id || '自动选择' }}</span>
                <el-select v-model="newModel" size="small" style="width: 220px" placeholder="选择新模型">
                  <el-option v-for="m in modelOptions" :key="m.name" :value="m.name" :label="m.name">
                    <span class="model-opt"><i class="dot" :class="m.healthy ? 'on' : 'off'"></i>{{ m.name }}</span>
                  </el-option>
                </el-select>
                <el-button size="small" :disabled="!newModel || newModel === task.main_model_id" :loading="changingModel" @click="changeModel">更换模型</el-button>
                <span class="mg-hint">创建时锁定，任务全程使用；更换后立即生效并留痕</span>
              </div>
            </div>

            <div class="mg-card">
              <div class="mg-title mono">GLOBAL GOAL · 全局目标</div>
              <div class="mg-body">
                <div v-if="!goalEditing" class="mg-goal">{{ goal.content || '（尚未生成）' }}</div>
                <el-input v-else v-model="goalDraft" type="textarea" :rows="5" />
                <div class="mg-row">
                  <el-button v-if="!goalEditing" size="small" @click="goalEditing = true; goalDraft = goal.content">编辑目标</el-button>
                  <template v-else>
                    <el-button size="small" @click="goalEditing = false">取消</el-button>
                    <el-button size="small" type="primary" :loading="savingGoal" @click="saveGoal">保存（Agent 下次调用生效）</el-button>
                  </template>
                  <span class="mg-hint">所有 Agent 的每次调用都会注入该目标，并要求汇报对目标的贡献</span>
                </div>
              </div>
            </div>

            <div class="mg-card">
              <div class="mg-title mono">SNAPSHOTS · 快照与回滚</div>
              <div class="mg-body">
                <div class="mg-row">
                  <el-button size="small" type="primary" :loading="creatingSnap" @click="createSnap">创建快照</el-button>
                  <span class="mg-hint">任务开始 / replan 决策点 / 任务结束 会自动创建快照</span>
                </div>
                <div v-if="!snapshots.length" class="mg-empty mono">暂无快照</div>
                <div v-for="s in snapshots" :key="s.id" class="snap-row mono">
                  <span class="snap-tag" :class="s.tag">{{ s.tag }}</span>
                  <span class="snap-time">{{ fmtTime(s.created_at) }}</span>
                  <span class="snap-ref">{{ s.git_ref?.slice(0, 8) || 'no-git' }}</span>
                  <span v-if="s.note" class="snap-note">{{ s.note }}</span>
                  <el-button size="small" link type="danger" @click="rollback(s)">回滚到此处</el-button>
                </div>
              </div>
            </div>
          </div>
        </el-tab-pane>
      </el-tabs>
    </div>
  </el-dialog>
</template>

<script setup lang="ts">
import { computed, onUnmounted, ref } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { api, type TaskEvent, type TaskGraph, type TaskNode, type ProgressInfo, type SnapshotMeta } from '../api';
import PipelineTrack from './PipelineTrack.vue';
import CollabGraph from './CollabGraph.vue';
import ChatStream from './ChatStream.vue';

const props = defineProps<{ modelValue: boolean; taskId: string; liveAgents?: Record<string, { model?: string; currentAction?: string }> }>();
const emit = defineEmits<{ (e: 'close'): void }>();

const task = ref<TaskGraph | null>(null);
const events = ref<TaskEvent[]>([]);
const selectedNodeId = ref('');
const selectedAgent = ref('');
const tab = ref('warroom');
let pollTimer: number | undefined;

// manage tab state (improvements 6/9/10/11)
const progress = ref<ProgressInfo | null>(null);
const modelOptions = ref<{ name: string; healthy: boolean }[]>([]);
const newModel = ref('');
const changingModel = ref(false);
const goal = ref<{ content: string }>({ content: '' });
const goalEditing = ref(false);
const goalDraft = ref('');
const savingGoal = ref(false);
const snapshots = ref<SnapshotMeta[]>([]);
const creatingSnap = ref(false);

const selected = computed(() => task.value?.nodes.find((n) => n.id === selectedNodeId.value) || null);
const completedCount = computed(() => task.value?.nodes.filter((n) => n.status === 'completed').length || 0);
const progressPct = computed(() => (task.value?.nodes.length ? Math.round((completedCount.value / task.value.nodes.length) * 100) : 0));
const nodeEvents = computed(() => events.value.filter((e) => e.payload?.node_id === selectedNodeId.value));
const selectedLive = computed(() => (selectedAgent.value ? props.liveAgents?.[selectedAgent.value] || null : null));
const branches = ref<{ name: string; commit: string }[]>([]);

const agentsInTask = computed(() => [...new Set((task.value?.nodes || []).map((n) => n.agent).filter((a) => a !== 'orchestrator'))]);

function selectAgent(agent: string) { selectedAgent.value = agent; }
function selectNodeId(id: string) {
  selectedNodeId.value = id;
  const n = task.value?.nodes.find((x) => x.id === id);
  if (n && n.agent !== 'orchestrator') selectedAgent.value = n.agent;
}
function dur(n: TaskNode): string {
  if (!n.started_at) return '';
  const end = n.finished_at ? new Date(n.finished_at).getTime() : Date.now();
  return ' ' + Math.max(0, Math.round((end - new Date(n.started_at).getTime()) / 100) / 10) + 's';
}
function fmt(ts: string): string { return new Date(ts).toLocaleTimeString(); }
function tlType(t: string) {
  return t.includes('error') ? 'danger' : t.includes('complete') ? 'success' : t.includes('start') ? 'warning' : t.includes('approval') ? 'primary' : 'info';
}

function pickDefaultAgent() {
  if (!agentsInTask.value.length) return;
  const working = task.value?.nodes.find((n) => n.status === 'running' || n.status === 'retrying');
  selectedAgent.value = working?.agent || agentsInTask.value[0];
}

async function refresh() {
  if (!props.modelValue) return;
  const d = await api.getTask(props.taskId);
  task.value = d;
  const ev = await api.taskEvents(props.taskId);
  events.value = ev.events;
}

async function refreshManage() {
  if (!props.modelValue) return;
  try {
    progress.value = await api.taskProgress(props.taskId);
  } catch { /* ignore */ }
  try {
    goal.value = await api.getTaskGoal(props.taskId);
  } catch { /* ignore */ }
  try {
    snapshots.value = (await api.listSnapshots(props.taskId)).snapshots;
  } catch { /* ignore */ }
}

async function loadModels() {
  try {
    const d = await api.getModelPool();
    const health = (d as any).health || {};
    modelOptions.value = d.model_pool.map((m) => ({ name: m.name, healthy: health[m.name]?.healthy !== false }));
  } catch { /* ignore */ }
}

async function changeModel() {
  if (!newModel.value) return;
  changingModel.value = true;
  try {
    await api.setTaskModel(props.taskId, newModel.value);
    ElMessage.success(`主 Agent 模型已切换为 ${newModel.value}`);
    task.value = await api.getTask(props.taskId);
    newModel.value = '';
  } catch (e: any) {
    ElMessage.error(e.message);
  } finally {
    changingModel.value = false;
  }
}

async function saveGoal() {
  savingGoal.value = true;
  try {
    await api.updateTaskGoal(props.taskId, goalDraft.value);
    goal.value = { content: goalDraft.value };
    goalEditing.value = false;
    ElMessage.success('全局目标已更新');
  } catch (e: any) {
    ElMessage.error(e.message);
  } finally {
    savingGoal.value = false;
  }
}

async function createSnap() {
  creatingSnap.value = true;
  try {
    await api.createSnapshot(props.taskId, 'manual');
    ElMessage.success('快照已创建');
    snapshots.value = (await api.listSnapshots(props.taskId)).snapshots;
  } catch (e: any) {
    ElMessage.error(e.message);
  } finally {
    creatingSnap.value = false;
  }
}

async function rollback(s: SnapshotMeta) {
  try {
    await ElMessageBox.confirm(
      `确定回滚到快照 ${s.created_at}（${s.tag}）？\n任务状态、Agent 会话与协作状态将恢复为快照时点。`,
      '回滚确认',
      { type: 'warning' }
    );
  } catch {
    return;
  }
  try {
    const r = await api.rollbackSnapshot(s.id);
    ElMessage.success(`回滚完成：${r.git_action}，恢复 ${r.kv_restored} 项状态`);
    await refresh();
    await refreshManage();
  } catch (e: any) {
    ElMessage.error(e.message);
  }
}

function fmtTime(ts: string): string {
  try {
    return new Date(ts).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
  } catch {
    return ts;
  }
}

async function onOpen() {
  tab.value = 'warroom';
  selectedNodeId.value = '';
  newModel.value = '';
  goalEditing.value = false;
  await refresh();
  await refreshManage();
  void loadModels();
  const lg = await api.taskLogs(props.taskId);
  branches.value = (task.value?.nodes || [])
    .filter((n) => n.branch)
    .map((n) => ({ name: n.branch as string, commit: (n.result as any)?.git_commit?.commit?.slice(0, 8) || '' }));
  pickDefaultAgent();
  window.clearInterval(pollTimer);
  pollTimer = window.setInterval(() => {
    if (task.value && ['running', 'pending', 'planned'].includes(task.value.status)) void refresh();
  }, 3000);
}

function onClose() { window.clearInterval(pollTimer); emit('close'); }
onUnmounted(() => window.clearInterval(pollTimer));
</script>

<style scoped>
.detail { font-size: 13px; }
.meta { display: flex; align-items: center; gap: 16px; margin-bottom: 12px; }
.meta-main { flex: 1; min-width: 0; }
.desc { font-size: 13px; font-weight: 600; color: var(--ct-text); margin-bottom: 4px; }
.meta-sub { font-size: 11px; color: var(--ct-text3); }
.progress { flex: 0 0 160px; height: 6px; background: var(--ct-panel2); border-radius: 3px; overflow: hidden; }
.progress-fill { height: 100%; background: var(--ct-accent); transition: width 0.5s; }
.warroom { display: grid; grid-template-columns: 480px 1fr; gap: 16px; align-items: start; }
.wr-left, .wr-right { max-height: calc(88vh - 200px); overflow-y: auto; }
.wr-left { padding-right: 12px; }
.wr-hint { font-size: 10px; color: var(--ct-text3); margin-top: 6px; }
.wr-right { display: flex; flex-direction: column; min-width: 0; }
.live-head { display: flex; align-items: center; gap: 10px; padding: 8px 10px; background: var(--ct-panel2); border-radius: 6px; margin-bottom: 8px; font-size: 11px; flex-wrap: wrap; }
.live-agent { font-weight: 700; color: var(--ct-text); }
.live-model { color: var(--ct-accent); border: 1px solid var(--ct-border2); border-radius: 3px; padding: 0 6px; }
.live-action { color: var(--ct-yellow); }
.live-chat { max-height: calc(88vh - 290px); overflow-y: auto; display: flex; flex-direction: column; }
.body-grid { display: grid; grid-template-columns: 360px 1fr; gap: 16px; align-items: start; }
.left { border-right: 1px solid var(--ct-border); padding-right: 14px; max-height: calc(88vh - 200px); overflow-y: auto; }
.right { min-width: 0; max-height: calc(88vh - 200px); overflow-y: auto; }
.branches { margin-top: 14px; }
.sub-title { font-size: 10px; color: var(--ct-text3); text-transform: uppercase; letter-spacing: 0.6px; margin: 12px 0 6px; }
.branch-row { display: flex; justify-content: space-between; font-size: 11px; padding: 2px 0; color: var(--ct-text2); }
.b-commit { color: var(--ct-text3); }
.node-head { display: flex; align-items: center; gap: 10px; margin-bottom: 8px; }
.stamp { font-size: 9px; font-weight: 700; letter-spacing: 1px; padding: 1px 5px; border: 1px solid currentColor; border-radius: 2px; transform: rotate(-3deg); }
.stamp.completed { color: var(--ct-green); }
.stamp.failed { color: var(--ct-red); }
.stamp.running, .stamp.retrying { color: var(--ct-yellow); }
.stamp.waiting_approval { color: var(--ct-accent); }
.n-name { color: var(--ct-text); font-weight: 600; }
.n-meta { color: var(--ct-text3); font-size: 11px; }
.reason { font-size: 12px; color: var(--ct-text2); font-style: italic; margin-bottom: 6px; }
.error { color: var(--ct-red); font-size: 12px; margin-bottom: 6px; }
.summary { font-size: 12px; color: var(--ct-text2); margin-bottom: 8px; white-space: pre-wrap; }
.changes .change { font-size: 11px; color: var(--ct-text2); padding: 1px 0; }
.tl-err { color: var(--ct-red); font-size: 11px; }
.tl-type { color: var(--ct-text2); font-size: 11px; }
.tl-node { color: var(--ct-text3); font-size: 11px; }
.tl-sum { color: var(--ct-text3); font-size: 11px; }
.empty { color: var(--ct-text3); text-align: center; padding: 40px 0; }
/* manage tab */
.manage { display: flex; flex-direction: column; gap: 14px; max-height: calc(88vh - 200px); overflow-y: auto; }
.mg-card { border: 1px solid var(--ct-border); border-radius: 8px; padding: 12px 14px; }
.mg-title { font-size: 10px; color: var(--ct-text3); letter-spacing: 1px; margin-bottom: 10px; }
.mg-body { display: flex; flex-direction: column; gap: 8px; }
.mg-row { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.mg-line { font-size: 12px; color: var(--ct-text2); }
.mg-tag { margin-right: 4px; }
.mg-model { font-size: 13px; color: var(--ct-accent); font-weight: 600; }
.mg-hint { font-size: 11px; color: var(--ct-text3); }
.mg-goal { white-space: pre-wrap; font-size: 12px; color: var(--ct-text2); background: var(--ct-panel2); border-radius: 6px; padding: 10px; }
.mg-empty { color: var(--ct-text3); font-size: 12px; }
.mg-progress { max-width: 420px; }
.snap-row { display: flex; align-items: center; gap: 10px; font-size: 11px; padding: 6px 0; border-bottom: 1px dotted var(--ct-border); }
.snap-tag { border: 1px solid currentColor; border-radius: 3px; padding: 0 6px; font-size: 10px; }
.snap-tag.manual { color: var(--ct-accent); }
.snap-tag.task-start { color: var(--ct-green); }
.snap-tag.task-end { color: var(--ct-text3); }
.snap-tag.decision { color: var(--ct-yellow); }
.snap-time { color: var(--ct-text2); }
.snap-ref { color: var(--ct-text3); }
.snap-note { color: var(--ct-text3); flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.model-opt { display: inline-flex; align-items: center; gap: 6px; }
.model-opt .dot { width: 6px; height: 6px; border-radius: 50%; display: inline-block; }
.model-opt .dot.on { background: var(--ct-green); }
.model-opt .dot.off { background: var(--ct-red); }
</style>
