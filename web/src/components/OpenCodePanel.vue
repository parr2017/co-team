<template>
  <div class="oc-page">
    <!-- 左栏：实例 + 会话（接管入口） -->
    <aside class="oc-side">
      <div class="side-head">
        <span class="side-title">外部运行时 · OpenCode</span>
        <el-button size="small" text :loading="loadingInstances" @click="loadInstances">刷新</el-button>
      </div>
      <div v-if="!instances.length && !loadingInstances" class="side-empty">
        <div class="empty-title">没有可接管实例</div>
        <div class="empty-desc">
          在 <code>config.yaml</code> 的 <code>opencode.instances</code> 配置：<br />
          <code>managed</code> = co-team 拉起 serve（模型注入）；<br />
          <code>attached-desktop/cli</code> = 接管正在跑的实例。
        </div>
      </div>
      <div class="side-list">
        <div
          v-for="inst in instances"
          :key="inst.id"
          class="inst-card"
          :class="{ open: expandedId === inst.id, active: activeInstanceId === inst.id, disabled: !inst.enabled }"
          @click="toggleInstance(inst)"
        >
          <div class="inst-head">
            <i class="dot" :class="inst.state" />
            <span class="inst-name">{{ inst.label || inst.id }}</span>
            <span class="kind-tag" :class="inst.kind">{{ KIND_LABEL[inst.kind] || inst.kind }}</span>
            <span class="mode-tag" :class="inst.mode">{{ inst.mode === 'control' ? '可控' : '只读' }}</span>
          </div>
          <div class="inst-meta">
            <span class="state-text" :class="inst.state">{{ STATE_LABEL[inst.state] || inst.state }}</span>
            <span v-if="inst.version" class="dim mono">v{{ inst.version }}</span>
            <span v-if="inst.project_root" class="root" :title="inst.project_root">{{ shortRoot(inst.project_root) }}</span>
          </div>
          <div v-if="inst.error" class="inst-err" :title="inst.error">{{ inst.error }}</div>
          <div class="inst-ops" @click.stop>
            <el-button v-if="inst.kind === 'managed' && inst.state !== 'connected'" size="small" :loading="busyInstance === inst.id && busyAction === 'start'" @click="startInstance(inst)">启动</el-button>
            <el-button v-if="inst.kind === 'managed' && inst.state === 'connected'" size="small" :loading="busyInstance === inst.id && busyAction === 'stop'" @click="stopInstance(inst)">停止</el-button>
            <el-button v-if="inst.state === 'connected'" size="small" text :loading="creatingSession === inst.id" @click="createAndTakeover(inst)">新建并接管</el-button>
          </div>

          <!-- 会话列表：本项目 / 全部项目 切换 + 项目徽标 -->
          <div v-if="expandedId === inst.id && inst.state === 'connected'" class="sess-box" @click.stop>
            <div class="sess-head">
              <span class="sess-lab">会话</span>
              <span class="scope-switch">
                <button class="sc" :class="{ on: scope === 'current' }" @click="setScope('current')">本项目 {{ counts.current }}</button>
                <button class="sc" :class="{ on: scope === 'all' }" @click="setScope('all')">全部 {{ counts.all }}</button>
              </span>
            </div>
            <div v-if="!filteredSessions.length && !loadingSessions" class="sess-empty">
              该实例在 {{ shortRoot(inst.project_root || '（未知项目）') }} 下还没有会话——在右侧给它下达指令即创建
            </div>
            <div
              v-for="s in filteredSessions"
              :key="s.id"
              class="sess-item"
              :class="{ active: s.id === activeSessionId && inst.id === activeInstanceId }"
              @click="openSession(inst, s)"
            >
              <span class="sess-title" :title="s.title || s.id">{{ s.title || '（未命名会话）' }}</span>
              <span v-if="s.parentID" class="child-tag" title="子会话（任务/子代理派生）">子</span>
              <span v-if="scope === 'all' && projectOf(inst, s)" class="proj-tag" :title="projectOf(inst, s)">{{ basename(projectOf(inst, s)) }}</span>
              <span class="sess-id mono">{{ shortId(s.id) }}</span>
              <span class="sess-time" :title="fullTime(s)">{{ relTime(s) }}</span>
            </div>
          </div>
        </div>
      </div>
    </aside>

    <!-- 右栏：TUI 同构对话 -->
    <section class="oc-main">
      <OpenCodeChat
        v-if="activeInstance && activeSessionId"
        :key="activeInstanceId + ':' + activeSessionId"
        :instance="activeInstance"
        :session-id="activeSessionId"
      />
      <div v-else class="chat-empty">
        <div class="big">接管一个 opencode 对话</div>
        <div class="sm">从会话列表明确选择一个会话，或点击「新建并接管」创建全新会话。co-team 不再自动猜测当前对话。</div>
      </div>
    </section>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { ElMessage } from 'element-plus';
