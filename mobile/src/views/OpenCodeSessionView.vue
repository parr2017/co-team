<template>
  <div class="page">
    <van-nav-bar fixed placeholder @click-left="router.back()">
      <template #title>
        <span class="nav-title">{{ sessionTitle }}</span>
      </template>
      <template #right>
        <van-icon name="replay" size="18" style="margin-right: 10px" @click="loadMessages" />
        <van-icon name="ellipsis" size="18" @click="moreSheet = true" />
      </template>
    </van-nav-bar>
    <div class="projline mono">
      {{ instance ? `${instance.label || instance.id} · ${instance.mode === 'control' ? 'control' : 'readonly'}` : instanceId }}
    </div>

    <!-- 断线可见：WS 断开时提示"不是模型没回应" -->
    <div v-if="!connected" class="conn-ribbon"><span class="spin" />连接已断开，正在重连…</div>

    <!-- 审批条：permission.asked 事件驱动，同一 permission 不重复弹 -->
    <div v-if="pendingPermissions.length" class="perm-area">
      <div v-for="p in pendingPermissions" :key="p.id" class="perm-card">
        <div class="l1">权限请求 · opencode 等待审批</div>
        <div v-if="p.title" class="perm-title">{{ p.title }}</div>
        <div class="cmd mono">{{ p.detail }}</div>
        <div class="acts">
          <button @click="resolvePermission(p.id, 'reject')">拒绝</button>
          <button @click="resolvePermission(p.id, 'always')">总是允许</button>
          <button class="p" @click="resolvePermission(p.id, 'once')">批准一次</button>
        </div>
      </div>
    </div>
    <!-- 只读提示条 -->
    <div v-else-if="instance && !canControl" class="readonly-ribbon">只读模式：可查看消息与 diff；发送 / 打断需 control 档</div>

    <div ref="streamEl" class="stream" @scroll="onStreamScroll">
      <div v-if="!messages.length && !loadingMessages" class="notice">该会话暂无消息</div>
      <template v-for="(m, mi) in messages" :key="m.info.id || mi">
        <!-- 用户消息：右侧气泡 -->
        <div v-if="m.info.role === 'user'" class="u-row">
          <div class="u-bub">
            <template v-for="(p, pi) in m.parts" :key="pi">
              <div v-if="p.type === 'text' && p.text" class="plain">{{ p.text }}</div>
              <div v-else-if="p.type === 'reasoning' && p.text" class="dim mini">（思考略）</div>
              <div v-else-if="p.type === 'tool'" class="dim mini">🔧 {{ p.tool || 'tool' }}</div>
            </template>
          </div>
        </div>
        <!-- assistant：左对齐，parts 按类型渲染 -->
        <div v-else class="a-block">
          <div class="a-head">
            <span class="a-name">opencode</span>
            <span v-if="m.info.model" class="a-model mono">{{ m.info.model }}</span>
          </div>
          <template v-for="(p, pi) in m.parts" :key="pi">
            <div v-if="p.type === 'text' && p.text" class="a-text md"><MdView :source="p.text" /></div>
            <div v-else-if="p.type === 'reasoning' && p.text" class="thinking" @click="thinkOpen = thinkOpen === m.info.id + ':' + pi ? '' : m.info.id + ':' + pi">
              <span class="lab">思考{{ thinkOpen === m.info.id + ':' + pi ? ' ▾' : ' ▸' }}</span>
              <span v-if="thinkOpen === m.info.id + ':' + pi" class="tb">{{ p.text }}</span>
              <span v-else class="tb short">{{ p.text.slice(0, 80) }}…</span>
            </div>
            <div v-else-if="p.type === 'tool'" class="lg">
              <span class="st" />
              <span class="tg">{{ p.tool || 'tool' }}</span>
              <span class="ar">{{ toolArgs(p) }}</span>
            </div>
            <div v-else-if="p.type === 'step-start'" class="step-chip">— 步骤开始 —</div>
            <div v-else-if="p.type === 'step-finish'" class="step-chip">— 步骤完成 —</div>
          </template>
        </div>
      </template>
    </div>

    <!-- 回到底部 -->
    <div v-if="showToBottom" class="to-bottom" @click="toBottom">↓</div>

    <!-- 输入栏：control 档才显示发送框 -->
    <div v-if="canControl" class="composer" safe-area-inset-bottom>
      <div class="input-flat">
        <div class="input-box">
          <textarea v-model="draft" rows="1" placeholder="给 opencode 下达指令…" @keydown.enter.prevent="send" @input="autoGrow" />
        </div>
        <button class="send" :disabled="sending" @click="send">↑</button>
      </div>
    </div>
    <div v-else class="composer readonly">只读模式 · 无法发送消息</div>

    <!-- 更多操作 -->
    <van-popup v-model:show="moreSheet" position="bottom" round>
      <div class="sheet">
        <div class="si" @click="moreSheet = false; loadMessages()">刷新消息</div>
        <div class="si" @click="moreSheet = false; openDiff()">查看会话 diff</div>
        <div class="si danger" @click="moreSheet = false; abortSession()">打断当前执行（abort）</div>
        <div class="gap" />
        <div class="si" @click="moreSheet = false">取消</div>
      </div>
    </van-popup>

    <!-- diff：按文件展示 additions/deletions 与 patch -->
    <van-popup v-model:show="diffDlg" position="bottom" :style="{ height: '80%' }" round>
      <div class="sheet diffsheet">
        <div class="sh-h"><span>会话 diff</span><span class="x" @click="diffDlg = false">✕</span></div>
        <div v-if="!diffFiles.length" class="sh">没有文件变更</div>
        <template v-else>
          <div class="sh">{{ diffFiles.length }} 个文件 · 上下滑动查看</div>
          <div v-for="(f, i) in diffFiles" :key="i" class="diff-file">
            <div class="diff-file-head">
              <span class="mono fname">{{ f.file }}</span>
              <span class="add">+{{ f.additions }}</span>
              <span class="del">−{{ f.deletions }}</span>
            </div>
            <pre v-if="f.patch" class="diff-patch"><code><span v-for="(l, li) in f.patch.split('\n')" :key="li" :class="lineClass(l)">{{ l }}
