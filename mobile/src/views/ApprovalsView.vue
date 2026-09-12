<script setup lang="ts">
/**
 * M10-C 我的审批：聚合收件箱——把散落在各任务详情里的"等你处理"集中到一个流：
 * 节点审批 / 监督者提案 / 待审批命令 / ask 提问 / 节点澄清。全部一键处理。
 */
import { onUnmounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { showToast } from 'vant';
import { api } from '../api';
import StatusTag from '../components/StatusTag.vue';
import { useDashboard } from '../composables/useDashboard';

const router = useRouter();
const { tasks, connected } = useDashboard();

interface ApprovalItem {
  key: string;
  kind: 'node' | 'proposal' | 'command' | 'ask' | 'clarify';
  taskId: string;
  title: string;
  detail: string;
  /** 直接可执行的动作（一键批准/拒绝/答复） */
  act?: (decision: { approved: boolean; answer?: string }) => Promise<void>;
}

const items = ref<ApprovalItem[]>([]);
const loading = ref(false);
const busyKey = ref('');
let timer: ReturnType<typeof setInterval> | null = null;

const NEED_HUMAN_STATUSES = ['waiting_approval', 'clarifying', 'running', 'retrying', 'waiting_clarify'];

async function load() {
  loading.value = true;
  const out: ApprovalItem[] = [];
  const graphs = Object.values(tasks.value).filter((t) => NEED_HUMAN_STATUSES.includes(t.status));
  try {
    await Promise.all(
      graphs.map(async (t) => {
        // 1) waiting_approval 节点——直接一键批准
        for (const n of t.nodes || []) {
          if (n.status === 'waiting_approval') {
            out.push({
              key: `node:${t.task_id}:${n.id}`,
              kind: 'node',
              taskId: t.task_id,
              title: `节点「${n.name}」等待审批`,
              detail: n.reason || '该节点被标记为需要人工审批后才能执行',
              act: async ({ approved }) => {
                if (approved) {
                  await api.approveNode(t.task_id, n.id);
                  showToast('已批准，任务恢复执行');
                } else {
                  showToast('节点审批请在任务详情中处理（取消需谨慎）');
                }
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
        // 2) 监督者提案
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
                showToast(approved ? '提案已批准并执行' : '提案已拒绝');
              },
            });
          }
        } catch { /* task may be gone */ }
        // 3) 待审批命令
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
                showToast(approved ? '命令已批准执行' : '命令已拒绝');
              },
            });
          }
        } catch { /* optional */ }
        // 4) 未答 ask
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
                showToast('已回答，agent 将继续');
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
timer = setInterval(refresh, 10000);
onUnmounted(() => { if (timer) clearInterval(timer); });

const kindLabel: Record<string, string> = { node: '节点审批', proposal: '提案', command: '命令审批', ask: '提问', clarify: '澄清' };
const busy = (key: string) => busyKey.value === key;
async function decide(item: ApprovalItem, approved: boolean) {
  if (!item.act) return;
  busyKey.value = item.key;
  try {
    await item.act({ approved });
    await load();
  } catch (e: any) {
    showToast(e?.message || '操作失败');
  } finally {
    busyKey.value = '';
  }
}
const goTask = (taskId: string) => router.push(`/task/${taskId}`);
</script>

<template>
  <div class="page">
    <van-nav-bar title="我的审批" fixed placeholder left-arrow @click-left="router.back()" />
    <div class="body">
      <div class="conn mono" :class="{ ok: connected }">{{ connected ? '实时同步中' : '离线——重连后自动刷新' }}</div>
      <van-empty v-if="!loading && !items.length" description="当前没有等你处理的事项" />
      <div v-for="it in items" :key="it.key" class="wx-group ap-card">
        <div class="ap-head">
          <StatusTag :status="it.kind === 'ask' ? 'waiting_approval' : it.kind" :label="kindLabel[it.kind] || it.kind" />
          <span class="ap-task mono" @click="goTask(it.taskId)">{{ it.taskId }} ›</span>
        </div>
        <div class="ap-title">{{ it.title }}</div>
        <div v-if="it.detail" class="ap-detail">{{ it.detail }}</div>
        <div v-if="it.act" class="ap-actions">
          <van-button size="small" type="primary" :loading="busy(it.key)" @click="decide(it, true)">批准</van-button>
          <van-button size="small" :loading="busy(it.key)" @click="decide(it, false)">拒绝</van-button>
          <van-button size="small" plain @click="goTask(it.taskId)">详情</van-button>
        </div>
        <div v-else class="ap-actions">
          <van-button size="small" plain type="primary" @click="goTask(it.taskId)">去处理</van-button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.page { height: 100dvh; display: flex; flex-direction: column; background: var(--bg); }
.body { flex: 1; min-height: 0; overflow-y: auto; padding-bottom: 16px; }
.conn { font-size: var(--fs-xs); color: var(--text-3); padding: 10px 16px 0; }
.conn.ok { color: var(--ct-green); }
.ap-card { margin: 10px 16px; }
.ap-head { display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px; }
.ap-task { font-size: var(--fs-xs); color: var(--ct-accent); }
.ap-title { font-size: var(--fs-md); font-weight: 600; margin-bottom: 4px; }
.ap-detail { font-size: var(--fs-sm); color: var(--text-2); margin-bottom: 8px; word-break: break-all; }
.ap-actions { display: flex; gap: 8px; }
</style>
