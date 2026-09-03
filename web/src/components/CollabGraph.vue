<template>
  <div ref="chartEl" class="collab-graph"></div>
</template>

<script setup lang="ts">
import { nextTick, onUnmounted, ref, watch } from 'vue';
import * as echarts from 'echarts';
import type { TaskGraph } from '../api';
import { useTheme } from '../composables/useTheme';

const props = defineProps<{ task: TaskGraph | null; selectedAgent?: string }>();
const emit = defineEmits<{ (e: 'select', agent: string): void }>();

const chartEl = ref<HTMLElement>();
let chart: echarts.ECharts | null = null;
const { theme, cssVar } = useTheme();

function statusColor(statuses: string[]): string {
  if (statuses.includes('failed')) return cssVar('--ct-red') || '#e5534b';
  if (statuses.includes('running') || statuses.includes('retrying')) return cssVar('--ct-yellow') || '#d29922';
  if (statuses.every((s) => s === 'completed') && statuses.length) return cssVar('--ct-green') || '#3fb950';
  if (statuses.includes('waiting_approval')) return cssVar('--ct-accent') || '#4a8dff';
  return cssVar('--ct-text3') || '#666b75';
}

function render() {
  const task = props.task;
  if (!task || !chartEl.value) return;
  chart ||= echarts.init(chartEl.value);

  // agents participating in this task (orchestrator stays in the center)
  const agents: { name: string; statuses: string[]; current: string; actions: number }[] = [];
  for (const n of task.nodes) {
    if (n.agent === 'orchestrator') continue;
    let a = agents.find((x) => x.name === n.agent);
    if (!a) {
      a = { name: n.agent, statuses: [], current: '', actions: 0 };
      agents.push(a);
    }
    a.statuses.push(n.status);
    a.actions += 1;
    if (n.status === 'running' || n.status === 'retrying') a.current = n.name;
  }

  const cx = 260;
  const cy = 200;
  const radius = 150;
  const nodes: any[] = [
    {
      id: '__master__',
      name: '主 Agent',
      x: cx,
      y: cy,
      symbol: 'roundRect',
      symbolSize: [110, 40],
      itemStyle: { color: cssVar('--ct-accent') || '#4a8dff', borderColor: cssVar('--ct-border2'), borderWidth: 1 },
      label: { show: true, formatter: '主 Agent\n(编排)', color: '#fff', fontSize: 11, position: 'inside' },
    },
  ];
  agents.forEach((a, i) => {
    const angle = -Math.PI / 2 + (i * 2 * Math.PI) / Math.max(1, agents.length);
    nodes.push({
      id: a.name,
      name: a.name,
      x: cx + radius * Math.cos(angle),
      y: cy + radius * Math.sin(angle),
      symbolSize: [96, 34],
      symbol: 'roundRect',
      itemStyle: { color: cssVar('--ct-panel'), borderColor: statusColor(a.statuses), borderWidth: 2 },
      label: {
        show: true,
        formatter: `{name|${a.name}}\n{act|${(a.current || `${a.actions} 节点`).slice(0, 16)}}`,
        rich: {
          name: { fontSize: 11, color: cssVar('--ct-text') || '#d7dae0', fontWeight: 'bold', align: 'center' },
          act: { fontSize: 9, color: cssVar('--ct-text3') || '#666', align: 'center', width: 110, overflow: 'truncate' },
        },
        position: 'inside',
      },
    });
  });

  // edges: assignment out (solid), report back (dashed) — colored by the agent's state
  const links: any[] = [];
  for (const a of agents) {
    const color = statusColor(a.statuses);
    links.push({ source: '__master__', target: a.name, lineStyle: { color, width: 1.6, curveness: 0.12 }, label: { show: false } });
    links.push({ source: a.name, target: '__master__', lineStyle: { color, width: 1, type: 'dashed', curveness: 0.12, opacity: 0.7 } });
  }

  chart.setOption(
    {
      series: [
        {
          type: 'graph', layout: 'none', data: nodes, links,
          edgeSymbol: ['none', 'arrow'], edgeSymbolSize: 9, roam: false, top: 10, bottom: 10,
          // running members pulse via a slightly larger animated symbol border
          animationDurationUpdate: 400,
        },
      ],
      tooltip: {
        formatter: (p: any) => {
          if (p.dataType !== 'node') return '';
          if (p.data.id === '__master__') return '主 Agent：拆解任务、分配节点、回收结果、合并分支';
          const sts = agents.find((a) => a.name === p.data.id);
          const nodeRows = task.nodes.filter((n) => n.agent === p.data.id).map((n) => `· ${n.name} [${n.status}]${n.branch ? ' ⎇' + n.branch : ''}`);
          return `<b>${p.data.id}</b><br/>${nodeRows.join('<br/>')}${sts?.current ? `<br/>当前: ${sts.current}` : ''}`;
        },
      },
    },
    true
  );
  bindClick();
  chart.resize();
}

function bindClick() {
  chart?.off('click');
  chart?.on('click', (p: any) => {
    if (p.dataType === 'node' && p.data.id !== '__master__') emit('select', p.data.id);
  });
}

watch(() => [props.task, props.selectedAgent, theme.value] as const, async () => {
  await nextTick();
  render();
}, { deep: true, immediate: true });
watch(chartEl, (el) => { if (el) void nextTick(render); });
onUnmounted(() => {
  chart?.dispose();
  chart = null;
});
</script>

<style scoped>
.collab-graph { width: 100%; height: 380px; }
</style>
