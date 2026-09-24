<template>
  <div class="oc-page">
    <!-- 左栏：实例列表 -->
    <aside class="oc-side">
      <div class="side-head">
        <span class="side-title">外部运行时 · 实例</span>
        <el-button size="small" text :loading="loadingInstances" @click="loadInstances">刷新</el-button>
      </div>
      <div class="side-list">
        <div v-if="!instances.length && !loadingInstances" class="side-empty">
          <div class="empty-title">还没有接入任何 opencode 实例</div>
          <div class="empty-desc">
            在 <code class="mono">config/config.yaml</code> 的 <code class="mono">opencode.instances</code> 下添加：<br />
            · <b>managed</b>：co-team 托管拉起 opencode serve（模型由 co-team 注入）<br />
            · <b>attached-cli / attached-desktop</b>：接管你已在跑的 opencode（模型归它）<br />
            保存后重启服务生效。
          </div>
        </div>
        <div
          v-for="inst in instances"
          :key="inst.id"
          class="inst-card"
          :class="{ active: inst.id === activeInstanceId, open: inst.id === expandedId, disabled: !inst.enabled }"
        >
          <div class="inst-head" @click="toggleInstance(inst)">
            <span class="dot" :class="inst.enabled ? inst.state : 'off'" />
            <span class="inst-name" :title="inst.id">{{ inst.label || inst.id }}</span>
            <span class="kind-tag" :class="inst.kind">{{ KIND_LABEL[inst.kind] || inst.kind }}</span>
            <span class="mode-tag" :class="inst.mode">{{ inst.mode === 'control' ? '可控制' : '只读' }}</span>
          </div>
          <div class="inst-meta">
            <span class="state-text" :class="inst.enabled ? inst.state : 'off'">{{ inst.enabled ? STATE_LABEL[inst.state] || inst.state : '未启用' }}</span>
            <span class="mono dim" :title="inst.url">v{{ inst.version || '?' }}</span>
            <span v-if="inst.project_root" class="mono root" :title="inst.project_root">{{ shortRoot(inst.project_root) }}</span>
          </div>
          <div v-if="inst.error" class="inst-err" :title="inst.error">⚠ {{ inst.error }}</div>
          <div v-if="inst.kind === 'managed' && inst.enabled" class="inst-ops">
            <el-button
              size="small"
              :loading="busyInstance === inst.id && busyAction === 'start'"
              :disabled="busyInstance === inst.id || inst.state === 'starting' || inst.state === 'running' || inst.state === 'connected'"
              @click.stop="startInstance(inst)"
            >启动</el-button>
            <el-button
              size="small"
              :loading="busyInstance === inst.id && busyAction === 'stop'"
              :disabled="busyInstance === inst.id || inst.state === 'stopped'"
              @click.stop="stopInstance(inst)"
            >停止</el-button>
          </div>
          <!-- 会话列表：点实例卡展开 -->
          <div v-if="expandedId === inst.id" class="sess-box" @click.stop>
            <div class="sess-head">
              <span class="sess-lab">会话</span>
              <el-button size="small" text :loading="loadingSessions" @click="loadSessions(inst)">刷新</el-button>
            </div>
            <div v-if="!sessions.length && !loadingSessions" class="sess-empty">该实例暂无会话</div>
            <div
              v-for="s in sessions"
              :key="s.id"
              class="sess-item"
              :class="{ active: s.id === activeSessionId && inst.id === activeInstanceId }"
              @click="openSession(inst, s)"
            >
              <span class="sess-title">{{ s.title || '（未命名会话）' }}</span>
              <span class="sess-id mono">{{ shortId(s.id) }}</span>
            </div>
          </div>
        </div>
      </div>
    </aside>

    <!-- 右侧：消息流 -->
    <section class="oc-main">
      <template v-if="activeInstance && activeSession">
        <div class="chat-head">
          <div class="head-title">
            <span class="title" :title="activeSessionId">{{ sessionTitle }}</span>
            <span class="mono inst-tag" :title="activeInstance.url">{{ activeInstance.label || activeInstance.id }} · {{ activeInstance.mode === 'control' ? 'control' : 'readonly' }}</span>
          </div>
          <div class="head-right">
            <el-button size="small" :loading="loadingMessages" @click="refreshMessages">刷新</el-button>
            <el-button v-if="canControl" size="small" :loading="aborting" :disabled="!capOf('abort')" @click="abortSession">打断</el-button>
            <el-button size="small" :disabled="!capOf('diff')" @click="openDiff">diff</el-button>
          </div>
        </div>

        <!-- 审批条：permission.asked 事件驱动，同一 permission 不重复弹 -->
        <div v-if="pendingPermissions.length" class="perm-area">
          <div v-for="p in pendingPermissions" :key="p.id" class="perm-card">
            <div class="perm-l1">权限请求 · opencode 等待审批</div>
            <div v-if="p.title" class="perm-title">{{ p.title }}</div>
            <div class="perm-cmd mono" :title="p.detail">{{ p.detail }}</div>
            <div class="perm-acts">
              <el-button size="small" @click="resolvePermission(p.id, 'reject')">拒绝</el-button>
              <el-button size="small" @click="resolvePermission(p.id, 'always')">总是允许</el-button>
              <el-button size="small" type="primary" @click="resolvePermission(p.id, 'once')">批准一次</el-button>
            </div>
          </div>
        </div>
        <!-- 只读提示条 -->
        <div v-else-if="!canControl" class="readonly-ribbon">只读模式：可查看消息与 diff；发送 / 打断需 control 档（实例 mode 在 config.yaml 配置）</div>

        <div ref="streamEl" class="stream" @scroll="onScroll">
          <div class="col">
            <div v-if="!messages.length && !loadingMessages" class="stream-empty">该会话暂无消息</div>
            <template v-for="(m, mi) in messages" :key="m.info.id || mi">
              <!-- 用户消息：右侧气泡 -->
              <div v-if="m.info.role === 'user'" class="user-row">
                <div class="user-msg">
                  <template v-for="(p, pi) in m.parts" :key="pi">
                    <div v-if="p.type === 'text' && p.text" class="plain">{{ p.text }}</div>
                    <div v-else-if="p.type === 'reasoning' && p.text" class="dim mono mini">（思考略）</div>
                    <div v-else-if="p.type === 'tool'" class="dim mono mini">🔧 {{ p.tool || 'tool' }}</div>
                  </template>
                </div>
              </div>
              <!-- assistant：左对齐，parts 按类型渲染 -->
              <div v-else class="a-block">
                <div class="a-head">
                  <span class="a-name">opencode</span>
                  <span v-if="m.info.model" class="a-model mono" :title="m.info.model">{{ m.info.model }}</span>
                </div>
                <template v-for="(p, pi) in m.parts" :key="pi">
                  <div v-if="p.type === 'text' && p.text" class="a-text"><MdView :source="p.text" /></div>
                  <details v-else-if="p.type === 'reasoning' && p.text" class="a-think">
                    <summary><span class="car">▶</span><span class="tt">思考过程</span></summary>
                    <div class="think-body">{{ p.text }}</div>
                  </details>
                  <div v-else-if="p.type === 'tool'" class="act-line">
                    <span class="tool-tag">{{ p.tool || 'tool' }}</span>
                    <span class="act-args" :title="toolArgs(p)">{{ toolArgs(p) }}</span>
                  </div>
                  <div v-else-if="p.type === 'step-start'" class="step-chip">— 步骤开始 —</div>
                  <div v-else-if="p.type === 'step-finish'" class="step-chip">— 步骤完成 —</div>
                </template>
              </div>
            </template>
          </div>
        </div>

        <!-- 输入区：control 档才显示发送框 -->
        <div v-if="canControl" class="composer">
          <div class="comp-r2">
            <div class="ta-wrap">
              <el-input
                v-model="draft"
                type="textarea"
                :autosize="{ minRows: 1, maxRows: 6 }"
                placeholder="给 opencode 下达指令…  Enter 发送 / Shift+Enter 换行"
                @keydown="onKeydown"
              />
            </div>
            <el-button type="primary" class="send-btn" :loading="sending" @click="sendPrompt">发送</el-button>
          </div>
        </div>
        <div v-else class="composer readonly">只读模式 · 无法发送消息</div>
      </template>

      <div v-else class="chat-empty">
        <div class="big">选择左侧实例，再选一个会话</div>
        <div class="sm">外部运行时 = co-team 接管 opencode：看它的会话、批它的权限，control 档可直接发号施令</div>
      </div>
    </section>

    <!-- diff 弹层：按文件展示 additions/deletions 与 patch -->
    <el-dialog v-model="diffDlg" title="会话 diff" width="760" top="6vh">
      <div v-if="!diffFiles.length" class="diff-none">没有文件变更</div>
      <div v-for="(f, i) in diffFiles" :key="i" class="diff-file">
        <div class="diff-file-head">
          <span class="mono fname" :title="f.file">{{ f.file }}</span>
          <span class="add">+{{ f.additions }}</span>
          <span class="del">−{{ f.deletions }}</span>
        </div>
        <pre v-if="f.patch" class="diff-patch"><code><span v-for="(l, li) in f.patch.split('\n')" :key="li" :class="lineClass(l)">{{ l }}
