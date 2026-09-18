<template>
  <div class="disc-chat">
    <div class="chat-left">
      <div ref="wrapEl" class="stream-wrap" @scroll="onScroll">
        <div v-if="!rows.length" class="empty">
          还没有聊天内容——发一条消息试试。成员会像真实同事一样：谁有话说谁上，能动手就直接动手。
        </div>

        <div class="stream">
          <template v-for="(row, i) in rows" :key="rowKey(row, i)">
            <!-- 时间分隔（两侧发丝线居中） -->
            <div v-if="row.type === 'time'" class="sysline"><span class="mono">{{ row.label }}</span></div>

            <!-- 未读分隔线（滚离底部期间到达的新消息起点） -->
            <div v-else-if="row.type === 'unread'" class="unread-divider"><span>{{ newBelow > 0 ? `${newBelow} 条新消息` : '新消息' }}</span></div>

            <!-- 系统：ask 问答卡 / 转任务确认卡 / notice / 普通系统行 -->
            <div v-else-if="row.type === 'sys'" class="sys-row">
              <!-- M5.2 ③：任务 ask_user 提问卡片——可在群里直接回答 -->
              <div v-if="row.m.kind === 'card' && row.m.meta?.bridge_ask" class="askcard">
                <div class="q">需要你拍板</div>
                <div class="hint">{{ row.m.text }}</div>
                <div v-if="!answeredAskIds.has(String(row.m.meta.bridge_ask.ask_id))" class="row">
                  <input
                    v-model="askDrafts[String(row.m.meta.bridge_ask.ask_id)]"
                    class="ask-input"
                    placeholder="在群里直接回答，agent 将立即继续…（可附图）"
                    @keydown.enter="sendAskAnswer(row.m.meta.bridge_ask)"
                  />
                  <AttachPicker v-model="askImgs[String(row.m.meta.bridge_ask.ask_id)]" />
                  <el-button size="small" type="primary" :loading="answeringAsk === String(row.m.meta.bridge_ask.ask_id)" @click="sendAskAnswer(row.m.meta.bridge_ask)">回答</el-button>
                </div>
                <div v-else class="done-line ok">✓ 已回答，agent 继续执行中</div>
              </div>
              <!-- 2026-09-15 转任务确认卡：agent 发起转任务先过用户拍板，确认才开工 -->
              <div v-else-if="row.m.kind === 'card' && row.m.meta?.convert_confirm" class="askcard cv-card">
                <div class="q">转任务确认</div>
                <div class="hint cv-text">{{ row.m.text }}</div>
                <div v-if="String(row.m.meta.convert_confirm.state) === 'pending'" class="row">
                  <el-button size="small" type="primary" :loading="cvResolving === cvId(row)" @click="resolveConvert(row, 'confirm')">确认开干</el-button>
                  <el-button size="small" :loading="cvResolving === cvId(row)" @click="resolveConvert(row, 'cancel')">暂不转</el-button>
                </div>
                <div v-else class="done-line" :class="String(row.m.meta.convert_confirm.state) === 'confirmed' ? 'ok' : ''">
                  {{ String(row.m.meta.convert_confirm.state) === 'confirmed' ? `✓ 已确认开工${row.m.meta.convert_confirm.task_id ? `，任务 ${row.m.meta.convert_confirm.task_id}` : ''}` : '✕ 已取消，继续讨论' }}
                </div>
              </div>
              <div v-else-if="row.m.kind === 'card'" class="sys-card">{{ row.m.text }}</div>
              <div v-else-if="row.m.kind === 'notice'" class="notice"><span class="ic">⚙</span><span>{{ row.m.text }}</span></div>
              <div v-else class="sysline"><span>{{ row.m.text }}</span></div>
            </div>

            <!-- 工具活动行（P1-2 工作流条目）：tooltree 折叠摘要，点开看工具树（meta.calls） -->
            <div v-else-if="row.type === 'tool'" class="msg tool-msg">
              <div class="msg-avatar"></div>
              <div class="msg-col">
                <div class="tooltree" :class="{ open: expandedTools.has(row.m.id) }">
                  <button class="tt-head" @click="toggleTool(row.m.id)">
                    <span class="tt-caret">{{ expandedTools.has(row.m.id) ? '▾' : '▸' }}</span>
                    <span class="tt-dot" :class="toolFailCount(row.m) ? 'err' : 'ok'"></span>
                    <span class="tt-agent" :style="{ color: agentColor(row.m.from) }">{{ roleOf(row.m.from) }}</span>
                    <span class="tt-text">{{ row.m.text }}</span>
                    <span class="tt-meta mono">
                      <template v-if="toolFailCount(row.m)"><b class="tt-fail">{{ toolFailCount(row.m) }} 失败</b> · </template>工具调用<template v-if="toolCallsOf(row.m).length"> × {{ toolCallsOf(row.m).length }}</template>
                    </span>
                  </button>
                  <div v-if="expandedTools.has(row.m.id)" class="tt-body">
                    <div v-for="(rec, ci) in toolCallsOf(row.m)" :key="ci" class="tcall">
                      <div class="tcall-line">
                        <span class="sym mono">▸</span>
                        <span class="path mono">{{ rec.mcp ? `mcp:${rec.mcp.server}.${rec.mcp.tool}` : rec.tool }}</span>
                        <span v-if="rec.args_summary" class="args mono">{{ rec.args_summary }}</span>
                        <span class="st mono" :class="{ bad: rec.ok === false }">{{ rec.ok === false ? '✗ 失败' : '✓ ok' }}</span>
                      </div>
                      <div v-if="rec.output_gist" class="gist mono">{{ rec.output_gist }}</div>
                      <!-- P2-8 小改：diff 落流 + 一键回滚 -->
                      <div v-if="rec.diff" class="tc-diff mono">{{ rec.diff }}</div>
                      <button v-if="rec.undo_id && !undoingMsg.has(row.m.id)" class="tc-undo" @click="undoWrites(row.m)">↩ 回滚此改动</button>
                      <span v-else-if="rec.undo_id" class="done-line ok">✓ 已回滚</span>
                    </div>
                  </div>
                </div>
              </div>
            </div>

            <!-- 消息行：avatar 列 + 内容列（分组后续行 avatar 列留白） -->
            <div v-else class="msg" :class="{ user: row.side === 'me' }">
              <div class="msg-avatar">
                <div v-if="row.head && row.side === 'me'" class="avatar-user">我</div>
                <AgentAvatar v-else-if="row.head" :name="row.m.from" :size="26" />
              </div>
              <div class="msg-col">
                <div v-if="row.head" class="msg-head">
                  <span class="who" :style="{ color: row.side === 'me' ? 'var(--accent)' : agentColor(row.m.from) }">{{ roleOf(row.m.from) }}</span>
                  <span v-if="row.side === 'them'" class="aid mono">{{ row.m.from }}</span>
                  <span v-if="row.m.model" class="model mono" :title="'模型：' + row.m.model">{{ row.m.model }}</span>
                  <span v-if="row.m.needs_user" class="ask-tag" :class="{ answered: row.answered }">{{ row.answered ? '@你 已回复' : '@你 待拍板' }}</span>
                  <span class="ts mono">{{ fmtHM(row.m.ts) }}</span>
                  <span class="msg-actions">
                    <button v-if="row.side === 'them' && hasDetail(row.m)" class="msg-btn detail-btn" @click="openDetail(row.m)">详细</button>
                    <button class="msg-btn" title="回应 👍" @click="onReact(row.m, '👍')">👍</button>
                    <button class="msg-btn" title="引用回复" @click="startReply(row.m)">↩</button>
                    <button class="msg-btn" title="复制" @click="copyText(row.m.text)">⧉</button>
                  </span>
                </div>
                <div class="msg-body">
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
                  >{{ emo }} <span class="mono">{{ users.length }}</span></button>
                </div>
              </div>
            </div>
          </template>

          <!-- 实时工具树（进行中的成员：每批工具调用完成后实时出现） -->
          <div v-for="(lt, agent) in visibleLiveTools" :key="`lt-${agent}`" class="msg">
            <div class="msg-avatar">
              <AgentAvatar :name="String(agent)" :size="26" />
            </div>
            <div class="msg-col">
              <div class="msg-head">
                <span class="live-dot"></span>
                <span class="who" :style="{ color: agentColor(String(agent)) }">{{ roleOf(String(agent)) }}</span>
                <span class="aid mono">{{ agent }}</span>
                <span class="live-label">正在动手执行</span><span class="mono live-eta">{{ liveEta((lt as any).ts) }}</span>
              </div>
              <div class="tooltree open live-tree">
                <div class="tt-body">
                  <div v-for="(rec, ci) in liveRecords(lt)" :key="ci" class="tcall">
                    <div class="tcall-line">
                      <span class="sym mono">▸</span>
                      <span class="path mono">{{ rec.mcp ? `mcp:${rec.mcp.server}.${rec.mcp.tool}` : rec.tool }}</span>
                      <span v-if="rec.args_summary" class="args mono">{{ rec.args_summary }}</span>
                      <span class="st mono" :class="{ bad: rec.ok === false }">{{ rec.ok === false ? '✗ 失败' : '✓ ok' }}</span>
                    </div>
                    <div v-if="rec.output_gist" class="gist mono">{{ rec.output_gist }}</div>
                  </div>
                </div>
              </div>
            </div>
          </div>

          <!-- 流式发言（未定稿的实时内容） -->
          <div v-for="(s, sid) in streams" :key="sid" class="msg">
            <div class="msg-avatar">
              <AgentAvatar :name="s.agent" :size="26" />
            </div>
            <div class="msg-col">
              <div class="msg-head">
                <span class="live-dot"></span>
                <span class="who" :style="{ color: agentColor(s.agent) }">{{ roleOf(s.agent) }}</span>
                <span class="aid mono">{{ s.agent }}</span>
                <span class="live-label">正在输入…</span>
              </div>
              <div class="msg-body"><span class="wf-text dim">{{ s.text }}</span><span class="caret"></span></div>
            </div>
          </div>

          <!-- 路由器决策中 -->
          <div v-if="thinking === 'router' && !anyStreaming && !anyLiveTools" class="router-hint">
            <span class="dot-t"></span><span class="dot-t"></span><span class="dot-t"></span> 正在看消息，决定谁来回复…
          </div>

          <!-- 并行活动状态行（统一工作流视图：多成员同时动手/输入一眼可见） -->
          <div v-else-if="activeMembers.length && !anyLiveTools" class="parallel-line">
            <span v-for="(a, i) in activeMembers" :key="a" class="pl-chip">
              <span class="pl-dot" :style="{ background: agentColor(a) }"></span>
              {{ a }} {{ activityLabel(a) }}<span v-if="i < activeMembers.length - 1" class="pl-sep">·</span>
            </span>
          </div>
        </div>
      </div>

      <!-- 新消息胶囊（滚离底部时出现） -->
      <transition name="fade">
        <button v-if="!stick && newBelow > 0" class="new-pill mono" @click="scrollToBottom(true)">↓ {{ newBelow }} 条新消息</button>
      </transition>

      <!-- 详情面板收起时的重新展开钮（IDE inspector 形态） -->
      <button v-if="!detailOpen" class="detail-open-btn" title="展开消息明细面板" @click="detailOpen = true">‹ 明细</button>

      <div v-if="pendingUser" class="pending-bar">有成员提出了需要你拍板的问题，回复一条消息即可继续</div>

      <!-- 开干确认横条：方案就绪，等你拍板（P1-2） -->
      <div v-if="pendingConvert" class="go-bar">
        <span class="go-text">⚙ 方案已就绪，等你拍板开工</span>
        <span class="go-ops">
          <el-button size="small" type="primary" :loading="cvResolving === String(pendingConvert.meta?.convert_confirm?.id || '')" @click="resolveConvert({ m: pendingConvert }, 'confirm')">确认开干</el-button>
          <el-button size="small" :loading="cvResolving === String(pendingConvert.meta?.convert_confirm?.id || '')" @click="resolveConvert({ m: pendingConvert }, 'cancel')">暂不转</el-button>
        </span>
      </div>

      <div class="input-zone">
        <div class="input-inner">
          <div v-if="replyTo" class="quote-reply">
            <span class="bar author" :style="{ background: replyAuthorColor }"></span>
            <span class="quote-text">回复「{{ replyPreview }}」</span>
            <button class="rb-x" @click="replyTo = null">✕</button>
          </div>
          <div class="mentions" v-if="members.length">
            <span class="chip-label">@点名（只唤被点名者）</span>
            <button v-for="m in members" :key="m" class="mention-chip" @click="insertMention(m)">
              <span class="pl-dot" :style="{ background: agentColor(m) }"></span>@{{ m }}
            </button>
          </div>
          <div class="inputrow">
            <el-input
              ref="inputEl"
              v-model="draft"
              type="textarea"
              :rows="2"
              resize="none"
              :placeholder="converted ? '本群聊已转任务——输入消息将重新开启群聊，继续沟通或再转新任务' : busy ? '成员正在处理——插话会在成员完成当前步后优先回应你' : '回复讨论… Enter 发送 / Shift+Enter 换行 / @ 点名成员 / 可让它动手、可发图'"
              @keydown.enter.exact.prevent="sendNow"
            />
            <div class="input-side">
              <el-radio-group v-model="mode" size="small" class="mode-seg" @change="onModeChange">
                <el-radio-button value="manual">手动</el-radio-button>
                <el-radio-button value="auto">自动</el-radio-button>
              </el-radio-group>
              <div class="under">
                <AttachPicker v-model="pendingImages" :disabled="sending" @preview="onPreview" />
                <el-button v-if="busy" size="small" type="warning" plain @click="stop">打断并停止</el-button>
                <el-button v-else size="small" @click="moreRound">让成员继续</el-button>
                <el-button size="small" type="primary" :loading="sending" :disabled="(!draft.trim() && !pendingImages.length)" @click="sendNow">{{ busy ? '插话' : '发送' }}</el-button>
              </div>
            </div>
          </div>
          <div class="mode-hint">{{ mode === 'auto' ? '自动：一条消息驱动多轮，直到成员收敛或你插话' : '手动：你一句它一句，插话即刻受理' }}</div>
        </div>
      </div>
    </div>

    <!-- 右侧详情面板（P1-2，改版：常驻可收的 IDE inspector） -->
    <aside v-show="detailOpen" class="detail-panel">
      <div class="dp-head">
        <span class="dp-title">消息明细</span>
        <span v-if="detailMsg" class="dp-sub mono">
          <template v-if="detailMsg.from !== 'user'">{{ detailMsg.from }} · </template>{{ fmtHM(detailMsg.ts) }}
        </span>
        <button class="dp-collapse" title="收起面板" @click="detailOpen = false">»</button>
      </div>
      <div class="dp-body">
        <template v-if="detailMsg">
          <template v-if="detailData">
            <!-- 解决思路 -->
            <section v-if="detailData.evidence" class="dsec">
              <div class="dtitle">解决思路</div>
              <p class="dp-sec-body">{{ detailData.evidence }}</p>
            </section>
            <!-- 看了哪些代码 -->
            <section v-if="groupedCalls.code.length" class="dsec">
              <div class="dtitle">看过哪些代码 · {{ groupedCalls.code.length }}</div>
              <div v-for="(rec, i) in groupedCalls.code" :key="`c${i}`" class="fitem-block mono">
                <div class="fitem-line">
                  <span class="fi-name">{{ rec.tool }}</span>
                  <span class="fi-status mono" :class="{ bad: rec.ok === false }">{{ rec.ok === false ? '✗' : '✓' }}</span>
                </div>
                <div v-if="rec.args_summary" class="fi-args">{{ rec.args_summary }}</div>
                <div v-if="rec.output_gist" class="fi-gist">{{ rec.output_gist }}</div>
              </div>
            </section>
            <!-- 命令与验证 -->
            <section v-if="groupedCalls.cmd.length" class="dsec">
              <div class="dtitle">执行了什么命令 · {{ groupedCalls.cmd.length }}</div>
              <div v-for="(rec, i) in groupedCalls.cmd" :key="`x${i}`" class="fitem-block mono">
                <div class="fitem-line">
                  <span class="fi-name">{{ rec.tool }}</span>
                  <span class="fi-status mono" :class="{ bad: rec.ok === false }">{{ rec.ok === false ? '✗' : '✓' }}</span>
                </div>
                <div v-if="rec.args_summary" class="fi-args">{{ rec.args_summary }}</div>
                <div v-if="rec.output_gist" class="fi-gist">{{ rec.output_gist }}</div>
              </div>
            </section>
            <!-- MCP -->
            <section v-if="groupedCalls.mcp.length" class="dsec">
              <div class="dtitle">MCP 调用 · {{ groupedCalls.mcp.length }}</div>
              <div v-for="(rec, i) in groupedCalls.mcp" :key="`m${i}`" class="fitem-block mono">
                <div class="fitem-line">
                  <span class="fi-name">{{ rec.mcp ? `${rec.mcp.server}.${rec.mcp.tool}` : rec.tool }}</span>
                  <span class="fi-status mono" :class="{ bad: rec.ok === false }">{{ rec.ok === false ? '✗' : '✓' }}</span>
                </div>
                <div v-if="rec.args_summary" class="fi-args">{{ rec.args_summary }}</div>
                <div v-if="rec.output_gist" class="fi-gist">{{ rec.output_gist }}</div>
              </div>
            </section>
            <!-- 文档/沉淀 -->
            <section v-if="groupedCalls.doc.length" class="dsec">
              <div class="dtitle">文档与沉淀 · {{ groupedCalls.doc.length }}</div>
              <div v-for="(rec, i) in groupedCalls.doc" :key="`d${i}`" class="fitem-block mono">
                <div class="fitem-line">
                  <span class="fi-name">{{ rec.tool }}</span>
                </div>
                <div v-if="rec.args_summary" class="fi-args">{{ rec.args_summary }}</div>
              </div>
            </section>
            <!-- SKILL -->
            <section v-if="detailData.skills?.length" class="dsec">
              <div class="dtitle">绑定的 SKILL</div>
              <div class="chips">
                <span v-for="s in detailData.skills" :key="s" class="chip mono">{{ s }}</span>
              </div>
            </section>
            <!-- 协作 -->
            <section v-if="detailData.mentioned?.length" class="dsec">
              <div class="dtitle">协作</div>
              <div class="chips">
                <span v-for="a in detailData.mentioned" :key="a" class="chip mono">@{{ a }}（{{ roleOf(a) }}）</span>
              </div>
            </section>
            <div class="dp-model mono">模型：{{ detailData.model }} · 第 {{ detailData.round }} 轮</div>
          </template>
          <div v-else class="dp-empty">这条消息还没有工作明细</div>
        </template>
        <div v-else class="dp-empty">选中消息上的「详细」<br />在这里看它的工作明细：<br />解决思路 / 看过哪些代码 / 命令 / SKILL / 协作</div>
      </div>
    </aside>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, ref, watch, watchEffect } from 'vue';
