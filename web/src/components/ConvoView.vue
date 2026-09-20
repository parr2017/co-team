<template>
  <div class="convo-page">
    <!-- 左栏：会话列表 -->
    <aside class="side">
      <div class="side-search">
        <el-input v-model="search" placeholder="搜索会话" size="small" clearable :prefix-icon="Search" />
      </div>
      <div class="side-list">
        <template v-for="group in groupedConvos" :key="group.name">
          <div class="side-group">{{ group.name }}</div>
          <div
            v-for="c in group.items"
            :key="c.id"
            class="side-item"
            :class="{ active: c.id === activeId }"
            @click="openConvo(c.id)"
          >
            <div class="t">
              <span class="dot" :class="c.status" />
              <span class="title">{{ c.title }}</span>
              <el-icon class="del-btn" title="删除会话" @click.stop="removeConvo(c)"><Delete /></el-icon>
            </div>
            <div class="m">
              <span class="mtag">{{ c.model_id || '自动选模' }}</span>
              <span class="st">{{ STATUS_LABEL[c.status] || c.status }}</span>
              <span v-if="queuedOf(c.id)" class="st warn">排队 {{ queuedOf(c.id) }}</span>
            </div>
          </div>
        </template>
        <div v-if="!convos.length" class="side-empty">还没有会话，点下方新建</div>
      </div>
      <div class="side-foot">
        <el-button size="small" class="new-btn" @click="createDlg = true">＋ 新建会话</el-button>
      </div>
    </aside>

    <!-- 右侧：聊天 -->
    <section class="chat">
      <template v-if="detail">
        <div class="chat-head">
          <div class="head-title">
            <span class="title" :title="detail.workspace">{{ detail.title }}</span>
            <el-button link size="small" @click="startRename">改名</el-button>
          </div>
          <div class="proj">{{ detail.workspace || '（未绑定项目）' }}</div>
          <div class="head-right">
            <el-select
              :model-value="detail.model_id || ''"
              size="small"
              class="model-select"
              placeholder="自动选模"
              @change="(v: string) => changeModel(v)"
            >
              <el-option v-for="m in modelOptions" :key="m.id" :label="modelLabel(m)" :value="m.id" />
            </el-select>
            <span class="auto-sw" title="开启后主模型失败将沿降级链自动换模；关闭则自动重试 10 次后报断连">
              自动切换<el-switch :model-value="!!detail.auto_switch" size="small" @change="(v: any) => changeAutoSwitch(!!v)" />
            </span>
            <el-select
              :model-value="detail.policy_level || ''"
              size="small"
              class="perm-select"
              @change="(v: string) => changePolicy(v)"
            >
              <el-option label="继承全局（whitelist_auto）" value="" />
              <el-option v-for="lv in PERMISSION_LEVELS" :key="lv" :label="PERMISSION_LEVEL_LABELS[lv]" :value="lv" />
            </el-select>
            <el-button size="small" @click="openDiff">diff</el-button>
            <el-button size="small" @click="fork">fork</el-button>
            <el-button size="small" type="danger" plain @click="rollback">回滚快照</el-button>
          </div>
        </div>

        <div ref="streamEl" class="stream" @scroll="onScroll">
