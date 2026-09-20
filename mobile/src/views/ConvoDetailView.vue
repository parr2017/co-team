<template>
  <div class="page">
    <van-nav-bar left-arrow fixed placeholder @click-left="router.back()">
      <template #title>
        <span class="nav-title">{{ detail?.title || '协作会话' }}</span>
      </template>
      <template #right>
        <span class="mono model-pill" @click="modelSheet = true">{{ shortModel }} ▾</span>
        <van-icon name="ellipsis" size="18" style="margin-left: 8px" @click="moreSheet = true" />
      </template>
    </van-nav-bar>
    <div class="projline">{{ detail?.workspace || '（未绑定项目）' }}</div>

    <div ref="streamEl" class="stream">
      <!-- v5 原生风轮次渲染 -->
      <template v-for="(turn, ti) in turns" :key="ti">
        <div class="day-sep" v-if="turn.user && ti > 0">{{ fmtTime(turn.user.ts) }}</div>

        <div v-if="turn.user && turn.user.kind === 'text'" class="u-row">
          <div class="u-bub">
            <div class="plain">{{ turn.user.text }}</div>
            <div v-if="turn.user.meta?.images?.length" class="imgrow">
              <img v-for="(img, i) in turn.user.meta.images" :key="i" class="ph" :src="img.url" @click="previewImg(img.url)" />
            </div>
          </div>
        </div>
        <div v-else-if="turn.user && turn.user.kind === 'file'" class="u-row">
          <div class="u-bub">
            <div v-for="f in turn.user.meta?.files || []" :key="f.id" class="file-line">
              <van-icon name="description" /><a :href="f.url" target="_blank">{{ f.name }}</a>
            </div>
          </div>
        </div>

        <div v-if="turn.items.length" class="a">
          <div class="a-head">
            <span v-if="isTurnLive(turn)" class="live" />
            <span class="nm">搭档</span>
            <span class="md mono">{{ turnModel(turn) }}</span>
            <span class="tm">{{ isTurnLive(turn) ? '运行中' : (turnSteps(turn) ? turnSteps(turn) + ' 步' : '') }}</span>
          </div>

          <!-- 步骤清单（最新轮 + 有 plan 时）：胶囊/展开 -->
          <div v-if="ti === turns.length - 1 && detail?.plan?.steps?.length" class="plan">
            <div v-if="!planOpen" class="plan-pill" @click="planOpen = true">
              <span class="plan-dot" />
              <span>步骤 {{ planDone }}/{{ detail.plan.steps.length }}</span>
              <span class="cur">{{ planCur?.text || '已完成' }}</span>
              <span class="car">▸</span>
            </div>
            <div v-else class="plan-full">
              <div class="plan-head" @click="planOpen = false">
                <span>任务计划 {{ planDone }}/{{ detail.plan.steps.length }}</span>
                <span class="car" style="transform:rotate(90deg)">▸</span>
              </div>
              <div v-for="(st, si) in detail.plan.steps" :key="si" class="plan-step" :class="st.status">
                <span class="mark">{{ st.status === 'done' ? '✓' : st.status === 'in_progress' ? '●' : st.status === 'blocked' ? '⊘' : '○' }}</span>
                <span>{{ st.text }}</span>
              </div>
            </div>
          </div>

          <!-- 执行摘要 chip（点开日志面板） -->
          <div v-if="turnActs(turn).length" class="chip" @click="toggleLogs(turn)">
            <span class="st" />
            <span>执行了 {{ turnSteps(turn) }} 步</span>
            <span class="car" :class="{ open: logsOpen.has(turn.user?.id || String(ti)) }">▶</span>
          </div>
          <div v-if="turnActs(turn).length && logsOpen.has(turn.user?.id || String(ti))" class="logs">
            <div v-for="(a, ai) in turnActs(turn)" :key="ai" class="lg" :class="{ err: !a.ok }">
              <span class="st" />
              <span class="tg">{{ a.tool }}</span>
              <span class="ar">{{ a.args }}</span>
              <span class="rs" :class="{ good: a.ok && a.isExit }">{{ a.res || (a.live ? '执行中' : '') }}</span>
            </div>
          </div>

          <!-- 轮内非工具卡 -->
          <template v-for="m in turn.items" :key="m.id">
            <div v-if="m.kind === 'notice'" class="notice" :class="{ warn: (m.meta as any)?.retry || (m.meta as any)?.turn_complete || (m.meta as any)?.stale_reset }">{{ m.text }}</div>
            <div v-else-if="m.kind === 'degrade' && (m.meta as any)?.broken" class="inline danger">模型断连 · {{ m.text }}</div>
        <div v-else-if="m.kind === 'degrade' && (m.meta as any)?.recovered" class="inline warn">已恢复 · {{ m.text }}</div>
        <div v-else-if="m.kind === 'degrade'" class="inline warn">{{ m.text }}</div>
            <div v-else-if="m.kind === 'approval'" class="appr">
              <div class="l1">待审批 · 白名单外命令</div>
              <div class="cmd mono">{{ m.meta?.command || m.text }}</div>
              <div v-if="m.meta?.status === 'pending'" class="acts">
                <button @click="resolveApproval(m.meta!.approval_id, 'reject')">拒绝</button>
                <button @click="resolveApproval(m.meta!.approval_id, 'always')">总是允许</button>
                <button class="p" @click="resolveApproval(m.meta!.approval_id, 'once')">批准一次</button>
              </div>
              <div v-else class="acts"><span class="done-lb">{{ m.meta?.status === 'rejected' ? '已拒绝' : m.meta?.status === 'approved_always' ? '已授权 · 不再询问' : '已执行' }}</span></div>
            </div>
            <div v-else-if="m.kind === 'ask'" class="appr ask">
              <div class="l1 ask-lb">需要你拍板</div>
              <div class="cmd" style="white-space:normal">{{ m.text }}</div>
              <div v-if="m.meta?.status === 'pending'" class="acts">
                <input v-model="askDraft" placeholder="输入回答" @keydown.enter="submitAsk(m.meta!.ask_id)" />
                <button class="p" @click="submitAsk(m.meta!.ask_id)">回复</button>
              </div>
              <div v-else class="acts"><span class="done-lb">{{ m.meta?.status === 'answered' ? '已回答：' + (m.meta?.answer || '').slice(0, 40) : '超时未回答' }}</span></div>
            </div>
            <div v-else-if="m.kind === 'file'" class="file-inline" @click="previewFile(m.text)">
              <van-icon name="description" /><span class="mono">{{ m.text }}</span><span class="sp" /><van-icon name="arrow" />
            </div>
            <div v-else-if="m.kind === 'interrupt'" class="interrupt-sep"><span class="sq" />已打断 · 输入新指令继续</div>
          </template>

          <!-- 思考段（回放） -->
          <div v-if="turnThinking(turn) && !isTurnLive(turn)" class="thinking">
            <div class="lab">思考</div>{{ turnThinking(turn) }}
          </div>

          <!-- 结论全宽 -->
          <div v-for="m in turn.items.filter(x => x.role === 'assistant' && x.kind === 'text')" :key="'c' + m.id" class="ans">
            <div class="md"><MdView :source="m.text" /></div>
            <div class="ops">
              <span class="op" @click="copyText(m.text)">复制</span>
              <span class="op" @click="forkMsg(m)">分叉</span>
              <span class="tm mono">{{ fmtTime(m.ts) }}</span>
            </div>
          </div>

          <!-- diff 细条 -->
          <div v-for="m in turn.items.filter(x => x.kind === 'diff')" :key="'d' + m.id" class="diff">
            <div class="files">
              <div v-for="f in (m.meta?.files || []).slice(0, 5)" :key="f" class="f mono">{{ f }}</div>
            </div>
            <span class="btn" @click="showDiffDialog(m.meta?.patch || '')">查看 diff</span>
          </div>

          <!-- 运行中 live -->
          <template v-if="isTurnLive(turn)">
            <div v-if="toolLive.length" class="logs live-logs">
              <div v-for="(tl, tli) in toolLive" :key="'tl' + tli" class="lg">
                <span class="st" />
                <span class="tg">{{ tl.tool }}</span>
                <span class="ar">{{ tl.command }}</span>
                <span class="rs">执行中…</span>
              </div>
            </div>
            <div v-if="reasonBuf" class="thinking">
              <div class="lab">思考</div>{{ reasonBuf.slice(-700) }}
            </div>
            <div v-if="streamingText" class="ans"><div class="md"><MdView :source="streamingText" /><span class="cursor" /></div></div>
            <div v-if="!reasonBuf && !streamingText && !toolLive.length" class="notice">正在思考…</div>
          </template>
        </div>
      </template>

      <div v-if="queuedCount" class="queued">
        <span>排队中 {{ queuedCount }} 条</span>
        <button class="promote-btn" :disabled="promoting" @click="promoteNow">立即插入</button>
      </div>

      <van-empty v-if="detail && !detail.messages.length" description="发第一条消息开始协作" />
    </div>

    <!-- 输入栏 -->
    <div class="composer" safe-area-inset-bottom>
      <div class="chips" v-if="pendingImages.length || pendingFiles.length">
        <span v-for="(img, i) in pendingImages" :key="'i' + i" class="chip">图 {{ img.name }} <b @click="pendingImages.splice(i, 1)">×</b></span>
        <span v-for="(f, i) in pendingFiles" :key="'f' + i" class="chip">文 {{ f.name }} <b @click="pendingFiles.splice(i, 1)">×</b></span>
      </div>
      <div class="comp-meta">
        <span class="hint">{{ busy ? '会话进行中 · 发送将自动排队' : 'Enter 发送' }}</span>
        <span class="ic stop-ic" :class="{ disabled: !busy }" @click="stop"><van-icon name="stop-circle-o" /></span>
      </div>
      <div class="atpanel" v-if="atOpen">
        <input v-model="atQuery" placeholder="输入文件名过滤" @input="atFilter" />
        <div class="atlist">
          <div v-for="f in atResults" :key="f" class="mono" @click="pickAt(f)">{{ f }}</div>
          <div v-if="!atResults.length" class="dim" style="padding: 6px 10px">无匹配文件</div>
        </div>
      </div>
      <div class="input-flat">
        <div class="input-box">
          <textarea v-model="draft" rows="1" placeholder="提出后续修改要求…" @keydown.enter.prevent="send" />
          <span class="ic" @click="imgInput?.click()"><van-icon name="photo-o" /></span>
          <span class="ic" @click="fileInput?.click()"><van-icon name="description" /></span>
          <span class="ic" @click="openAt"><van-icon name="link-o" /></span>
        </div>
        <button class="send" :disabled="sending" @click="send">↑</button>
        <input ref="imgInput" type="file" accept="image/*" multiple hidden @change="onPickImages" />
        <input ref="fileInput" type="file" multiple hidden @change="onPickFiles" />
      </div>
    </div>

    <!-- 模型快切 -->
    <van-popup v-model:show="modelSheet" position="bottom" round>
      <div class="sheet">
        <div class="sh">切换主模型</div>
        <div v-for="m in models" :key="m.id" class="si mono" :class="{ cur: m.id === detail?.model_id }" @click="pickModel(m.id)">{{ m.name }}{{ m.provider ? ' · ' + m.provider : '' }}</div>
      </div>
    </van-popup>

    <!-- 更多操作 -->
    <van-popup v-model:show="moreSheet" position="bottom" round>
      <div class="sheet">
        <div class="switch-row">
          <span>自动切换模型<small>主模型失败时自动沿降级链换模</small></span>
          <span class="sw" :class="{ on: detail?.auto_switch }" @click="toggleAutoSwitch">{{ detail?.auto_switch ? '开' : '关' }}</span>
        </div>
        <div class="si" @click="permSheet = true">权限级别（{{ permLabel }}）</div>
        <div class="gap" />
        <div class="si" @click="doDiff">本轮 diff 汇总</div>
        <div class="si" @click="doRollback">回滚快照</div>
        <div class="si" @click="renameDlg = true">重命名</div>
        <div class="si" @click="doFork">复制为新会话（fork）</div>
        <div class="gap" />
        <div class="si danger" @click="doDelete">删除会话</div>
      </div>
    </van-popup>

    <!-- 重命名 -->
    <van-popup v-model:show="renameDlg" position="bottom" round>
      <div class="sheet">
        <div class="sh">重命名会话</div>
        <div class="frow"><input v-model="renameDraft" /></div>
        <div class="btnrow">
          <button class="btn-g" @click="renameDlg = false">取消</button>
          <button class="btn-p" @click="doRename">保存</button>
        </div>
      </div>
    </van-popup>

    <!-- 长按消息 -->
    <van-popup v-model:show="lpSheet" position="bottom" round>
      <div class="sheet">
        <div class="si" @click="lpCopy">复制</div>
        <div class="si" @click="lpQuote">引用回复</div>
        <div class="si" @click="lpSheet = false; doDiff()">查看本轮 diff</div>
      </div>
    </van-popup>

    <!-- diff -->
    <!-- 权限级别选项 -->
    <van-popup v-model:show="permSheet" position="bottom" round :style="{ maxHeight: '50%' }">
      <div class="sheet">
        <div class="sh-h"><span>权限级别</span><span class="x" @click="permSheet = false">取消</span></div>
        <div class="si" :class="{ cur: !detail?.policy_level }" @click="pickPerm('')">继承全局（whitelist_auto）</div>
        <div class="si" :class="{ cur: detail?.policy_level === 'plan_only' }" @click="pickPerm('plan_only')">plan_only · 只出方案</div>
        <div class="si" :class="{ cur: detail?.policy_level === 'readonly' }" @click="pickPerm('readonly')">readonly · 只读</div>
        <div class="si" :class="{ cur: detail?.policy_level === 'approve_required' }" @click="pickPerm('approve_required')">approve_required · 改动需审批</div>
        <div class="si" :class="{ cur: detail?.policy_level === 'whitelist_auto' }" @click="pickPerm('whitelist_auto')">whitelist_auto · 白名单自动</div>
        <div class="si" :class="{ cur: detail?.policy_level === 'full' }" @click="pickPerm('full')">full · 目录内完全控制</div>
      </div>
    </van-popup>

    <van-popup v-model:show="diffDlg" position="bottom" :style="{ height: '80%' }" round>
      <div class="sheet diffsheet">
        <div class="sh-h"><span>本轮 diff</span><span class="x" @click="diffDlg = false">取消</span></div>
        <div class="sh">{{ diffFiles.length }} 个文件 · 上下滑动查看</div>
        <pre class="diff-patch"><code><span v-for="(l, i) in diffLines" :key="i" :class="lineClass(l)">{{ l }}
