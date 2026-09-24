<template>
  <div class="page">
    <van-nav-bar title="外部运行时 · OpenCode" fixed placeholder>
      <template #left>
        <van-icon name="arrow-left" size="18" @click="router.back()" />
      </template>
      <template #right>
        <van-icon name="replay" size="18" @click="load" />
      </template>
    </van-nav-bar>

    <div class="tip-bar">接管 opencode：managed 由 co-team 托管拉起，attached 接管你已在跑的 CLI / 桌面版</div>

    <van-pull-refresh v-model="refreshing" @refresh="onRefresh">
      <div class="cards">
        <div v-for="inst in instances" :key="inst.id" class="inst-card" :class="{ disabled: !inst.enabled }">
          <div class="head" @click="toggle(inst)">
            <span class="dot" :class="inst.enabled ? inst.state : 'off'" />
            <span class="nm">{{ inst.label || inst.id }}</span>
            <span class="kind-tag" :class="inst.kind">{{ KIND_LABEL[inst.kind] || inst.kind }}</span>
            <span class="mode-tag" :class="inst.mode">{{ inst.mode === 'control' ? '可控制' : '只读' }}</span>
            <span class="sp" />
            <van-icon name="arrow-down" :class="{ open: expandedId === inst.id }" />
          </div>
          <div class="meta">
            <span class="state-text" :class="inst.enabled ? inst.state : 'off'">{{ inst.enabled ? STATE_LABEL[inst.state] || inst.state : '未启用' }}</span>
            <span class="mono dim">v{{ inst.version || '?' }}</span>
            <span v-if="inst.project_root" class="mono root" :title="inst.project_root">{{ inst.project_root }}</span>
          </div>
          <div v-if="inst.error" class="err">⚠ {{ inst.error }}</div>
          <!-- managed 启停 + 接管当前对话 -->
          <div v-if="inst.kind === 'managed' && inst.enabled || canTakeOver(inst)" class="ops">
            <template v-if="inst.kind === 'managed' && inst.enabled">
              <van-button
                size="small"
                :loading="busyId === inst.id && busyAct === 'start'"
                :disabled="busyId === inst.id || inst.state === 'starting' || inst.state === 'running' || inst.state === 'connected'"
                @click.stop="start(inst)"
              >启动</van-button>
              <van-button
                size="small"
                :loading="busyId === inst.id && busyAct === 'stop'"
                :disabled="busyId === inst.id || inst.state === 'stopped'"
                @click.stop="stop(inst)"
              >停止</van-button>
            </template>
            <van-button
              v-if="canTakeOver(inst)"
              size="small"
              type="primary"
              :loading="takingOver === inst.id"
              :disabled="!!busyId"
              @click.stop="takeOver(inst)"
            >接管当前对话</van-button>
          </div>
          <!-- 会话列表：点实例卡展开；按 directory 分组（本项目 / 其他项目） -->
          <div v-if="expandedId === inst.id" class="sess" @click.stop>
            <div class="sess-head">
              <span class="sess-lab">会话</span>
              <span class="refresh" @click.stop="loadSessions(inst)">{{ loadingSessions ? '加载中…' : '刷新' }}</span>
            </div>
            <div v-if="sessions.length" class="sess-switch">
              <span :class="{ cur: sessFilter === 'project' }" @click.stop="sessFilter = 'project'">本项目({{ projectSessions.length }})</span>
              <span :class="{ cur: sessFilter === 'all' }" @click.stop="sessFilter = 'all'">全部({{ sessions.length }})</span>
            </div>
            <div v-if="!sessions.length && !loadingSessions" class="sess-empty">该实例暂无会话</div>
            <div v-else-if="!visibleSessions.length && !loadingSessions" class="sess-empty">
              本项目暂无会话——在 opencode 里发一条消息即会出现在这里，或切换到「全部」看其他项目
            </div>
            <div v-for="s in visibleSessions" :key="s.id" class="sess-item" @click.stop="openSession(inst.id, s.id)">
              <span class="st">{{ s.title || '（未命名会话）' }}</span>
              <span v-if="showDirBadge(s)" class="dir-badge mono" :title="String(s.directory || '')">{{ dirBase(String(s.directory || '')) }}</span>
              <span class="sid mono">{{ shortId(s.id) }}</span>
              <van-icon name="arrow" />
            </div>
          </div>
        </div>

        <van-empty v-if="!instances.length && !loading" image="search" description="">
          <template #description>
            <div class="empty-desc">
              还没有接入任何 opencode 实例<br />
              在 <b>config/config.yaml</b> 的 <b>opencode.instances</b> 下添加：<br />
              managed = co-team 托管拉起（模型由 co-team 注入）<br />
              attached-cli / attached-desktop = 接管已在跑的 opencode<br />
              保存后重启服务生效
            </div>
          </template>
        </van-empty>
      </div>
    </van-pull-refresh>
  </div>
