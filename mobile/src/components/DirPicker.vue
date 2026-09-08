<script setup lang="ts">
import { ref, watch } from 'vue';
import { showFailToast } from 'vant';
import { api } from '../api';
import type { FsListing } from '../api';

/**
 * 目录级联选择弹层（微信分组列表风格）。
 * 从 TaskCreateView 提取，供发起任务 / 转项目 / 新建项目共用。
 * 用法：<DirPicker v-model:show="show" @pick="workspace = $event" />
 */
const props = withDefaults(defineProps<{ show: boolean; title?: string }>(), { title: '选择目录' });
const emit = defineEmits<{
  (e: 'update:show', v: boolean): void;
  (e: 'pick', path: string): void;
}>();

const fsLoading = ref(false);
const fsPath = ref('');
const fsParent = ref<string | null>(null);
const fsDirs = ref<FsListing['dirs']>([]);
const fsShortcuts = ref<FsListing['shortcuts']>([]);

async function loadFs(p: string) {
  fsLoading.value = true;
  try {
    const d = await api.fsList(p);
    fsPath.value = d.path;
    fsParent.value = d.parent;
    fsDirs.value = d.dirs;
    fsShortcuts.value = d.shortcuts || [];
  } catch (e: any) {
    showFailToast(e.message || '读取目录失败');
  } finally {
    fsLoading.value = false;
  }
}

function enterDir(dir: { name: string; path: string }) {
  void loadFs(dir.path);
}

function goUp() {
  void loadFs(fsParent.value || '');
}

function chooseCurrent() {
  if (!fsPath.value) {
    showFailToast('请先进入一个具体目录');
    return;
  }
  emit('pick', fsPath.value);
  emit('update:show', false);
}

watch(
  () => props.show,
  (on) => { if (on) void loadFs(''); }
);
</script>

<template>
  <van-popup :show="show" position="bottom" :style="{ height: '70%' }" round @update:show="emit('update:show', $event)">
    <div class="fs-picker">
      <div class="fs-head">
        <span class="fs-title">{{ title }}</span>
        <span class="fs-use" @click="chooseCurrent">使用当前目录</span>
      </div>
      <div v-if="fsPath" class="fs-path">{{ fsPath }}</div>
      <div v-if="fsParent" class="wx-cell link fs-up" @click="goUp">
        <van-icon name="arrow-up" size="16" color="#07c160" />
        <span class="cell-label">返回上级</span>
      </div>
      <van-loading v-if="fsLoading" class="fs-loading" />
      <div v-else class="fs-list">
        <div class="wx-group fs-inline-group">
          <div v-for="s in fsShortcuts" :key="s.path" class="wx-cell link" @click="loadFs(s.path)">
            <van-icon name="star-o" size="18" color="#fa9d3b" />
            <span class="cell-label">{{ s.name }}</span>
          </div>
          <div
            v-for="d in fsDirs"
            :key="d.path"
            class="wx-cell link"
            :class="{ chosen: d.path === fsPath }"
            @click="enterDir(d)"
          >
            <van-icon name="folder-o" size="18" color="#07c160" />
            <span class="cell-label">{{ d.name }}</span>
            <van-icon v-if="d.path === fsPath" name="success" size="16" color="#07c160" />
          </div>
        </div>
        <div v-if="!fsDirs.length && !fsShortcuts.length" class="fs-empty">无子目录</div>
      </div>
    </div>
  </van-popup>
</template>

<style scoped>
.fs-picker { height: 100%; display: flex; flex-direction: column; padding: 14px 0 0; background: var(--bg); }
.fs-head { display: flex; justify-content: space-between; align-items: center; padding: 0 16px 10px; }
.fs-title { font-size: 17px; font-weight: 600; color: var(--text); }
.fs-use { font-size: 15px; color: var(--accent); }
.fs-path { font-size: 12px; color: var(--wx-blue); padding: 0 16px 8px; word-break: break-all; }
.fs-up { margin: 0 12px; }
.fs-loading { margin: 20px auto; }
.fs-list { flex: 1; overflow-y: auto; -webkit-overflow-scrolling: touch; padding-bottom: 14px; }
.fs-inline-group { margin: 0 12px; }
.fs-empty { text-align: center; color: var(--text-3); padding: 30px 0; }
.cell-label { font-size: 16px; color: var(--text); flex: 1; min-width: 0; }
.wx-cell.chosen { background: var(--panel-2); }
</style>
