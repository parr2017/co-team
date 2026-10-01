<template>
  <div class="page">
    <van-nav-bar title="OC" fixed placeholder>
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

    <van-pull-refresh v-model="refreshing" class="pull-wrap" @refresh="onRefresh">
      <div class="pull">
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
        <div v-if="loaded && !projects.length" class="empty">暂无项目——在 opencode 里发一条消息，或点右上「实例」新建会话</div>
      </div>
      </div>
    </van-pull-refresh>

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
import { useOcBusy, dirBase, relTime } from '../composables/useOcBusy';

const router = useRouter();
const { instances, busyList, busyCount, projects, loaded, refresh } = useOcBusy();

const refreshing = ref(false);
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
