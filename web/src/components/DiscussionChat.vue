<template>
  <div class="disc-chat">
    <div class="chat-left">
      <div ref="wrapEl" class="stream" @scroll="onScroll">
        <div v-if="!rows.length" class="empty">
          还没有聊天内容——发一条消息试试。成员会像真实同事一样：谁有话说谁上，能动手就直接动手。
        </div>

        <template v-for="(row, i) in rows" :key="rowKey(row, i)">
          <div v-if="row.type === 'time'" class="time-divider">{{ row.label }}</div>

          <!-- 未读分隔线（滚离底部期间到达的新消息起点） -->
          <div v-else-if="row.type === 'unread'" class="unread-divider"><span>{{ newBelow > 0 ? `${newBelow} 条新消息` : '新消息' }}</span></div>

          <!-- 系统：普通小灰条 / notice 更淡 / card 居中卡片 -->
          <div v-else-if="row.type === 'sys'" class="sys-row">
            <!-- M5.2 ③：任务 ask_user 提问卡片——可在群里直接回答 -->
            <div v-if="row.m.kind === 'card' && row.m.meta?.bridge_ask" class="sys-card ask-card">
              <div class="ask-q">{{ row.m.text }}</div>
              <div v-if="!answeredAskIds.has(String(row.m.meta.bridge_ask.ask_id))" class="ask-row">
                <input
                  v-model="askDrafts[String(row.m.meta.bridge_ask.ask_id)]"
                  class="ask-input"
                  placeholder="在群里直接回答，agent 将立即继续…（可附图）"
                  @keydown.enter="sendAskAnswer(row.m.meta.bridge_ask)"
                />
                <AttachPicker v-model="askImgs[String(row.m.meta.bridge_ask.ask_id)]" />
                <el-button size="small" type="primary" :loading="answeringAsk === String(row.m.meta.bridge_ask.ask_id)" @click="sendAskAnswer(row.m.meta.bridge_ask)">回答</el-button>
              </div>
              <div v-else class="ask-done">✓ 已回答，agent 继续执行中</div>
            </div>
            <!-- 2026-09-15 转任务确认卡：agent 发起转任务先过用户拍板，确认才开工 -->
            <div v-else-if="row.m.kind === 'card' && row.m.meta?.convert_confirm" class="sys-card cv-card">
              <div class="cv-text">{{ row.m.text }}</div>
              <div v-if="String(row.m.meta.convert_confirm.state) === 'pending'" class="cv-row">
                <el-button size="small" type="primary" :loading="cvResolving === cvId(row)" @click="resolveConvert(row, 'confirm')">确认开干</el-button>
                <el-button size="small" :loading="cvResolving === cvId(row)" @click="resolveConvert(row, 'cancel')">暂不转</el-button>
              </div>
              <div v-else class="cv-done" :class="{ off: String(row.m.meta.convert_confirm.state) === 'cancelled' }">
                {{ String(row.m.meta.convert_confirm.state) === 'confirmed' ? `✓ 已确认开工${row.m.meta.convert_confirm.task_id ? `，任务 ${row.m.meta.convert_confirm.task_id}` : ''}` : '✕ 已取消，继续讨论' }}
              </div>
            </div>
            <div v-else-if="row.m.kind === 'card'" class="sys-card">{{ row.m.text }}</div>
            <span v-else-if="row.m.kind === 'notice'" class="sys-notice">{{ row.m.text }}</span>
            <span v-else class="sys-text">{{ row.m.text }}</span>
          </div>

          <!-- 工具活动行（P1-2 工作流条目）：折叠摘要，点开看工具树（meta.calls） -->
          <div v-else-if="row.type === 'tool'" class="tool-block" :class="{ open: expandedTools.has(row.m.id) }">
            <button class="tool-head mono" @click="toggleTool(row.m.id)">
              <span class="tool-caret">{{ expandedTools.has(row.m.id) ? '▾' : '▸' }}</span>
              <span class="tool-agent" :style="{ color: agentColor(row.m.from) }">{{ roleOf(row.m.from) }}</span>
              <span class="tool-text">{{ row.m.text }}</span>
              <span class="tool-hint">工具调用</span>
            </button>
            <div v-if="expandedTools.has(row.m.id)" class="tool-tree">
              <div v-for="(rec, ci) in toolCallsOf(row.m)" :key="ci" class="tool-call">
                <div class="tc-line mono">
                  <span class="tc-icon">{{ toolIcon(rec.tool) }}</span>
                  <span class="tc-name">{{ rec.mcp ? `mcp:${rec.mcp.server}.${rec.mcp.tool}` : rec.tool }}</span>
                  <span v-if="rec.args_summary" class="tc-args">{{ rec.args_summary }}</span>
                  <span class="tc-status" :class="{ bad: rec.ok === false }">{{ rec.ok === false ? '✗' : '✓' }}</span>
                </div>
                <div v-if="rec.output_gist" class="tc-gist mono">{{ rec.output_gist }}</div>
              </div>
            </div>
          </div>

          <!-- 通栏工作流条目（用户 / agent；左缘色条标识，无气泡） -->
          <div v-else class="wf-row" :class="{ me: row.side === 'me' }">
            <div class="wf-bar" :style="{ background: row.side === 'me' ? undefined : agentColor(row.m.from) }"></div>
            <div class="wf-col">
              <div class="wf-head">
                <span class="wf-role" :style="{ color: row.side === 'me' ? 'var(--ct-accent)' : agentColor(row.m.from) }">{{ roleOf(row.m.from) }}</span>
                <span v-if="row.side === 'them'" class="wf-id mono">{{ row.m.from }}</span>
                <span v-if="row.m.model" class="wf-model mono" :title="'模型：' + row.m.model">{{ row.m.model }}</span>
                <span v-if="row.m.needs_user" class="ask-tag" :class="{ answered: row.answered }">{{ row.answered ? '@你 已回复' : '@你 待拍板' }}</span>
                <span class="wf-ts mono">{{ fmtHM(row.m.ts) }}</span>
                <span class="wf-actions">
                  <button v-if="row.side === 'them' && hasDetail(row.m)" class="wf-btn wf-detail-btn" @click="openDetail(row.m)">详细</button>
                  <button class="wf-btn" title="回应 👍" @click="onReact(row.m, '👍')">👍</button>
                  <button class="wf-btn" title="引用回复" @click="startReply(row.m)">↩</button>
                  <button class="wf-btn" title="复制" @click="copyText(row.m.text)">⧉</button>
                </span>
              </div>
              <div class="wf-body">
                <div v-if="row.quote" class="quote-bar mono" :title="row.quote.text">↩ {{ row.quote.who }}：{{ row.quote.text }}</div>
                <!-- 用户附图：图片网格（点击大图预览） -->
                <div v-if="rowImgUrls(row.m).length" class="img-grid">
                  <el-image
                    v-for="(u, i) in rowImgUrls(row.m)"
                    :key="u"
                    :src="u"
                    :preview-src-list="rowImgUrls(row.m)"
                    :initial-index="i"
                    fit="cover"
                    loading="lazy"
                    class="img-cell"
                  />
                </div>
                <div v-if="row.m.text" class="wf-text md" v-html="md(row.m.text)"></div>
              </div>
              <!-- emoji 回应聚合 -->
              <div v-if="hasReactions(row.m)" class="reactions">
                <button
                  v-for="(users, emo) in row.m.reactions"
                  :key="emo"
                  class="react-chip"
                  :class="{ mine: users.includes('user') }"
                  @click="onReact(row.m, String(emo))"
                >{{ emo }} <span>{{ users.length }}</span></button>
              </div>
            </div>
          </div>
        </template>

        <!-- 实时工具树（进行中的成员：每批工具调用完成后实时出现） -->
        <div v-for="(lt, agent) in visibleLiveTools" :key="`lt-${agent}`" class="wf-row live">
          <div class="wf-bar" :style="{ background: agentColor(String(agent)) }"></div>
          <div class="wf-col">
            <div class="wf-head">
              <span class="wf-live-dot"></span>
              <span class="wf-role" :style="{ color: agentColor(String(agent)) }">{{ roleOf(String(agent)) }}</span>
              <span class="wf-id mono">{{ agent }}</span>
              <span class="wf-live-label">正在动手…</span>
            </div>
            <div class="tool-tree live-tree">
              <div v-for="(rec, ci) in liveRecords(lt)" :key="ci" class="tool-call">
                <div class="tc-line mono">
                  <span class="tc-icon">{{ toolIcon(rec.tool) }}</span>
                  <span class="tc-name">{{ rec.mcp ? `mcp:${rec.mcp.server}.${rec.mcp.tool}` : rec.tool }}</span>
                  <span v-if="rec.args_summary" class="tc-args">{{ rec.args_summary }}</span>
                  <span class="tc-status" :class="{ bad: rec.ok === false }">{{ rec.ok === false ? '✗' : '✓' }}</span>
                </div>
                <div v-if="rec.output_gist" class="tc-gist mono">{{ rec.output_gist }}</div>
              </div>
            </div>
          </div>
        </div>

        <!-- 流式发言（未定稿的实时内容，通栏） -->
        <div v-for="(s, sid) in streams" :key="sid" class="wf-row live">
          <div class="wf-bar" :style="{ background: agentColor(s.agent) }"></div>
          <div class="wf-col">
            <div class="wf-head">
              <span class="wf-live-dot"></span>
              <span class="wf-role" :style="{ color: agentColor(s.agent) }">{{ roleOf(s.agent) }}</span>
              <span class="wf-id mono">{{ s.agent }}</span>
              <span class="wf-live-label">正在输入…</span>
            </div>
            <div class="wf-body"><span class="wf-text">{{ s.text }}</span><span class="caret"></span></div>
          </div>
        </div>

        <!-- 路由器决策中 -->
        <div v-if="thinking === 'router' && !anyStreaming && !anyLiveTools" class="router-hint mono">
          <span class="dot-t"></span><span class="dot-t"></span><span class="dot-t"></span> 正在看消息，决定谁来回复…
        </div>

        <!-- 并行活动状态行（统一工作流视图：多成员同时动手/输入一眼可见） -->
        <div v-else-if="activeMembers.length && !anyLiveTools" class="parallel-line mono">
          <span v-for="(a, i) in activeMembers" :key="a" class="pl-chip">
            <span class="pl-dot" :style="{ background: agentColor(a) }"></span>
            {{ a }} {{ activityLabel(a) }}<span v-if="i < activeMembers.length - 1" class="pl-sep">·</span>
          </span>
        </div>
      </div>

      <!-- 新消息胶囊（滚离底部时出现） -->
      <transition name="fade">
        <button v-if="!stick && newBelow > 0" class="new-pill mono" @click="scrollToBottom(true)">↓ {{ newBelow }} 条新消息</button>
      </transition>

      <div v-if="pendingUser" class="pending-bar">有成员提出了需要你拍板的问题，回复一条消息即可继续</div>

      <!-- 开干确认横条：方案就绪，等你拍板（P1-2） -->
      <div v-if="pendingConvert" class="go-bar">
        <span class="go-text">⚙️ 方案已就绪，等你拍板开工</span>
        <span class="go-ops">
          <el-button size="small" type="primary" :loading="cvResolving === String(pendingConvert.meta?.convert_confirm?.id || '')" @click="resolveConvert({ m: pendingConvert }, 'confirm')">确认开干</el-button>
          <el-button size="small" :loading="cvResolving === String(pendingConvert.meta?.convert_confirm?.id || '')" @click="resolveConvert({ m: pendingConvert }, 'cancel')">暂不转</el-button>
        </span>
      </div>

      <div class="input-zone">
        <div v-if="replyTo" class="reply-bar mono">
          <span>↩ 回复「{{ replyPreview }}」</span>
          <button class="rb-x" @click="replyTo = null">×</button>
        </div>
        <div class="chips-row" v-if="members.length">
          <span class="chip-label mono">@点名（只唤被点名者）：</span>
          <button v-for="m in members" :key="m" class="mention-chip mono" @click="insertMention(m)">@{{ m }}</button>
        </div>
        <el-input
          ref="inputEl"
          v-model="draft"
          type="textarea"
          :rows="2"
          resize="none"
          :placeholder="converted ? '本群聊已转任务——输入消息将重新开启群聊，继续沟通或再转新任务' : busy ? '成员正在处理——插话会在成员完成当前步后优先回应你' : '像群里聊天一样说：可 @成员、可让它动手（如：@launcher 把服务跑起来）、可发图、可打断'"
          @keydown.enter.exact.prevent="sendNow"
        />
        <div class="op-row">
          <el-radio-group v-model="mode" size="small" @change="onModeChange">
            <el-radio-button value="manual">手动</el-radio-button>
            <el-radio-button value="auto">自动</el-radio-button>
          </el-radio-group>
          <span class="mode-hint mono">{{ mode === 'auto' ? '自动：一条消息驱动多轮，直到成员收敛或你插话' : '手动：你一句它一句，插话即刻受理' }}</span>
          <div class="ops">
            <AttachPicker v-model="pendingImages" :disabled="sending" @preview="onPreview" />
            <el-button v-if="busy" size="small" type="warning" plain @click="stop">打断并停止</el-button>
            <el-button v-else size="small" @click="moreRound">让成员继续</el-button>
            <el-button size="small" type="primary" :loading="sending" :disabled="(!draft.trim() && !pendingImages.length)" @click="sendNow">{{ busy ? '插话' : '发送' }}</el-button>
          </div>
        </div>
      </div>
    </div>

    <!-- 右侧详情面板（P1-2）：解决思路 / 工具调用 / SKILL / 协作 -->
    <aside v-if="detailMsg" class="detail-panel">
      <div class="dp-head">
        <span class="dp-title">
          <span class="wf-role" :style="{ color: detailMsg.from === 'user' ? 'var(--ct-accent)' : agentColor(detailMsg.from) }">{{ roleOf(detailMsg.from) }}</span>
          <span v-if="detailMsg.from !== 'user'" class="wf-id mono">{{ detailMsg.from }}</span>
        </span>
        <button class="rb-x" @click="detailMsg = null">×</button>
      </div>
      <div class="dp-body">
        <template v-if="detailData">
          <!-- 💡 解决思路 -->
          <section v-if="detailData.evidence" class="dp-sec">
            <div class="dp-sec-title">💡 解决思路</div>
            <div class="dp-sec-body">{{ detailData.evidence }}</div>
          </section>
          <!-- 📂 看了哪些代码 -->
          <section v-if="groupedCalls.code.length" class="dp-sec">
            <div class="dp-sec-title">📂 看了哪些代码（{{ groupedCalls.code.length }}）</div>
            <div v-for="(rec, i) in groupedCalls.code" :key="`c${i}`" class="dp-call mono">
              <div class="dp-call-line">
                <span class="tc-icon">{{ toolIcon(rec.tool) }}</span>
                <span class="tc-name">{{ rec.tool }}</span>
                <span class="tc-status" :class="{ bad: rec.ok === false }">{{ rec.ok === false ? '✗' : '✓' }}</span>
              </div>
              <div v-if="rec.args_summary" class="dp-call-args">{{ rec.args_summary }}</div>
              <div v-if="rec.output_gist" class="dp-call-gist">{{ rec.output_gist }}</div>
            </div>
          </section>
          <!-- ⚙ 命令与验证 -->
          <section v-if="groupedCalls.cmd.length" class="dp-sec">
            <div class="dp-sec-title">⚙ 执行了什么命令（{{ groupedCalls.cmd.length }}）</div>
            <div v-for="(rec, i) in groupedCalls.cmd" :key="`x${i}`" class="dp-call mono">
              <div class="dp-call-line">
                <span class="tc-icon">{{ toolIcon(rec.tool) }}</span>
                <span class="tc-name">{{ rec.tool }}</span>
                <span class="tc-status" :class="{ bad: rec.ok === false }">{{ rec.ok === false ? '✗' : '✓' }}</span>
              </div>
              <div v-if="rec.args_summary" class="dp-call-args">{{ rec.args_summary }}</div>
              <div v-if="rec.output_gist" class="dp-call-gist">{{ rec.output_gist }}</div>
            </div>
          </section>
          <!-- 🔌 MCP -->
          <section v-if="groupedCalls.mcp.length" class="dp-sec">
            <div class="dp-sec-title">🔌 MCP 调用（{{ groupedCalls.mcp.length }}）</div>
            <div v-for="(rec, i) in groupedCalls.mcp" :key="`m${i}`" class="dp-call mono">
              <div class="dp-call-line">
                <span class="tc-icon">🔌</span>
                <span class="tc-name">{{ rec.mcp ? `${rec.mcp.server}.${rec.mcp.tool}` : rec.tool }}</span>
                <span class="tc-status" :class="{ bad: rec.ok === false }">{{ rec.ok === false ? '✗' : '✓' }}</span>
              </div>
              <div v-if="rec.args_summary" class="dp-call-args">{{ rec.args_summary }}</div>
              <div v-if="rec.output_gist" class="dp-call-gist">{{ rec.output_gist }}</div>
            </div>
          </section>
          <!-- 📄 文档/沉淀 -->
          <section v-if="groupedCalls.doc.length" class="dp-sec">
            <div class="dp-sec-title">📄 文档与沉淀（{{ groupedCalls.doc.length }}）</div>
            <div v-for="(rec, i) in groupedCalls.doc" :key="`d${i}`" class="dp-call mono">
              <div class="dp-call-line">
                <span class="tc-icon">{{ toolIcon(rec.tool) }}</span>
                <span class="tc-name">{{ rec.tool }}</span>
                <span class="tc-status" :class="{ bad: rec.ok === false }">{{ rec.ok === false ? '✗' : '✓' }}</span>
              </div>
              <div v-if="rec.args_summary" class="dp-call-args">{{ rec.args_summary }}</div>
            </div>
          </section>
          <!-- 🧩 SKILL -->
          <section v-if="detailData.skills?.length" class="dp-sec">
            <div class="dp-sec-title">🧩 绑定的 SKILL</div>
            <div class="dp-chips">
              <span v-for="s in detailData.skills" :key="s" class="dp-chip mono">{{ s }}</span>
            </div>
          </section>
          <!-- 🤝 协作 -->
          <section v-if="detailData.mentioned?.length" class="dp-sec">
            <div class="dp-sec-title">🤝 协作</div>
            <div class="dp-chips">
              <span v-for="a in detailData.mentioned" :key="a" class="dp-chip mono">@{{ a }}（{{ roleOf(a) }}）</span>
            </div>
          </section>
          <div class="dp-model mono">模型：{{ detailData.model }} · 第 {{ detailData.round }} 轮</div>
        </template>
        <div v-else class="dp-empty mono">这条消息还没有工作明细</div>
      </div>
    </aside>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue';