</span></code></pre>
          </div>
        </template>
      </div>
    </van-popup>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onActivated, onBeforeUnmount, onMounted, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { showFailToast, showSuccessToast } from 'vant';
import { api, type OcDiffFile, type OcInstance, type OcMessage } from '../api';
import { useWs } from '../composables/useWs';
import MdView from '../components/MdView.vue';

const route = useRoute();
const router = useRouter();
const { onEvent, onResync, connected } = useWs();

const instanceId = computed(() => String(route.params.instance || ''));
const sessionId = computed(() => String(route.params.session || ''));

const instance = ref<OcInstance | null>(null);
const sessionTitle = ref('');
const messages = ref<OcMessage[]>([]);
const loadingMessages = ref(false);
const sending = ref(false);
const aborting = ref(false);
const draft = ref('');
const streamEl = ref<HTMLElement>();
const showToBottom = ref(false);
const moreSheet = ref(false);
const thinkOpen = ref('');

// 审批：permission.asked 事件驱动；seenPermIds 去重（审批中/已决均不重复弹）
const pendingPermissions = ref<{ id: string; title: string; detail: string }[]>([]);
const seenPermIds = new Set<string>();

const canControl = computed(() => instance.value?.mode === 'control');

function shortId(id: string): string {
  return id.length > 12 ? id.slice(0, 8) + '…' : id;
}
function toolArgs(p: Record<string, unknown>): string {
  const args = (p.input || p.args || p.parameters || p.state) as unknown;
  if (args === undefined) return ((p.text as string) || '').slice(0, 120);
  let s = typeof args === 'string' ? args : JSON.stringify(args);
  if (!s) return ((p.text as string) || '').slice(0, 120);
  s = s.replace(/\s+/g, ' ');
  return s.length > 120 ? s.slice(0, 120) + '…' : s;
}
function lineClass(l: string): string {
  return l.startsWith('+') && !l.startsWith('+++') ? 'add' : l.startsWith('-') && !l.startsWith('---') ? 'del' : 'ctx';
}

function isNearEnd(): boolean {
  const el = streamEl.value;
  return !el || el.scrollHeight - el.scrollTop - el.clientHeight < 160;
}
function scrollEnd() {
  const el = streamEl.value;
  if (el) el.scrollTop = el.scrollHeight;
}
function onStreamScroll() {
  showToBottom.value = !isNearEnd();
}
function toBottom() { scrollEnd(); }
function autoGrow(e: Event) {
  const ta = e.target as HTMLTextAreaElement;
  ta.style.height = 'auto';
  ta.style.height = Math.min(ta.scrollHeight, 120) + 'px';
}

