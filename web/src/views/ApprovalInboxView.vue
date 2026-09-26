<script setup lang="ts">
/**
 * B5 审批收件箱（2026-09-17）：聚合 web 端散落的"等你处理"——节点审批 / 监督者提案 /
 * 待审批命令 / ask 提问 / 节点澄清，一键批准/拒绝/答复。与 mobile ApprovalsView 同一聚合口径。
 * 「去处理」通过全局事件打开任务详情对话框（对话框宿主在 App.vue）。
 */
import { onUnmounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { api } from '../api';
import { useDashboard } from '../composables/useDashboard';
import { showApiError } from '../utils/apiError';

const { tasks, connected } = useDashboard();
const router = useRouter();

interface ApprovalItem {
  key: string;
  kind: 'node' | 'proposal' | 'command' | 'ask' | 'clarify' | 'oc-permission' | 'oc-question';
  taskId: string;
  title: string;
  detail: string;
  act?: (decision: { approved: boolean; answer?: string }) => Promise<void>;
  /** oc-question 专用：提问选项（收件箱内快速 value 作答，仅单问题） */
  questionOptions?: { value: string; label: string; description?: string }[];
  /** oc-question 专用：单问题的字段 key（key-based 作答） */
  questionKey?: string;
  /** oc-question 专用：所属会话（多问题时引导去接管面板逐题作答） */
  sessionId?: string;
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
    // OpenCode 待人工确认（W6）：文件权限审核 + AskUserQuestion 提问——co-team 审批收件箱
    // 一个入口处理所有"等人拍板"（MTR 金标准的"处理人工确认"步）。服务端 SSE 事件驱动聚合。
    try {
      const pending = await api.ocPending();
      for (const p of pending.permissions || []) {
        const pattern = Array.isArray(p.pattern) ? p.pattern.join(' ') : String(p.pattern || '');
        out.push({
          key: `oc-perm:${p.instance}:${p.id}`,
          kind: 'oc-permission',
          taskId: '',
          title: `OpenCode 权限申请 · ${p.title || '执行操作'}`,
          detail: [p.instance_label || p.instance, p.sessionID ? String(p.sessionID).slice(0, 14) : '', pattern].filter(Boolean).join(' · '),
          act: async ({ approved }) => {
            await api.ocResolvePermission(String(p.instance), String(p.sessionID || ''), String(p.id), approved ? 'once' : 'reject');
          },
        });
      }
      for (const q of pending.questions || []) {
        const qs: any[] = q.questions || [];
        const first = qs[0] || {} as any;
        // 多问题时逐题列出（题干 + 选项），快捷选项按钮只在单问题给——多题的作答矩阵去会话面板
        const detail = qs.length <= 1
          ? [first.question, (first.options || []).length ? `选项：${(first.options || []).map((o: any) => o.label).join(' / ')}` : ''].filter(Boolean).join('\n')
          : qs.map((qi: any, i: number) => `${i + 1}. ${qi.header ? `【${qi.header}】` : ''}${qi.question || ''}${(qi.options || []).length ? `\n   选项：${(qi.options || []).map((o: any) => o.label).join(' / ')}` : ''}`).join('\n');
        out.push({
          key: `oc-question:${q.instance}:${q.id}`,
          kind: 'oc-question',
          taskId: '',
          title: `OpenCode 提问 · ${first.header || '征询'}${qs.length > 1 ? `（${qs.length} 个问题）` : ''}`,
          detail,
          act: async ({ approved }) => {
            if (!approved) await api.ocRejectQuestion(String(q.instance), String(q.id));
          },
          /** 提问的选项作答：单问题收件箱里点 label 即答；多问题不设快捷按钮（去会话面板逐题作答） */
          questionOptions: qs.length === 1 ? (first.options || []).map((o: any) => ({ value: String(o.value ?? o.label ?? ''), label: o.label, description: o.description })) : undefined,
          questionKey: first.key ? String(first.key) : undefined,
          sessionId: q.sessionID ? String(q.sessionID) : undefined,
        });
      }
    } catch { /* opencode 未接入/未启动时静默跳过 */ }
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

const kindLabel: Record<string, string> = { node: '节点审批', proposal: '提案', command: '命令审批', ask: '提问', clarify: '澄清', 'oc-permission': 'OpenCode 权限', 'oc-question': 'OpenCode 提问' };
const kindType: Record<string, string> = { node: 'warning', proposal: 'warning', command: 'warning', ask: 'warning', clarify: 'primary', 'oc-permission': 'warning', 'oc-question': 'primary' };
const busy = (key: string) => busyKey.value === key;

/** 提问选项作答：key-based——answer = { [field.key]: option.value }（label→value 由服务端再兜底） */
async function answerOcQuestion(item: ApprovalItem, value: string) {
  busyKey.value = item.key;
  try {
    const [instance, requestId] = item.key.replace('oc-question:', '').split(':');
    await api.ocAnswerQuestion(instance, requestId, { [item.questionKey || '']: value });
    refresh();
  } catch (e: any) {
    showApiError(e);
  } finally {
    busyKey.value = '';
  }
}

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

/** 多问题提问：收件箱的快捷 label 表达不了逐题作答，转接管面板打开对应会话 */
function goSession(item: ApprovalItem) {
  if (!item.sessionId) return;
  const instance = item.key.replace('oc-question:', '').split(':')[0];
  sessionStorage.setItem('coteam:pending-oc-session', JSON.stringify({ instance, sessionId: item.sessionId }));
  if (router.currentRoute.value.path !== '/opencode') router.push('/opencode');
  // 面板已挂载时事件直达；未挂载时面板 mount/loadInstances 消费 sessionStorage 接力棒
  window.dispatchEvent(new CustomEvent('coteam:open-opencode-session', { detail: { instance, sessionId: item.sessionId } }));
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
      <div v-if="it.kind === 'oc-question'" class="ap-actions">
        <!-- 单问题：选项 label 一键作答；多问题：逐题作答去接管面板 -->
        <template v-if="it.questionOptions?.length">
          <el-button
            v-for="o in it.questionOptions"
            :key="o.label"
            size="small"
            type="primary"
            plain
            :title="o.description || ''"
            :loading="busy(it.key)"
            @click="answerOcQuestion(it, o.value)"
          >{{ o.label }}</el-button>
        </template>
        <el-button v-else-if="it.sessionId" size="small" type="primary" plain @click="goSession(it)">去会话回答</el-button>
        <el-button size="small" :loading="busy(it.key)" @click="decide(it, false)">不回答</el-button>
      </div>
      <div v-else-if="it.act" class="ap-actions">
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
