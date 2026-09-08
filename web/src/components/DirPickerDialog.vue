<template>
  <el-dialog :model-value="show" :title="title" width="620px" @update:model-value="emit('update:show', $event)">
    <div class="fs-path">
      <el-input v-model="fsInput" placeholder="输入路径后回车直接跳转" @keydown.enter="loadFs(fsInput)" />
      <el-button @click="loadFs(listing?.parent || '')">上级</el-button>
      <el-button @click="loadFs('')">根</el-button>
    </div>
    <div class="fs-list">
      <div v-if="!listing" class="fs-empty">加载中...</div>
      <template v-else>
        <div v-for="s in listing.shortcuts" :key="s.path" class="fs-row shortcut" @click="loadFs(s.path)"><span class="fs-ico">⌂</span> {{ s.name }} <span class="fs-sub">{{ s.path }}</span></div>
        <div v-if="!listing.dirs.length && !listing.shortcuts.length" class="fs-empty">空目录</div>
        <div v-for="d in listing.dirs" :key="d.path" class="fs-row" @click="loadFs(d.path)"><span class="fs-ico">▸</span> {{ d.name }}</div>
      </template>
    </div>
    <template #footer>
      <el-button @click="emit('update:show', false)">取消</el-button>
      <el-button type="primary" @click="pick">选择当前目录</el-button>
    </template>
  </el-dialog>
</template>

<script setup lang="ts">
import { ref, watch } from 'vue';
import { ElMessage } from 'element-plus';
import { api, type FsListing } from '../api';

/**
 * 工作目录级联浏览对话框。从 TaskForm 提取，
 * 供提交任务 / 方案转项目 / 新建项目共用（用法：<DirPickerDialog v-model:show="x" @pick="ws = $event" />）。
 */
const props = withDefaults(defineProps<{ show: boolean; title?: string; startPath?: string }>(), { title: '选择工作目录', startPath: '' });
const emit = defineEmits<{ (e: 'update:show', v: boolean): void; (e: 'pick', path: string): void }>();

const listing = ref<FsListing | null>(null);
const fsInput = ref('');

async function loadFs(path: string) {
  try {
    listing.value = await api.fsList(path || '');
    fsInput.value = listing.value.path || '';
  } catch (e: any) {
    ElMessage.error(e.message);
  }
}

watch(
  () => props.show,
  (on) => {
    if (!on) return;
    const cur = props.startPath || '';
    listing.value = null;
    void loadFs(/^[a-zA-Z]:[\\/]/.test(cur) || cur.startsWith('/') ? cur : '');
  }
);

function pick() {
  if (listing.value?.path) emit('pick', listing.value.path);
  emit('update:show', false);
}
</script>

<style scoped>
.fs-path { display: flex; gap: 8px; margin-bottom: 12px; }
.fs-list { max-height: 320px; overflow-y: auto; background: var(--ct-bg); border: 1px solid var(--el-border-color); border-radius: 8px; }
.fs-row { display: flex; align-items: center; gap: 10px; padding: 8px 12px; border-bottom: 1px solid var(--el-border-color); cursor: pointer; font-size: 13px; }
.fs-row:hover { background: var(--ct-panel2); }
.fs-row.shortcut { color: var(--ct-text2); }
.fs-ico { color: var(--ct-text3); flex-shrink: 0; }
.fs-row .fs-sub { margin-left: 0; }
.fs-sub { color: var(--ct-text3); font-size: 11px; }
.fs-empty { padding: 24px; text-align: center; color: var(--ct-text3); font-size: 12px; }
</style>
