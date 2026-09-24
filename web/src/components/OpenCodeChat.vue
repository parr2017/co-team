<template>
  <div class="occ">
    <!-- 顶栏：标题 + 模型徽标 + 状态 + 操作 -->
    <div class="occ-head">
      <div class="h-left">
        <span class="s-title" :title="sessionId">{{ snap.title || '（未命名会话）' }}</span>
        <span v-if="sessionMeta.model" class="mono dim" :title="String(sessionMeta.model)">
          {{ String(sessionMeta.model).split('/').pop() }}
        </span>
        <span v-if="sessionMeta.tokens" class="mono dim mini" :title="String(sessionMeta.tokens)">
          {{ fmtTokens(sessionMeta.tokens) }}
        </span>
        <span v-if="typeof sessionMeta.cost === 'number' && sessionMeta.cost > 0" class="mono dim mini">
          ${{ sessionMeta.cost.toFixed(4) }}
        </span>
      </div>
      <div class="h-right">
        <span v-if="snap.busy" class="live"><i class="dot pulse" />opencode 工作中</span>
        <span v-else-if="snap.status === 'idle'" class="dim mini">空闲</span>
        <el-button size="small" text :loading="loading" @click="reloadAll">刷新</el-button>
        <el-button v-if="canControl" size="small" :disabled="!snap.busy" @click="abort">打断</el-button>
        <el-button size="small" @click="diffDlg = true">diff</el-button>
        <el-tooltip content="在你的 TUI 里打开这个会话" placement="top">
          <el-button v-if="canControl" size="small" text @click="openInTui">在 TUI 打开</el-button>
        </el-tooltip>
      </div>
    </div>

    <!-- 接管横幅：显式告知正在看/管的是哪条会话（busy=可能正被 TUI 使用，禁盲发） -->
    <div v-if="props.takeoverHint" class="takeover-banner" :class="{ warn: props.takeoverHint.busy }">
      <span v-if="props.takeoverHint.busy">⚠ 正在接管 <b>TUI 正在使用</b> 的会话：「{{ props.takeoverHint.title }}」 · {{ props.takeoverHint.project }}——你发的消息会进入该会话，TUI 实时可见</span>
      <span v-else>接管中：「{{ props.takeoverHint.title }}」 · {{ props.takeoverHint.project }}</span>
    </div>

    <!-- 状态条：重试 / 错误 / 已回退 -->
    <div v-if="snap.retry" class="ribbon warn">第 {{ snap.retry.attempt }} 次重试：{{ snap.retry.message }}</div>
    <div v-if="snap.error" class="ribbon err">{{ snap.error }}</div>
    <div v-if="snap.revert" class="ribbon warn">
      已回退到消息 {{ shortId(String(snap.revert.messageID || '')) }}——此前的文件改动已撤，可直接继续发新指令
    </div>

    <!-- todos：TUI 顶部任务清单 -->
    <div v-if="snap.todos.length" class="todos">
      <span v-for="(t, i) in snap.todos" :key="t.id || i" class="todo" :class="t.status">
        <i class="tdot" :class="t.status" />{{ t.content }}
      </span>
    </div>

    <!-- 消息流 -->
    <div ref="streamEl" class="stream" @scroll="onScroll">
      <div class="col">
        <div v-if="!snap.messages.length && !loading" class="stream-empty">该会话暂无消息——在下方给它下达第一条指令</div>
        <template v-for="(m, mi) in snap.messages" :key="m.id || mi">
          <!-- user -->
          <div v-if="m.role === 'user'" class="user-row">
            <div class="user-msg">
              <template v-for="(p, pi) in m.parts" :key="pi">
                <div v-if="p.type === 'text' && p.text" class="plain">{{ p.text }}</div>
                <div v-else-if="p.type === 'file'" class="dim mono mini">附件：{{ p.filename || 'file' }}</div>
              </template>
            </div>
          </div>
          <!-- assistant -->
          <div v-else class="a-block">
            <div class="a-head">
              <span class="a-name">opencode</span>
              <span v-if="m.providerID || m.modelID" class="mono dim mini">{{ m.providerID }}/{{ m.modelID }}</span>
              <span v-if="m.tokens" class="mono dim mini" :title="JSON.stringify(m.tokens)">
                ↑{{ fmtTokens(m.tokens.input) }} ↓{{ fmtTokens(m.tokens.output) }}
              </span>
              <span v-if="typeof m.cost === 'number' && m.cost > 0" class="mono dim mini">${{ m.cost.toFixed(4) }}</span>
              <span v-if="m.finish" class="mono dim mini">{{ m.finish }}</span>
            </div>
            <template v-for="(p, pi) in m.parts" :key="p.id || pi">
              <div v-if="p.type === 'text' && p.text" class="a-text"><MdView :source="p.text" /></div>
              <details v-else-if="p.type === 'reasoning' && p.text" class="a-think" :open="snap.busy && isLastPart(m, p)">
                <summary><span class="car">▶</span><span class="tt">思考过程</span></summary>
                <div class="think-body">{{ p.text }}</div>
              </details>
              <div v-else-if="p.type === 'tool'" class="tool-card" :class="p.state?.status">
                <div class="tc-head" @click="toggleTool(p)">
                  <i class="ticon" :class="p.state?.status">{{ toolIcon(p) }}</i>
                  <span class="tname">{{ p.tool || 'tool' }}</span>
                  <span class="targs" :title="toolArgs(p)">{{ p.state?.title || toolArgs(p) }}</span>
                  <span class="tstate mono mini">{{ p.state?.status || '' }}</span>
                  <span v-if="trimmedParts.has(String(p.id))" class="ttrim" @click.stop="openFullMessage(m.id)">已裁剪·原文</span>
                  <span class="tcar">{{ p.__open ? '▾' : '▸' }}</span>
                </div>
                <div v-if="p.__open" class="tc-body">
                  <div v-if="p.state?.input && Object.keys(p.state.input).length" class="tc-sec">
                    <div class="tc-lab">输入</div>
                    <pre class="tc-pre">{{ fmtJson(p.state.input) }}</pre>
                  </div>
                  <div v-if="p.state?.output" class="tc-sec">
                    <div class="tc-lab">输出</div>
                    <pre class="tc-pre">{{ String(p.state.output).slice(0, 6000) }}</pre>
                  </div>
                  <div v-if="p.state?.error" class="tc-sec err">{{ p.state.error }}</div>
                  <div v-if="p.state?.attachments?.length" class="tc-sec dim mini">
                    附件：{{ p.state.attachments.map((a: any) => a.filename || a.path || a.id).join('、') }}
                  </div>
                </div>
              </div>
              <div v-else-if="p.type === 'step-start'" class="step-chip">— 步骤开始 —</div>
              <div v-else-if="p.type === 'step-finish'" class="step-chip">— 步骤完成 —</div>
              <div v-else-if="p.type === 'patch'" class="patch-chip">
                变更 {{ p.files?.length || 0 }} 个文件：{{ (p.files || []).map((f: any) => f.path || f.file).join('、') }}
              </div>
              <div v-else-if="p.type === 'retry'" class="chip warn">第 {{ p.attempt }} 次重试{{ p.error ? '：' + String(p.error?.message || p.error) : '' }}</div>
              <div v-else-if="p.type === 'compaction'" class="chip">上下文已压缩</div>
              <div v-else-if="p.type === 'agent'" class="chip">切换 agent：{{ p.name }}</div>
              <div v-else-if="p.type === 'subtask'" class="chip">子任务：{{ p.description || p.agent || '' }}</div>
              <div v-else-if="p.type === 'snapshot'" class="chip dim">快照</div>
            </template>
            <div v-if="canControl" class="a-ops">
              <el-button size="small" text class="mini" @click="revertTo(m)">回退到此</el-button>
            </div>
          </div>
        </template>

        <!-- 行内提问卡：opencode 的 AskUserQuestion——TUI 里弹的题，这里也能答 -->
        <div v-for="q in snap.pendingQuestions" :key="q.id" class="q-card">
          <template v-for="(qi, qii) in q.questions || []" :key="qii">
            <div class="q-l1">opencode 等你拍板 · {{ qi.header || '征询' }}</div>
            <div class="q-text">{{ qi.question }}</div>
            <div class="q-opts">
              <el-button
                v-for="o in qi.options || []"
                :key="o.label"
                size="small"
                :title="o.description || ''"
                @click="answerQuestion(q.id, [[o.label]])"
              >{{ o.label }}</el-button>
            </div>
            <div v-if="qi.custom" class="q-custom">
              <el-input v-model="qDraft[q.id + ':' + qii]" size="small" placeholder="或输入你的回答" @keydown.enter="answerQuestion(q.id, [[qDraft[q.id + ':' + qii] || '']])" />
              <el-button size="small" type="primary" @click="answerQuestion(q.id, [[qDraft[q.id + ':' + qii] || '']])">提交</el-button>
            </div>
          </template>
          <div class="q-acts">
            <el-button size="small" text @click="rejectQuestion(q.id)">不回答，让它自己拿主意</el-button>
          </div>
        </div>
        <!-- 行内审批卡：opencode 等待放行 -->
        <div v-for="perm in snap.pendingPermissions" :key="perm.id" class="perm-card">
          <div class="perm-l1">权限请求 · opencode 等待审批</div>
          <div v-if="perm.title" class="perm-title">{{ perm.title }}</div>
          <div class="perm-cmd mono" :title="permDetail(perm)">{{ permDetail(perm) }}</div>
          <div class="perm-acts">
            <el-button size="small" @click="answerPerm(perm.id, 'reject')">拒绝</el-button>
            <el-button size="small" @click="answerPerm(perm.id, 'always')">总是允许</el-button>
            <el-button size="small" type="primary" @click="answerPerm(perm.id, 'once')">批准一次</el-button>
          </div>
        </div>
      </div>
    </div>

    <!-- PTY：TUI 的实时终端 -->
    <div v-if="snap.ptys.length" class="pty-strip">
      <span v-for="p in snap.ptys" :key="p.id" class="pty-chip" @click="openPty(p)">
        <i class="pdot" :class="p.status === 'exited' ? 'off' : 'on'" />
        <span class="mono">{{ p.title || p.command || p.id }}</span>
        <span class="mono dim mini">{{ p.status === 'exited' ? `exit ${p.exitCode}` : 'running' }}</span>
      </span>
    </div>

    <!-- composer -->
    <div v-if="canControl" class="composer">
      <div class="comp-r1">
        <el-select v-model="agent" size="small" class="sel" clearable placeholder="agent（缺省 build）">
          <el-option v-for="a in agents" :key="a.name" :label="a.name + (a.description ? ' · ' + a.description : '')" :value="a.name" />
        </el-select>
        <el-select v-model="model" size="small" class="sel" clearable filterable placeholder="模型（缺省实例默认）">
          <el-option v-for="m in modelOptions" :key="m.value" :label="m.label" :value="m.value" />
        </el-select>
        <span v-if="snap.busy" class="dim mini">发送将排队等当前回合结束</span>
      </div>
      <div class="comp-r2">
        <div class="ta-wrap">
          <el-input
            v-model="draft"
            type="textarea"
            :autosize="{ minRows: 1, maxRows: 8 }"
            placeholder="给 opencode 下达指令…  Enter 发送 / Shift+Enter 换行；/ 开头走斜杠命令（如 /summarize）"
            @keydown="onKeydown"
          />
        </div>
        <el-button type="primary" class="send-btn" :loading="sending" @click="send">发送</el-button>
      </div>
    </div>
    <div v-else class="composer readonly">只读模式 · 可批权限、看 diff；发送需 control 档</div>

    <!-- diff 抽屉 -->
    <el-dialog v-model="diffDlg" title="会话 diff" width="760" top="6vh">
      <div v-if="!diffFiles.length && !loadingDiff" class="diff-none">没有文件变更</div>
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

    <!-- PTY 实时终端（实验性：协议尽力渲染） -->
    <el-dialog v-model="ptyDlg" :title="ptyTitle" width="760" top="6vh" @closed="closePty">
      <div class="pty-term"><pre class="pty-out" ref="ptyOut">{{ ptyText }}</pre></div>
      <div class="pty-in">
        <el-input v-model="ptyInput" size="small" placeholder="输入命令回车发送（实验性）" @keydown.enter="ptySend" />
      </div>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { api, getApiToken, type OcInstance, type OcDiffFile } from '../api';