</span></code></pre>
      </div>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue';
import { ElMessage } from 'element-plus';
import { api, type OcInstance, type OcMessage, type OcSession, type OcDiffFile } from '../api';
import { useDashboard } from '../composables/useDashboard';
import { showApiError } from '../utils/apiError';
import MdView from './MdView.vue';

const { onEvent } = useDashboard();

const KIND_LABEL: Record<string, string> = { managed: '托管', 'attached-cli': '接管 · CLI', 'attached-desktop': '接管 · 桌面版' };
const STATE_LABEL: Record<string, string> = { stopped: '未启动', starting: '启动中', running: '运行中', connected: '已连接', error: '异常' };

const instances = ref<OcInstance[]>([]);
const loadingInstances = ref(false);
const expandedId = ref('');
const sessions = ref<OcSession[]>([]);
const loadingSessions = ref(false);
const activeInstanceId = ref('');
const activeSessionId = ref('');
const messages = ref<OcMessage[]>([]);
const loadingMessages = ref(false);
const busyInstance = ref('');
const busyAction = ref<'start' | 'stop' | ''>('');
const sending = ref(false);
const aborting = ref(false);
const draft = ref('');
const streamEl = ref<HTMLElement>();

// 审批：permission.asked 事件驱动；seenPermIds 去重（审批中/已决均不重复弹）
const pendingPermissions = ref<{ id: string; title: string; detail: string }[]>([]);
const seenPermIds = new Set<string>();