<div class="col">
            <!-- v4 渲染：按轮次分组（用户消息开轮 → 执行日志 → 思考 → 结论 → diff 脚注） -->
            <template v-for="(turn, ti) in turns" :key="ti">
              <div class="day-sep" v-if="turn.user">{{ fmtTime(turn.user.ts) }}</div>

              <div v-if="turn.user && turn.user.kind === 'text'" class="user-row">
                <div class="user-msg">
                  <div class="plain">{{ turn.user.text }}</div>
                  <div v-if="turn.user.meta?.images?.length" class="imgrow">
                    <el-image v-for="(img, i) in turn.user.meta.images" :key="i" class="ph" :src="img.url"
                      :preview-src-list="turn.user.meta.images.map((x: any) => x.url)" :initial-index="i" preview-teleported fit="cover" />
                  </div>
                </div>
              </div>
              <div v-else-if="turn.user && turn.user.kind === 'file'" class="user-row">
                <div class="user-msg">
                  <div v-for="f in turn.user.meta?.files || []" :key="f.id" class="file-line">
                    <el-icon><Document /></el-icon><a :href="f.url" target="_blank">{{ f.name }}</a>
                    <span class="dim">{{ fmtSize(f.size) }}</span>
                  </div>
                </div>
              </div>

              <div v-if="turn.items.length" class="turn" :class="{ live: isTurnLive(turn) }">
                <div class="turn-head">
                  <div class="t-avatar">搭</div><div class="t-name">搭档</div>
                  <div class="t-model">{{ turnModel(turn) }}</div>
                  <div class="t-meta">
                    <span v-if="isTurnLive(turn)"><span class="t-running" /> 运行中</span>
                    <template v-else>
                      <span v-if="turnSteps(turn)">{{ turnSteps(turn) }} 步</span>
                      <span v-if="turnDuration(turn)">{{ turnDuration(turn) }}</span>
                    </template>
                  </div>
                </div>

                <!-- 步骤清单（仅最新轮显示当前 plan；胶囊/展开） -->
                <div v-if="ti === turns.length - 1 && detail.plan?.steps?.length" class="plan">
                  <div v-if="!planOpen" class="plan-pill" @click="planOpen = true">
                    <span class="plan-dot" />
                    <span>步骤 {{ planDone }}/{{ detail.plan.steps.length }}</span>
                    <span class="plan-cur">{{ planCur?.text || '已完成' }}</span>
                    <span class="car">▸</span>
                  </div>
                  <div v-else class="plan-full">
                    <div class="plan-head" @click="planOpen = false">
                      <span>任务计划 {{ planDone }}/{{ detail.plan.steps.length }}</span>
                      <span class="car" style="transform:rotate(90deg)">▸</span>
                    </div>
                    <div v-for="(st, si) in detail.plan.steps" :key="si" class="plan-step" :class="st.status">
                      <span class="mark">{{ st.status === 'done' ? '✓' : st.status === 'in_progress' ? '●' : st.status === 'blocked' ? '⊘' : '○' }}</span>
                      <span class="txt">{{ st.text }}</span>
                    </div>
                  </div>
                </div>

                <!-- 执行日志（默认折叠；执行中的轮次自动展开） -->
                <details v-if="turnActs(turn).length" class="acts-fold" :open="isTurnLive(turn) || undefined">
                  <summary class="acts-sum">
                    <span class="car">▶</span>
                    <span>执行了 {{ turnActs(turn).length }} 步</span>
                    <span class="last-tool">{{ turnActs(turn)[turnActs(turn).length - 1]?.tool }}</span>
                  </summary>
                  <div class="acts">
                    <div v-for="(a, ai) in turnActs(turn)" :key="ai" class="act-line" :class="{ err: !a.ok, live: a.live }">
                      <span class="tool-tag">{{ a.tool }}</span>
                      <span class="act-args">{{ a.args }}</span>
                      <span class="act-res">
                        <span v-if="a.res" class="pill" :class="{ bad: !a.ok, dim: a.ok && !a.isExit }">{{ a.res }}</span>
                        <span v-if="a.extra">{{ a.extra }}</span>
                        <span v-if="a.live">执行中</span>
                      </span>
                    </div>
                  </div>
                </details>

                <!-- 轮内非工具卡（审批/提问/文件/降级/打断/提示）按原顺序 -->
                <template v-for="m in turn.items" :key="m.id">
                  <div v-if="m.kind === 'notice'" class="notice" :class="{ warn: m.meta?.retry || m.meta?.turn_complete || m.meta?.stale_reset }">{{ m.text }}</div>
                  <div v-else-if="m.kind === 'degrade' && m.meta?.broken" class="inline danger">
                    <span>模型断连</span><span style="flex:1;min-width:0">{{ m.text }}</span>
                    <el-button size="small" class="fbtn" @click="openModelPop">切换模型</el-button>
                  </div>
                  <div v-else-if="m.kind === 'degrade' && m.meta?.recovered" class="inline warn">
                    <span>已恢复</span><span>{{ m.text }}</span>
                  </div>
                  <div v-else-if="m.kind === 'degrade'" class="inline warn">
                    <span>降级</span><span>{{ m.text.replace(/^主模型/, '').replace(/，本轮已自动?降级为/, ' → ') }}</span>
                    <el-button size="small" class="fbtn" v-if="detail?.model_id && m.meta?.actual !== detail?.model_id" @click="changeModel(detail!.model_id!)">改回主模型</el-button>
                  </div>
                  <div v-else-if="m.kind === 'approval'" class="inline danger">
                    <span>待审批</span><span class="cmd">{{ m.meta?.command || m.text }}</span>
                    <template v-if="m.meta?.status === 'pending'">
                      <el-button size="small" class="fbtn" @click="resolveApproval(m.meta!.approval_id, 'reject')">拒绝</el-button>
                      <el-button size="small" class="fbtn" @click="resolveApproval(m.meta!.approval_id, 'always')">总是允许</el-button>
                      <el-button size="small" class="fbtn p" @click="resolveApproval(m.meta!.approval_id, 'once')">批准一次</el-button>
                    </template>
                    <span v-else class="act-res"><span class="pill" :class="{ bad: m.meta?.status === 'rejected' }">{{ m.meta?.status === 'rejected' ? '已拒绝' : m.meta?.status === 'approved_always' ? '已授权' : '已执行' }}</span></span>
                  </div>
                  <div v-else-if="m.kind === 'ask'" class="inline askcard">
                    <span>提问</span><span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">{{ m.text }}</span>
                    <template v-if="m.meta?.status === 'pending'">
                      <input v-model="askDraft" class="ask-input" placeholder="输入回答" @keydown.enter="submitAsk(m.meta!.ask_id)" />
                      <el-button size="small" class="fbtn p" @click="submitAsk(m.meta!.ask_id)">回复</el-button>
                    </template>
                    <span v-else class="act-res"><span class="pill" :class="{ bad: m.meta?.status !== 'answered' }">{{ m.meta?.status === 'answered' ? '已回答' : '已取消' }}</span></span>
                  </div>
                  <div v-else-if="m.kind === 'file'" class="inline">
                    <span>📎 {{ m.text }}</span><span class="sp" />
                    <el-button size="small" class="fbtn" @click="previewFile(m.text)">预览</el-button>
                  </div>
                  <div v-else-if="m.kind === 'interrupt'" class="interrupt-sep"><span class="sq" />已打断 · 输入新指令继续</div>
                </template>

                <!-- 思考折叠 -->
                <details v-if="turnThinking(turn)" class="think">
                  <summary><span class="car">▶</span><span class="tt">思考过程</span></summary>
                  <div class="think-body">{{ turnThinking(turn) }}</div>
                </details>

                <!-- 结论正文 -->
                <div v-for="m in turn.items.filter(x => x.role === 'assistant' && x.kind === 'text')" :key="'c' + m.id" class="conclusion">
                  <div class="md"><MdView :source="m.text" /></div>
                </div>

                <!-- 变更汇总行（ZCode 式） -->
                <div v-for="m in turn.items.filter(x => x.kind === 'diff')" :key="'d' + m.id" class="changes">
                  <div class="sum" :class="{ open: changesOpen.has(m.id) }" @click="toggleChanges(m.id)">
                    <span class="car">▶</span><span class="n">{{ (m.meta?.files || []).length }} 个文件已更改</span>
                    <span class="add" v-if="diffStat(m.meta?.patch).add">+{{ diffStat(m.meta?.patch).add }}</span>
                    <span class="del" v-if="diffStat(m.meta?.patch).del">−{{ diffStat(m.meta?.patch).del }}</span>
                  </div>
                  <div v-for="f in (m.meta?.files || []).slice(0, 8)" :key="f" class="file">{{ f }}</div>
                  <button class="fbtn" @click="showDiffDialog(m.meta?.patch || '')">查看 diff</button>
                </div>

                <!-- 结论操作行（ZCode 式） -->
                <div v-for="m in turn.items.filter(x => x.role === 'assistant' && x.kind === 'text')" :key="'o' + m.id" class="ops">
                  <button @click="copyText(m.text)"><el-icon><CopyDocument /></el-icon>复制</button>
                  <button :class="{ on: msgVote[m.id] === 'up' }" @click="msgVote[m.id] = 'up'">👍</button>
                  <button :class="{ on: msgVote[m.id] === 'down' }" @click="msgVote[m.id] = 'down'">👎</button>
                  <button @click="forkMsg(m)"><el-icon><Share /></el-icon>分叉</button>
                  <span class="ts">{{ fmtTime(m.ts) }}</span>
                </div>

                <!-- 运行中 live 区（嵌在当前轮内） -->
                <template v-if="isTurnLive(turn)">
                  <div v-if="toolLive.length" class="acts">
                    <div v-for="(tl, tli) in toolLive" :key="'tl' + tli" class="act-line live">
                      <span class="tool-tag">{{ tl.tool }}</span>
                      <span class="act-args">{{ tl.command }}</span>
                      <span class="act-res"><span class="pill dim">执行中…</span></span>
                    </div>
                  </div>
                  <div v-if="reasoningText" class="live-think">
                    <div class="lab">思考</div>
                    <div class="think-body live-scroll">{{ reasoningText.slice(-1000) }}</div>
                  </div>
                  <div v-if="streamingText" class="conclusion">
                    <div class="md"><MdView :source="streamingText" /><span class="cursor" /></div>
                  </div>
                  <div v-if="!reasoningText && !streamingText && !toolLive.length" class="notice think-placeholder">正在思考…</div>
                </template>
              </div>
            </template>

            <!-- 排队徽标（会话进行中自动入队；「立即插入」= 打断当前执行、队列消息马上处理） -->
            <div v-if="queuedCount" class="queued">
              <el-icon><Clock /></el-icon>排队中 {{ queuedCount }} 条 · 本轮结束后处理
              <el-button size="small" class="promote-btn" :loading="promoting" @click="promoteNow">立即插入</el-button>
            </div>
          </div>
        </div>

        <!-- 输入区 -->
        <div class="composer">
          <div class="atpanel" v-show="atOpen">
            <el-input v-model="atQuery" size="small" placeholder="输入文件名过滤（@ 引用进消息）" @input="atFilter" />
            <div class="atlist">
              <div v-for="f in atResults" :key="f" class="ai" @click="pickAt(f)"><el-icon><Document /></el-icon>{{ f }}</div>
              <div v-if="!atResults.length" class="at-none">无匹配文件</div>
            </div>
          </div>
          <div class="chips" v-if="pendingFiles.length || pendingImages.length || pendingRefs.length">
            <span v-for="(img, i) in pendingImages" :key="'i' + i" class="chip img">
              <el-icon><Picture /></el-icon>{{ img.name }}
              <b @click="pendingImages.splice(i, 1)"><el-icon><Close /></el-icon></b>
            </span>
            <span v-for="(f, i) in pendingFiles" :key="'f' + i" class="chip">
              <el-icon><Document /></el-icon>{{ f.name }}
              <b @click="pendingFiles.splice(i, 1)"><el-icon><Close /></el-icon></b>
            </span>
            <span v-for="(r, i) in pendingRefs" :key="'r' + i" class="chip">
              <el-icon><Link /></el-icon>@{{ r }}
              <b @click="pendingRefs.splice(i, 1)"><el-icon><Close /></el-icon></b>
            </span>
          </div>
          <div class="comp-r1">
            <span class="hint">{{ busy ? '会话进行中 · 发送将自动排队（排队气泡上可「立即插入」）' : 'Enter 发送 / Shift+Enter 换行' }}</span>
            <input ref="imgInput" type="file" accept="image/*" multiple hidden @change="onPickImages" />
            <input ref="fileInput" type="file" multiple hidden @change="onPickFiles" />
          </div>
          <div class="comp-r2">
            <div class="ta-wrap">
              <el-input
                v-model="draft"
                type="textarea"
                :autosize="{ minRows: 1, maxRows: 6 }"
                placeholder="提出后续修改要求…  Enter 发送 / Shift+Enter 换行"
                @keydown="onKeydown"
              />
              <div class="ta-tools">
                <el-button link size="small" title="发送图片" @click="imgInput?.click()"><el-icon><Picture /></el-icon></el-button>
                <el-button link size="small" title="发送文件" @click="fileInput?.click()"><el-icon><Document /></el-icon></el-button>
                <el-button link size="small" title="引用项目文件" @click="openAt"><el-icon><Link /></el-icon></el-button>
              </div>
            </div>
            <el-button class="stop-btn" :disabled="!busy" @click="stop">停止</el-button>
            <el-button type="primary" class="send-btn" :loading="sending" @click="send">发送</el-button>
          </div>
        </div>
      </template>

      <div v-else class="chat-empty">
        <div class="big">选择左侧会话，或新建一个</div>
        <div class="sm">协作会话 = 与搭档结对开发：直接读写项目工作区 · 每轮 diff 可见 · 首轮自动快照可回滚</div>
      </div>
    </section>

    <!-- 新建会话 -->
    <el-dialog v-model="createDlg" title="新建协作会话" width="520">
      <el-form label-width="86" label-position="left">
        <el-form-item label="项目">
          <el-select v-model="form.project_id" filterable placeholder="选择项目（决定工作区）">
            <el-option v-for="p in projects" :key="p.id" :label="p.name" :value="p.id" />
          </el-select>
        </el-form-item>
        <el-form-item label="标题">
          <el-input v-model="form.title" placeholder="留空自动生成" maxlength="120" />
        </el-form-item>
        <el-form-item label="主模型">
          <el-select v-model="form.model_id" filterable placeholder="自动选模" clearable>
            <el-option v-for="m in modelOptions" :key="m.id" :label="modelLabel(m)" :value="m.id" />
          </el-select>
        </el-form-item>
        <el-form-item label="人设">
          <el-select v-model="form.agent_id">
            <el-option v-for="a in agents" :key="a.name" :label="`${a.name}${a.role ? ' · ' + a.role : ''}`" :value="a.name" />
          </el-select>
        </el-form-item>
        <el-form-item label="权限">
          <el-select v-model="form.policy_level" placeholder="继承全局" clearable>
            <el-option v-for="lv in PERMISSION_LEVELS" :key="lv" :label="PERMISSION_LEVEL_LABELS[lv]" :value="lv" />
          </el-select>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="createDlg = false">取消</el-button>
        <el-button type="primary" :loading="creating" @click="create">创建</el-button>
      </template>
    </el-dialog>

    <!-- diff 查看器 -->
    <el-dialog v-model="diffDlg" :title="`diff · ${diffFiles.length} 个文件`" width="760" top="6vh">
      <div class="diff-files">{{ diffFiles.join('\n') }}</div>
      <pre class="diff-patch"><code><span v-for="(l, i) in diffLines" :key="i" :class="lineClass(l)">{{ l }}
