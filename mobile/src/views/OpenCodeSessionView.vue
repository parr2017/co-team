<template>
  <div class="page">
    <van-nav-bar fixed placeholder @click-left="router.back()">
      <template #title>
        <span class="nav-title">{{ sessionTitle }}</span>
      </template>
      <template #right>
        <span class="nav-badge mono" @click="onBadgeClick">{{ modelBadge }}</span>
        <span v-if="snap.busy && canControl" class="nav-abort" @click="abortSession">打断</span>
        <van-icon name="ellipsis" size="18" style="margin-left: 8px" @click="moreSheet = true" />
      </template>
    </van-nav-bar>
    <div class="projline">
      <span>{{ instance ? `${instance.label || instance.id} · ${canControl ? 'control' : 'readonly'}` : instanceId }}</span>
      <span v-if="snap.status !== 'unknown'" class="st-tag mono" :class="snap.busy ? 'busy' : 'idle'">{{ snap.busy ? 'busy' : snap.status }}</span>
    </div>

    <!-- 断线可见：事件流断开时提示"不是模型没回应" -->
    <div v-if="sseState !== 'open'" class="conn-ribbon">
      <span class="spin" />{{ sseState === 'connecting' ? '正在连接事件流…' : '事件流已断开，正在重连…' }}
    </div>
    <!-- 会话级错误红条（session.error） -->
    <div v-if="snap.error" class="err-bar">⚠ {{ snap.error }}</div>
    <!-- 重试态 -->
    <div v-if="snap.retry" class="retry-bar">第 {{ snap.retry.attempt }} 次重试：{{ snap.retry.message }}</div>
    <!-- revert 横幅（session.updated.info.revert） -->
    <div v-if="snap.revert" class="revert-bar">已回退到某条消息（其后的内容不再计入上下文）</div>

    <!-- todos 横滚 chip 栏（TUI 顶部任务清单） -->
    <div v-if="snap.todos.length" class="todos">
      <span v-for="(t, ti) in snap.todos" :key="t.id || ti" class="todo" :class="String(t.status)">
        <i>{{ todoMark(t) }}</i>{{ t.content }}
      </span>
    </div>

    <div ref="streamEl" class="stream" @scroll="onStreamScroll">
      <div v-if="loadingMessages && !snap.messages.length" class="notice"><span class="spin" />加载消息中…</div>
      <div v-else-if="!snap.messages.length" class="notice">该会话暂无消息——在下方输入框发第一条指令开始</div>
      <div v-if="hasMore || loadingMore" class="page-more" @click="loadMore">
        <span v-if="loadingMore">加载更早消息…</span>
        <span v-else>↑ 加载更早消息</span>
      </div>
      <div v-else-if="snap.messages.length > 1" class="page-more dim">已到最早消息</div>

      <template v-for="(m, mi) in snap.messages" :key="m.id || mi">
        <!-- 用户消息：右侧气泡，长按回退 -->
        <div v-if="m.role === 'user'" class="u-row">
          <div class="u-bub" @touchstart="lpStart(m)" @touchend="lpCancel" @touchmove="lpCancel" @contextmenu.prevent="lpStart(m)">
            <template v-for="(p, pi) in partsOf(m)" :key="pi">
              <div v-if="p.type === 'text' && p.text" class="plain">{{ p.text }}</div>
              <div v-else-if="p.type === 'file'" class="dim mini">📎 {{ p.filename || p.path || '文件' }}</div>
              <div v-else-if="p.type === 'image'" class="dim mini">🖼 图片</div>
              <div v-else-if="p.type === 'agent'" class="dim mini">agent · {{ p.name || '?' }}</div>
            </template>
          </div>
        </div>
        <!-- assistant：左对齐，parts 按类型渲染（TUI 同构） -->
        <div v-else class="a-block">
          <div class="a-head">
            <span class="a-name">opencode</span>
            <span v-if="m.modelID" class="a-model mono">{{ m.modelID }}<template v-if="m.providerID"> · {{ m.providerID }}</template></span>
            <span v-if="usageText(m)" class="a-usage mono">{{ usageText(m) }}</span>
            <span v-if="m.finish && m.finish !== 'stop'" class="a-fin mono">{{ m.finish }}</span>
          </div>
          <div v-if="m.error" class="a-err">⚠ {{ errText(m.error) }}</div>
          <template v-for="(p, pi) in partsOf(m)" :key="p.id || pi">
            <!-- 正文 -->
            <div v-if="p.type === 'text' && p.text" class="a-text"><MdView :source="p.text" /></div>
            <!-- 思考：默认展开（TUI 同款），点击折叠 -->
            <div v-else-if="p.type === 'reasoning' && p.text" class="thinking" @click="toggleThink(pk(m, p, pi))">
              <span class="lab">思考过程 {{ thinkClosed.has(pk(m, p, pi)) ? '▸' : '▾' }}</span>
              <span v-if="!thinkClosed.has(pk(m, p, pi))" class="tb">{{ p.text }}</span>
              <span v-else class="tb short">{{ p.text.slice(0, 80) }}…</span>
            </div>
            <!-- 工具四态卡 -->
            <div v-else-if="p.type === 'tool'" class="tool-card" :class="toolStateOf(p).status">
              <div class="tool-head" @click="toggleTool(pk(m, p, pi))">
                <span v-if="isToolLive(toolStateOf(p).status)" class="spin" />
                <span v-else-if="toolStateOf(p).status === 'error'" class="dot err" />
                <span v-else class="dot ok" />
                <span class="tool-name mono">{{ toolStateOf(p).title }}</span>
                <span v-if="trimmedParts.has(String(p.id))" class="tool-trim" @click.stop="openFullMessage(m.id)">已裁剪·原文</span>
                <span class="car">{{ toolOpen.has(pk(m, p, pi)) ? '▾' : '▸' }}</span>
              </div>
              <div v-if="toolOpen.has(pk(m, p, pi))" class="tool-body">
                <div v-if="toolStateOf(p).error" class="tool-err mono">{{ toolStateOf(p).error }}</div>
                <div v-else-if="toolInputText(p)" class="tool-io mono">{{ toolInputText(p) }}</div>
                <template v-if="toolOutputText(p)">
                  <pre class="tool-out mono">{{ toolOutFull.has(pk(m, p, pi)) ? toolOutputText(p) : clipText(toolOutputText(p)) }}</pre>
                  <span v-if="toolOutputText(p).length > 1500" class="tool-more" @click.stop="toggleOutFull(pk(m, p, pi))">
                    {{ toolOutFull.has(pk(m, p, pi)) ? '收起' : `展开全部（${toolOutputText(p).length} 字符）` }}
                  </span>
                </template>
                <div v-if="taskChildMap.get(String(p.id))" class="child-flow">
                  <div class="child-lab">子代理运行过程（{{ childMessages(taskChildMap.get(String(p.id))).length }} 条）</div>
                  <div v-for="cm in childMessages(taskChildMap.get(String(p.id)))" :key="cm.id" class="c-msg" :class="cm.role">
                    <span class="c-role">{{ cm.role === 'user' ? '派单' : cm.role === 'assistant' ? '子代理' : cm.role }}</span>
                    <span class="c-text">{{ childMsgText(cm) || '…' }}</span>
                  </div>
                  <div v-if="!childMessages(taskChildMap.get(String(p.id))).length" class="child-empty">子会话消息加载中…</div>
                </div>
                <div v-if="toolStateOf(p).attachments.length" class="tool-files">
                  <span v-for="(a, ai) in toolStateOf(p).attachments" :key="ai" class="fchip mono">{{ attName(a) }}</span>
                </div>
              </div>
            </div>
            <!-- 步骤边界 -->
            <div v-else-if="p.type === 'step-start'" class="step-sep"><i /><span>步骤开始</span><i /></div>
            <div v-else-if="p.type === 'step-finish'" class="step-sep"><i /><span>步骤完成</span><i /></div>
            <!-- 文件变更 -->
            <div v-else-if="p.type === 'patch'" class="patch-card">
              <div class="patch-head" @click="openPatch(p)">文件变更 · {{ patchFilesOf(p).length }} 个<span class="car">▸</span></div>
              <div class="patch-files">
                <div v-for="(f, fi) in patchFilesOf(p)" :key="fi" class="patch-file" @click="openPatch(p)">
                  <span class="mono fname">{{ f.path }}</span>
                  <span class="add">+{{ f.additions }}</span>
                  <span class="del">−{{ f.deletions }}</span>
                </div>
              </div>
            </div>
            <!-- 摘要 chip 族 -->
            <div v-else-if="SUMMARY_TYPES.includes(p.type)" class="chip-line" :class="p.type">
              <span class="chip-dot" />{{ chipTextOf(p) }}
            </div>
          </template>
        </div>
      </template>

      <!-- 提问卡：opencode 的 AskUserQuestion（字段控件/条件题/必填校验/草稿走共享 form 状态机，key-based 作答） -->
      <div v-for="q in liveQuestions" :id="'qcard-' + q.id" :key="q.id" class="q-card">
        <div class="q-head">
          <span class="q-title">{{ q.title || 'opencode 等你拍板' }}</span>
          <span v-if="(q.questions || []).length > 1" class="q-count">{{ qVisibleOf(q).length }}/{{ (q.questions || []).length }} 题</span>
        </div>
        <OcFormField
          v-for="f in qVisibleOf(q)"
          :key="q.id + ':' + f.key"
          :field="f"
          :value="qValueOf(q, f.key)"
          :disabled="qBusy[q.id] === true"
          :show-errors="qErrors[q.id] === true"
          :missing="qMissingOf(q).includes(f.key)"
          @update="(patch) => patchQValue(q, f.key, patch)"
          @submit="submitQ(q)"
        />
        <div class="acts">
          <span v-if="qErrors[q.id] && qMissingOf(q).length" class="q-err">还有 {{ qMissingOf(q).length }} 个必填未作答</span>
          <span class="q-sp" />
          <button class="p" :disabled="qBusy[q.id] === true" @click="submitQ(q)">提交回答</button>
          <button :disabled="qBusy[q.id] === true" @click="rejectQuestion(String(q.id))">不回答</button>
        </div>
      </div>

      <!-- 审批卡：消息流末尾内嵌（readonly 也可人工放行） -->
      <div v-for="pm in livePermissions" :key="pm.id" class="perm-card">
        <div class="l1">权限请求 · opencode 等待审批</div>
        <div v-if="pm.title" class="perm-title">{{ pm.title }}</div>
        <div class="cmd mono">{{ permDetailOf(pm) }}</div>
        <div v-if="permMetaText(pm)" class="cmd meta mono">{{ permMetaText(pm) }}</div>
        <div class="acts">
          <button @click="resolvePermission(pm.id, 'reject')">拒绝</button>
          <button @click="resolvePermission(pm.id, 'always')">总是允许</button>
          <button class="p" @click="resolvePermission(pm.id, 'once')">批准一次</button>
        </div>
      </div>
    </div>

    <div v-if="showToTop" class="to-top" @click="toTop">↑</div>
    <div v-if="showToBottom" class="to-bottom" @click="toBottom">↓</div>

    <!-- busy 脉冲条 -->
    <div v-if="snap.busy" class="busy-strip"><span class="pulse" />opencode 正在工作…</div>

    <!-- PTY 卡片行（snapshot.ptys；连接实时终端进 WS 弹层） -->
    <div v-if="snap.ptys.length" class="pty-row">
      <span class="pty-lab">PTY</span>
      <span v-for="pt in snap.ptys" :key="pt.id" class="pty-chip" :class="String(pt.status)" @click="openPty(pt)">
        {{ pt.title || pt.command || shortId(pt.id) }}<b v-if="pt.status === 'exited'"> · exit {{ pt.exitCode ?? '?' }}</b>
      </span>
    </div>

    <!-- 常驻入口条：提问卡会随消息流滚走，这里永远可见（点击跳到第一张卡） -->
    <div v-if="liveQuestions.length" class="q-bar" @click="jumpToQuestion(liveQuestions[0].id)">
      <span class="qb-dot" />opencode 等你回答 · {{ liveQuestions.length }} 张提问卡 · 点击查看
    </div>

    <!-- 输入栏：control 档才显示发送框 -->
    <div v-if="canControl" class="composer">
      <div class="comp-row">
        <span class="hint">{{ snap.busy ? 'opencode 工作中 · 可继续发' : 'Enter 发送 · Shift+Enter 换行 · / 开头走命令' }}</span>
        <span v-if="!isManaged" class="pill mono" @click="openModels">{{ modelLabel }} ▾</span>
        <span class="pill mono" @click="openAgents">{{ selectedAgent || '默认 agent' }} ▾</span>
      </div>
      <div class="input-flat">
        <div class="input-box">
          <textarea v-model="draft" rows="1" placeholder="给 opencode 下达指令…" @keydown="onKeydown" @input="autoGrow" />
        </div>
        <button class="send" :disabled="sending" @click="send">↑</button>
      </div>
    </div>
    <div v-else class="composer readonly">只读模式 · 可查看消息 / diff 并响应权限审批；发送需 control 档</div>

    <!-- 更多操作 -->
    <van-popup v-model:show="moreSheet" position="bottom" round>
      <div class="sheet">
        <div class="si" @click="moreSheet = false; reloadAll()">刷新消息</div>
        <div class="si" @click="moreSheet = false; openDiff()">查看会话 diff</div>
        <div class="si" :class="{ dis: !snap.busy || !canControl }" @click="abortSession">打断当前执行（abort）</div>
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

    <!-- patch part 详情 -->
    <van-popup v-model:show="patchDlg" position="bottom" :style="{ height: '80%' }" round>
      <div class="sheet diffsheet">
        <div class="sh-h"><span>{{ patchName }}</span><span class="x" @click="patchDlg = false">✕</span></div>
        <pre class="diff-patch"><code><span v-for="(l, li) in patchText.split('\n')" :key="li" :class="lineClass(l)">{{ l }}