async function loadInstanceAndTitle() {
  try {
    const [insts, sess] = await Promise.all([
      api.ocInstances(),
      api.ocSessions(instanceId.value).catch(() => ({ sessions: [] })),
    ]);
    instance.value = (insts.instances || []).find((x) => x.id === instanceId.value) || null;
    const found = (sess.sessions || []).find((s) => s.id === sessionId.value);
    sessionTitle.value = found?.title || shortId(sessionId.value);
  } catch { /* 标题缺失不阻塞消息流 */ }
}

async function loadMessages() {
  if (!instanceId.value || !sessionId.value) return;
  loadingMessages.value = true;
  try {
    const d = await api.ocMessages(instanceId.value, sessionId.value);
    messages.value = d.messages || [];
    if (isNearEnd()) await nextTick(() => scrollEnd());
  } catch (e: any) {
    showFailToast(e?.message || '消息加载失败');
  } finally {
    loadingMessages.value = false;
  }
}

// 实时刷新节流：message.part.updated 可能很密，2s 最多拉一次，尾部补一次
let lastMsgRefreshAt = 0;
let refreshTimer: ReturnType<typeof setTimeout> | null = null;
function throttledRefresh() {
  const now = Date.now();
  if (now - lastMsgRefreshAt > 2000) {
    lastMsgRefreshAt = now;
    void loadMessages();
  } else if (!refreshTimer) {
    refreshTimer = setTimeout(() => {
      refreshTimer = null;
      lastMsgRefreshAt = Date.now();
      void loadMessages();
    }, 2100);
  }
}

function permDetail(props: Record<string, any>): string {
  const md = (props.metadata || {}) as Record<string, any>;
  return String(props.command || props.pattern || props.description || md.command || md.pattern || props.title || 'opencode 请求执行一个操作');
}

async function send() {
  const text = draft.value.trim();
  if (!text || sending.value) return;
  sending.value = true;
  // 乐观上屏：发送即见，loadMessages 拉到真数据后替换
  messages.value.push({ info: { id: `tmp-${Date.now()}`, role: 'user' }, parts: [{ type: 'text', text }] });
  await nextTick(() => scrollEnd());
  try {
    await api.ocPrompt(instanceId.value, sessionId.value, { prompt: text });
    draft.value = '';
    await loadMessages();
  } catch (e: any) {
    showFailToast(e?.message || '发送失败');
    messages.value = messages.value.filter((m) => !String(m.info.id).startsWith('tmp-'));
  } finally {
    sending.value = false;
  }
}

async function abortSession() {
  aborting.value = true;
  try {
    await api.ocAbort(instanceId.value, sessionId.value);
    showSuccessToast('已发送打断信号');
    await loadMessages();
  } catch (e: any) {
    showFailToast(e?.message || '打断失败');
  } finally {
    aborting.value = false;
  }
}

async function resolvePermission(permId: string, response: 'once' | 'always' | 'reject') {
  try {
    await api.ocResolvePermission(instanceId.value, sessionId.value, permId, response);
    pendingPermissions.value = pendingPermissions.value.filter((x) => x.id !== permId);
    showSuccessToast(response === 'reject' ? '已拒绝' : response === 'always' ? '已授权（不再询问）' : '已批准一次');
    await loadMessages();
  } catch (e: any) {
    showFailToast(e?.message || '审批提交失败');
  }
}

// ---------- diff ----------
const diffDlg = ref(false);
const diffFiles = ref<OcDiffFile[]>([]);
async function openDiff() {
  try {
    const d = await api.ocDiff(instanceId.value, sessionId.value);
    diffFiles.value = d.diff || [];
    diffDlg.value = true;
  } catch (e: any) {
    showFailToast(e?.message || 'diff 获取失败');
  }
}

// ---------- WS 实时事件（/ws/events 的 oc_event 帧） ----------
let off: (() => void) | null = null;
let offResync: (() => void) | null = null;
let pollTimer: number | undefined;

