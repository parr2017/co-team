<template>
  <el-dialog :model-value="modelValue" title="服务日志" width="900px" top="4vh" @open="onOpen" @close="$emit('close')">
    <div class="toolbar">
      <el-date-picker v-model="date" type="date" size="small" :clearable="false" value-format="YYYY-MM-DD" style="width: 140px" @change="load" />
      <el-select v-model="lines" size="small" style="width: 110px" @change="load">
        <el-option label="最近 120 行" :value="120" />
        <el-option label="最近 300 行" :value="300" />
        <el-option label="最近 800 行" :value="800" />
      </el-select>
      <el-input v-model="keyword" size="small" placeholder="关键字过滤（ERROR / taskId…）" style="width: 220px" clearable @keydown.enter="load" @clear="load" />
      <el-switch v-model="auto" size="small" active-text="自动刷新" />
      <el-button size="small" @click="load">刷新</el-button>
      <span class="meta mono" v-if="total">共 {{ total }} 行 · 显示 {{ shown.length }} 行</span>
    </div>
    <div class="log-wrap" ref="wrap">
      <div v-if="!shown.length" class="empty mono">{{ raw.length ? '无匹配行' : '该日期暂无日志' }}</div>
      <div v-for="(l, i) in shown" :key="i" class="log-line mono" :class="levelClass(l)">
        <span class="idx mono">{{ (total - shown.length + i + 1) || i + 1 }}</span>
        <span class="txt">{{ l }}</span>
      </div>
    </div>
    <template #footer>
      <el-button size="small" link type="primary" @click="copyAll" :disabled="!shown.length">复制可见日志</el-button>
      <el-button size="small" @click="$emit('close')">关闭</el-button>
    </template>
  </el-dialog>
</template>

<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from 'vue';
import { ElMessage } from 'element-plus';
import { api } from '../api';

defineProps<{ modelValue: boolean }>();
defineEmits<{ (e: 'close'): void }>();

const date = ref(new Date().toISOString().slice(0, 10));
const lines = ref(300);
const keyword = ref('');
const auto = ref(true);
const raw = ref<string[]>([]);
const total = ref(0);
const wrap = ref<HTMLElement>();
let timer: number | undefined;

const shown = computed(() => {
  const kw = keyword.value.trim();
  if (!kw) return raw.value;
  return raw.value.filter((l) => l.toLowerCase().includes(kw.toLowerCase()));
});

function levelClass(line: string): string {
  if (/\[ERROR\]/.test(line)) return 'err';
  if (/\[WARN\]/.test(line)) return 'warn';
  return '';
}

async function load() {
  try {
    const d = await api.logs(date.value, lines.value);
    raw.value = d.lines || [];
    total.value = d.total || raw.value.length;
  } catch (e: any) {
    ElMessage.error(e.message || '日志加载失败');
  }
}

function onOpen() {
  void load();
  window.clearInterval(timer);
  if (auto.value) timer = window.setInterval(() => { if (!keyword.value) void load(); }, 5000);
}
watch(auto, (v) => {
  window.clearInterval(timer);
  if (v) timer = window.setInterval(() => { if (!keyword.value) void load(); }, 5000);
});
onUnmounted(() => window.clearInterval(timer));

async function copyAll() {
  try {
    await navigator.clipboard.writeText(shown.value.join('\n'));
    ElMessage.success('已复制');
  } catch {
    ElMessage.error('复制失败');
  }
}
</script>

<style scoped>
.toolbar { display: flex; align-items: center; gap: 10px; margin-bottom: 10px; flex-wrap: wrap; }
.meta { font-size: 11px; color: var(--ct-text3); margin-left: auto; }
.log-wrap { height: 62vh; overflow: auto; background: var(--ct-bg); border: 1px solid var(--ct-border); border-radius: 6px; padding: 6px 0; font-size: 11px; line-height: 1.55; }
.log-line { display: flex; gap: 10px; padding: 1px 12px; }
.log-line .idx { flex: 0 0 46px; text-align: right; color: var(--ct-text3); opacity: 0.6; user-select: none; }
.log-line .txt { flex: 1; min-width: 0; white-space: pre-wrap; word-break: break-all; color: var(--ct-text2); }
.log-line.err .txt { color: var(--ct-red); }
.log-line.warn .txt { color: var(--ct-yellow); }
.empty { text-align: center; color: var(--ct-text3); padding: 40px 0; }
</style>
