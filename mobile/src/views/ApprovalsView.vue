<script setup lang="ts">
/**
 * M10-C 我的审批：聚合收件箱——把散落在各任务详情里的"等你处理"集中到一个流：
 * 节点审批 / 监督者提案 / 待审批命令 / ask 提问 / 节点澄清。全部一键处理。
 */
import { computed, onUnmounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { showToast, showConfirmDialog } from 'vant';
import { api } from '../api';
import StatusTag from '../components/StatusTag.vue';
import MdView from '../components/MdView.vue';
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
  /** 服务端是否有真实拒绝语义（节点审批/ask 只能批准或答复，不显示假拒绝按钮） */
  rejectable?: boolean;
}

const items = ref<ApprovalItem[]>([]);
const loading = ref(false);
const busyKey = ref('');
let timer: ReturnType<typeof setInterval> | null = null;

const NEED_HUMAN_STATUSES = ['waiting_approval', 'clarifying', 'running', 'retrying', 'waiting_clarify'];

async function load() {
  loading.value = true;
  const out: ApprovalItem[] = [];
  const graphs = Object.values(tasks.value).filter((t) => NEED_HUMAN_STATUSES.includes(t.status) && !!t.task_id);
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
                if (!approved) return;
                await api.approveNode(t.task_id, n.id);
                showToast('已批准，任务恢复执行');
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
              rejectable: true,
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
              rejectable: true,
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

const refreshing = ref(false);
async function onRefresh() {
  refreshing.value = true;
  await load();
  refreshing.value = false;
}
function refresh() {
  void load();
}
refresh();
timer = setInterval(() => { if (document.visibilityState === 'visible') void refresh(); }, 10000);
onUnmounted(() => { if (timer) clearInterval(timer); });

const presentKinds = computed(() => {
  const order = ['node', 'proposal', 'command', 'ask', 'clarify'];
  return order.filter((k) => items.value.some((x) => x.kind === k));
});
const kindLabel: Record<string, string> = { node: '节点审批', proposal: '提案', command: '命令审批', ask: '提问', clarify: '澄清' };
/** kind 不在 StatusTag 语义表内，映射到相近的审批语义色 */
const kindTone: Record<string, string> = { node: 'waiting_approval', proposal: 'waiting_approval', command: 'waiting_approval', ask: 'waiting_approval', clarify: 'waiting_clarify' };
const busy = (key: string) => busyKey.value === key;
async function decide(item: ApprovalItem, approved: boolean) {
  if (!item.act) return;
  if (!approved && item.kind === 'command') {
    // 拒绝敏感命令需确认，防误触
    try {
      await showConfirmDialog({ title: '拒绝命令', message: '确定拒绝该命令？agent 将收到拒绝结果并继续。' });
    } catch { return; }
  }
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
    <van-nav-bar safe-area-inset-top title="我的审批" fixed placeholder left-arrow @click-left="router.back()" />
    <div class="body">
      <div class="conn mono" :class="{ ok: connected }">{{ connected ? '实时同步中' : '离线——重连后自动刷新' }}</div>
      <van-pull-refresh v-model="refreshing" @refresh="onRefresh">
      <van-skeleton v-if="loading && !items.length" :row="3" class="sk" />
      <van-empty v-else-if="!loading && !items.length" description="当前没有等你处理的事项" />
      <template v-for="kind in presentKinds" :key="kind">
        <div class="secttl">{{ kindLabel[kind] || kind }}</div>
        <div v-for="it in items.filter((x) => x.kind === kind)" :key="it.key" class="wx-group ap-card">
        <div class="ap-head">
          <StatusTag :status="kindTone[it.kind]" :label="kindLabel[it.kind] || it.kind" />
          <span class="ap-task mono" @click="goTask(it.taskId)">{{ it.taskId }} ›</span>
        </div>
        <div class="ap-title">{{ it.title }}</div>
        <MdView v-if="it.detail" class="ap-detail" :source="it.detail" />
        <div v-if="it.act" class="ap-actions">
          <van-button size="small" type="primary" :loading="busy(it.key)" @click="decide(it, true)">批准</van-button>
          <van-button v-if="it.rejectable" size="small" class="reject-btn" :loading="busy(it.key)" @click="decide(it, false)">拒绝</van-button>
          <van-button size="small" plain @click="goTask(it.taskId)">详情</van-button>
        </div>
        <div v-else class="ap-actions">
          <van-button size="small" plain type="primary" @click="goTask(it.taskId)">去处理</van-button>
        </div>
        </div>
      </template>
      </van-pull-refresh>
    </div>
  </div>
</template>

<style scoped>
.page { height: 100dvh; display: flex; flex-direction: column; background: var(--bg); }
.body { flex: 1; min-height: 0; overflow-y: auto; padding-bottom: calc(16px + env(safe-area-inset-bottom)); }
.conn { font-size: var(--fs-xs); color: var(--text-3); padding: 10px 16px 0; }
.conn.ok { color: var(--ct-green); }
.ap-card { margin: 10px 16px; }
.ap-head { display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px; }
.ap-task { font-size: var(--fs-xs); color: var(--ct-accent); max-width: 60%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ap-title { font-size: var(--fs-md); font-weight: 600; margin-bottom: 4px; }
.ap-detail { font-size: var(--fs-sm); color: var(--text-2); margin-bottom: 8px; }
.ap-actions { display: flex; gap: 8px; }
.sk { padding: 16px; }
.body .van-pull-refresh { min-height: 40vh; }

/* 预览稿：分节 mono 标题 + 拒绝 danger 形态 */
.secttl {
  font-size: var(--fs-meta); color: var(--text-3); font-family: var(--font-mono);
  letter-spacing: .08em; text-transform: uppercase; padding: 14px 14px 6px;
  display: flex; align-items: center; gap: 8px;
}
.secttl::after { content: ""; flex: 1; height: 1px; background: var(--line); }
.reject-btn { background: color-mix(in srgb, var(--danger) 12%, transparent); color: var(--danger); border: 1px solid color-mix(in srgb, var(--danger) 30%, transparent); }
.ap-actions .van-button { height: 34px; }
</style>
