<template>
  <div class="gdv">
    <!-- 左：讨论列表（264px，IDE 侧栏形态） -->
    <aside class="disc-list">
      <div class="side-head"><span>讨论</span><span class="cnt mono">{{ filteredList.length }}</span></div>
      <div class="search">
        <span class="search-ic">⌕</span>
        <input v-model="search" placeholder="搜索讨论…" />
      </div>
      <div class="disc-scroll">
        <div v-if="!list.length" class="gd-empty">还没有讨论。发起一场：说出想法，成员谁有话说谁上，能动手就直接动手。</div>
        <div v-else-if="!filteredList.length" class="gd-empty">没有匹配「{{ search }}」的讨论</div>
        <button
          v-for="d in filteredList"
          :key="d.id"
          class="disc-item"
          :class="{ active: current?.id === d.id }"
          @click="open(d.id)"
        >
          <div class="t">
            <span class="name">{{ d.title }}</span>
            <span class="tag" :class="statusTagClass(d.status)">{{ statusText(d.status) }}</span>
          </div>
          <div class="last">
            <template v-if="d.pending_user"><span class="pending-mark">待你拍板</span> · </template>{{ d.members.length }} 成员 · {{ d.message_count || 0 }} 条
          </div>
          <div class="meta"><span class="time mono">{{ shortTime(d.updated_at) }}</span></div>
        </button>
      </div>
      <div class="disc-foot">
        <button class="new-disc-btn" @click="createVisible = true">+ 发起讨论</button>
      </div>
    </aside>

    <!-- 中：消息流 + 输入区（DiscussionChat 内含右侧详情面板） -->
    <main class="chat-main">
      <template v-if="current">
        <header class="chat-head">
          <div class="ch-title">{{ current.title }}</div>
          <span v-if="boundProject" class="tag">{{ boundProject.name }}</span>
          <span class="tag" :class="current.mode === 'auto' ? 'tag-accent' : ''">{{ current.mode === 'auto' ? '自动模式' : '手动模式' }}</span>
          <span v-if="current.task_id" class="tag mono" @click="emit('open-task', current.task_id)" style="cursor:pointer">任务 {{ current.task_id }}<template v-if="taskCount > 1"> +{{ taskCount - 1 }}</template></span>
          <span v-if="current.scheme_version" class="tag mono">方案 v{{ current.scheme_version }}</span>
          <div class="spacer"></div>
          <!-- 成员头像堆叠（点击看资料卡） -->
          <div class="gh-members">
            <el-popover v-for="m in current.members" :key="m" placement="bottom" :width="240" trigger="click">
              <template #reference>
                <span class="gh-av"><AgentAvatar :name="m" :size="24" :title="`${roleOf(m)} · ${m}`" /></span>
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
          <div class="ch-ops">
            <button class="op-btn" :disabled="!current.scheme" @click="schemeVisible = true">查看方案</button>
            <button class="op-btn" :disabled="genLoading || converted" @click="onGenScheme">{{ genLoading ? '生成中…' : '生成方案' }}</button>
            <!-- 转任务不封存（2026-09-15）：converted 时按钮保留但需先发消息复活讨论 -->
            <button
              class="op-btn accent"
              :disabled="!current.scheme || converted"
              :title="converted ? '发一条消息重新开启群聊后，即可再转后续任务' : ''"
              @click="convertVisible = true"
            >转任务</button>
            <button v-if="current.task_id" class="op-btn" @click="emit('open-task', current.task_id!)">开发任务 ›</button>
            <button class="op-btn" @click="expOpen = !expOpen">沉淀经验{{ experiences.length ? ` (${experiences.length})` : '' }}</button>
            <el-popconfirm title="删除该讨论及其记录？" @confirm="remove(current.id)">
              <template #reference><button class="op-btn danger">删除</button></template>
            </el-popconfirm>
          </div>
        </header>

        <div v-if="expOpen" class="gd-exp">
          <div v-if="!experiences.length" class="empty-line">本讨论暂未沉淀经验——成员在发言中写出经验/踩坑/决策理由时会自动进入知识库。</div>
          <div v-for="e in experiences" :key="e.id" class="exp-item">
            <div class="exp-title">{{ e.title }} <span class="tag tag-ok">{{ e.tags?.find(t => t !== '群组讨论') || '经验' }}</span></div>
            <MdView class="exp-body" :source="e.content" />
          </div>
        </div>

        <div class="gd-chat">
          <DiscussionChat @member-info="(m) => ElMessage.info(`${m} · ${roleOf(m)}`)" />
        </div>
      </template>
      <div v-else class="gd-placeholder">
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
import MdView from './MdView.vue';
import { relativeTime } from '../utils/time';
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
const search = ref('');
const form = reactive({ title: '', topic: '', members: [] as string[], mode: 'manual' as 'manual' | 'auto', project_id: '' });

