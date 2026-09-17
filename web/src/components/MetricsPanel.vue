<template>
  <div class="section">
    <div class="section-head">
      <div class="section-title">运行指标</div>
    </div>
    <div v-if="loadError && !metrics" class="metrics-error">
      <span>指标加载失败{{ loadError }}</span>
      <el-button size="small" link type="primary" @click="refresh">重试</el-button>
    </div>
    <div class="statrow" v-if="metrics">
      <div class="stat">
        <div class="k">任务总数</div>
        <div class="v mono">{{ metrics.tasks.total }}</div>
      </div>
      <div class="stat">
        <div class="k">成功率</div>
        <div class="v mono">{{ Math.round(metrics.tasks.success_rate * 100) }}<i>%</i></div>
      </div>
      <div class="stat">
        <div class="k">Token 消耗</div>
        <div class="v mono">{{ metrics.tokens_total.toLocaleString() }}</div>
      </div>
      <div class="stat">
        <div class="k">总成本</div>
        <div class="v mono">${{ metrics.cost_total.toFixed(4) }}</div>
      </div>
    </div>
    <div class="metrics-summary" v-if="metrics?.quality">
      <div class="metric-row metric-quality-title">质量闭环</div>
      <div class="metric-row"><span>缺陷总数 / 已闭环</span><b>{{ metrics.quality.defects_total }} / {{ metrics.quality.defects_closed }}</b></div>
      <div class="metric-row"><span>缺陷闭环率</span><b>{{ Math.round(metrics.quality.defect_close_rate * 100) }}%</b></div>
      <div class="metric-row"><span>平均修复轮次</span><b>{{ metrics.quality.fix_rounds_avg }}</b></div>
      <div class="metric-row"><span>测试通过率（有报告节点）</span><b>{{ Math.round(metrics.quality.test_pass_rate * 100) }}%</b></div>
      <div class="metric-row"><span>交付一致率</span><b>{{ metrics.quality.delivery_checked_nodes ? Math.round(metrics.quality.delivery_consistent_rate * 100) + '%' : '—' }}</b></div>
    </div>
    <div ref="trendChartEl" class="chart chart-tall"></div>
    <div class="charts-row">
      <div ref="agentChartEl" class="chart"></div>
      <div ref="costChartEl" class="chart"></div>
    </div>
    <div class="charts-row">
      <div ref="failChartEl" class="chart"></div>
      <div class="model-cost">
        <div class="mc-title mono">模型成本明细</div>
        <div v-if="modelCostRows.length">
          <div v-for="r in modelCostRows" :key="r.name" class="mc-row">
            <span class="mc-name mono" :title="r.name">{{ r.name }}</span>
            <span class="mc-calls mono">{{ r.calls }} 次</span>
            <span class="mc-cost mono">${{ r.cost.toFixed(4) }}</span>
          </div>
        </div>
        <div v-else class="mc-empty mono">暂无调用记录</div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue';
import * as echarts from 'echarts';
import { api, type MetricsResponse, type TrendPoint } from '../api';
import { useTheme } from '../composables/useTheme';

const metrics = ref<MetricsResponse | null>(null);
const trend = ref<TrendPoint[]>([]);
const loadError = ref('');
const { theme, cssVar } = useTheme();
const agentChartEl = ref<HTMLElement>();
const costChartEl = ref<HTMLElement>();
const trendChartEl = ref<HTMLElement>();
const failChartEl = ref<HTMLElement>();
let agentChart: echarts.ECharts | null = null;
let costChart: echarts.ECharts | null = null;
let trendChart: echarts.ECharts | null = null;
let failChart: echarts.ECharts | null = null;
let timer: number | undefined;

const FAILURE_LABEL: Record<string, string> = {
  budget: '预算耗尽', precondition: '前置条件', blocker: '阻塞', capacity: '容量受限',
  content: '内容质量', system: '系统错误', other: '其他',
};

/** token_usage 的成本明细行（服务端给了 cost/calls，此前从未露出） */
const modelCostRows = computed(() =>
  Object.entries(metrics.value?.token_usage || {})
    .map(([name, u]) => ({ name, calls: u.calls || 0, cost: u.cost || 0 }))
    .sort((a, b) => b.cost - a.cost)
);

async function refresh() {
  loadError.value = '';
  try {
    metrics.value = await api.metrics();
  } catch (e: any) {
    loadError.value = e?.message ? `（${e.message}）` : '';
  }
  try {
    trend.value = (await api.metricsTrend(14)).trend;
  } catch {
    /* ignore */
  }
  renderCharts();
}

