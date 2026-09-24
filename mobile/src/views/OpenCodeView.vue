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
          <div v-if="inst.kind === 'managed' && inst.enabled" class="ops">
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
          </div>
          <!-- 会话列表：点实例卡展开 -->
          <div v-if="expandedId === inst.id" class="sess" @click.stop>
            <div class="sess-head">
              <span class="sess-lab">会话</span>
              <span class="refresh" @click.stop="loadSessions(inst)">{{ loadingSessions ? '加载中…' : '刷新' }}</span>
            </div>
            <div v-if="!sessions.length && !loadingSessions" class="sess-empty">该实例暂无会话</div>
            <div v-for="s in sessions" :key="s.id" class="sess-item" @click.stop="openSession(inst.id, s.id)">
              <span class="st">{{ s.title || '（未命名会话）' }}</span>
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
import { onActivated, onBeforeUnmount, onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { showFailToast, showSuccessToast } from 'vant';
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
let poll: number | undefined;

function shortId(id: string): string {
  return id.length > 12 ? id.slice(0, 8) + '…' : id;
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
.ops { display: flex; gap: 8px; margin-top: 9px; }

/* 会话列表（实例卡内展开） */
.sess { margin-top: 10px; border-top: 1px dashed var(--line); padding-top: 8px; }
.sess-head { display: flex; align-items: center; justify-content: space-between; }
.sess-lab { font-size: 11px; color: var(--text-3); }
.refresh { font-size: 11px; color: var(--accent); padding: 2px 6px; }
.sess-empty { font-size: 11px; color: var(--text-3); padding: 8px 2px; }
.sess-item { display: flex; align-items: center; gap: 8px; padding: 9px 6px; border-radius: 6px; font-size: 12.5px; }
.sess-item:active { background: var(--bg-raised); }
.sess-item .st { flex: 1; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; color: var(--text-1); }
.sess-item .sid { font-size: 10px; color: var(--text-3); flex: none; }
.sess-item .van-icon { color: var(--text-3); flex: none; }

.empty-desc { font-size: 12px; color: var(--text-3); line-height: 1.9; text-align: center; padding: 0 12px; }
.empty-desc b { color: var(--text-2); }
</style>