const filteredList = computed(() => {
  const q = search.value.trim().toLowerCase();
  if (!q) return list.value;
  return list.value.filter((d) => (d.title || '').toLowerCase().includes(q));
});

const converted = computed(() => current.value?.status === 'converted');
const taskCount = computed(() => current.value?.task_ids?.length || (current.value?.task_id ? 1 : 0));
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

function statusTagClass(s: string) {
  return s === 'converted' ? 'tag-ok' : s === 'converged' ? 'tag-warn' : '';
}

function shortTime(ts?: string): string {
  return relativeTime(ts);
}

// busy 状态供模板提示（避免未用告警：用于输入区文案已在子组件；这里仅内部引用）
void busy;
</script>

<style scoped>
/* ===== 满宽三栏：列表 264 / 消息流 flex / 详情 360（详情面板在 DiscussionChat 内常驻可收） ===== */
.gdv { display: flex; height: 100%; min-height: 0; }

/* ---------- 左：讨论列表 ---------- */
.disc-list {
  width: var(--disc-w); flex: none; display: flex; flex-direction: column;
  border-right: 1px solid var(--line); background: var(--bg-panel);
}
.side-head {
  padding: 12px 14px 8px; font-size: var(--fs-meta); color: var(--text-3);
  font-family: var(--font-mono); letter-spacing: .08em; text-transform: uppercase;
  display: flex; justify-content: space-between; align-items: center;
}
.search {
  margin: 0 12px 10px; height: 28px; display: flex; align-items: center; gap: 7px; padding: 0 9px;
  background: var(--bg-overlay); border: 1px solid var(--line); border-radius: var(--r-ctl);
  transition: border-color .15s;
}
.search:focus-within { border-color: var(--accent-line); }
.search-ic { color: var(--text-3); font-size: 13px; }
.search input { flex: 1; min-width: 0; border: none; outline: none; background: transparent; color: var(--text-1); font-size: 12.5px; }
.search input::placeholder { color: var(--text-3); }
.disc-scroll { flex: 1; overflow-y: auto; padding: 0 8px 12px; }
.disc-item {
  width: 100%; text-align: left; padding: 9px 10px; border-radius: 8px; border: 1px solid transparent;
  display: block; margin-bottom: 2px; position: relative; background: none; cursor: pointer; color: inherit;
}
.disc-item:hover { background: var(--bg-raised); }
.disc-item.active { background: var(--bg-raised); border-color: var(--line); }
.disc-item.active::before {
  content: ""; position: absolute; left: 0; top: 9px; bottom: 9px; width: 2px; border-radius: 2px; background: var(--accent);
}
.disc-item .t { display: flex; align-items: center; gap: 8px; margin-bottom: 2px; }
.disc-item .name { font-size: 13.5px; font-weight: 600; color: var(--text-1); flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.disc-item .last { font-size: var(--fs-aux); color: var(--text-2); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.disc-item .meta { display: flex; justify-content: space-between; align-items: center; margin-top: 4px; }
.disc-item .time { font-size: var(--fs-meta); color: var(--text-3); }
.pending-mark { color: var(--accent); font-weight: 600; }
.disc-foot { padding: 6px 10px 10px; }
.new-disc-btn {
  width: calc(100% - 0px); height: 26px; border-radius: var(--r-ctl); border: 1px solid transparent;
  background: transparent; color: var(--text-3); font-size: 12px; cursor: pointer;
  transition: background .15s, color .15s, border-color .15s;
}
.new-disc-btn:hover { background: var(--bg-raised); color: var(--text-1); border-color: var(--line); }
.gd-empty { font-size: var(--fs-aux); color: var(--text-3); padding: 20px 10px; line-height: 1.8; }

/* 通用 tag（发丝线 mono 小标签） */
.tag {
  display: inline-flex; align-items: center; height: 18px; padding: 0 7px; border-radius: 4px; flex: none;
  font-size: var(--fs-meta); font-family: var(--font-mono); letter-spacing: .02em;
  color: var(--text-2); background: var(--bg-raised); border: 1px solid var(--line);
}
.tag-ok { color: var(--ok); background: color-mix(in srgb, var(--ok) 10%, transparent); border-color: color-mix(in srgb, var(--ok) 25%, transparent); }
.tag-warn { color: var(--warn); background: color-mix(in srgb, var(--warn) 10%, transparent); border-color: color-mix(in srgb, var(--warn) 25%, transparent); }
.tag-accent { color: var(--accent); background: var(--accent-soft); border-color: var(--accent-line); }

/* ---------- 中：聊天主区 ---------- */
.chat-main { flex: 1; min-width: 0; display: flex; flex-direction: column; background: var(--bg-page); }
.chat-head {
  height: 46px; flex: none; display: flex; align-items: center; gap: 10px; padding: 0 18px;
  border-bottom: 1px solid var(--line); background: var(--bg-panel); flex-wrap: nowrap; min-width: 0;
}
.ch-title { font-size: var(--fs-title); font-weight: 700; color: var(--text-1); min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 0 1 auto; }
.spacer { flex: 1; }
.gh-members { display: flex; }
.gh-av { margin-left: -6px; border: 2px solid var(--bg-panel); border-radius: 7px; cursor: pointer; }
.gh-av:first-child { margin-left: 0; }
.member-card { display: flex; flex-direction: column; gap: 6px; }
.mc-head { display: flex; align-items: center; gap: 8px; }
.mc-role { font-size: 13px; font-weight: 700; }
.mc-id { font-size: var(--fs-meta); color: var(--text-3); }
.mc-tags, .mc-last { font-size: var(--fs-meta); color: var(--text-3); }
.ch-ops { display: flex; gap: 2px; flex-wrap: nowrap; overflow-x: auto; scrollbar-width: none; flex: none; }
.ch-ops::-webkit-scrollbar { display: none; }
.op-btn {
  height: 24px; padding: 0 9px; border-radius: var(--r-ctl); border: 1px solid transparent;
  background: transparent; color: var(--text-2); font-size: 12px; white-space: nowrap; cursor: pointer;
  transition: background .15s, color .15s, border-color .15s;
}
.op-btn:hover:not(:disabled) { background: var(--bg-raised); color: var(--text-1); border-color: var(--line); }
.op-btn:disabled { opacity: .45; cursor: not-allowed; }
.op-btn.accent { color: var(--accent); }
.op-btn.accent:hover:not(:disabled) { border-color: var(--accent-line); background: var(--accent-soft); color: var(--accent); }
.op-btn.danger { color: var(--danger); }
.op-btn.danger:hover:not(:disabled) { border-color: color-mix(in srgb, var(--danger) 30%, transparent); background: color-mix(in srgb, var(--danger) 10%, transparent); color: var(--danger); }

/* 经验沉淀折叠区 */
.gd-exp { border-bottom: 1px solid var(--line); padding: 10px 18px; max-height: 180px; overflow-y: auto; background: var(--bg-panel); }
.exp-item { margin-bottom: 8px; }
.exp-title { font-size: var(--fs-aux); color: var(--text-1); font-weight: 600; margin-bottom: 2px; display: flex; align-items: center; gap: 6px; }
.exp-body { font-size: var(--fs-aux); color: var(--text-2); white-space: pre-wrap; }
.empty-line { font-size: var(--fs-aux); color: var(--text-3); }

.gd-chat { flex: 1; min-height: 0; }
.gd-placeholder { flex: 1; display: flex; align-items: center; justify-content: center; text-align: center; color: var(--text-3); font-size: var(--fs-aux); line-height: 2; }
.mono { font-family: var(--font-mono); }
</style>