function baseColors() {
  return {
    text2: cssVar('--ct-text2') || '#9aa0aa',
    text3: cssVar('--ct-text3') || '#666b75',
    border: cssVar('--ct-border') || '#26272c',
    accent: cssVar('--ct-accent') || '#4a8dff',
    green: cssVar('--ct-green') || '#3fb950',
    red: cssVar('--ct-red') || '#e5534b',
    yellow: cssVar('--ct-yellow') || '#d29922',
  };
}

function renderCharts() {
  const m = metrics.value;
  if (!m) return;
  const c = baseColors();
  if (agentChartEl.value) {
    agentChart ||= echarts.init(agentChartEl.value);
    const names = Object.keys(m.agents);
    agentChart.setOption({
      title: { text: 'Agent 负载', textStyle: { color: c.text2, fontSize: 12 } },
      // 左侧留足类别标签宽度（"orchestrator" 12 字符），避免截断
      grid: { left: 92, right: 16, top: 30, bottom: 24 },
      xAxis: { type: 'value', axisLabel: { color: c.text3 }, splitLine: { lineStyle: { color: c.border } } },
      yAxis: { type: 'category', data: names, axisLabel: { color: c.text2 } },
      series: [
        { name: '完成', type: 'bar', stack: 'x', data: names.map((n) => m.agents[n].completed), itemStyle: { color: c.green } },
        { name: '失败', type: 'bar', stack: 'x', data: names.map((n) => m.agents[n].failed), itemStyle: { color: c.red } },
        { name: '重试', type: 'bar', stack: 'x', data: names.map((n) => m.agents[n].retries || 0), itemStyle: { color: c.yellow } },
      ],
      tooltip: {
        trigger: 'axis',
        formatter: (params: any) => {
          const name = Array.isArray(params) ? params[0]?.name : '';
          const stat = m.agents[name];
          const rows = Array.isArray(params) ? params.map((p: any) => `${p.marker}${p.seriesName} ${p.value ?? 0}`).join('<br/>') : '';
          const tok = stat?.tokens ? `<br/>Token ${stat.tokens.toLocaleString()}` : '';
          return `${name}<br/>${rows}${tok}`;
        },
      },
    });
    agentChart.resize();
  }
  if (costChartEl.value) {
    costChart ||= echarts.init(costChartEl.value);
    const entries = Object.entries(m.token_usage);
    costChart.setOption({
      title: { text: '模型 Token 消耗', textStyle: { color: c.text2, fontSize: 12 } },
      grid: { left: 60, right: 16, top: 30, bottom: 40 },
      xAxis: { type: 'category', data: entries.map(([n]) => n), axisLabel: { color: c.text3, fontSize: 10, rotate: 20 } },
      yAxis: { type: 'value', axisLabel: { color: c.text3 }, splitLine: { lineStyle: { color: c.border } } },
      series: [
        { type: 'bar', data: entries.map(([, u]) => u.prompt_tokens + u.completion_tokens), itemStyle: { color: c.accent } },
      ],
      tooltip: {
        trigger: 'axis',
        formatter: (params: any) => {
          const p = Array.isArray(params) ? params[0] : null;
          const u = p ? m.token_usage[p.name] : null;
          if (!u) return p?.name || '';
          return `${p!.name}<br/>Token ${(u.prompt_tokens + u.completion_tokens).toLocaleString()}<br/>调用 ${u.calls} 次 · $${u.cost.toFixed(4)}`;
        },
      },
      // 空数据空态：一条孤线看起来像渲染故障
      graphic: entries.length
        ? []
        : [{ type: 'text', left: 'center', top: 'middle', style: { text: '暂无 Token 消耗记录', fill: c.text3, fontSize: 12 } }],
    });
    costChart.resize();
  }
  if (failChartEl.value) {
    failChart ||= echarts.init(failChartEl.value);
    const fails = Object.entries(m.failure_types || {}).filter(([, v]) => v > 0);
    failChart.setOption({
      title: { text: '失败分型', textStyle: { color: c.text2, fontSize: 12 } },
      series: [
        {
          type: 'pie',
          radius: ['40%', '60%'],
          center: ['50%', '58%'],
          data: fails.map(([k, v]) => ({ name: FAILURE_LABEL[k] || k, value: v })),
          label: { color: c.text3, fontSize: 10 },
          itemStyle: { borderColor: 'transparent', borderWidth: 2 },
          color: [c.red, c.yellow, c.accent, c.green, '#b3559e', '#c98a3a', c.text3],
        },
      ],
      tooltip: { trigger: 'item' },
      graphic: fails.length
        ? []
        : [{ type: 'text', left: 'center', top: 'middle', style: { text: '暂无失败记录', fill: c.text3, fontSize: 12 } }],
    });
    failChart.resize();
  }
  if (trendChartEl.value) {
    trendChart ||= echarts.init(trendChartEl.value);
    trendChart.setOption({
      title: { text: '质量趋势（近 14 天）', textStyle: { color: c.text2, fontSize: 12 } },
      grid: { left: 40, right: 40, top: 30, bottom: 40 },
      legend: { textStyle: { color: c.text3, fontSize: 10 }, top: 26 },
      xAxis: { type: 'category', data: trend.value.map((t) => t.date.slice(5)), axisLabel: { color: c.text3, fontSize: 10 } },
      yAxis: [
        { type: 'value', axisLabel: { color: c.text3 }, splitLine: { lineStyle: { color: c.border } } },
        { type: 'value', min: 0, max: 1, axisLabel: { color: c.text3, formatter: (v: number) => Math.round(v * 100) + '%' }, splitLine: { show: false } },
      ],
      series: [
        { name: '任务数', type: 'bar', data: trend.value.map((t) => t.tasks), itemStyle: { color: c.accent } },
        { name: '缺陷数', type: 'bar', data: trend.value.map((t) => t.defects_total), itemStyle: { color: c.red } },
        { name: '成功率', type: 'line', yAxisIndex: 1, data: trend.value.map((t) => t.success_rate), itemStyle: { color: c.green }, smooth: true },
      ],
      tooltip: { trigger: 'axis' },
    });
    trendChart.resize();
  }
}

