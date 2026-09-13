<script setup lang="ts">
/**
 * 移动端运行指标页（OBS-3）：轻量 CSS 条形图，不引图表库。
 * 任务总览 / 质量闭环 / 失败分型 / Agent 负载与 Token / 模型成本 / 近 7 天趋势。
 */
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { api } from '../api';
import { useDashboard } from '../composables/useDashboard';

defineOptions({ name: 'MetricsView' });

const { connected } = useDashboard();

const metrics = ref<any>(null);
const trend = ref<{ date: string; tasks: number; defects_total: number; success_rate: number }[]>([]);
const loading = ref(true);
const error = ref('');

const FAILURE_LABEL: Record<string, string> = {
  budget: '预算耗尽', precondition: '前置条件', blocker: '阻塞', capacity: '容量受限',
  content: '内容质量', system: '系统错误', other: '其他',
};

async function load() {
  error.value = '';
  try {
    const [m, t] = await Promise.all([api.metrics(), api.metricsTrend(7).catch(() => ({ trend: [] }))]);
    metrics.value = m;
    trend.value = t.trend || [];
  } catch (e: any) {
    error.value = e?.message || '加载失败';
  } finally {
    loading.value = false;
  }
}
onMounted(() => { void load(); timer = window.setInterval(() => { if (document.visibilityState === 'visible') void load(); }, 30_000); });
let timer: ReturnType<typeof setInterval> | null = null;
onUnmounted(() => { if (timer) clearInterval(timer); });

const agentRows = computed(() => {
  const agents = metrics.value?.agents || {};
  return Object.entries(agents)
    .map(([name, s]: [string, any]) => ({
      name,
      completed: s.completed || 0,
      failed: s.failed || 0,
      retries: s.retries || 0,
      tokens: s.tokens || 0,
      total: (s.completed || 0) + (s.failed || 0),
    }))
    .sort((a, b) => b.total - a.total);
});
const agentMax = computed(() => Math.max(1, ...agentRows.value.map((r) => r.total)));

const failRows = computed(() => {
  const ft = metrics.value?.failure_types || {};
  const entries = Object.entries(ft).filter(([, v]) => (v as number) > 0) as [string, number][];
  const sum = entries.reduce((s, [, v]) => s + v, 0) || 1;
  return entries
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => ({ label: FAILURE_LABEL[k] || k, value: v, pct: Math.round((v / sum) * 100) }));
});

const modelRows = computed(() =>
  Object.entries(metrics.value?.token_usage || {})
    .map(([name, u]: [string, any]) => ({
      name,
      tokens: (u.prompt_tokens || 0) + (u.completion_tokens || 0),
      calls: u.calls || 0,
      cost: u.cost || 0,
    }))
    .sort((a, b) => b.cost - a.cost)
);
const modelMax = computed(() => Math.max(1, ...modelRows.value.map((r) => r.tokens)));

const trendMax = computed(() => Math.max(1, ...trend.value.map((t) => t.tasks)));
function fmtTok(n: number): string {
  if (n >= 1_000_000) return (Math.round(n / 100_000) / 10) + 'M';
  if (n >= 1000) return (Math.round(n / 100) / 10) + 'k';
  return String(n);
}
</script>

<template>
  <div class="page">
    <van-nav-bar safe-area-inset-top title="运行指标" fixed placeholder>
      <template #right>
        <span class="conn mono" :class="{ ok: connected }">{{ connected ? '实时' : '离线' }}</span>
      </template>
    </van-nav-bar>

    <div class="body">
      <van-loading v-if="loading" class="loading" vertical>加载中…</van-loading>
      <div v-else-if="error" class="err-state">
        <van-icon name="warning-o" size="48" color="var(--yellow)" />
        <div class="err-text">{{ error }}</div>
        <button class="wx-btn err-btn" @click="load">重新加载</button>
      </div>

      <template v-else-if="metrics">
        <!-- 任务总览 -->
        <div class="wx-group stat-card">
          <div class="stat-row">
            <div class="stat-item"><div class="stat-num">{{ metrics.tasks.total }}</div><div class="stat-label">任务</div></div>
            <div class="stat-item ok"><div class="stat-num">{{ Math.round(metrics.tasks.success_rate * 100) }}%</div><div class="stat-label">成功率</div></div>
            <div class="stat-item"><div class="stat-num">{{ fmtTok(metrics.tokens_total) }}</div><div class="stat-label">Token</div></div>
            <div class="stat-item"><div class="stat-num">${{ metrics.cost_total.toFixed(2) }}</div><div class="stat-label">成本</div></div>
          </div>
          <div v-if="metrics.quality" class="q-rows">
            <div class="q-row"><span>缺陷闭环</span><b>{{ metrics.quality.defects_closed }}/{{ metrics.quality.defects_total }}（{{ Math.round(metrics.quality.defect_close_rate * 100) }}%）</b></div>
            <div class="q-row"><span>测试通过率</span><b>{{ Math.round(metrics.quality.test_pass_rate * 100) }}%</b></div>
            <div class="q-row"><span>交付一致率</span><b>{{ metrics.quality.delivery_checked_nodes ? Math.round(metrics.quality.delivery_consistent_rate * 100) + '%' : '—' }}</b></div>
          </div>
        </div>

        <!-- 失败分型 -->
        <div class="wx-caption">失败分型</div>
        <div class="wx-group sec">
          <div v-if="failRows.length" v-for="f in failRows" :key="f.label" class="bar-row">
            <span class="bar-label">{{ f.label }}</span>
            <div class="bar-track"><div class="bar-fill red" :style="{ width: f.pct + '%' }"></div></div>
            <span class="bar-num mono">{{ f.value }}</span>
          </div>
          <div v-else class="sec-empty">暂无失败记录</div>
        </div>

        <!-- Agent 负载 -->
        <div class="wx-caption">成员负载</div>
        <div class="wx-group sec">
          <div v-if="agentRows.length" v-for="a in agentRows" :key="a.name" class="agent-row">
            <div class="agent-head">
              <span class="agent-name mono">{{ a.name }}</span>
              <span class="agent-meta mono">{{ fmtTok(a.tokens) }} tok<template v-if="a.retries"> · 重试{{ a.retries }}</template></span>
            </div>
            <div class="bar-track tall">
              <div class="bar-fill green" :style="{ width: (a.completed / agentMax * 100) + '%' }"></div>
              <div class="bar-fill red" :style="{ width: (a.failed / agentMax * 100) + '%' }"></div>
            </div>
          </div>
          <div v-else class="sec-empty">暂无成员数据</div>
        </div>

        <!-- 模型成本 -->
        <div class="wx-caption">模型消耗</div>
        <div class="wx-group sec">
          <div v-if="modelRows.length" v-for="m in modelRows" :key="m.name" class="agent-row">
            <div class="agent-head">
              <span class="agent-name mono">{{ m.name }}</span>
              <span class="agent-meta mono">{{ m.calls }} 次 · ${{ m.cost.toFixed(4) }}</span>
            </div>
            <div class="bar-track tall"><div class="bar-fill accent" :style="{ width: (m.tokens / modelMax * 100) + '%' }"></div></div>
          </div>
          <div v-else class="sec-empty">暂无调用记录</div>
        </div>

        <!-- 近 7 天趋势 -->
        <div class="wx-caption">近 7 天趋势</div>
        <div class="wx-group sec">
          <div v-if="trend.length" class="trend">
            <div v-for="t in trend" :key="t.date" class="trend-col">
              <div class="trend-bars">
                <div class="trend-bar accent" :style="{ height: Math.max(4, t.tasks / trendMax * 64) + 'px' }"></div>
                <div class="trend-bar red" :style="{ height: Math.max(2, t.defects_total / trendMax * 64) + 'px' }"></div>
              </div>
              <span class="trend-date mono">{{ t.date.slice(5) }}</span>
            </div>
          </div>
          <div v-else class="sec-empty">暂无趋势数据</div>
        </div>
      </template>
    </div>
  </div>
