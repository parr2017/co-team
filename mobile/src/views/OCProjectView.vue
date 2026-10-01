<template>
  <div class="page">
    <van-nav-bar :title="projectName" left-arrow left-text="OC" @click-left="router.back()" fixed placeholder>
      <template #right>
        <van-icon name="replay" size="17" @click="onRefresh" />
      </template>
    </van-nav-bar>

    <div class="projline mono">{{ decodedDir }}</div>

    <van-pull-refresh v-model="refreshing" class="pull-wrap" @refresh="onRefresh">
      <div class="pull">
      <div class="cards">
        <div class="chips">
          <span class="chip" :class="{ on: scope === 'project' }" @click="scope = 'project'">本项目 {{ projectRows.length }}</span>
          <span class="chip" :class="{ on: scope === 'all' }" @click="scope = 'all'">全部 {{ allRows.length }}</span>
        </div>

        <template v-if="visibleRows.length">
          <div v-for="row in visibleRows" :key="row.instId + ':' + row.id" class="sess" @click="openSession(row)">
            <span class="dot" :class="{ pulse: row.busy }" />
            <span class="st">{{ row.title || '（未命名会话）' }}</span>
            <span v-if="row.parentID" class="child" title="子会话（任务/子代理派生）">子</span>
            <span v-if="scope === 'all'" class="dirb mono">{{ dirBase(row.directory) || row.instLabel }}</span>
            <span class="tm">{{ relTime(row.updatedAt) }}</span>
            <span class="chev">›</span>
          </div>
        </template>
        <div v-else class="empty">本项目还没有会话——点下方「新建会话」开始，或在 opencode / 桌面版里发一条消息</div>

        <div class="fab" :class="{ dis: creating }" @click="createSession">{{ creating ? '创建中…' : '＋ 新建会话（登记到本项目）' }}</div>
      </div>
      </div>
    </van-pull-refresh>

    <!-- 多实例服务同一项目时选一下 -->
    <van-action-sheet
      v-model:show="instPickSheet"
      title="选择实例"
      :actions="instPickActions"
      @select="onInstPicked"
      cancel-text="取消"
    />
  </div>
</template>

<script setup lang="ts">
/**
 * 项目内 OC 会话列表（/oc/project/:dir）：
 * - 本项目 = 该目录（normDir 归一）下的全部会话；「全部」= 所有实例的所有会话（带目录徽标）；
 * - 行内 busy 脉冲点实时来自 useOcBusy（computed 驱动，无需本地二次拉取）；点击进会话页；
 * - 新建会话：多实例服务同一项目时先 ActionSheet 选实例，ocCreateSession 登记到项目目录，创建后直接进入。
 */
