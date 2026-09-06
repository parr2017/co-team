<template>
  <el-dialog :model-value="modelValue" title="每日问题报告" width="820px" @open="onOpen" @close="$emit('close')">
    <div class="sheet">
      <div class="toolbar">
        <el-select v-model="selectedDate" size="small" style="width: 160px" @change="reload">
          <el-option v-for="r in reports" :key="r.date" :label="`报告 ${r.date}`" :value="r.date" />
        </el-select>
        <span v-if="current" class="meta mono">生成于 {{ fmtTime(current.generated_at) }} · {{ current.items.length }} 类问题</span>
        <el-button size="small" style="margin-left: auto" @click="reload">刷新</el-button>
      </div>

      <div v-if="!current || current.items.length === 0" class="empty mono">暂无问题报告 —— 开关在「设置 → 通用 → 每日问题报告」</div>

      <div v-else class="items">
        <div v-for="item in current.items" :key="item.id" class="item" :class="{ done: current.resolved[item.id] }">
          <div class="item-head">
            <span class="cat mono" :class="item.category">{{ CATEGORY_LABELS[item.category] || item.category }}</span>
            <span class="count mono">× {{ item.count }}</span>
            <span class="time mono">{{ fmtTime(item.last_seen) }}</span>
            <span v-if="current.resolved[item.id]" class="resolved mono">
              已处理 · {{ ACTION_LABELS[current.resolved[item.id].action] || current.resolved[item.id].action }}
              <template v-if="current.resolved[item.id].task_id"> · 任务 {{ current.resolved[item.id].task_id }}</template>
            </span>
          </div>
          <div class="sample mono">{{ item.sample }}</div>
          <div v-if="item.sources.length" class="sources mono">
            来源:
            <template v-for="(s, i) in item.sources.slice(0, 3)" :key="i">
              <el-link v-if="s.task_id" type="primary" :underline="false" class="src" @click="$emit('open-task', s.task_id)">
                {{ s.task_id }}{{ s.node_name ? ` / ${s.node_name}` : '' }}
              </el-link>
            </template>
          </div>
          <div v-if="!current.resolved[item.id]" class="ops">
            <el-button size="small" type="primary" :loading="resolving === item.id" @click="resolve(item, 'create_task')">转为修复任务</el-button>
            <el-button size="small" @click="resolve(item, 'skip')">忽略</el-button>
          </div>
        </div>
      </div>
    </div>
  </el-dialog>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue';
import { ElMessage } from 'element-plus';
import { api, type DailyReport } from '../api';

// feature: 每日问题沉淀报告 —— 汇总展示 + 用户决策（转为修复任务 / 忽略）

const props = defineProps<{ modelValue: boolean }>();
const emit = defineEmits<{ (e: 'close'): void; (e: 'open-task', taskId: string): void }>();

const reports = ref<DailyReport[]>([]);
const selectedDate = ref('');
const resolving = ref('');

const current = computed(() => reports.value.find((r) => r.date === selectedDate.value) || reports.value[0] || null);

const CATEGORY_LABELS: Record<string, string> = {
  model_env: '环境/模型',
  code_defect: '代码缺陷',
  command_risk: '命令风险',
  requirement: '需求问题',
  other: '其他',
};
const ACTION_LABELS: Record<string, string> = { fix_now: '已修复', create_task: '已转任务', skip: '已忽略' };

function fmtTime(ts: string): string {
  try {
    return new Date(ts).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
  } catch {
    return ts;
  }
}

async function reload() {
  try {
    const d = await api.listDailyReports();
    reports.value = d.reports;
    if (!selectedDate.value && reports.value.length) selectedDate.value = reports.value[0].date;
  } catch (e: any) {
    ElMessage.error(e.message);
  }
}

function onOpen() {
  selectedDate.value = '';
  void reload();
}

async function resolve(item: { id: string }, action: 'create_task' | 'skip') {
  if (!current.value) return;
  resolving.value = item.id;
  try {
    const r = await api.resolveReportItem(current.value.date, item.id, action);
    if (action === 'create_task' && r.task_id) {
      ElMessage.success(`修复任务已创建：${r.task_id}（等待计划评审）`);
      emit('open-task', r.task_id);
    } else {
      ElMessage.info('已忽略该问题');
    }
    await reload();
  } catch (e: any) {
    ElMessage.error(e.message);
  } finally {
    resolving.value = '';
  }
}
</script>

<style scoped>
.sheet { font-size: 13px; }
.toolbar { display: flex; align-items: center; gap: 10px; margin-bottom: 12px; }
.meta { font-size: 11px; color: var(--ct-text3); }
.empty { color: var(--ct-text3); text-align: center; padding: 48px 0; }
.items { display: flex; flex-direction: column; gap: 10px; max-height: 60vh; overflow-y: auto; }
.item { border: 1px solid var(--ct-border); border-radius: 6px; padding: 10px 12px; background: var(--ct-panel2); }
.item.done { opacity: 0.55; }
.item-head { display: flex; align-items: center; gap: 10px; }
.cat { font-size: 10px; border: 1px solid currentColor; border-radius: 3px; padding: 0 6px; }
.cat.model_env { color: var(--ct-yellow); }
.cat.code_defect { color: var(--ct-red); }
.cat.command_risk { color: var(--ct-accent); }
.cat.requirement { color: var(--ct-green); }
.cat.other { color: var(--ct-text3); }
.count { font-size: 11px; color: var(--ct-text2); }
.time { font-size: 10px; color: var(--ct-text3); }
.resolved { margin-left: auto; font-size: 10px; color: var(--ct-green); }
.sample { font-size: 12px; color: var(--ct-text); margin-top: 6px; white-space: pre-wrap; word-break: break-all; }
.sources { font-size: 11px; color: var(--ct-text3); margin-top: 6px; }
.src { margin-right: 10px; font-size: 11px; }
.ops { margin-top: 8px; display: flex; gap: 8px; }
</style>
