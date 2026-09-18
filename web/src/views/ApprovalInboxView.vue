<script setup lang="ts">
/**
 * B5 审批收件箱（2026-09-17）：聚合 web 端散落的"等你处理"——节点审批 / 监督者提案 /
 * 待审批命令 / ask 提问 / 节点澄清，一键批准/拒绝/答复。与 mobile ApprovalsView 同一聚合口径。
 * 「去处理」通过全局事件打开任务详情对话框（对话框宿主在 App.vue）。
 */
import { onUnmounted, ref } from 'vue';
import { api } from '../api';
import { useDashboard } from '../composables/useDashboard';
import { showApiError } from '../utils/apiError';

const { tasks, connected } = useDashboard();

interface ApprovalItem {
  key: string;
  kind: 'node' | 'proposal' | 'command' | 'ask' | 'clarify';
  taskId: string;
  title: string;
  detail: string;
  act?: (decision: { approved: boolean; answer?: string }) => Promise<void>;
  rejectable?: boolean;
}

const items = ref<ApprovalItem[]>([]);
const loading = ref(false);
const busyKey = ref('');
const answering = ref('');
const answerDraft = ref('');
let timer: ReturnType<typeof setInterval> | null = null;

const NEED_HUMAN_STATUSES = ['waiting_approval', 'clarifying', 'running', 'retrying', 'waiting_clarify'];

async function load() {
  loading.value = true;
  const out: ApprovalItem[] = [];
  // useDashboard 的 tasks 是 reactive 对象（非 ref）——取 .value 会是 undefined，直接遍历本身
  const graphs = Object.values(tasks).filter((t) => NEED_HUMAN_STATUSES.includes(t.status) && !!t.task_id);
  try {
    await Promise.all(
      graphs.map(async (t) => {
        for (const n of t.nodes || []) {
          if (n.status === 'waiting_approval') {
            out.push({
              key: `node:${t.task_id}:${n.id}`,
              kind: 'node',
              taskId: t.task_id,
              title: `节点「${n.name}」等待审批`,
              detail: n.reason || '该节点被标记为需要人工审批后才能执行',
              act: async ({ approved }) => {
                if (!approved) return;
                await api.approveNode(t.task_id, n.id);
              },
            });
          }
          if (n.status === 'waiting_clarify') {
            out.push({
              key: `clarify:${t.task_id}:${n.id}`,
              kind: 'clarify',
              taskId: t.task_id,
              title: `节点「${n.name}」等待澄清确认`,
              detail: n.result?.summary || 'agent 已提交实施简报，等待你确认或补充',
            });
          }
        }
        try {
          const ps = (await api.listProposals(t.task_id)).proposals || [];
          for (const p of ps.filter((x) => x.status === 'pending')) {
            out.push({
              key: `proposal:${t.task_id}:${p.id}`,
              kind: 'proposal',
              taskId: t.task_id,
              title: `监督者提案：${p.type === 'derive_task' ? '派生修复任务' : p.type}`,
              detail: p.reason || '',
              act: async ({ approved }) => {
                await api.decideProposal(t.task_id, p.id, approved);
              },
              rejectable: true,
            });
          }
        } catch { /* task may be gone */ }
        try {
          const cs = (await (api as any).getPendingCommands?.(t.task_id))?.commands || [];
          for (const c of cs) {
            out.push({
              key: `command:${t.task_id}:${c.id}`,
              kind: 'command',
              taskId: t.task_id,
              title: `命令待审批：${String(c.command || '').slice(0, 60)}`,
              detail: `节点 ${c.node_name || c.node_id || ''}`,
              act: async ({ approved }) => {
                await api.resolveCommand(t.task_id, c.id, approved);
              },
              rejectable: true,
            });
          }
        } catch { /* optional */ }
        try {
          const asks = ((await api.listAsks(t.task_id)) as any).asks || [];
          for (const a of asks.filter((x: any) => x.status === 'pending')) {
            out.push({
              key: `ask:${t.task_id}:${a.id}`,
              kind: 'ask',
              taskId: t.task_id,
              title: `${a.from} 提问：${String(a.question || '').slice(0, 80)}`,
              detail: 'agent 已挂起等待你的回答',
              act: async ({ answer }) => {
                if (!answer) return;
                await api.answerAsk(t.task_id, a.id, answer);
              },
            });
          }
        } catch { /* optional */ }
      })
    );
    items.value = out;
  } finally {
    loading.value = false;
  }
}