import { ElMessage, ElImageViewer } from 'element-plus';
import { renderMarkdown } from '../utils/md';
import type { DiscussionMessage } from '../api';
import { api } from '../api';
import { useDiscussion } from '../composables/useDiscussion';
import { agentColor } from '../utils/agentColor';
import AttachPicker from './AttachPicker.vue';
import AgentAvatar from './AgentAvatar.vue';

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
  if (act === 'queued') return '排队中…';
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

// ---------- P2-8 小改回滚 ----------
const undoingMsg = ref<Set<string>>(new Set());
async function undoWrites(m: DiscussionMessage) {
  const ids = toolCallsOf(m).map((c: any) => c.undo_id).filter(Boolean);
  if (!ids.length || !current.value || undoingMsg.value.has(m.id)) return;
  undoingMsg.value = new Set([...undoingMsg.value, m.id]);
  try {
    const r = await api.undoDiscussionWrites(current.value.id, ids);
    ElMessage.success(r.reverted.length ? `已回滚 ${r.reverted.length} 个文件` : '没有需要回滚的改动');
  } catch (e: any) {
    ElMessage.error(String(e?.message || e));
    undoingMsg.value = new Set([...undoingMsg.value].filter((x) => x !== m.id));
  }
}
/** 本批工具失败数（头行红点/失败计数用） */
function toolFailCount(m: DiscussionMessage): number {
  return toolCallsOf(m).filter((c: any) => c.ok === false).length;
}


