<template>
  <div class="page">
    <van-nav-bar safe-area-inset-top title="OC" fixed placeholder>
      <template #left>
        <span class="nav-act" @click="instSheet = true">实例</span>
      </template>
      <template #right>
        <van-icon name="replay" size="17" @click="refresh" />
      </template>
    </van-nav-bar>

    <!-- 活动会话横幅：跨实例聚合 busy 会话，点击直达任意活动会话 -->
    <div v-if="busyCount" class="active-banner" @click="openActiveSheet">
      <span class="dot pulse" /><span><b>{{ busyCount }}</b> 个活动会话 · 点击切换</span><span class="arr">›</span>
    </div>
    <div v-else-if="loaded" class="active-banner idle"><span class="dot off" />暂无活动会话</div>

    <div class="tip-bar">接管 opencode：托管实例由 co-team 拉起，attached 接管你已在跑的 CLI / 桌面版</div>

    <van-pull-refresh v-model="refreshing" class="pull-wrap" :disabled="pullDisabled" @refresh="onRefresh">
      <div class="pull" @scroll="onPullScroll">
      <div class="cards">
        <div class="sec-title">项目 · {{ projects.length }}</div>
        <div v-for="p in projects" :key="p.dir" class="proj-card" @click="openProject(p.dir)">
          <div class="picon"><span>{{ p.name.slice(0, 1).toUpperCase() }}</span><span v-if="p.busyCount" class="pdot" /></div>
          <div class="pbody">
            <div class="pname">{{ p.name }}</div>
            <div class="psub">
              <span v-for="lb in p.instanceLabels" :key="lb" class="tag">{{ shortLabel(lb) }}</span>
              <span v-if="p.busyCount" class="tag run">● {{ p.busyCount }} 活跃</span>
              <span class="last">{{ p.lastTitle }}<template v-if="p.lastUpdated"> · {{ relTime(p.lastUpdated) }}</template></span>
            </div>
          </div>
          <span class="chev">›</span>
        </div>
        <div v-if="loaded && !projects.length" class="empty">暂无项目——点下方「新建会话」，或在 opencode / 桌面版里发一条消息</div>

        <div class="fab" :class="{ dis: creating }" @click="openNewSession">{{ creating ? '创建中…' : '＋ 新建会话（登记到项目）' }}</div>
      </div>
      </div>
    </van-pull-refresh>

    <!-- 项目/目录选择 -->
    <van-popup v-model:show="newSheet" position="bottom" round :style="{ maxHeight: '72%' }">
      <div class="sheet">
        <div class="sh-h"><span>新建会话 · 选择项目</span><span class="x" @click="newSheet = false">✕</span></div>
        <div class="new-dirs">
          <div v-for="d in newDirs" :key="d.workspace" class="si" @click="pickNewProject(d)">
            <span class="si-nm">{{ d.name }}</span>
            <span class="si-tg mono">{{ dirBase(d.workspace) }}</span>
          </div>
          <div v-if="!newDirs.length" class="sh">暂无已知项目——选一个目录新建</div>
        </div>
        <div class="si new-custom" @click="pickCustomDir">
          <span class="si-nm">选择其他目录…</span>
          <span class="si-tg">📁</span>
        </div>
      </div>
    </van-popup>

    <DirPicker v-model:show="dirPick" title="选择会话目录" @pick="onDirPicked" />

    <!-- 活动会话直达弹层 -->
    <van-action-sheet v-model:show="activeSheet" :title="'活动会话 · ' + busyCount" :actions="activeActions" @select="onActiveSelect" cancel-text="取消" />
    <!-- 实例管理（从首屏收进入口） -->
    <van-popup v-model:show="instSheet" position="bottom" round :style="{ maxHeight: '72%' }">
      <div class="sheet">
        <div class="sh-h"><span>opencode 实例</span><span class="x" @click="instSheet = false">✕</span></div>
        <div v-for="inst in instances" :key="inst.id" class="inst-row" :class="{ disabled: !inst.enabled }">
          <span class="dot" :class="inst.enabled ? inst.state : 'off'" />
          <div class="ibody">
            <div class="iname">{{ inst.label || inst.id }} <span class="tag" :class="{ mg: inst.kind === 'managed' }">{{ shortKind(inst.kind) }}</span> <span class="tag">{{ inst.mode === 'control' ? '可控制' : '只读' }}</span></div>
            <div class="isub">{{ stateLabel(inst) }} <template v-if="inst.project_root">· {{ dirBase(inst.project_root) }}</template></div>
          </div>
          <template v-if="inst.kind === 'managed' && inst.enabled">
            <van-button v-if="inst.state === 'stopped'" size="mini" :loading="busyId === inst.id" @click.stop="startInst(inst)">启动</van-button>
            <van-button v-else size="mini" plain :loading="busyId === inst.id" @click.stop="stopInst(inst)">停止</van-button>
          </template>
        </div>
        <div v-if="!instances.length" class="empty">还没有接入 opencode 实例——在 config.yaml 的 opencode.instances 下添加</div>
      </div>
    </van-popup>
  </div>