import { api, type OcInstance, type OcSession } from '../api';
import { useDashboard } from '../composables/useDashboard';
import { showApiError } from '../utils/apiError';
import OpenCodeChat from './OpenCodeChat.vue';

const { onEvent } = useDashboard();

const KIND_LABEL: Record<string, string> = { managed: '托管', 'attached-cli': '接管 · CLI', 'attached-desktop': '接管 · 桌面版' };
const STATE_LABEL: Record<string, string> = { stopped: '未启动', starting: '启动中', running: '运行中', connected: '已连接', error: '异常' };

const instances = ref<OcInstance[]>([]);
const loadingInstances = ref(false);
const expandedId = ref('');
const sessions = ref<OcSession[]>([]);
const allSessions = ref<OcSession[]>([]);
const loadingSessions = ref(false);
const scope = ref<'current' | 'all'>('current');
const busyInstance = ref('');
const busyAction = ref<'start' | 'stop' | ''>('');
const creatingSession = ref('');
const activeInstanceId = ref('');
const activeSessionId = ref('');

const activeInstance = computed(() => instances.value.find((i) => i.id === activeInstanceId.value) || null);
const counts = computed(() => ({ current: currentSessions.value.length, all: allSessions.value.length }));
const filteredSessions = computed(() => (scope.value === 'all' ? allSessions.value : currentSessions.value));

/** 本项目 = session.directory 与实例 project_root 归一化后相等（Windows 大小写/斜杠不敏感） */
function norm(p: string): string {
  return p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}
const currentSessions = computed(() => {
  const root = norm(activeInstanceId.value ? (instances.value.find((i) => i.id === activeInstanceId.value)?.project_root || '') : '');
  if (!root) return allSessions.value;
  return allSessions.value.filter((s) => norm(s.directory || '') === root);
});

function projectOf(inst: OcInstance, s: OcSession): string {
  if (norm(s.directory || '') === norm(inst.project_root || '')) return '';
  return s.directory || '';
}
function basename(p: string): string {
  const segs = p.replace(/\\/g, '/').split('/').filter(Boolean);
  return segs[segs.length - 1] || p;
}
function setScope(v: 'current' | 'all'): void {
  scope.value = v;
}
function shortId(id: string): string {
  return id.length > 12 ? id.slice(0, 8) + '…' : id;
}
/** 会话最近更新时间（v2 SessionInfo.time.updated；兜底 created） */
function sessionTs(s: OcSession): number {
  const t = s.time as Record<string, unknown> | undefined;
  return Number(t?.updated || t?.created || 0);
}
function relTime(s: OcSession): string {
  const ts = sessionTs(s);
  if (!ts) return '';
  const diff = Date.now() - ts;
  if (diff < 60_000) return '刚刚';
  if (diff < 3_600_000) return Math.floor(diff / 60_000) + ' 分钟前';
  if (diff < 86_400_000) return Math.floor(diff / 3_600_000) + ' 小时前';
  if (diff < 7 * 86_400_000) return Math.floor(diff / 86_400_000) + ' 天前';
  const d = new Date(ts);
  return `${d.getMonth() + 1}/${d.getDate()}`;
}
function fullTime(s: OcSession): string {
  const ts = sessionTs(s);
  return ts ? new Date(ts).toLocaleString() : '';
}
function shortRoot(p: string): string {
  const segs = p.replace(/\\/g, '/').split('/').filter(Boolean);
  return segs.length > 2 ? '…/' + segs.slice(-2).join('/') : p;
}

async function loadInstances() {
  loadingInstances.value = true;
  try {
    const d = await api.ocInstances();
    instances.value = d.instances || [];
  } catch (e: any) {
    showApiError(e);
  } finally {
    loadingInstances.value = false;
  }
}

async function loadSessions(inst: OcInstance) {
  loadingSessions.value = true;
  try {
    const d = await api.ocSessions(inst.id);
    allSessions.value = d.sessions || [];
  } catch (e: any) {
    showApiError(e);
    allSessions.value = [];
  } finally {
    loadingSessions.value = false;
  }
}

function toggleInstance(inst: OcInstance) {
  if (expandedId.value === inst.id) {
    expandedId.value = '';
    return;
  }
  expandedId.value = inst.id;
  scope.value = 'current';
  void loadSessions(inst);
}