</span></code></pre>
      </div>
    </van-popup>

    <!-- 长按消息：回退 / 复制 -->
    <van-popup v-model:show="lpSheet" position="bottom" round>
      <div class="sheet">
        <div class="sh">回退将丢弃该消息及其后的全部内容</div>
        <div class="si" :class="{ dis: !canControl }" @click="doRevert">回退到此消息</div>
        <div class="si" @click="lpCopy">复制消息文本</div>
        <div class="gap" />
        <div class="si" @click="lpSheet = false">取消</div>
      </div>
    </van-popup>

    <!-- 模型下拉（attached；managed 用注入模型池不显示） -->
    <van-popup v-model:show="modelSheet" position="bottom" round :style="{ maxHeight: '60%' }">
      <div class="sheet">
        <div class="sh-h"><span>选择模型</span><span class="x" @click="modelSheet = false">✕</span></div>
        <div class="si" :class="{ cur: !selectedModel }" @click="selectedModel = ''; modelSheet = false">opencode 默认</div>
        <div v-for="mo in models" :key="mo.value" class="si" :class="{ cur: selectedModel === mo.value }" @click="pickModel(mo.value)">
          <span class="si-nm">{{ mo.label }}</span>
          <span class="si-tg mono">{{ mo.provider }}</span>
        </div>
        <div v-if="!models.length" class="sh">未获取到模型列表</div>
      </div>
    </van-popup>

    <!-- agent 下拉 -->
    <van-popup v-model:show="agentSheet" position="bottom" round :style="{ maxHeight: '60%' }">
      <div class="sheet">
        <div class="sh-h"><span>选择 agent</span><span class="x" @click="agentSheet = false">✕</span></div>
        <div class="si" :class="{ cur: !selectedAgent }" @click="selectedAgent = ''; agentSheet = false">默认 agent</div>
        <div v-for="a in agents" :key="a.name" class="si" :class="{ cur: selectedAgent === a.name }" @click="pickAgent(a.name)">
          <span class="si-nm">{{ a.display || a.name }}</span>
          <span class="si-tg">{{ a.description || a.mode || '' }}</span>
        </div>
        <div v-if="!agents.length" class="sh">未获取到 agent 列表</div>
      </div>
    </van-popup>

    <!-- PTY 实时终端（实验性：协议未知，原始帧尽力渲染） -->
    <van-popup v-model:show="ptySheet" position="bottom" :style="{ height: '80%' }" round>
      <div class="sheet diffsheet">
        <div class="sh-h">
          <span>{{ activePty?.title || activePty?.command || 'PTY' }}<small v-if="activePty?.command" class="dim mono"> · {{ activePty?.command }}</small></span>
          <span class="x" @click="closePtySheet">✕</span>
        </div>
        <div class="pty-status" :class="{ bad: /断开|出错|关闭/.test(ptyLog) }">{{ ptyLog || '准备中…' }}</div>
        <pre ref="ptyOutEl" class="pty-out mono">{{ ptyOut }}</pre>
        <div class="pty-input-row">
          <input v-model="ptyInput" class="mono" placeholder="输入命令，回车发送（实验性）" @keydown.enter.prevent="sendPty" />
          <button :disabled="ptyConnecting" @click="sendPty">发送</button>
        </div>
      </div>
    </van-popup>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onActivated, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { showFailToast, showSuccessToast, showToast } from 'vant';
import {
  api,
  type OcAgentInfo,
  type OcDiffFile,
  type OcInstance,
  type OcModelsInfo,
  type OcPty,
} from '../api';
import {
  SessionStream,
  buildFormAnswer,
  dropFormDraft,
  fieldValueOf,
  formFieldsSignature,
  initialFormValues,
  loadFormDraft,
  missingRequiredKeys,
  saveFormDraft,
  visibleFields,
  toolOutputText as toolOutputOf,
  type FormFieldView,
  type FormFieldValue,
  type FormValues,
  type StreamQuestion,
  type StreamSnapshot,
} from '../opencode-stream';
import { useWs } from '../composables/useWs';
import OcFormField from '../components/OcFormField.vue';
import MdView from '../components/MdView.vue';