</span></code></pre>
      </div>
    </van-popup>

    <!-- 文件预览 -->
    <van-popup v-model:show="fileDlg" position="bottom" :style="{ height: '80%' }" round>
      <div class="sheet diffsheet">
        <div class="sh">{{ previewName }}</div>
        <img v-if="previewKind === 'image'" :src="previewDataUrl" class="preview-img" />
        <pre v-else class="preview-text">{{ previewContent }}</pre>
      </div>
    </van-popup>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onActivated, onBeforeUnmount, onMounted, reactive, ref } from 'vue';
import { useRouter } from 'vue-router';
import { showFailToast, showConfirmDialog, showImagePreview, showToast } from 'vant';
import { api, type ConvoDetail, type ConvoMessage } from '../api';
import { useWs } from '../composables/useWs';
import MdView from '../components/MdView.vue';

const router = useRouter();
const { onEvent } = useWs();

const detail = ref<ConvoDetail | null>(null);
const draft = ref('');
const sending = ref(false);
const queuedCount = ref(0);
const streamEl = ref<HTMLElement>();
const streamBuf = ref<Record<string, string>>({});
const reasonBuf = ref('');
// 工具执行中步骤（convo_tool_start → convo_tool）：实时展示"正在执行…"，批次完成清空
const toolLive = ref<{ tool: string; command: string }[]>([]);