import { useDashboard } from '../composables/useDashboard';
import { showApiError } from '../utils/apiError';
import { SessionStream } from '../opencode-stream';
import MdView from './MdView.vue';

const props = defineProps<{ instance: OcInstance; sessionId: string; takeoverHint?: { title: string; project: string; busy: boolean } | null }>();
const { onEvent } = useDashboard();
const canControl = computed(() => props.instance.mode === 'control');

const stream = new SessionStream();
const snap = ref(stream.snapshot());
let busyAck = false; // busy 接管会话的首次发送确认（同会话只问一次）
const loading = ref(false);
const sending = ref(false);
const draft = ref('');
const agent = ref('');
const model = ref('');
const agents = ref<{ name: string; description?: string; mode?: string }[]>([]);
const modelOptions = ref<{ label: string; value: string }[]>([]);
const streamEl = ref<HTMLElement>();

// diff / pty
const diffDlg = ref(false);
const diffFiles = ref<OcDiffFile[]>([]);
const loadingDiff = ref(false);
const ptyDlg = ref(false);
const ptyTitle = ref('');
const ptyText = ref('');
const ptyInput = ref('');
const ptyOut = ref<HTMLElement>();
let ptyWs: WebSocket | null = null;

// 事件订阅：managed 直连（无鉴权+CORS 已放行）；attached 走同源代理。断线重连内置。
let es: EventSource | null = null;
let proxyReader: ReadableStreamDefaultReader<Uint8Array> | null = null;
let proxyAbort: AbortController | null = null;
let directKind: 'direct' | 'proxy' | '' = '';
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let renderRaf = 0;