</template>

<script setup lang="ts">
/**
 * OC 首页（2026-10 一级 tab 改版）：按项目聚合所有 opencode 会话。
 * - 顶部活动会话横幅：跨实例 busy 聚合，点击 ActionSheet 直达任意活动会话；
 * - 项目卡片：normDir 归组（useOcBusy），活跃数/最近会话/实例标签，点击进项目会话列表；
 * - 实例启停管理收进右上「实例」弹层，不占首屏。
 * 数据源：useOcBusy 单例轮询（12s）+ 下拉刷新即时拉。
 */
import { computed, onActivated, ref } from 'vue';
import { useRouter } from 'vue-router';
import { showFailToast, showSuccessToast } from 'vant';
import { api, type OcInstance } from '../api';
import DirPicker from '../components/DirPicker.vue';
import { useOcBusy, dirBase, relTime, normDir } from '../composables/useOcBusy';

const router = useRouter();
const { instances, busyList, busyCount, projects, loaded, refresh } = useOcBusy();

const refreshing = ref(false);
/** 滚动离顶即禁用拉刷新：Vant 的 reachTop 按"组件根的滚动父级"算，固定壳下恒为 0，
 *  中部下滑会被误判成下拉刷新劫持手势（列表回不去顶）——以真实内层 scrollTop 为准 */
const pullDisabled = ref(false);
function onPullScroll(e: Event): void {
  pullDisabled.value = (e.target as HTMLElement).scrollTop > 4;
}
const activeSheet = ref(false);
const instSheet = ref(false);
const busyId = ref('');

const STATE_LABEL: Record<string, string> = { stopped: '未启动', starting: '启动中', running: '运行中', connected: '已连接', error: '异常' };

function shortKind(kind: string): string {
  return kind === 'managed' ? '托管' : kind === 'attached-desktop' ? '桌面版' : 'CLI';
}
function shortLabel(label: string): string {
  if (/桌面/.test(label)) return '桌面版';
  if (/托管|本机/.test(label)) return '托管';
  return label.length > 6 ? label.slice(0, 6) : label;
}
function stateLabel(inst: OcInstance): string {
  return inst.enabled ? STATE_LABEL[inst.state] || inst.state : '未启用';
}

function openProject(dir: string): void {
  void router.push(`/oc/project/${encodeURIComponent(dir)}`);
}

const activeActions = computed(() => busyList.value.map((b) => ({
  name: b.title,
  subname: `${dirBase(b.directory) || '未知项目'} · ${b.instanceLabel}`,
  instance: b.instance,
  sessionID: b.sessionID,
})));
function openActiveSheet(): void {
  if (!busyList.value.length) return;
  activeSheet.value = true;
}
function onActiveSelect(action: unknown): void {
  activeSheet.value = false;
  const a = action as { instance: string; sessionID: string };
  if (!a?.instance || !a?.sessionID) return;
  void router.push(`/opencode/session/${a.instance}/${a.sessionID}`);
}

// ---------- 新建会话（登记到项目/目录） ----------
const newSheet = ref(false);
const creating = ref(false);
const dirPick = ref(false);
const newDirs = ref<{ id: string; name: string; workspace: string }[]>([]);