/** 实时工具批次：只显示当前讨论绑定成员的进行中批次（round end 后由 useDiscussion 清空） */
const visibleLiveTools = computed(() => {
  const out: Record<string, { agent: string; calls: any[]; results: any[]; ts: number }> = {};
  for (const [agent, lt] of Object.entries(liveTools)) {
    if (lt?.agent) out[agent] = lt;
  }
  return out;
});

/** 实时批次已用秒数（1s tick，仅存在活跃批次时有意义） */
const nowTick = ref(Date.now());
let tickTimer: ReturnType<typeof setInterval> | null = null;
watchEffect((onCleanup) => {
  const active = Object.keys(visibleLiveTools.value).length > 0 || Object.keys(streams).length > 0;
  if (active && !tickTimer) tickTimer = setInterval(() => { nowTick.value = Date.now(); }, 1000);
  if (!active && tickTimer) { clearInterval(tickTimer); tickTimer = null; }
  onCleanup(() => { if (tickTimer) { clearInterval(tickTimer); tickTimer = null; } });
});
function liveEta(ts: number): string {
  const sec = Math.max(0, Math.round((nowTick.value - ts) / 1000));
  return sec < 60 ? `${sec}s` : `${Math.floor(sec / 60)}m${String(sec % 60).padStart(2, '0')}s`;
}

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

