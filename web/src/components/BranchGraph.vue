<template>
  <div ref="chartEl" class="branch-graph"></div>
</template>

<script setup lang="ts">
import { nextTick, onUnmounted, ref, watch } from 'vue';
import * as echarts from 'echarts';
import type { TaskGraph } from '../api';
import { useTheme } from '../composables/useTheme';

const props = defineProps<{ task: TaskGraph | null }>();
const emit = defineEmits<{ (e: 'select', nodeId: string): void }>();

const chartEl = ref<HTMLElement>();
let chart: echarts.ECharts | null = null;
const { theme, cssVar } = useTheme();

const STATUS_VAR: Record<string, string> = {
  completed: '--ct-green',
  success: '--ct-green',
  running: '--ct-yellow',
  retrying: '--ct-yellow',
  failed: '--ct-red',
  waiting_approval: '--ct-accent',
  cancelled: '--ct-text3',
  pending: '--ct-text3',
  planned: '--ct-text3',
};

interface Lane { agent: string; y: number }

function build(task: TaskGraph) {
  // git swimlanes: one lane per agent (orchestrator last), nodes placed by topological level
  const levels = computeLevels(task);
  const agents: string[] = [];
  for (const n of task.nodes) if (!agents.includes(n.agent)) agents.push(n.agent);
  agents.sort((a, b) => (a === 'orchestrator' ? 1 : b === 'orchestrator' ? -1 : a.localeCompare(b)));
  const lanes = new Map<string, number>();
  agents.forEach((a, i) => lanes.set(a, i));

  const xStep = 170;
  const laneH = 64;
  const height = Math.max(240, agents.length * laneH + 40);
  const nodes = task.nodes.map((n) => {
    const level = levels.get(n.id) || 0;
    return {
      id: n.id,
      name: n.name,
      agent: n.agent,
      branch: n.branch,
      level,
      lane: lanes.get(n.agent) ?? 0,
      x: 70 + level * xStep,
      y: (lanes.get(n.agent) ?? 0) * laneH + 30,
    };
  });
  return { nodes, edges: task.edges, height, agents };
}

function render() {
  const task = props.task;
  if (!task || !chartEl.value) return;
  chart ||= echarts.init(chartEl.value);
  const { nodes, edges, height, agents } = build(task);
  const color = (status: string) => cssVar(STATUS_VAR[status] || '--ct-text3') || '#888';
  const byId = new Map(nodes.map((n) => [n.id, n]));

  const graphNodes = nodes.map((n) => ({
    id: n.id,
    name: n.name.length > 20 ? n.name.slice(0, 20) + '…' : n.name,
    x: n.x,
    y: n.y,
    symbol: 'roundRect',
    symbolSize: [120, 30],
    itemStyle: { color: 'transparent', borderColor: color(statusOf(task, n.id)), borderWidth: 1.5 },
    label: {
      show: true,
      formatter: `{name|${n.name}}\n{meta|${badge(n.agent)}${n.branch ? ' ⎇' + n.branch.replace('coteam/', '') : ''}}`,
      rich: {
        name: { fontSize: 10, color: cssVar('--ct-text') || '#d7dae0', width: 110, overflow: 'truncate' },
        meta: { fontSize: 9, color: cssVar('--ct-text3') || '#666', fontFamily: 'monospace' },
      },
      position: 'inside' as const,
    },
  }));
  const graphEdges = edges.map(([src, dst]) => {
    const a = byId.get(src);
    const b = byId.get(dst);
    const crossLane = a && b && a.lane !== b.lane;
    return {
      source: src,
      target: dst,
      lineStyle: { color: cssVar(crossLane ? '--ct-accent' : '--ct-border2') || '#333', width: crossLane ? 1.6 : 1.2, type: crossLane ? 'dashed' : 'solid', curveness: 0.08 },
    };
  });

  chart.setOption(
    {
      height,
      grid: { left: 0 },
      xAxis: { show: false, min: 0, max: Math.max(1, Math.max(...nodes.map((n) => n.level)) + 1) * 170 + 60 },
      yAxis: { show: false, min: -10, max: Math.max(1, agents.length) * 64 + 20, inverse: true },
      series: [
        {
          type: 'graph',
          layout: 'none',
          data: graphNodes,
          links: graphEdges,
          edgeSymbol: ['none', 'arrow'],
          edgeSymbolSize: 9,
          coordinateSystem: 'cartesian2d',
          label: { show: true },
          emphasis: { scale: 1.05 },
        },
      ],
      tooltip: {
        formatter: (p: any) => {
          if (p.dataType !== 'node') return '';
          const n = task.nodes.find((x) => x.id === p.data.id);
          if (!n) return '';
          return `${n.name}<br/>agent: ${n.agent}${n.reason ? `<br/>理由: ${n.reason}` : ''}${n.branch ? `<br/>分支: ${n.branch}` : ''}<br/>状态: ${n.status}${n.error ? `<br/>错误: ${n.error}` : ''}`;
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
    if (p.dataType === 'node') emit('select', p.data.id);
  });
}

function statusOf(task: TaskGraph, id: string): string {
  return task.nodes.find((n) => n.id === id)?.status || 'pending';
}
function badge(agent: string): string {
  const CODES: Record<string, string> = { orchestrator: 'OR', dev: 'DV', deploy: 'DP', docs: 'DO', refactor: 'RF', review: 'RV', test: 'TE' };
  return CODES[agent] || agent.slice(0, 2).toUpperCase();
}

function computeLevels(task: TaskGraph): Map<string, number> {
  const deps = new Map<string, string[]>();
  task.nodes.forEach((n) => deps.set(n.id, []));
  task.edges.forEach(([src, dst]) => deps.get(dst)?.push(src));
  const levels = new Map<string, number>();
  const resolve = (id: string, seen: Set<string>): number => {
    if (levels.has(id)) return levels.get(id)!;
    if (seen.has(id)) return 0;
    seen.add(id);
    const parents = deps.get(id) || [];
    const level = parents.length === 0 ? 0 : Math.max(...parents.map((p) => resolve(p, seen) + 1));
    levels.set(id, level);
    return level;
  };
  task.nodes.forEach((n) => resolve(n.id, new Set()));
  return levels;
}

watch(() => [props.task, theme.value] as const, async () => {
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
.branch-graph { width: 100%; height: 100%; min-height: 240px; }
</style>
