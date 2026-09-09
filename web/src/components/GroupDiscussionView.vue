<template>
  <div class="gdv">
    <aside class="gd-list">
      <div class="gd-list-head">
        <span class="mono">群组讨论</span>
        <el-button size="small" type="primary" @click="createVisible = true">发起讨论</el-button>
      </div>
      <div v-if="!list.length" class="gd-empty mono">还没有讨论。发起一场：说出想法，成员谁有话说谁上，能动手就直接动手。</div>
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
          <div class="gh-left">
            <div class="gh-title">{{ current.title }}</div>
            <div class="gh-sub mono">
              <template v-if="boundProject">
                <el-tag size="small" type="success" effect="plain">{{ boundProject.name }}</el-tag>
                <span class="gh-hint">已绑定项目 · 成员可读文件、执行命令、小改代码并重启验证</span>
              </template>
              <template v-else>
                <span class="gh-hint">未绑定项目：挂接后成员才能动手（讨论设置里可选）</span>
              </template>
              <template v-if="current.task_id"> · 任务 {{ current.task_id }}</template>
              <template v-if="current.scheme_version"> · 方案 v{{ current.scheme_version }}</template>
            </div>
          </div>
          <!-- 成员头像堆叠（点击看资料卡），像真群聊的群成员 -->
          <div class="gh-members">
            <el-popover v-for="m in current.members" :key="m" placement="bottom" :width="240" trigger="click">
              <template #reference>
                <span class="gh-av"><AgentAvatar :name="m" :size="30" :title="`${roleOf(m)} · ${m}`" /></span>
              </template>
              <div class="member-card">
                <div class="mc-head">
                  <AgentAvatar :name="m" :size="34" />
                  <div>
                    <div class="mc-role" :style="{ color: agentColor(m) }">{{ roleOf(m) }}</div>
                    <div class="mc-id mono">{{ m }}</div>
                  </div>
                </div>
                <div class="mc-tags mono">{{ agentTags(m) }}</div>
                <div class="mc-last mono" v-if="lastSaid(m)">上次发言：{{ shortTime(lastSaid(m)!) }}</div>
              </div>
            </el-popover>
          </div>
          <div class="gh-ops">
            <el-button size="small" :disabled="!current.scheme" @click="schemeVisible = true">查看方案</el-button>
            <el-button size="small" :loading="genLoading" :disabled="converted" @click="onGenScheme">生成方案</el-button>
            <el-button v-if="!converted" size="small" type="success" :disabled="!current.scheme" @click="convertVisible = true">转为项目开发</el-button>
            <el-button v-else size="small" @click="emit('open-task', current.task_id!)">查看开发任务 ›</el-button>
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
          <DiscussionChat @member-info="(m) => ElMessage.info(`${m} · ${roleOf(m)}`)" />
        </div>
      </template>
      <div v-else class="gd-placeholder mono">
        ← 选择左侧讨论，或点「发起讨论」新建<br /><br />
        群组聊天式协作：谁有话说谁上、能动手就直接动手；讨论可一键转为项目规划与开发任务。
      </div>
    </main>

    <!-- 发起讨论 -->
    <el-dialog v-model="createVisible" title="发起群组讨论" width="560px">
      <el-form label-width="88px" size="small">
        <el-form-item label="讨论话题">
          <el-input v-model="form.title" placeholder="一句话概括想解决什么，例如：把记账 app 在 5123 跑起来" />
        </el-form-item>
        <el-form-item label="需求背景">
          <el-input v-model="form.topic" type="textarea" :rows="3" placeholder="可选：目标用户、约束、偏好技术等" />
        </el-form-item>
        <el-form-item label="参与成员">
          <el-checkbox-group v-model="form.members">
            <el-checkbox v-for="a in agents" :key="a.name" :value="a.name" :label="a.name">{{ a.role || a.description }}（{{ a.name }}）</el-checkbox>
          </el-checkbox-group>
        </el-form-item>
        <el-form-item label="讨论模式">
          <el-radio-group v-model="form.mode">
            <el-radio value="manual">手动（你一句它一句）</el-radio>
            <el-radio value="auto">自动（一条消息驱动多轮）</el-radio>
          </el-radio-group>
        </el-form-item>
        <el-form-item label="挂入项目">
          <el-select v-model="form.project_id" clearable placeholder="强烈建议绑定：成员可读写项目文件、执行命令、小改代码并重启验证" style="width: 100%">
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
import { computed, onMounted, reactive, ref } from 'vue';
import { ElMessage } from 'element-plus';
import { api, type AgentInfo, type ProjectSummary } from '../api';
import { useDiscussion } from '../composables/useDiscussion';
import { statusText } from '../utils/events';
import { agentColor } from '../utils/agentColor';
import DiscussionChat from './DiscussionChat.vue';
import SchemePanel from './SchemePanel.vue';
import DiscussionConvertDialog from './DiscussionConvertDialog.vue';
import AgentAvatar from './AgentAvatar.vue';