function openSession(inst: OcInstance, s: OcSession) {
  activeInstanceId.value = inst.id;
  activeSessionId.value = s.id;
}

/** 新建并接管：不碰 heuristic 选中的会话，从全新会话开始（co-team 派活的安全路径） */
async function createAndTakeover(inst: OcInstance) {
  creatingSession.value = inst.id;
  try {
    const created = await api.ocCreateSession(inst.id, `co-team 接管 ${new Date().toISOString().slice(5, 16)}`);
    if (!created.ok || !created.session) {
      ElMessage.warning((created as any).error || '创建会话失败');
      return;
    }
    openSession(inst, created.session);
    if (!expandedId.value || expandedId.value !== inst.id) {
      expandedId.value = inst.id;
      void loadSessions(inst);
    }
    ElMessage.success('已创建新会话并接管');
  } catch (e: any) {
    showApiError(e);
  } finally {
    creatingSession.value = '';
  }
}

async function startInstance(inst: OcInstance) {
  busyInstance.value = inst.id;
  busyAction.value = 'start';
  try {
    await api.ocStartInstance(inst.id);
    ElMessage.success(`实例 ${inst.label || inst.id} 启动中…`);
    await loadInstances();
  } catch (e: any) {
    showApiError(e);
  } finally {
    busyInstance.value = '';
    busyAction.value = '';
  }
}

async function stopInstance(inst: OcInstance) {
  busyInstance.value = inst.id;
  busyAction.value = 'stop';
  try {
    await api.ocStopInstance(inst.id);
    ElMessage.success(`实例 ${inst.label || inst.id} 已停止`);
    await loadInstances();
  } catch (e: any) {
    showApiError(e);
  } finally {
    busyInstance.value = '';
    busyAction.value = '';
  }
}

let pollTimer: ReturnType<typeof setInterval> | null = null;
let offEvent: (() => void) | null = null;

onMounted(() => {
  void loadInstances();
  // 实例状态轻轮询：starting→connected 等迁移不依赖人工点刷新
  pollTimer = setInterval(() => { if (document.visibilityState === 'visible') void loadInstances(); }, 12_000);
  // 会话标题/活跃度随事件变化：展开中的实例收到会话事件时刷新列表
  offEvent = onEvent((msg) => {
    if (msg.type !== 'oc_event') return;
    const p = (msg.payload || {}) as { instance?: string; event?: { type?: string } };
    const t = String(p.event?.type || '');
    if ((t === 'session.created' || t === 'session.updated' || t === 'session.status' || t === 'session.idle') && p.instance === expandedId.value) {
      const found = instances.value.find((x) => x.id === p.instance);
      if (found) void loadSessions(found);
    }
  });
});

onBeforeUnmount(() => {
  if (pollTimer) clearInterval(pollTimer);
  offEvent?.();
});
</script>