/** 合并 co-team 项目与既有会话目录（去重，项目名优先） */
function mergeDirs(projects: { id: string; name: string; workspace: string }[], dirs: { label: string; workspace: string }[]): { id: string; name: string; workspace: string }[] {
  const map = new Map<string, { id: string; name: string; workspace: string }>();
  for (const d of dirs) map.set(normDir(d.workspace), { id: d.workspace, name: `（会话目录）${d.label}`, workspace: d.workspace });
  for (const p of projects) map.set(normDir(p.workspace), { id: p.id, name: p.name, workspace: p.workspace });
  return [...map.values()].slice(0, 30);
}

async function openNewSession(): Promise<void> {
  if (creating.value) return;
  if (!instances.value.some((i) => i.enabled && (i.state === 'connected' || i.state === 'running'))) {
    showFailToast('没有已连接的实例');
    return;
  }
  try {
    const [proj, wd] = await Promise.all([
      api.listProjects().catch(() => ({ projects: [] as { id: string; name: string; workspace: string }[] })),
      api.ocWorkdirs().catch(() => ({ items: [] as { label: string; workspace: string }[] })),
    ]);
    newDirs.value = mergeDirs(proj.projects || [], wd.items || []);
  } catch {
    newDirs.value = [];
  }
  newSheet.value = true;
}

/** 服务目标目录的已连接实例：project_root 命中优先，否则首个在线实例 */
function pickInstance(dir: string): OcInstance | undefined {
  const live = instances.value.filter((i) => i.enabled && (i.state === 'connected' || i.state === 'running'));
  const key = normDir(dir);
  return live.find((i) => normDir(i.project_root) === key) || live[0];
}

function pickNewProject(d: { workspace: string }): void {
  newSheet.value = false;
  void doCreate(d.workspace);
}
function pickCustomDir(): void {
  newSheet.value = false;
  dirPick.value = true;
}
function onDirPicked(path: string): void {
  void doCreate(path);
}

async function doCreate(directory: string): Promise<void> {
  const inst = pickInstance(directory);
  if (!inst) {
    showFailToast('没有已连接的实例');
    return;
  }
  creating.value = true;
  try {
    const title = `会话 ${new Date().toISOString().slice(5, 16).replace('T', ' ')}`;
    const created = await api.ocCreateSession(inst.id, title, directory);
    if (!created.ok || !created.session) {
      showFailToast((created as any).error || '创建会话失败');
      return;
    }
    showSuccessToast('已创建并进入');
    await refresh();
    void router.push(`/opencode/session/${inst.id}/${created.session.id}`);
  } catch (e: any) {
    showFailToast(e?.message || '创建失败');
  } finally {
    creating.value = false;
  }
}

async function onRefresh(): Promise<void> {
  refreshing.value = true;
  await refresh();
  refreshing.value = false;
}

async function startInst(inst: OcInstance): Promise<void> {
  busyId.value = inst.id;
  try {
    await api.ocStartInstance(inst.id);
    showSuccessToast(`${inst.label || inst.id} 启动中…`);
    await refresh();
  } catch (e: any) {
    showFailToast(e?.message || '启动失败');
  } finally {
    busyId.value = '';
  }
}
async function stopInst(inst: OcInstance): Promise<void> {
  busyId.value = inst.id;
  try {
    await api.ocStopInstance(inst.id);
    showSuccessToast(`${inst.label || inst.id} 已停止`);
    await refresh();
  } catch (e: any) {
    showFailToast(e?.message || '停止失败');
  } finally {
    busyId.value = '';
  }
}

onActivated(() => { void refresh(); });
</script>