// ---------- 右侧详情面板（P1-2；改版后常驻可收） ----------
const CODE_TOOLS = /^(read_file|read|read_dir|readdir|list_files|list|ls|grep|search|git_log|git_diff)$/;
const CMD_TOOLS = /^(exec|exec_command|run_command|exec_background|start_process|kill_process|check_page|screenshot|look_image)$/;
const DOC_TOOLS = /^(write_knowledge|write_doc)$/;
const detailMsg = ref<DiscussionMessage | null>(null);
const detailOpen = ref(true);

function hasDetail(m: DiscussionMessage): boolean {
  const meta: any = m.meta || {};
  return !!(meta.detail?.tool_calls?.length || meta.detail?.evidence || meta.detail?.skills?.length || meta.detail?.mentioned?.length || meta.calls?.length);
}
function openDetail(m: DiscussionMessage) {
  detailMsg.value = m;
  detailOpen.value = true;
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

const replyAuthorColor = computed(() => {
  const src = (current.value?.messages || []).find((x) => x.id === replyTo.value);
  return src ? agentColor(src.from) : '';
});

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
.disc-chat { display: flex; height: 100%; min-height: 0; background: var(--bg-page); position: relative; }
.chat-left { flex: 1; display: flex; flex-direction: column; min-width: 0; position: relative; }
.stream-wrap { flex: 1; overflow-y: auto; }
.stream { max-width: var(--measure); margin: 0 auto; padding: 18px 24px 12px; display: flex; flex-direction: column; gap: 2px; }
.empty { color: var(--text-3); text-align: center; padding: 48px 24px; font-size: var(--fs-aux); line-height: 2; }

/* ---------- 消息行：avatar 列 + 内容列 ---------- */
.msg { display: grid; grid-template-columns: 30px 1fr; gap: 0 12px; padding: 7px 0; border-radius: 6px; }
.msg:hover { background: color-mix(in srgb, var(--bg-raised) 55%, transparent); }
.msg.user { background: linear-gradient(90deg, var(--accent-soft), transparent 70%); border-radius: 8px; }
.msg-avatar { width: 30px; }
.avatar-user {
  width: 26px; height: 26px; border-radius: 8px; display: grid; place-items: center;
  background: var(--accent); color: var(--accent-text);
  font-family: var(--font-mono); font-size: var(--fs-meta); font-weight: 700;
}
.msg-col { min-width: 0; display: flex; flex-direction: column; gap: 3px; }

.msg-head { display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap; }
.msg-head .who { font-size: 13px; font-weight: 700; }
.msg-head .aid { font-size: var(--fs-meta); color: var(--text-3); }
.msg-head .model {
  font-size: var(--fs-meta); font-family: var(--font-mono); color: var(--text-3);
  border: 1px solid var(--line); border-radius: 4px; padding: 0 5px; height: 16px; line-height: 15px;
  max-width: 140px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.ts { margin-left: auto; font-size: var(--fs-meta); color: var(--text-3); opacity: 0; transition: opacity .15s; }
.msg:hover .ts { opacity: 1; }
.msg-actions { display: flex; gap: 2px; opacity: 0; transition: opacity 0.15s; }
.msg:hover .msg-actions { opacity: 1; }
.msg-btn {
  border: 1px solid var(--line); background: var(--bg-panel); border-radius: var(--r-ctl);
  font-size: var(--fs-meta); padding: 1px 6px; cursor: pointer; color: var(--text-3); line-height: 1.4;
}
.msg-btn:hover { color: var(--text-1); border-color: var(--line-strong); }
.msg-btn.detail-btn { color: var(--accent); border-color: var(--accent-line); }

.ask-tag { font-size: var(--fs-meta); color: var(--accent); background: var(--accent-soft); border: 1px solid var(--accent-line); border-radius: 4px; padding: 0 6px; }
.ask-tag.answered { color: var(--ok); background: color-mix(in srgb, var(--ok) 10%, transparent); border-color: color-mix(in srgb, var(--ok) 25%, transparent); }

.msg-body { font-size: var(--fs-body); line-height: 1.62; color: var(--text-1); min-width: 0; }
.wf-text { word-break: break-word; }
.wf-text.dim { color: var(--text-2); }

.quote-bar { font-size: var(--fs-aux); color: var(--text-3); border-left: 2px solid var(--line-strong); padding: 2px 0 2px 8px; margin-bottom: 4px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 100%; }

.reactions { display: flex; gap: 4px; margin: 2px 0 0; flex-wrap: wrap; }
.react-chip { font-size: var(--fs-aux); background: var(--bg-raised); border: 1px solid var(--line); border-radius: 10px; padding: 0 7px; cursor: pointer; color: var(--text-2); }
.react-chip.mine { border-color: var(--accent-line); background: var(--accent-soft); color: var(--accent); }

/* 用户附图：图片网格（最多 3 张，一张撑满两列宽） */
.img-grid { display: grid; grid-template-columns: repeat(2, 120px); gap: 6px; margin: 2px 0 6px; }
.img-grid .img-cell { width: 120px; height: 120px; border-radius: 8px; cursor: zoom-in; }
.img-grid .img-cell:first-child:last-child, .img-grid .img-cell:only-child { grid-column: span 2; width: 240px; height: 200px; }

.wf-text :deep(p) { margin: 0 0 6px; }
.wf-text :deep(p:last-child) { margin-bottom: 0; }
.wf-text :deep(code) { font-family: var(--font-mono); font-size: 12.5px; background: var(--bg-inset); border: 1px solid var(--line); border-radius: 4px; padding: 0 5px; }
.wf-text :deep(ul), .wf-text :deep(ol) { margin: 4px 0; padding-left: 18px; }
.wf-text :deep(strong) { font-weight: 600; }
.wf-text :deep(.mention) { color: var(--accent); background: var(--accent-soft); border-radius: 3px; padding: 0 3px; font-weight: 600; }

/* ---------- 工具调用树（IDE 感核心组件） ---------- */
.tooltree {
  margin: 4px 0; background: var(--bg-inset); border: 1px solid var(--line);
  border-radius: var(--r-panel); overflow: hidden;
}
.tt-head {
  display: flex; align-items: center; gap: 8px; width: 100%; text-align: left;
  padding: 6px 10px; font-size: var(--fs-aux); color: var(--text-2);
  border: none; background: color-mix(in srgb, var(--bg-raised) 60%, transparent); cursor: pointer;
  border-bottom: 1px solid var(--line);
}
.tooltree:not(.open) .tt-head { border-bottom: none; }
.tt-caret { color: var(--text-3); font-size: 11px; width: 11px; flex: none; }
.tt-dot { width: 6px; height: 6px; border-radius: 50%; flex: none; }
.tt-dot.ok { background: var(--ok); }
.tt-dot.err { background: var(--danger); }
.tt-fail { color: var(--danger); font-weight: 600; }
.tt-agent { font-weight: 600; flex: none; }
.tt-text { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--text-3); }
.tt-meta { font-family: var(--font-mono); color: var(--text-3); flex: none; }
.tt-body { padding: 6px 10px 7px; display: flex; flex-direction: column; gap: 4px; }
.tcall { display: flex; flex-direction: column; gap: 1px; }
.tcall-line { display: flex; align-items: baseline; gap: 8px; font-size: var(--fs-aux); line-height: 1.5; flex-wrap: wrap; }
.tcall .sym { color: var(--text-3); flex: none; font-size: 11px; }
.tcall .path { color: var(--text-2); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.tcall .args { color: var(--text-3); word-break: break-all; }
.tcall .st { margin-left: auto; font-size: var(--fs-meta); color: var(--ok); flex: none; }
.tcall .st.bad { color: var(--danger); }
.gist { font-size: var(--fs-meta); color: var(--text-3); padding-left: 22px; word-break: break-all; }
.live-tree { margin: 0; }

.tc-diff { font-size: var(--fs-meta); color: var(--text-2); background: var(--bg-page); border: 1px solid var(--line); border-radius: 4px; padding: 4px 8px; margin: 2px 0 2px 22px; white-space: pre-wrap; word-break: break-all; max-height: 140px; overflow-y: auto; }
.tc-undo {
  border: 1px solid var(--line-strong); background: var(--bg-raised); color: var(--text-3);
  border-radius: var(--r-ctl); font-size: var(--fs-meta); padding: 1px 8px; cursor: pointer; margin: 2px 0 2px 22px; align-self: flex-start;
}
.tc-undo:hover { color: var(--text-1); border-color: var(--accent-line); }
.done-line { font-size: var(--fs-meta); color: var(--text-3); }
.done-line.ok { color: var(--ok); }

/* ---------- 系统行 / notice ---------- */
.sysline {
  display: flex; align-items: center; gap: 10px; color: var(--text-3);
  font-size: var(--fs-aux); padding: 7px 0;
}
.sysline::before, .sysline::after { content: ""; flex: 1; height: 1px; background: var(--line); }
.sysline span { flex: none; }
.sys-row { display: flex; justify-content: center; margin: 4px 0; }
.sys-card {
  font-size: var(--fs-aux); color: var(--text-2); background: var(--bg-raised);
  border: 1px solid var(--line-strong); border-radius: var(--r-panel); padding: 8px 16px;
  max-width: 80%; text-align: center;
}
.notice {
  display: flex; gap: 9px; align-items: flex-start; max-width: 640px; margin: 8px auto;
  padding: 8px 12px; border-radius: var(--r-panel);
  background: color-mix(in srgb, var(--warn) 7%, transparent);
  border: 1px solid color-mix(in srgb, var(--warn) 22%, transparent);
  color: var(--text-2); font-size: 12.5px; line-height: 1.55;
}
.notice .ic { color: var(--warn); flex: none; margin-top: 1px; }

/* ---------- 问答卡（需拍板）---------- */
.askcard {
  max-width: 640px; width: 100%; margin: 10px auto; background: var(--bg-raised);
  border: 1px solid var(--accent-line); border-left: 3px solid var(--accent);
  border-radius: var(--r-panel); padding: 12px 14px;
}
.askcard .q { font-size: var(--fs-body); font-weight: 600; margin-bottom: 3px; color: var(--text-1); }
.askcard .hint { font-size: 12.5px; color: var(--text-2); margin-bottom: 10px; }
.askcard .row { display: flex; gap: 8px; align-items: center; }
.ask-input {
  flex: 1; min-width: 0; height: 30px; padding: 0 10px; background: var(--bg-overlay);
  border: 1px solid var(--line-strong); border-radius: var(--r-ctl); color: var(--text-1);
  font-size: 13px; outline: none;
}
.ask-input:focus { border-color: var(--accent-line); }
.cv-text { white-space: pre-wrap; }

/* ---------- 未读分隔 ---------- */
.unread-divider { display: flex; align-items: center; gap: 10px; margin: 8px 0; color: var(--danger); font-size: var(--fs-meta); }
.unread-divider::before, .unread-divider::after { content: ''; flex: 1; height: 1px; background: color-mix(in srgb, var(--danger) 35%, transparent); }

/* ---------- 实时状态 ---------- */
.live-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--accent); animation: pulse 1.1s infinite; align-self: center; flex: none; }
@keyframes pulse { 50% { opacity: 0.3; } }
.live-label { font-size: var(--fs-meta); color: var(--accent); }
.caret { display: inline-block; width: 7px; height: 14px; background: var(--accent); margin-left: 4px; vertical-align: text-bottom; border-radius: 1px; animation: blink 1s step-end infinite; }
@keyframes blink { 50% { opacity: 0; } }
.router-hint { align-self: center; font-size: var(--fs-aux); color: var(--text-3); display: flex; align-items: center; gap: 4px; margin: 8px 0; }
.dot-t { width: 5px; height: 5px; border-radius: 50%; background: var(--text-3); animation: bob 1.2s infinite; }
.dot-t:nth-child(2) { animation-delay: 0.15s; }
.dot-t:nth-child(3) { animation-delay: 0.3s; }
@keyframes bob { 0%, 60%, 100% { transform: translateY(0); opacity: 0.4; } 30% { transform: translateY(-4px); opacity: 1; } }