import { ElMessage, ElImageViewer } from 'element-plus';
import { renderMarkdown } from '../utils/md';
import type { DiscussionMessage } from '../api';
import { api } from '../api';
import { useDiscussion } from '../composables/useDiscussion';
import { agentColor } from '../utils/agentColor';
import AttachPicker from './AttachPicker.vue';

const emit = defineEmits<{ (e: 'member-info', agent: string): void }>();

// M5.2 ③：群内直接回答任务的 ask_user 提问
const answeredAskIds = ref<Set<string>>(new Set());
const askDrafts = ref<Record<string, string>>({});
/** ask 回答的待发附图（ask_id -> dataURL 数组），随 answerAsk 提交 */
const askImgs = ref<Record<string, { name: string; dataUrl: string }[]>>({});
const answeringAsk = ref('');
async function sendAskAnswer(bridge: { task_id: string; ask_id: string }) {
  const text = (askDrafts.value[bridge.ask_id] || '').trim();
  const imgs = askImgs.value[bridge.ask_id] || [];
  if ((!text && !imgs.length) || answeringAsk.value) return;
  answeringAsk.value = bridge.ask_id;
  try {
    await api.answerAsk(bridge.task_id, bridge.ask_id, text, imgs.length ? imgs : undefined);
    answeredAskIds.value = new Set([...answeredAskIds.value, bridge.ask_id]);
    askDrafts.value[bridge.ask_id] = '';
    askImgs.value[bridge.ask_id] = [];
    ElMessage.success('已回答，agent 将继续执行');
  } catch (e: any) {
    ElMessage.error(e?.message || '回答失败');
  } finally {
    answeringAsk.value = '';
  }
}

