<template>
  <el-dialog :model-value="modelValue" title="计划评审" width="860px" @open="onOpen" @close="$emit('close')">
    <div class="sheet">
      <div class="sheet-head mono">
        <span class="doc-no">PLAN {{ taskId }}</span>
        <span class="doc-status">STATUS: {{ statusLabel(graph?.status) }}</span>
      </div>
      <div class="sheet-desc">{{ graph?.description }}</div>

      <div class="entries">
        <div v-for="(n, i) in editableNodes" :key="n.id" class="entry" :class="{ dim: n._deleted }">
          <div class="entry-line">
            <span class="entry-no mono">{{ String(i + 1).padStart(2, '0') }}</span>
            <span class="leader"></span>
            <template v-if="!n._editing">
              <span class="entry-name">{{ n.name }}</span>
            </template>
            <template v-else>
              <el-input v-model="n.name" size="small" class="entry-name-input" />
            </template>
            <span class="entry-agent mono" :class="n.agent">[{{ n.agent }}]</span>
            <el-select
              v-if="n._editing"
              :model-value="n.agent"
              size="small"
              style="width: 110px"
              @update:model-value="(v: string) => (n.agent = v)"
            >
              <el-option v-for="a in agentOptions" :key="a" :label="a" :value="a" />
            </el-select>
            <span v-if="n.requires_approval" class="stamp mono">APPROVAL</span>
            <span v-if="n._deleted" class="stamp mono del">REMOVED</span>
            <span v-else-if="!n._editing" class="branch mono">{{ branchOf(n) }}</span>
            <span class="ops">
              <el-button size="small" link @click="toggleEdit(n)">{{ n._editing ? '完成' : '改' }}</el-button>
              <el-button size="small" link type="danger" @click="removeNode(n)">删</el-button>
            </span>
          </div>
          <div v-if="n.reason" class="margin-note">
            <span class="note-line"></span>
            <span class="note-text">{{ n.reason }}</span>
          </div>
        </div>
      </div>

      <div class="sign-area">
        <div class="feedback">
          <span class="mono feedback-label">REVIEW ></span>
          <el-input
            v-model="feedback"
            size="small"
            placeholder="写下调整意见，重新规划（可多轮），如：测试拆成接口测试和端到端测试"
            @keydown.enter="doReplan"
          />
          <el-button size="small" :loading="replanning" @click="doReplan">重新规划</el-button>
        </div>
        <div class="actions">
          <el-button size="small" @click="cancelTask">取消任务</el-button>
          <el-button size="small" type="primary" :disabled="liveCount === 0" :loading="approving" @click="approve">
            确认执行（{{ liveCount }} 节点）
          </el-button>
        </div>
      </div>
    </div>
  </el-dialog>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue';
import { ElMessage } from 'element-plus';
import { api, type TaskGraph } from '../api';

const props = defineProps<{ modelValue: boolean; taskId: string }>();
const emit = defineEmits<{ (e: 'close'): void; (e: 'started'): void; (e: 'cancelled'): void; (e: 'changed'): void }>();

interface EditableNode {
  id: string;
  name: string;
  agent: string;
  reason: string;
  requires_approval: boolean;
  _editing?: boolean;
  _deleted?: boolean;
  _agentPicked?: boolean;
  _original?: { name: string; agent: string };
}

const task = computed(() => null as TaskGraph | null); // App supplies graph via loader below
const graph = ref<TaskGraph | null>(null);
const editableNodes = ref<EditableNode[]>([]);
const feedback = ref('');
const replanning = ref(false);
const approving = ref(false);
const agentOptions = ref<string[]>([]);

function statusLabel(s?: string) {
  return ({ planned: '待确认', pending: '待执行', running: '执行中', success: '已完成', failed: '失败', cancelled: '已取消', waiting_approval: '待审批' } as Record<string, string>)[s || ''] || s || '';
}
function branchOf(n: EditableNode): string {
  return n.agent === 'orchestrator' ? '' : `⎇ coteam/${n.id}-${n.agent}`;
}

async function onOpen() {
  await reload();
  try {
    const d = await api.listAgents();
    agentOptions.value = ['orchestrator', ...d.agents.map((a) => a.name)];
  } catch {
    agentOptions.value = ['orchestrator', 'dev'];
  }
}