</template>

<script setup lang="ts">
import { computed, onActivated, onBeforeUnmount, onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { showFailToast, showSuccessToast, showDialog } from 'vant';
import { api, type OcInstance, type OcSession } from '../api';

const router = useRouter();

const KIND_LABEL: Record<string, string> = { managed: '托管', 'attached-cli': '接管·CLI', 'attached-desktop': '接管·桌面' };
const STATE_LABEL: Record<string, string> = { stopped: '未启动', starting: '启动中', running: '运行中', connected: '已连接', error: '异常' };

const instances = ref<OcInstance[]>([]);
const loading = ref(false);
const refreshing = ref(false);
const expandedId = ref('');
const sessions = ref<OcSession[]>([]);
const loadingSessions = ref(false);
const busyId = ref('');
const busyAct = ref('');
const takingOver = ref('');
/** 会话列表过滤器：本项目（实例 project_root 匹配）/ 全部 */
const sessFilter = ref<'project' | 'all'>('project');
let poll: number | undefined;

function shortId(id: string): string {
  return id.length > 12 ? id.slice(0, 8) + '…' : id;
}

/** 归一化目录（反斜杠→正斜杠、去尾部斜杠、小写）后与实例 project_root 比较
 *  （opencode 的 session.directory 在 Windows 下是 D:\x\y，project_root 配置常写 D:/x/y） */
function normDir(d: string): string {
  return d.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}
function isThisProject(s: OcSession): boolean {
  const inst = instances.value.find((x) => x.id === expandedId.value);
  const root = normDir(String(inst?.project_root || ''));
  if (!root) return false;
  return normDir(String(s.directory || '')) === root;
}
function dirBase(d: string): string {
  const seg = d.split(/[\\/]/).filter(Boolean);
  return seg.length ? seg[seg.length - 1] : d;
}
/** 实例没有 project_root（attached 未探测到）时不做分组，全部展示且不带徽标 */
const canGroup = computed(() => {
  const inst = instances.value.find((x) => x.id === expandedId.value);
  return !!String(inst?.project_root || '');
});
const projectSessions = computed(() => sessions.value.filter(isThisProject));
const visibleSessions = computed(() => (canGroup.value && sessFilter.value === 'project' ? projectSessions.value : sessions.value));
function showDirBadge(s: OcSession): boolean {
  return canGroup.value && !isThisProject(s);
}

function canTakeOver(inst: OcInstance): boolean {
  return inst.enabled && (inst.state === 'connected' || inst.state === 'running');
}

async function load() {
  loading.value = true;
  try {
    const d = await api.ocInstances();
    instances.value = d.instances || [];
  } catch (e: any) {
    showFailToast(e?.message || '实例列表加载失败');
  } finally {
    loading.value = false;
  }
}

async function loadSessions(inst: OcInstance) {
  loadingSessions.value = true;
  try {
    const d = await api.ocSessions(inst.id);
    sessions.value = d.sessions || [];
  } catch (e: any) {
    showFailToast(e?.message || '会话列表加载失败');
    sessions.value = [];
  } finally {
    loadingSessions.value = false;
  }
}

function toggle(inst: OcInstance) {
  if (expandedId.value === inst.id) {
    expandedId.value = '';
    return;
  }
  expandedId.value = inst.id;
  void loadSessions(inst);
}

function openSession(instId: string, sessId: string) {
  router.push(`/opencode/session/${instId}/${sessId}`);
}

/** 接管当前对话：busy 会话优先否则最近更新。busy=可能正被 TUI 使用——
 *  弹征询（共享接管 / 让 TUI 切走我独占 / 放弃），杜绝"接管即污染"（2026-09-24 事故复盘）。 */
async function takeOver(inst: OcInstance) {
  takingOver.value = inst.id;
  try {
    const d = await api.ocActiveSession(inst.id);
    if (!d.ok || !d.session?.id) {
      showFailToast(d.error || '没有可接管的会话');
      return;
    }
    if (d.reason === 'busy') {
      const choice = await showBusyDialog(d.session.title || d.session.id, d.session.directory || inst.project_root || '（未标记项目）');
      if (choice === 'share') {
        openSession(inst.id, d.session.id);
      } else if (choice === 'yield') {
        // 让位式接管：TUI 切到新会话，我独占原会话
        const created = await api.ocCreateSession(inst.id, 'TUI 让位后的新会话').catch(() => null);
        if (!created?.ok || !created.session) { showFailToast('让位失败：无法创建承接会话'); return; }
        const r = await api.ocTuiSelectSession(inst.id, created.session.id).catch(() => null);
        if (!r?.ok) { showFailToast(`TUI 切换失败：${r?.error || '未知'}（仍可共享接管）`); return; }
        await api.ocTuiToast(inst.id, 'co-team 已接管原会话，TUI 已切换到新会话', 'info').catch(() => {});
        openSession(inst.id, d.session.id);
      }
      // cancel：放弃
    } else {
      openSession(inst.id, d.session.id);
      void api.ocTuiToast(inst.id, 'co-team 正在查看此对话', 'info').catch(() => {});
    }
  } catch (e: any) {
    showFailToast(e?.message || '接管失败');
  } finally {
    takingOver.value = '';
  }
}

/** busy 接管征询：共享接管 / 让位独占 / 取消（beforeClose 精确分流三态：
 *  confirm=共享、cancel 按钮=让位、overlay/ESC 关闭=放弃） */
function showBusyDialog(title: string, dir: string): Promise<'share' | 'yield' | 'cancel'> {
  return new Promise((resolve) => {
    showDialog({
      title: '接管确认 · 该会话可能正被他人使用',
      message: `「${title}」正在 TUI 中使用（busy）\n项目：${dir}\n\nopencode 的会话是服务端共享的——没有"踢掉 TUI"的接口。选择接管方式：`,
      showCancelButton: true,
      confirmButtonText: '共享接管',
      cancelButtonText: '让 TUI 切走，我独占',
      closeOnClickOverlay: true,
      beforeClose: (action: 'confirm' | 'cancel', done: () => void) => {
        done();
        resolve(action === 'confirm' ? 'share' : 'yield');
      },
    }).catch(() => resolve('cancel'));
  });
}

async function start(inst: OcInstance) {
  busyId.value = inst.id;
  busyAct.value = 'start';
  try {
    await api.ocStartInstance(inst.id);
    showSuccessToast(`${inst.label || inst.id} 启动中…`);
    await load();
  } catch (e: any) {
    showFailToast(e?.message || '启动失败');
  } finally {
    busyId.value = '';
    busyAct.value = '';
  }
}

async function stop(inst: OcInstance) {
  busyId.value = inst.id;
  busyAct.value = 'stop';
  try {
    await api.ocStopInstance(inst.id);
    showSuccessToast(`${inst.label || inst.id} 已停止`);
    await load();
  } catch (e: any) {
    showFailToast(e?.message || '停止失败');
  } finally {
    busyId.value = '';
    busyAct.value = '';
  }
}

async function onRefresh() {
  refreshing.value = true;
  await load();
  refreshing.value = false;
}

onMounted(() => {
  void load();
  // 实例状态轻轮询：starting→connected 等迁移不依赖人工下拉（与 web 面板同思路）
  poll = window.setInterval(() => { if (document.visibilityState === 'visible') void load(); }, 12_000);
});
onActivated(load);
onBeforeUnmount(() => {
  if (poll) { window.clearInterval(poll); poll = undefined; }
});
</script>

<style scoped>
.page { min-height: 100vh; padding-bottom: 24px; }
.tip-bar { margin: 10px 12px 0; padding: 8px 11px; font-size: 11px; color: var(--text-3); background: var(--bg-inset); border: 1px solid var(--line); border-radius: 8px; line-height: 1.6; }
.cards { padding: 10px 12px; display: flex; flex-direction: column; gap: 10px; }
.inst-card { background: var(--bg-panel); border: 1px solid var(--line); border-radius: 10px; padding: 11px 13px; }
.inst-card:active { border-color: var(--accent); }
.inst-card.disabled { opacity: .55; }
.head { display: flex; align-items: center; gap: 7px; font-size: 13px; font-weight: 600; flex-wrap: wrap; }
.head .nm { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 40vw; }
.head .sp { flex: 1; }
.head .van-icon { color: var(--text-3); transition: transform .15s; }
.head .van-icon.open { transform: rotate(180deg); }
.dot { width: 6px; height: 6px; border-radius: 50%; background: var(--text-3); flex: none; }
.dot.connected, .dot.running { background: var(--ok); }
.dot.starting { background: var(--warn); animation: livepulse 1.2s infinite; }
.dot.error { background: var(--danger); }
.dot.stopped, .dot.off { background: var(--text-3); }
@keyframes livepulse { 0%,100% { opacity: 1; } 50% { opacity: .25; } }

.kind-tag { font-family: var(--font-mono, monospace); font-size: 10px; padding: 1px 6px; border-radius: 4px; border: 1px solid var(--line-strong); color: var(--text-2); background: var(--bg-inset); flex: none; }
.kind-tag.managed { color: var(--accent); border-color: var(--accent-line); }
.mode-tag { font-family: var(--font-mono, monospace); font-size: 10px; padding: 1px 6px; border-radius: 4px; border: 1px solid var(--line-strong); color: var(--text-3); flex: none; }
.mode-tag.control { color: var(--danger); border-color: color-mix(in srgb, var(--danger) 40%, transparent); }

.meta { display: flex; align-items: center; gap: 8px; margin-top: 6px; font-size: 11px; flex-wrap: wrap; }
.state-text { font-weight: 600; }
.state-text.connected, .state-text.running { color: var(--ok); }
.state-text.starting { color: var(--warn); }
.state-text.error { color: var(--danger); }
.state-text.stopped, .state-text.off { color: var(--text-3); font-weight: 400; }
.dim { color: var(--text-3); }
.root { color: var(--text-3); font-size: 10px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 100%; }
.err { margin-top: 7px; font-size: 11px; color: var(--danger); background: color-mix(in srgb, var(--danger) 8%, transparent); border: 1px solid color-mix(in srgb, var(--danger) 25%, transparent); border-radius: 6px; padding: 6px 9px; line-height: 1.5; }
.ops { display: flex; gap: 8px; margin-top: 9px; flex-wrap: wrap; }

/* 会话列表（实例卡内展开） */
.sess { margin-top: 10px; border-top: 1px dashed var(--line); padding-top: 8px; }
.sess-head { display: flex; align-items: center; justify-content: space-between; }
.sess-lab { font-size: 11px; color: var(--text-3); }
.refresh { font-size: 11px; color: var(--accent); padding: 2px 6px; }
.sess-switch { display: flex; gap: 6px; margin: 6px 0 4px; }
.sess-switch span { font-size: 11px; color: var(--text-3); border: 1px solid var(--line); border-radius: 99px; padding: 2px 10px; }
.sess-switch span.cur { color: var(--accent); border-color: color-mix(in srgb, var(--accent) 45%, transparent); background: color-mix(in srgb, var(--accent) 8%, transparent); }
.sess-empty { font-size: 11px; color: var(--text-3); padding: 8px 2px; line-height: 1.7; }
.sess-item { display: flex; align-items: center; gap: 8px; padding: 9px 6px; border-radius: 6px; font-size: 12.5px; }
.sess-item:active { background: var(--bg-raised); }
.sess-item .st { flex: 1; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; color: var(--text-1); }
.sess-item .sid { font-size: 10px; color: var(--text-3); flex: none; }
.sess-item .van-icon { color: var(--text-3); flex: none; }
.dir-badge { flex: none; font-size: 9.5px; color: var(--text-3); background: var(--bg-inset); border: 1px solid var(--line); border-radius: 4px; padding: 1px 6px; max-width: 26vw; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

.empty-desc { font-size: 12px; color: var(--text-3); line-height: 1.9; text-align: center; padding: 0 12px; }
.empty-desc b { color: var(--text-2); }
</style>
