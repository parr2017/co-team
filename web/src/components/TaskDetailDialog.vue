<template>
  <el-dialog :model-value="modelValue" title="任务详情" width="1020px" @open="onOpen" @close="$emit('close')">
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

      <div class="body-grid">
        <!-- 左：管线轨道 -->
        <div class="left">
          <PipelineTrack :nodes="task.nodes" @select="selectNode" />
          <div v-if="branches.length" class="branches mono">
            <div class="sub-title mono">branches</div>
            <div v-for="b in branches" :key="b.name" class="branch-row">
              <span class="b-name">{{ b.name }}</span>
              <span class="b-commit">{{ b.commit }}</span>
            </div>
          </div>
        </div>

        <!-- 右：节点详情 / 任务时间线 -->
        <div class="right">
          <el-tabs v-model="tab">
            <el-tab-pane label="节点详情" name="node">
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
                    {{ e.type }}
                    <span v-if="e.payload.error" class="tl-err">— {{ e.payload.error }}</span>
                  </el-timeline-item>
                </el-timeline>

                <div class="sub-title mono">conversation</div>
                <ConversationView :conversations="nodeLogs" :sub-agent="selected.agent" />
              </template>
              <div v-else class="empty mono">← 在轨道图上选择一个节点</div>
            </el-tab-pane>

            <el-tab-pane :label="`任务时间线 (${events.length})`" name="all">
              <el-timeline style="padding-left: 2px; margin-top: 4px">
                <el-timeline-item v-for="(e, i) in events" :key="i" :timestamp="fmt(e.ts)" :type="tlType(e.type)">
                  <span class="mono tl-type">{{ e.type }}</span>
                  <span v-if="e.payload.node_id" class="mono tl-node"> #{{ e.payload.node_id }}</span>
                  <span v-if="e.payload.summary" class="tl-sum"> {{ e.payload.summary }}</span>
                  <span v-if="e.payload.error" class="tl-err"> {{ e.payload.error }}</span>
                </el-timeline-item>
              </el-timeline>
            </el-tab-pane>
          </el-tabs>
        </div>
      </div>
    </div>
  </el-dialog>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue';
import { api, type AgentConversation, type TaskEvent, type TaskGraph, type TaskNode } from '../api';
import PipelineTrack from './PipelineTrack.vue';
import ConversationView from './ConversationView.vue';

const props = defineProps<{ modelValue: boolean; taskId: string }>();
const emit = defineEmits<{ (e: 'close'): void }>();

const task = ref<TaskGraph | null>(null);
const events = ref<TaskEvent[]>([]);
const logs = ref<Record<string, AgentConversation[]>>({});
const selectedId = ref('');
const tab = ref('node');

const selected = computed(() => task.value?.nodes.find((n) => n.id === selectedId.value) || null);
const completedCount = computed(() => task.value?.nodes.filter((n) => n.status === 'completed').length || 0);
const progressPct = computed(() => (task.value?.nodes.length ? Math.round((completedCount.value / task.value.nodes.length) * 100) : 0));
const nodeEvents = computed(() => events.value.filter((e) => e.payload?.node_id === selectedId.value));
const nodeLogs = computed(() => logs.value[selectedId.value] || []);
const branches = ref<{ name: string; commit: string }[]>([]);

async function onOpen() {
  const d = await api.getTask(props.taskId);
  task.value = d;
  selectedId.value = '';
  tab.value = 'node';
  void api.taskEvents(props.taskId).then((e) => (events.value = e.events));
  void api.taskLogs(props.taskId).then((l) => (logs.value = l.logs));
  // sandbox branches are cleaned up after the task; show them from node records
  branches.value = (d.nodes || [])
    .filter((n) => n.branch)
    .map((n) => ({ name: n.branch as string, commit: (n.result as any)?.git_commit?.commit?.slice(0, 8) || '' }));
}

function selectNode(id: string) {
  selectedId.value = id;
  tab.value = 'node';
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
</script>

<style scoped>
.meta { display: flex; align-items: center; gap: 16px; margin-bottom: 14px; }
.meta-main { flex: 1; min-width: 0; }
.desc { font-size: 13px; font-weight: 600; color: var(--ct-text); margin-bottom: 4px; }
.meta-sub { font-size: 11px; color: var(--ct-text3); }
.progress { flex: 0 0 160px; height: 6px; background: var(--ct-panel2); border-radius: 3px; overflow: hidden; }
.progress-fill { height: 100%; background: var(--ct-accent); transition: width 0.5s; }
.body-grid { display: grid; grid-template-columns: 380px 1fr; gap: 16px; }
.left { border-right: 1px solid var(--ct-border); padding-right: 14px; }
.right { min-width: 0; }
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
.
.changes .change { font-size: 11px; color: var(--ct-text2); padding: 1px 0; }
.tl-err { color: var(--ct-red); font-size: 11px; }
.tl-type { color: var(--ct-text2); font-size: 11px; }
.tl-node { color: var(--ct-text3); font-size: 11px; }
.tl-sum { color: var(--ct-text3); font-size: 11px; }
.empty { color: var(--ct-text3); text-align: center; padding: 40px 0; }
</style>