<style scoped>
/* 固定壳（100dvh）内部滚动：page 撑满 → pull-wrap 占余 → .pull 滚动（照 TaskListView 模式） */
.page { height: 100%; display: flex; flex-direction: column; background: var(--bg-page); }
.pull-wrap { flex: 1; min-height: 0; overflow: hidden; }
.pull { height: 100%; overflow-y: auto; -webkit-overflow-scrolling: touch; padding-bottom: calc(60px + env(safe-area-inset-bottom, 0px)); }
.nav-act { font-size: 13px; color: var(--accent); }
.active-banner { margin: 10px 12px 0; border: 1px solid rgba(63, 185, 111, 0.4); background: rgba(63, 185, 111, 0.09); color: var(--ok); font-size: 12.5px; border-radius: 10px; padding: 10px 13px; display: flex; align-items: center; gap: 8px; }
.active-banner:active { filter: brightness(1.2); }
.active-banner.idle { border-color: var(--line); background: var(--bg-inset); color: var(--text-3); }
.active-banner b { font-size: 14px; }
.active-banner .arr { margin-left: auto; color: var(--text-3); }
.dot { width: 7px; height: 7px; border-radius: 50%; background: var(--ok); flex: none; }
.dot.pulse { animation: pu 1.3s infinite; }
.dot.off { background: var(--text-3); }
@keyframes pu { 0%, 100% { opacity: 1; } 50% { opacity: .25; } }
.tip-bar { margin: 10px 12px 0; padding: 7px 10px; font-size: 10.5px; color: var(--text-3); background: var(--bg-inset); border: 1px solid var(--line); border-radius: 8px; line-height: 1.6; }
.cards { padding: 2px 0 10px; }
.sec-title { font-size: 11px; color: var(--text-3); padding: 12px 14px 2px; letter-spacing: .06em; }
.proj-card { margin: 8px 12px 0; background: var(--bg-panel); border: 1px solid var(--line); border-radius: 12px; padding: 11px 13px; display: flex; align-items: center; gap: 10px; }
.proj-card:active { border-color: var(--accent-line); }
.picon { width: 38px; height: 38px; border-radius: 9px; background: var(--bg-raised); border: 1px solid var(--line-strong); display: grid; place-items: center; font-weight: 700; font-size: 16px; color: var(--accent); position: relative; flex: none; }
.picon .pdot { position: absolute; top: -3px; right: -3px; width: 9px; height: 9px; border-radius: 50%; background: var(--ok); border: 2px solid var(--bg-panel); }
.pbody { flex: 1; min-width: 0; }
.pname { font-size: 13.5px; font-weight: 600; }
.psub { font-size: 10.5px; color: var(--text-3); margin-top: 3px; display: flex; align-items: center; gap: 5px; flex-wrap: wrap; }
.psub .last { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 100%; }
.tag { font-size: 9px; padding: 0 5px; border-radius: 4px; border: 1px solid var(--line-strong); color: var(--text-2); flex: none; }
.tag.mg { color: var(--accent); border-color: var(--accent-line); }
.tag.run { color: var(--ok); border-color: rgba(63, 185, 111, 0.4); background: rgba(63, 185, 111, 0.08); }
.chev { color: var(--text-3); font-size: 13px; flex: none; }
.empty { font-size: 12px; color: var(--text-3); text-align: center; padding: 36px 20px; line-height: 1.8; }
.fab { margin: 16px 12px 0; background: var(--accent); color: var(--accent-text); text-align: center; font-size: 13px; font-weight: 600; border-radius: 10px; padding: 11px; }
.fab.dis { opacity: .6; }

/* 新建会话弹层 */
.new-dirs { max-height: 46vh; overflow-y: auto; }
.new-custom { color: var(--accent); border-top: 1px solid var(--line); margin-top: 6px; }

/* 实例弹层 */
.sheet { padding: 12px 16px 18px; }
.sh-h { display: flex; align-items: center; justify-content: space-between; font-size: 14px; font-weight: 600; padding-bottom: 8px; }
.sh-h .x { color: var(--text-3); padding: 2px 6px; font-weight: 400; }
.inst-row { display: flex; align-items: center; gap: 9px; padding: 11px 2px; border-bottom: 1px solid var(--line); font-size: 12.5px; }
.inst-row.disabled { opacity: .55; }
.inst-row .dot { width: 7px; height: 7px; }
.inst-row .dot.connected, .inst-row .dot.running { background: var(--ok); }
.inst-row .dot.starting { background: var(--warn); }
.inst-row .dot.error { background: var(--danger); }
.inst-row .dot.stopped, .inst-row .dot.off { background: var(--text-3); }
.ibody { flex: 1; min-width: 0; }
.iname { font-weight: 600; display: flex; align-items: center; gap: 5px; flex-wrap: wrap; }
.isub { font-size: 10.5px; color: var(--text-3); margin-top: 2px; }
</style>