const sessionMeta = computed(() => {
  for (let i = snap.value.messages.length - 1; i >= 0; i--) {
    const m = snap.value.messages[i];
    if (m?.role === 'assistant') return { model: `${m.providerID || ''}/${m.modelID || ''}`, tokens: m.tokens, cost: m.cost };
  }
  return {} as { model?: string; tokens?: unknown; cost?: number };
});

function shortId(id: string): string {
  return id.length > 12 ? id.slice(0, 8) + '…' : id;
}
function fmtTokens(v: unknown): string {
  const n = Number(v || 0);
  if (!n) return '0';
  return n > 1000 ? (n / 1000).toFixed(1) + 'k' : String(n);
}
function fmtJson(v: unknown): string {
  try { return JSON.stringify(v, null, 2).slice(0, 4000); } catch { return String(v).slice(0, 2000); }
}
function toolArgs(p: Record<string, any>): string {
  const args = p.state?.input ?? p.input ?? p.args;
  if (args === undefined) return '';
  let s = typeof args === 'string' ? args : JSON.stringify(args);
  if (!s) return '';
  s = s.replace(/\s+/g, ' ');
  return s.length > 160 ? s.slice(0, 160) + '…' : s;
}
function toolIcon(p: Record<string, any>): string {
  const st = p.state?.status;
  return st === 'completed' ? '✓' : st === 'error' ? '✗' : st === 'running' || st === 'pending' ? '⋯' : '·';
}
function toggleTool(p: Record<string, any>): void {
  p.__open = !p.__open;
  flush();
}
function isLastPart(m: Record<string, any>, p: Record<string, any>): boolean {
  const parts = partsOf(m);
  return parts[parts.length - 1] === p;
}
function lineClass(l: string): string {
  return l.startsWith('+') && !l.startsWith('+++') ? 'add' : l.startsWith('-') && !l.startsWith('---') ? 'del' : 'ctx';
}
function permDetail(perm: Record<string, any>): string {
  const md = perm.metadata || {};
  return String(perm.pattern || perm.title || md.command || md.pattern || (Array.isArray(perm.pattern) ? perm.pattern.join(' ') : '') || 'opencode 请求执行一个操作');
}