interface OcEventLike {
  type: string;
  properties?: Record<string, any>;
  id?: string;
}

const route = useRoute();
const router = useRouter();

const instanceId = computed(() => String(route.params.instance || ''));
const sessionId = computed(() => String(route.params.session || ''));

// ---------- 流式内核（TUI 同构状态机） ----------
// stream 为 let：切换会话（同组件路由参数变化）时整体换新实例，避免上一会话状态残留
let stream = new SessionStream();
const snap = ref<StreamSnapshot>(stream.snapshot());
/** 已知消息 id（reset 播种 + 已受理事件累积）——message.part.delta 无 sessionID，据此防他会话幽灵消息 */
const knownMsgIds = new Set<string>();
/** 历史分页状态（尾优先：初始 PAGE 条，上滑/点按钮拉更早） */
const PAGE = 50;
const hasMore = ref(false);
const nextBefore = ref('');
const loadingMore = ref(false);
/** 被服务端头尾裁剪的 part id（角标）+ 已拉全文中消息 id（渲染优先全文） */
const trimmedParts = ref(new Set<string>());
const fullMessages = ref(new Map<string, any>());
/** 本地已决权限（服务端 permission.replied 事件到达前先移除，双保险） */
const resolvedPerms = reactive(new Set<string>());
const livePermissions = computed(() => snap.value.pendingPermissions.filter((p) => !resolvedPerms.has(String(p.id))));
/** 本地已答提问（question.replied/rejected 事件到达前先移除，双保险）；qSel 逐题点选 / qDraft 自定义输入 */
const resolvedQuestions = reactive(new Set<string>());
const liveQuestions = computed(() => snap.value.pendingQuestions.filter((q) => !resolvedQuestions.has(String(q.id))));

// ---------- 提问 dock 逻辑：表单状态机（共享 @co-team/opencode-sync/form，key-based 作答） ----------
const qValues = ref<Record<string, FormValues>>({});
const qBusy = ref<Record<string, boolean>>({});
const qErrors = ref<Record<string, boolean>>({});

function qSigOf(q: StreamQuestion): string {
  return formFieldsSignature(q.questions || []);
}
function qValuesOf(q: StreamQuestion): FormValues {
  if (!qValues.value[q.id]) {
    qValues.value = { ...qValues.value, [q.id]: loadFormDraft(q.id, qSigOf(q)) ?? initialFormValues(q.questions || []) };
  }
  return qValues.value[q.id];
}
function qVisibleOf(q: StreamQuestion): FormFieldView[] {
  return visibleFields(q.questions || [], qValuesOf(q));
}
function qValueOf(q: StreamQuestion, key: string): FormFieldValue {
  return fieldValueOf(qValuesOf(q), key);
}
function qMissingOf(q: StreamQuestion): string[] {
  return missingRequiredKeys(q.questions || [], qValuesOf(q));
}
function patchQValue(q: StreamQuestion, key: string, patch: Partial<FormFieldValue>): void {
  const values = qValuesOf(q);
  qValues.value = { ...qValues.value, [q.id]: { ...values, [key]: { ...fieldValueOf(values, key), ...patch } } };
  saveFormDraft(q.id, qSigOf(q), qValues.value[q.id]);
  scheduleFlush();
}

// pending 提问到达即初始化/恢复草稿
watch(() => snap.value.pendingQuestions, (qs) => {
  for (const q of qs) {
    if (!qValues.value[q.id]) {
      qValues.value = { ...qValues.value, [q.id]: loadFormDraft(q.id, qSigOf(q)) ?? initialFormValues(q.questions || []) };
    }
  }
}, { immediate: true });

/** 常驻入口条：滚到第一张提问卡并高亮 */
function jumpToQuestion(id: string): void {
  const el = document.getElementById('qcard-' + id);
  if (!el) return;
  el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  el.classList.add('flash');
  setTimeout(() => el.classList.remove('flash'), 1600);
}

/** 提交：必填拦截 → key-based 作答；失败保留卡片可重试 */
async function submitQ(q: StreamQuestion): Promise<void> {
  if (qBusy.value[q.id]) return;
  const missing = qMissingOf(q);
  if (missing.length) {
    qErrors.value = { ...qErrors.value, [q.id]: true };
    return;
  }
  qBusy.value = { ...qBusy.value, [q.id]: true };
  try {
    const answer = buildFormAnswer(q.questions || [], qValuesOf(q));
    await api.ocAnswerQuestion(instanceId.value, String(q.id), answer);
    dropFormDraft(q.id);
    resolvedQuestions.add(String(q.id));
    showSuccessToast('已作答');
  } catch (e: any) {
    showFailToast(e?.message || '作答失败，可重试');
  } finally {
    qBusy.value = { ...qBusy.value, [q.id]: false };
  }
}

async function rejectQuestion(requestId: string): Promise<void> {
  try {
    await api.ocRejectQuestion(instanceId.value, requestId);
    resolvedQuestions.add(requestId);
    showSuccessToast('已谢绝，opencode 将自行继续');
  } catch (e: any) {
    showFailToast(e?.message || '操作失败');
  }
}

let gen = 0;
let lastEventId: string | undefined;
// ---------- 停帧看门狗（发送后回复不渲染的自愈兜底） ----------
// 服务端 opencode 事件泵若卡在断流退避窗，期间帧不可补放；已有的 5s status 对账只在
// "两端 busy 不一致"时触发，泵死在回复中途时两端一致正好漏掉。此处 busy 且长时间无任何
// 帧 → 全量重拉自愈。等提问/权限不算停帧（那是等人拍板）。
let lastFrameAt = Date.now();
let lastSelfHealAt = 0;
let watchdogTimer: ReturnType<typeof setInterval> | undefined;
const { connected, ensureStarted, onEvent, onResync } = useWs();
ensureStarted();
const sseState = computed<'connecting' | 'open' | 'closed'>(() => connected.value ? 'open' : 'closed');

// ---------- 页面状态 ----------
const instance = ref<OcInstance | null>(null);
const explicitTitle = ref('');
const sessionTitle = computed(() => snap.value.title || explicitTitle.value || shortId(sessionId.value));
const loadingMessages = ref(false);
const sending = ref(false);
const draft = ref('');
const moreSheet = ref(false);
const streamEl = ref<HTMLElement>();
const showToBottom = ref(false);
const showToTop = ref(false);
let stickBottom = true;

// 展开态（按 part key 持久化：part.updated 全量校正换对象引用不丢展开）
const toolOpen = reactive(new Set<string>());
const toolOutFull = reactive(new Set<string>());
const thinkClosed = ref(new Set<string>());

// diff / patch
const diffDlg = ref(false);
const diffFiles = ref<OcDiffFile[]>([]);
const patchDlg = ref(false);
const patchText = ref('');
const patchName = ref('');

// 长按消息（回退）
const lpSheet = ref(false);
const lpTarget = ref<any>(null);
let lpTimer: number | undefined;

// 模型 / agent 下拉
interface ModelOption { value: string; label: string; provider: string; }
const isManaged = computed(() => instance.value?.kind === 'managed');
const canControl = computed(() => instance.value?.mode === 'control');
const models = ref<ModelOption[]>([]);
const selectedModel = ref('');
const modelSheet = ref(false);
const agents = ref<OcAgentInfo[]>([]);
const selectedAgent = ref('');
const agentSheet = ref(false);
const modelLabel = computed(() => {
  if (!selectedModel.value) return '默认模型';
  const f = models.value.find((x) => x.value === selectedModel.value);
  return f ? f.label : shortId(selectedModel.value);
});
const modelBadge = computed(() => (isManaged.value ? '注入模型' : modelLabel.value));

// PTY 实时终端
const ptySheet = ref(false);
const activePty = ref<OcPty | null>(null);
const ptyConnecting = ref(false);
const ptyLog = ref('');
const ptyOut = ref('');
const ptyInput = ref('');
const ptyOutEl = ref<HTMLElement>();
let ptyWs: WebSocket | null = null;

// ---------- 事件过滤与状态机驱动 ----------

/** 事件的 session 归属（各族字段名不一：sessionID / info.sessionID / part.sessionID） */
function evSid(ev: OcEventLike): string {
  const p: any = ev.properties || {};
  return String(p.sessionID || p.session_id || p.sessionId || (p.info && p.info.sessionID) || (p.part && p.part.sessionID) || '');
}

function belongsToSession(ev: OcEventLike): boolean {
  const sid = evSid(ev);
  if (sid && sid !== sessionId.value) return false;
  // message.part.delta 不带 sessionID：仅对已知消息应用（message.updated 先行是正常时序，
  // 未知 id 视为其他会话的 delta，天然过滤幽灵消息漏绘）
  if (ev.type === 'message.part.delta') {
    const mid = String((ev.properties as any)?.messageID || '');
    if (mid && !knownMsgIds.has(mid)) return false;
  }
  return true;
}

