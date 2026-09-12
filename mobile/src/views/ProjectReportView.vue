<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { showFailToast } from 'vant';
import { api } from '../api';
import type { ProjectProgressReport } from '../api';

const route = useRoute();
const router = useRouter();

const projectId = computed(() => String(route.params.id));
const report = ref<ProjectProgressReport | null>(null);
const loading = ref(true);
const error = ref('');

const expanded = ref<string>('');

async function load() {
  loading.value = true;
  try {
    report.value = await api.projectReport(projectId.value);
  } catch (e: any) {
    error.value = e.message || '加载失败';
  } finally {
    loading.value = false;
  }
}

onMounted(() => void load());

function toggle(taskId: string) {
  expanded.value = expanded.value === taskId ? '' : taskId;
}

function openDeliverable(taskId: string, nodeId: string) {
  void api.getDeliverable(taskId, nodeId).then((d) => {
    deliverableView.value = { title: d.node_name, markdown: d.markdown };
    deliverableOpen.value = true;
  }).catch(() => showFailToast('交付成果不存在'));
}

const deliverableOpen = ref(false);
const deliverableView = ref<{ title: string; markdown: string } | null>(null);

function statusType(s: string): string {
  if (s === 'success' || s === 'completed') return 'success';
  if (s === 'failed') return 'danger';
  if (['running', 'retrying', 'pending'].includes(s)) return 'warning';
  return 'default';
}

function nodeIcon(status: string): string {
  return ({ completed: 'checked', failed: 'close', running: 'clock-o', retrying: 'replay', waiting_approval: 'edit', cancelled: 'cross' } as Record<string, string>)[status] || 'arrow';
}
</script>

<template>
  <div class="page">
    <van-nav-bar title="项目进度成果表" left-arrow fixed placeholder @click-left="router.back()" />

    <van-loading v-if="loading" class="loading" vertical>加载中…</van-loading>

    <div v-else-if="error" class="err-state">
      <van-icon name="warning-o" size="48" color="var(--yellow)" />
      <div class="err-text">{{ error }}</div>
      <button class="wx-btn err-btn" @click="load">重新加载</button>
    </div>

    <div v-else-if="report" class="body">
      <!-- 汇总头 -->
      <div class="wx-group stat-card">
        <div class="stat-row">
          <div class="stat-item"><div class="stat-num">{{ report.totals.tasks }}</div><div class="stat-label">任务</div></div>
          <div class="stat-item ok"><div class="stat-num">{{ report.totals.tasks_success }}</div><div class="stat-label">完成</div></div>
          <div class="stat-item run"><div class="stat-num">{{ report.totals.tasks_running }}</div><div class="stat-label">进行中</div></div>
          <div class="stat-item bad"><div class="stat-num">{{ report.totals.tasks_failed }}</div><div class="stat-label">失败</div></div>
        </div>
        <div class="wx-caption flat">节点 {{ report.totals.nodes }}（完成 {{ report.totals.nodes_completed }} / 失败 {{ report.totals.nodes_failed }}） · 重试 {{ report.totals.retries }} · 交付成果 {{ report.totals.deliverables }} 份 · 累计 {{ Math.round(report.totals.duration_sec / 60) }} 分钟 · {{ report.totals.tokens.toLocaleString() }} tok</div>
      </div>

      <!-- 每任务卡片：展开看节点完整记录 -->
      <div class="wx-caption">任务记录（点任务展开节点）</div>
      <div class="wx-group">
        <div v-for="t in report.tasks" :key="t.task_id" class="task-block">
          <div class="t-row" @click="toggle(t.task_id)">
            <van-tag plain size="medium" :type="statusType(t.status) as any">{{ t.status }}</van-tag>
            <span class="t-desc">{{ t.description || t.task_id }}</span>
            <span class="t-tok">{{ t.tokens.toLocaleString() }}tok</span>
            <van-icon :name="expanded === t.task_id ? 'arrow-up' : 'arrow-down'" size="13" color="var(--text-3)" />
          </div>
          <div v-if="expanded === t.task_id" class="t-nodes">
            <div v-for="n in t.nodes" :key="n.node_id" class="n-row">
              <van-icon :name="nodeIcon(n.status)" size="14" :color="n.status === 'completed' ? 'var(--green)' : n.status === 'failed' ? 'var(--red)' : 'var(--text-3)'" />
              <span class="n-name">{{ n.name }}</span>
              <span class="n-meta">{{ n.agent }} · {{ n.duration_sec }}s<template v-if="n.retry_count"> · 重试{{ n.retry_count }}</template></span>
              <van-button
                v-if="n.deliverable"
                size="small"
                round
                type="primary"
                @click.stop="openDeliverable(t.task_id, n.node_id)"
              >交付成果</van-button>
            </div>
          </div>
        </div>
        <div v-if="!report.tasks.length" class="empty">项目暂无任务</div>
      </div>

      <!-- 交付成果阅读器 -->
      <van-popup v-model:show="deliverableOpen" position="bottom" :style="{ height: '82%' }" round>
        <div class="dl-viewer">
          <div class="dl-head">
            <span class="dl-title">交付成果 · {{ deliverableView?.title }}</span>
            <van-icon name="cross" size="18" @click="deliverableOpen = false" />
          </div>
          <div class="dl-body md" v-html="deliverableView?.markdown"></div>
        </div>
      </van-popup>
    </div>
  </div>
</template>

<style scoped>
.page { height: 100%; display: flex; flex-direction: column; background: var(--bg); }
.loading { margin: 60px auto; }
.body { flex: 1; min-height: 0; overflow-y: auto; -webkit-overflow-scrolling: touch; padding-bottom: 16px; }

.stat-card { padding: 16px 14px 10px; }
.stat-row { display: flex; gap: 8px; }
.stat-item { flex: 1; text-align: center; }
.stat-num { font-size: 24px; font-weight: 700; color: var(--text); font-variant-numeric: tabular-nums; }
.stat-item.ok .stat-num { color: var(--green); }
.stat-item.run .stat-num { color: var(--wx-orange); }
.stat-item.bad .stat-num { color: var(--red); }
.stat-label { font-size: 12px; color: var(--text-3); margin-top: 2px; }
.wx-caption.flat { padding: 8px 2px 0; text-transform: none; letter-spacing: 0; }

.task-block + .task-block { position: relative; }
.task-block + .task-block::before {
  content: ''; position: absolute; left: 16px; right: 0; top: 0;
  height: 1px; background: var(--border); transform: scaleY(0.5);
}
.t-row { display: flex; align-items: center; gap: 8px; padding: 12px 14px; cursor: pointer; }
.t-row:active { background: var(--panel-2); }
.t-desc { flex: 1; min-width: 0; font-size: 14px; color: var(--text); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.t-tok { font-size: 11px; color: var(--text-3); font-variant-numeric: tabular-nums; flex-shrink: 0; }
.t-nodes { border-top: 1px dashed var(--border); padding: 6px 14px 10px; }
.n-row { display: flex; align-items: center; gap: 8px; padding: 7px 0; }
.n-name { flex: 1; min-width: 0; font-size: 13px; color: var(--text); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.n-meta { font-size: 11px; color: var(--text-3); flex-shrink: 0; }

.err-state { display: flex; flex-direction: column; align-items: center; gap: 8px; padding: 64px 0; }
.err-text { font-size: 14px; color: var(--text-2); }
.err-btn { margin-top: 12px; max-width: 180px; }
.empty { text-align: center; color: var(--text-3); padding: 28px 0; }
</style>