/** 事件归属当前会话才应用（防其他会话幽灵消息）；无 sessionID 的帧放行（本地帧） */
function belongsToSession(ev: { properties?: Record<string, any> }): boolean {
  const p = ev.properties || {};
  const sid = p.sessionID || p.session_id || p.info?.sessionID || p.part?.sessionID || '';
  return !sid || sid === props.sessionId;
}

function applyEvents(frames: ({ event?: any; events?: any[] } | any)[]): void {
  let touched = false;
  for (const f of frames) {
    const list = f?.events ? f.events : f?.event ? [f.event] : f?.type ? [f] : [];
    for (const ev of list) {
      if (!ev?.type || !belongsToSession(ev)) continue;
      stream.applyEvent(ev);
      touched = true;
    }
  }
  if (touched) flush();
}

/** 合并刷帧：delta 可能 50ms 一批，rAF 合并 DOM 更新 */
function flush(): void {
  if (renderRaf) return;
  renderRaf = requestAnimationFrame(() => {
    renderRaf = 0;
    snap.value = stream.snapshot();
    if (snap.value.busy && isNearEnd()) void nextTick(() => scrollEnd());
  });
}

// ---------- 数据加载 ----------

/** 分页常量与前端 page 状态（尾优先：初始拉最近 PAGE 条，上滑 Load more earlier messages） */
const PAGE = 50;
const hasMore = ref(false);
const nextBefore = ref('');
const loadingMore = ref(false);
/** 被服务端头尾裁剪的 part id（tool 卡角标 + 完整原文按钮） */
const qDraft = ref<Record<string, string>>({});
const trimmedParts = ref(new Set<string>());
/** 已拉全文中消息 id → message（渲染时优先取全文 parts） */
const fullMessages = ref(new Map<string, any>());

async function reloadAll(): Promise<void> {
  loading.value = true;
  try {
    const d = await api.ocMessages(props.instance.id, props.sessionId, { limit: PAGE });
    stream.reset(d.messages || []);
    hasMore.value = !!d.has_more;
    nextBefore.value = d.next_before || '';
    trimmedParts.value = new Set(d.trimmed || []);
    fullMessages.value = new Map();
    const todos = await api.ocTodos(props.instance.id, props.sessionId).catch(() => null);
    if (todos?.todos) stream.applyEvent({ type: 'todo.updated', properties: { todos: todos.todos } });
    flush();
    if (isNearEnd()) await nextTick(() => scrollEnd());
  } catch (e: any) {
    showApiError(e);
  } finally {
    loading.value = false;
  }
}

/** Load more earlier messages：上游 before 翻页 + prepend + 滚动位置补偿（不跳动） */
async function loadMore(): Promise<void> {
  if (!hasMore.value || !nextBefore.value || loadingMore.value) return;
  loadingMore.value = true;
  const el = streamEl.value;
  const prevHeight = el?.scrollHeight || 0;
  const prevTop = el?.scrollTop || 0;
  try {
    const d = await api.ocMessages(props.instance.id, props.sessionId, { limit: PAGE, before: nextBefore.value });
    if (d.messages?.length) {
      stream.prepend(d.messages);
      for (const id of d.trimmed || []) trimmedParts.value.add(id);
      flush();
      await nextTick();
      // 位置补偿：把新插入内容的高度差补回 scrollTop，视觉上原地不动
      if (el) el.scrollTop = prevTop + (el.scrollHeight - prevHeight);
    }
    hasMore.value = !!d.has_more;
    nextBefore.value = d.next_before || '';
  } catch (e: any) {
    showApiError(e);
  } finally {
    loadingMore.value = false;
  }
}