function rememberIds(ev: OcEventLike) {
  const p: any = ev.properties || {};
  const ids = [p.messageID, p.part && p.part.messageID, p.info && p.info.id];
  for (const x of ids) if (x) knownMsgIds.add(String(x));
}

function applyEvents(events: OcEventLike[]) {
  let applied = 0;
  for (const ev of events) {
    // 子会话事件 → 内嵌子流（TUI 同款：子代理活动实时嵌在父会话里）
    const evOwner = evSid(ev);
    if (evOwner && evOwner !== sessionId.value) {
      const cs = childStreams.get(evOwner);
      if (cs) {
        cs.applyEvent(ev);
        childSnaps.value = new Map(childSnaps.value).set(evOwner, cs.snapshot());
        applied += 1;
      }
      continue;
    }
    if (!belongsToSession(ev)) continue;
    rememberIds(ev);
    if (typeof ev.id === 'string' && ev.id) lastEventId = ev.id;
    stream.applyEvent(ev);
    applied += 1;
  }
  if (applied) {
    lastFrameAt = Date.now();
    scheduleFlush();
  }
}

async function replayFromHub(): Promise<void> {
  if (!lastEventId) return;
  try {
    const result = await api.ocReplay(instanceId.value, lastEventId);
    if (result.resync) {
      await reloadAll();
      return;
    }
    applyEvents((result.events || []) as OcEventLike[]);
  } catch {
    await reloadAll();
  }
}

const offWs = onEvent((message) => {
  if (message.type !== 'oc_event' || message.payload?.instance !== instanceId.value) return;
  const frame = message.payload?.event;
  applyEvents(frame?.events ? frame.events : frame ? [frame] : []);
});
const offResync = onResync(() => { void replayFromHub(); });
watch(connected, (value) => { if (value) void replayFromHub(); });
// 流内出现新 task 工具分片时重配对（busy 中实时派生子代理的场景）
watch(() => snap.value.messages.length, () => {
  if (childSessions.value.length) pairChildren();
});

// 渲染合并：delta 洪峰（几十/s）时 80ms 一拍取 snapshot，避免每 token 全量重建
let flushTimer: number | undefined;
function scheduleFlush() {
  if (flushTimer !== undefined) return;
  flushTimer = window.setTimeout(() => {
    flushTimer = undefined;
    flushNow();
  }, 80);
}
function flushNow() {
  snap.value = stream.snapshot();
  if (stickBottom) nextTick(scrollEnd);
}

// ---------- 数据加载 ----------

async function loadInstanceAndTitle() {
  try {
    const [insts, sess] = await Promise.all([
      api.ocInstances(),
      api.ocSessions(instanceId.value).catch(() => ({ sessions: [] })),
    ]);
    instance.value = (insts.instances || []).find((x) => x.id === instanceId.value) || null;
    const found = (sess.sessions || []).find((s) => s.id === sessionId.value);
    explicitTitle.value = found?.title || '';
  } catch { /* 标题缺失不阻塞消息流 */ }
}

async function loadMessages() {
  if (!instanceId.value || !sessionId.value) return;
  const my = gen;
  loadingMessages.value = true;
  try {
    const d = await api.ocMessages(instanceId.value, sessionId.value, { limit: PAGE, full: true });
    if (my !== gen) return;
    stream.reset(d.messages || []);
    lastEventId = d.event_id || undefined;
    hasMore.value = !!d.has_more;
    nextBefore.value = d.next_before || '';
    trimmedParts.value = new Set(d.trimmed || []);
    fullMessages.value = new Map();
    childStreams.clear();
    childSnaps.value = new Map();
    taskChildMap.value = new Map();
    childSessions.value = [];
    knownMsgIds.clear();
    for (const m of d.messages || []) {
      const id = String((m as any)?.info?.id || (m as any)?.id || '');
      if (id) knownMsgIds.add(id);
    }
    lastFrameAt = Date.now();
    flushNow();
    void loadChildren();
  } catch (e: any) {
    if (my !== gen) return;
    showFailToast(e?.message || '消息加载失败');
  } finally {
    if (my === gen) loadingMessages.value = false;
  }
}

/** 上滑/点按钮加载更早消息（尾优先分页） */
async function loadMore() {
  if (!hasMore.value || !nextBefore.value || loadingMore.value) return;
  loadingMore.value = true;
  const el = streamEl.value;
  const prevH = el?.scrollHeight || 0;
  const prevT = el?.scrollTop || 0;
  try {
    const d = await api.ocMessages(instanceId.value, sessionId.value, { limit: PAGE, before: nextBefore.value, full: true });
    if (d.messages?.length) {
      stream.prepend(d.messages);
      for (const id of d.trimmed || []) trimmedParts.value.add(id);
      flushNow();
      await nextTick();
      if (el) el.scrollTop = prevT + (el.scrollHeight - prevH);
    }
    hasMore.value = !!d.has_more;
    nextBefore.value = d.next_before || '';
  } catch (e: any) {
    showFailToast(e?.message || '加载更早消息失败');
  } finally {
    loadingMore.value = false;
  }
}

/** 完整原文：裁剪块点"原文" → 拉单条全文，渲染优先取全文 */
async function openFullMessage(messageId: string) {
  if (!messageId) return;
  try {
    const r = await api.ocMessageFull(instanceId.value, sessionId.value, messageId);
    if (r.ok && r.message) {
      fullMessages.value = new Map(fullMessages.value).set(messageId, r.message);
    } else {
      showFailToast(r.error || '完整原文加载失败');
    }
  } catch (e: any) {
    showFailToast(e?.message || '完整原文加载失败');
  }
}

/** 渲染取 parts：全文缓存优先于（可能已裁剪的）流内版本 */
function partsOf(m: any): any[] {
  const full = fullMessages.value.get(String(m.id));
  if (full?.parts?.length) return full.parts;
  return m.parts || [];
}

async function loadStatus() {
  const my = gen;
  try {
    const d = await api.ocSessionStatus(instanceId.value, sessionId.value);
    if (my !== gen) return;
    if (d.status && d.status !== 'unknown') {
      stream.applyEvent({ type: 'session.status', properties: { status: { type: d.status } } });
      flushNow();
    }
  } catch { /* 软错误：5s 轮询还会再试 */ }
}

async function loadTodos() {
  const my = gen;
  try {
    const d = await api.ocTodos(instanceId.value, sessionId.value);
    if (my !== gen || !Array.isArray(d.todos)) return;
    stream.applyEvent({ type: 'todo.updated', properties: { todos: d.todos } });
    flushNow();
  } catch { /* 软错误 */ }
}

async function loadPtys() {
  const my = gen;
  try {
    const d = await api.ocPtys(instanceId.value);
    if (my !== gen) return;
    for (const pt of d.ptys || []) stream.applyEvent({ type: 'pty.created', properties: { info: pt } });
    flushNow();
  } catch { /* 软错误 */ }
}

async function reloadAll() {
  const my = gen;
  await Promise.all([loadMessages(), loadStatus(), loadTodos(), loadPtys()]);
  if (my === gen) flushNow();
}

/** 进入（或切换）会话：新状态机 + 权威快照 + 事件订阅（先缓存后重放，窗口不漏帧） */
async function enterSession() {
  const my = ++gen;
  lastEventId = undefined;
  lastFrameAt = Date.now();
  lastSelfHealAt = 0;
  stream = new SessionStream();
  knownMsgIds.clear();
  resolvedPerms.clear();
  resolvedQuestions.clear();
  qValues.value = {};
  qErrors.value = {};
  qBusy.value = {};
  toolOpen.clear();
  toolOutFull.clear();
  thinkClosed.value = new Set();
  snap.value = stream.snapshot();
  stickBottom = true;
  loadingMessages.value = true;

  void loadInstanceAndTitle();
  await loadMessages();
  if (my !== gen) return;
  await Promise.all([loadStatus(), loadTodos(), loadPtys()]);
  if (my !== gen) return;
  flushNow();
}

// ---------- 操作 ----------

function onKeydown(e: KeyboardEvent) {
  if (e.key !== 'Enter') return;
  if (e.shiftKey) return; // Shift+Enter 换行：不拦截默认行为
  e.preventDefault();
  void send();
}

async function send() {
  const text = draft.value.trim();
  if (!text || sending.value || !canControl.value) return;
  const my = gen;
  sending.value = true;
  stickBottom = true;
  try {
    if (text.startsWith('/')) {
      const cmd = text.replace(/^\/+/, '').trim();
      if (!cmd) {
        showFailToast('命令不能为空');
        return;
      }
      await api.ocCommand(instanceId.value, sessionId.value, cmd);
      showSuccessToast(`命令 /${cmd} 已执行`);
    } else {
      await api.ocPrompt(instanceId.value, sessionId.value, {
        prompt: text,
        ...(selectedModel.value ? { model: selectedModel.value } : {}),
        ...(selectedAgent.value ? { agent: selectedAgent.value } : {}),
      });
    }
    draft.value = '';
    await Promise.all([loadMessages(), loadStatus()]);
  } catch (e: any) {
    showFailToast(e?.message || '发送失败');
  } finally {
    if (my === gen) sending.value = false;
  }
}