onMounted(async () => {
  await Promise.all([loadInstanceAndTitle(), loadMessages()]);
  offResync = onResync(() => { void loadMessages(); });
  off = onEvent((msg: any) => {
    if (msg?.type !== 'oc_event') return;
    const p: any = msg.payload || {};
    const inst = String(p.instance || '');
    if (inst !== instanceId.value) return;
    const evType = String(p.event?.type || '');
    const props = (p.event?.properties || {}) as Record<string, any>;
    if (evType === 'message.part.updated' || evType === 'message.updated' || evType === 'session.idle' || evType === 'session.status') {
      throttledRefresh();
    } else if (evType === 'permission.asked') {
      const sid = String(props.sessionID || props.session_id || props.sessionId || '');
      if (sid && sid !== sessionId.value) return;
      const pid = String(props.id || props.permissionID || props.permission_id || '');
      if (!pid || seenPermIds.has(pid) || pendingPermissions.value.some((x) => x.id === pid)) return;
      seenPermIds.add(pid);
      pendingPermissions.value.push({
        id: pid,
        title: String(props.title || props.reason || ''),
        detail: permDetail(props),
      });
    }
  });
  // 手机端安全网：WS 可能被系统杀掉，15s 轻轮询兜底（与 ConvoDetail 的 reconcile 同思路）
  pollTimer = window.setInterval(() => { if (document.visibilityState === 'visible') void loadMessages(); }, 15_000);
});

onActivated(loadMessages);
onBeforeUnmount(() => {
  off?.();
  offResync?.();
  if (pollTimer) { window.clearInterval(pollTimer); pollTimer = undefined; }
  if (refreshTimer) { clearTimeout(refreshTimer); refreshTimer = null; }
});
</script>

<style scoped>
.page { min-height: 100vh; display: flex; flex-direction: column; }
.nav-title { font-size: 15px; font-weight: 600; }
.projline { padding: 8px 14px 6px; font-size: 11px; color: var(--text-3); }
.conn-ribbon { padding: 6px 14px; font-size: 11px; color: var(--warn); background: color-mix(in srgb, var(--warn) 9%, transparent); border-bottom: 1px solid color-mix(in srgb, var(--warn) 25%, transparent); }
.conn-ribbon .spin { display: inline-block; width: 7px; height: 7px; border-radius: 50%; background: var(--warn); margin-right: 6px; vertical-align: middle; animation: livepulse 1.3s infinite; }
@keyframes livepulse { 0%,100% { opacity: 1; } 50% { opacity: .25; } }

/* 审批条 */
.perm-area { padding: 10px 12px 2px; }
.perm-card { border: 1px solid color-mix(in srgb, var(--danger) 35%, transparent); background: color-mix(in srgb, var(--danger) 7%, var(--bg-panel)); border-radius: 10px; padding: 10px 12px; }
.perm-card .l1 { font-size: 12px; font-weight: 600; color: var(--danger); }
.perm-title { font-size: 11px; color: var(--text-2); margin-top: 3px; }
.perm-card .cmd { margin-top: 6px; font-size: 11px; color: var(--text-1); background: var(--bg-inset); border: 1px solid var(--line); border-radius: 6px; padding: 7px 9px; max-height: 120px; overflow-y: auto; white-space: pre-wrap; word-break: break-all; }
.perm-card .acts { display: flex; gap: 8px; margin-top: 9px; }
.perm-card .acts button { flex: 1; padding: 7px 0; border-radius: 7px; font-size: 12px; border: 1px solid var(--line-strong); background: none; color: var(--text-2); }
.perm-card .acts button.p { border: none; background: var(--accent); color: var(--accent-text); }

/* 只读提示条 */
.readonly-ribbon { padding: 7px 14px; font-size: 11px; color: var(--text-3); background: var(--bg-inset); border-bottom: 1px solid var(--line); }

/* 消息流 */
.stream { flex: 1; overflow-y: auto; padding: 12px 12px 8px; }
.notice { color: var(--text-3); font-size: 12px; text-align: center; padding: 40px 0; }
.u-row { display: flex; justify-content: flex-end; margin: 10px 0 6px; }
.u-bub { max-width: 78%; background: var(--accent); color: var(--accent-text); border-radius: 12px 12px 3px 12px; padding: 9px 12px; font-size: 13.5px; line-height: 1.6; white-space: pre-wrap; overflow-wrap: anywhere; }
.u-bub .mini { font-size: 10.5px; opacity: .75; margin-top: 4px; }
.u-bub .dim { opacity: .75; }

.a-block { margin: 10px 0; }
.a-head { display: flex; align-items: center; gap: 8px; padding: 2px 2px 6px; }
.a-name { font-size: 13px; font-weight: 600; color: var(--text-1); }
.a-model { font-size: 10px; color: var(--text-3); padding: 2px 8px; border: 1px solid var(--line); border-radius: 99px; }
.a-text { padding: 2px 2px 6px; font-size: 14px; line-height: 1.7; overflow-wrap: anywhere; }