/** 完整原文：tool 卡/裁剪提示的按钮 → 拉单条全文，渲染时优先取全文 parts */
async function openFullMessage(messageId: string): Promise<void> {
  if (!messageId) return;
  try {
    const r = await api.ocMessageFull(props.instance.id, props.sessionId, messageId);
    if (r.ok && r.message) {
      fullMessages.value = new Map(fullMessages.value).set(messageId, r.message);
      ElMessage.success('已加载完整原文');
    } else {
      ElMessage.warning(r.error || '完整原文加载失败');
    }
  } catch (e: any) {
    showApiError(e);
  }
}

/** 渲染取 parts：有全文缓存用全文，否则用（可能已裁剪的）流内版本 */
function partsOf(m: Record<string, any>): any[] {
  const full = fullMessages.value.get(String(m.id));
  if (full?.parts?.length) return full.parts;
  return m.parts || [];
}

async function loadSelectors(): Promise<void> {
  try {
    const [ag, md] = await Promise.all([
      api.ocAgents(props.instance.id).catch(() => ({ agents: [] })),
      api.ocModels(props.instance.id).catch(() => ({ providers: [], default: {} })),
    ]);
    agents.value = ag.agents || [];
    const opts: { label: string; value: string }[] = [];
    for (const p of md.providers || []) {
      const pid = String((p as any).id || '');
      const models = (p as any).models || {};
      for (const mid of Object.keys(models)) opts.push({ label: `${pid}/${mid}`, value: `${pid}/${mid}` });
    }
    modelOptions.value = opts;
  } catch { /* 选择器加载失败不阻塞聊天 */ }
}

// ---------- 事件订阅 ----------

async function subscribe(): Promise<void> {
  unsubscribe();
  let direct: { ok: boolean; direct: boolean; url: string } = { ok: false, direct: false, url: '' };
  try {
    direct = await api.ocDirect(props.instance.id);
  } catch { /* 走代理 */ }
  directKind = direct.ok && direct.direct ? 'direct' : 'proxy';
  if (directKind === 'direct' && direct.url) {
    // managed 实例无鉴权且 CORS 已放本地源：浏览器直连 opencode SSE（少一跳，最真流式）
    es = new EventSource(`${direct.url}/event`);
    es.onmessage = (e) => {
      try { applyEvents([JSON.parse(e.data)]); } catch { /* 单帧坏 */ }
    };
    es.onerror = () => scheduleReconnect();
    return;
  }
  // 代理：fetch + Authorization（EventSource 无法带 token）
  proxyAbort = new AbortController();
  try {
    const token = getApiToken();
    const res = await fetch(`/api/opencode/instances/${encodeURIComponent(props.instance.id)}/events`, {
      headers: { accept: 'text/event-stream', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      signal: proxyAbort.signal,
    });
    // managed 实例代理路由会返回 JSON 直连提示（{direct:true,url}）——识别后改走直连，
    // 否则会把 JSON 当 SSE 解析、静默无事件（2026-09-24 排障）
    const ct = String(res.headers.get('content-type') || '');
    if (ct.includes('application/json')) {
      const hint = (await res.json().catch(() => null)) as { direct?: boolean; url?: string } | null;
      if (hint?.direct && hint.url) {
        directKind = 'direct';
        es = new EventSource(`${hint.url}/event`);
        es.onmessage = (e) => {
          try { applyEvents([JSON.parse(e.data)]); } catch { /* 单帧坏 */ }
        };
        es.onerror = () => scheduleReconnect();
        return;
      }
      throw new Error('实例不可代理（未连接或 attached 无凭据）');
    }
    if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
    proxyReader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    for (;;) {
      const { done, value } = await proxyReader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (line.startsWith('data:')) {
          try { applyEvents([JSON.parse(line.slice(5).trim())]); } catch { /* 帧坏 */ }
        }
      }
    }
  } catch (e: any) {
    if (!proxyAbort?.signal.aborted) scheduleReconnect();
  }
}

function scheduleReconnect(): void {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    void subscribe();
  }, 3000);
}

function unsubscribe(): void {
  es?.close();
  es = null;
  proxyAbort?.abort();
  proxyAbort = null;
  proxyReader = null;
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
}

// WS oc_event 兜底（manager→WS 通道；direct/proxy 之一挂了也有事件）
const offWs = onEvent((env: { type: string; payload?: any }) => {
  if (env.type !== 'oc_event' || env.payload?.instance !== props.instance.id) return;
  applyEvents([env.payload]);
});

// ---------- 操作 ----------