const { current, busy, thinking, activity, streams, liveTools, memberActivity, send, react, round, stop, setMode, roles } = useDiscussion();
const mode = computed(() => (current.value?.mode as string) || 'manual');

// ---------- 转任务确认卡（agent 发起 → 用户拍板） ----------
const cvResolving = ref('');
const cvId = (row: { m?: DiscussionMessage }) => String(((row.m?.meta as any)?.convert_confirm?.id || ''));

/** 开干确认横条：最新一张待拍板的转任务确认卡（P1-2 §5.4） */
const pendingConvert = computed<DiscussionMessage | null>(() => {
  const msgs = current.value?.messages || [];
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i];
    if ((m.meta as any)?.convert_confirm && String((m.meta as any).convert_confirm.state) === 'pending') return m;
  }
  return null;
});

async function resolveConvert(row: { m?: DiscussionMessage }, action: 'confirm' | 'cancel') {
  const confirmId = cvId(row);
  if (!confirmId || !current.value || cvResolving.value) return;
  cvResolving.value = confirmId;
  try {
    const r = await api.resolveDiscussionConvert(current.value.id, confirmId, action);
    if (action === 'confirm') ElMessage.success(r.task_id ? `已确认，任务 ${r.task_id} 已创建并开工` : '已确认，任务已创建并开工');
    else ElMessage.info('已取消转任务，继续讨论');
    // 卡片状态与讨论状态经 discussion_convert_resolved 事件回写（store 内统一处理）
  } catch (e: any) {
    ElMessage.error(String(e?.message || e));
  } finally {
    cvResolving.value = '';
  }
}