<style scoped>
/* 设计语言对齐 ConvoView：同 token / 同卡片与间距 / 同 dot / tool-tag / think 折叠节奏 */
.oc-page { display: flex; height: 100%; min-height: 0; }
.oc-side { width: 300px; flex: none; background: var(--bg-panel); border-right: 1px solid var(--line); display: flex; flex-direction: column; min-height: 0; }
.side-head { display: flex; align-items: center; justify-content: space-between; padding: 10px 12px 6px; }
.side-title { font-size: var(--fs-meta); font-family: var(--font-mono); letter-spacing: .08em; text-transform: uppercase; color: var(--text-3); }
.side-list { flex: 1; overflow: auto; padding: 0 8px 10px; min-height: 0; display: flex; flex-direction: column; gap: 8px; }
.side-empty { color: var(--text-3); font-size: var(--fs-aux); padding: 24px 12px; }
.side-empty .empty-title { color: var(--text-2); font-size: var(--fs-body); font-weight: 600; margin-bottom: 8px; }
.side-empty .empty-desc { line-height: 1.8; }
.side-empty code { background: var(--bg-inset); border: 1px solid var(--line); border-radius: 4px; padding: 0 5px; font-size: var(--fs-meta); }
.inst-card { border: 1px solid var(--line); border-radius: var(--r-panel); background: var(--bg-panel); padding: 10px 12px; cursor: pointer; transition: border-color .15s; }
.inst-card:hover { border-color: var(--line-strong); }
.inst-card.open, .inst-card.active { border-color: color-mix(in srgb, var(--accent) 45%, var(--line)); }
.inst-card.disabled { opacity: .55; }
.inst-head { display: flex; align-items: center; gap: 7px; flex-wrap: wrap; }
.inst-name { font-size: var(--fs-body); font-weight: 600; color: var(--text-1); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 130px; }
.dot { width: 7px; height: 7px; border-radius: 50%; background: var(--text-3); flex: none; }
.dot.connected, .dot.running { background: var(--ok); }
.dot.starting { background: var(--warn); animation: livepulse 1.2s infinite; }
.dot.error { background: var(--danger); }
.dot.stopped, .dot.off { background: var(--text-3); }
@keyframes livepulse { 0%,100% { opacity: 1; } 50% { opacity: .25; } }
.kind-tag { font-family: var(--font-mono); font-size: 10px; padding: 1px 7px; border-radius: 4px; border: 1px solid var(--line-strong); color: var(--text-2); background: var(--bg-inset); flex: none; }
.kind-tag.managed { color: var(--accent); border-color: color-mix(in srgb, var(--accent) 40%, transparent); }
.mode-tag { font-family: var(--font-mono); font-size: 10px; padding: 1px 7px; border-radius: 4px; border: 1px solid var(--line-strong); color: var(--text-3); flex: none; }
.mode-tag.control { color: var(--danger); border-color: color-mix(in srgb, var(--danger) 40%, transparent); }
.inst-meta { display: flex; align-items: center; gap: 8px; margin-top: 6px; font-size: var(--fs-meta); flex-wrap: wrap; }
.state-text { font-weight: 600; }
.state-text.connected, .state-text.running { color: var(--ok); }
.state-text.starting { color: var(--warn); }
.state-text.error { color: var(--danger); }
.state-text.stopped, .state-text.off { color: var(--text-3); font-weight: 400; }
.inst-meta .dim { color: var(--text-3); }
.inst-meta .root { color: var(--text-3); font-size: 10px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 100%; }
.inst-err { margin-top: 6px; font-size: var(--fs-meta); color: var(--danger); background: color-mix(in srgb, var(--danger) 8%, transparent); border: 1px solid color-mix(in srgb, var(--danger) 25%, transparent); border-radius: var(--r-ctl); padding: 5px 9px; line-height: 1.5; }
.inst-ops { display: flex; gap: 6px; margin-top: 8px; flex-wrap: wrap; }
.sess-box { margin-top: 9px; border-top: 1px dashed var(--line); padding-top: 7px; }
.sess-head { display: flex; align-items: center; justify-content: space-between; gap: 6px; }
.sess-lab { font-size: var(--fs-meta); color: var(--text-3); }
.scope-switch { display: inline-flex; gap: 2px; }
.sc { font-size: 10px; padding: 1px 7px; border-radius: 4px; border: 1px solid var(--line); background: transparent; color: var(--text-3); cursor: pointer; font-family: var(--font-mono); }
.sc.on { color: var(--accent); border-color: color-mix(in srgb, var(--accent) 45%, var(--line)); background: color-mix(in srgb, var(--accent) 10%, transparent); }
.sess-empty { font-size: var(--fs-meta); color: var(--text-3); padding: 8px 2px; line-height: 1.6; }
.sess-item { display: flex; align-items: center; gap: 8px; padding: 6px 8px; border-radius: var(--r-ctl); cursor: pointer; }
.sess-item:hover { background: var(--bg-raised); }
.sess-item.active { background: color-mix(in srgb, var(--accent) 10%, transparent); box-shadow: inset 2px 0 0 var(--accent); }
.sess-title { flex: 1; min-width: 0; font-size: var(--fs-aux); color: var(--text-1); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.proj-tag { font-family: var(--font-mono); font-size: 10px; padding: 0 6px; border-radius: 4px; background: var(--bg-inset); border: 1px solid var(--line); color: var(--text-2); flex: none; max-width: 90px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sess-id { font-size: 10px; color: var(--text-3); flex: none; }
.sess-time { font-size: 10px; color: var(--text-3); flex: none; white-space: nowrap; }
.child-tag { flex: none; font-size: 10px; padding: 0 5px; border-radius: 4px; background: color-mix(in srgb, var(--accent) 12%, transparent); color: var(--accent); border: 1px solid color-mix(in srgb, var(--accent) 30%, transparent); }
.oc-main { flex: 1; min-width: 0; display: flex; flex-direction: column; min-height: 0; }
.chat-empty { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 10px; color: var(--text-3); }
.chat-empty .big { font-size: var(--fs-title, 16px); font-weight: 600; color: var(--text-2); }
.chat-empty .sm { font-size: var(--fs-aux); max-width: 420px; text-align: center; line-height: 1.8; }
.mono { font-family: var(--font-mono); }
</style>
