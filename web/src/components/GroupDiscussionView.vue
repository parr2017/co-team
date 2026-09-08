<template>
  <div class="gdv">
    <aside class="gd-list">
      <div class="gd-list-head">
        <span class="mono">群组讨论</span>
        <el-button size="small" type="primary" @click="createVisible = true">发起讨论</el-button>
      </div>
      <div v-if="!list.length" class="gd-empty mono">还没有讨论。发起一场：勾选成员，说出想法，方案在这里长出来。</div>
      <button
        v-for="d in list"
        :key="d.id"
        class="gd-card"
        :class="{ active: current?.id === d.id }"
        @click="open(d.id)"
      >
        <div class="gc-top">
          <span class="gc-title">{{ d.title }}</span>
          <el-tag size="small" :type="statusTag(d.status)">{{ statusText(d.status) }}</el-tag>
        </div>
        <div class="gc-meta mono">
          {{ d.members.length }} 成员 · {{ d.message_count || 0 }} 条 · {{ shortTime(d.updated_at) }}
          <span v-if="d.pending_user" class="gc-pending">待你拍板</span>
        </div>
      </button>
    </aside>

    <main class="gd-main">
      <template v-if="current">
        <header class="gd-head">
          <div class="gh-title">{{ current.title }}</div>
          <div class="gh-sub mono">
            成员 {{ current.members.join('、') }}<template v-if="current.project_id"> · 挂入项目 {{ current.project_id }}</template><template v-if="current.task_id"> · 任务 {{ current.task_id }}</template>
            <template v-if="current.scheme_version"> · 方案 v{{ current.scheme_version }}</template>
          </div>
          <div class="gh-ops">
            <el-button size="small" :disabled="!current.scheme" @click="schemeVisible = true">查看方案</el-button>
            <el-button size="small" @click="expOpen = !expOpen">沉淀经验{{ experiences.length ? ` (${experiences.length})` : '' }}</el-button>
            <el-popconfirm title="删除该讨论及其记录？" @confirm="remove(current.id)">
              <template #reference><el-button size="small" type="danger" plain>删除</el-button></template>
            </el-popconfirm>
          </div>
        </header>

        <div v-if="expOpen" class="gd-exp">
          <div v-if="!experiences.length" class="mono empty-line">本讨论暂未沉淀经验——成员在发言中写出经验/踩坑/决策理由时会自动进入知识库。</div>
          <div v-for="e in experiences" :key="e.id" class="exp-item">
            <div class="exp-title mono">{{ e.title }} <el-tag size="small" type="success">{{ e.tags?.find(t => t !== '群组讨论') || '经验' }}</el-tag></div>
            <div class="exp-body">{{ e.content }}</div>
          </div>
        </div>

        <div class="gd-chat">
          <DiscussionChat @gen-scheme="onGenScheme" @convert="convertVisible = true" @open-task="emit('open-task', current.task_id!)" />
        </div>
      </template>
      <div v-else class="gd-placeholder mono">
        ← 选择左侧讨论，或点「发起讨论」新建<br /><br />
        群组沟通 → 自主讨论 → 生成项目规划方案 → 转项目开发；过程中成员经验自动沉淀到项目知识库。
      </div>
    </main>

    <!-- 发起讨论 -->
    <el-dialog v-model="createVisible" title="发起群组讨论" width="560px">
      <el-form label-width="88px" size="small">
        <el-form-item label="讨论话题">
          <el-input v-model="form.title" placeholder="一句话概括想规划什么，例如：做一个个人记账 Web 应用" />
        </el-form-item>
        <el-form-item label="需求背景">
          <el-input v-model="form.topic" type="textarea" :rows="3" placeholder="可选：目标用户、约束、偏好技术等" />
        </el-form-item>
        <el-form-item label="参与成员">
          <el-checkbox-group v-model="form.members">
            <el-checkbox v-for="a in agents" :key="a.name" :value="a.name" :label="a.name">{{ a.name }}（{{ a.role || a.description }}）</el-checkbox>
          </el-checkbox-group>
        </el-form-item>
        <el-form-item label="讨论模式">
          <el-radio-group v-model="form.mode">
            <el-radio value="manual">手动（你驱动每轮）</el-radio>
            <el-radio value="auto">自动（成员多轮讨论）</el-radio>
          </el-radio-group>
        </el-form-item>
        <el-form-item label="挂入项目">
          <el-select v-model="form.project_id" clearable placeholder="可选：经验与方案直接沉淀到该项目" style="width: 100%">
            <el-option v-for="p in projects" :key="p.id" :label="p.name" :value="p.id" />
          </el-select>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button size="small" @click="createVisible = false">取消</el-button>
        <el-button size="small" type="primary" :disabled="!form.title.trim() || !form.members.length" @click="doCreate">开始讨论</el-button>
      </template>
    </el-dialog>

    <SchemePanel v-model="schemeVisible" />
    <DiscussionConvertDialog v-model="convertVisible" @converted="(r) => emit('open-task', r.task_id)" />
  </div>
