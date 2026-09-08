<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { showToast } from 'vant';
import { marked } from 'marked';
import { api } from '../api';
import type { ProjectSummary, DiscussionMessage } from '../api';
import { useDiscussion } from '../composables/useDiscussion';
import AgentAvatar from '../components/AgentAvatar.vue';
import DirPicker from '../components/DirPicker.vue';

defineOptions({ name: 'DiscussionDetailView' });

const route = useRoute();
const router = useRouter();
const { current, experiences, busy, thinking, open, send, round, stop, generateScheme, saveScheme, setMode, convert } = useDiscussion();

const discId = computed(() => String(route.params.id));
const draft = ref('');
const stickToBottom = ref(true);
const wrapEl = ref<HTMLElement | null>(null);

const members = computed(() => current.value?.members || []);
const status = computed(() => current.value?.status || 'discussing');
const pendingUser = computed(() => !!current.value?.pending_user);
const schemeReady = computed(() => !!current.value?.scheme?.trim());

// ---------- 消息流渲染（微信气泡语言，与 ChatStream 同构） ----------

const TIME_GAP_MS = 5 * 60 * 1000;
type ChatItem = { t: 'time'; label: string } | { t: 'system' | 'user' | 'agent'; m: DiscussionMessage; answered?: boolean };

const items = computed<ChatItem[]>(() => {
  const msgs = current.value?.messages || [];
  const lastUserIdx = msgs.map((m) => m.from).lastIndexOf('user');
  const out: ChatItem[] = [];
  let lastTs = 0;
  for (let i = 0; i < msgs.length; i++) {
    const m = msgs[i];
    const ts = m.ts ? new Date(m.ts.replace(' ', 'T')).getTime() : 0;
    if (ts - lastTs > TIME_GAP_MS) out.push({ t: 'time', label: fmtTime(m.ts) });
    lastTs = ts || lastTs;
    const t = m.from === 'user' ? 'user' : m.from === 'system' ? 'system' : 'agent';
    out.push({ t, m, answered: !!m.needs_user && lastUserIdx > i });
  }
  return out;
});

function fmtTime(ts: string): string {
  if (!ts) return '';
  const d = new Date(ts.replace(' ', 'T'));
  const now = new Date();
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  return d.toDateString() === now.toDateString() ? hm : `${d.getMonth() + 1}月${d.getDate()}日 ${hm}`;
}

