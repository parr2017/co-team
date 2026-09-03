<template>
  <el-dialog :model-value="modelValue" title="任务拓扑图" width="820px" @close="$emit('close')">
    <div v-if="task" class="dag-info">
      <el-tag size="small">{{ task.description?.slice(0, 60) || task.task_id }}</el-tag>
      <el-tag size="small" type="info" style="margin-left: 8px">{{ statusLabel(task.status) }}</el-tag>
    </div>
    <div ref="chartEl" class="dag-chart"></div>
  </el-dialog>
</template>

<script setup lang="ts">
import { nextTick, ref, watch } from 'vue';
import * as echarts from 'echarts';
import type { TaskGraph } from '../api';
import { useTheme } from '../composables/useTheme';

const props = defineProps<{ modelValue: boolean; task: TaskGraph | null }>();
defineEmits<{ (e: 'close'): void }>();

const chartEl = ref<HTMLElement>();
const { theme, cssVar } = useTheme();
let chart: echarts.ECharts | null = null;

const STATUS_VAR: Record<string, string> = {
  completed: '--ct-green',
  success: '--ct-green',
  running: '--ct-yellow',
  retrying: '--ct-yellow',
  failed: '--ct-red',
  waiting_approval: '--ct-accent',
  cancelled: '--ct-text3',
  pending: '--ct-text3',
};

function statusLabel(s: string) {
  return ({ pending: '待执行', running: '执行中', success: '已完成', failed: '失败', waiting_approval: '待审批', cancelled: '已取消' } as Record<string, string>)[s] || s;
}

watch(
  () => [props.modelValue, props.task] as const,
  async ([visible, task]) => {
    if (!visible || !task) return;
    await renderDag(task);
  }
);

async function renderDag(task: TaskGraph) {
  await nextTick();
  if (!chartEl.value) return;
  chart ||= echarts.init(chartEl.value);
    // layered DAG layout: level = longest path from roots; x by level, y by order within level
    const levels = computeLevels(task);
    const byLevel = new Map<number, string[]>();
    task.nodes.forEach((n) => {
      const list = byLevel.get(levels.get(n.id) || 0) || [];
      list.push(n.id);
      byLevel.set(levels.get(n.id) || 0, list);
    });
    const xStep = 200;
    const yStep = 110;
    const positions = new Map<string, [number, number]>();
    for (const [level, ids] of byLevel) {
      ids.forEach((id, i) => {
        const height = (byLevel.size - 1) * yStep;
        positions.set(id, [level * xStep, ids.length === 1 ? height / 2 : (i * height) / (ids.length - 1)]);
      });
    }
    const nodes = task.nodes.map((n) => {
      const [x, y] = positions.get(n.id) || [0, 0];
      return {
        id: n.id,
        name: n.name.length > 18 ? n.name.slice(0, 18) + '…' : n.name,
        x,
        y,
        symbolSize: 40,
        itemStyle: { color: cssVar(STATUS_VAR[n.status] || '--ct-text3') || '#888', borderColor: cssVar('--ct-border') || '#26272c', borderWidth: 2 },
        label: { show: true, formatter: `${n.name}\n(${n.agent})`, fontSize: 10, color: cssVar('--ct-text') || '#d7dae0', position: 'bottom' as const },
      };
    });
    const edges = task.edges.map(([src, dst]) => ({
      source: src,
      target: dst,
      lineStyle: { color: cssVar('--ct-border2') || '#33353b', width: 2, curveness: 0.1 },
    }));
    chart.setOption(
      {
        tooltip: {
          formatter: (p: any) => {
            if (p.dataType === 'node') {
              const n = task.nodes.find((x) => x.id === p.id || p.data.id === x.id);
              if (!n) return p.name;
              return `${n.name}<br/>agent: ${n.agent}<br/>状态: ${statusLabel(n.status)}<br/>重试: ${n.retry_count}${n.error ? `<br/>错误: ${n.error}` : ''}`;
            }
            return '';
          },
        },
        series: [
          {
            type: 'graph',
            layout: 'none',
            roam: true,
            data: nodes,
            links: edges,
            edgeSymbol: ['none', 'arrow'],
            edgeSymbolSize: 10,
            label: { show: true },
          },
        ],
      },
      true
    );
    chart.resize();
}

watch(theme, () => {
  if (props.modelValue && props.task) void renderDag(props.task);
});

function computeLevels(task: TaskGraph): Map<string, number> {
  const deps = new Map<string, string[]>();
  task.nodes.forEach((n) => deps.set(n.id, []));
  task.edges.forEach(([src, dst]) => deps.get(dst)?.push(src));
  const levels = new Map<string, number>();
  const resolve = (id: string, seen: Set<string>): number => {
    if (levels.has(id)) return levels.get(id)!;
    if (seen.has(id)) return 0; // cycle guard
    seen.add(id);
    const parents = deps.get(id) || [];
    const level = parents.length === 0 ? 0 : Math.max(...parents.map((p) => resolve(p, seen) + 1));
    levels.set(id, level);
    return level;
  };
  task.nodes.forEach((n) => resolve(n.id, new Set()));
  return levels;
}
</script>

<style scoped>
.dag-info { margin-bottom: 8px; }
.dag-chart { height: 460px; }
</style>