const activeInstance = computed(() => instances.value.find((i) => i.id === activeInstanceId.value) || null);
const activeSession = computed(() => sessions.value.find((s) => s.id === activeSessionId.value) || null);
const sessionTitle = computed(() => activeSession.value?.title || '（未命名会话）');
const canControl = computed(() => activeInstance.value?.mode === 'control');
/** capabilities 缺省时放行（服务端软门禁会兜底拒绝） */
function capOf(k: 'abort' | 'diff' | 'permissions' | 'sync_prompt' | 'revert'): boolean {
  return activeInstance.value?.capabilities?.[k] !== false;
}

function shortId(id: string): string {
  return id.length > 12 ? id.slice(0, 8) + '…' : id;
}
function shortRoot(p: string): string {
  const segs = p.replace(/\\/g, '/').split('/').filter(Boolean);
  return segs.length > 2 ? '…/' + segs.slice(-2).join('/') : p;
}
function toolArgs(p: Record<string, unknown>): string {
  const args = (p.input || p.args || p.parameters || p.state) as unknown;
  if (args === undefined) return (p.text as string) || '';
  let s = typeof args === 'string' ? args : JSON.stringify(args);
  if (!s) return (p.text as string) || '';
  s = s.replace(/\s+/g, ' ');
  return s.length > 160 ? s.slice(0, 160) + '…' : s;
}
function lineClass(l: string): string {
  return l.startsWith('+') && !l.startsWith('+++') ? 'add' : l.startsWith('-') && !l.startsWith('---') ? 'del' : 'ctx';
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
    sessions.value = d.sessions || [];
  } catch (e: any) {
    showApiError(e);
    sessions.value = [];
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
  void loadSessions(inst);
}