/* ---------- 并行活动状态行 ---------- */
.parallel-line { align-self: flex-start; display: flex; gap: 10px; flex-wrap: wrap; margin: 6px 0 6px 38px; font-size: var(--fs-meta); color: var(--text-3); }
.pl-chip { display: inline-flex; align-items: center; gap: 5px; }
.pl-dot { width: 6px; height: 6px; border-radius: 50%; display: inline-block; flex: none; }
.parallel-line .pl-dot { animation: pulse 1.1s infinite; }
.pl-sep { opacity: 0.5; margin-left: 8px; }

/* ---------- 新消息胶囊 / pending / go-bar ---------- */
.new-pill {
  position: absolute; right: 16px; bottom: 160px; z-index: 5;
  border: 1px solid var(--line-strong); background: var(--bg-raised); color: var(--accent);
  border-radius: 14px; font-size: var(--fs-aux); padding: 4px 12px; cursor: pointer; box-shadow: var(--shadow-float);
}
.fade-enter-active, .fade-leave-active { transition: opacity 0.18s; }
.fade-enter-from, .fade-leave-to { opacity: 0; }

.detail-open-btn {
  position: absolute; right: 12px; top: 10px; z-index: 5;
  border: 1px solid var(--line); background: var(--bg-panel); color: var(--text-3);
  border-radius: var(--r-ctl); font-size: var(--fs-meta); padding: 3px 9px; cursor: pointer;
}
.detail-open-btn:hover { color: var(--text-1); border-color: var(--line-strong); }