const members = computed(() => current.value?.members || []);
const converted = computed(() => (current.value?.status || 'discussing') === 'converted');
const pendingUser = computed(() => !!current.value?.pending_user);
const anyStreaming = computed(() => Object.keys(streams).length > 0);
const anyLiveTools = computed(() => Object.keys(visibleLiveTools.value).length > 0);
const draft = ref('');
const wrapEl = ref<HTMLElement | null>(null);
const inputEl = ref<{ focus: () => void } | null>(null);
let stickToBottom = true;
const stick = ref(true);
const newBelow = ref(0);
const unreadStartId = ref<string | null>(null);
const replyTo = ref<string | null>(null);

/** 正在活动的成员（并行状态行）：memberActivity 非空 + 流式中的成员 */
const activeMembers = computed<string[]>(() => {
  const set = new Set<string>();
  for (const [a, act] of Object.entries(memberActivity)) if (act) set.add(a);
  for (const s of Object.values(streams)) if (s.agent) set.add(s.agent);
  if (thinking.value && thinking.value !== 'router') set.add(thinking.value);
  return [...set];
});

function activityLabel(agent: string): string {
  const act = memberActivity[agent] || (thinking.value === agent ? activity.value : '');
  if (act === 'tool') return '正在动手…';
  if (act === 'tool_followup') return '正在看执行结果…';
  return '正在输入…';
}

function agentStreaming(agent: string): boolean {
  return Object.values(streams).some((s) => s.agent === agent);
}

function roleOf(name: string): string {
  if (name === 'user') return '我';
  return roles.value[name] || name;
}

// ---------- 行模型：分组 / 系统 / 工具 / 时间 / 未读 ----------
type ChatRow = { type: 'chat'; m: DiscussionMessage; side: 'me' | 'them'; head: boolean; tail: boolean; answered?: boolean; quote?: { who: string; text: string } };
type Row =
  | { type: 'time'; label: string }
  | { type: 'unread' }
  | { type: 'sys'; m: DiscussionMessage }
  | { type: 'tool'; m: DiscussionMessage }
  | ChatRow;

const GROUP_GAP_MS = 3 * 60 * 1000;
const TIME_GAP_MS = 10 * 60 * 1000;

const rows = computed<Row[]>(() => {
  const msgs = current.value?.messages || [];
  const lastUserIdx = msgs.map((m) => m.from).lastIndexOf('user');
  const byId = new Map(msgs.map((m) => [m.id, m]));
  const tsOf = (m: DiscussionMessage) => (m.ts ? new Date(m.ts.replace(' ', 'T')).getTime() : 0);

  const out: Row[] = [];
  let lastTs = 0;
  let prevChat: ChatRow | null = null;
  let pendingUnread = !!unreadStartId.value && msgs.some((m) => m.id === unreadStartId.value);

  for (let i = 0; i < msgs.length; i++) {
    const m = msgs[i];
    const ts = tsOf(m);
    if (ts - lastTs > TIME_GAP_MS) { out.push({ type: 'time', label: fmtFull(m.ts) }); prevChat = null; }
    lastTs = ts || lastTs;
    if (pendingUnread && m.id === unreadStartId.value) { out.push({ type: 'unread' }); pendingUnread = false; }
    if (m.from === 'system') { out.push({ type: 'sys', m }); prevChat = null; continue; }
    if (m.tool) { out.push({ type: 'tool', m }); continue; } // 工具行不打断分组节奏

    const side: 'me' | 'them' = m.from === 'user' ? 'me' : 'them';
    const head = !prevChat || prevChat.m.from !== m.from || ts - tsOf(prevChat.m) > GROUP_GAP_MS;
    const row: ChatRow = {
      type: 'chat', m, side, head, tail: false,
      answered: !!m.needs_user && lastUserIdx > i,
      quote: m.reply_to ? quoteOf(byId.get(m.reply_to)) : undefined,
    };
    if (prevChat) prevChat.tail = !head; // 上一组到此为止 → 上一条是组尾
    out.push(row);
    prevChat = row;
  }
  if (prevChat) prevChat.tail = true;
  return out;
});