async function abortSession() {
  moreSheet.value = false;
  const my = gen;
  try {
    await api.ocAbort(instanceId.value, sessionId.value);
    showSuccessToast('已发送打断信号');
    await Promise.all([loadMessages(), loadStatus()]);
  } catch (e: any) {
    showFailToast(e?.message || '打断失败');
  } finally {
    if (my === gen) sending.value = false;
  }
}

async function resolvePermission(permId: string, response: 'once' | 'always' | 'reject') {
  try {
    await api.ocResolvePermission(instanceId.value, sessionId.value, permId, response);
    resolvedPerms.add(permId);
    showSuccessToast(response === 'reject' ? '已拒绝' : response === 'always' ? '已授权（不再询问）' : '已批准一次');
  } catch (e: any) {
    showFailToast(e?.message || '审批提交失败');
  }
}

async function doRevert() {
  const m = lpTarget.value;
  lpSheet.value = false;
  const id = String(m?.id || '');
  if (!id) return;
  try {
    await api.ocRevert(instanceId.value, sessionId.value, id);
    showSuccessToast('已回退');
    await reloadAll();
  } catch (e: any) {
    showFailToast(e?.message || '回退失败');
  }
}

function lpCopy() {
  const m = lpTarget.value;
  lpSheet.value = false;
  const text = ((m?.parts || []) as any[]).map((p) => (p?.type === 'text' ? String(p.text || '') : '')).join('\n').trim();
  if (text) {
    navigator.clipboard?.writeText(text).catch(() => {});
    showToast('已复制');
  }
}

// ---------- diff / patch ----------

function lineClass(l: string): string {
  return l.startsWith('+') && !l.startsWith('+++') ? 'add' : l.startsWith('-') && !l.startsWith('---') ? 'del' : 'ctx';
}

async function openDiff() {
  try {
    const d = await api.ocDiff(instanceId.value, sessionId.value);
    diffFiles.value = d.diff || [];
    diffDlg.value = true;
  } catch (e: any) {
    showFailToast(e?.message || 'diff 获取失败');
  }
}

interface PatchFileView { path: string; additions: number; deletions: number }
function patchFilesOf(p: any): PatchFileView[] {
  const files = Array.isArray(p?.files) ? p.files : [];
  return files.map((f: any) =>
    typeof f === 'string'
      ? { path: f, additions: 0, deletions: 0 }
      : { path: String(f?.path || f?.file || f?.filename || ''), additions: Number(f?.additions || 0), deletions: Number(f?.deletions || 0) },
  );
}

function openPatch(p: any) {
  patchName.value = `文件变更 · ${patchFilesOf(p).length} 个`;
  patchText.value = String(p?.patch || p?.diff || (p?.files ? JSON.stringify(p.files, null, 2) : '（该 part 未携带 patch 文本）'));
  patchDlg.value = true;
}

// ---------- 模型 / agent ----------

function flattenProviders(d: OcModelsInfo): ModelOption[] {
  const out: ModelOption[] = [];
  for (const p of d.providers || []) {
    const pid = String(p?.id || p?.providerID || '');
    if (!pid) continue;
    const pname = String(p?.name || pid);
    const models = (p?.models && typeof p.models === 'object' ? p.models : {}) as Record<string, any>;
    for (const [mid, info] of Object.entries(models)) {
      out.push({ value: `${pid}/${mid}`, label: String(info?.name || mid), provider: pname });
    }
  }
  return out;
}

async function openModels() {
  modelSheet.value = true;
  if (models.value.length) return;
  try {
    models.value = flattenProviders(await api.ocModels(instanceId.value));
  } catch (e: any) {
    showFailToast(e?.message || '模型列表获取失败');
  }
}

async function openAgents() {
  agentSheet.value = true;
  if (agents.value.length) return;
  try {
    const d = await api.ocAgents(instanceId.value);
    agents.value = d.agents || [];
  } catch (e: any) {
    showFailToast(e?.message || 'agent 列表获取失败');
  }
}

function onBadgeClick() {
  if (isManaged.value) {
    showToast('managed 实例：模型由 co-team 模型池注入');
    return;
  }
  void openModels();
}

// ---------- PTY 实时终端（实验性） ----------

function appendPty(chunk: string) {
  if (!chunk) return;
  ptyOut.value = (ptyOut.value + chunk).slice(-20000);
  nextTick(() => {
    const el = ptyOutEl.value;
    if (el) el.scrollTop = el.scrollHeight;
  });
}

async function openPty(pt: OcPty) {
  activePty.value = pt;
  ptySheet.value = true;
  ptyOut.value = '';
  ptyInput.value = '';
  ptyConnecting.value = true;
  ptyLog.value = '正在签票…';
  try {
    const d = await api.ocPtyTicket(instanceId.value, pt.id);
    if (!d.ok || !d.ws_url) throw new Error('签票失败');
    const sep = d.ws_url.includes('?') ? '&' : '?';
    const ws = new WebSocket(`${d.ws_url}${sep}ticket=${encodeURIComponent(d.ticket)}`);
    ptyWs = ws;
    ws.onopen = () => {
      ptyConnecting.value = false;
      ptyLog.value = '已连接（实验性：输入回车发送，原始帧尽力渲染）';
    };
    ws.onmessage = (e: MessageEvent) => {
      const data: any = e.data;
      if (typeof data === 'string') appendPty(data);
      else if (data instanceof Blob) void data.text().then(appendPty).catch(() => {});
      else if (data instanceof ArrayBuffer) appendPty(new TextDecoder().decode(data));
    };
    ws.onerror = () => { ptyLog.value = '连接出错（PTY 可能已退出）'; };
    ws.onclose = () => {
      ptyConnecting.value = false;
      if (ptyLog.value.startsWith('已连接') || ptyLog.value.startsWith('正在')) ptyLog.value = '连接已关闭';
    };
  } catch (e: any) {
    ptyConnecting.value = false;
    ptyLog.value = '';
    showFailToast(e?.message || 'PTY 连接失败');
    ptySheet.value = false;
  }
}

function sendPty() {
  const t = ptyInput.value;
  if (!t || !ptyWs || ptyWs.readyState !== WebSocket.OPEN) return;
  ptyWs.send(`${t}\r`); // 原始终端协议未知：按"键入 + 回车"尽力发送
  ptyInput.value = '';
}

function closePtyWs() {
  const ws = ptyWs;
  ptyWs = null;
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
    try { ws.close(); } catch { /* 已断 */ }
  }
}

function closePtySheet() {
  ptySheet.value = false;
  closePtyWs();
}

watch(ptySheet, (v) => { if (!v) closePtyWs(); });

// ---------- 长按 ----------

function lpStart(m: any) {
  if (lpTimer !== undefined) clearTimeout(lpTimer);
  lpTimer = window.setTimeout(() => {
    lpTarget.value = m;
    lpSheet.value = true;
  }, 500);
}
function lpCancel() {
  if (lpTimer !== undefined) {
    clearTimeout(lpTimer);
    lpTimer = undefined;
  }
}

// ---------- 滚动 ----------

function isNearEnd(): boolean {
  const el = streamEl.value;
  return !el || el.scrollHeight - el.scrollTop - el.clientHeight < 160;
}
function scrollEnd() {
  const el = streamEl.value;
  if (el) el.scrollTop = el.scrollHeight;
}
function onStreamScroll() {
  stickBottom = isNearEnd();
  showToBottom.value = !stickBottom;
  const el = streamEl.value;
  showToTop.value = !!el && el.scrollTop > 480;
  if (el && el.scrollTop < 80) void loadMore();
}
function toTop() {
  const el = streamEl.value;
  if (el) el.scrollTo({ top: 0, behavior: 'smooth' });
}
function toBottom() {
  scrollEnd();
  stickBottom = true;
  showToBottom.value = false;
}
function autoGrow(e: Event) {
  const ta = e.target as HTMLTextAreaElement;
  ta.style.height = 'auto';
  ta.style.height = Math.min(ta.scrollHeight, 120) + 'px';
}

// ---------- 渲染辅助 ----------

const SUMMARY_TYPES = ['snapshot', 'agent', 'retry', 'compaction', 'subtask', 'file'];