import { computed, onActivated, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { showFailToast, showSuccessToast } from 'vant';
import { api, type OcInstance } from '../api';
import { useOcBusy, dirBase, normDir, relTime, type OcSessionRow } from '../composables/useOcBusy';

const route = useRoute();
const router = useRouter();
const { instances, sessionRows, refresh } = useOcBusy();

const decodedDir = computed(() => decodeURIComponent(String(route.params.dir || '')));
const projectKey = computed(() => normDir(decodedDir.value));
const projectName = computed(() => dirBase(decodedDir.value));

const refreshing = ref(false);
const scope = ref<'project' | 'all'>('project');
const creating = ref(false);
const instPickSheet = ref(false);

const allRows = computed<OcSessionRow[]>(() => sessionRows.value);
const projectRows = computed(() => allRows.value.filter((r) => normDir(r.directory) === projectKey.value));
const visibleRows = computed(() => (scope.value === 'project' ? projectRows.value : allRows.value));

async function onRefresh(): Promise<void> {
  refreshing.value = true;
  await refresh();
  refreshing.value = false;
}

function openSession(row: OcSessionRow): void {
  void router.push(`/opencode/session/${row.instId}/${row.id}`);
}

/** 服务本项目的已连接实例：project_root 命中或既有会话落在该目录 */
const servingInstances = computed<OcInstance[]>(() => {
  const out: OcInstance[] = [];
  for (const inst of instances.value) {
    if (!inst.enabled || (inst.state !== 'connected' && inst.state !== 'running')) continue;
    const root = normDir(inst.project_root);
    const serves = root === projectKey.value
      || allRows.value.some((r) => r.instId === inst.id && normDir(r.directory) === projectKey.value);
    if (serves) out.push(inst);
  }
  return out;
});

/** 新建会话：单实例直建；多实例 ActionSheet 选一下 */
async function createSession(): Promise<void> {
  if (creating.value) return;
  const serving = servingInstances.value;
  if (!serving.length) {
    showFailToast('没有已连接的实例服务该项目');
    return;
  }
  if (serving.length === 1) {
    void doCreate(serving[0]);
    return;
  }
  pendingPick.value = serving;
  instPickSheet.value = true;
}

const pendingPick = ref<OcInstance[]>([]);
const instPickActions = computed(() => pendingPick.value.map((i) => ({ name: i.label || i.id, subname: i.project_root || '', instId: i.id })));
function onInstPicked(action: unknown): void {
  instPickSheet.value = false;
  const a = action as { instId?: string };
  const inst = pendingPick.value.find((i) => i.id === a?.instId);
  if (inst) void doCreate(inst);
}

async function doCreate(inst: OcInstance): Promise<void> {
  creating.value = true;
  try {
    const title = `会话 ${new Date().toISOString().slice(5, 16).replace('T', ' ')}`;
    const created = await api.ocCreateSession(inst.id, title, decodedDir.value);
    if (!created.ok || !created.session) {
      showFailToast((created as any).error || '创建会话失败');
      return;
    }
    showSuccessToast('已创建并进入');
    void router.push(`/opencode/session/${inst.id}/${created.session.id}`);
  } catch (e: any) {
    showFailToast(e?.message || '创建失败');
  } finally {
    creating.value = false;
  }
}

onActivated(() => { void onRefresh(); });
</script>

<style scoped>
/* 固定壳（100dvh）内部滚动：page 撑满 → pull-wrap 占余 → .pull 滚动 */
.page { height: 100%; display: flex; flex-direction: column; background: var(--bg-page); }
.pull-wrap { flex: 1; min-height: 0; overflow: hidden; }
.pull { height: 100%; overflow-y: auto; -webkit-overflow-scrolling: touch; padding-bottom: calc(60px + env(safe-area-inset-bottom, 0px)); }
.projline { padding: 8px 14px 0; font-size: 10px; color: var(--text-3); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.cards { padding: 2px 0 10px; }
.chips { display: flex; gap: 6px; padding: 10px 14px 2px; }
.chip { font-size: 10.5px; color: var(--text-3); border: 1px solid var(--line); border-radius: 99px; padding: 3px 11px; }
.chip.on { color: var(--accent); border-color: var(--accent-line); background: var(--accent-soft); }
.sess { display: flex; align-items: center; gap: 8px; padding: 11px 14px; border-bottom: 1px solid var(--line); font-size: 12.5px; }
.sess:active { background: var(--bg-raised); }
.dot { width: 7px; height: 7px; border-radius: 50%; background: var(--text-3); flex: none; }
.dot.pulse { background: var(--ok); animation: pu 1.3s infinite; }
@keyframes pu { 0%, 100% { opacity: 1; } 50% { opacity: .25; } }
.sess .st { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sess .tm { font-size: 10px; color: var(--text-3); flex: none; }
.sess .chev { color: var(--text-3); font-size: 13px; flex: none; }
.sess .child { flex: none; font-size: 9px; color: var(--accent); border: 1px solid var(--accent-line); background: var(--accent-soft); border-radius: 4px; padding: 0 4px; }
.sess .dirb { flex: none; font-size: 9px; color: var(--text-3); border: 1px solid var(--line); border-radius: 4px; padding: 0 5px; max-width: 24vw; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.empty { font-size: 12px; color: var(--text-3); text-align: center; padding: 34px 20px; line-height: 1.8; }
.fab { margin: 16px 12px 0; background: var(--accent); color: var(--accent-text); text-align: center; font-size: 13px; font-weight: 600; border-radius: 10px; padding: 11px; }
.fab.dis { opacity: .6; }
</style>
