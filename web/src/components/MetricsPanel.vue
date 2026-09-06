<template>
  <div class="section">
    <div class="section-head">
      <div class="section-title">运行指标</div>
    </div>
    <div class="metrics-band" v-if="metrics">
      <div class="metric-box">
        <div class="m-num">{{ metrics.tasks.total }}</div>
        <div class="m-label">任务总数</div>
      </div>
      <div class="metric-box">
        <div class="m-num">{{ Math.round(metrics.tasks.success_rate * 100) }}<i>%</i></div>
        <div class="m-label">成功率</div>
      </div>
      <div class="metric-box">
        <div class="m-num">{{ metrics.tokens_total.toLocaleString() }}</div>
        <div class="m-label">Token 消耗</div>
      </div>
      <div class="metric-box">
        <div class="m-num">${{ metrics.cost_total.toFixed(4) }}</div>
        <div class="m-label">总成本</div>
      </div>
    </div>
    <div class="charts-row">
      <div ref="agentChartEl" class="chart"></div>
      <div ref="costChartEl" class="chart"></div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { nextTick, onMounted, onUnmounted, ref, watch } from 'vue';
import * as echarts from 'echarts';
import { api, type MetricsResponse } from '../api';
import { useTheme } from '../composables/useTheme';

const metrics = ref<MetricsResponse | null>(null);
const { theme, cssVar } = useTheme();
const agentChartEl = ref<HTMLElement>();
const costChartEl = ref<HTMLElement>();
let agentChart: echarts.ECharts | null = null;
let costChart: echarts.ECharts | null = null;
let timer: number | undefined;

async function refresh() {
  try {
    metrics.value = await api.metrics();
    renderCharts();
  } catch {
    /* ignore */
  }
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
}
defineExpose({ refresh });
</script>

<style scoped>
.metrics-band { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 10px; margin-bottom: 12px; }
.metric-box { background: var(--ct-bg); border: 1px solid var(--el-border-color); border-radius: 6px; padding: 12px 14px; }
.m-num { font-size: 20px; font-weight: 700; color: var(--ct-text); line-height: 1.2; }
.m-num i { font-style: normal; font-size: 13px; color: var(--ct-text3); }
.m-label { font-size: 11px; color: var(--ct-text3); margin-top: 3px; }
.charts-row { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
.chart { height: 170px; min-width: 0; }
.section-head { margin-bottom: 10px; }
@media (max-width: 900px) {
  .charts-row { grid-template-columns: 1fr; }
}
</style>