</template>

<script setup lang="ts">
import { onMounted, reactive, ref } from 'vue';
import { ElMessage } from 'element-plus';
import { api, type AgentInfo, type ProjectSummary } from '../api';
import { useDiscussion } from '../composables/useDiscussion';
import { statusText } from '../utils/events';
import DiscussionChat from './DiscussionChat.vue';
import SchemePanel from './SchemePanel.vue';
import DiscussionConvertDialog from './DiscussionConvertDialog.vue';

const emit = defineEmits<{ (e: 'open-task', taskId: string): void }>();

const { list, current, experiences, open, create, remove, loadList, generateScheme } = useDiscussion();

const agents = ref<AgentInfo[]>([]);
const projects = ref<ProjectSummary[]>([]);
const createVisible = ref(false);
const schemeVisible = ref(false);
const convertVisible = ref(false);
const expOpen = ref(false);
const form = reactive({ title: '', topic: '', members: [] as string[], mode: 'manual' as 'manual' | 'auto', project_id: '' });

onMounted(async () => {
  await loadList();
  void api.listAgents().then((r) => (agents.value = r.agents)).catch(() => undefined);
  void api.listProjects().then((r) => (projects.value = r.projects)).catch(() => undefined);
});

async function doCreate() {
  try {
    await create({
      title: form.title.trim(),
      topic: form.topic.trim() || undefined,
      members: form.members,
      mode: form.mode,
      project_id: form.project_id || undefined,
    });
    createVisible.value = false;
    form.title = '';
    form.topic = '';
    form.members = [];
    form.project_id = '';
  } catch (e: any) {
    ElMessage.error(String(e?.message || e));
  }
}

async function onGenScheme() {
  schemeVisible.value = true;
  try {
    await generateScheme();
  } catch (e: any) {
    ElMessage.error(String(e?.message || e));
  }
}

function statusTag(s: string) {
  return s === 'converted' ? 'success' : s === 'converged' ? 'warning' : 'info';
}

function shortTime(ts?: string): string {
  if (!ts) return '';
  const d = new Date(ts);
  const now = Date.now();
  const diff = now - d.getTime();
  if (diff < 60_000) return '刚刚';
  if (diff < 3600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 24 * 3600_000) return `${Math.floor(diff / 3600_000)} 小时前`;
  return `${d.getMonth() + 1}/${d.getDate()}`;
}
</script>

<style scoped>
.gdv { display: flex; gap: 12px; height: calc(100vh - 130px); min-height: 480px; }
.gd-list { width: 280px; flex-shrink: 0; display: flex; flex-direction: column; gap: 8px; border: 1px solid var(--ct-border); border-radius: 10px; background: var(--ct-panel); padding: 10px; overflow-y: auto; }
.gd-list-head { display: flex; justify-content: space-between; align-items: center; font-size: 13px; font-weight: 600; color: var(--ct-text); }
.gd-empty { font-size: 11px; color: var(--ct-text3); padding: 20px 8px; line-height: 1.8; }
.gd-card { text-align: left; background: var(--ct-bg); border: 1px solid var(--ct-border); border-radius: 8px; padding: 8px 10px; cursor: pointer; }
.gd-card:hover { border-color: var(--ct-border2); }
.gd-card.active { border-color: var(--ct-accent); box-shadow: 0 0 0 1px var(--ct-accent); }
.gc-top { display: flex; justify-content: space-between; align-items: center; gap: 6px; }
.gc-title { font-size: 13px; color: var(--ct-text); font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.gc-meta { font-size: 10px; color: var(--ct-text3); margin-top: 4px; }
.gc-pending { color: var(--ct-accent); font-weight: 600; }

.gd-main { flex: 1; display: flex; flex-direction: column; min-width: 0; border: 1px solid var(--ct-border); border-radius: 10px; background: var(--ct-panel); }
.gd-head { padding: 10px 14px; border-bottom: 1px solid var(--ct-border); display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
.gh-title { font-size: 15px; font-weight: 700; color: var(--ct-text); }
.gh-sub { font-size: 10px; color: var(--ct-text3); }
.gh-ops { margin-left: auto; display: flex; gap: 6px; }

.gd-exp { border-bottom: 1px solid var(--ct-border); padding: 8px 14px; max-height: 180px; overflow-y: auto; background: var(--ct-bg); }
.exp-item { margin-bottom: 8px; }
.exp-title { font-size: 12px; color: var(--ct-text); font-weight: 600; margin-bottom: 2px; }
.exp-body { font-size: 11px; color: var(--ct-text3); white-space: pre-wrap; }
.empty-line { font-size: 11px; color: var(--ct-text3); }

.gd-chat { flex: 1; min-height: 0; }
.gd-placeholder { flex: 1; display: flex; align-items: center; justify-content: center; text-align: center; color: var(--ct-text3); font-size: 12px; line-height: 2; }
</style>