function pk(m: any, p: any, pi: number | string): string {
  return `${String(m?.id || '')}:${String(p?.id || pi)}`;
}
function shortId(id: string): string {
  return id.length > 12 ? id.slice(0, 8) + '…' : id;
}
function clipText(s: string, max = 1500): string {
  return s.length > max ? s.slice(0, max) + '\n…（已截断）' : s;
}
function errText(e: any): string {
  if (typeof e === 'string') return e;
  if (e?.message) return String(e.message);
  return clipText(JSON.stringify(e), 200);
}
function fmtTok(n: number): string {
  return n >= 1000 ? (n / 1000).toFixed(1) + 'k' : String(n);
}
function usageText(m: any): string {
  const t = m?.tokens || {};
  const total = Number(t.total ?? (Number(t.input || 0) + Number(t.output || 0) + Number(t.reasoning || 0))) || 0;
  const parts: string[] = [];
  if (total) parts.push(`${fmtTok(total)} tok`);
  const cost = Number(m?.cost || 0);
  if (cost) parts.push(`$${cost < 0.01 ? cost.toFixed(4) : cost.toFixed(2)}`);
  return parts.join(' · ');
}
function todoMark(t: any): string {
  return t?.status === 'completed' ? '✓' : t?.status === 'in_progress' ? '●' : '○';
}

interface ToolView { status: string; title: string; input: any; output: any; error: string; attachments: any[] }
function toolStateOf(p: any): ToolView {
  const st = p?.state && typeof p.state === 'object' ? (p.state as Record<string, any>) : {};
  return {
    status: String(st.status || p?.status || 'completed'),
    title: String(st.title || p?.title || p?.tool || 'tool'),
    input: st.input,
    output: st.output,
    error: String(st.error || p?.error || ''),
    attachments: Array.isArray(st.attachments) ? st.attachments : [],
  };
}
function isToolLive(status: string): boolean {
  return status === 'pending' || status === 'running';
}
function toText(v: any): string {
  if (v === undefined || v === null || v === '') return '';
  if (typeof v === 'string') return v;
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
}
function toolInputText(p: any): string {
  const t = toText(toolStateOf(p).input);
  return t ? clipText(t.replace(/\s+/g, ' '), 300) : '';
}
function toolOutputText(p: any): string {
  // 共享包版本：解包 v2 state.output 内容块数组 + metadata 回退（与 web/TUI 同源取值）
  return toolOutputOf(p, 30_000);
}
function attName(a: any): string {
  return String(a?.filename || a?.name || a?.path || a?.id || '附件');
}
function toggleTool(k: string) {
  if (toolOpen.has(k)) toolOpen.delete(k); else toolOpen.add(k);
}
function toggleOutFull(k: string) {
  if (toolOutFull.has(k)) toolOutFull.delete(k); else toolOutFull.add(k);
}
function toggleThink(k: string) {
  const next = new Set(thinkClosed.value);
  if (next.has(k)) next.delete(k); else next.add(k);
  thinkClosed.value = next;
}

// ---------- 即时切换（TUI 同款：选中即生效，不等发送） ----------

async function pickAgent(name: string) {
  selectedAgent.value = name;
  agentSheet.value = false;
  try {
    const r = await api.ocSwitchAgent(instanceId.value, sessionId.value, name);
    if (r.ok) showSuccessToast(`执行模式已切换：${name}`);
    else showFailToast(r.error || '切换失败');
  } catch (e: any) {
    showFailToast(e?.message || '切换失败');
  }
}

async function pickModel(value: string) {
  selectedModel.value = value;
  modelSheet.value = false;
  try {
    const r = await api.ocSwitchModel(instanceId.value, sessionId.value, value);
    if (r.ok) showSuccessToast(`模型已切换：${value}`);
    else showFailToast(r.error || '切换失败');
  } catch (e: any) {
    showFailToast(e?.message || '切换失败');
  }
}

// ---------- 子代理内嵌：task 工具派生的子会话，TUI 同款一层展示 ----------

const childSessions = ref<any[]>([]);
const taskChildMap = ref(new Map<string, string>());
const childStreams = new Map<string, SessionStream>();
const childSnaps = ref(new Map<string, any>());

async function loadChildren() {
  try {
    const d = await api.ocSessions(instanceId.value);
    childSessions.value = (d.sessions || []).filter((s: any) => s.parentID === sessionId.value);
    pairChildren();
  } catch { /* 会话列表失败不影响主聊天 */ }
}

/** task 工具分片 ↔ 子会话配对：子会话创建时间落在工具执行窗口内 */
function pairChildren() {
  const map = new Map<string, string>();
  const used = new Set<string>();
  const kids = [...childSessions.value].sort((a, b) => Number(a.time?.created || 0) - Number(b.time?.created || 0));
  for (const m of snap.value.messages) {
    for (const p of m.parts || []) {
      if (p.type !== 'tool' || !/^(task|agent|subtask)$/i.test(String(p.tool || ''))) continue;
      const t = (p.time || {}) as Record<string, number>;
      const lo = Number(t.created || 0) - 1000;
      const hi = Number(t.completed || Number.MAX_SAFE_INTEGER) + 1000;
      const kid = kids.find((k) => !used.has(k.id) && Number(k.time?.created || 0) >= lo && Number(k.time?.created || 0) <= hi);
      if (kid) {
        map.set(String(p.id), kid.id);
        used.add(kid.id);
        ensureChildStream(kid.id);
      }
    }
  }
  taskChildMap.value = map;
}

function ensureChildStream(sid: string) {
  if (childStreams.has(sid)) return;
  const cs = new SessionStream();
  childStreams.set(sid, cs);
  void (async () => {
    try {
      const d = await api.ocMessages(instanceId.value, sid, { limit: 40, full: true });
      cs.reset(d.messages || []);
      childSnaps.value = new Map(childSnaps.value).set(sid, cs.snapshot());
    } catch { /* 子会话消息失败不阻塞主流程 */ }
  })();
}

function childMessages(sid: string | undefined): any[] {
  if (!sid) return [];
  return childSnaps.value.get(sid)?.messages || [];
}

function childMsgText(m: any): string {
  const text = (m.parts || []).filter((p: any) => p.type === 'text' && p.text).map((p: any) => String(p.text)).join(' ');
  return text.length > 300 ? text.slice(0, 300) + '…' : text;
}

function chipTextOf(p: any): string {
  switch (String(p?.type)) {
    case 'retry':
      return `第 ${Number(p?.attempt ?? 0)} 次重试${p?.error ? `：${clipText(String(p.error), 120)}` : ''}`;
    case 'compaction':
      return '上下文已压缩';
    case 'snapshot':
      return `快照 ${shortId(String(p?.hash || p?.id || ''))}`;
    case 'agent':
      return `agent · ${String(p?.name || p?.agent || '?')}`;
    case 'subtask':
      return `子任务 · ${String(p?.title || p?.description || shortId(String(p?.id || '')))}`;
    case 'file':
      return `文件 · ${String(p?.filename || p?.path || shortId(String(p?.id || '')))}`;
    default:
      return String(p?.type || '');
  }
}

function permDetailOf(p: any): string {
  const pat = Array.isArray(p?.pattern) ? p.pattern.join(' , ') : p?.pattern;
  return String(pat || p?.command || 'opencode 请求执行一个操作');
}
function permMetaText(p: any): string {
  const md = p?.metadata;
  if (!md || typeof md !== 'object') return '';
  return clipText(JSON.stringify(md), 400);
}

// ---------- 生命周期 ----------

let pollTimer: number | undefined;

function onVisibility() {
  if (document.visibilityState !== 'visible') return;
  void replayFromHub();
  void reloadAll();
}

onMounted(() => {
  void enterSession();
  // 5s 兜底轮询：与 session.status 对账，差异大且事件流陈旧 → 全量 reset 自愈（断线不漏终态）
  pollTimer = window.setInterval(() => {
    if (document.visibilityState !== 'visible') return;
    void (async () => {
      try {
        const d = await api.ocSessionStatus(instanceId.value, sessionId.value);
        const serverBusy = d.status === 'busy';
        const local = snap.value;
        if (serverBusy !== local.busy) {
          if (d.status && d.status !== 'unknown') {
            stream.applyEvent({ type: 'session.status', properties: { status: { type: d.status } } });
            flushNow();
          }
          if (Date.now() - (local.lastEventAt || 0) > 4000) void reloadAll();
        }
      } catch { /* 软错误：下轮再试 */ }
    })();
  }, 5000);
  // 停帧看门狗：busy 但 30s 无任何事件帧 → 全量重拉（服务端事件泵退避窗内帧不可补放）
  watchdogTimer = window.setInterval(() => {
    if (document.visibilityState !== 'visible') return;
    const s = snap.value;
    if (!s.busy || s.pendingQuestions.length || s.pendingPermissions.length) return;
    const now = Date.now();
    if (now - lastFrameAt < 30_000 || now - lastSelfHealAt < 30_000) return;
    lastSelfHealAt = now;
    void reloadAll();
  }, 5000);
  document.addEventListener('visibilitychange', onVisibility);
});

// 同组件切换会话（路由参数变化）：整体重入
watch([instanceId, sessionId], () => { void enterSession(); });

onActivated(() => { void replayFromHub(); void reloadAll(); });