</span></code></pre>
    </el-dialog>

    <!-- 文件预览 -->
    <el-dialog v-model="fileDlg" :title="previewName" width="680" top="6vh">
      <img v-if="previewKind === 'image'" :src="previewDataUrl" class="preview-img" />
      <pre v-else class="preview-text">{{ previewContent }}</pre>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue';
import { Search, Document, SetUp, User, WarningFilled, Lock, ChatDotRound, Clock, Picture, Close, SwitchButton, Files, Link, Delete, CopyDocument, Share } from '@element-plus/icons-vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { api, PERMISSION_LEVELS, PERMISSION_LEVEL_LABELS } from '../api';
import type { Convo, ConvoDetail, ConvoFileRef, IncomingImage, ConvoMessage } from '../api';
import { useDashboard } from '../composables/useDashboard';
import MdView from './MdView.vue';


const { onEvent } = useDashboard();

const STATUS_LABEL: Record<string, string> = { idle: '空闲', running: '运行中', waiting_approval: '待审批', waiting_ask: '待回答' };

const convos = ref<Convo[]>([]);
const projects = ref<{ id: string; name: string; workspace: string }[]>([]);
const agents = ref<{ name: string; role?: string }[]>([]);
const modelOptions = ref<{ id: string; name: string; provider?: string }[]>([]);
const search = ref('');
const activeId = ref('');
const detail = ref<ConvoDetail | null>(null);
const queuedCounts = reactive<Record<string, number>>({});
const draft = ref('');
const sending = ref(false);
const streamEl = ref<HTMLElement>();
const createDlg = ref(false);
const creating = ref(false);
const form = reactive({ project_id: '', title: '', model_id: '', agent_id: 'partner', policy_level: '' });
const busy = computed(() => detail.value?.status === 'running' || detail.value?.status === 'waiting_approval' || detail.value?.status === 'waiting_ask');
const queuedCount = computed(() => queuedCounts[activeId.value] || 0);

// 流式上屏：stream_id → 累积文本
const streamBuf = reactive<Record<string, string>>({});
const streaming = ref(false);
const streamingText = computed(() => Object.values(streamBuf).join(''));

// diff / 预览
const diffDlg = ref(false);
const diffFiles = ref<string[]>([]);
const diffPatch = ref('');
const diffLines = computed(() => diffPatch.value.split('\n'));
const fileDlg = ref(false);
const previewName = ref('');
const previewKind = ref<'text' | 'image'>('text');
const previewContent = ref('');
const previewDataUrl = ref('');

const pendingImages = ref<IncomingImage[]>([]);
const pendingFiles = ref<File[]>([]);
const pendingRefs = ref<string[]>([]);
const atOpen = ref(false);
const atQuery = ref('');
const atResults = ref<string[]>([]);
const imgInput = ref<HTMLInputElement>();
const fileInput = ref<HTMLInputElement>();
const askDraft = ref('');
const promoting = ref(false);

// ---------- @ 引用 ----------
async function openAt() {
  atOpen.value = !atOpen.value;
  if (atOpen.value) {
    atQuery.value = '';
    await atFilter();
  }
}

async function atFilter() {
  if (!detail.value) return;
  try {
    const r = await api.convoSearchFiles(detail.value.id, atQuery.value, 20);
    atResults.value = r.files;
  } catch {
    atResults.value = [];
  }
}

function pickAt(f: string) {
  if (!pendingRefs.value.includes(f)) pendingRefs.value.push(f);
  atOpen.value = false;
}

// ---------- fork ----------
async function fork() {
  if (!detail.value) return;
  try {
    const r = await api.convoFork(detail.value.id, { title: `${detail.value.title}（副本）` });
    ElMessage.success('已复制出新会话');
    await loadConvos();
    await openConvo(r.convo.id);
  } catch (e: any) {
    ElMessage.error(e.message);
  }
}

const groupedConvos = computed(() => {
  const q = search.value.trim().toLowerCase();
  const map = new Map<string, Convo[]>();
  for (const c of convos.value) {
    if (q && !c.title.toLowerCase().includes(q)) continue;
    const name = projects.value.find((p) => p.id === c.project_id)?.name || '未绑定项目';
    if (!map.has(name)) map.set(name, []);
    map.get(name)!.push(c);
  }
  return [...map.entries()].map(([name, items]) => ({ name, items }));
});

function queuedOf(id: string): number {
  return queuedCounts[id] || 0;
}

async function loadConvos() {
  // 列表与项目目录各自容错：任一失败不让另一个空转（项目下拉可用性优先）
  const [r, p] = await Promise.allSettled([api.convoList(), api.listProjects()]);
  if (r.status === 'fulfilled') {
    convos.value = r.value.convos;
  } else {
    convos.value = [];
    ElMessage.error(`会话列表加载失败：${(r.reason as Error)?.message || r.reason}`);
  }
  if (p.status === 'fulfilled') {
    projects.value = p.value.projects || [];
  } else {
    projects.value = [];
    ElMessage.error(`项目列表加载失败：${(p.reason as Error)?.message || p.reason}`);
  }
}