async function openSession(inst: OcInstance, s: OcSession) {
  activeInstanceId.value = inst.id;
  activeSessionId.value = s.id;
  pendingPermissions.value = [];
  await refreshMessages();
}

async function refreshMessages() {
  if (!activeInstanceId.value || !activeSessionId.value) return;
  loadingMessages.value = true;
  try {
    const d = await api.ocMessages(activeInstanceId.value, activeSessionId.value);
    messages.value = d.messages || [];
    if (isNearEnd()) await nextTick(() => scrollEnd());
  } catch (e: any) {
    showApiError(e);
  } finally {
    loadingMessages.value = false;
  }
}

function isNearEnd(): boolean {
  const el = streamEl.value;
  return !el || el.scrollHeight - el.scrollTop - el.clientHeight < 120;
}
function scrollEnd() {
  const el = streamEl.value;
  if (el) el.scrollTop = el.scrollHeight;
}
function onScroll() { /* 预留：向上翻页懒加载 */ }

// 实时刷新节流：message.part.updated 可能很密，1.5s 最多拉一次，尾部补一次
let lastMsgRefreshAt = 0;
let refreshTimer: ReturnType<typeof setTimeout> | null = null;
function throttledRefresh() {
  const now = Date.now();
  if (now - lastMsgRefreshAt > 1500) {
    lastMsgRefreshAt = now;
    void refreshMessages();
  } else if (!refreshTimer) {
    refreshTimer = setTimeout(() => {
      refreshTimer = null;
      lastMsgRefreshAt = Date.now();
      void refreshMessages();
    }, 1600);
  }
}

function permDetail(props: Record<string, any>): string {
  const md = (props.metadata || {}) as Record<string, any>;
  return String(props.command || props.pattern || props.description || md.command || md.pattern || props.title || 'opencode 请求执行一个操作');
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

function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    void sendPrompt();
  }
}

async function sendPrompt() {
  if (!activeInstanceId.value || !activeSessionId.value) return;
  const text = draft.value.trim();
  if (!text) return;
  sending.value = true;
  const inst = activeInstanceId.value;
  const sess = activeSessionId.value;
  // 乐观上屏：发送即见，refreshMessages 拉到真数据后替换
  messages.value.push({ info: { id: `tmp-${Date.now()}`, role: 'user' }, parts: [{ type: 'text', text }] });
  await nextTick(() => scrollEnd());
  try {
    await api.ocPrompt(inst, sess, { prompt: text });
    draft.value = '';
    await refreshMessages();
  } catch (e: any) {
    showApiError(e);
    // 发送失败：撤掉乐观气泡，避免界面留下不存在的消息
    messages.value = messages.value.filter((m) => !String(m.info.id).startsWith('tmp-'));
  } finally {
    sending.value = false;
  }
}

async function abortSession() {
  if (!activeInstanceId.value || !activeSessionId.value) return;
  aborting.value = true;
  try {
    await api.ocAbort(activeInstanceId.value, activeSessionId.value);
    ElMessage.success('已发送打断信号');
    await refreshMessages();
  } catch (e: any) {
    showApiError(e);
  } finally {
    aborting.value = false;
  }
}

