<template>
  <el-dialog :model-value="modelValue" title="任务详情" width="1080px" @open="onOpen" @close="onClose">
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
                <ConversationView :journal="selectedJournal" :sub-agent="selectedAgent || 'agent'" />
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
                <div class="sub-title mono">conversation ({{ selectedJournal.length }})</div>
                <ConversationView :journal="selectedJournal" :sub-agent="selected.agent" :filter-node-id="selected.id" />
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
      </el-tabs>
    </div>
  </el-dialog>
</template>

<script setup lang="ts">
import { computed, onUnmounted, ref } from 'vue';
import { api, type AgentConversation, type JournalEntry, type TaskEvent, type TaskGraph, type TaskNode } from '../api';
import PipelineTrack from './PipelineTrack.vue';
import CollabGraph from './CollabGraph.vue';
import ConversationView from './ConversationView.vue';

const props = defineProps<{ modelValue: boolean; taskId: string; liveAgents?: Record<string, { model?: string; currentAction?: string }> }>();
const emit = defineEmits<{ (e: 'close'): void }>();

const task = ref<TaskGraph | null>(null);
const events = ref<TaskEvent[]>([]);
const journals = ref<Record<string, JournalEntry[]>>({});
const logs = ref<Record<string, AgentConversation[]>>({});
const selectedNodeId = ref('');
const selectedAgent = ref('');
const tab = ref('warroom');
let pollTimer: number | undefined;

const selected = computed(() => task.value?.nodes.find((n) => n.id === selectedNodeId.value) || null);
const completedCount = computed(() => task.value?.nodes.filter((n) => n.status === 'completed').length || 0);
const progressPct = computed(() => (task.value?.nodes.length ? Math.round((completedCount.value / task.value.nodes.length) * 100) : 0));
const nodeEvents = computed(() => events.value.filter((e) => e.payload?.node_id === selectedNodeId.value));
const selectedJournal = computed(() => (selectedAgent.value ? journals.value[selectedAgent.value] || [] : []));
const selectedLive = computed(() => (selectedAgent.value ? props.liveAgents?.[selectedAgent.value] || null : null));
const branches = ref<{ name: string; commit: string }[]>([]);

const agentsInTask = computed(() => [...new Set((task.value?.nodes || []).map((n) => n.agent).filter((a) => a !== 'orchestrator'))]);

function selectAgent(agent: string) {
  selectedAgent.value = agent;
}
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
function fmt(ts: string): string {
  return new Date(ts).toLocaleTimeString();
}
function tlType(t: string) {
  return t.includes('error') ? 'danger' : t.includes('complete') ? 'success' : t.includes('start') ? 'warning' : t.includes('approval') ? 'primary' : 'info';
}

function pickDefaultAgent() {
  if (!agentsInTask.value.length) return;
  // prefer an agent currently working, else first
  const working = task.value?.nodes.find((n) => n.status === 'running' || n.status === 'retrying');
  selectedAgent.value = working?.agent || agentsInTask.value[0];
}

async function refresh() {
  if (!props.modelValue) return;
  const d = await api.getTask(props.taskId);
  task.value = d;
  const [ev, jn] = await Promise.all([api.taskEvents(props.taskId), api.taskJournals(props.taskId)]);
  events.value = ev.events;
  journals.value = jn.journals;
}

async function onOpen() {
  tab.value = 'warroom';
  selectedNodeId.value = '';
  await refresh();
  const lg = await api.taskLogs(props.taskId);
  logs.value = lg.logs;
  branches.value = (task.value?.nodes || [])
    .filter((n) => n.branch)
    .map((n) => ({ name: n.branch as string, commit: (n.result as any)?.git_commit?.commit?.slice(0, 8) || '' }));
  pickDefaultAgent();
  // live polling while the dialog is open and the task is running
  window.clearInterval(pollTimer);
  pollTimer = window.setInterval(() => {
    if (task.value && ['running', 'pending', 'planned'].includes(task.value.status)) void refresh();
  }, 3000);
}

function onClose() {
  window.clearInterval(pollTimer);
  emit('close');
}

onUnmounted(() => window.clearInterval(pollTimer));
</script>