async function openConvo(id: string) {
  activeId.value = id;
  delete queuedCounts[id];
  try {
    detail.value = await api.convoGet(id);
    await nextTick();
    scrollEnd();
  } catch (e: any) {
    ElMessage.error(`会话加载失败：${e.message}`);
  }
}

async function refreshActive() {
  if (!activeId.value) return;
  try {
    const wasNearEnd = isNearEnd();
    detail.value = await api.convoGet(activeId.value);
    queuedCounts[activeId.value] = detail.value.pending_queue || 0;
    if (wasNearEnd) await nextTick(() => scrollEnd());
  } catch { /* 会话可能被删除 */ }
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

function showDaySep(_m: any): boolean {
  // 与 ChatStream 一致的 5 分钟间隔时间条（首条消息永远显示）
  return true;
}
function fmtTime(ts: string): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}
function fmtSize(n?: number): string {
  if (!n) return '';
  return n > 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)}MB` : `${Math.round(n / 1024)}KB`;
}

const openTools = reactive(new Set<string>());
function toggleTool(id: string) {
  if (openTools.has(id)) openTools.delete(id);
  else openTools.add(id);
}

// ---------- v4 轮次分组渲染 ----------
interface TurnGroup { user?: ConvoMessage; items: ConvoMessage[] }
const turns = computed<TurnGroup[]>(() => {
  const out: TurnGroup[] = [];
  for (const m of detail.value?.messages || []) {
    if (m.role === 'user') out.push({ user: m, items: [] });
    else {
      if (!out.length) out.push({ items: [] });
      out[out.length - 1].items.push(m);
    }
  }
  return out;
});

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
function turnDuration(turn: TurnGroup): string {
  const withTs = turn.items.filter((m) => m.ts);
  if (withTs.length < 2) return '';
  const ms = new Date(withTs[withTs.length - 1].ts).getTime() - new Date(withTs[0].ts).getTime();
  if (ms <= 0 || ms > 3600_000) return '';
  return ms > 60_000 ? `${Math.round(ms / 6000) / 10}m` : `${Math.round(ms / 100) / 10}s`;
}
interface ActLine { tool: string; args: string; res: string; extra?: string; ok: boolean; isExit: boolean; live?: boolean }
function turnActs(turn: TurnGroup): ActLine[] {
  const lines: ActLine[] = [];
  for (const m of turn.items) {
    if (m.kind !== 'tool') continue;
    const calls = (m.meta?.calls || []) as { tool: string; args_summary?: string; output_gist?: string; ok?: boolean; mcp?: { server: string } }[];
    for (const c of calls) {
      const isExit = /exit \d+/.test(c.output_gist || '');
      let res = '';
      if (isExit) res = (c.output_gist || '').match(/exit \d+/)?.[0] || '';
      else if (c.ok === false) res = c.tool.startsWith('mcp__') ? 'MCP 失败' : '工具不存在';
      else if (c.output_gist) {
        const nums = c.output_gist.match(/^([+-]?\d+[\s,]*)+/);
        res = /^\+\d+/.test(c.output_gist) ? c.output_gist.slice(0, 12) : '';
        if (!res && /\+\d+\s*−?\d*/.test(c.output_gist)) res = c.output_gist.match(/\+\d+(\s*−\d+)?/)?.[0] || '';
      }
      lines.push({
        tool: c.tool.startsWith('mcp__') ? 'mcp:' + c.mcp?.server : c.tool,
        args: c.args_summary || '',
        res, extra: isExit ? (c.output_gist || '').replace(/.*exit \d+\s*·?\s*/, '').slice(0, 10) : '',
        ok: c.ok !== false, isExit,
      });
    }
    // 运行中且该批是最后一条 tool 消息 → 追加"执行中"占位行
    if (busy.value && m === turn.items[turn.items.length - 1]) {
      lines.push({ tool: '…', args: '下一步执行中', res: '', ok: true, isExit: false, live: true });
    }
  }
  return lines;
}
function turnThinking(turn: TurnGroup): string {
  const parts = turn.items.map((m) => (m.meta?.reasoning as string) || '').filter(Boolean);
  return parts.join('\n\n');
}

// 步骤清单展开态 + 投票本地态
const planOpen = ref(false);
const changesOpen = reactive(new Set<string>());
const msgVote = reactive<Record<string, 'up' | 'down'>>({});
const planDone = computed(() => detail.value?.plan?.steps.filter((x) => x.status === 'done').length || 0);
const planCur = computed(() => detail.value?.plan?.steps.find((x) => x.status === 'in_progress'));
function modelLabel(m: { name: string; provider?: string }): string {
  return m.provider ? `${m.name} · ${m.provider}` : m.name;
}

async function promoteNow() {
  if (!detail.value) return;
  promoting.value = true;
  try {
    await api.convoPromote(detail.value.id);
    ElMessage.success('已打断当前执行，排队消息立即处理');
    await refreshActive();
  } catch (e: any) {
    ElMessage.error(e.message);
  } finally {
    promoting.value = false;
  }
}

function toggleChanges(id: string) { if (changesOpen.has(id)) changesOpen.delete(id); else changesOpen.add(id); }
function diffStat(patch?: string): { add: number; del: number } {
  if (!patch) return { add: 0, del: 0 };
  let add = 0, del = 0;
  for (const l of patch.split('\n')) { if (l.startsWith('+') && !l.startsWith('+++')) add++; else if (l.startsWith('-') && !l.startsWith('---')) del++; }
  return { add, del };
}
async function copyText(t: string) {
  try { await navigator.clipboard.writeText(t); ElMessage.success('已复制'); } catch { /* 剪贴板权限 */ }
}
async function forkMsg(m: ConvoMessage) {
  if (!detail.value) return;
  try {
    const r = await api.convoFork(detail.value.id, { message_id: m.id, title: `${detail.value.title}（分叉）` });
    ElMessage.success('已从该结论分叉出新会话');
    await loadConvos();
    await openConvo(r.convo.id);
  } catch (e: any) { ElMessage.error(e.message); }
}

// 思考流（convo_reason）：流式期间累积展示，最终消息到达后清空（回放走 meta.reasoning）
const reasonBuf = ref('');
const reasoningText = computed(() => reasonBuf.value);

// 工具执行中步骤（convo_tool_start → convo_tool）：实时展示"正在执行 grep…"，批次完成清空
const toolLive = ref<{ tool: string; command: string }[]>([]);
function clearToolLive() { toolLive.value = []; }
// 本轮 turn 基线：进入 running 时记录消息数，运行卡"执行"区实时显示其后新增的 tool 消息
const turnBaseline = ref(0);
const lastStatus = ref('');
const liveToolLines = computed(() => {
  if (!detail.value) return [];
  // 「最后一条 assistant 结论之后」的 tool 消息 = 本轮执行活动（不依赖 running 状态切换的捕获时机）
  const msgs = detail.value.messages;
  let start = msgs.length;
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i].role === 'assistant' && msgs[i].kind === 'text') { start = i + 1; break; }
    if (i === 0) start = 0;
  }
  return msgs.slice(start).filter((m) => m.kind === 'tool').map((m) => m.text);
});
watch(() => detail.value?.status, (st) => {
  if (st === 'running' && lastStatus.value !== 'running') {
    turnBaseline.value = detail.value?.messages.length || 0;
    reasonBuf.value = '';
    for (const k of Object.keys(streamBuf)) delete streamBuf[k];
  }
  if (st !== 'running' && lastStatus.value === 'running') {
    // turn 收敛：清运行卡状态（消息本体已在流里）
    reasonBuf.value = '';
    for (const k of Object.keys(streamBuf)) delete streamBuf[k];
  }
  lastStatus.value = st || '';
});

async function removeConvo(c: Convo) {
  try {
    await ElMessageBox.confirm(`删除会话「${c.title}」？消息与审批记录将一并删除（工作区文件不动）。`, '删除会话', { type: 'warning' });
  } catch { return; }
  try {
    await api.convoDelete(c.id);
    if (activeId.value === c.id) { activeId.value = ''; detail.value = null; }
    await loadConvos();
    ElMessage.success('已删除');
  } catch (e: any) {
    ElMessage.error(e.message);
  }
}

// ---------- 新建 / 管理 ----------
async function loadMeta() {
  const [ag, mp] = await Promise.all([api.listAgents().catch(() => ({ agents: [] })), api.getModelPool().catch(() => ({ model_pool: [] }))]);
  agents.value = ag.agents.map((a) => ({ name: a.name, role: (a as any).role }));
  if (!agents.value.some((a) => a.name === 'partner')) agents.value.unshift({ name: 'partner', role: '协作工程师' });
  modelOptions.value = mp.model_pool.map((m) => ({ id: m.id, name: m.name, provider: (m as any).provider || '' }));
}

async function create() {
  if (!form.project_id) { ElMessage.warning('请选择项目'); return; }
  creating.value = true;
  try {
    const r = await api.convoCreate({
      project_id: form.project_id,
      title: form.title || undefined,
      model_id: form.model_id || undefined,
      agent_id: form.agent_id || undefined,
      policy_level: form.policy_level || undefined,
    });
    createDlg.value = false;
    form.title = '';
    await loadConvos();
    await openConvo(r.convo.id);
  } catch (e: any) {
    ElMessage.error(e.message);
  } finally {
    creating.value = false;
  }
}

async function startRename() {
  if (!detail.value) return;
  try {
    const { value } = await ElMessageBox.prompt('新的会话标题', '重命名', { inputValue: detail.value.title });
    if (value?.trim()) {
      await api.convoUpdate(detail.value.id, { title: value.trim() });
      detail.value.title = value.trim();
      await loadConvos();
    }
  } catch { /* 取消 */ }
}

async function openModelPop() {
  if (!modelOptions.value.length || !detail.value) return;
  try {
    const { value } = await ElMessageBox.prompt(
      `当前主模型不可用。输入要切换到的模型 id（可选：${modelOptions.value.map((m) => m.id).join('、')}）`,
      '切换模型',
      { inputValue: detail.value.model_id || '' }
    );
    if (value?.trim()) await changeModel(value.trim());
  } catch { /* 取消 */ }
}

async function changeAutoSwitch(on: boolean) {
  if (!detail.value) return;
  try {
    await api.convoUpdate(detail.value.id, { auto_switch: on } as any);
    detail.value.auto_switch = on;
    ElMessage.success(on ? '已开启自动切换：主模型失败将自动降级' : '已关闭自动切换：主模型失败将自动重试 10 次后报断连');
  } catch (e: any) {
    ElMessage.error(e.message);
  }
}

async function changePolicy(level: string) {
  if (!detail.value) return;
  try {
    await api.convoUpdate(detail.value.id, { policy_level: level || null });
    detail.value.policy_level = level || undefined;
    ElMessage.success(level ? `权限已切换为${PERMISSION_LEVEL_LABELS[level]}` : '权限已切换为继承全局');
  } catch (e: any) {
    ElMessage.error(e.message);
  }
}

async function changeModel(modelId: string) {
  if (!detail.value) return;
  try {
    await api.convoUpdate(detail.value.id, { model_id: modelId || null });
    detail.value.model_id = modelId || undefined;
    ElMessage.success(`主模型已切换为 ${modelId || '自动选模'}`);
    await loadConvos();
  } catch (e: any) {
    ElMessage.error(e.message);
  }
}

// ---------- 发送 / 插话 ----------
function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    send();
  }
}

async function onPickImages(e: Event) {
  const files = (e.target as HTMLInputElement).files;
  if (!files) return;
  for (const f of Array.from(files).slice(0, 3)) {
    if (f.size > 10 * 1024 * 1024) { ElMessage.warning(`${f.name} 超过 10MB`); continue; }
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
    if (f.size > 20 * 1024 * 1024) { ElMessage.warning(`${f.name} 超过 20MB`); continue; }
    pendingFiles.value.push(f);
  }
  (e.target as HTMLInputElement).value = '';
}

async function send() {
  if (!detail.value) return;
  const text = draft.value.trim();
  if (!text && !pendingImages.value.length && !pendingFiles.value.length && !pendingRefs.value.length) return;
  sending.value = true;
  try {
    let uploaded: ConvoFileRef[] = [];
    if (pendingFiles.value.length) {
      const r = await api.convoUploadFiles(detail.value.id, [...pendingFiles.value]);
      uploaded = r.files;
      pendingFiles.value = [];
    }
    const images = [...pendingImages.value];
    pendingImages.value = [];
    const refs = [...pendingRefs.value];
    pendingRefs.value = [];
    // @ 引用以行内文本形式随消息送达（agent 基于工作区路径读取）
    const refNote = refs.length ? `\n（引用项目文件：${refs.map((r) => '@' + r).join(' ')}）` : '';
    // 乐观上屏：不等 WS/刷新，发送即见（refreshActive 拉到真数据后自动替换）
    if (detail.value) {
      detail.value.messages.push({
        id: `tmp-${Date.now()}`, role: 'user', kind: 'text',
        text: text + (images.length ? '' : ''), ts: new Date().toISOString(),
        meta: { images: images.map((i) => ({ id: '', name: i.name, url: i.dataUrl })) },
      } as any);
      nextTick(() => { if (isNearEnd()) scrollEnd(); });
    }
    await api.convoSend(detail.value.id, { text: text + refNote, images: images.length ? images : undefined });
    draft.value = '';
    if (!busy.value) delete queuedCounts[detail.value.id];
    await refreshActive();
  } catch (e: any) {
    ElMessage.error(e.message);
  } finally {
    sending.value = false;
  }
}

async function stop() {
  if (!detail.value) return;
  try {
    await api.convoStop(detail.value.id);
    ElMessage.success('已停止当前执行');
  } catch (e: any) {
    ElMessage.error(e.message);
  }
}

// ---------- 审批 / 提问 ----------
async function resolveApproval(approvalId: string, action: 'once' | 'reject' | 'always') {
  if (!detail.value) return;
  try {
    await api.convoApprove(detail.value.id, approvalId, action);
    await refreshActive();
  } catch (e: any) {
    ElMessage.error(e.message);
  }
}

async function submitAsk(askId: string) {
  if (!detail.value || !askDraft.value.trim()) return;
  try {
    await api.convoAnswerAsk(detail.value.id, askId, askDraft.value.trim());
    askDraft.value = '';
    await refreshActive();
  } catch (e: any) {
    ElMessage.error(e.message);
  }
}

// ---------- diff / 回滚 / 预览 ----------
async function openDiff() {
  if (!detail.value) return;
  try {
    const r = await api.convoDiff(detail.value.id);
    diffFiles.value = r.files;
    diffPatch.value = r.patch;
    diffDlg.value = true;
  } catch (e: any) {
    ElMessage.error(e.message);
  }
}

function showDiffDialog(patch: string) {
  diffPatch.value = patch;
  diffFiles.value = [];
  diffDlg.value = true;
}

function lineClass(l: string) {
  return l.startsWith('+') ? 'add' : l.startsWith('-') ? 'del' : 'ctx';
}

async function rollback() {
  if (!detail.value) return;
  try {
    await ElMessageBox.confirm('回滚到会话首轮快照？工作区在本会话中的改动将被还原。', '回滚快照', { type: 'warning' });
  } catch { return; }
  try {
    await api.convoRollback(detail.value.id);
    ElMessage.success('已回滚');
    await refreshActive();
  } catch (e: any) {
    ElMessage.error(e.message);
  }
}

async function previewFile(p: string) {
  if (!detail.value) return;
  try {
    const r = await api.convoFile(detail.value.id, p);
    previewName.value = r.name;
    previewKind.value = r.kind;
    previewContent.value = r.content || '';
    previewDataUrl.value = r.dataUrl || '';
    fileDlg.value = true;
  } catch (e: any) {
    ElMessage.error(e.message);
  }
}

// ---------- WS 事件 ----------
let offEvent: (() => void) | null = null;
function onConvoResync() { if (activeId.value) refreshActive(); }
onMounted(async () => {
  await loadMeta();
  await loadConvos();
  // 断线重连补拉（useDashboard resyncAfterReconnect 只补拉 agents/tasks，会话消息靠此兜底）
  window.addEventListener('coteam:convo-resync', onConvoResync as EventListener);
  offEvent = onEvent((msg) => {
    const t = msg.type || '';
    if (!t.startsWith('convo_')) return;
    const p: any = msg.payload || {};
    if (t === 'convo_status') {
      const c = convos.value.find((x) => x.id === p.convo_id);
      if (c) c.status = p.status;
      if (p.convo_id === activeId.value && detail.value) {
        detail.value.status = p.status;
        if (p.status !== 'running') { reasonBuf.value = ''; clearToolLive(); streaming.value = false; }
      }
    } else if (t === 'convo_message') {
      const m = p.message;
      if (p.convo_id === activeId.value && detail.value && m) {
        if (!detail.value.messages.some((x) => x.id === m.id)) detail.value.messages.push(m);
        if (m.role === 'assistant' && m.kind === 'text') {
          // 最终回复替换流式气泡
          for (const k of Object.keys(streamBuf)) delete streamBuf[k];
          reasonBuf.value = '';
          clearToolLive();
          streaming.value = false;
        }
        nextTick(() => { if (isNearEnd()) scrollEnd(); });
      }
      loadConvos();
    } else if (t === 'convo_delta') {
      if (p.convo_id !== activeId.value) return;
      if (p.discarded) {
        for (const k of Object.keys(streamBuf)) delete streamBuf[k];
        reasonBuf.value = '';
        streaming.value = false;
        return;
      }
      streamBuf[p.stream_id] = (streamBuf[p.stream_id] || '') + (p.text || '');
      streaming.value = true;
      nextTick(() => { if (isNearEnd()) scrollEnd(); });
    } else if (t === 'convo_reason') {
      if (p.convo_id !== activeId.value) return;
      reasonBuf.value += p.text || '';
      streaming.value = true;
      nextTick(() => { if (isNearEnd()) scrollEnd(); });
    } else if (t === 'convo_plan') {
      if (p.convo_id === activeId.value && detail.value) detail.value.plan = p.plan;
      loadConvos();
    } else if (t === 'convo_queued') {
      queuedCounts[p.convo_id] = (queuedCounts[p.convo_id] || 0) + 1;
    } else if (t === 'convo_tool_start') {
      // 工具批次开始：实时步骤行（此前整批跑完才见，干活过程零可见）
      if (p.convo_id === activeId.value) {
        for (const c of p.calls || []) toolLive.value.push({ tool: c.tool || '', command: c.command || c.path || '' });
        streaming.value = true;
        nextTick(() => { if (isNearEnd()) scrollEnd(); });
      }
    } else if (t === 'convo_approval') {
      if (p.convo_id === activeId.value) refreshActive();
    } else if (t === 'convo_tool') {
      if (p.convo_id === activeId.value) refreshActive();
      if (p.convo_id === activeId.value) clearToolLive();
    }
  });
});

onBeforeUnmount(() => {
  offEvent?.();
  window.removeEventListener('coteam:convo-resync', onConvoResync as EventListener);
});
</script>

<style scoped>
.convo-page { display: flex; height: 100%; min-height: 0; }
.side { width: 272px; flex: none; background: var(--bg-panel); border-right: 1px solid var(--line); display: flex; flex-direction: column; min-height: 0; }
.side-search { padding: 10px 10px 6px; }
.side-list { flex: 1; overflow: auto; padding: 0 6px 6px; min-height: 0; }
.side-group { font-size: var(--fs-meta); color: var(--text-3); padding: 12px 8px 4px; }
.side-item { padding: 7px 9px; border-radius: var(--r-ctl); cursor: pointer; }
.side-item:hover { background: var(--bg-raised); }
.side-item.active { background: color-mix(in srgb, var(--accent) 10%, transparent); box-shadow: inset 2px 0 0 var(--accent); }
.side-item .t { display: flex; align-items: center; gap: 6px; font-size: var(--fs-aux); color: var(--text-1); }
.side-item .title { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.side-item .m { display: flex; gap: 6px; align-items: center; margin-top: 2px; font-size: var(--fs-meta); color: var(--text-3); }
.mtag { font-family: var(--font-mono); font-size: 10px; }
.st.warn { color: var(--warn); }
.dot { width: 6px; height: 6px; border-radius: 50%; background: var(--text-3); flex: none; }
.dot.run { background: var(--ok); }
.dot.waiting_approval, .dot.waiting_ask { background: var(--warn); }
.side-empty { color: var(--text-3); font-size: var(--fs-aux); padding: 20px 10px; text-align: center; }
.side-foot { padding: 10px; border-top: 1px solid var(--line); }
.new-btn { width: 100%; border-style: solid; }

.chat { flex: 1; display: flex; flex-direction: column; min-width: 0; min-height: 0; }
.chat-head { display: flex; align-items: center; gap: 10px; padding: 8px 16px; background: var(--bg-panel); border-bottom: 1px solid var(--line); flex: none; flex-wrap: wrap; }
.head-title { display: flex; align-items: center; gap: 4px; font-size: var(--fs-sub); font-weight: 600; }
.proj { font-size: var(--fs-meta); color: var(--text-3); font-family: var(--font-mono); width: 100%; order: 5; }
.head-right { margin-left: auto; display: flex; align-items: center; gap: 8px; }
.model-select { width: 190px; font-family: var(--font-mono); }
.perm-select { width: 190px; }
.auto-sw { display: inline-flex; align-items: center; gap: 6px; font-size: var(--fs-meta); color: var(--text-3); }

.stream { flex: 1; overflow-y: auto; padding: 16px 20px 8px; min-height: 0; }
.col { max-width: 860px; margin: 0 auto; display: flex; flex-direction: column; gap: 9px; }
.day-sep { text-align: center; font-size: 11px; color: var(--text-3); display: flex; align-items: center; gap: 14px; margin: 18px 0; }
.day-sep::before, .day-sep::after { content: ''; flex: 1; height: 1px; background: var(--line); }

/* 用户消息（轻量内联条） */
.user-row { display: flex; justify-content: flex-end; margin: 12px 0 8px; }
.user-msg { max-width: 78%; background: color-mix(in srgb, var(--accent) 11%, var(--bg-panel)); border: 1px solid color-mix(in srgb, var(--accent) 24%, transparent); border-radius: 12px 12px 3px 12px; padding: 10px 14px; font-size: 15px; line-height: 1.7; white-space: pre-wrap; overflow-wrap: anywhere; }
.user-msg .imgrow { display: flex; gap: 6px; margin-top: 8px; flex-wrap: wrap; }
.user-msg .imgrow .ph { width: 84px; height: 62px; border-radius: 6px; border: 1px solid var(--line-strong); }
.file-line { display: flex; align-items: center; gap: 6px; font-size: 12.5px; }
.file-line a { color: var(--accent); }
.dim { color: var(--text-3); font-size: 11px; }
.plain { white-space: pre-wrap; }

/* 轮次块 */
.turn { margin: 12px 0; border: 1px solid var(--line); border-radius: 12px; background: var(--bg-panel); overflow: hidden; box-shadow: 0 1px 3px rgba(0,0,0,.18); }
.turn.live { border-color: color-mix(in srgb, var(--ok) 30%, var(--line)); }
.turn-head { display: flex; align-items: center; gap: 9px; padding: 10px 16px; border-bottom: 1px solid var(--line); }
.t-avatar { width: 24px; height: 24px; border-radius: 7px; background: var(--accent); color: var(--accent-text); font-size: 12px; font-weight: 700; display: flex; align-items: center; justify-content: center; flex: none; }
.t-name { font-size: 14px; font-weight: 600; }
.t-model { font-family: var(--font-mono); font-size: 11px; color: var(--text-3); padding: 2px 8px; border: 1px solid var(--line); border-radius: 99px; }
.t-meta { margin-left: auto; display: flex; gap: 10px; font-size: 11px; color: var(--text-3); font-family: var(--font-mono); align-items: center; }
.t-running { display: inline-block; width: 7px; height: 7px; border-radius: 50%; background: var(--ok); margin-right: 2px; animation: livepulse 1.3s infinite; }
@keyframes livepulse { 0%,100% { opacity: 1; } 50% { opacity: .2; } }

/* 执行区 */
.acts { position: relative; padding: 10px 16px 6px; }
.acts::before { content: ''; position: absolute; left: 23px; top: 18px; bottom: 16px; width: 1px; background: linear-gradient(to bottom, var(--line-strong), transparent); }
.act-line { position: relative; display: flex; align-items: center; gap: 9px; padding: 5px 8px 5px 22px; border-radius: 7px; font-size: 12px; min-height: 30px; }
.act-line:hover { background: var(--bg-inset); }
.act-line::before { content: ''; position: absolute; left: 3px; top: 50%; transform: translateY(-50%); width: 7px; height: 7px; border-radius: 50%; background: var(--ok); box-shadow: 0 0 0 3px color-mix(in srgb, var(--ok) 14%, transparent); }
.act-line.err::before { background: var(--danger); box-shadow: 0 0 0 3px color-mix(in srgb, var(--danger) 14%, transparent); }
.act-line.live::before { background: var(--accent); box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 18%, transparent); animation: livepulse 1s infinite; }
.tool-tag { font-family: var(--font-mono); font-size: 10.5px; font-weight: 600; color: var(--text-1); background: var(--bg-inset); border: 1px solid var(--line); border-radius: 5px; padding: 2px 7px; flex: none; letter-spacing: .02em; }
.act-args { color: var(--text-1); font-family: var(--font-mono); font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.act-res { margin-left: auto; flex: none; font-family: var(--font-mono); font-size: 10.5px; color: var(--text-3); display: flex; gap: 6px; align-items: center; }
.act-res .pill { padding: 1px 8px; border-radius: 99px; border: 1px solid color-mix(in srgb, var(--ok) 35%, transparent); color: var(--ok); }
.act-res .pill.bad { border-color: color-mix(in srgb, var(--danger) 35%, transparent); color: var(--danger); }
.act-res .pill.dim { border-color: var(--line-strong); color: var(--text-3); }

/* 思考折叠 */
.think { border-top: 1px solid var(--line); }
.think > summary { list-style: none; display: flex; align-items: center; gap: 9px; padding: 10px 16px; font-size: 12px; color: var(--text-3); cursor: pointer; user-select: none; }
.think > summary::-webkit-details-marker { display: none; }
.think > summary .car { transition: transform .15s; font-size: 9px; display: inline-flex; }
.think[open] > summary .car { transform: rotate(90deg); }
.think > summary .tt { color: var(--text-2); font-weight: 600; }
.think > summary:hover .tt { color: var(--accent); }
.think-body { padding: 2px 0 14px; font-size: 12.5px; line-height: 1.85; color: var(--text-2); white-space: pre-wrap; overflow-wrap: anywhere; max-height: 260px; overflow-y: auto; border-left: 2px solid var(--line-strong); margin: 0 18px 0 32px; padding-left: 14px; }

/* 结论 */
.conclusion { padding: 16px 20px 8px; }
.conclusion .md { line-height: 1.85; font-size: 15px; overflow-wrap: anywhere; }
.conclusion .md :deep(p) { margin: 8px 0; }
.conclusion .md :deep(li) { margin: 5px 0 5px 20px; color: var(--text-1); }
.conclusion .md :deep(code) { font-family: var(--font-mono); font-size: 12.5px; background: var(--bg-inset); padding: 2px 6px; border-radius: 5px; border: 1px solid var(--line); }
.conclusion .md :deep(pre) { background: var(--bg-page); border: 1px solid var(--line); border-radius: 8px; padding: 12px 14px; font-family: var(--font-mono); font-size: 12.5px; line-height: 1.75; overflow-x: auto; margin: 10px 0; }

/* 轮次脚注 */
.turn-foot { display: flex; align-items: center; gap: 8px; padding: 10px 20px 14px; flex-wrap: wrap; }
.fchip { font-family: var(--font-mono); font-size: 11px; color: var(--text-2); border: 1px solid var(--line-strong); border-radius: 7px; padding: 4px 10px; display: inline-flex; gap: 7px; align-items: center; background: var(--bg-inset); }
.fbtn { margin-left: auto; }

/* 内联卡 */
.inline { margin: 10px 0 4px; border-radius: 9px; padding: 8px 14px; font-size: 12.5px; display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.inline.warn { border: 1px solid color-mix(in srgb, var(--warn) 30%, transparent); background: color-mix(in srgb, var(--warn) 7%, var(--bg-panel)); color: var(--warn); }
.inline.danger { border: 1px solid color-mix(in srgb, var(--danger) 30%, transparent); background: color-mix(in srgb, var(--danger) 7%, var(--bg-panel)); color: var(--danger); }
.inline .cmd { font-family: var(--font-mono); font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.inline .sp { flex: 1; }
.inline .fbtn { flex: none; }
.askcard { border: 1px solid color-mix(in srgb, var(--accent) 30%, transparent); background: color-mix(in srgb, var(--accent) 6%, var(--bg-panel)); color: var(--text-1); }
.ask-input { flex: 1; min-width: 140px; padding: 5px 10px; border-radius: 6px; border: 1px solid var(--line-strong); background: var(--bg-inset); color: var(--text-1); font-size: 12px; outline: none; }
.notice { margin: 8px 16px 0; font-size: 11.5px; color: var(--text-3); }
.notice.warn { border: 1px solid color-mix(in srgb, var(--warn) 30%, transparent); background: color-mix(in srgb, var(--warn) 7%, var(--bg-panel)); color: var(--warn); border-radius: 7px; padding: 6px 10px; }
.notice.think-placeholder { border: none; background: none; padding: 8px 16px 0; }
.acts-fold { position: relative; padding: 4px 16px 0; }
.acts-fold > summary { list-style: none; display: flex; align-items: center; gap: 8px; font-size: 12px; color: var(--text-2); padding: 5px 8px; border-radius: 7px; cursor: pointer; user-select: none; }
.acts-fold > summary:hover { background: var(--bg-inset); }
.acts-fold > summary .car { font-size: 10px; color: var(--text-3); transition: transform .15s; }
.acts-fold[open] > summary .car { transform: rotate(90deg); }
.acts-fold > summary .last-tool { font-family: var(--font-mono); font-size: 11px; color: var(--text-3); }
.interrupt-sep { display: flex; align-items: center; gap: 8px; color: var(--danger); font-size: 11.5px; margin: 10px 16px 0; }
.interrupt-sep .sq { width: 9px; height: 9px; border: 2px solid var(--danger); border-radius: 2px; flex: none; }
.interrupt-sep::after { content: ''; flex: 1; height: 1px; background: color-mix(in srgb, var(--danger) 30%, transparent); }

/* 步骤清单 */
.plan { padding: 10px 16px 0; }
.plan-pill { display: inline-flex; align-items: center; gap: 8px; font-size: 11.5px; color: var(--text-2); background: var(--bg-inset); border: 1px solid var(--line); border-radius: 99px; padding: 5px 13px; cursor: pointer; max-width: 100%; }
.plan-pill:hover { border-color: var(--accent); }
.plan-pill .plan-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--accent); flex: none; animation: livepulse 1.3s infinite; }
.plan-pill .plan-cur { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--text-1); }
.plan-pill .car { color: var(--text-3); font-size: 9px; }
.plan-full { border: 1px solid var(--line); border-radius: 9px; background: var(--bg-inset); padding: 8px 12px; }
.plan-head { display: flex; align-items: center; gap: 8px; font-size: 11.5px; color: var(--text-2); cursor: pointer; font-weight: 600; padding-bottom: 4px; }
.plan-head .car { color: var(--text-3); font-size: 9px; transform: rotate(90deg); display: inline-block; }
.plan-step { display: flex; align-items: center; gap: 9px; font-size: 12.5px; padding: 4px 0; color: var(--text-2); }
.plan-step .mark { width: 16px; text-align: center; flex: none; }
.plan-step.done .mark { color: var(--ok); }
.plan-step.done .txt { text-decoration: line-through; color: var(--text-3); }
.plan-step.in_progress { color: var(--text-1); }
.plan-step.in_progress .mark { color: var(--accent); animation: livepulse 1.2s infinite; }
.plan-step.blocked .mark { color: var(--danger); }

/* 变更汇总行 */
.changes { padding: 10px 16px 2px; display: flex; flex-direction: column; gap: 4px; font-family: var(--font-mono); font-size: 11.5px; }
.changes .sum { display: flex; gap: 10px; align-items: center; color: var(--text-2); cursor: pointer; }
.changes .sum .n { font-weight: 700; color: var(--text-1); }
.changes .sum .add { color: var(--ok); font-weight: 700; }
.changes .sum .del { color: var(--danger); font-weight: 700; }
.changes .sum .car { color: var(--text-3); font-size: 9px; transition: transform .15s; }
.changes .sum.open .car { transform: rotate(90deg); }
.changes .file { display: none; color: var(--text-2); padding-left: 20px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.changes .sum.open + .file { display: flex; gap: 10px; }

/* 结论操作行 */
.ops { display: flex; align-items: center; gap: 2px; padding: 8px 16px 2px; }
.ops button { font-size: 11.5px; color: var(--text-3); background: none; border: none; padding: 4px 9px; border-radius: 6px; cursor: pointer; display: inline-flex; align-items: center; gap: 5px; }
.ops button:hover { color: var(--text-1); background: var(--bg-inset); }
.ops button.on { color: var(--accent); }
.ops .ts { margin-left: auto; font-family: var(--font-mono); font-size: 10.5px; color: var(--text-3); }

/* 运行中 live 区（嵌轮内） */
.live-think { padding: 10px 16px 2px; }
.live-think .lab { font-size: 10.5px; color: var(--text-3); letter-spacing: .14em; margin-bottom: 3px; }
.live-scroll { max-height: 180px; }
.cursor { display: inline-block; width: 8px; height: 15px; background: var(--accent); vertical-align: -2px; animation: cursorbk 1s steps(2) infinite; }
@keyframes cursorbk { 50% { opacity: 0; } }

.queued { align-self: flex-end; display: inline-flex; align-items: center; gap: 5px; font-size: var(--fs-meta); color: var(--warn); padding: 2px 10px; border: 1px solid color-mix(in srgb, var(--warn) 40%, transparent); border-radius: 99px; }
.typing-bubble { opacity: .85; }

.composer { border-top: 1px solid var(--line); background: var(--bg-panel); padding: 10px 20px 12px; flex: none; }
.comp-r1 { display: flex; align-items: center; gap: 10px; margin-bottom: 8px; font-size: var(--fs-meta); color: var(--text-3); max-width: 860px; margin-left: auto; margin-right: auto; }
.comp-r1 .hint { color: var(--text-3); }
.chips { max-width: 860px; margin: 0 auto 7px; display: flex; flex-wrap: wrap; gap: 6px; }
.chip { display: inline-flex; align-items: center; gap: 5px; font-size: var(--fs-meta); padding: 3px 9px; border-radius: var(--r-ctl); border: 1px solid var(--line-strong); background: var(--bg-inset); color: var(--text-2); }
.chip b { cursor: pointer; display: inline-flex; }
.chip b:hover { color: var(--danger); }
.chip.img { color: var(--text-1); border-color: color-mix(in srgb, var(--accent) 35%, transparent); }
.comp-r2 { display: flex; gap: 10px; align-items: flex-end; max-width: 860px; margin: 0 auto; }
.ta-wrap { flex: 1; position: relative; }
.ta-tools { position: absolute; right: 8px; bottom: 6px; display: flex; gap: 2px; }
.stop-btn, .send-btn { height: 44px; }
.send-btn { padding: 0 20px; }

.syscard.subagent > .hd { color: var(--text-1); }
.subagent-name { color: var(--ag-dev); font-weight: 600; flex: none; }
.sub-summary { font-size: var(--fs-aux); color: var(--text-1); padding: 4px 12px 6px; }
.side-item .del-btn { margin-left: auto; opacity: 0; flex: none; color: var(--text-3); transition: opacity .12s; }
.side-item .del-btn:hover { color: var(--danger); }
.side-item:hover .del-btn { opacity: 1; }

.live-card { min-width: 0; max-width: 720px; border: 1px solid var(--line-strong); border-radius: var(--r-panel); background: var(--bg-panel); padding: 10px 14px; }
.live-dot { display: inline-block; width: 6px; height: 6px; border-radius: 50%; background: var(--ok); margin-left: 6px; animation: livepulse 1.4s infinite; }
@keyframes livepulse { 0%,100% { opacity: 1; } 50% { opacity: .25; } }
.live-sect { margin-top: 6px; }
.live-sect:first-of-type { margin-top: 0; }
.live-label { font-size: var(--fs-meta); color: var(--text-3); letter-spacing: .08em; margin-bottom: 3px; }
.live-scroll { max-height: 180px; overflow-y: auto; }
.live-tools { max-height: 180px; overflow-y: auto; display: flex; flex-direction: column; gap: 2px; }
.live-tool-line { font-family: var(--font-mono); font-size: var(--fs-meta); color: var(--text-2); }
.live-content { border-left: 2px solid var(--accent); padding-left: 10px; max-height: 320px; overflow-y: auto; }

.think-details { font-size: var(--fs-meta); color: var(--text-3); border: 1px solid var(--line); border-radius: var(--r-ctl); background: var(--bg-inset); padding: 4px 8px; margin-bottom: 6px; }
.think-details summary { cursor: pointer; user-select: none; color: var(--text-3); }
.think-details[open] summary { margin-bottom: 4px; }
.think-body { white-space: pre-wrap; overflow-wrap: anywhere; max-height: 260px; overflow-y: auto; color: var(--text-2); line-height: 1.6; font-size: var(--fs-meta); }
.think-body.mono-pre { font-family: var(--font-mono); }
.bubble-think { display: block; margin-bottom: 4px; }

.atpanel { border: 1px solid var(--line-strong); border-radius: var(--r-panel); background: var(--bg-overlay); padding: 8px; margin-bottom: 8px; max-width: 860px; margin-left: auto; margin-right: auto; }
.atlist { max-height: 180px; overflow: auto; margin-top: 6px; }
.atlist .ai { display: flex; align-items: center; gap: 6px; padding: 5px 9px; font-family: var(--font-mono); font-size: var(--fs-meta); color: var(--text-2); cursor: pointer; border-radius: 4px; }
.atlist .ai:hover { background: var(--bg-raised); color: var(--text-1); }
.at-none { color: var(--text-3); font-size: var(--fs-meta); padding: 6px 9px; }

.chat-empty { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 10px; color: var(--text-3); }
.chat-empty .big { font-size: var(--fs-sub); color: var(--text-2); }
.chat-empty .sm { font-size: var(--fs-aux); }

.diff-files { font-family: var(--font-mono); font-size: var(--fs-meta); color: var(--text-2); white-space: pre-wrap; border-bottom: 1px solid var(--line); padding-bottom: 8px; margin-bottom: 8px; }
.diff-patch { font-family: var(--font-mono); font-size: 12px; line-height: 1.7; max-height: 60vh; overflow: auto; white-space: pre-wrap; overflow-wrap: anywhere; }
.diff-patch .add { background: color-mix(in srgb, var(--ok) 12%, transparent); color: var(--ok); display: block; }
.diff-patch .del { background: color-mix(in srgb, var(--danger) 12%, transparent); color: var(--danger); display: block; }
.diff-patch .ctx { color: var(--text-2); display: block; }
.preview-img { max-width: 100%; }
.preview-text { font-family: var(--font-mono); font-size: 12px; line-height: 1.7; max-height: 60vh; overflow: auto; white-space: pre-wrap; overflow-wrap: anywhere; }
</style>