const emit = defineEmits<{ (e: 'open-task', taskId: string): void }>();

const { list, current, experiences, busy, roles, open, create, remove, loadList, generateScheme } = useDiscussion();

const agents = ref<AgentInfo[]>([]);
const projects = ref<ProjectSummary[]>([]);
const createVisible = ref(false);
const schemeVisible = ref(false);
const convertVisible = ref(false);
const expOpen = ref(false);
const genLoading = ref(false);
const form = reactive({ title: '', topic: '', members: [] as string[], mode: 'manual' as 'manual' | 'auto', project_id: '' });

const converted = computed(() => current.value?.status === 'converted');
const boundProject = computed(() => projects.value.find((p) => p.id === current.value?.project_id) || null);

function roleOf(name: string): string {
  return roles.value[name] || agents.value.find((a) => a.name === name)?.role || name;
}
function agentTags(name: string): string {
  const a = agents.value.find((x) => x.name === name);
  if (!a) return '';
  return [(a.tags || []).join('/'), a.modelOverride ? `模型 ${a.modelOverride}` : ''].filter(Boolean).join(' · ');
}
function lastSaid(name: string): string | null {
  const msgs = current.value?.messages || [];
  for (let i = msgs.length - 1; i >= 0; i--) if (msgs[i].from === name) return msgs[i].ts;
  return null;
}

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
  genLoading.value = true;
  schemeVisible.value = true;
  try {
    await generateScheme();
  } catch (e: any) {
    ElMessage.error(String(e?.message || e));
  } finally {
    genLoading.value = false;
  }
}

function statusTag(s: string) {
  return s === 'converted' ? 'success' : s === 'converged' ? 'warning' : 'info';
}

function shortTime(ts?: string): string {
  if (!ts) return '';
  const d = new Date(ts);
  const diff = Date.now() - d.getTime();
  if (diff < 60_000) return '刚刚';
  if (diff < 3600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 24 * 3600_000) return `${Math.floor(diff / 3600_000)} 小时前`;
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

// busy 状态供模板提示（避免未用告警：用于输入区文案已在子组件；这里仅内部引用）
void busy;
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
.gh-left { min-width: 0; }
.gh-title { font-size: 15px; font-weight: 700; color: var(--ct-text); }
.gh-sub { font-size: 10px; color: var(--ct-text3); display: flex; align-items: center; gap: 6px; flex-wrap: wrap; margin-top: 2px; }
.gh-hint { opacity: 0.85; }
.gh-members { display: flex; margin-left: 8px; }
.gh-av { margin-left: -6px; border: 2px solid var(--ct-panel); border-radius: 8px; cursor: pointer; }
.gh-av:first-child { margin-left: 0; }
.member-card { display: flex; flex-direction: column; gap: 6px; }
.mc-head { display: flex; align-items: center; gap: 8px; }
.mc-role { font-size: 13px; font-weight: 700; }
.mc-id { font-size: 10px; color: var(--ct-text3); }
.mc-tags, .mc-last { font-size: 10px; color: var(--ct-text3); }
.gh-ops { margin-left: auto; display: flex; gap: 6px; flex-wrap: wrap; }

.gd-exp { border-bottom: 1px solid var(--ct-border); padding: 8px 14px; max-height: 180px; overflow-y: auto; background: var(--ct-bg); }
.exp-item { margin-bottom: 8px; }
.exp-title { font-size: 12px; color: var(--ct-text); font-weight: 600; margin-bottom: 2px; }
.exp-body { font-size: 11px; color: var(--ct-text3); white-space: pre-wrap; }
.empty-line { font-size: 11px; color: var(--ct-text3); }

.gd-chat { flex: 1; min-height: 0; }
.gd-placeholder { flex: 1; display: flex; align-items: center; justify-content: center; text-align: center; color: var(--ct-text3); font-size: 12px; line-height: 2; }
.mono { font-family: var(--ct-mono); }
</style>