// v5：轮次分组 + plan/logs 状态
interface TurnGroup { user?: ConvoMessage; items: ConvoMessage[] }
const turns = computed<TurnGroup[]>(() => {
  const out: TurnGroup[] = [];
  for (const m of detail.value?.messages || []) {
    if (m.role === 'user') out.push({ user: m, items: [] });
    else { if (!out.length) out.push({ items: [] }); out[out.length - 1].items.push(m); }
  }
  return out;
});
const planOpen = ref(false);
const planDone = computed(() => detail.value?.plan?.steps.filter((x) => x.status === 'done').length || 0);
const planCur = computed(() => detail.value?.plan?.steps.find((x) => x.status === 'in_progress'));
const logsOpen = reactive(new Set<string>());
function toggleLogs(turn: TurnGroup) {
  const k = turn.user?.id || String(turn.items[0]?.id || '0');
  if (logsOpen.has(k)) logsOpen.delete(k); else logsOpen.add(k);
}
function isTurnLive(turn: TurnGroup): boolean {
  const hasConclusion = turn.items.some((m) => m.role === 'assistant' && m.kind === 'text');
  return busy.value && !hasConclusion;
}
function turnModel(turn: TurnGroup): string {
  return detail.value?.model_id || turn.items.find((m) => m.model)?.model || '';
}
function turnSteps(turn: TurnGroup): number {
  return turn.items.filter((m) => m.kind === 'tool').reduce((n, m) => n + ((m.meta?.calls || []) as any[]).length, 0);
}
function fmtTime(ts: string): string {
  const d = new Date(ts);
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}
interface ActLine { tool: string; args: string; res: string; ok: boolean; isExit: boolean; live?: boolean }
function turnActs(turn: TurnGroup): ActLine[] {
  const lines: ActLine[] = [];
  for (const m of turn.items) {
    if (m.kind !== 'tool') continue;
    const calls = (m.meta?.calls || []) as { tool: string; args_summary?: string; output_gist?: string; ok?: boolean; mcp?: { server: string } }[];
    for (const c of calls) {
      const isExit = /exit \d+/.test(c.output_gist || '');
      let res = '';
      if (isExit) res = (c.output_gist || '').match(/exit \d+/)?.[0] || '';
      else if (c.ok === false) res = c.tool.startsWith('mcp__') ? 'MCP 失败' : '不存在';
      else if (/\+\d+(\s*−\d+)?/.test(c.output_gist || '')) res = (c.output_gist || '').match(/\+\d+(\s*−\d+)?/)?.[0] || '';
      lines.push({ tool: c.tool.startsWith('mcp__') ? 'mcp:' + c.mcp?.server : c.tool, args: c.args_summary || '', res, ok: c.ok !== false, isExit });
    }
    if (busy.value && m === turn.items[turn.items.length - 1]) {
      lines.push({ tool: '…', args: '下一步执行中', res: '', ok: true, isExit: false, live: true });
    }
  }
  return lines;
}
function turnThinking(turn: TurnGroup): string {
  return turn.items.map((m) => (m.meta?.reasoning as string) || '').filter(Boolean).join('\n\n');
}
async function copyText(t: string) {
  try { await navigator.clipboard?.writeText(t); showToast('已复制'); } catch { /* ignore */ }
}
async function forkMsg(m: ConvoMessage) {
  try {
    const r = await api.convoFork(convoId, { message_id: m.id, title: `${detail.value?.title || '会话'}（分叉）` });
    showToast('已分叉出新会话');
    router.replace(`/convo/${r.convo.id}`);
  } catch (e: any) { showFailToast(e.message); }
}
const streaming = ref(false);
const streamingText = computed(() => Object.values(streamBuf.value).join(''));
const askDraft = ref('');
const promoting = ref(false);
const permSheet = ref(false);
const PERM_LABELS: Record<string, string> = {
  '': '继承全局', plan_only: '只出方案', readonly: '只读', approve_required: '改动需审批', whitelist_auto: '白名单自动', full: '完全控制',
};
const permLabel = computed(() => PERM_LABELS[detail.value?.policy_level || ''] || '继承全局');
async function pickPerm(level: string) {
  permSheet.value = false;
  try {
    await api.convoUpdate(convoId, { policy_level: level || null });
    showToast(level ? `权限已切换为 ${PERM_LABELS[level]}` : '权限已切换为继承全局');
    await load();
  } catch (e: any) { showFailToast(e.message); }
}
async function toggleAutoSwitch() {
  try {
    const next = !(detail.value?.auto_switch);
    await api.convoUpdate(convoId, { auto_switch: next });
    showToast(next ? '已开启自动切换' : '已关闭自动切换');
    await load();
  } catch (e: any) { showFailToast(e.message); }
}
async function promoteNow() {
  promoting.value = true;
  try {
    await api.convoPromote(convoId);
    showToast('已打断当前执行，排队消息立即处理');
    await load();
  } catch (e: any) {
    showFailToast(e.message);
  } finally {
    promoting.value = false;
  }
}
const busy = computed(() => !!detail.value && ['running', 'waiting_approval', 'waiting_ask'].includes(detail.value.status));
const shortModel = computed(() => (detail.value?.model_id || '自动').slice(0, 12));

const models = ref<{ id: string; name: string; provider?: string }[]>([]);
const modelSheet = ref(false);
const moreSheet = ref(false);
const renameDlg = ref(false);
const renameDraft = ref('');
const lpSheet = ref(false);
const lpTarget = ref<ConvoMessage | null>(null);
const diffDlg = ref(false);
const diffFiles = ref<string[]>([]);
const diffPatch = ref('');
const diffLines = computed(() => diffPatch.value.split('\n'));
const fileDlg = ref(false);
const previewName = ref('');
const previewKind = ref<'text' | 'image'>('text');
const previewContent = ref('');
const previewDataUrl = ref('');
const pendingImages = ref<{ name: string; dataUrl: string }[]>([]);
const pendingFiles = ref<File[]>([]);
const pendingRefs = ref<string[]>([]);
const atOpen = ref(false);
const atQuery = ref('');
const atResults = ref<string[]>([]);
const imgInput = ref<HTMLInputElement>();
const fileInput = ref<HTMLInputElement>();

// ---------- @ 引用 ----------
async function openAt() {
  atOpen.value = !atOpen.value;
  if (atOpen.value) {
    atQuery.value = '';
    await atFilter();
  }
}

async function atFilter() {
  try {
    const r = await api.convoSearchFiles(convoId, atQuery.value, 20);
    atResults.value = r.files;
  } catch {
    atResults.value = [];
  }
}

function pickAt(f: string) {
  if (!pendingRefs.value.includes(f)) pendingRefs.value.push(f);
  atOpen.value = false;
}

async function doFork() {
  moreSheet.value = false;
  try {
    const r = await api.convoFork(convoId, { title: `${detail.value?.title || '会话'}（副本）` });
    showToast('已复制出新会话');
    router.replace(`/convo/${r.convo.id}`);
  } catch (e: any) {
    showFailToast(e.message);
  }
}

const convoId = router.currentRoute.value.params.id as string;