async function resolvePermission(permId: string, response: 'once' | 'always' | 'reject') {
  const inst = activeInstanceId.value;
  const sess = activeSessionId.value;
  if (!inst || !sess) return;
  try {
    await api.ocResolvePermission(inst, sess, permId, response);
    pendingPermissions.value = pendingPermissions.value.filter((x) => x.id !== permId);
    ElMessage.success(response === 'reject' ? '已拒绝' : response === 'always' ? '已授权（不再询问）' : '已批准一次');
    await refreshMessages();
  } catch (e: any) {
    showApiError(e);
  }
}

// ---------- diff ----------
const diffDlg = ref(false);
const diffFiles = ref<OcDiffFile[]>([]);
async function openDiff() {
  if (!activeInstanceId.value || !activeSessionId.value) return;
  try {
    const d = await api.ocDiff(activeInstanceId.value, activeSessionId.value);
    diffFiles.value = d.diff || [];
    diffDlg.value = true;
  } catch (e: any) {
    showApiError(e);
  }
}

// ---------- WS 实时事件（/ws/events 的 oc_event 帧） ----------
let offEvent: (() => void) | null = null;
let pollTimer: ReturnType<typeof setInterval> | null = null;

onMounted(() => {
  void loadInstances();
  // 实例状态轻轮询：starting→connected 等迁移不依赖人工点刷新（与 App.vue 轮询状态同思路）
  pollTimer = setInterval(() => { if (document.visibilityState === 'visible') void loadInstances(); }, 12_000);
  offEvent = onEvent((msg) => {
    if (msg.type !== 'oc_event') return;
    const p = (msg.payload || {}) as { instance?: string; event?: { type?: string; properties?: Record<string, any> } };
    const inst = String(p.instance || '');
    const evType = String(p.event?.type || '');
    const props = (p.event?.properties || {}) as Record<string, any>;
    if (evType === 'message.part.updated' || evType === 'message.updated' || evType === 'session.idle' || evType === 'session.status') {
      if (inst === activeInstanceId.value && activeSessionId.value) throttledRefresh();
      // 会话标题/活跃度可能随 status 帧变化：同实例下刷新会话列表
      if (evType === 'session.status' && inst === activeInstanceId.value) {
        const found = instances.value.find((x) => x.id === inst);
        if (found) void loadSessions(found);
      }
    } else if (evType === 'permission.asked') {
      if (inst !== activeInstanceId.value) return;
      const sid = String(props.sessionID || props.session_id || props.sessionId || '');
      if (sid && sid !== activeSessionId.value) return;
      const pid = String(props.id || props.permissionID || props.permission_id || '');
      if (!pid || seenPermIds.has(pid) || pendingPermissions.value.some((x) => x.id === pid)) return;
      seenPermIds.add(pid);
      pendingPermissions.value.push({
        id: pid,
        title: String(props.title || props.reason || ''),
        detail: permDetail(props),
      });
    } else if (evType === 'session.error' || evType === 'instance.error' || evType === 'server.connected' || evType === 'instance.updated') {
      void loadInstances();
    }
  });
});

onBeforeUnmount(() => {
  offEvent?.();
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  if (refreshTimer) { clearTimeout(refreshTimer); refreshTimer = null; }
});
</script>

<style scoped>
/* 设计语言对齐 ConvoView：同 token / 同卡片与间距 / 同 dot / tool-tag / think 折叠节奏 */
.oc-page { display: flex; height: 100%; min-height: 0; }

/* ---- 左栏：实例列表 ---- */
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
.inst-ops { display: flex; gap: 6px; margin-top: 8px; }