async function reload() {
  const d = await api.getTask(props.taskId);
  graph.value = d;
  editableNodes.value = d.nodes
    .filter((n) => n.id !== 'merge-auto')
    .map((n) => ({ id: n.id, name: n.name, agent: n.agent, reason: n.reason || '', requires_approval: n.requires_approval }));
}

const liveCount = computed(() => editableNodes.value.filter((n) => !n._deleted).length);

function toggleEdit(n: EditableNode) {
  if (n._editing) {
    const orig = n._original || { name: n.name, agent: n.agent };
    void applyNode(n, { name: n.name, agent: n.agent });
  }
  n._editing = !n._editing;
}

async function applyNode(n: EditableNode, patch: { name?: string; agent?: string }) {
  try {
    await api.updateNode(props.taskId, n.id, patch);
    n._original = { name: n.name, agent: n.agent };
    emit('changed');
  } catch (e: any) {
    ElMessage.error(e.message);
  }
}

async function removeNode(n: EditableNode) {
  try {
    await api.updateNode(props.taskId, n.id, { action: 'delete' });
    n._deleted = true;
    emit('changed');
  } catch (e: any) {
    ElMessage.error(e.message);
  }
}

async function doReplan() {
  if (!feedback.value.trim()) {
    ElMessage.warning('先写下调整意见');
    return;
  }
  replanning.value = true;
  try {
    await api.replan(props.taskId, feedback.value.trim());
    feedback.value = '';
    await reload();
    ElMessage.success('已按反馈重新规划');
    emit('changed');
  } catch (e: any) {
    ElMessage.error(e.message);
  } finally {
    replanning.value = false;
  }
}

async function approve() {
  approving.value = true;
  try {
    await api.executeTask(props.taskId);
    ElMessage.success('已确认，任务开始执行');
    emit('started');
    emit('close');
  } catch (e: any) {
    ElMessage.error(e.message);
  } finally {
    approving.value = false;
  }
}

async function cancelTask() {
  try {
    await api.cancelTask(props.taskId);
    ElMessage.info('任务已取消');
    emit('cancelled');
    emit('close');
  } catch (e: any) {
    ElMessage.error(e.message);
  }
}
</script>

<style scoped>
.sheet { font-size: 13px; }
.sheet-head { display: flex; justify-content: space-between; font-size: 10px; color: var(--ct-text3); letter-spacing: 1px; border-bottom: 1px dashed var(--ct-border2); padding-bottom: 8px; }
.doc-status { color: var(--ct-yellow); }
.sheet-desc { margin: 12px 0 16px; color: var(--ct-text); font-weight: 500; }
.entries { display: flex; flex-direction: column; gap: 2px; max-height: 380px; overflow-y: auto; }
.entry { padding: 6px 4px; border-bottom: 1px dotted var(--ct-border); }
.entry.dim { opacity: 0.4; }
.entry-line { display: flex; align-items: center; gap: 8px; }
.entry-no { color: var(--ct-text3); font-size: 11px; }
.leader { flex: 0 0 0; }
.entry-name { color: var(--ct-text); }
.entry-name-input { width: 320px; }
.entry-agent { color: var(--ct-accent); font-size: 11px; }
.entry-agent.orchestrator { color: var(--ct-text3); }
.branch { font-size: 10px; color: var(--ct-text3); }
.stamp { font-size: 9px; border: 1px solid var(--ct-accent); color: var(--ct-accent); border-radius: 2px; padding: 0 4px; transform: rotate(-3deg); }
.stamp.del { color: var(--ct-red); border-color: var(--ct-red); }
.ops { margin-left: auto; display: flex; gap: 4px; align-items: center; }
.margin-note { display: flex; gap: 8px; align-items: center; padding: 2px 0 2px 28px; }
.note-line { width: 24px; height: 1px; background: var(--ct-border2); transform: rotate(-2deg); }
.note-text { font-size: 11px; color: var(--ct-text3); font-style: italic; }
.sign-area { border-top: 2px solid var(--ct-border2); margin-top: 14px; padding-top: 12px; }
.feedback { display: flex; gap: 8px; align-items: center; }
.feedback-label { color: var(--ct-accent); font-size: 11px; font-weight: 600; }
.feedback .el-input { flex: 1; }
.actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 12px; }
</style>
