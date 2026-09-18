<script setup lang="ts">
import { computed, nextTick, onMounted, reactive, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { showToast, showImagePreview } from 'vant';
import { renderMd as renderMdShared } from '../utils/md';
import { api } from '../api';
import type { ProjectSummary, DiscussionMessage } from '../api';
import { useDiscussion } from '../composables/useDiscussion';
import { agentColor } from '../utils/agentColor';
import { copyText } from '../utils/clipboard';
import AgentAvatar from '../components/AgentAvatar.vue';
import MdView from '../components/MdView.vue';
import DirPicker from '../components/DirPicker.vue';

defineOptions({ name: 'DiscussionDetailView' });

const route = useRoute();
const router = useRouter();
const { current, experiences, roles, busy, thinking, activity, streams, memberActivity, open, send, react, round, stop, generateScheme, saveScheme, setMode, convert } = useDiscussion();

const discId = computed(() => String(route.params.id));
const draft = ref('');
const stickToBottom = ref(true);
const wrapEl = ref<HTMLElement | null>(null);
/** 打开失败（已删除/404）：明确错误态，替代永远"加载中" */
const loadFailed = ref(false);

const members = computed(() => current.value?.members || []);
const status = computed(() => current.value?.status || 'discussing');
const converted = computed(() => status.value === 'converted');
/** 转任务不封存：本讨论转出的任务数 */
const taskCount = computed(() => current.value?.task_ids?.length || (current.value?.task_id ? 1 : 0));
const pendingUser = computed(() => !!current.value?.pending_user);
const anyStreaming = computed(() => Object.keys(streams).length > 0);

// ---------- 转任务确认卡（agent 发起 → 用户拍板，与 web 同行为） ----------
const cvResolving = ref('');
const cvId = (row: { m?: DiscussionMessage }) => String(((row.m?.meta as any)?.convert_confirm?.id || ''));
async function resolveConvert(row: { m?: DiscussionMessage }, action: 'confirm' | 'cancel') {
  const confirmId = cvId(row);
  if (!confirmId || !current.value || cvResolving.value) return;
  cvResolving.value = confirmId;
  try {
    const r = await api.resolveDiscussionConvert(current.value.id, confirmId, action);
    showToast(action === 'confirm' ? (r.task_id ? `已确认，任务 ${r.task_id} 已创建并开工` : '已确认，任务已创建并开工') : '已取消转任务，继续讨论');
    // 卡片状态与讨论状态经 discussion_convert_resolved 事件回写（store 内统一处理）
  } catch (e: any) {
    showToast(String(e?.message || e));
  } finally {
    cvResolving.value = '';
  }
}

function roleOf(name: string): string {
  if (name === 'user') return '我';
  return roles.value[name] || name;
}

// ---------- P2-4 并行活动（双端一致）：多成员同时动手/输入/排队一眼可见 ----------
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

// ---------- 消息行模型（与 web DiscussionChat 同构：分组/系统卡片/工具条/引用） ----------

// M5.2 ③：群内直接回答任务的 ask_user 提问（可附图）
const answeredAskIds = ref<Set<string>>(new Set());
const askDrafts = ref<Record<string, string>>({});
const answeringAsk = ref('');
/** ask 回答的待发附图（ask_id -> 数组），随 answerAsk 提交 */
const askImgs = ref<Record<string, { url?: string; name?: string; dataUrl?: string; file?: File }[]>>({});
const askImgInputEl = ref<HTMLInputElement | null>(null);
const askImgTarget = ref('');
function pickAskImage(askId: string) {
  askImgTarget.value = askId;
  askImgInputEl.value?.click();
}
async function onPickAskImage(e: Event) {
  const input = e.target as HTMLInputElement;
  const files = [...(input.files || [])];
  input.value = '';
  const askId = askImgTarget.value;
  const ACCEPT = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/bmp']);
  for (const f of files) {
    const cur = askImgs.value[askId] || [];
    if (cur.length >= 3) { showToast('最多附 3 张图'); break; }
    if (!ACCEPT.has(f.type)) { showToast(`${f.name}：不支持的图片类型`); continue; }
    if (f.size > 10 * 1024 * 1024) { showToast(`${f.name} 超过 10MB`); continue; }
    const dataUrl = await new Promise<string>((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(String(r.result));
      r.onerror = () => reject(new Error('read failed'));
      r.readAsDataURL(f);
    }).catch(() => { showToast(`${f.name} 读取失败`); return ''; });
    if (!dataUrl) continue;
    askImgs.value[askId] = [...cur, { url: dataUrl, name: f.name, dataUrl }];
  }
}
async function sendAskAnswer(bridge: { task_id: string; ask_id: string }) {
  const text = (askDrafts.value[bridge.ask_id] || '').trim();
  const imgs = (askImgs.value[bridge.ask_id] || []).filter((p) => p.dataUrl).map((p) => ({ name: p.name || 'image', dataUrl: p.dataUrl as string }));
  if ((!text && !imgs.length) || answeringAsk.value) return;
  answeringAsk.value = bridge.ask_id;
  try {
    await api.answerAsk(bridge.task_id, bridge.ask_id, text, imgs.length ? imgs : undefined);
    answeredAskIds.value = new Set([...answeredAskIds.value, bridge.ask_id]);
    askDrafts.value[bridge.ask_id] = '';
    askImgs.value[bridge.ask_id] = [];
    showToast('已回答，agent 将继续执行');
  } catch (e: any) {
    showToast(e?.message || '回答失败');
  } finally {
    answeringAsk.value = '';
  }
}

const GROUP_GAP_MS = 3 * 60 * 1000;
const TIME_GAP_MS = 10 * 60 * 1000;
type ChatRow = { type: 'chat'; m: DiscussionMessage; side: 'me' | 'them'; head: boolean; tail: boolean; answered?: boolean; quote?: { who: string; text: string } };
type Row =
  | { type: 'time'; label: string }
  | { type: 'sys'; m: DiscussionMessage }
  | { type: 'tool'; m: DiscussionMessage }
  | ChatRow;

const rows = computed<Row[]>(() => {
  const msgs = current.value?.messages || [];
  const lastUserIdx = msgs.map((m) => m.from).lastIndexOf('user');
  const byId = new Map(msgs.map((m) => [m.id, m]));
  const tsOf = (m: DiscussionMessage) => (m.ts ? new Date(m.ts.replace(' ', 'T')).getTime() : 0);
  const out: Row[] = [];
  let lastTs = 0;
  let prevChat: ChatRow | null = null;
  for (let i = 0; i < msgs.length; i++) {
    const m = msgs[i];
    const ts = tsOf(m);
    if (ts - lastTs > TIME_GAP_MS) { out.push({ type: 'time', label: fmtTime(m.ts) }); prevChat = null; }
    lastTs = ts || lastTs;
    if (m.from === 'system') { out.push({ type: 'sys', m }); prevChat = null; continue; }
    if (m.tool) { out.push({ type: 'tool', m }); continue; }
    const side: 'me' | 'them' = m.from === 'user' ? 'me' : 'them';
    const head = !prevChat || prevChat.m.from !== m.from || ts - tsOf(prevChat.m) > GROUP_GAP_MS;
    const row: ChatRow = {
      type: 'chat', m, side, head, tail: false,
      answered: !!m.needs_user && lastUserIdx > i,
      quote: m.reply_to ? quoteOf(byId.get(m.reply_to)) : undefined,
    };
    if (prevChat) prevChat.tail = !head;
    out.push(row);
    prevChat = row;
  }
  if (prevChat) prevChat.tail = true;
  return out;
});

function quoteOf(src?: DiscussionMessage) {
  if (!src) return undefined;
  return { who: src.from === 'user' ? '我' : roleOf(src.from), text: src.text.slice(0, 40) };
}

function fmtTime(ts: string): string {
  if (!ts) return '';
  const d = new Date(ts.replace(' ', 'T'));
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  return d.toDateString() === new Date().toDateString() ? hm : `${d.getMonth() + 1}月${d.getDate()}日 ${hm}`;
}

function hasReactions(m: DiscussionMessage): boolean {
  return !!m.reactions && Object.keys(m.reactions).length > 0;
}

/** 共享渲染 + @点名高亮：只作用于纯文本段，不误伤代码块内容与标签属性 */
function md(text: string): string {
  const html = renderMdShared(text);
  return html.split(/(<pre[\s\S]*?<\/pre>|<code[\s\S]*?<\/code>|<[^>]*>)/g)
    .map((part) => (part.startsWith('<') ? part : part.replace(/@([A-Za-z0-9_\-\u4e00-\u9fff]+)/g, '<span class="mention">@$1</span>')))
    .join('');
}

// ---------- 滚动 ----------
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
watch(() => [current.value?.messages.length, Object.keys(streams).length, thinking.value], () => void nextTick(() => scrollToBottom()));
onMounted(() => {
  void open(discId.value).then((ok) => { if (!ok) loadFailed.value = true; });
  void nextTick(() => scrollToBottom(true));
});

// ---------- 发送 / 插话 ----------
// ---------- 用户附图（与 web 同一行为契约：最多 3 张、单张 ≤10MB、纯图消息可发） ----------
const pendingImages = ref<{ url?: string; name?: string; dataUrl?: string; file?: File }[]>([]);
const sending = ref(false);
const imgInputEl = ref<HTMLInputElement | null>(null);
function rowImgUrls(m: DiscussionMessage): string[] {
  const imgs = (m.meta as any)?.images;
  return Array.isArray(imgs) ? imgs.map((i: any) => String(i.url || '')).filter(Boolean) : [];
}
function pickImages() {
  imgInputEl.value?.click();
}
async function onPickImages(e: Event) {
  const input = e.target as HTMLInputElement;
  const files = [...(input.files || [])];
  input.value = '';
  const ACCEPT = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/bmp']);
  for (const f of files) {
    if (pendingImages.value.length >= 3) { showToast('最多附 3 张图'); break; }
    if (!ACCEPT.has(f.type)) { showToast(`${f.name}：不支持的图片类型`); continue; }
    if (f.size > 10 * 1024 * 1024) { showToast(`${f.name} 超过 10MB`); continue; }
    const dataUrl = await new Promise<string>((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(String(r.result));
      r.onerror = () => reject(new Error('read failed'));
      r.readAsDataURL(f);
    }).catch(() => { showToast(`${f.name} 读取失败`); return ''; });
    if (!dataUrl) continue;
    pendingImages.value = [...pendingImages.value, { url: dataUrl, name: f.name, dataUrl }];
  }
}
function imagePayload() {
  return pendingImages.value
    .filter((p) => p.dataUrl)
    .map((p) => ({ name: p.name || 'image', dataUrl: p.dataUrl as string }));
}
async function sendNow() {
  const text = draft.value.trim();
  const imgs = imagePayload();
  if ((!text && !imgs.length) || sending.value) return;
  sending.value = true;
  try {
    await send(text, { ...(replyTo.value ? { reply_to: replyTo.value } : {}), images: imgs.length ? imgs : undefined });
    draft.value = '';
    pendingImages.value = [];
    replyTo.value = null;
    stickToBottom.value = true;
    await nextTick();
    scrollToBottom(true);
  } catch (e: any) {
    showToast(String(e?.message || e));
  } finally {
    sending.value = false;
  }
}

const replyTo = ref<string | null>(null);
const replyPreview = computed(() => {
  const src = (current.value?.messages || []).find((x) => x.id === replyTo.value);
  return src ? `${roleOf(src.from)}：${src.text.slice(0, 24)}` : '';
});

async function onReact(m: DiscussionMessage, emoji: string) {
  if (m.reactions?.[emoji]?.includes('user')) { showToast('已经回应过了'); return; }
  try { await react(m.id, emoji); } catch (e: any) { showToast(String(e?.message || e)); }
}

// ---------- 长按气泡动作面板 ----------
const msgSheet = reactive({ show: false, msg: null as DiscussionMessage | null });
let lpTimer: ReturnType<typeof setTimeout> | null = null;
/** M10-A 长按容差：手指微动 <10px 不取消（此前 1px 移动就 cancel，长按几乎无法触发） */
let lpStartPos: { x: number; y: number } | null = null;
function lpStart(e: TouchEvent, m: DiscussionMessage) {
  const t = e.touches?.[0];
  lpStartPos = t ? { x: t.clientX, y: t.clientY } : null;
  lpTimer = setTimeout(() => {
    msgSheet.msg = m;
    msgSheet.show = true;
  }, 500);
}
function lpMove(e: TouchEvent) {
  if (!lpStartPos || !lpTimer) return;
  const t = e.touches?.[0];
  if (!t) return;
  if (Math.abs(t.clientX - lpStartPos.x) > 10 || Math.abs(t.clientY - lpStartPos.y) > 10) lpCancel();
}
function lpCancel() {
  if (lpTimer) { clearTimeout(lpTimer); lpTimer = null; }
}
/** Vant action-sheet 的 select 事件参数是 action 对象（含 name），不是字符串 */
function msgSheetSelect(action: any) {
  const name = String(action?.name || '');
  const m = msgSheet.msg;
  msgSheet.show = false;
  if (!m || !name) return;
  if (name === 'reply') {
    replyTo.value = m.id;
  } else if (name === 'copy') {
    void copyText(m.text).then((ok) => showToast(ok ? '已复制' : '复制失败（浏览器限制）'));
  } else if (name === 'detail') {
    detailMsg.value = m;
    detailSheet.value = true;
  } else if (name.startsWith('react:')) {
    void onReact(m, name.slice(6));
  }
}
const msgActions = computed(() => {
  const m = msgSheet.msg;
  const list: { name: string; text: string }[] = [
    { name: 'reply', text: '↩ 引用回复' },
    { name: 'react:👍', text: m?.reactions?.['👍'] ? '👍 已回应' : '👍 同意' },
    { name: 'react:✅', text: m?.reactions?.['✅'] ? '✅ 已回应' : '✅ 收到/已解决' },
    { name: 'react:👀', text: m?.reactions?.['👀'] ? '👀 已回应' : '👀 在看' },
    { name: 'copy', text: '⧉ 复制' },
  ];
  // P1-3 明细抽屉：有工作过程的消息可查看详细（思路/工具调用/技能/协作）
  if (m && hasDetail(m)) list.unshift({ name: 'detail', text: '🔍 查看工作明细' });
  return list;
});

// ---------- P1-3 工作明细（工具树 + 底部抽屉详情） ----------
const CODE_TOOLS = /^(read_file|read|read_dir|readdir|list_files|list|ls|grep|search|git_log|git_diff)$/;
const CMD_TOOLS = /^(exec|exec_command|run_command|exec_background|start_process|kill_process|check_page|screenshot|look_image)$/;
const DOC_TOOLS = /^(write_knowledge|write_doc)$/;
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

/** 本批工具失败数（头行红点/失败计数用） */
function toolFailCount(m: DiscussionMessage): number {
  return toolCallsOf(m).filter((c: any) => c.ok === false).length;
}
// ---------- P2-8 小改回滚 ----------
const undoingMsg = ref<Set<string>>(new Set());
async function undoWrites(m: DiscussionMessage) {
  const ids = toolCallsOf(m).map((c: any) => c.undo_id).filter(Boolean);
  if (!ids.length || undoingMsg.value.has(m.id)) return;
  undoingMsg.value = new Set([...undoingMsg.value, m.id]);
  try {
    const r = await api.undoDiscussionWrites(discId.value, ids);
    showToast(r.reverted.length ? `已回滚 ${r.reverted.length} 个文件` : '没有需要回滚的改动');
  } catch (e: any) {
    showToast(String(e?.message || e));
    undoingMsg.value = new Set([...undoingMsg.value].filter((x) => x !== m.id));
  }
}
function hasDetail(m: DiscussionMessage): boolean {
  const meta: any = m.meta || {};
  return !!(meta.detail?.tool_calls?.length || meta.detail?.evidence || meta.detail?.skills?.length || meta.detail?.mentioned?.length || meta.calls?.length);
}
const detailSheet = ref(false);
const detailMsg = ref<DiscussionMessage | null>(null);
function openDetail(m: DiscussionMessage) {
  detailMsg.value = m;
  detailSheet.value = true;
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

// ---------- @点名 ----------
const mentionSheet = ref(false);
const mentionActions = computed(() => members.value.map((m) => ({ name: m, text: `@${m}（${roleOf(m)}）` })));
function pickMention(action: any) {
  const name = String(action?.name || '');
  mentionSheet.value = false;
  if (!name) return;
  draft.value = (draft.value + (draft.value && !draft.value.endsWith(' ') ? ' ' : '') + `@${name} `).slice(0, 4000);
}

// ---------- 成员资料 ----------
const memberSheet = ref(false);

// ---------- 导航右侧操作（popover） ----------
const showOps = ref(false);
const opsActions = computed(() => {
  const list: { text: string }[] = [];
  list.push(busy.value ? { text: '⏹ 打断并停止' } : { text: '▶ 让成员继续' });
  list.push(current.value?.mode === 'auto' ? { text: '🔁 切到手动模式' } : { text: '🔁 切到自动模式' });
  list.push({ text: current.value?.scheme ? `📄 查看方案 v${current.value.scheme_version}` : '📄 生成方案' });
  // 转任务不封存（2026-09-15）：已转任务仍可查看，且可继续讨论后再转后续任务
  if (current.value?.task_id) list.push({ text: `🚀 查看开发任务${taskCount.value > 1 ? `（共 ${taskCount.value} 个）` : ''}` });
  list.push({ text: '🚀 转为项目开发' });
  list.push({ text: `💡 沉淀经验${experiences.value.length ? ` (${experiences.value.length})` : ''}` });
  list.push({ text: '👥 群成员' });
  return list;
});
async function onOpsSelect(_action: any, { index }: { index: number }) {
  showOps.value = false;
  const list: { text: string }[] = opsActions.value;
  const label = list[index]?.text || '';
  try {
    if (label.includes('打断并停止')) await stop();
    else if (label.includes('让成员继续')) await round();
    else if (label.includes('切到手动')) await setMode('manual');
    else if (label.includes('切到自动')) await setMode('auto');
    else if (label.includes('生成方案')) {
      genLoading.value = true;
      await generateScheme();
      genLoading.value = false;
      showScheme.value = true;
    } else if (label.includes('查看方案')) showScheme.value = true;
    else if (label.includes('查看开发任务')) router.push(`/task/${current.value!.task_id}`);
    else if (label.includes('转为项目开发')) await openConvert();
    else if (label.includes('沉淀经验')) showExp.value = true;
    else if (label.includes('群成员')) memberSheet.value = true;
  } catch (e: any) {
    showToast(String(e?.message || e));
  }
}

// ---------- 方案弹层 ----------
const showScheme = ref(false);
const genLoading = ref(false);
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
/** 方案纯文摘（去 markdown，前 400 字）：确认前让用户看到任务大概内容 */
const schemeDigest = computed(() => {
  const s = current.value?.scheme || '';
  if (!s) return '';
  const plain = s.replace(/```[\s\S]*?```/g, ' ').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/[#>*`]+/g, '').replace(/\s+/g, ' ').trim();
  return plain.slice(0, 400) + (plain.length > 400 ? '…' : '');
});
/** 未拍板事项数（最后一条用户消息之后的 needs_user 消息） */
const pendingCount = computed(() => {
  const msgs = current.value?.messages || [];
  const lastUser = msgs.map((m) => m.from).lastIndexOf('user');
  return msgs.slice(lastUser + 1).filter((m) => m.needs_user).length;
});
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
    <van-nav-bar safe-area-inset-top left-arrow fixed placeholder @click-left="router.back()">
      <template #title>
        <div class="nav-title">{{ current?.title || '群组讨论' }}</div>
        <div class="nav-sub">{{ current ? `${members.length} 人群聊 · ${current.scheme ? `方案 v${current.scheme_version}` : (current.project_id ? '已绑定项目，可动手' : '未绑定项目')} · ${current.mode === 'auto' ? '自动' : '手动'}` : '' }}</div>
      </template>
      <template #right>
        <span class="nav-avs">
          <AgentAvatar v-for="m in members.slice(0, 4)" :key="m" :name="m" :size="22" class="nav-av" :title="roleOf(m)" @click="memberSheet = true" />
        </span>
        <van-popover v-model:show="showOps" :actions="opsActions" placement="bottom-end" @select="onOpsSelect">
          <template #reference><van-icon name="ellipsis" class="nav-op" /></template>
        </van-popover>
      </template>
    </van-nav-bar>

    <div ref="wrapEl" class="stream" @scroll="onScroll">
      <div v-if="loadFailed" class="center-tip">讨论不存在或已被删除<br /><button class="wx-btn err-back" @click="router.back()">返回列表</button></div>
      <div v-else-if="!current" class="center-tip">加载中…</div>
      <div v-else-if="!rows.length" class="center-tip">还没有聊天内容<br />发一条消息——成员谁有话说谁上</div>

      <template v-for="(row, i) in rows" :key="row.type === 'time' ? `t${i}${row.label}` : row.type === 'sys' || row.type === 'tool' ? `${row.type}${row.m.id}` : row.m.id">
        <div v-if="row.type === 'time'" class="time-divider">{{ row.label }}</div>

        <div v-else-if="row.type === 'sys'" class="sys-row">
          <!-- M5.2 ③：任务 ask_user 提问卡片——可在群里直接回答 -->
          <div v-if="row.m.kind === 'card' && row.m.meta?.bridge_ask" class="sys-card ask-card">
            <div class="ask-q">{{ row.m.text }}</div>
            <div v-if="!answeredAskIds.has(String(row.m.meta.bridge_ask.ask_id))" class="ask-col">
              <div class="ask-row">
                <input
                  v-model="askDrafts[String(row.m.meta.bridge_ask.ask_id)]"
                  class="ask-input"
                  placeholder="在群里直接回答，agent 将立即继续…"
                  @keydown.enter="sendAskAnswer(row.m.meta.bridge_ask)"
                />
                <span class="at-btn sm" @click="pickAskImage(String(row.m.meta.bridge_ask.ask_id))">📷</span>
                <van-button size="small" type="primary" :loading="answeringAsk === String(row.m.meta.bridge_ask.ask_id)" @click="sendAskAnswer(row.m.meta.bridge_ask)">回答</van-button>
              </div>
              <van-uploader
                v-if="(askImgs[String(row.m.meta.bridge_ask.ask_id)] || []).length"
                v-model="askImgs[String(row.m.meta.bridge_ask.ask_id)]"
                :max-count="3"
                :deletable="true"
                :show-upload="false"
                class="ask-uploader"
              />
            </div>
            <div v-else class="ask-done">✓ 已回答，agent 继续执行中</div>
          </div>
          <!-- 2026-09-15 转任务确认卡：agent 发起转任务先过用户拍板，确认才开工 -->
          <div v-else-if="row.m.kind === 'card' && row.m.meta?.convert_confirm" class="sys-card cv-card">
            <div class="cv-text">{{ row.m.text }}</div>
            <div v-if="String(row.m.meta.convert_confirm.state) === 'pending'" class="cv-row">
              <van-button size="small" type="primary" :loading="cvResolving === cvId(row)" @click="resolveConvert(row, 'confirm')">确认转任务</van-button>
              <van-button size="small" :loading="cvResolving === cvId(row)" @click="resolveConvert(row, 'cancel')">暂不转</van-button>
            </div>
            <div v-else class="cv-done" :class="{ off: String(row.m.meta.convert_confirm.state) === 'cancelled' }">
              {{ String(row.m.meta.convert_confirm.state) === 'confirmed' ? `✓ 已确认开工${row.m.meta.convert_confirm.task_id ? `，任务 ${row.m.meta.convert_confirm.task_id}` : ''}` : '✕ 已取消，继续讨论' }}
            </div>
          </div>
          <div v-else-if="row.m.kind === 'card'" class="sys-card">{{ row.m.text }}</div>
          <div v-else-if="row.m.kind === 'notice'" class="sys-notice"><span class="ic">⚙</span><span>{{ row.m.text }}</span></div>
          <span v-else class="sys-text">{{ row.m.text }}</span>
        </div>

        <div v-else-if="row.type === 'tool'" class="tool-block">
          <div class="tool-head" @click="toggleTool(row.m.id)">
            <span class="tool-caret mono">{{ expandedTools.has(row.m.id) ? '▾' : '▸' }}</span>
            <span class="tool-dot" :class="toolFailCount(row.m) ? 'err' : 'ok'"></span>
            <span class="tool-agent" :style="{ color: agentColor(row.m.from) }">{{ roleOf(row.m.from) }}</span>
            <span class="tool-text">{{ row.m.text }}</span>
            <span class="tool-meta mono"><b v-if="toolFailCount(row.m)" class="tool-fail">{{ toolFailCount(row.m) }} 失败</b><template v-if="toolFailCount(row.m)"> · </template>工具调用<template v-if="toolCallsOf(row.m).length"> × {{ toolCallsOf(row.m).length }}</template></span>
          </div>
          <div v-if="expandedTools.has(row.m.id)" class="tool-tree">
            <div v-for="(rec, ci) in toolCallsOf(row.m)" :key="ci" class="tool-call">
              <div class="tc-line mono">
                <span class="tc-icon mono">▸</span>
                <span class="tc-name">{{ rec.mcp ? `mcp:${rec.mcp.server}.${rec.mcp.tool}` : rec.tool }}</span>
                <span class="tc-status" :class="{ bad: rec.ok === false }">{{ rec.ok === false ? '✗' : '✓' }}</span>
              </div>
              <div v-if="rec.args_summary" class="tc-args mono">{{ rec.args_summary }}</div>
              <div v-if="rec.output_gist" class="tc-gist mono">{{ rec.output_gist }}</div>
              <!-- P2-8 小改：diff 落流 + 一键回滚 -->
              <div v-if="rec.diff" class="tc-diff mono">{{ rec.diff }}</div>
              <button v-if="rec.undo_id && !undoingMsg.has(row.m.id)" class="tc-undo" @click="undoWrites(row.m)">↩ 回滚此改动</button>
              <span v-else-if="rec.undo_id" class="tc-undo-done mono">✓ 已回滚</span>
            </div>
          </div>
        </div>

        <div v-else class="msg" :class="{ user: row.side === 'me' }"
          @touchstart="lpStart($event, row.m)"
          @touchend="lpCancel"
          @touchmove="lpMove"
          @contextmenu.prevent="lpCancel(); msgSheet.msg = row.m; msgSheet.show = true"
        >
          <div class="msg-av">
            <div v-if="row.head && row.side === 'me'" class="av-me">我</div>
            <AgentAvatar v-else-if="row.head" :name="row.m.from" :size="24" @click="memberSheet = true" />
          </div>
          <div class="msg-col">
            <div v-if="row.head" class="mhead">
              <span class="who" :style="{ color: row.side === 'me' ? 'var(--accent)' : agentColor(row.m.from) }">{{ roleOf(row.m.from) }}</span>
              <span v-if="row.m.model" class="who-model mono">{{ row.m.model }}</span>
              <span v-if="row.m.needs_user" class="ask-tag" :class="{ answered: row.answered }">{{ row.answered ? '已回复' : '待你拍板' }}</span>
              <span class="tail-ts mono">{{ fmtTime(row.m.ts) }}</span>
            </div>
            <div class="mbody">
              <div v-if="row.quote" class="quote-bar">↩ {{ row.quote.who }}：{{ row.quote.text }}</div>
              <!-- 用户附图：图片网格（点击 showImagePreview 大图） -->
              <div v-if="rowImgUrls(row.m).length" class="img-grid">
                <img
                  v-for="(u, i) in rowImgUrls(row.m)"
                  :key="u"
                  :src="u"
                  class="img-cell"
                  @click="showImagePreview({ images: rowImgUrls(row.m), startPosition: i })"
                />
              </div>
              <div v-if="row.m.text" class="b-text" v-html="md(row.m.text)"></div>
            </div>
            <div v-if="hasDetail(row.m)" class="detail-row"><span class="detail-chip" @click.stop="openDetail(row.m)">🔍 查看工作明细</span></div>
            <div v-if="hasReactions(row.m)" class="reactions">
              <button
                v-for="(users, emo) in row.m.reactions"
                :key="emo"
                class="react-chip"
                :class="{ mine: users.includes('user') }"
                @click="onReact(row.m, String(emo))"
              >{{ emo }} {{ users.length }}</button>
            </div>
          </div>
        </div>
      </template>

      <!-- 流式发言行（未定稿实时内容，头像列 + 打字光标） -->
      <div v-for="(s, sid) in streams" :key="sid" class="msg">
        <div class="msg-av"><AgentAvatar :name="s.agent" :size="24" /></div>
        <div class="msg-col">
          <div class="mhead">
            <span class="who" :style="{ color: agentColor(s.agent) }">{{ roleOf(s.agent) }}</span>
            <span class="live-label">正在输入…</span>
          </div>
          <div class="mbody"><span class="b-text dim">{{ s.text }}</span><span class="caret"></span></div>
        </div>
      </div>

      <div v-if="thinking === 'router' && !anyStreaming && !activeMembers.length" class="router-hint">
        <span class="dot"></span><span class="dot"></span><span class="dot"></span> 正在看消息，决定谁来回复…
      </div>
      <!-- P2-4 并行活动行（双端一致）：多成员同时动手/输入/排队一眼可见 -->
      <div v-else-if="activeMembers.length" class="parallel-line">
        <span v-for="(a, i) in activeMembers" :key="a" class="pl-chip">
          <span class="pl-dot" :style="{ background: agentColor(a) }"></span>
          {{ a }} {{ activityLabel(a) }}<span v-if="i < activeMembers.length - 1" class="pl-sep">·</span>
        </span>
      </div>
    </div>

    <div v-if="pendingUser" class="pending-bar">有成员需要你拍板，回复一条消息即可继续</div>

    <!-- 底部输入：微信式常驻一条，操作收进右上菜单 -->
    <div class="input-zone">
      <div v-if="replyTo" class="reply-bar">
        <span>↩ 回复「{{ replyPreview }}」</span>
        <span class="rb-x" @click="replyTo = null">×</span>
      </div>
      <div v-if="members.length" class="mention-row">
        <button v-for="m in members" :key="m" class="mention-chip" @click="draft = (draft + (draft && !draft.endsWith(' ') ? ' ' : '') + `@${m} `).slice(0, 4000)">
          <span class="mdot" :style="{ background: agentColor(m) }"></span>@{{ m }}
        </button>
      </div>
      <div class="input-row">
        <span class="at-btn" @click="mentionSheet = true">＠</span>
        <span class="at-btn" @click="pickImages">📷</span>
        <van-field
          v-model="draft"
          type="textarea"
          rows="1"
          autosize
          maxlength="4000"
          :placeholder="converted ? '已转任务——输入消息将重新开启群聊，继续沟通或再转新任务' : busy ? '成员在忙，插话即刻受理' : '说点什么…（@成员点名、发图、或让它动手）'"
          class="input-field"
          @keydown.enter.exact.prevent="sendNow"
        />
        <button class="send-btn" :disabled="sending || (!draft.trim() && !pendingImages.length)" @click="sendNow">
          <span v-if="!sending" class="mono">➤</span><van-loading v-else size="16" />
        </button>
      </div>
      <div class="inmode">
        <div class="mpill">
          <button :class="{ on: current?.mode !== 'auto' }" @click="setMode('manual')">手动</button>
          <button :class="{ on: current?.mode === 'auto' }" @click="setMode('auto')">自动</button>
        </div>
        <span class="lhint">长按消息可复制 / 引用 / 回应</span>
      </div>
    <!-- 待发图片条：van-uploader 受控（不发不落盘，随消息一起 dataURL 提交） -->
    <van-uploader
      v-if="pendingImages.length"
      v-model="pendingImages"
      :max-count="3"
      :deletable="true"
      :show-upload="false"
      class="pending-uploader"
    />
    <input ref="imgInputEl" type="file" accept="image/png,image/jpeg,image/webp,image/gif,image/bmp" multiple hidden @change="onPickImages" />
    <input ref="askImgInputEl" type="file" accept="image/png,image/jpeg,image/webp,image/gif,image/bmp" hidden @change="onPickAskImage" />
    </div>

    <!-- 长按/右键动作 -->
    <van-action-sheet v-model:show="msgSheet.show" :actions="msgActions" title="消息操作" close-on-click-action cancel-text="取消" @select="msgSheetSelect" />

    <!-- P1-3 工作明细抽屉：解决思路 / 工具调用 / SKILL / 协作 -->
    <van-popup v-model:show="detailSheet" position="bottom" round :style="{ maxHeight: '75%' }">
      <div v-if="detailMsg" class="dp-wrap">
        <div class="dp-grab"></div>
        <div class="dp-head">
          <span class="dp-title">
            <span class="dp-role" :style="{ color: agentColor(detailMsg.from) }">{{ roleOf(detailMsg.from) }}</span>
            <span class="dp-id mono">{{ detailMsg.from }}</span>
          </span>
          <span class="dp-close" @click="detailSheet = false">×</span>
        </div>
        <div class="dp-body">
          <template v-if="detailData">
            <div v-if="detailData.evidence" class="dp-sec">
              <div class="dp-sec-title">解决思路</div>
              <div class="dp-sec-body">{{ detailData.evidence }}</div>
            </div>
            <div v-if="groupedCalls.code.length" class="dp-sec">
              <div class="dp-sec-title">看了哪些代码（{{ groupedCalls.code.length }}）</div>
              <div v-for="(rec, i) in groupedCalls.code" :key="`c${i}`" class="dp-call mono">
                <div class="dp-call-line"><span class="tc-name">{{ rec.tool }}</span><span class="tc-status" :class="{ bad: rec.ok === false }">{{ rec.ok === false ? '✗' : '✓' }}</span></div>
                <div v-if="rec.args_summary" class="dp-call-args">{{ rec.args_summary }}</div>
                <div v-if="rec.output_gist" class="dp-call-gist">{{ rec.output_gist }}</div>
              </div>
            </div>
            <div v-if="groupedCalls.cmd.length" class="dp-sec">
              <div class="dp-sec-title">执行了什么命令（{{ groupedCalls.cmd.length }}）</div>
              <div v-for="(rec, i) in groupedCalls.cmd" :key="`x${i}`" class="dp-call mono">
                <div class="dp-call-line"><span class="tc-name">{{ rec.tool }}</span><span class="tc-status" :class="{ bad: rec.ok === false }">{{ rec.ok === false ? '✗' : '✓' }}</span></div>
                <div v-if="rec.args_summary" class="dp-call-args">{{ rec.args_summary }}</div>
                <div v-if="rec.output_gist" class="dp-call-gist">{{ rec.output_gist }}</div>
              </div>
            </div>
            <div v-if="groupedCalls.mcp.length" class="dp-sec">
              <div class="dp-sec-title">MCP 调用（{{ groupedCalls.mcp.length }}）</div>
              <div v-for="(rec, i) in groupedCalls.mcp" :key="`m${i}`" class="dp-call mono">
                <div class="dp-call-line"><span>🔌</span><span class="tc-name">{{ rec.mcp ? `${rec.mcp.server}.${rec.mcp.tool}` : rec.tool }}</span><span class="tc-status" :class="{ bad: rec.ok === false }">{{ rec.ok === false ? '✗' : '✓' }}</span></div>
                <div v-if="rec.args_summary" class="dp-call-args">{{ rec.args_summary }}</div>
                <div v-if="rec.output_gist" class="dp-call-gist">{{ rec.output_gist }}</div>
              </div>
            </div>
            <div v-if="groupedCalls.doc.length" class="dp-sec">
              <div class="dp-sec-title">文档与沉淀（{{ groupedCalls.doc.length }}）</div>
              <div v-for="(rec, i) in groupedCalls.doc" :key="`d${i}`" class="dp-call mono">
                <div class="dp-call-line"><span class="tc-name">{{ rec.tool }}</span><span class="tc-status" :class="{ bad: rec.ok === false }">{{ rec.ok === false ? '✗' : '✓' }}</span></div>
                <div v-if="rec.args_summary" class="dp-call-args">{{ rec.args_summary }}</div>
              </div>
            </div>
            <div v-if="detailData.skills?.length" class="dp-sec">
              <div class="dp-sec-title">绑定的 SKILL</div>
              <div class="dp-chips"><span v-for="s in detailData.skills" :key="s" class="dp-chip mono">{{ s }}</span></div>
            </div>
            <div v-if="detailData.mentioned?.length" class="dp-sec">
              <div class="dp-sec-title">协作</div>
              <div class="dp-chips"><span v-for="a in detailData.mentioned" :key="a" class="dp-chip mono">@{{ a }}（{{ roleOf(a) }}）</span></div>
            </div>
            <div class="dp-model mono">模型：{{ detailData.model }} · 第 {{ detailData.round }} 轮</div>
          </template>
          <div v-else class="dp-empty mono">这条消息还没有工作明细</div>
        </div>
      </div>
    </van-popup>

    <!-- @点名选择 -->
    <van-action-sheet v-model:show="mentionSheet" :actions="mentionActions" title="点名成员（只唤被点名者）" cancel-text="取消" close-on-click-action @select="pickMention" />

    <!-- 群成员 -->
    <van-popup v-model:show="memberSheet" position="bottom" round :style="{ maxHeight: '60%' }">
      <div class="sheet">
        <div class="sheet-head"><span class="sheet-title">群成员</span><span class="sheet-op" @click="memberSheet = false">关闭</span></div>
        <div v-for="m in members" :key="m" class="member-row">
          <AgentAvatar :name="m" :size="36" />
          <div class="member-info">
            <div class="member-role" :style="{ color: agentColor(m) }">{{ roleOf(m) }}</div>
            <div class="member-id">{{ m }}</div>
          </div>
        </div>
      </div>
    </van-popup>

    <!-- 方案弹层 -->
    <van-popup v-model:show="showScheme" position="bottom" round :style="{ height: '80%' }">
      <div class="sheet">
        <div class="sheet-head">
          <span class="sheet-title">项目规划方案 · v{{ current?.scheme_version || 0 }}</span>
          <span class="sheet-op" @click="showScheme = false">关闭</span>
        </div>
        <div v-if="!current?.scheme" class="center-tip">方案尚未生成——点右上菜单「生成方案」</div>
        <template v-else>
          <div v-if="!schemeEditing" class="scheme-md md" v-html="md(current.scheme)"></div>
          <van-field v-else v-model="schemeBuffer" type="textarea" rows="18" autosize />
          <div class="sheet-ops">
            <template v-if="schemeEditing">
              <van-button size="small" @click="schemeEditing = false">取消</van-button>
              <van-button size="small" type="primary" @click="saveEdit">保存（版本 +1）</van-button>
            </template>
            <template v-else>
              <van-button size="small" @click="startEdit">人工编辑</van-button>
              <van-button size="small" type="primary" :loading="genLoading" @click="generateScheme().then(() => showToast('方案已重新生成'))">重新生成</van-button>
            </template>
          </div>
        </template>
      </div>
    </van-popup>

    <!-- 转项目弹层 -->
    <van-popup v-model:show="showConvert" position="bottom" round :style="{ maxHeight: '80%' }">
      <div class="sheet">
        <div class="sheet-head"><span class="sheet-title">方案转项目开发</span><span class="sheet-op" @click="showConvert = false">关闭</span></div>
        <!-- 任务内容预览：转任务前先看清要建的是什么任务（2026-09-15，与 web 弹窗一致） -->
        <div class="cv-preview">
          <div v-if="schemeDigest" class="cv-preview-text">{{ schemeDigest }}</div>
          <div v-else class="cv-preview-text dim">方案尚未生成——请先在右上菜单「生成方案」后再转任务</div>
          <div class="cv-preview-meta">
            方案 v{{ current?.scheme_version || 0 }} · 共 {{ (current?.scheme || '').length }} 字
            <template v-if="pendingCount"> · 未拍板事项 {{ pendingCount }} 个（执行到相关决策点时按方案默认取向推进）</template>
          </div>
        </div>
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
          <MdView class="exp-body" :source="e.content" />
        </div>
      </div>
    </van-popup>
  </div>
</template>

<style scoped>
/* 预览样式（preview-mobile.html）：头像列消息流 / tooltree / notice / askcard / dtitle 明细抽屉 */
/* 用 100%（根容器为 100dvh）而非 100vh：地址栏展开时遮挡历史教训 */
.disc-detail { display: flex; flex-direction: column; height: 100%; background: var(--bg-page); }
.nav-title { font-size: var(--fs-sub); font-weight: 700; max-width: 56vw; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.nav-sub { font-size: var(--fs-meta); color: var(--text-3); font-weight: 400; margin-top: 1px; }
.nav-op { font-size: 20px; color: var(--text-1); margin-left: 10px; }
.nav-avs { display: inline-flex; }
.nav-av { margin-left: -6px; border: 1.5px solid var(--bg-panel); border-radius: 6px; }
.nav-av:first-child { margin-left: 0; }

.stream { flex: 1; overflow-y: auto; padding: 10px 12px 4px; display: flex; flex-direction: column; gap: 2px; }
.center-tip { text-align: center; color: var(--text-3); font-size: var(--fs-aux); padding: 40px 20px; line-height: 1.8; }
.err-back { margin-top: 12px; }

/* 时间分隔（两侧发丝线） */
.time-divider { display: flex; align-items: center; gap: 10px; color: var(--text-3); font-size: var(--fs-meta); margin: 10px 0 4px; }
.time-divider::before, .time-divider::after { content: ''; flex: 1; height: 1px; background: var(--line); }

/* ---------- 系统形态 ---------- */
.sys-row { display: flex; justify-content: center; margin: 4px 0; }
.sys-text { font-size: var(--fs-meta); color: var(--text-3); background: var(--bg-inset); border: 1px solid var(--line); border-radius: var(--r-panel); padding: 3px 10px; max-width: 88%; text-align: center; }
.sys-notice {
  display: flex; gap: 8px; align-items: flex-start; max-width: 92%; margin: 8px auto;
  padding: 8px 11px; border-radius: var(--r-panel);
  background: color-mix(in srgb, var(--warn) 7%, transparent);
  border: 1px solid color-mix(in srgb, var(--warn) 22%, transparent);
  color: var(--text-2); font-size: 12.5px; line-height: 1.5;
}
.sys-notice .ic { color: var(--warn); flex: none; margin-top: 1px; }
.sys-card { font-size: var(--fs-aux); color: var(--text-1); background: var(--bg-panel); border: 1px solid var(--line-strong); border-radius: var(--r-panel); padding: 9px 14px; max-width: 86%; text-align: center; }
/* ask 提问卡（accent 左缘） */
.ask-card { text-align: left; max-width: 92%; border: 1px solid var(--accent-line); border-left: 3px solid var(--accent); background: var(--bg-raised); }
.ask-q { margin-bottom: 8px; white-space: pre-wrap; font-size: var(--fs-body); font-weight: 600; }
.ask-row { display: flex; gap: 6px; align-items: center; }
.ask-col { display: flex; flex-direction: column; gap: 4px; }
.ask-uploader { padding: 2px 0; }
.at-btn.sm { width: 30px; height: 30px; font-size: 15px; flex-shrink: 0; }
.ask-input { flex: 1; min-width: 0; height: 32px; background: var(--bg-overlay); border: 1px solid var(--line-strong); border-radius: var(--r-ctl); font-size: 13px; padding: 6px 10px; outline: none; color: var(--text-1); }
.ask-input:focus { border-color: var(--accent-line); }
.ask-done { font-size: var(--fs-meta); color: var(--ok); margin-top: 4px; }
/* 转任务确认卡 */
.cv-card { text-align: left; max-width: 92%; border-color: var(--accent-line); border-left: 3px solid var(--accent); }
.cv-text { white-space: pre-wrap; margin-bottom: 8px; }
.cv-row { display: flex; gap: 6px; }
.cv-done { font-size: var(--fs-meta); color: var(--ok); margin-top: 4px; }
.cv-done.off { color: var(--text-3); }

/* ---------- 工具活动行（tooltree 盒） ---------- */
.tool-block { margin: 4px 0; background: var(--bg-inset); border: 1px solid var(--line); border-radius: var(--r-panel); overflow: hidden; }
.tool-head { display: flex; align-items: center; gap: 6px; padding: 6px 10px; cursor: pointer; border-bottom: 1px solid var(--line); font-size: var(--fs-aux); color: var(--text-2); background: color-mix(in srgb, var(--bg-raised) 60%, transparent); }
.tool-caret { font-size: var(--fs-meta); color: var(--text-3); width: 10px; flex: none; }
.tool-agent { font-size: var(--fs-meta); font-weight: 600; flex-shrink: 0; }
.tool-tree { margin: 0; display: flex; flex-direction: column; gap: 3px; padding: 6px 10px 7px; }
.tool-call { display: flex; flex-direction: column; gap: 1px; }
.tc-line { display: flex; align-items: baseline; gap: 5px; font-size: var(--fs-aux); flex-wrap: wrap; }
.tc-icon { font-size: var(--fs-meta); }
.tc-name { font-weight: 600; word-break: break-all; color: var(--text-2); }
.tc-status { font-size: var(--fs-meta); color: var(--ok); }
.tc-status.bad { color: var(--danger); }
.tc-args { font-size: var(--fs-meta); color: var(--text-3); word-break: break-all; }
.tc-gist { font-size: var(--fs-meta); color: var(--text-3); word-break: break-all; }
.tc-diff { font-size: var(--fs-meta); color: var(--text-2); background: var(--bg-page); border: 1px solid var(--line); border-radius: 4px; padding: 4px 8px; margin: 2px 0; white-space: pre-wrap; word-break: break-all; max-height: 120px; overflow-y: auto; }
.tc-undo { border: 1px solid var(--line-strong); background: var(--bg-raised); color: var(--text-2); border-radius: var(--r-ctl); font-size: var(--fs-meta); padding: 2px 8px; cursor: pointer; margin: 2px 0; align-self: flex-start; }
.tc-undo:hover { border-color: var(--accent-line); color: var(--text-1); }
.tc-undo-done { font-size: var(--fs-meta); color: var(--ok); }

/* ---------- 消息行：头像列 + 内容列（用户消息 accent 渐变底） ---------- */
.msg { display: grid; grid-template-columns: 24px 1fr; gap: 0 9px; padding: 5px 0; border-radius: 8px; }
.msg.user { background: linear-gradient(90deg, var(--accent-soft), transparent 72%); }
.msg-av { width: 24px; }
.av-me {
  width: 24px; height: 24px; border-radius: 8px; display: grid; place-items: center;
  background: var(--accent); color: var(--accent-text);
  font-family: var(--font-mono); font-size: var(--fs-meta); font-weight: 700;
}
.msg-col { min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.mhead { display: flex; align-items: baseline; gap: 7px; flex-wrap: wrap; }
.mhead .who { font-size: var(--fs-aux); font-weight: 700; }
.who-model { font-size: var(--fs-meta); color: var(--text-3); background: var(--bg-panel); border: 1px solid var(--line); border-radius: 4px; padding: 0 4px; height: 15px; line-height: 14px; max-width: 120px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ask-tag { font-size: var(--fs-meta); color: var(--accent); background: var(--accent-soft); border: 1px solid var(--accent-line); border-radius: 4px; padding: 0 5px; }
.ask-tag.answered { color: var(--ok); background: color-mix(in srgb, var(--ok) 10%, transparent); border-color: color-mix(in srgb, var(--ok) 25%, transparent); }
.tail-ts { margin-left: auto; font-size: var(--fs-meta); color: var(--text-3); opacity: 0.75; }
.detail-row { display: flex; }
.detail-chip { font-size: var(--fs-meta); color: var(--accent); background: var(--accent-soft); border: 1px solid var(--accent-line); border-radius: 4px; padding: 1px 7px; cursor: pointer; }

.mbody { font-size: var(--fs-body); line-height: 1.58; color: var(--text-1); min-width: 0; word-break: break-word; position: relative; }
.b-text.dim { color: var(--text-2); }
.b-text :deep(.mention) { color: var(--accent); background: var(--accent-soft); border-radius: 3px; padding: 0 3px; font-weight: 600; }
.b-text :deep(code) { font-family: var(--font-mono); font-size: var(--fs-aux); background: var(--bg-inset); border: 1px solid var(--line); border-radius: 3px; padding: 0 3px; }
.b-text :deep(p) { margin: 0 0 4px; }
.b-text :deep(p:last-child) { margin-bottom: 0; }
.b-text :deep(ul), .b-text :deep(ol) { margin: 2px 0; padding-left: 16px; }
.quote-bar { font-size: var(--fs-aux); color: var(--text-3); border-left: 2px solid var(--line-strong); padding: 1px 0 1px 6px; margin-bottom: 4px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 100%; }

/* M10-A：气泡文本允许原生长按选择/复制 */
.b-text { user-select: text; -webkit-user-select: text; }

.reactions { display: flex; gap: 4px; margin: 3px 0 0; flex-wrap: wrap; }
.react-chip { font-size: var(--fs-aux); background: var(--bg-panel); border: 1px solid var(--line); border-radius: 10px; padding: 1px 8px; color: var(--text-2); }
.react-chip.mine { border-color: var(--accent-line); background: var(--accent-soft); color: var(--accent); }

/* ---------- P2-4 并行活动行 ---------- */
.parallel-line { display: flex; gap: 10px; flex-wrap: wrap; margin: 6px 0 6px 33px; font-size: var(--fs-meta); color: var(--text-3); }
.pl-chip { display: inline-flex; align-items: center; gap: 4px; }
.pl-dot { width: 6px; height: 6px; border-radius: 50%; animation: pulse 1.1s infinite; }
.pl-sep { opacity: 0.5; margin-left: 8px; }
@keyframes pulse { 50% { opacity: 0.3; } }

.live-label { font-size: var(--fs-meta); color: var(--accent); }
.caret { display: inline-block; width: 6px; height: 13px; background: var(--accent); margin-left: 2px; vertical-align: text-bottom; border-radius: 1px; animation: blink 0.9s step-end infinite; }
@keyframes blink { 50% { opacity: 0; } }

.pending-bar { margin: 0 12px 4px; font-size: var(--fs-aux); color: var(--warn); border: 1px dashed color-mix(in srgb, var(--warn) 45%, transparent); border-radius: var(--r-panel); padding: 4px 8px; background: var(--bg-panel); }

/* ---------- 输入区 ---------- */
.input-zone { background: var(--bg-panel); border-top: 1px solid var(--line); padding: 8px 12px calc(8px + env(safe-area-inset-bottom)); }
.reply-bar { display: flex; align-items: center; justify-content: space-between; gap: 8px; font-size: var(--fs-meta); color: var(--text-2); background: var(--bg-inset); border: 1px solid var(--line); border-radius: var(--r-ctl); padding: 4px 8px; margin-bottom: 6px; }
.reply-bar span:first-child { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.rb-x { font-size: 16px; padding: 0 6px; color: var(--text-3); }
.input-row { display: flex; gap: 7px; align-items: flex-end; }
.at-btn { width: 36px; height: 36px; border-radius: var(--r-ctl); background: var(--bg-overlay); border: 1px solid var(--line-strong); color: var(--text-2); font-size: 17px; display: flex; align-items: center; justify-content: center; flex-shrink: 0; }
.at-btn:active { background: var(--bg-raised); color: var(--text-1); }
.at-btn.dim { opacity: 0.45; }
.pending-uploader { padding: 6px 4px 0; }
/* 用户附图：气泡内图片网格（单张占整行） */
.img-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 5px; margin: 2px 0 6px; }
.img-grid .img-cell { width: 100%; height: 84px; object-fit: cover; border-radius: 8px; display: block; }
.img-grid .img-cell:first-child:last-child, .img-grid .img-cell:only-child { width: 100%; height: 150px; }
.input-field { flex: 1; background: var(--bg-overlay); border-radius: 12px; padding: 4px 12px; --van-field-text-area-min-height: 40px; }
.input-field :deep(.van-field__control) { color: var(--text-1); font-size: var(--fs-body); }
.send-btn {
  flex-shrink: 0; width: 40px; height: 40px; border-radius: 12px; border: none;
  background: var(--accent); color: var(--accent-text); font-size: 15px;
  display: grid; place-items: center;
}
.send-btn:disabled { opacity: .45; }
/* 工具树头行：ok 点 + 右侧 mono 元信息 */
.tool-dot { width: 6px; height: 6px; border-radius: 50%; flex: none; }
.tool-dot.ok { background: var(--ok); }
.tool-dot.err { background: var(--danger); }
.tool-fail { color: var(--danger); font-weight: 600; }
.tool-meta { margin-left: auto; flex: none; font-family: var(--font-mono); color: var(--text-3); font-size: var(--fs-meta); }
/* 输入区：@chips 常驻行 + 模式 pill + 长按 hint */
.mention-row { display: flex; gap: 6px; margin-bottom: 7px; overflow-x: auto; scrollbar-width: none; }
.mention-row::-webkit-scrollbar { display: none; }
.mention-chip {
  flex: none; display: inline-flex; align-items: center; gap: 5px; height: 24px; padding: 0 9px;
  border-radius: 12px; font-size: 11.5px; color: var(--text-2); border: 1px solid var(--line); background: var(--bg-raised);
}
.mention-chip .mdot { width: 5px; height: 5px; border-radius: 50%; }
.inmode { display: flex; align-items: center; gap: 8px; margin-top: 7px; }
.mpill { display: flex; background: var(--bg-overlay); border: 1px solid var(--line-strong); border-radius: var(--r-ctl); overflow: hidden; }
.mpill button { padding: 4px 11px; font-size: 11.5px; color: var(--text-3); border: none; background: none; }
.mpill button.on { background: var(--accent-soft); color: var(--accent); }
.lhint { margin-left: auto; font-size: var(--fs-meta); color: var(--text-3); }
/* 明细抽屉 grab 条 */
.dp-grab { width: 36px; height: 4px; border-radius: 3px; background: var(--line-strong); margin: 8px auto 2px; }

/* ---------- 明细抽屉（dtitle mono 大写 + 发丝线） ---------- */
.dp-wrap { display: flex; flex-direction: column; min-height: 0; max-height: 75vh; }
.dp-head { display: flex; align-items: center; justify-content: space-between; padding: 10px 14px; border-bottom: 1px solid var(--line); }
.dp-title { display: flex; align-items: baseline; gap: 6px; }
.dp-role { font-size: 13px; font-weight: 700; }
.dp-id { font-size: var(--fs-meta); color: var(--text-3); }
.dp-close { font-size: 18px; color: var(--text-3); cursor: pointer; padding: 0 4px; }
.dp-body { flex: 1; overflow-y: auto; padding: 12px 14px; display: flex; flex-direction: column; gap: 14px; }
.dp-empty { font-size: var(--fs-aux); color: var(--text-3); text-align: center; padding: 24px 0; }
.dp-sec { display: flex; flex-direction: column; gap: 5px; }
.dp-sec-title { font-size: var(--fs-meta); color: var(--text-3); font-family: var(--font-mono); letter-spacing: 0.08em; text-transform: uppercase; display: flex; align-items: center; gap: 8px; }
.dp-sec-title::after { content: ''; flex: 1; height: 1px; background: var(--line); }
.dp-sec-body { font-size: 13px; line-height: 1.6; color: var(--text-2); white-space: pre-wrap; word-break: break-word; background: var(--bg-inset); border: 1px solid var(--line); border-radius: var(--r-ctl); padding: 6px 8px; }
.dp-call { display: flex; flex-direction: column; gap: 2px; background: var(--bg-inset); border-radius: var(--r-ctl); padding: 5px 8px; }
.dp-call-line { display: flex; align-items: baseline; gap: 5px; font-size: var(--fs-aux); }
.dp-call-args { font-size: var(--fs-meta); color: var(--text-3); word-break: break-all; }
.dp-call-gist { font-size: var(--fs-meta); color: var(--text-3); word-break: break-all; }
.dp-chips { display: flex; flex-wrap: wrap; gap: 4px; }
.dp-chip { font-size: var(--fs-meta); color: var(--accent); background: var(--accent-soft); border: 1px solid var(--accent-line); border-radius: 4px; padding: 1px 8px; }
.dp-model { font-size: var(--fs-meta); color: var(--text-3); }

.member-row { display: flex; align-items: center; gap: 10px; padding: 9px 0; border-bottom: 1px solid var(--line); }
.member-role { font-size: 13px; font-weight: 600; }
.member-id { font-size: var(--fs-meta); color: var(--text-3); }

.sheet { padding: 14px 16px calc(20px + env(safe-area-inset-bottom)); overflow-y: auto; height: 100%; }
.pick-dir { font-size: 13px; color: var(--accent); padding: 2px 8px; border: 1px solid var(--line-strong); border-radius: 4px; background: var(--bg-raised); }
.sheet-head { display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px; }
.sheet-title { font-size: var(--fs-sub); font-weight: 700; }
.sheet-op { font-size: var(--fs-aux); color: var(--accent); }
.sheet-ops { display: flex; gap: 8px; justify-content: flex-end; margin-top: 14px; }
.scheme-md { font-size: 13px; line-height: 1.65; color: var(--text-1); }
.scheme-md :deep(h1) { font-size: var(--fs-title); margin: 4px 0 8px; }
.scheme-md :deep(h2) { font-size: var(--fs-body); margin: 12px 0 4px; border-bottom: 1px solid var(--line); padding-bottom: 3px; }
.cv-target { margin-bottom: 8px; }
/* 转项目弹层：任务内容预览 */
.cv-preview { background: var(--bg-inset); border: 1px solid var(--line); border-radius: var(--r-ctl); padding: 8px 10px; margin-bottom: 10px; }
.cv-preview-text { font-size: var(--fs-aux); line-height: 1.7; color: var(--text-1); max-height: 120px; overflow-y: auto; white-space: pre-wrap; word-break: break-word; }
.cv-preview-text.dim { color: var(--text-3); }
.cv-preview-meta { font-size: var(--fs-meta); color: var(--text-3); margin-top: 6px; }
.cv-note { font-size: var(--fs-meta); color: var(--text-3); margin-top: 10px; line-height: 1.6; }
.exp-item { padding: 8px 0; border-bottom: 1px solid var(--line); }
.exp-title { font-size: 13px; font-weight: 600; }
.exp-src { font-size: var(--fs-meta); color: var(--text-3); margin: 2px 0; }
.exp-body { font-size: var(--fs-aux); color: var(--text-2); }
</style>