</template>

<style scoped>
.page { height: 100%; display: flex; flex-direction: column; background: var(--bg); }
.body { flex: 1; min-height: 0; overflow-y: auto; -webkit-overflow-scrolling: touch; padding-bottom: calc(16px + env(safe-area-inset-bottom)); }
.loading { margin: 60px auto; }
.conn { font-size: 12px; color: var(--text-3); }
.conn.ok { color: var(--ct-green); }
.err-state { display: flex; flex-direction: column; align-items: center; gap: 8px; padding: 64px 0; }
.err-text { font-size: 14px; color: var(--text-2); }
.err-btn { margin-top: 12px; max-width: 180px; }

.stat-card { padding: 16px 14px 12px; }
.stat-row { display: flex; gap: 8px; }
.stat-item { flex: 1; text-align: center; }
.stat-num { font-size: 22px; font-weight: 700; color: var(--text); font-variant-numeric: tabular-nums; }
.stat-item.ok .stat-num { color: var(--green); }
.stat-label { font-size: 12px; color: var(--text-3); margin-top: 2px; }
.q-rows { margin-top: 12px; border-top: 1px dashed var(--border); padding-top: 8px; }
.q-row { display: flex; justify-content: space-between; font-size: 12.5px; color: var(--text-2); padding: 3px 0; }
.q-row b { color: var(--text); font-variant-numeric: tabular-nums; }

.sec { padding: 12px 14px; }
.sec-empty { text-align: center; color: var(--text-3); font-size: 12.5px; padding: 18px 0; }
.bar-row { display: flex; align-items: center; gap: 10px; padding: 4px 0; }
.bar-label { flex: 0 0 64px; font-size: 12px; color: var(--text-2); }
.bar-track { flex: 1; height: 8px; border-radius: 4px; background: var(--panel-2); overflow: hidden; display: flex; }
.bar-track.tall { height: 10px; }
.bar-fill { height: 100%; border-radius: 4px; transition: width 0.4s ease; }
.bar-fill.red { background: var(--red); }
.bar-fill.green { background: var(--green); }
.bar-fill.accent { background: var(--accent); }
.bar-num { flex: 0 0 28px; text-align: right; font-size: 11px; color: var(--text-3); }

.agent-row { padding: 5px 0; }
.agent-head { display: flex; justify-content: space-between; align-items: baseline; margin-bottom: 3px; }
.agent-name { font-size: 12.5px; color: var(--text); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.agent-meta { font-size: 10.5px; color: var(--text-3); flex-shrink: 0; }
.bar-track.tall { margin-top: 2px; }
.bar-track.tall .bar-fill + .bar-fill { margin-left: 2px; }

.trend { display: flex; justify-content: space-between; align-items: flex-end; padding: 4px 0; }
.trend-col { display: flex; flex-direction: column; align-items: center; gap: 5px; flex: 1; }
.trend-bars { display: flex; align-items: flex-end; gap: 3px; height: 68px; }
.trend-bar { width: 10px; border-radius: 3px 3px 0 0; }
.trend-bar.accent { background: var(--accent); }
.trend-bar.red { background: var(--red); opacity: 0.7; }
.trend-date { font-size: 10px; color: var(--text-3); }
</style>