function refresh() {
  void load();
}
refresh();
timer = setInterval(() => { if (document.visibilityState === 'visible') refresh(); }, 10_000);
onUnmounted(() => { if (timer) clearInterval(timer); });

const kindLabel: Record<string, string> = { node: '节点审批', proposal: '提案', command: '命令审批', ask: '提问', clarify: '澄清' };
const kindType: Record<string, string> = { node: 'warning', proposal: 'warning', command: 'warning', ask: 'warning', clarify: 'primary' };
const busy = (key: string) => busyKey.value === key;

async function decide(item: ApprovalItem, approved: boolean, answer?: string) {
  if (!item.act) return;
  busyKey.value = item.key;
  try {
    await item.act({ approved, answer });
    await load();
  } catch (e) {
    showApiError(e, '操作失败');
  } finally {
    busyKey.value = '';
    if (answering.value === item.key) { answering.value = ''; answerDraft.value = ''; }
  }
}

function toggleAnswer(key: string) {
  answering.value = answering.value === key ? '' : key;
  answerDraft.value = '';
}

/** 打开任务详情对话框（宿主在 App.vue，走全局事件——与 coteam:unauthorized 同风格） */
function goTask(taskId: string) {
  window.dispatchEvent(new CustomEvent('coteam:open-task', { detail: taskId }));
}
</script>

<template>
  <div class="inbox" v-loading="loading && !items.length">
    <div class="inbox-head">
      <span>共 {{ items.length }} 项等你处理</span>
      <el-button size="small" @click="refresh">刷新</el-button>
    </div>
    <el-empty v-if="!loading && !items.length" description="当前没有等你处理的事项" />
    <div v-for="it in items" :key="it.key" class="ap-card">
      <div class="ap-head">
        <el-tag size="small" :type="(kindType[it.kind] as any) || 'info'">{{ kindLabel[it.kind] || it.kind }}</el-tag>
        <span class="ap-task mono" @click="goTask(it.taskId)">{{ it.taskId }} ›</span>
      </div>
      <div class="ap-title">{{ it.title }}</div>
      <div v-if="it.detail" class="ap-detail">{{ it.detail }}</div>
      <div v-if="it.act" class="ap-actions">
        <el-button size="small" type="primary" :loading="busy(it.key)" @click="decide(it, true)">批准</el-button>
        <el-button v-if="it.rejectable" size="small" :loading="busy(it.key)" @click="decide(it, false)">拒绝</el-button>
        <el-button v-if="it.kind === 'ask'" size="small" @click="toggleAnswer(it.key)">{{ answering === it.key ? '收起' : '作答' }}</el-button>
        <el-button size="small" plain @click="goTask(it.taskId)">详情</el-button>
      </div>
      <div v-if="answering === it.key" class="ap-answer">
        <el-input v-model="answerDraft" type="textarea" :rows="2" placeholder="输入你的回答，agent 将继续执行" />
        <el-button size="small" type="primary" :loading="busy(it.key)" :disabled="!answerDraft.trim()" @click="decide(it, true, answerDraft)">发送回答</el-button>
      </div>
      <div v-else-if="!it.act" class="ap-actions">
        <el-button size="small" plain type="primary" @click="goTask(it.taskId)">去处理</el-button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.inbox { padding: 4px 0; }
.inbox-head { display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px; color: var(--text-2); font-size: 13px; }
.ap-card { border: 1px solid var(--el-border-color-lighter); border-radius: 8px; padding: 10px 12px; margin-bottom: 10px; background: var(--el-bg-color); }
.ap-head { display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px; }
.ap-task { font-size: 12px; color: var(--el-color-primary); cursor: pointer; }
.ap-title { font-size: 13px; font-weight: 600; margin-bottom: 4px; }
.ap-detail { font-size: 12px; color: var(--text-2); margin-bottom: 8px; white-space: pre-wrap; }
.ap-actions { display: flex; gap: 8px; }
.ap-answer { margin-top: 8px; display: flex; flex-direction: column; gap: 6px; align-items: flex-end; }
</style>