.pending-bar {
  margin: 0 24px 6px; font-size: var(--fs-aux); color: var(--accent);
  border: 1px dashed var(--accent-line); border-radius: var(--r-panel); padding: 5px 10px;
}

.go-bar {
  margin: 0 24px 6px; display: flex; align-items: center; justify-content: space-between; gap: 8px;
  font-size: var(--fs-aux); color: var(--text-1); background: var(--bg-raised);
  border: 1px solid var(--accent-line); border-radius: var(--r-panel); padding: 6px 10px;
}
.go-text { font-weight: 600; }
.go-ops { display: flex; gap: 6px; }

/* ---------- 输入区 ---------- */
.input-zone { flex: none; border-top: 1px solid var(--line); background: var(--bg-panel); padding: 10px 24px 12px; }
.input-inner { max-width: var(--measure); margin: 0 auto; display: flex; flex-direction: column; gap: 8px; }
.quote-reply {
  display: flex; align-items: center; gap: 8px; font-size: var(--fs-aux); color: var(--text-2);
  background: var(--bg-inset); border: 1px solid var(--line); border-radius: var(--r-ctl); padding: 5px 9px;
}
.quote-reply .bar { width: 2px; height: 14px; background: var(--line-strong); border-radius: 2px; flex: none; }
.quote-reply .bar.author { background: var(--accent); }
.quote-reply .quote-text { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.rb-x { border: none; background: none; color: var(--text-3); font-size: 12px; cursor: pointer; }
.rb-x:hover { color: var(--text-1); }
.mentions { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
.chip-label { font-size: var(--fs-meta); color: var(--text-3); }
.mention-chip {
  display: inline-flex; align-items: center; gap: 5px; height: 22px; padding: 0 9px; border-radius: 11px;
  font-size: var(--fs-aux); color: var(--text-2); border: 1px solid var(--line); background: var(--bg-raised); cursor: pointer;
}
.mention-chip:hover { color: var(--accent); border-color: var(--accent-line); background: var(--accent-soft); }
.inputrow { display: flex; gap: 10px; align-items: flex-end; }
.inputrow :deep(.el-textarea__inner) {
  background: var(--bg-overlay); border-color: var(--line-strong); border-radius: var(--r-panel);
  font-size: var(--fs-body); line-height: 1.5; color: var(--text-1); padding: 9px 12px;
  min-height: 44px; box-shadow: none;
}
.inputrow :deep(.el-textarea__inner:focus) { border-color: var(--accent-line); }
.input-side { display: flex; flex-direction: column; gap: 8px; align-items: flex-end; flex: none; }
.mode-seg :deep(.el-radio-button__inner) { background: var(--bg-overlay); border-color: var(--line-strong); color: var(--text-3); }
.mode-seg :deep(.el-radio-button__original-radio:checked + .el-radio-button__inner) {
  background: var(--accent-soft); color: var(--accent); border-color: var(--accent-line);
}
.under { display: flex; gap: 6px; align-items: center; }
.mode-hint { font-size: var(--fs-meta); color: var(--text-3); }

/* ---------- 右侧详情面板（常驻可收 IDE inspector） ---------- */
.detail-panel {
  width: var(--detail-w); flex: none; border-left: 1px solid var(--line); background: var(--bg-panel);
  display: flex; flex-direction: column; min-height: 0; overflow: hidden;
}
.dp-head {
  height: 46px; flex: none; display: flex; align-items: center; gap: 9px; padding: 0 14px;
  border-bottom: 1px solid var(--line); font-size: 13px; font-weight: 600; color: var(--text-2);
}
.dp-sub { color: var(--text-3); font-weight: 400; font-size: var(--fs-meta); }
.dp-collapse {
  margin-left: auto; width: 24px; height: 24px; display: grid; place-items: center;
  border: none; background: transparent; color: var(--text-3); border-radius: var(--r-ctl); cursor: pointer; font-size: 13px;
}
.dp-collapse:hover { background: var(--bg-raised); color: var(--text-1); }
.dp-body { flex: 1; overflow-y: auto; padding: 14px 16px 20px; display: flex; flex-direction: column; }
.dsec { margin-bottom: 18px; display: flex; flex-direction: column; gap: 6px; }
.dtitle {
  font-size: var(--fs-meta); color: var(--text-3); font-family: var(--font-mono);
  letter-spacing: .08em; text-transform: uppercase; margin-bottom: 2px;
  display: flex; align-items: center; gap: 8px;
}
.dtitle::after { content: ""; flex: 1; height: 1px; background: var(--line); }
.dp-sec-body { font-size: 13px; line-height: 1.65; color: var(--text-2); white-space: pre-wrap; word-break: break-word; margin: 0; }
.fitem-block { display: flex; flex-direction: column; gap: 2px; padding: 5px 8px; border-radius: 5px; }
.fitem-block:hover { background: var(--bg-raised); }
.fitem-line { display: flex; align-items: baseline; gap: 6px; font-size: var(--fs-aux); }
.fi-name { color: var(--text-2); font-weight: 600; }
.fi-status { margin-left: auto; color: var(--ok); flex: none; }
.fi-status.bad { color: var(--danger); }
.fi-args { font-size: var(--fs-meta); color: var(--text-3); word-break: break-all; }
.fi-gist { font-size: var(--fs-meta); color: var(--text-3); word-break: break-all; }
.chips { display: flex; flex-wrap: wrap; gap: 4px; }
.chip {
  font-size: var(--fs-meta); color: var(--accent); font-family: var(--font-mono);
  background: var(--accent-soft); border: 1px solid var(--accent-line); border-radius: 8px; padding: 1px 8px;
}
.dp-model { font-size: var(--fs-meta); color: var(--text-3); margin-top: auto; padding-top: 10px; }
.dp-empty { font-size: var(--fs-aux); color: var(--text-3); text-align: center; padding: 24px 0; line-height: 2; }
.mono { font-family: var(--font-mono); }

/* 窄屏隐藏详情面板 */
@media (max-width: 1100px) { .detail-panel { display: none; } }
</style>