function quoteOf(src?: DiscussionMessage) {
  if (!src) return undefined;
  return { who: src.from === 'user' ? '我' : roleOf(src.from), text: src.text.slice(0, 60) };
}

function rowKey(row: Row, i: number): string {
  if (row.type === 'time') return `t${i}${row.label}`;
  if (row.type === 'unread') return 'unread';
  return `${row.type}:${row.m.id}`;
}

function hasReactions(m: DiscussionMessage): boolean {
  return !!m.reactions && Object.keys(m.reactions).length > 0;
}

// ---------- 工具明细（P1-2） ----------
const expandedTools = ref<Set<string>>(new Set());
function toggleTool(id: string) {
  const next = new Set(expandedTools.value);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  expandedTools.value = next;
}
function toolCallsOf(m: DiscussionMessage): any[] {
  const calls = (m.meta as any)?.calls;
  return Array.isArray(calls) ? calls : [];
}
function toolIcon(tool: string): string {
  if (tool.startsWith('mcp__')) return '🔌';
  if (/^read_file|^read$|^read_dir|^readdir|^list_files|^list$|^ls$|^grep|^search|^git_log|^git_diff/.test(tool)) return '📂';
  if (/^exec|^exec_command|^run_command|^exec_background|^start_process|^kill_process|^check_page|^screenshot|^look_image/.test(tool)) return '⚙';
  if (/^write_knowledge|^write_doc/.test(tool)) return '📄';
  if (/^convert_to_project|^convert_task/.test(tool)) return '🚀';
  return '🔧';
}

/** 实时工具批次：只显示当前讨论绑定成员的进行中批次（round end 后由 useDiscussion 清空） */
const visibleLiveTools = computed(() => {
  const out: Record<string, { agent: string; calls: any[]; results: any[]; ts: number }> = {};
  for (const [agent, lt] of Object.entries(liveTools)) {
    if (lt?.agent) out[agent] = lt;
  }
  return out;
});

/** 实时批次 → 记录形态（与 meta.calls 同构，含完整输出要点） */
function liveRecords(lt: { agent: string; calls: any[]; results: any[] }): any[] {
  const out: any[] = [];
  const calls = Array.isArray(lt.calls) ? lt.calls : [];
  const results = Array.isArray(lt.results) ? lt.results : [];
  for (let i = 0; i < calls.length; i++) {
    const c = calls[i] || {};
    const r: any = results[i] || {};
    const name = String(c.tool || '?');
    const rec: any = { tool: name, ok: r.ok !== false };
    if (name.startsWith('mcp__')) {
      const rest = name.slice('mcp__'.length);
      const sep = rest.indexOf('__');
      rec.mcp = { server: sep > 0 ? rest.slice(0, sep) : '', tool: sep > 0 ? rest.slice(sep + 2) : name };
    }
    const argParts: string[] = [];
    for (const k of ['command', 'path', 'pattern', 'url', 'pid']) {
      if (c[k] !== undefined && c[k] !== null && String(c[k]).trim()) argParts.push(String(c[k]).slice(0, 120));
    }
    rec.args_summary = argParts.join(' ') || undefined;
    let gist = '';
    if (r.returncode !== undefined) {
      gist = `exit ${r.returncode}${r.stdout ? ' · ' + String(r.stdout).trim().slice(-160) : ''}${!r.stdout && r.stderr ? ' · ' + String(r.stderr).trim().slice(-160) : ''}`;
    } else if (r.error) {
      gist = `✗ ${String(r.error).slice(0, 200)}`;
    } else if (Array.isArray(r.matches)) {
      gist = `命中 ${r.matches.length} 处${r.matches[0] ? ` · ${r.matches[0].file}:${r.matches[0].line}` : ''}`;
    } else if (r.total_lines !== undefined) {
      gist = `${r.total_lines} 行`;
    } else if (Array.isArray(r.entries)) {
      gist = `${r.entries.length} 项`;
    } else if (r.output) {
      gist = String(r.output).slice(0, 280);
    } else if (r.content) {
      gist = String(r.content).slice(0, 200);
    }
    rec.output_gist = gist || undefined;
    out.push(rec);
  }
  return out;
}

// ---------- 右侧详情面板（P1-2） ----------
const CODE_TOOLS = /^(read_file|read|read_dir|readdir|list_files|list|ls|grep|search|git_log|git_diff)$/;
const CMD_TOOLS = /^(exec|exec_command|run_command|exec_background|start_process|kill_process|check_page|screenshot|look_image)$/;
const DOC_TOOLS = /^(write_knowledge|write_doc)$/;
const detailMsg = ref<DiscussionMessage | null>(null);

function hasDetail(m: DiscussionMessage): boolean {
  const meta: any = m.meta || {};
  return !!(meta.detail?.tool_calls?.length || meta.detail?.evidence || meta.detail?.skills?.length || meta.detail?.mentioned?.length || meta.calls?.length);
}
function openDetail(m: DiscussionMessage) {
  detailMsg.value = m;
}
const detailData = computed(() => {
  const m = detailMsg.value;
  if (!m) return null;
  const meta: any = m.meta || {};
  return meta.detail || (meta.calls?.length ? { agent: m.from, round: m.round || 0, tool_calls: meta.calls, skills: [], mentioned: [], model: m.model || '' } : null);
});
const groupedCalls = computed(() => {
  const calls: any[] = detailData.value?.tool_calls || [];
  const code: any[] = [];
  const cmd: any[] = [];
  const mcp: any[] = [];
  const doc: any[] = [];
  for (const rec of calls) {
    if (rec.mcp || String(rec.tool).startsWith('mcp__')) mcp.push(rec);
    else if (CODE_TOOLS.test(rec.tool)) code.push(rec);
    else if (CMD_TOOLS.test(rec.tool)) cmd.push(rec);
    else if (DOC_TOOLS.test(rec.tool)) doc.push(rec);
    else cmd.push(rec);
  }
  return { code, cmd, mcp, doc };
});