function isNearEnd(): boolean {
  const el = streamEl.value;
  return !el || el.scrollHeight - el.scrollTop - el.clientHeight < 140;
}
function scrollEnd() {
  const el = streamEl.value;
  if (el) el.scrollTop = el.scrollHeight;
}

async function load() {
  try {
    const near = isNearEnd();
    detail.value = await api.convoGet(convoId);
    queuedCount.value = detail.value.pending_queue || 0;
    if (near) nextTick(scrollEnd);
  } catch (e: any) {
    showFailToast(e.message);
  }
}

async function loadModels() {
  try {
    const mp = await api.getModelPool();
    models.value = mp.model_pool.map((m) => ({ id: m.id, name: m.name, provider: (m as any).provider || '' }));
  } catch { /* 非关键 */ }
}

async function pickModel(id: string) {
  modelSheet.value = false;
  try {
    await api.convoUpdate(convoId, { model_id: id });
    showToast(`主模型已切换为 ${id}`);
    await load();
  } catch (e: any) {
    showFailToast(e.message);
  }
}

// ---------- 发送 ----------
async function onPickImages(e: Event) {
  const files = (e.target as HTMLInputElement).files;
  if (!files) return;
  for (const f of Array.from(files).slice(0, 3)) {
    if (f.size > 10 * 1024 * 1024) { showFailToast(`${f.name} 超过 10MB`); continue; }
    const dataUrl = await new Promise<string>((res) => {
      const r = new FileReader();
      r.onload = () => res(String(r.result));
      r.readAsDataURL(f);
    });
    pendingImages.value.push({ name: f.name, dataUrl });
  }
  (e.target as HTMLInputElement).value = '';
}

function onPickFiles(e: Event) {
  const files = (e.target as HTMLInputElement).files;
  if (!files) return;
  for (const f of Array.from(files).slice(0, 10)) {
    if (f.size > 20 * 1024 * 1024) { showFailToast(`${f.name} 超过 20MB`); continue; }
    pendingFiles.value.push(f);
  }
  (e.target as HTMLInputElement).value = '';
}

async function send() {
  const text = draft.value.trim();
  if (!text && !pendingImages.value.length && !pendingFiles.value.length && !pendingRefs.value.length) return;
  sending.value = true;
  try {
    if (pendingFiles.value.length) {
      await api.convoUploadFiles(convoId, [...pendingFiles.value]);
      pendingFiles.value = [];
    }
    const images = [...pendingImages.value];
    pendingImages.value = [];
    const refs = [...pendingRefs.value];
    pendingRefs.value = [];
    const refNote = refs.length ? `\n（引用项目文件：${refs.map((r) => '@' + r).join(' ')}）` : '';
    // 乐观上屏：发送即见（load() 拉到真数据后自动替换）
    if (detail.value) {
      detail.value.messages.push({
        id: `tmp-${Date.now()}`, role: 'user', kind: 'text', text: text + '', ts: new Date().toISOString(),
        meta: { images: images.map((i) => ({ id: '', name: i.name, url: i.dataUrl })) },
      } as any);
      nextTick(scrollEnd);
    }
    await api.convoSend(convoId, { text: text + refNote, images: images.length ? images : undefined });
    draft.value = '';
    await load();
  } catch (e: any) {
    showFailToast(e.message);
  } finally {
    sending.value = false;
  }
}

async function stop() {
  try {
    await api.convoStop(convoId);
    showToast('已停止当前执行');
  } catch (e: any) {
    showFailToast(e.message);
  }
}

// ---------- 审批 / 提问 ----------
async function resolveApproval(approvalId: string, action: 'once' | 'reject' | 'always') {
  try {
    await api.convoApprove(convoId, approvalId, action);
    await load();
  } catch (e: any) {
    showFailToast(e.message);
  }
}

async function submitAsk(askId: string) {
  if (!askDraft.value.trim()) return;
  try {
    await api.convoAnswerAsk(convoId, askId, askDraft.value.trim());
    askDraft.value = '';
    await load();
  } catch (e: any) {
    showFailToast(e.message);
  }
}

// ---------- 会话操作 ----------
function showDiffDialog(patch: string) {
  diffPatch.value = patch || '（无改动记录）';
  diffDlg.value = true;
}
async function doDiff() {
  moreSheet.value = false;
  try {
    const r = await api.convoDiff(convoId);
    diffFiles.value = r.files;
    diffPatch.value = r.patch || '（工作区不是 git 仓库或暂无改动）';
    diffDlg.value = true;
  } catch (e: any) {
    showFailToast(e.message);
  }
}

function lineClass(l: string) {
  return l.startsWith('+') ? 'add' : l.startsWith('-') ? 'del' : 'ctx';
}

async function doRollback() {
  moreSheet.value = false;
  try {
    await showConfirmDialog({ title: '回滚快照', message: '回滚到会话首轮快照？本会话在工作区的改动将被还原。' });
  } catch { return; }
  try {
    await api.convoRollback(convoId);
    showToast('已回滚');
    await load();
  } catch (e: any) {
    showFailToast(e.message);
  }
}

async function doRename() {
  renameDlg.value = false;
  const t = renameDraft.value.trim();
  if (!t) return;
  try {
    await api.convoUpdate(convoId, { title: t });
    showToast('已重命名');
    await load();
  } catch (e: any) {
    showFailToast(e.message);
  }
}

async function doDelete() {
  moreSheet.value = false;
  try {
    await showConfirmDialog({ title: '删除会话', message: '删除该会话？消息与审批记录将一并删除（工作区文件不动）。' });
  } catch { return; }
  try {
    await api.convoDelete(convoId);
    showToast('已删除');
    router.back();
  } catch (e: any) {
    showFailToast(e.message);
  }
}

// ---------- 文件预览 / 长按 ----------
async function previewFile(p: string) {
  try {
    const r = await api.convoFile(convoId, p);
    previewName.value = r.name;
    previewKind.value = r.kind;
    previewContent.value = r.content || '';
    previewDataUrl.value = r.dataUrl || '';
    fileDlg.value = true;
  } catch (e: any) {
    showFailToast(e.message);
  }
}

function previewImg(url: string) {
  showImagePreview([url]);
}

function lpCopy() {
  lpSheet.value = false;
  if (lpTarget.value) navigator.clipboard?.writeText(lpTarget.value.text).catch(() => {});
  showToast('已复制');
}

function lpQuote() {
  lpSheet.value = false;
  if (lpTarget.value) draft.value = `> ${lpTarget.value.text.slice(0, 40)}…\n`;
}

// ---------- WS 事件 ----------
let off: (() => void) | null = null;
onMounted(async () => {
  await Promise.all([load(), loadModels()]);
  off = onEvent((msg: any) => {
    const t = msg?.type || '';
    if (!t.startsWith('convo_')) return;
    const p: any = msg.payload || {};
    if (p.convo_id !== convoId) return;
    if (t === 'convo_status' || t === 'convo_tool' || t === 'convo_approval') {
      if (t === 'convo_tool') toolLive.value = [];
      if (t === 'convo_status' && p.status !== 'running') { toolLive.value = []; reasonBuf.value = ''; streaming.value = false; }
      load();
    } else if (t === 'convo_tool_start') {
      for (const c of p.calls || []) toolLive.value.push({ tool: c.tool || '', command: c.command || c.path || '' });
      streaming.value = true;
      nextTick(() => { if (isNearEnd()) scrollEnd(); });
    } else if (t === 'convo_message') {
      const m = p.message;
      if (detail.value && m && !detail.value.messages.some((x) => x.id === m.id)) detail.value.messages.push(m);
      if (m?.role === 'assistant' && m?.kind === 'text') {
        streamBuf.value = {};
        reasonBuf.value = '';
        toolLive.value = [];
        streaming.value = false;
      }
      nextTick(() => { if (isNearEnd()) scrollEnd(); });
    } else if (t === 'convo_delta') {
      if (p.discarded) {
        streamBuf.value = {};
        reasonBuf.value = '';
        streaming.value = false;
        return;
      }
      streamBuf.value = { ...streamBuf.value, [p.stream_id]: (streamBuf.value[p.stream_id] || '') + (p.text || '') };
      streaming.value = true;
      nextTick(() => { if (isNearEnd()) scrollEnd(); });
    } else if (t === 'convo_reason') {
      reasonBuf.value += p.text || '';
      streaming.value = true;
      nextTick(() => { if (isNearEnd()) scrollEnd(); });
    } else if (t === 'convo_plan') {
      if (detail.value) detail.value.plan = p.plan;
    } else if (t === 'convo_queued') {
      queuedCount.value += 1;
    }
  });
});