async function send(): Promise<void> {
  const text = draft.value.trim();
  if (!text || sending.value) return;
  // busy 接管会话的首次发送需显式确认（接管横幅已警示，这里是最后一道闸）
  if (props.takeoverHint?.busy && !busyAck) {
    try {
      await ElMessageBox.confirm(
        `该会话正被 TUI 使用。确认把这条消息发进去？\n\n「${text.slice(0, 80)}${text.length > 80 ? '…' : ''}」`,
        '发送确认 · 消息将进入他人正在使用的会话',
        { confirmButtonText: '发送', cancelButtonText: '取消', type: 'warning', autofocus: false },
      );
      busyAck = true;
    } catch {
      return; // 取消发送
    }
  }
  sending.value = true;
  try {
    const m = model.value || undefined;
    const payload = { prompt: text, ...(m ? { model: m } : {}), ...(agent.value ? { agent: agent.value } : {}) };
    const r = text.startsWith('/')
      ? await api.ocCommand(props.instance.id, props.sessionId, text.replace(/^\//, ''))
      : await api.ocPrompt(props.instance.id, props.sessionId, payload);
    if (r.ok) {
      draft.value = '';
      // 立即拉一次：prompt 同步返回即已跑完；异步进展由事件流接管
      setTimeout(() => void reloadAll(), 300);
    } else {
      ElMessage.warning((r as any).error || '发送失败');
    }
  } catch (e: any) {
    showApiError(e);
  } finally {
    sending.value = false;
  }
}

function onKeydown(e: KeyboardEvent): void {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    void send();
  }
}

async function abort(): Promise<void> {
  try {
    await api.ocAbort(props.instance.id, props.sessionId);
    ElMessage.success('已打断');
  } catch (e: any) { showApiError(e); }
}

async function revertTo(m: Record<string, any>): Promise<void> {
  try {
    await api.ocRevert(props.instance.id, props.sessionId, String(m.id));
    ElMessage.success('已回退到该消息');
    setTimeout(() => void reloadAll(), 300);
  } catch (e: any) { showApiError(e); }
}

/** 回答提问：answerQuestion 走本地 stream 先移除（双保险），服务端事件随后确认 */
async function answerQuestion(requestId: string, answers: string[][]): Promise<void> {
  const cleaned = answers.map((a) => a.filter((x) => typeof x === 'string' && x.trim())).filter((a) => a.length);
  if (!cleaned.length) { ElMessage.warning('回答不能为空'); return; }
  try {
    const r = await api.ocAnswerQuestion(props.instance.id, requestId, cleaned);
    if (r.ok) {
      stream.applyEvent({ type: 'question.replied', properties: { requestID: requestId } });
      flush();
      ElMessage.success('已作答');
    } else {
      ElMessage.warning(r.error || '作答失败');
    }
  } catch (e: any) { showApiError(e); }
}

async function rejectQuestion(requestId: string): Promise<void> {
  try {
    const r = await api.ocRejectQuestion(props.instance.id, requestId);
    if (r.ok) {
      stream.applyEvent({ type: 'question.rejected', properties: { requestID: requestId } });
      flush();
      ElMessage.success('已谢绝，opencode 将自行继续');
    } else {
      ElMessage.warning(r.error || '操作失败');
    }
  } catch (e: any) { showApiError(e); }
}

async function answerPerm(pid: string, response: 'once' | 'always' | 'reject'): Promise<void> {
  try {
    await api.ocResolvePermission(props.instance.id, props.sessionId, pid, response);
    stream.applyEvent({ type: 'permission.replied', properties: { permissionID: pid } });
    flush();
  } catch (e: any) { showApiError(e); }
}

async function loadDiff(): Promise<void> {
  loadingDiff.value = true;
  try {
    const d = await api.ocDiff(props.instance.id, props.sessionId);
    diffFiles.value = d.diff || [];
  } catch (e: any) { showApiError(e); } finally { loadingDiff.value = false; }
}

async function openInTui(): Promise<void> {
  try {
    await api.ocTuiOpenSessions(props.instance.id);
    await api.ocTuiToast(props.instance.id, 'co-team 正在接管此对话', 'info').catch(() => {});
    ElMessage.success('已通知 TUI 打开会话选择器');
  } catch (e: any) { showApiError(e); }
}

/** PTY：签票 → WebSocket 直连 opencode（协议尽力渲染，实验性） */
async function openPty(p: Record<string, any>): Promise<void> {
  ptyTitle.value = `终端 · ${p.title || p.command || p.id}`;
  ptyText.value = '';
  ptyInput.value = '';
  ptyDlg.value = true;
  try {
    const t = await api.ocPtyTicket(props.instance.id, String(p.id));
    if (!t.ok) { ElMessage.warning((t as any).error || '签票失败'); return; }
    const wsUrl = `${t.ws_url}${t.ws_url.includes('?') ? '&' : '?'}ticket=${encodeURIComponent(t.ticket)}`;
    const ws = new WebSocket(wsUrl);
    ptyWs = ws;
    ws.onmessage = (e) => {
      const data = typeof e.data === 'string' ? e.data : '';
      ptyText.value = (ptyText.value + data).slice(-20000);
      void nextTick(() => { if (ptyOut.value) ptyOut.value.scrollTop = ptyOut.value.scrollHeight; });
    };
    ws.onerror = () => ElMessage.warning('PTY 连接失败（实验性）');
    ws.onclose = () => { ptyWs = null; };
  } catch (e: any) { showApiError(e); }
}

function ptySend(): void {
  const cmd = ptyInput.value;
  if (!cmd || !ptyWs) return;
  ptyWs.send(cmd + '\r');
  ptyInput.value = '';
}

function closePty(): void {
  ptyWs?.close();
  ptyWs = null;
}

function isNearEnd(): boolean {
  const el = streamEl.value;
  return !el || el.scrollHeight - el.scrollTop - el.clientHeight < 160;
}
function scrollEnd(): void {
  const el = streamEl.value;
  if (el) el.scrollTop = el.scrollHeight;
}
function onScroll(): void { /* 预留：向上懒加载 */ }

watch(() => props.sessionId, () => {
  void reloadAll();
  void subscribe();
});
watch(diffDlg, (v) => { if (v && !diffFiles.value.length) void loadDiff(); });

onMounted(() => {
  void reloadAll();
  void subscribe();
  void loadSelectors();
});
onBeforeUnmount(() => {
  unsubscribe();
  offWs();
  closePty();
  if (renderRaf) cancelAnimationFrame(renderRaf);
});
</script>

<style scoped>
.occ { display: flex; flex-direction: column; height: 100%; min-height: 0; }
.occ-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 8px 12px; border-bottom: 1px solid var(--el-border-color-lighter); }
.h-left { display: flex; align-items: center; gap: 8px; min-width: 0; }
.s-title { font-weight: 600; max-width: 320px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.h-right { display: flex; align-items: center; gap: 6px; }
.live { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; color: var(--el-color-primary); }
.dot { width: 8px; height: 8px; border-radius: 50%; background: var(--el-color-primary); display: inline-block; }
.dot.pulse { animation: ocpulse 1s ease-in-out infinite; }
@keyframes ocpulse { 0%, 100% { opacity: 0.35; } 50% { opacity: 1; } }
.ribbon { padding: 6px 12px; font-size: 12px; }
.takeover-banner { padding: 7px 12px; font-size: 12px; background: var(--el-color-primary-light-9); color: var(--el-color-primary-darken-2); border-bottom: 1px solid var(--el-border-color-lighter); }
.takeover-banner.warn { background: var(--el-color-warning-light-9); color: var(--el-color-warning-darken-2); }
.ribbon.warn { background: var(--el-color-warning-light-9); color: var(--el-color-warning-darken-2); }
.ribbon.err { background: var(--el-color-danger-light-9); color: var(--el-color-danger); }
.todos { display: flex; gap: 6px; padding: 6px 12px; overflow-x: auto; border-bottom: 1px solid var(--el-border-color-lighter); }
.todo { display: inline-flex; align-items: center; gap: 5px; font-size: 12px; padding: 2px 8px; border-radius: 10px; background: var(--el-fill-color-light); white-space: nowrap; }
.todo.in_progress { background: var(--el-color-primary-light-9); color: var(--el-color-primary); }
.tdot { width: 6px; height: 6px; border-radius: 50%; background: var(--el-text-color-disabled); }
.tdot.in_progress { background: var(--el-color-primary); animation: ocpulse 1s ease-in-out infinite; }
.tdot.completed { background: var(--el-color-success); }
.stream { flex: 1; overflow-y: auto; min-height: 0; }
.col { max-width: 860px; margin: 0 auto; padding: 14px 16px 24px; display: flex; flex-direction: column; gap: 14px; }
.stream-empty { text-align: center; color: var(--el-text-color-secondary); padding: 40px 0; font-size: 13px; }
.page-head { text-align: center; padding: 4px 0 10px; }
.ttrim { font-size: 10px; color: var(--el-color-warning); border: 1px solid var(--el-color-warning-light-5); border-radius: 4px; padding: 0 5px; cursor: pointer; flex: none; }
.ttrim:hover { background: var(--el-color-warning-light-9); }
.user-row { display: flex; justify-content: flex-end; }
.user-msg { max-width: 78%; background: var(--el-color-primary-light-9); border: 1px solid var(--el-color-primary-light-7); border-radius: 10px 10px 2px 10px; padding: 8px 12px; }
.user-msg .plain { white-space: pre-wrap; word-break: break-word; font-size: 13.5px; line-height: 1.65; }
.a-block { min-width: 0; }
.a-head { display: flex; align-items: center; gap: 8px; margin-bottom: 4px; }
.a-name { font-size: 12px; font-weight: 600; color: var(--el-text-color-primary); }
.a-text { font-size: 14px; line-height: 1.7; }
.a-think { margin: 6px 0; border: 1px solid var(--el-border-color-lighter); border-radius: 8px; padding: 4px 10px; }
.a-think summary { cursor: pointer; display: flex; align-items: center; gap: 6px; font-size: 12px; color: var(--el-text-color-secondary); list-style: none; }
.a-think summary::-webkit-details-marker { display: none; }
.a-think .car { transition: transform 0.15s; display: inline-block; }
.a-think[open] .car { transform: rotate(90deg); }
.think-body { font-size: 12px; color: var(--el-text-color-secondary); white-space: pre-wrap; padding: 6px 0 2px; max-height: 220px; overflow-y: auto; }
.a-ops { opacity: 0; transition: opacity 0.15s; }
.a-block:hover .a-ops { opacity: 1; }
.step-chip { text-align: center; font-size: 11px; color: var(--el-text-color-disabled); padding: 2px 0; }
.patch-chip { font-size: 12px; color: var(--el-text-color-secondary); background: var(--el-fill-color-light); border-radius: 6px; padding: 4px 8px; }
.chip { font-size: 12px; color: var(--el-text-color-secondary); background: var(--el-fill-color-light); border-radius: 6px; padding: 2px 8px; display: inline-block; margin: 2px 0; }
.chip.warn { background: var(--el-color-warning-light-9); color: var(--el-color-warning-darken-2); }
.tool-card { border: 1px solid var(--el-border-color-lighter); border-radius: 8px; margin: 6px 0; overflow: hidden; }
.tool-card.running { border-color: var(--el-color-primary-light-5); }
.tool-card.error { border-color: var(--el-color-danger-light-5); }
.tc-head { display: flex; align-items: center; gap: 8px; padding: 6px 10px; cursor: pointer; font-size: 12.5px; background: var(--el-fill-color-lighter); }
.ticon { font-style: normal; width: 14px; text-align: center; }
.ticon.completed { color: var(--el-color-success); }
.ticon.error { color: var(--el-color-danger); }
.ticon.running, .ticon.pending { color: var(--el-color-primary); animation: ocpulse 1s ease-in-out infinite; }
.tname { font-weight: 600; }
.targs { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--el-text-color-secondary); }
.tstate { color: var(--el-text-color-disabled); }
.tcar { color: var(--el-text-color-disabled); }
.tc-body { padding: 8px 10px; border-top: 1px solid var(--el-border-color-lighter); }
.tc-lab { font-size: 11px; color: var(--el-text-color-secondary); margin-bottom: 2px; }
.tc-pre { margin: 0 0 8px; font-size: 12px; background: var(--el-fill-color-light); border-radius: 6px; padding: 8px; max-height: 260px; overflow: auto; white-space: pre-wrap; word-break: break-all; }
.tc-sec.err { color: var(--el-color-danger); font-size: 12px; }
.q-card { border: 1px solid var(--el-color-primary); border-radius: 8px; padding: 10px 12px; background: var(--el-color-primary-light-9); }
.q-l1 { font-size: 12px; font-weight: 600; color: var(--el-color-primary-darken-2); }
.q-text { font-size: 13px; margin: 4px 0 8px; }
.q-opts { display: flex; flex-wrap: wrap; gap: 8px; }
.q-custom { display: flex; gap: 8px; margin-top: 8px; }
.q-acts { display: flex; justify-content: flex-end; margin-top: 6px; }
.perm-card { border: 1px solid var(--el-color-warning); border-radius: 8px; padding: 10px 12px; background: var(--el-color-warning-light-9); }
.perm-l1 { font-size: 12px; color: var(--el-color-warning-darken-2); font-weight: 600; }
.perm-title { font-size: 13px; margin-top: 2px; }
.perm-cmd { font-size: 12px; color: var(--el-text-secondary); margin-top: 4px; word-break: break-all; }
.perm-acts { display: flex; gap: 8px; margin-top: 8px; justify-content: flex-end; }
.pty-strip { display: flex; gap: 6px; padding: 6px 12px; border-top: 1px solid var(--el-border-color-lighter); overflow-x: auto; }
.pty-chip { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; padding: 3px 10px; border-radius: 10px; background: var(--el-fill-color-light); cursor: pointer; }
.pty-chip:hover { background: var(--el-fill-color); }
.pdot { width: 6px; height: 6px; border-radius: 50%; }
.pdot.on { background: var(--el-color-success); animation: ocpulse 1.4s ease-in-out infinite; }
.pdot.off { background: var(--el-text-color-disabled); }
.composer { border-top: 1px solid var(--el-border-color-lighter); padding: 8px 12px; }
.composer.readonly { text-align: center; color: var(--el-text-color-secondary); font-size: 12px; padding: 12px; }
.comp-r1 { display: flex; align-items: center; gap: 8px; margin-bottom: 6px; }
.sel { width: 220px; }
.comp-r2 { display: flex; gap: 8px; align-items: flex-end; }
.ta-wrap { flex: 1; }
.send-btn { flex-shrink: 0; }
.diff-none { text-align: center; color: var(--el-text-color-secondary); padding: 20px; }
.diff-file { margin-bottom: 14px; }
.diff-file-head { display: flex; gap: 10px; align-items: center; font-size: 12.5px; }
.fname { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; }
.add { color: var(--el-color-success); }
.del { color: var(--el-color-danger); }
.diff-patch { font-size: 11.5px; background: var(--el-fill-color-light); border-radius: 6px; padding: 8px; overflow: auto; max-height: 300px; }
.diff-patch .add { color: var(--el-color-success); }
.diff-patch .del { color: var(--el-color-danger); }
.diff-patch .ctx { color: var(--el-text-color-secondary); }
.pty-term { background: #0b0e14; border-radius: 8px; padding: 10px; }
.pty-out { margin: 0; color: #c8d1e0; font-size: 12px; height: 320px; overflow: auto; white-space: pre-wrap; word-break: break-all; }
.pty-in { display: flex; gap: 8px; margin-top: 8px; }
.mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
.dim { color: var(--el-text-color-secondary); }
.mini { font-size: 11px; }
</style>