function fmtHM(ts: string): string {
  if (!ts) return '';
  const d = new Date(ts.replace(' ', 'T'));
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function fmtFull(ts: string): string {
  if (!ts) return '';
  const d = new Date(ts.replace(' ', 'T'));
  const hm = fmtHM(ts);
  if (d.toDateString() === new Date().toDateString()) return hm;
  return `${d.getMonth() + 1}月${d.getDate()}日 ${hm}`;
}

/** 共享渲染 + @点名高亮：只作用于纯文本段，不再误伤代码块内容与标签属性 */
function md(text: string): string {
  if (!text) return '';
  const html = renderMarkdown(text);
  return html.split(/(<pre[\s\S]*?<\/pre>|<code[\s\S]*?<\/code>|<[^>]*>)/g)
    .map((part) => (part.startsWith('<') ? part : part.replace(/@([A-Za-z0-9_\-\u4e00-\u9fff]+)/g, '<span class="mention">@$1</span>')))
    .join('');
}

// ---------- 交互 ----------
// 待发附图 + 发送中标记（视觉描述在服务端生成，等待数秒属正常）
const pendingImages = ref<{ name: string; dataUrl: string }[]>([]);
const sending = ref(false);
function rowImgUrls(m: DiscussionMessage): string[] {
  const imgs = (m.meta as any)?.images;
  return Array.isArray(imgs) ? imgs.map((i: any) => String(i.url || '')).filter(Boolean) : [];
}
function onPreview(url: string) {
  // 缩略图点击放大：待发预览无 el-image 组件，手工挂一个 viewer
  const div = document.createElement('div');
  div.innerHTML = '';
  const app = new (ElImageViewer as any)({ propsData: { urlList: [url], onClose: () => (app as any).$el.remove() } });
  app.$mount();
  document.body.appendChild(app.$el);
}
async function sendNow() {
  const text = draft.value.trim();
  if (!text && !pendingImages.value.length) return;
  if (sending.value) return;
  sending.value = true;
  try {
    await send(text, {
      ...(replyTo.value ? { reply_to: replyTo.value } : {}),
      images: pendingImages.value.length ? pendingImages.value : undefined,
    } as Parameters<typeof send>[1]);
    draft.value = '';
    pendingImages.value = [];
    replyTo.value = null;
    await nextTick();
    scrollToBottom(true);
  } catch (e: any) {
    ElMessage.error(String(e?.message || e));
  } finally {
    sending.value = false;
  }
}

async function moreRound() {
  await round();
}

async function onReact(m: DiscussionMessage, emoji: string) {
  if (m.reactions?.[emoji]?.includes('user')) return;
  await react(m.id, emoji).catch(() => undefined);
}

function startReply(m: DiscussionMessage) {
  replyTo.value = m.id;
  void nextTick(() => inputEl.value?.focus());
}

const replyPreview = computed(() => {
  const src = (current.value?.messages || []).find((x) => x.id === replyTo.value);
  return src ? `${roleOf(src.from)}：${src.text.slice(0, 40)}` : '';
});

function copyText(text: string) {
  void navigator.clipboard?.writeText(text).then(
    () => ElMessage.success('已复制'),
    () => undefined
  );
}

async function onModeChange(v: any) {
  await setMode(v === 'auto' ? 'auto' : 'manual');
  ElMessage.success(v === 'auto' ? '已切到自动模式：一条消息驱动多轮' : '已切到手动模式');
}

function insertMention(name: string) {
  draft.value = (draft.value + (draft.value && !draft.value.endsWith(' ') ? ' ' : '') + `@${name} `).slice(0, 4000);
  void nextTick(() => inputEl.value?.focus());
}

// ---------- 滚动 / 未读 ----------
function onScroll() {
  const el = wrapEl.value;
  if (!el) return;
  stickToBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  stick.value = stickToBottom;
  if (stickToBottom) {
    newBelow.value = 0;
    if (unreadStartId.value) {
      const msgs = current.value?.messages || [];
      const idx = msgs.findIndex((m) => m.id === unreadStartId.value);
      if (idx < 0 || msgs.length - idx <= 2) unreadStartId.value = null;
    }
  }
}

function scrollToBottom(force = false) {
  const el = wrapEl.value;
  if (!el || (!force && !stickToBottom)) return;
  el.scrollTop = el.scrollHeight;
  newBelow.value = 0;
}

watch(
  () => current.value?.messages.length ?? 0,
  (len, old) => {
    if (typeof old === 'number' && len > old && !stickToBottom) newBelow.value += len - old;
    void nextTick(() => scrollToBottom());
  }
);

watch(
  () => Object.keys(streams).length + Object.keys(visibleLiveTools.value).length,
  () => void nextTick(() => scrollToBottom())
);

watch(() => [thinking.value, activity.value] as const, () => void nextTick(() => scrollToBottom()));

// 切换讨论：重置未读锚点（打开时最后一条之后到达的都算新）
watch(() => current.value?.id, (id) => {
  if (!id) return;
  const msgs = current.value?.messages || [];
  unreadStartId.value = msgs.length ? msgs[msgs.length - 1].id : null;
  replyTo.value = null;
  detailMsg.value = null;
  stickToBottom = true;
  void nextTick(() => scrollToBottom(true));
});
</script>

<style scoped>
.disc-chat { display: flex; height: 100%; min-height: 0; background: var(--ct-bg); position: relative; }
.chat-left { flex: 1; display: flex; flex-direction: column; min-width: 0; position: relative; }
.stream { flex: 1; display: flex; flex-direction: column; gap: 2px; padding: 12px 10px; overflow-y: auto; }
.empty { color: var(--ct-text3); text-align: center; padding: 48px 24px; font-size: 12px; line-height: 2; }

.time-divider { text-align: center; font-size: 10px; color: var(--ct-text3); margin: 10px 0 6px; opacity: 0.85; }

.unread-divider { display: flex; align-items: center; gap: 8px; margin: 8px 0; color: #e5484d; font-size: 10px; }
.unread-divider::before, .unread-divider::after { content: ''; flex: 1; height: 1px; background: rgba(229, 72, 77, 0.35); }

/* ---------- 系统形态 ---------- */
.sys-row { display: flex; justify-content: center; margin: 4px 0; }
.sys-text { font-size: 11px; color: var(--ct-text3); background: var(--ct-panel2); border-radius: 10px; padding: 3px 12px; max-width: 85%; text-align: center; }
.sys-notice { font-size: 10px; color: var(--ct-text3); font-style: italic; opacity: 0.8; }
.sys-card { font-size: 12px; color: var(--ct-text); background: var(--ct-panel); border: 1px solid var(--ct-border2); border-radius: 10px; padding: 8px 16px; max-width: 80%; text-align: center; box-shadow: 0 1px 4px rgba(0, 0, 0, 0.04); }
/* M5.2 ③ ask 提问卡片 */
.ask-card { text-align: left; max-width: 86%; border-color: var(--ct-orange, #fa8c16); }
.ask-q { margin-bottom: 8px; white-space: pre-wrap; }
.ask-row { display: flex; gap: 6px; align-items: center; }
.ask-input { flex: 1; min-width: 0; background: var(--ct-panel2); border: 1px solid var(--ct-border); border-radius: 4px; color: var(--ct-text); font-size: 12px; padding: 5px 8px; outline: none; }
.ask-input:focus { border-color: var(--ct-accent); }
.ask-done { font-size: 11px; color: var(--ct-green); margin-top: 4px; }
/* 转任务确认卡 */
.cv-card { text-align: left; max-width: 86%; border-color: var(--ct-accent); }
.cv-text { white-space: pre-wrap; margin-bottom: 8px; }
.cv-row { display: flex; gap: 6px; }
.cv-done { font-size: 11px; color: var(--ct-green); margin-top: 4px; }
.cv-done.off { color: var(--ct-text3); }

/* ---------- 工具活动块（P1-2 工作流条目） ---------- */
.tool-block { margin: 2px 0; }
.tool-head { display: flex; align-items: center; gap: 6px; border: none; background: none; cursor: pointer; padding: 2px 4px 2px 8px; width: 100%; text-align: left; }
.tool-caret { font-size: 9px; color: var(--ct-text3); width: 10px; }
.tool-agent { font-size: 10px; font-weight: 600; flex-shrink: 0; }
.tool-text { font-size: 10px; color: var(--ct-text3); background: var(--ct-panel2); border-radius: 6px; padding: 2px 8px; flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.tool-hint { font-size: 9px; color: var(--ct-text3); opacity: 0.7; flex-shrink: 0; }
.tool-tree { margin: 2px 0 4px 18px; display: flex; flex-direction: column; gap: 3px; border-left: 2px solid var(--ct-border); padding-left: 8px; }
.tool-call { display: flex; flex-direction: column; gap: 1px; }
.tc-line { display: flex; align-items: baseline; gap: 6px; font-size: 11px; flex-wrap: wrap; }
.tc-icon { font-size: 10px; }
.tc-name { color: var(--ct-text); font-weight: 600; }
.tc-args { color: var(--ct-text2, var(--ct-text)); opacity: 0.85; word-break: break-all; }
.tc-status { font-size: 10px; color: var(--ct-green); }
.tc-status.bad { color: #e5484d; }
.tc-gist { font-size: 10px; color: var(--ct-text3); padding-left: 18px; word-break: break-all; }
.live-tree { margin-left: 8px; }

/* ---------- 通栏工作流条目（P1-2） ---------- */
.wf-row { display: flex; gap: 8px; margin: 6px 0; padding: 6px 8px 6px 0; border-radius: 8px; position: relative; }
.wf-row:hover { background: var(--ct-panel2); }
.wf-row.me { background: var(--ct-panel2); }
.wf-row.live { background: rgba(0, 0, 0, 0.02); }
html.dark .wf-row.live { background: rgba(255, 255, 255, 0.03); }
.wf-bar { width: 3px; border-radius: 2px; flex-shrink: 0; align-self: stretch; }
.wf-row.me .wf-bar { background: var(--ct-accent); }
.wf-col { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 3px; }

.wf-head { display: flex; align-items: baseline; gap: 6px; flex-wrap: wrap; }
.wf-role { font-size: 12px; font-weight: 600; }
.wf-id { font-size: 10px; color: var(--ct-text3); }
.wf-model { font-size: 9px; color: var(--ct-text3); background: var(--ct-panel); border: 1px solid var(--ct-border2); border-radius: 3px; padding: 0 4px; max-width: 140px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.wf-ts { font-size: 9px; color: var(--ct-text3); margin-left: auto; }
.wf-actions { display: flex; gap: 2px; opacity: 0; transition: opacity 0.15s; }
.wf-row:hover .wf-actions { opacity: 1; }
.wf-btn { border: 1px solid var(--ct-border); background: var(--ct-panel); border-radius: 6px; font-size: 10px; padding: 1px 6px; cursor: pointer; color: var(--ct-text3); }
.wf-btn:hover { color: var(--ct-text); border-color: var(--ct-border2); }
.wf-detail-btn { color: var(--ct-accent); border-color: var(--ct-accent); }

.wf-live-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--ct-accent); animation: pulse 1.1s infinite; align-self: center; }
@keyframes pulse { 50% { opacity: 0.3; } }
.wf-live-label { font-size: 10px; color: var(--ct-accent); }

.wf-body { font-size: 13px; line-height: 1.65; min-width: 0; }
.wf-text { word-break: break-word; color: var(--ct-text); }

.quote-bar { font-size: 10px; opacity: 0.75; border-left: 2px solid currentColor; padding: 2px 0 2px 6px; margin-bottom: 4px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 100%; }

.reactions { display: flex; gap: 4px; margin: 2px 0 0; flex-wrap: wrap; }
.react-chip { font-size: 11px; background: var(--ct-panel); border: 1px solid var(--ct-border); border-radius: 10px; padding: 0 7px; cursor: pointer; color: var(--ct-text); }
.react-chip.mine { border-color: var(--ct-accent); background: var(--ct-panel2); }

.ask-tag { font-size: 10px; color: #fff; background: var(--ct-accent); border-radius: 4px; padding: 1px 6px; }
.ask-tag.answered { background: var(--ct-text3); }

/* 用户附图：图片网格（最多 3 张，一张撑满两列宽） */
.img-grid { display: grid; grid-template-columns: repeat(2, 120px); gap: 6px; margin: 2px 0 6px; }
.img-grid .img-cell { width: 120px; height: 120px; border-radius: 8px; cursor: zoom-in; }
.img-grid .img-cell:first-child:last-child, .img-grid .img-cell:only-child { grid-column: span 2; width: 240px; height: 200px; }

.wf-text :deep(p) { margin: 0 0 6px; }
.wf-text :deep(p:last-child) { margin-bottom: 0; }
.wf-text :deep(code) { font-family: var(--ct-mono); font-size: 11px; background: var(--ct-panel); border: 1px solid var(--ct-border); border-radius: 3px; padding: 0 4px; }
.wf-text :deep(ul), .wf-text :deep(ol) { margin: 4px 0; padding-left: 18px; }
.wf-text :deep(strong) { font-weight: 600; }
.wf-text :deep(.mention) { color: var(--ct-accent); background: var(--ct-panel); border-radius: 3px; padding: 0 3px; font-weight: 600; }

/* ---------- 并行活动状态行 ---------- */
.parallel-line { align-self: flex-start; display: flex; gap: 10px; flex-wrap: wrap; margin: 6px 0 6px 11px; font-size: 10px; color: var(--ct-text3); }
.pl-chip { display: inline-flex; align-items: center; gap: 4px; }
.pl-dot { width: 6px; height: 6px; border-radius: 50%; animation: pulse 1.1s infinite; }
.pl-sep { opacity: 0.5; margin-left: 8px; }

/* ---------- 流式/路由状态 ---------- */
.caret { display: inline-block; width: 2px; height: 14px; background: var(--ct-accent); margin-left: 2px; vertical-align: text-bottom; animation: blink 0.9s step-end infinite; }
@keyframes blink { 50% { opacity: 0; } }
.router-hint { align-self: center; font-size: 11px; color: var(--ct-text3); display: flex; align-items: center; gap: 4px; margin: 8px 0; }
.dot-t { width: 5px; height: 5px; border-radius: 50%; background: var(--ct-text3); animation: bob 1.2s infinite; }
.dot-t:nth-child(2) { animation-delay: 0.15s; }
.dot-t:nth-child(3) { animation-delay: 0.3s; }
@keyframes bob { 0%, 60%, 100% { transform: translateY(0); opacity: 0.4; } 30% { transform: translateY(-4px); opacity: 1; } }

/* ---------- 新消息胶囊 ---------- */
.new-pill { position: absolute; right: 16px; bottom: 150px; z-index: 5; border: 1px solid var(--ct-border2); background: var(--ct-panel); color: var(--ct-accent); border-radius: 14px; font-size: 11px; padding: 4px 12px; cursor: pointer; box-shadow: 0 2px 10px rgba(0, 0, 0, 0.12); }
.fade-enter-active, .fade-leave-active { transition: opacity 0.18s; }
.fade-enter-from, .fade-leave-to { opacity: 0; }

.pending-bar { margin: 0 10px 6px; font-size: 11px; color: var(--ct-accent); border: 1px dashed var(--ct-accent); border-radius: 8px; padding: 5px 10px; }

/* ---------- 开干确认横条（P1-2） ---------- */
.go-bar { margin: 0 10px 6px; display: flex; align-items: center; justify-content: space-between; gap: 8px; font-size: 12px; color: var(--ct-text); background: var(--ct-panel); border: 1px solid var(--ct-accent); border-radius: 8px; padding: 6px 10px; box-shadow: 0 1px 6px rgba(0, 0, 0, 0.06); }
.go-text { font-weight: 600; }
.go-ops { display: flex; gap: 6px; }

/* ---------- 输入区 ---------- */
.input-zone { border-top: 1px solid var(--ct-border); background: var(--ct-panel); padding: 8px; display: flex; flex-direction: column; gap: 6px; }
.reply-bar { display: flex; align-items: center; justify-content: space-between; gap: 8px; font-size: 11px; color: var(--ct-text3); background: var(--ct-bg); border: 1px solid var(--ct-border); border-radius: 8px; padding: 4px 8px; }
.rb-x { border: none; background: none; color: var(--ct-text3); font-size: 14px; cursor: pointer; }
.chips-row { display: flex; flex-wrap: wrap; align-items: center; gap: 4px; }
.chip-label { font-size: 10px; color: var(--ct-text3); }
.mention-chip { font-size: 11px; color: var(--ct-accent); background: var(--ct-bg); border: 1px solid var(--ct-border2); border-radius: 10px; padding: 1px 8px; cursor: pointer; }
.mention-chip:hover:not(:disabled) { border-color: var(--ct-accent); }
.mention-chip:disabled { opacity: 0.4; cursor: default; }
.op-row { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.mode-hint { font-size: 10px; color: var(--ct-text3); }
.ops { margin-left: auto; display: flex; gap: 6px; flex-wrap: wrap; }

/* ---------- 右侧详情面板（P1-2） ---------- */
.detail-panel { width: 340px; flex-shrink: 0; border-left: 1px solid var(--ct-border); background: var(--ct-panel); display: flex; flex-direction: column; min-height: 0; }
.dp-head { display: flex; align-items: center; justify-content: space-between; padding: 10px 12px; border-bottom: 1px solid var(--ct-border); }
.dp-title { display: flex; align-items: baseline; gap: 6px; }
.dp-body { flex: 1; overflow-y: auto; padding: 10px 12px; display: flex; flex-direction: column; gap: 12px; }
.dp-empty { font-size: 11px; color: var(--ct-text3); text-align: center; padding: 24px 0; }
.dp-sec { display: flex; flex-direction: column; gap: 4px; }
.dp-sec-title { font-size: 11px; font-weight: 600; color: var(--ct-text2, var(--ct-text)); }
.dp-sec-body { font-size: 12px; color: var(--ct-text); line-height: 1.6; white-space: pre-wrap; word-break: break-word; background: var(--ct-bg); border: 1px solid var(--ct-border); border-radius: 6px; padding: 6px 8px; }
.dp-call { display: flex; flex-direction: column; gap: 2px; background: var(--ct-bg); border: 1px solid var(--ct-border); border-radius: 6px; padding: 5px 8px; margin-bottom: 4px; }
.dp-call-line { display: flex; align-items: baseline; gap: 6px; font-size: 11px; }
.dp-call-args { font-size: 10px; color: var(--ct-text2, var(--ct-text)); opacity: 0.85; word-break: break-all; }
.dp-call-gist { font-size: 10px; color: var(--ct-text3); word-break: break-all; }
.dp-chips { display: flex; flex-wrap: wrap; gap: 4px; }
.dp-chip { font-size: 10px; color: var(--ct-accent); background: var(--ct-bg); border: 1px solid var(--ct-border2); border-radius: 8px; padding: 1px 8px; }
.dp-model { font-size: 9px; color: var(--ct-text3); }
.mono { font-family: var(--ct-mono); }
</style>
