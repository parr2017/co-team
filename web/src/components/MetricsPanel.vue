<template>
  <div class="section">
    <div class="section-title">运行指标</div>
    <div class="metrics-summary" v-if="metrics">
      <div class="metric-row"><span>任务总数</span><b>{{ metrics.tasks.total }}</b></div>
      <div class="metric-row"><span>成功率</span><b>{{ Math.round(metrics.tasks.success_rate * 100) }}%</b></div>
      <div class="metric-row"><span>Token 总消耗</span><b>{{ metrics.tokens_total.toLocaleString() }}</b></div>
      <div class="metric-row"><span>总成本</span><b>${{ metrics.cost_total.toFixed(4) }}</b></div>
      <template v-if="metrics.quality">
        <div class="metric-row metric-quality-title">质量闭环</div>
        <div class="metric-row"><span>缺陷总数 / 已闭环</span><b>{{ metrics.quality.defects_total }} / {{ metrics.quality.defects_closed }}</b></div>
        <div class="metric-row"><span>缺陷闭环率</span><b>{{ Math.round(metrics.quality.defect_close_rate * 100) }}%</b></div>
        <div class="metric-row"><span>平均修复轮次</span><b>{{ metrics.quality.fix_rounds_avg }}</b></div>
        <div class="metric-row"><span>测试通过率（有报告节点）</span><b>{{ Math.round(metrics.quality.test_pass_rate * 100) }}%</b></div>
        <div class="metric-row"><span>交付一致率</span><b>{{ metrics.quality.delivery_checked_nodes ? Math.round(metrics.quality.delivery_consistent_rate * 100) + '%' : '—' }}</b></div>
      </template>
    </div>
    <div ref="trendChartEl" class="chart chart-tall"></div>
    <div ref="agentChartEl" class="chart"></div>
    <div ref="costChartEl" class="chart"></div>
  </div>
</template>

<script setup lang="ts">
import { nextTick, onMounted, onUnmounted, ref, watch } from 'vue';
import * as echarts from 'echarts';
import { api, type MetricsResponse, type TrendPoint } from '../api';
import { useTheme } from '../composables/useTheme';

const metrics = ref<MetricsResponse | null>(null);
const trend = ref<TrendPoint[]>([]);
const { theme, cssVar } = useTheme();
const agentChartEl = ref<HTMLElement>();
const costChartEl = ref<HTMLElement>();
const trendChartEl = ref<HTMLElement>();
let agentChart: echarts.ECharts | null = null;
let costChart: echarts.ECharts | null = null;
let trendChart: echarts.ECharts | null = null;
let timer: number | undefined;

async function refresh() {
  try {
    metrics.value = await api.metrics();
  } catch {
    /* ignore */
  }
  try {
    trend.value = (await api.metricsTrend(14)).trend;
  } catch {
    /* ignore */
  }
  renderCharts();
}

function renderCharts() {
  const m = metrics.value;
  if (!m) return;
  const c = {
    text2: cssVar('--ct-text2') || '#9aa0aa',
    text3: cssVar('--ct-text3') || '#666b75',
    border: cssVar('--ct-border') || '#26272c',
    accent: cssVar('--ct-accent') || '#4a8dff',
    green: cssVar('--ct-green') || '#3fb950',
    red: cssVar('--ct-red') || '#e5534b',
  };
  if (agentChartEl.value) {
    agentChart ||= echarts.init(agentChartEl.value);
    const names = Object.keys(m.agents);
    agentChart.setOption({
      title: { text: 'Agent 负载', textStyle: { color: c.text2, fontSize: 12 } },
      // 左侧留足类别标签宽度（"orchestrator" 12 字符），避免截断成 "herator"
      grid: { left: 92, right: 16, top: 30, bottom: 24 },
      xAxis: { type: 'value', axisLabel: { color: c.text3 }, splitLine: { lineStyle: { color: c.border } } },
      yAxis: { type: 'category', data: names, axisLabel: { color: c.text2 } },
      series: [
        { name: '完成', type: 'bar', stack: 'x', data: names.map((n) => m.agents[n].completed), itemStyle: { color: c.green } },
        { name: '失败', type: 'bar', stack: 'x', data: names.map((n) => m.agents[n].failed), itemStyle: { color: c.red } },
      ],
      tooltip: { trigger: 'axis' },
    });
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
      tooltip: { trigger: 'axis' },
      // 空数据空态：一条孤线看起来像渲染故障
      graphic: entries.length
        ? []
        : [{ type: 'text', left: 'center', top: 'middle', style: { text: '暂无 Token 消耗记录', fill: c.text3, fontSize: 12 } }],
    });
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
  }
}

onMounted(() => {
  refresh();
  timer = window.setInterval(refresh, 10_000);
  window.addEventListener('resize', onResize);
});
watch(theme, () => nextTick(renderCharts));
onUnmounted(() => {
  window.clearInterval(timer);
  window.removeEventListener('resize', onResize);
  // echarts 实例随组件销毁，避免 tab 反复切换累积实例
  agentChart?.dispose();
  costChart?.dispose();
  agentChart = null;
  costChart = null;
});
function onResize() {
  agentChart?.resize();
  costChart?.resize();
  trendChart?.resize();
}
defineExpose({ refresh });
</script>

<style scoped>
.metrics-summary { font-size: 12px; color: var(--ct-text2); margin-bottom: 10px; }
.metric-row { display: flex; justify-content: space-between; padding: 2px 0; }
.metric-row b { color: var(--ct-text); }
.metric-quality-title { margin-top: 6px; color: var(--ct-accent); font-weight: 600; }
.chart { height: 160px; margin-top: 6px; }
.chart-tall { height: 200px; }
</style>