/* 会话列表（实例卡内展开） */
.sess-box { margin-top: 9px; border-top: 1px dashed var(--line); padding-top: 7px; }
.sess-head { display: flex; align-items: center; justify-content: space-between; }
.sess-lab { font-size: var(--fs-meta); color: var(--text-3); }
.sess-empty { font-size: var(--fs-meta); color: var(--text-3); padding: 8px 2px; }
.sess-item { display: flex; align-items: center; gap: 8px; padding: 6px 8px; border-radius: var(--r-ctl); cursor: pointer; }
.sess-item:hover { background: var(--bg-raised); }
.sess-item.active { background: color-mix(in srgb, var(--accent) 10%, transparent); box-shadow: inset 2px 0 0 var(--accent); }
.sess-title { flex: 1; min-width: 0; font-size: var(--fs-aux); color: var(--text-1); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.sess-id { font-size: 10px; color: var(--text-3); flex: none; }

/* ---- 右侧：消息流 ---- */
.oc-main { flex: 1; display: flex; flex-direction: column; min-width: 0; min-height: 0; }
.chat-head { display: flex; align-items: center; gap: 10px; padding: 8px 16px; background: var(--bg-panel); border-bottom: 1px solid var(--line); flex: none; flex-wrap: wrap; }
.head-title { display: flex; align-items: center; gap: 8px; font-size: var(--fs-sub); font-weight: 600; min-width: 0; }
.head-title .title { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 46vw; }
.inst-tag { font-size: 10px; color: var(--text-3); border: 1px solid var(--line); border-radius: 99px; padding: 2px 9px; flex: none; }
.head-right { margin-left: auto; display: flex; align-items: center; gap: 8px; }

/* 审批条 */
.perm-area { padding: 10px 16px 4px; flex: none; }
.perm-card { border: 1px solid color-mix(in srgb, var(--danger) 35%, transparent); background: color-mix(in srgb, var(--danger) 7%, var(--bg-panel)); border-radius: var(--r-panel); padding: 10px 14px; margin-bottom: 8px; }
.perm-l1 { font-size: var(--fs-aux); font-weight: 600; color: var(--danger); }
.perm-title { font-size: var(--fs-aux); color: var(--text-2); margin-top: 3px; }
.perm-cmd { margin-top: 6px; font-size: 12px; color: var(--text-1); background: var(--bg-inset); border: 1px solid var(--line); border-radius: var(--r-ctl); padding: 7px 10px; max-height: 120px; overflow-y: auto; white-space: pre-wrap; overflow-wrap: anywhere; }
.perm-acts { display: flex; gap: 8px; margin-top: 9px; }

/* 只读提示条 */
.readonly-ribbon { padding: 7px 16px; font-size: var(--fs-meta); color: var(--text-3); background: var(--bg-inset); border-bottom: 1px solid var(--line); flex: none; }

.stream { flex: 1; overflow-y: auto; padding: 16px 20px 8px; min-height: 0; }
.col { max-width: 860px; margin: 0 auto; display: flex; flex-direction: column; gap: 10px; }
.stream-empty { color: var(--text-3); font-size: var(--fs-aux); text-align: center; padding: 40px 0; }

/* 用户气泡 */
.user-row { display: flex; justify-content: flex-end; margin: 10px 0 4px; }
.user-msg { max-width: 78%; background: color-mix(in srgb, var(--accent) 11%, var(--bg-panel)); border: 1px solid color-mix(in srgb, var(--accent) 24%, transparent); border-radius: 12px 12px 3px 12px; padding: 10px 14px; font-size: 14px; line-height: 1.7; white-space: pre-wrap; overflow-wrap: anywhere; }
.user-msg .mini { font-size: 11px; margin-top: 4px; }

/* assistant 块 */
.a-block { margin: 8px 0; }
.a-head { display: flex; align-items: center; gap: 9px; padding: 2px 4px 6px; }
.a-name { font-size: 14px; font-weight: 600; color: var(--text-1); }
.a-model { font-size: 11px; color: var(--text-3); padding: 2px 8px; border: 1px solid var(--line); border-radius: 99px; }
.a-text { padding: 2px 4px 6px; font-size: 14px; line-height: 1.7; overflow-wrap: anywhere; }

/* 思考折叠（同 ConvoView 节奏） */
.a-think { border-top: 1px solid var(--line); }
.a-think > summary { list-style: none; display: flex; align-items: center; gap: 8px; padding: 8px 4px; font-size: 12px; color: var(--text-3); cursor: pointer; user-select: none; }
.a-think > summary::-webkit-details-marker { display: none; }
.a-think > summary .car { transition: transform .15s; font-size: 9px; display: inline-flex; }
.a-think[open] > summary .car { transform: rotate(90deg); }
.a-think > summary .tt { color: var(--text-2); font-weight: 600; }
.a-think > summary:hover .tt { color: var(--accent); }
.think-body { padding: 2px 0 12px 16px; font-size: 12.5px; line-height: 1.85; color: var(--text-2); white-space: pre-wrap; overflow-wrap: anywhere; max-height: 260px; overflow-y: auto; border-left: 2px solid var(--line-strong); margin: 0 4px 0 12px; padding-left: 14px; }

/* 工具行（同 ConvoView act-line 语言） */
.act-line { position: relative; display: flex; align-items: center; gap: 9px; padding: 3px 8px 3px 20px; border-radius: 7px; font-size: 12px; min-height: 22px; }
.act-line::before { content: ''; position: absolute; left: 3px; top: 50%; transform: translateY(-50%); width: 7px; height: 7px; border-radius: 50%; background: var(--ok); box-shadow: 0 0 0 3px color-mix(in srgb, var(--ok) 14%, transparent); }
.tool-tag { font-family: var(--font-mono); font-size: 10.5px; font-weight: 600; color: var(--text-1); background: var(--bg-inset); border: 1px solid var(--line); border-radius: 5px; padding: 2px 7px; flex: none; letter-spacing: .02em; }
.act-args { color: var(--text-1); font-family: var(--font-mono); font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.step-chip { text-align: center; font-size: 10.5px; color: var(--text-3); font-family: var(--font-mono); padding: 3px 0; }

/* 输入区 */
.composer { border-top: 1px solid var(--line); background: var(--bg-panel); padding: 10px 20px 12px; flex: none; }
.composer.readonly { color: var(--text-3); font-size: var(--fs-meta); text-align: center; padding: 12px; }
.comp-r2 { display: flex; gap: 10px; align-items: flex-end; max-width: 860px; margin: 0 auto; }
.ta-wrap { flex: 1; position: relative; }
.send-btn { height: 40px; padding: 0 20px; }

.chat-empty { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 10px; color: var(--text-3); }
.chat-empty .big { font-size: var(--fs-sub); color: var(--text-2); }
.chat-empty .sm { font-size: var(--fs-aux); }

/* diff 弹层 */
.diff-none { color: var(--text-3); font-size: var(--fs-aux); text-align: center; padding: 20px 0; }
.diff-file { margin-bottom: 14px; }
.diff-file-head { display: flex; align-items: center; gap: 10px; padding: 4px 0; border-bottom: 1px solid var(--line); }
.diff-file-head .fname { font-size: 12px; color: var(--text-1); font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.diff-file-head .add { color: var(--ok); font-family: var(--font-mono); font-size: 11px; }
.diff-file-head .del { color: var(--danger); font-family: var(--font-mono); font-size: 11px; }
.diff-patch { font-family: var(--font-mono); font-size: 12px; line-height: 1.7; max-height: 40vh; overflow: auto; white-space: pre-wrap; overflow-wrap: anywhere; margin: 6px 0 0; }
.diff-patch .add { background: color-mix(in srgb, var(--ok) 12%, transparent); color: var(--ok); display: block; }
.diff-patch .del { background: color-mix(in srgb, var(--danger) 12%, transparent); color: var(--danger); display: block; }
.diff-patch .ctx { color: var(--text-2); display: block; }
.dim { color: var(--text-3); }
</style>