onActivated(load);
onBeforeUnmount(() => off?.());
</script>

<style scoped>
.page { height: 100vh; height: 100dvh; display: flex; flex-direction: column; overflow: hidden; }
.nav-title { max-width: 150px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; display: inline-block; vertical-align: middle; }
.mono { font-family: var(--font-mono, monospace); }
.model-pill { font-size: 11px; color: var(--accent); }
.projline { padding: 4px 14px 6px; font-size: 10px; color: var(--text-3); background: var(--bg-panel); border-bottom: 1px solid var(--line); }

.stream { flex: 1; overflow-y: auto; padding: 10px 12px; display: flex; flex-direction: column; gap: 8px; }
.row { display: flex; gap: 7px; }
.row.me { flex-direction: row-reverse; }
.avatar { width: 24px; height: 24px; border-radius: 6px; flex: none; display: flex; align-items: center; justify-content: center; font-size: 10px; color: #fff; }
.avatar.partner { background: var(--accent); color: var(--accent-text); font-weight: 700; }
.avatar.u { background: var(--bg-overlay); color: var(--text-2); border: 1px solid var(--line-strong); }
.bubble { background: var(--bg-raised); border: 1px solid var(--line); border-radius: 10px; padding: 8px 11px; font-size: 13px; line-height: 1.6; max-width: 255px; overflow-wrap: anywhere; }
.me-bubble { background: color-mix(in srgb, var(--accent) 10%, var(--bg-raised)); border-color: color-mix(in srgb, var(--accent) 28%, transparent); }
.plain { white-space: pre-wrap; }
.imgrow { display: flex; gap: 5px; margin-top: 6px; flex-wrap: wrap; }
.ph { width: 74px; height: 55px; border-radius: 5px; border: 1px solid var(--line-strong); object-fit: cover; }
.file-line { display: flex; align-items: center; gap: 5px; font-size: 12px; }
.file-line a { color: var(--accent); }
.dim { color: var(--text-3); font-size: 10px; }

.syscard { border: 1px solid var(--line); border-radius: 10px; background: var(--bg-inset); font-size: 11px; margin-left: 31px; overflow: hidden; }
.syscard .hd { padding: 6px 10px; color: var(--text-2); display: flex; align-items: center; gap: 6px; }
.syscard.subcard { border-color: color-mix(in srgb, var(--ag-dev, #178a3e) 40%, transparent); }
.sub-name { color: var(--ag-dev, #178a3e); font-weight: 600; flex: none; font-size: 11px; }
.sub-summary { font-size: 11px; color: var(--text-1); padding: 0 10px 7px; }
.atpanel { border: 1px solid var(--line-strong); border-radius: 8px; background: var(--bg-overlay); padding: 6px; }
.atpanel input { width: 100%; padding: 6px 9px; border-radius: 6px; border: 1px solid var(--line-strong); background: var(--bg-inset); color: var(--text-1); font-size: 12px; outline: none; }
.atlist { max-height: 150px; overflow: auto; }
.atlist > div { padding: 6px 9px; font-size: 11px; color: var(--text-2); }
.atlist > div:active { background: var(--bg-inset); color: var(--text-1); }
.tool-line { font-family: var(--font-mono, monospace); font-size: 10px; padding: 2px 10px; color: var(--text-2); }
.notice { margin-left: 31px; font-size: 10px; color: var(--text-3); }
.degrade { border-color: color-mix(in srgb, var(--warn) 40%, transparent); color: var(--warn); padding: 8px 10px; }
.approve { border-color: color-mix(in srgb, var(--danger) 40%, transparent); }
.approve .cmd { font-family: var(--font-mono, monospace); font-size: 11px; margin: 0 10px 7px; padding: 5px 8px; border-radius: 5px; background: var(--bg-page); color: var(--danger); border: 1px solid color-mix(in srgb, var(--danger) 25%, transparent); white-space: pre-wrap; overflow-wrap: anywhere; }
.acts { display: flex; gap: 6px; padding: 0 10px 9px; }
.acts button, .mini { border: 1px solid var(--line-strong); background: none; color: var(--text-2); border-radius: 6px; font-size: 12px; padding: 6px 10px; }
.acts .btn-p { flex: 1; border: none; background: var(--accent); color: var(--accent-text); }
.acts .btn-g { flex: 1; }
.resolved { padding: 0 10px 9px; font-size: 11px; }
.resolved.ok { color: var(--ok); }
.resolved.dim { color: var(--text-3); }
.ask { border-color: color-mix(in srgb, var(--accent) 35%, transparent); }
.ask .q { padding: 7px 10px; color: var(--text-1); }
.ask .ans { display: flex; gap: 6px; padding: 0 10px 9px; }
.ask input { flex: 1; padding: 6px 9px; border-radius: 6px; border: 1px solid var(--line-strong); background: var(--bg-panel); color: var(--text-1); font-size: 12px; outline: none; }
.ask .btn-p { flex: none; border: none; background: var(--accent); color: var(--accent-text); border-radius: 6px; font-size: 12px; padding: 6px 10px; }
.filecard { display: flex; align-items: center; gap: 8px; padding: 8px 10px; }
.filecard .name { color: var(--text-1); flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.interrupt-sep { display: flex; align-items: center; gap: 7px; color: var(--danger); font-size: 10px; margin-left: 31px; }
.interrupt-sep .sq { width: 8px; height: 8px; border: 2px solid var(--danger); border-radius: 2px; flex: none; }
.interrupt-sep::after { content: ''; flex: 1; height: 1px; background: color-mix(in srgb, var(--danger) 30%, transparent); }
.msg-main { min-width: 0; max-width: 100%; }
.think-details { font-size: 10px; color: var(--text-3); border: 1px solid var(--line); border-radius: 6px; background: var(--bg-inset); padding: 4px 8px; margin-bottom: 4px; }
.think-details summary { cursor: pointer; user-select: none; }
.think-body { white-space: pre-wrap; overflow-wrap: anywhere; max-height: 200px; overflow-y: auto; color: var(--text-2); line-height: 1.6; margin-top: 4px; }

.live-card { min-width: 0; flex: 1; max-width: 280px; border: 1px solid var(--line-strong); border-radius: 10px; background: var(--bg-panel); padding: 8px 11px; }
.live-head { font-size: 12px; color: var(--text-1); display: flex; align-items: center; gap: 5px; }
.live-dot { display: inline-block; width: 6px; height: 6px; border-radius: 50%; background: var(--ok); margin-left: 4px; animation: livepulse 1.4s infinite; }
@keyframes livepulse { 0%,100% { opacity: 1; } 50% { opacity: .25; } }
.live-sect { margin-top: 5px; }
.live-label { font-size: 10px; color: var(--text-3); letter-spacing: .08em; margin-bottom: 2px; }
.live-scroll { max-height: 140px; overflow-y: auto; }
.live-tool-line { font-size: 10px; color: var(--text-2); padding: 1px 0; }
.live-content { border-left: 2px solid var(--accent); padding-left: 8px; max-height: 240px; overflow-y: auto; font-size: 12px; }

.queued { align-self: flex-end; font-size: 10px; color: var(--warn); padding: 2px 9px; border: 1px solid color-mix(in srgb, var(--warn) 40%, transparent); border-radius: 99px; }
.typing-bubble { opacity: .85; }

.composer { border-top: 1px solid var(--line); background: var(--bg-panel); padding: 7px 9px 10px; display: flex; flex-direction: column; gap: 6px; position: sticky; bottom: 0; }
.chips { display: flex; flex-wrap: wrap; gap: 5px; }
.chip { display: inline-flex; align-items: center; gap: 4px; font-size: 10px; padding: 2px 8px; border-radius: 6px; border: 1px solid var(--line-strong); background: var(--bg-inset); color: var(--text-2); }
.chip b { font-weight: 400; cursor: pointer; }
.comp-r1 { display: flex; align-items: center; gap: 7px; font-size: 10px; color: var(--text-3); }
.comp-r1 .sp { flex: 1; }
.mode-toggle { display: inline-flex; border: 1px solid var(--line-strong); border-radius: 6px; overflow: hidden; }
.mode-toggle button { padding: 2px 9px; font-size: 10px; border: none; background: none; color: var(--text-2); }
.mode-toggle button.on { background: var(--accent); color: var(--accent-text); }
.comp-r2 { display: flex; gap: 6px; align-items: flex-end; }
.comp-r2 textarea { flex: 1; height: 38px; resize: none; padding: 9px 11px; border-radius: 10px; border: 1px solid var(--line-strong); background: var(--bg-inset); color: var(--text-1); font-family: inherit; font-size: 13px; outline: none; }
.comp-r2 textarea:focus { border-color: var(--accent); }
.comp-r2 .mini { height: 38px; width: 34px; display: flex; align-items: center; justify-content: center; padding: 0; }
.comp-r2 .mini:disabled { opacity: .4; }
.send { height: 38px; padding: 0 13px; border-radius: 10px; border: none; background: var(--accent); color: var(--accent-text); font-size: 12px; font-weight: 600; }
.send:disabled { opacity: .6; }

.sheet { padding: 12px 0 18px; max-height: 100%; overflow: auto; }
.sheet .sh { text-align: center; font-size: 11px; color: var(--text-3); padding: 4px 0 8px; }
.sheet .si { padding: 13px 18px; font-size: 14px; text-align: center; }
.sheet .si:active { background: var(--bg-inset); }
.sheet .si.cur { color: var(--accent); }
.sheet .si.danger { color: var(--danger); }
.sheet .gap { height: 6px; background: var(--bg-inset); }
.frow { padding: 0 18px 10px; }
.frow input { width: 100%; padding: 8px 10px; border-radius: 6px; border: 1px solid var(--line-strong); background: var(--bg-inset); color: var(--text-1); font-size: 13px; outline: none; }
.btnrow { display: flex; gap: 8px; padding: 4px 18px 0; }
.btnrow button { flex: 1; padding: 10px; border-radius: 8px; font-size: 13px; }
.btn-g { border: 1px solid var(--line-strong); background: none; color: var(--text-2); }
.btn-p { border: none; background: var(--accent); color: var(--accent-text); }
.diffsheet { display: flex; flex-direction: column; }
.diff-patch { font-family: var(--font-mono, monospace); font-size: 11px; line-height: 1.7; overflow: auto; padding: 0 12px 12px; white-space: pre-wrap; overflow-wrap: anywhere; }
.diff-patch .add { background: color-mix(in srgb, var(--ok) 12%, transparent); color: var(--ok); display: block; }
.diff-patch .del { background: color-mix(in srgb, var(--danger) 12%, transparent); color: var(--danger); display: block; }
.diff-patch .ctx { color: var(--text-2); display: block; }
.preview-img { max-width: 100%; margin: 0 auto; display: block; }
.preview-text { font-family: var(--font-mono, monospace); font-size: 12px; line-height: 1.7; overflow: auto; padding: 0 12px 12px; white-space: pre-wrap; overflow-wrap: anywhere; }
.day-sep { text-align: center; font-size: 10px; color: var(--text-3); display: flex; align-items: center; gap: 10px; margin: 2px 0; }
.day-sep::before, .day-sep::after { content: ''; flex: 1; height: 1px; background: var(--line); }
.user-row { display: flex; justify-content: flex-end; }
.user-msg { max-width: 82%; background: color-mix(in srgb, var(--accent) 11%, var(--bg-panel)); border: 1px solid color-mix(in srgb, var(--accent) 24%, transparent); border-radius: 12px 12px 3px 12px; padding: 9px 12px; font-size: 14px; line-height: 1.65; white-space: pre-wrap; overflow-wrap: anywhere; }
.user-msg .ph { width: 74px; height: 55px; border-radius: 5px; border: 1px solid var(--line-strong); object-fit: cover; margin-top: 6px; }
.imgrow { display: flex; gap: 5px; flex-wrap: wrap; }
.file-line { display: flex; align-items: center; gap: 5px; font-size: 12px; }
.file-line a { color: var(--accent); }
.dim { color: var(--text-3); font-size: 10px; }
.plain { white-space: pre-wrap; }

.turn { border: 1px solid var(--line); border-radius: 12px; background: var(--bg-panel); overflow: hidden; }
.turn.live { border-color: color-mix(in srgb, var(--ok) 30%, var(--line)); }
.turn-head { display: flex; align-items: center; gap: 8px; padding: 9px 12px; border-bottom: 1px solid var(--line); }
.t-avatar { width: 21px; height: 21px; border-radius: 6px; background: var(--accent); color: var(--accent-text); font-size: 10px; font-weight: 700; display: flex; align-items: center; justify-content: center; flex: none; }
.t-name { font-size: 12.5px; font-weight: 600; }
.t-model { font-size: 10px; color: var(--text-3); }
.t-meta { margin-left: auto; font-size: 10px; color: var(--text-3); display: flex; gap: 8px; align-items: center; }
.t-running { display: inline-block; width: 6px; height: 6px; border-radius: 50%; background: var(--ok); animation: livepulse 1.3s infinite; }
@keyframes livepulse { 0%,100% { opacity: 1; } 50% { opacity: .2; } }

.acts { position: relative; padding: 8px 12px 4px; }
.acts::before { content: ''; position: absolute; left: 19px; top: 16px; bottom: 10px; width: 1px; background: linear-gradient(to bottom, var(--line-strong), transparent); }
.act-line { position: relative; display: flex; align-items: center; gap: 8px; padding: 4px 4px 4px 18px; font-size: 12px; min-height: 28px; }
.act-line::before { content: ''; position: absolute; left: 1px; top: 50%; transform: translateY(-50%); width: 6px; height: 6px; border-radius: 50%; background: var(--ok); }
.act-line.err::before { background: var(--danger); }
.act-line.live::before { background: var(--accent); animation: livepulse 1s infinite; }
.tool-tag { font-family: var(--font-mono, monospace); font-size: 10px; font-weight: 600; color: var(--text-1); background: var(--bg-inset); border: 1px solid var(--line); border-radius: 5px; padding: 1px 6px; flex: none; }
.act-args { color: var(--text-1); font-family: var(--font-mono, monospace); font-size: 11px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.act-res { margin-left: auto; flex: none; font-family: var(--font-mono, monospace); font-size: 10px; color: var(--text-3); }
.act-res .pill { padding: 1px 6px; border-radius: 99px; border: 1px solid color-mix(in srgb, var(--ok) 35%, transparent); color: var(--ok); }
.act-res .pill.bad { border-color: color-mix(in srgb, var(--danger) 35%, transparent); color: var(--danger); }
.act-res .pill.dim { border-color: var(--line-strong); color: var(--text-3); }

.think > summary { list-style: none; display: flex; align-items: center; gap: 7px; padding: 8px 12px; font-size: 11px; color: var(--text-3); cursor: pointer; user-select: none; border-top: 1px solid var(--line); }
.think > summary::-webkit-details-marker { display: none; }
.think > summary .car { transition: transform .15s; font-size: 8px; display: inline-flex; }
.think[open] > summary .car { transform: rotate(90deg); }
.think > summary .tt { color: var(--text-2); font-weight: 600; }
.think-body { padding: 0 14px 10px 26px; font-size: 11.5px; line-height: 1.75; color: var(--text-2); white-space: pre-wrap; overflow-wrap: anywhere; max-height: 180px; overflow-y: auto; }

.conclusion { padding: 12px 14px 4px; }
.conclusion .md { line-height: 1.8; font-size: 14px; overflow-wrap: anywhere; }
.conclusion .md :deep(p) { margin: 6px 0; }
.conclusion .md :deep(li) { margin: 4px 0 4px 16px; }
.conclusion .md :deep(code) { font-family: var(--font-mono, monospace); font-size: 11.5px; background: var(--bg-inset); padding: 1px 5px; border-radius: 4px; border: 1px solid var(--line); }

.turn-foot { display: flex; gap: 6px; padding: 9px 14px 12px; flex-wrap: wrap; align-items: center; }
.fchip { font-family: var(--font-mono, monospace); font-size: 10px; color: var(--text-2); border: 1px solid var(--line-strong); border-radius: 6px; padding: 3px 8px; background: var(--bg-inset); }
.fbtn { margin-left: auto; font-size: 10.5px; padding: 4px 10px; border-radius: 6px; border: 1px solid var(--line-strong); background: none; color: var(--text-2); }

.inline { margin: 8px 0 2px; border-radius: 9px; padding: 7px 11px; font-size: 11.5px; display: flex; align-items: center; gap: 7px; flex-wrap: wrap; }
.inline.warn { border: 1px solid color-mix(in srgb, var(--warn) 30%, transparent); background: color-mix(in srgb, var(--warn) 7%, var(--bg-panel)); color: var(--warn); }
.inline.danger { border: 1px solid color-mix(in srgb, var(--danger) 30%, transparent); background: color-mix(in srgb, var(--danger) 7%, var(--bg-panel)); color: var(--danger); }
.inline .cmd { font-family: var(--font-mono, monospace); font-size: 11px; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.inline button { font-size: 11px; padding: 5px 11px; border-radius: 6px; border: 1px solid var(--line-strong); background: none; color: var(--text-2); }
.inline button.p { border-color: color-mix(in srgb, var(--accent) 55%, transparent); color: var(--accent); font-weight: 600; }
.inline.ask { border: 1px solid color-mix(in srgb, var(--accent) 30%, transparent); background: color-mix(in srgb, var(--accent) 6%, var(--bg-panel)); }
.inline.ask input { flex: 1; min-width: 100px; padding: 6px 9px; border-radius: 6px; border: 1px solid var(--line-strong); background: var(--bg-inset); color: var(--text-1); font-size: 12px; outline: none; }
.q-inline { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.notice { margin: 8px 14px 0; font-size: 10.5px; color: var(--text-3); }
.notice.warn { color: var(--warn, #e6a23c); border: 1px solid var(--line-soft, #1a1d24); background: var(--bg-raise, #14161b); border-radius: 8px; padding: 6px 10px; }
.live-logs { margin: 6px 0 2px; }
.live-logs .lg .st { background: var(--accent, #4b8bff); animation: pulse 1.1s infinite; }
.interrupt-sep { display: flex; align-items: center; gap: 7px; color: var(--danger); font-size: 10.5px; margin: 8px 14px 0; }
.interrupt-sep .sq { width: 8px; height: 8px; border: 2px solid var(--danger); border-radius: 2px; flex: none; }
.interrupt-sep::after { content: ''; flex: 1; height: 1px; background: color-mix(in srgb, var(--danger) 30%, transparent); }

.live-think { padding: 8px 14px 2px; }
.live-think .lab { font-size: 9.5px; color: var(--text-3); letter-spacing: .14em; margin-bottom: 2px; }
.cursor { display: inline-block; width: 7px; height: 13px; background: var(--accent); vertical-align: -2px; animation: bk 1s steps(2) infinite; }
@keyframes bk { 50% { opacity: 0; } }


/* ===== v5 原生风 ===== */
.nav-title { font-weight: 700; }
.u-row { display: flex; justify-content: flex-end; margin: 14px 0 6px; }
.u-bub { max-width: 84%; background: linear-gradient(135deg, var(--accent-deep, #ff9349), color-mix(in srgb, var(--accent) 78%, #000)); border-radius: 20px 20px 6px 20px; padding: 10px 15px; font-size: 14.5px; line-height: 1.65; white-space: pre-wrap; overflow-wrap: anywhere; }
html.light .u-bub { background: var(--accent); }
.u-bub .ph { margin-top: 7px; width: 130px; height: 88px; border-radius: 10px; background: rgba(255,255,255,.14); border: 1px solid rgba(255,255,255,.25); object-fit: cover; }
.file-line { display: flex; align-items: center; gap: 6px; font-size: 12px; }
.a { margin: 18px 0 24px; }
.a-head { display: flex; align-items: baseline; gap: 7px; margin-bottom: 6px; }
.a-head .nm { font-size: 13px; font-weight: 700; }
.a-head .md { font-size: 10px; color: var(--t3, #5f6773); }
.a-head .tm { margin-left: auto; font-family: var(--font-mono, monospace); font-size: 10px; color: var(--t3, #5f6773); }
.a-head .live { width: 7px; height: 7px; border-radius: 50%; background: var(--ok); align-self: center; animation: livepulse 1.2s infinite; }
.plan { margin: 10px 0 4px; }
.plan-pill { display: inline-flex; align-items: center; gap: 7px; font-size: 11px; color: var(--t2, #9aa3ae); background: var(--bg-raise, #14161b); border: 1px solid var(--line); border-radius: 99px; padding: 6px 13px; max-width: 100%; }
.plan-pill .plan-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--accent); animation: livepulse 1.2s infinite; flex: none; }
.plan-pill .cur { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--text-1); }
.plan-pill .car { color: var(--t3); font-size: 8px; }
.plan-full { border: 1px solid var(--line); border-radius: 12px; background: var(--bg-raise, #14161b); padding: 9px 13px; }
.plan-head { display: flex; align-items: center; gap: 7px; font-size: 11px; color: var(--t2); font-weight: 600; padding-bottom: 4px; }
.plan-step { display: flex; align-items: center; gap: 8px; font-size: 12px; padding: 4px 0; color: var(--t2, #9aa3ae); }
.plan-step .mark { width: 15px; text-align: center; flex: none; }
.plan-step.done .mark { color: var(--ok); }
.plan-step.done { text-decoration: line-through; opacity: .65; }
.plan-step.in_progress { color: var(--t1); }
.plan-step.in_progress .mark { color: var(--accent); animation: livepulse 1.2s infinite; }
.plan-step.blocked .mark { color: var(--danger); }
.chip { display: inline-flex; align-items: center; gap: 7px; font-family: var(--font-mono, monospace); font-size: 11px; color: var(--t2, #9aa3ae); background: var(--bg-raise, #14161b); border: 1px solid var(--line-soft, #1a1d24); border-radius: 99px; padding: 6px 13px; margin: 8px 0 2px; }
.chip .st { width: 6px; height: 6px; border-radius: 50%; background: var(--ok); }
.chip .car { color: var(--t3); font-size: 8px; transition: transform .15s; }
.chip .car.open { transform: rotate(90deg); }
.logs { margin: 6px 0 2px; border-radius: 12px; background: var(--bg-raise, #14161b); border: 1px solid var(--line-soft, #1a1d24); padding: 8px 12px; display: flex; flex-direction: column; gap: 1px; }
.lg { display: flex; align-items: center; gap: 8px; font-family: var(--font-mono, monospace); font-size: 11px; color: var(--t2, #9aa3ae); line-height: 2.1; }
.lg .st { width: 5px; height: 5px; border-radius: 50%; background: var(--ok); flex: none; }
.lg.err .st { background: var(--danger); }
.lg .tg { color: var(--t1); flex: none; }
.lg .ar { color: var(--t3); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.lg .rs { margin-left: auto; font-size: 10px; flex: none; }
.lg .rs.good { color: var(--ok); }
.thinking { font-size: 12.5px; line-height: 1.8; color: var(--t3, #5f6773); border-left: 2px solid var(--line); padding-left: 11px; margin: 10px 0; max-height: 150px; overflow-y: auto; white-space: pre-wrap; overflow-wrap: anywhere; }
.thinking .lab { font-size: 9.5px; letter-spacing: .16em; margin-bottom: 3px; opacity: .7; }
.ans { margin-top: 4px; font-size: 15px; line-height: 1.9; overflow-wrap: anywhere; }
.ans .md :deep(p) { margin: 8px 0; }
.ans .md :deep(li) { margin: 5px 0 5px 18px; }
.ans .md :deep(code) { font-family: var(--font-mono, monospace); font-size: 12.5px; background: var(--bg-raise, #14161b); padding: 2px 7px; border-radius: 6px; }
.ans .md :deep(pre) { background: var(--bg-raise, #14161b); border: 1px solid var(--line); border-radius: 10px; padding: 11px 13px; font-family: var(--font-mono, monospace); font-size: 12px; line-height: 1.7; overflow-x: auto; margin: 9px 0; }
.ops { display: flex; align-items: center; gap: 4px; margin-top: 10px; }
.ops .op { font-size: 11px; color: var(--t3, #5f6773); padding: 4px 10px; border-radius: 7px; }
.ops .op:active { background: var(--bg-raise, #14161b); color: var(--t1); }
.ops .tm { margin-left: auto; font-size: 10px; }
.diff { margin-top: 12px; border-top: 1px solid var(--line-soft, #1a1d24); padding-top: 10px; display: flex; flex-direction: column; gap: 6px; }
.diff .files { display: flex; flex-direction: column; gap: 4px; font-size: 11px; color: var(--t2); }
.diff .f { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.diff .btn { align-self: flex-start; font-size: 11px; color: var(--accent); padding: 5px 12px; border-radius: 99px; background: color-mix(in srgb, var(--accent) 12%, transparent); }
.appr { margin-top: 12px; border-radius: 14px; background: var(--bg-raise, #14161b); border: 1px solid color-mix(in srgb, var(--danger) 25%, transparent); padding: 11px 13px; }
.appr .l1 { display: flex; align-items: center; gap: 7px; font-size: 11px; color: var(--danger); font-weight: 600; }
.appr .cmd { font-size: 11.5px; margin: 7px 0 9px; color: var(--t1); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.appr .acts { display: flex; gap: 8px; align-items: center; }
.appr .acts button { flex: 1; padding: 8px 0; border-radius: 9px; border: 1px solid var(--line); background: none; color: var(--t2, #9aa3ae); font-size: 12.5px; }
.appr .acts button.p { background: var(--danger); border-color: var(--danger); color: #fff; font-weight: 600; }
.appr .acts input { flex: 1; padding: 8px 11px; border-radius: 9px; border: 1px solid var(--line-strong); background: var(--bg-inset); color: var(--text-1); font-size: 12.5px; outline: none; }
.appr .done-lb { font-size: 11px; color: var(--t3); }
.appr.ask { border-color: color-mix(in srgb, var(--accent) 25%, transparent); }
.appr .ask-lb { color: var(--accent); }
.file-inline { display: flex; align-items: center; gap: 8px; font-size: 12px; margin-top: 10px; padding: 9px 12px; border-radius: 12px; background: var(--bg-raise, #14161b); border: 1px solid var(--line-soft, #1a1d24); }
.file-inline .sp { flex: 1; }
.composer { flex: none; position: sticky; bottom: 0; z-index: 5; background: var(--bg); border-top: 1px solid var(--line); padding: 8px 14px calc(10px + env(safe-area-inset-bottom)); }
.comp-meta { display: flex; align-items: center; gap: 8px; font-size: 10px; color: var(--t3, #5f6773); margin-bottom: 7px; }
.comp-meta .mode { display: inline-flex; background: var(--bg-inset); border-radius: 99px; padding: 2px; }
.comp-meta .mode span { font-size: 10px; color: var(--t3, #5f6773); padding: 2px 10px; border-radius: 99px; cursor: pointer; }
.comp-meta .mode span.on { background: var(--bg-raise, #14161b); color: var(--text-1); box-shadow: 0 1px 3px rgba(0,0,0,.25); }
.comp-meta .hint { margin-left: 0; }
.comp-meta .stop-ic { margin-left: auto; width: 24px; height: 24px; border-radius: 50%; display: flex; align-items: center; justify-content: center; }
.comp-meta .stop-ic.disabled { opacity: .35; }
.input-flat { display: flex; align-items: flex-end; gap: 8px; }
.input-box { flex: 1; min-width: 0; background: var(--bg-chip, #1b1e25); border-radius: 13px; padding: 8px 10px 8px 12px; display: flex; align-items: flex-end; gap: 7px; }
html.light .input-box { background: var(--bg-inset); }
.input-box textarea { flex: 1; min-width: 0; border: none; background: none; resize: none; color: var(--text-1); font-size: 16px; font-family: var(--font-ui); outline: none; height: 36px; line-height: 1.5; }
.input-box textarea::placeholder { color: var(--t3, #5f6773); }
.input-box .ic { width: 27px; height: 27px; border-radius: 50%; display: flex; align-items: center; justify-content: center; color: var(--t3, #5f6773); font-size: 14px; flex: none; cursor: pointer; }
.input-box .ic:active { color: var(--accent); }
.send { width: 38px; height: 38px; border-radius: 11px; background: var(--accent); color: var(--accent-text); display: flex; align-items: center; justify-content: center; font-size: 16px; border: none; flex: none; cursor: pointer; font-weight: 700; }
.send:disabled { opacity: .5; }


/* ===== v6：开关/权限面板/断连卡 ===== */
.switch-row { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
.switch-row span:first-child { display: flex; flex-direction: column; align-items: flex-start; gap: 2px; }
.switch-row small { font-size: 10px; color: var(--t3, #5f6773); font-weight: 400; }
.sw { font-size: 12px; padding: 4px 14px; border-radius: 99px; border: 1px solid var(--line-strong); color: var(--t3, #5f6773); }
.sw.on { background: var(--ok); border-color: var(--ok); color: #fff; }
.sh-h { display: flex; align-items: center; justify-content: space-between; padding: 10px 16px 6px; font-size: 13px; font-weight: 600; color: var(--text-1); }
.sh-h .x { font-size: 12px; color: var(--t3, #5f6773); font-weight: 400; padding: 4px 8px; }
.inline.danger { border: 1px solid color-mix(in srgb, var(--danger) 30%, transparent); background: color-mix(in srgb, var(--danger) 7%, var(--bg-panel)); color: var(--danger); }
.comp-meta { display: flex; align-items: center; gap: 7px; font-size: 10px; color: var(--t3, #5f6773); margin-bottom: 5px; }
.comp-meta .hint { flex: 1; }
.comp-meta .stop-ic { width: 22px; height: 22px; border-radius: 50%; display: flex; align-items: center; justify-content: center; }
.comp-meta .stop-ic.disabled { opacity: .35; }

</style>