/* 思考折叠（与 ConvoDetail 的 thinking 同语言） */
.thinking { margin: 6px 2px; padding: 7px 10px; border: 1px solid var(--line); border-radius: 8px; background: var(--bg-inset); }
.thinking .lab { font-size: 11px; color: var(--text-3); letter-spacing: .1em; }
.thinking .tb { display: block; font-size: 12px; line-height: 1.7; color: var(--text-2); white-space: pre-wrap; overflow-wrap: anywhere; margin-top: 4px; max-height: 240px; overflow-y: auto; }
.thinking .tb.short { color: var(--text-3); }

/* 工具行（同 ConvoDetail 的 lg 行语言） */
.lg { display: flex; align-items: center; gap: 8px; padding: 4px 6px; border-radius: 6px; font-size: 11.5px; }
.lg:active { background: var(--bg-inset); }
.lg .st { width: 6px; height: 6px; border-radius: 50%; background: var(--ok); flex: none; }
.lg .tg { font-family: var(--font-mono, monospace); font-size: 10.5px; font-weight: 600; color: var(--text-1); background: var(--bg-inset); border: 1px solid var(--line); border-radius: 5px; padding: 2px 7px; flex: none; }
.lg .ar { color: var(--text-2); font-family: var(--font-mono, monospace); font-size: 11px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.step-chip { text-align: center; font-size: 10.5px; color: var(--text-3); font-family: var(--font-mono, monospace); padding: 3px 0; }

.to-bottom { position: fixed; right: 14px; bottom: 96px; width: 34px; height: 34px; border-radius: 50%; background: var(--bg-panel); border: 1px solid var(--line-strong); color: var(--text-2); display: grid; place-items: center; box-shadow: var(--shadow-float, 0 2px 8px rgba(0,0,0,.2)); z-index: 10; }

/* 输入栏 */
.composer { border-top: 1px solid var(--line); background: var(--bg-panel); padding: 8px 10px 10px; }
.composer.readonly { color: var(--text-3); font-size: 11px; text-align: center; padding: 13px; }
.input-flat { display: flex; gap: 8px; align-items: flex-end; }
.input-box { flex: 1; background: var(--bg-inset); border: 1px solid var(--line-strong); border-radius: 10px; padding: 7px 10px; }
.input-box textarea { width: 100%; border: none; outline: none; background: none; color: var(--text-1); font-size: 13.5px; line-height: 1.5; resize: none; max-height: 120px; }
.send { width: 38px; height: 38px; border-radius: 50%; border: none; background: var(--accent); color: var(--accent-text); font-size: 16px; flex: none; }
.send:disabled { opacity: .5; }

/* 弹层 */
.sheet { padding: 12px 16px 18px; }
.sh { text-align: center; font-size: 12px; color: var(--text-3); padding-bottom: 8px; }
.sh-h { display: flex; align-items: center; justify-content: space-between; font-size: 14px; font-weight: 600; color: var(--text-1); padding-bottom: 8px; }
.sh-h .x { color: var(--text-3); padding: 2px 6px; }
.si { padding: 12px 6px; font-size: 13.5px; color: var(--text-1); border-bottom: 1px solid var(--line); }
.si:active { background: var(--bg-inset); }
.si.danger { color: var(--danger); }
.gap { height: 8px; }
.diffsheet { height: 100%; display: flex; flex-direction: column; }
.diff-file { margin-bottom: 14px; }
.diff-file-head { display: flex; align-items: center; gap: 8px; padding: 4px 0; border-bottom: 1px solid var(--line); }
.diff-file-head .fname { font-size: 11px; color: var(--text-1); font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.diff-file-head .add { color: var(--ok); font-family: var(--font-mono, monospace); font-size: 10.5px; }
.diff-file-head .del { color: var(--danger); font-family: var(--font-mono, monospace); font-size: 10.5px; }
.diff-patch { font-family: var(--font-mono, monospace); font-size: 11px; line-height: 1.65; overflow: auto; white-space: pre-wrap; overflow-wrap: anywhere; margin: 6px 0 0; }
.diff-patch .add { background: color-mix(in srgb, var(--ok) 12%, transparent); color: var(--ok); display: block; }
.diff-patch .del { background: color-mix(in srgb, var(--danger) 12%, transparent); color: var(--danger); display: block; }
.diff-patch .ctx { color: var(--text-2); display: block; }
.dim { color: var(--text-3); }
</style>