function md(text: string): string {
  const escaped = (text || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const html = String(marked.parse(escaped, { async: false, breaks: true }));
  return html.replace(/@([A-Za-z0-9_\-\u4e00-\u9fff]+)/g, '<span class="mention">@$1</span>');
}

async function sendNow() {
  const text = draft.value.trim();
  if (!text) return;
  try {
    await send(text);
    draft.value = '';
    stickToBottom.value = true;
    await nextTick();
    scrollToBottom(true);
  } catch (e: any) {
    showToast(String(e?.message || e));
  }
}

function insertMention(name: string) {
  draft.value = (draft.value + (draft.value && !draft.value.endsWith(' ') ? ' ' : '') + `@${name} `).slice(0, 4000);
}

async function doRound() {
  try { await round(); } catch (e: any) { showToast(String(e?.message || e)); }
}
async function doStop() { await stop(); }

async function doGenScheme() {
  schemeLoading.value = true;
  try {
    await generateScheme();
    showScheme.value = true;
  } catch (e: any) {
    showToast(String(e?.message || e));
  } finally {
    schemeLoading.value = false;
  }
}

function onScroll() {
  const el = wrapEl.value;
  if (!el) return;
  stickToBottom.value = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
}
function scrollToBottom(force = false) {
  const el = wrapEl.value;
  if (!el || (!force && !stickToBottom.value)) return;
  el.scrollTop = el.scrollHeight;
}

watch(
  () => [current.value?.id, current.value?.messages.length, thinking.value],
  () => void nextTick(() => scrollToBottom())
);

onMounted(() => {
  void open(discId.value);
});

// ---------- 模式切换 ----------
const mode = ref<'manual' | 'auto'>('manual');
watch(() => [current.value?.id, current.value?.mode] as const, () => { mode.value = current.value?.mode || 'manual'; }, { immediate: true });
async function onModeChange(v: any) {
  try {
    await setMode(v === 'auto' ? 'auto' : 'manual');
    showToast(v === 'auto' ? '自动模式：成员最多自由讨论 3 轮' : '手动模式：你驱动每轮');
  } catch (e: any) {
    mode.value = current.value?.mode || 'manual';
    showToast(String(e?.message || e));
  }
}

// ---------- 方案弹层 ----------
const showScheme = ref(false);
const schemeLoading = ref(false);
const schemeEditing = ref(false);
const schemeBuffer = ref('');
function startEdit() {
  schemeBuffer.value = current.value?.scheme || '';
  schemeEditing.value = true;
}
async function saveEdit() {
  try {
    await saveScheme(schemeBuffer.value.trim());
    schemeEditing.value = false;
    showToast('方案已保存为新版本');
  } catch (e: any) {
    showToast(String(e?.message || e));
  }
}

// ---------- 转项目弹层 ----------
const showConvert = ref(false);
const showCvProject = ref(false);
const showCvDir = ref(false);
const converting = ref(false);
const projects = ref<ProjectSummary[]>([]);
const cv = ref({ target: 'new' as 'new' | 'existing', name: '', workspace: '', scaffold: true, project_id: '', auto_run: false });
async function openConvert() {
  const bound = current.value?.project_id || '';
  cv.value = { target: bound ? 'existing' : 'new', name: current.value?.title || '', workspace: '', scaffold: true, project_id: bound, auto_run: false };
  try { projects.value = (await api.listProjects()).projects || []; } catch { /* ignore */ }
  // 新建项目：预填 <projects.root>/<标题 slug>，用户可改
  if (!bound) {
    try {
      const r = await api.projectsRoot();
      const slug = (current.value?.title || '').trim().replace(/[\\/:*?"<>|\s]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'project';
      cv.value.workspace = `${(r.root || '').replace(/[\\/]$/, '')}\\${slug}`;
    } catch { /* 拿不到就手填 */ }
  }
  showConvert.value = true;
}
async function doConvert() {
  if (cv.value.target === 'new' && !cv.value.workspace.trim()) { showToast('填写工作区绝对路径'); return; }
  if (cv.value.target === 'existing' && !cv.value.project_id) { showToast('选择要挂入的项目'); return; }
  converting.value = true;
  try {
    const res = await convert({
      target: cv.value.target,
      name: cv.value.name.trim() || undefined,
      workspace: cv.value.workspace.trim() || undefined,
      scaffold: cv.value.scaffold,
      project_id: cv.value.project_id || undefined,
      auto_run: cv.value.auto_run,
    });
    showConvert.value = false;
    showToast('已转项目开发');
    router.push(`/task/${res.task_id}`);
  } catch (e: any) {
    showToast(String(e?.message || e));
  } finally {
    converting.value = false;
  }
}

// ---------- 沉淀经验弹层 ----------
const showExp = ref(false);
</script>

<template>
  <div class="disc-detail">
    <van-nav-bar :title="current ? `${current.title}(${current.members.length})` : '群组讨论'" left-arrow fixed placeholder @click-left="router.back()">
      <template #right>
        <span class="nav-op" @click="showExp = true">经验{{ experiences.length ? ` ${experiences.length}` : '' }}</span>
      </template>
    </van-nav-bar>

    <div ref="wrapEl" class="stream" @scroll="onScroll">
      <div v-if="!current" class="center-tip">加载中…</div>
      <div v-else-if="!items.length" class="center-tip">还没有讨论内容<br />发一条消息，或点「继续讨论」让成员开场</div>

      <template v-for="(item, i) in items" :key="i">
        <div v-if="item.t === 'time'" class="time-divider">{{ item.label }}</div>
        <div v-else-if="item.t === 'system'" class="sys-row"><span>{{ item.m.text }}</span></div>
        <div v-else-if="item.t === 'user'" class="row me">
          <div class="me-col"><div class="bubble me-b">{{ item.m.text }}</div></div>
          <AgentAvatar name="master" :size="34" class="av" />
        </div>
        <div v-else class="row them">
          <AgentAvatar :name="item.m.from" :size="34" class="av" />
          <div class="them-col">
            <div class="who">{{ item.m.from }}</div>
            <div :class="['bubble', 'them-b', { ask: item.m.needs_user, answered: item.m.needs_user && item.answered }]">
              <div v-if="item.m.needs_user" class="ask-tag">{{ item.answered ? '@你 已回复' : '@你 待拍板' }}</div>
              <div class="b-text" v-html="md(item.m.text)"></div>
            </div>
          </div>
        </div>
      </template>

      <div v-if="thinking" class="row them">
        <AgentAvatar :name="thinking" :size="34" class="av" />
        <div class="them-col">
          <div class="who">{{ thinking }}</div>
          <div class="bubble them-b typing-b"><span class="dot"></span><span class="dot"></span><span class="dot"></span><span class="typing-label">正在思考是否发言…</span></div>
        </div>
      </div>
    </div>

    <div v-if="pendingUser" class="pending-bar">有成员需要你拍板，回复一条消息即可继续</div>

    <div class="input-zone">
      <div v-if="members.length" class="chips-row">
        <span class="chip-label">@点名：</span>
        <span v-for="m in members" :key="m" class="mention-chip" @click="insertMention(m)">@{{ m }}</span>
      </div>
      <div class="input-row">
        <van-field v-model="draft" type="textarea" rows="1" autosize max-length="4000" placeholder="可 @agent 指定发言，也可补充或修正方向" />
        <van-button type="primary" size="small" :disabled="!draft.trim() || status === 'converted'" @click="sendNow">发送</van-button>
      </div>
      <div class="op-row">
        <van-radio-group v-model="mode" direction="horizontal" @change="onModeChange">
          <van-radio name="manual" :disabled="busy">手动</van-radio>
          <van-radio name="auto" :disabled="busy">自动</van-radio>
        </van-radio-group>
        <div class="ops">
          <van-button v-if="busy" size="mini" type="warning" plain @click="doStop">停止</van-button>
          <van-button v-else size="mini" plain :disabled="status === 'converted'" @click="doRound">继续讨论</van-button>
          <van-button size="mini" plain :loading="schemeLoading" :disabled="status === 'converted'" @click="doGenScheme">生成方案</van-button>
          <van-button v-if="status !== 'converted'" size="mini" type="success" :disabled="!schemeReady" @click="openConvert">转项目</van-button>
          <van-button v-else size="mini" type="primary" plain @click="router.push(`/task/${current!.task_id}`)">查看任务 ›</van-button>
          <van-button size="mini" plain :disabled="!current?.scheme" @click="showScheme = true">方案{{ current?.scheme_version ? ` v${current.scheme_version}` : '' }}</van-button>
        </div>
      </div>
    </div>

    <!-- 方案弹层 -->
    <van-popup v-model:show="showScheme" position="bottom" round :style="{ height: '80%' }">
      <div class="sheet">
        <div class="sheet-head">
          <span class="sheet-title">项目规划方案 · v{{ current?.scheme_version || 0 }}</span>
          <span class="sheet-op" @click="showScheme = false">关闭</span>
        </div>
        <div v-if="!current?.scheme" class="center-tip">方案尚未生成——讨论后点「生成方案」</div>
        <template v-else>
          <div v-if="!schemeEditing" class="scheme-md" v-html="md(current.scheme)"></div>
          <van-field v-else v-model="schemeBuffer" type="textarea" rows="18" autosize />
          <div class="sheet-ops">
            <template v-if="schemeEditing">
              <van-button size="small" @click="schemeEditing = false">取消</van-button>
              <van-button size="small" type="primary" @click="saveEdit">保存（版本 +1）</van-button>
            </template>
            <template v-else>
              <van-button size="small" @click="startEdit">人工编辑</van-button>
              <van-button size="small" type="primary" @click="doGenScheme">重新生成</van-button>
            </template>
          </div>
        </template>
      </div>
    </van-popup>

    <!-- 转项目弹层 -->
    <van-popup v-model:show="showConvert" position="bottom" round :style="{ maxHeight: '80%' }">
      <div class="sheet">
        <div class="sheet-head"><span class="sheet-title">方案转项目开发</span><span class="sheet-op" @click="showConvert = false">关闭</span></div>
        <van-radio-group v-model="cv.target" direction="horizontal" class="cv-target">
          <van-radio name="new">新建项目</van-radio>
          <van-radio name="existing">挂入已有项目</van-radio>
        </van-radio-group>
        <template v-if="cv.target === 'new'">
          <van-field v-model="cv.name" label="项目名称" placeholder="例如：会员系统" />
          <van-field v-model="cv.workspace" label="工作区" placeholder="绝对路径，或点「选择」浏览">
            <template #button><span class="pick-dir" @click="showCvDir = true">选择</span></template>
          </van-field>
          <van-field label="初始化"><template #input><van-checkbox v-model="cv.scaffold">标准脚手架（目录+文档+git）</van-checkbox></template></van-field>
        </template>
        <van-field v-else label="项目" readonly is-link :model-value="projects.find(p => p.id === cv.project_id)?.name || '选择项目'" @click="showCvProject = true" />
        <van-field label="执行"><template #input><van-checkbox v-model="cv.auto_run">规划完成后直接进队列执行</van-checkbox></template></van-field>
        <div class="cv-note">讨论即澄清：任务不再重复需求澄清；方案、待定事项与沉淀经验随任务交给执行团队。</div>
        <div class="sheet-ops"><van-button block round type="primary" :loading="converting" @click="doConvert">转为项目开发</van-button></div>
      </div>
    </van-popup>
    <van-popup v-model:show="showCvProject" position="bottom" round>
      <van-picker
        :columns="projects.map((p) => ({ text: p.name, value: p.id }))"
        @confirm="({ selectedValues }) => { cv.project_id = String(selectedValues[0] || ''); showCvProject = false; }"
        @cancel="showCvProject = false"
      />
    </van-popup>
    <DirPicker v-model:show="showCvDir" title="选择工作区目录" @pick="cv.workspace = $event" />

    <!-- 沉淀经验弹层 -->
    <van-popup v-model:show="showExp" position="bottom" round :style="{ maxHeight: '70%' }">
      <div class="sheet">
        <div class="sheet-head"><span class="sheet-title">本讨论沉淀经验（{{ experiences.length }}）</span><span class="sheet-op" @click="showExp = false">关闭</span></div>
        <van-empty v-if="!experiences.length" image="search" description="成员发言中的经验/踩坑/决策理由会自动沉淀到这里与知识库" />
        <div v-for="e in experiences" :key="e.id" class="exp-item">
          <div class="exp-title">{{ e.title }}</div>
          <div class="exp-src">来源 {{ e.source }} · {{ (e.updated_at || '').slice(0, 10) }}</div>
          <div class="exp-body">{{ e.content }}</div>
        </div>
      </div>
    </van-popup>
  </div>
</template>

<style scoped>
/* 用 100%（根容器为 100dvh）而非 100vh：后者按工具栏隐藏的大视口计算，
   浏览器地址栏展开时底部输入区与操作行会被顶出可视区且无法滚动（遮挡 BUG） */
.disc-detail { display: flex; flex-direction: column; height: 100%; background: #f7f8fa; }
.nav-op { font-size: 12px; color: #1989fa; }
.stream { flex: 1; overflow-y: auto; padding: 10px 10px 4px; display: flex; flex-direction: column; gap: 10px; }
.center-tip { text-align: center; color: #969799; font-size: 12px; padding: 40px 20px; line-height: 1.8; }
.time-divider { align-self: center; font-size: 10px; color: #969799; background: #ebedf0; border-radius: 4px; padding: 2px 8px; }
.sys-row { display: flex; justify-content: center; }
.sys-row span { font-size: 10px; color: #969799; background: #ebedf0; border-radius: 4px; padding: 2px 10px; max-width: 88%; text-align: center; }
.row { display: flex; gap: 8px; }
.row.me { justify-content: flex-end; }
.them-col { display: flex; flex-direction: column; align-items: flex-start; max-width: 78%; min-width: 0; }
.me-col { display: flex; flex-direction: column; align-items: flex-end; max-width: 78%; }
.who { font-size: 10px; color: #969799; margin: 0 2px 2px; }
.bubble { padding: 8px 11px; border-radius: 9px; font-size: 14px; line-height: 1.55; word-break: break-word; }
.me-b { background: #95ec69; color: #0b2e13; border-top-right-radius: 2px; }
.them-b { background: #fff; border: 1px solid #ebedf0; border-top-left-radius: 2px; color: #323233; }
.b-text :deep(.mention) { color: #1989fa; background: #ecf5ff; border-radius: 3px; padding: 0 3px; font-weight: 600; }
.b-text :deep(code) { font-size: 12px; background: #f7f8fa; border-radius: 3px; padding: 0 3px; }
.b-text :deep(p) { margin: 0 0 4px; }
.b-text :deep(p:last-child) { margin: 0; }
.b-text :deep(ul), .b-text :deep(ol) { margin: 2px 0; padding-left: 16px; }
.them-b.ask { border: 1.5px solid #ff976a; }
.ask-tag { display: inline-block; font-size: 10px; color: #fff; background: #ff976a; border-radius: 3px; padding: 0 5px; margin-bottom: 4px; }
.them-b.answered .ask-tag { background: #c8c9cc; }
.typing-b { display: flex; align-items: center; gap: 3px; }
.dot { width: 5px; height: 5px; border-radius: 50%; background: #c8c9cc; animation: bob 1.2s infinite; }
.dot:nth-child(2) { animation-delay: 0.15s; }
.dot:nth-child(3) { animation-delay: 0.3s; }
@keyframes bob { 0%, 60%, 100% { transform: translateY(0); opacity: 0.4; } 30% { transform: translateY(-4px); opacity: 1; } }
.typing-label { font-size: 10px; color: #969799; margin-left: 4px; }
.pending-bar { margin: 0 10px 4px; font-size: 11px; color: #ff976a; border: 1px dashed #ff976a; border-radius: 6px; padding: 4px 8px; }
.input-zone { background: #fff; border-top: 1px solid #ebedf0; padding: 6px 8px calc(8px + env(safe-area-inset-bottom)); }
.chips-row { display: flex; flex-wrap: wrap; gap: 5px; align-items: center; margin-bottom: 4px; }
.chip-label { font-size: 10px; color: #969799; }
.mention-chip { font-size: 11px; color: #1989fa; border: 1px solid #d4e6ff; border-radius: 10px; padding: 1px 8px; background: #f4f8ff; }
.input-row { display: flex; gap: 6px; align-items: flex-end; }
.input-row :deep(.van-field) { flex: 1; background: #f7f8fa; border-radius: 6px; padding: 4px 8px; }
.op-row { display: flex; justify-content: space-between; align-items: center; gap: 6px; margin-top: 4px; flex-wrap: wrap; }
.op-row :deep(.van-radio) { margin-right: 8px; }
.ops { display: flex; gap: 4px; flex-wrap: wrap; margin-left: auto; }
.sheet { padding: 14px 16px calc(20px + env(safe-area-inset-bottom)); overflow-y: auto; height: 100%; }
.pick-dir { font-size: 13px; color: #1989fa; padding: 2px 8px; border: 1px solid #d4e6ff; border-radius: 4px; background: #f4f8ff; }
.sheet-head { display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px; }
.sheet-title { font-size: 15px; font-weight: 700; }
.sheet-op { font-size: 12px; color: #1989fa; }
.sheet-ops { display: flex; gap: 8px; justify-content: flex-end; margin-top: 14px; }
.scheme-md { font-size: 13px; line-height: 1.65; color: #323233; }
.scheme-md :deep(h1) { font-size: 16px; margin: 4px 0 8px; }
.scheme-md :deep(h2) { font-size: 14px; margin: 12px 0 4px; border-bottom: 1px solid #ebedf0; padding-bottom: 3px; }
.cv-target { margin-bottom: 8px; }
.cv-note { font-size: 11px; color: #969799; margin-top: 10px; line-height: 1.6; }
.exp-item { padding: 8px 0; border-bottom: 1px solid #f2f3f5; }
.exp-title { font-size: 13px; font-weight: 600; }
.exp-src { font-size: 10px; color: #969799; margin: 2px 0; }
.exp-body { font-size: 12px; color: #646566; white-space: pre-wrap; }
</style>