onBeforeUnmount(() => {
  offWs();
  offResync();
  if (pollTimer !== undefined) {
    window.clearInterval(pollTimer);
    pollTimer = undefined;
  }
  if (watchdogTimer !== undefined) {
    window.clearInterval(watchdogTimer);
    watchdogTimer = undefined;
  }
  if (flushTimer !== undefined) {
    window.clearTimeout(flushTimer);
    flushTimer = undefined;
  }
  document.removeEventListener('visibilitychange', onVisibility);
  closePtyWs();
  lpCancel();
});
</script>

<style scoped>
/* 填满 app-root 的动态视口（100dvh），不要用 100vh——手机浏览器 100vh 含地址栏高度，
   会把底部输入栏推出屏幕外（实测输入不了）；flex:1 + min-height:0 让流内滚动、输入栏常驻可视区 */
.page { flex: 1; min-height: 0; display: flex; flex-direction: column; }
.nav-title { font-size: 15px; font-weight: 600; }
.nav-badge { font-size: 10px; color: var(--text-3); border: 1px solid var(--line); border-radius: 99px; padding: 2px 8px; margin-right: 4px; max-width: 34vw; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.nav-abort { font-size: 12px; color: var(--danger); border: 1px solid color-mix(in srgb, var(--danger) 40%, transparent); border-radius: 99px; padding: 2px 9px; margin-right: 6px; }
.nav-abort:active { background: color-mix(in srgb, var(--danger) 10%, transparent); }
.projline { padding: 8px 14px 6px; font-size: 11px; color: var(--text-3); display: flex; align-items: center; gap: 8px; }
.projline .st-tag { font-size: 10px; padding: 1px 7px; border-radius: 4px; border: 1px solid var(--line-strong); }
.projline .st-tag.busy { color: var(--warn); border-color: color-mix(in srgb, var(--warn) 45%, transparent); }
.projline .st-tag.idle { color: var(--text-3); }

.conn-ribbon { padding: 6px 14px; font-size: 11px; color: var(--warn); background: color-mix(in srgb, var(--warn) 9%, transparent); border-bottom: 1px solid color-mix(in srgb, var(--warn) 25%, transparent); display: flex; align-items: center; gap: 6px; }
.spin { display: inline-block; width: 11px; height: 11px; border: 2px solid var(--line-strong); border-top-color: var(--accent); border-radius: 50%; animation: rot .8s linear infinite; flex: none; }
@keyframes rot { to { transform: rotate(360deg); } }

.err-bar { padding: 7px 14px; font-size: 11.5px; color: var(--danger); background: color-mix(in srgb, var(--danger) 8%, transparent); border-bottom: 1px solid color-mix(in srgb, var(--danger) 25%, transparent); line-height: 1.5; }
.retry-bar { padding: 6px 14px; font-size: 11px; color: var(--warn); background: color-mix(in srgb, var(--warn) 8%, transparent); border-bottom: 1px solid color-mix(in srgb, var(--warn) 22%, transparent); }
.revert-bar { padding: 6px 14px; font-size: 11px; color: var(--text-2); background: var(--bg-inset); border-bottom: 1px solid var(--line); }

/* todos 横滚 chip 栏 */
.todos { display: flex; gap: 6px; padding: 8px 12px 4px; overflow-x: auto; scrollbar-width: none; }
.todos::-webkit-scrollbar { display: none; }
.todo { flex: none; font-size: 11px; color: var(--text-2); background: var(--bg-inset); border: 1px solid var(--line); border-radius: 99px; padding: 3px 10px; display: inline-flex; align-items: center; gap: 5px; max-width: 72vw; }
.todo i { font-style: normal; color: var(--text-3); }
.todo.in_progress { color: var(--accent); border-color: color-mix(in srgb, var(--accent) 45%, transparent); background: color-mix(in srgb, var(--accent) 8%, transparent); }
.todo.in_progress i { color: var(--accent); }
.todo.completed { opacity: .6; text-decoration: line-through; }

/* 消息流 */
.stream { flex: 1; overflow-y: auto; padding: 12px 12px 8px; }
.notice { color: var(--text-3); font-size: 12px; text-align: center; padding: 40px 0; display: flex; align-items: center; justify-content: center; gap: 8px; }
.u-row { display: flex; justify-content: flex-end; margin: 10px 0 6px; }
.u-bub { max-width: 78%; background: var(--accent); color: var(--accent-text); border-radius: 12px 12px 3px 12px; padding: 9px 12px; font-size: 13.5px; line-height: 1.6; white-space: pre-wrap; overflow-wrap: anywhere; }
.u-bub .mini { font-size: 10.5px; opacity: .75; margin-top: 4px; }
.u-bub .dim { opacity: .75; }

.a-block { margin: 10px 0; }
.a-head { display: flex; align-items: center; gap: 8px; padding: 2px 2px 6px; flex-wrap: wrap; }
.a-name { font-size: 13px; font-weight: 600; color: var(--text-1); }
.a-model { font-size: 10px; color: var(--text-3); padding: 2px 8px; border: 1px solid var(--line); border-radius: 99px; }
.a-usage { font-size: 10px; color: var(--text-3); }
.a-fin { font-size: 10px; color: var(--warn); border: 1px solid color-mix(in srgb, var(--warn) 40%, transparent); border-radius: 4px; padding: 1px 6px; }
.a-err { margin: 2px 2px 6px; font-size: 11.5px; color: var(--danger); background: color-mix(in srgb, var(--danger) 8%, transparent); border: 1px solid color-mix(in srgb, var(--danger) 25%, transparent); border-radius: 6px; padding: 6px 9px; line-height: 1.5; }
.a-text { padding: 2px 2px 6px; font-size: 14px; line-height: 1.7; overflow-wrap: anywhere; }

/* 思考折叠 */
.thinking { margin: 6px 2px; padding: 7px 10px; border: 1px solid var(--line); border-radius: 8px; background: var(--bg-inset); }
.thinking .lab { font-size: 11px; color: var(--text-3); letter-spacing: .1em; }
.thinking .tb { display: block; font-size: 12px; line-height: 1.7; color: var(--text-2); white-space: pre-wrap; overflow-wrap: anywhere; margin-top: 4px; max-height: 240px; overflow-y: auto; }
.thinking .tb.short { color: var(--text-3); }

/* 工具四态卡 */
.tool-card { margin: 6px 2px; border: 1px solid var(--line); border-radius: 8px; background: var(--bg-panel); overflow: hidden; }
.tool-card.running, .tool-card.pending { border-color: color-mix(in srgb, var(--warn) 40%, transparent); }
.tool-card.error { border-color: color-mix(in srgb, var(--danger) 40%, transparent); }
.tool-head { display: flex; align-items: center; gap: 8px; padding: 8px 10px; }
.tool-head:active { background: var(--bg-inset); }
.tool-head .dot { width: 7px; height: 7px; border-radius: 50%; flex: none; }
.tool-head .dot.ok { background: var(--ok); }
.tool-head .dot.err { background: var(--danger); }
.tool-name { font-size: 11px; font-weight: 600; color: var(--text-1); background: var(--bg-inset); border: 1px solid var(--line); border-radius: 5px; padding: 2px 7px; flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.tool-head .car { font-size: 10px; color: var(--text-3); flex: none; }
.tool-body { border-top: 1px dashed var(--line); padding: 8px 10px; }
.tool-io { font-size: 11px; color: var(--text-2); line-height: 1.6; white-space: pre-wrap; word-break: break-all; }
.tool-out { font-family: var(--font-mono, monospace); font-size: 11px; line-height: 1.6; color: var(--text-2); white-space: pre-wrap; word-break: break-all; margin: 6px 0 0; max-height: 260px; overflow-y: auto; }
.tool-err { font-size: 11px; color: var(--danger); line-height: 1.6; white-space: pre-wrap; word-break: break-all; }
.tool-more { display: inline-block; margin-top: 6px; font-size: 11px; color: var(--accent); }
.child-flow { margin-top: 8px; padding: 6px 8px; background: var(--bg-inset, rgba(127, 127, 127, 0.08)); border-radius: 6px; display: flex; flex-direction: column; gap: 6px; max-height: 280px; overflow: auto; }
.child-lab { font-size: 10.5px; color: var(--text-3); }
.c-msg { display: flex; gap: 6px; align-items: baseline; font-size: 11.5px; line-height: 1.55; }
.c-role { flex: none; font-size: 9.5px; padding: 0 4px; border-radius: 4px; background: var(--bg-panel, rgba(127, 127, 127, 0.15)); color: var(--text-2); }
.c-msg.assistant .c-role { color: var(--accent); }
.c-text { min-width: 0; white-space: pre-wrap; word-break: break-word; color: var(--text-2); }
.child-empty { font-size: 10.5px; color: var(--text-3); }
.tool-files { display: flex; flex-wrap: wrap; gap: 5px; margin-top: 7px; }
.fchip { font-size: 10px; color: var(--text-2); background: var(--bg-inset); border: 1px solid var(--line); border-radius: 4px; padding: 2px 7px; max-width: 60vw; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

/* 步骤分隔线 */
.step-sep { display: flex; align-items: center; gap: 8px; padding: 5px 2px; font-size: 10px; color: var(--text-3); }
.step-sep i { flex: 1; height: 1px; background: var(--line); }

/* patch 卡 */
.patch-card { margin: 6px 2px; border: 1px solid var(--line); border-radius: 8px; background: var(--bg-panel); }
.patch-head { display: flex; align-items: center; gap: 8px; padding: 8px 10px; font-size: 11.5px; font-weight: 600; color: var(--text-1); }
.patch-head .car { margin-left: auto; font-size: 10px; color: var(--text-3); }
.patch-files { border-top: 1px dashed var(--line); }
.patch-file { display: flex; align-items: center; gap: 8px; padding: 6px 10px; font-size: 11px; }
.patch-file:active { background: var(--bg-inset); }
.patch-file .fname { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--text-1); }
.patch-file .add { color: var(--ok); font-family: var(--font-mono, monospace); font-size: 10px; }
.patch-file .del { color: var(--danger); font-family: var(--font-mono, monospace); font-size: 10px; }

/* 摘要 chip 族 */
.chip-line { display: flex; align-items: center; gap: 7px; margin: 4px 2px; font-size: 11px; color: var(--text-3); }
.chip-line .chip-dot { width: 5px; height: 5px; border-radius: 50%; background: var(--text-3); flex: none; }
.chip-line.retry { color: var(--warn); }
.chip-line.retry .chip-dot { background: var(--warn); }
.chip-line.compaction { color: var(--accent); }
.chip-line.compaction .chip-dot { background: var(--accent); }
.chip-line.error, .chip-line.subtask { color: var(--text-2); }

/* 审批卡 */
.perm-card { border: 1px solid color-mix(in srgb, var(--danger) 35%, transparent); background: color-mix(in srgb, var(--danger) 7%, var(--bg-panel)); border-radius: 10px; padding: 10px 12px; margin: 10px 0 6px; }
/* 提问卡（对齐 web 端 q-card）：选项按钮 + 自定义输入 + 逐题提交 */
.q-card { border: 1px solid color-mix(in srgb, var(--warn) 45%, transparent); background: color-mix(in srgb, var(--warn) 8%, var(--bg-panel)); border-radius: 10px; padding: 10px 12px; margin: 10px 0 6px; }
.q-card.flash { animation: qflash 1.6s ease-out; }
@keyframes qflash { 0%, 60% { box-shadow: 0 0 0 2px var(--warn); } 100% { box-shadow: 0 0 0 0 transparent; } }
.q-card .q-head { display: flex; align-items: center; gap: 8px; margin-bottom: 4px; }
.q-card .q-title { font-size: 12.5px; font-weight: 600; color: var(--warn); min-width: 0; }
.q-card .q-count { font-size: 11px; color: var(--text-3); flex: none; }
.q-card .q-sp { flex: 1; }
.q-card .q-err { font-size: 11px; color: var(--danger); }
.q-card .acts { display: flex; align-items: center; gap: 8px; margin-top: 9px; }
.q-card .acts button { padding: 7px 12px; border-radius: 7px; font-size: 12px; border: 1px solid var(--line-strong); background: none; color: var(--text-2); }
.q-card .acts button.p { border: none; background: var(--accent); color: var(--accent-text); }
.q-card .acts button:disabled { opacity: 0.6; }
/* 常驻入口条：提问卡滚出视野也能看到 */
.q-bar { display: flex; align-items: center; gap: 7px; border-top: 1px solid color-mix(in srgb, var(--warn) 45%, transparent); background: color-mix(in srgb, var(--warn) 12%, var(--bg-panel)); color: var(--warn); font-size: 12px; padding: 8px 12px; }
.q-bar .qb-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--warn); animation: qbarpulse 1.6s ease-in-out infinite; }
@keyframes qbarpulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.35; } }
.perm-card .l1 { font-size: 12px; font-weight: 600; color: var(--danger); }
.perm-title { font-size: 11px; color: var(--text-2); margin-top: 3px; }
.perm-card .cmd { margin-top: 6px; font-size: 11px; color: var(--text-1); background: var(--bg-inset); border: 1px solid var(--line); border-radius: 6px; padding: 7px 9px; max-height: 120px; overflow-y: auto; white-space: pre-wrap; word-break: break-all; }
.perm-card .cmd.meta { color: var(--text-3); max-height: 80px; }
.perm-card .acts { display: flex; gap: 8px; margin-top: 9px; }
.perm-card .acts button { flex: 1; padding: 7px 0; border-radius: 7px; font-size: 12px; border: 1px solid var(--line-strong); background: none; color: var(--text-2); }
.perm-card .acts button.p { border: none; background: var(--accent); color: var(--accent-text); }