onMounted(() => {
  refresh();
  timer = window.setInterval(refresh, 10_000);
  window.addEventListener('resize', onResize);
});
watch(theme, () => nextTick(() => {
  // 主题切换：重建颜色（setOption 全量覆盖）
  renderCharts();
}));
onUnmounted(() => {
  window.clearInterval(timer);
  window.removeEventListener('resize', onResize);
  // echarts 实例随组件销毁，避免 tab 反复切换累积实例
  agentChart?.dispose();
  costChart?.dispose();
  trendChart?.dispose();
  failChart?.dispose();
  agentChart = null;
  costChart = null;
  trendChart = null;
  failChart = null;
});
function onResize() {
  agentChart?.resize();
  costChart?.resize();
  trendChart?.resize();
  failChart?.resize();
}
defineExpose({ refresh });
</script>

<style scoped>
/* 统计行（预览 statrow：分割线单容器 + mono 大数字） */
.statrow { display: flex; border: 1px solid var(--line); border-radius: var(--r-panel); background: var(--bg-panel); margin-bottom: 12px; flex-wrap: wrap; }
.stat { flex: 1; padding: 14px 18px; min-width: 140px; }
.stat + .stat { border-left: 1px solid var(--line); }
.stat .k { font-size: var(--fs-aux); color: var(--text-2); display: flex; align-items: center; gap: 6px; }
.stat .v { font-size: 24px; font-weight: 700; letter-spacing: -.02em; color: var(--text-1); margin-top: 3px; font-variant-numeric: tabular-nums; }
.stat .v i { font-style: normal; font-size: 14px; color: var(--text-3); }
.charts-row { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; margin-bottom: 14px; }
.chart { height: 170px; min-width: 0; }
.chart-tall { height: 200px; }
/* 图表容器统一（chartbox） */
.chart, .chart-tall, .model-cost {
  border: 1px solid var(--line); border-radius: var(--r-panel); background: var(--bg-panel); padding: 14px 16px;
}
.metrics-summary { font-size: var(--fs-aux); color: var(--text-2); margin-bottom: 10px; }
.metric-row { display: flex; justify-content: space-between; padding: 2px 0; }
.metric-row b { color: var(--text-1); font-family: var(--font-mono); font-weight: 600; }
.metric-quality-title { margin-top: 6px; color: var(--accent); font-weight: 600; }
.metrics-error { display: flex; align-items: center; gap: 10px; color: var(--danger); font-size: var(--fs-aux); padding: 10px 0; }
.model-cost { font-size: var(--fs-aux); overflow: hidden; }
.mc-title { font-size: var(--fs-meta); color: var(--text-3); margin-bottom: 8px; }
.mc-row { display: flex; align-items: center; gap: 8px; padding: 3px 0; min-width: 0; }
.mc-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--text-2); }
.mc-calls { color: var(--text-3); flex-shrink: 0; }
.mc-cost { color: var(--text-1); flex-shrink: 0; }
.mc-empty { color: var(--text-3); text-align: center; padding: 24px 0; }
@media (max-width: 900px) {
  .charts-row { grid-template-columns: 1fr; }
}
</style>