.to-bottom { position: fixed; right: 14px; bottom: 148px; width: 34px; height: 34px; border-radius: 50%; background: var(--bg-panel); border: 1px solid var(--line-strong); color: var(--text-2); display: grid; place-items: center; box-shadow: var(--shadow-float, 0 2px 8px rgba(0,0,0,.2)); z-index: 10; }
.to-top { position: fixed; right: 14px; bottom: 190px; width: 34px; height: 34px; border-radius: 50%; background: var(--bg-panel); border: 1px solid var(--line-strong); color: var(--text-2); display: grid; place-items: center; box-shadow: var(--shadow-float, 0 2px 8px rgba(0,0,0,.2)); z-index: 10; }

/* busy 脉冲条 */
.busy-strip { display: flex; align-items: center; gap: 8px; padding: 7px 14px; font-size: 11.5px; color: var(--warn); background: color-mix(in srgb, var(--warn) 8%, transparent); border-top: 1px solid color-mix(in srgb, var(--warn) 22%, transparent); }
.busy-strip .pulse { width: 7px; height: 7px; border-radius: 50%; background: var(--warn); animation: livepulse 1.3s infinite; }
@keyframes livepulse { 0%,100% { opacity: 1; } 50% { opacity: .25; } }

/* PTY 卡片行 */
.pty-row { display: flex; align-items: center; gap: 7px; padding: 7px 12px; overflow-x: auto; scrollbar-width: none; border-top: 1px solid var(--line); background: var(--bg-panel); }
.pty-row::-webkit-scrollbar { display: none; }
.pty-lab { flex: none; font-size: 10px; color: var(--text-3); font-family: var(--font-mono, monospace); letter-spacing: .1em; }
.pty-chip { flex: none; font-size: 11px; color: var(--text-2); background: var(--bg-inset); border: 1px solid var(--line); border-radius: 6px; padding: 3px 9px; max-width: 60vw; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pty-chip b { font-weight: 400; color: var(--text-3); }
.pty-chip.running { color: var(--ok); border-color: color-mix(in srgb, var(--ok) 45%, transparent); }
.pty-chip.exited { opacity: .55; }

/* 输入栏 */
.composer { border-top: 1px solid var(--line); background: var(--bg-panel); padding: 8px 10px calc(10px + env(safe-area-inset-bottom)); }
.composer.readonly { color: var(--text-3); font-size: 11px; text-align: center; padding: 13px; }
.comp-row { display: flex; align-items: center; gap: 6px; padding-bottom: 6px; }
.comp-row .hint { flex: 1; min-width: 0; font-size: 10.5px; color: var(--text-3); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.comp-row .pill { flex: none; font-size: 10px; color: var(--text-2); border: 1px solid var(--line-strong); border-radius: 99px; padding: 2px 9px; max-width: 34vw; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.comp-row .pill:active { background: var(--bg-inset); }
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
.si { padding: 12px 6px; font-size: 13.5px; color: var(--text-1); border-bottom: 1px solid var(--line); display: flex; align-items: center; gap: 8px; }
.si:active { background: var(--bg-inset); }
.si.danger { color: var(--danger); }
.si.dis { opacity: .4; pointer-events: none; }
.si.cur { color: var(--accent); }
.si .si-nm { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.si .si-tg { flex: none; font-size: 10px; color: var(--text-3); max-width: 40vw; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
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

/* PTY 终端弹层 */
.pty-status { font-size: 11px; color: var(--text-3); padding-bottom: 8px; }
.pty-status.bad { color: var(--danger); }
.pty-out { flex: 1; min-height: 0; overflow-y: auto; font-family: var(--font-mono, monospace); font-size: 11px; line-height: 1.6; color: var(--text-1); background: var(--bg-inset); border: 1px solid var(--line); border-radius: 8px; padding: 8px 10px; white-space: pre-wrap; word-break: break-all; margin: 0; }
.pty-input-row { display: flex; gap: 8px; padding-top: 8px; }
.pty-input-row input { flex: 1; background: var(--bg-inset); border: 1px solid var(--line-strong); border-radius: 8px; padding: 8px 10px; font-size: 12px; color: var(--text-1); outline: none; }
.pty-input-row button { flex: none; border: none; border-radius: 8px; background: var(--accent); color: var(--accent-text); font-size: 12px; padding: 0 16px; }
.pty-input-row button:disabled { opacity: .5; }
</style>
