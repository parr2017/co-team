<template>
  <div class="panel section">
    <div class="section-title">提交任务</div>
    <el-input v-model="description" type="textarea" :rows="2" placeholder="描述你的任务... 例如：实现用户注册 API，包含输入验证、密码加密和数据库存储" />
    <div class="form-row">
      <el-input v-model="workspace" placeholder="工作目录绝对路径，如 D:\projects\myapp" style="flex: 1">
        <template #append>
          <el-button @click="openPicker">选择目录</el-button>
        </template>
      </el-input>
      <el-button type="primary" :loading="submitting" @click="submit">提交任务</el-button>
    </div>
    <div class="form-hint">{{ hint }}</div>

    <el-dialog v-model="pickerVisible" title="选择工作目录" width="620px">
      <div class="fs-path">
        <el-input v-model="fsInput" placeholder="输入路径后回车直接跳转" @keydown.enter="loadFs(fsInput)" />
        <el-button @click="loadFs(listing?.parent || '')">上级</el-button>
        <el-button @click="loadFs('')">根</el-button>
      </div>
      <div class="fs-list">
        <div v-if="!listing" class="fs-empty">加载中...</div>
        <template v-else>
          <div v-for="s in listing.shortcuts" :key="s.path" class="fs-row" @click="loadFs(s.path)">🏠 {{ s.name }} <span class="fs-sub">{{ s.path }}</span></div>
          <div v-if="!listing.dirs.length && !listing.shortcuts.length" class="fs-empty">空目录</div>
          <div v-for="d in listing.dirs" :key="d.path" class="fs-row" @click="loadFs(d.path)">📁 {{ d.name }}</div>
        </template>
      </div>
      <template #footer>
        <el-button @click="pickerVisible = false">取消</el-button>
        <el-button type="primary" @click="pick">选择当前目录</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue';
import { ElMessage } from 'element-plus';
import { api, type FsListing } from '../api';

const description = ref('');
const workspace = ref('');
const submitting = ref(false);
const hint = ref('');
const pickerVisible = ref(false);
const emit = defineEmits<{ (e: 'planned', taskId: string): void }>();
const listing = ref<FsListing | null>(null);
const fsInput = ref('');

const ABSOLUTE = /^[a-zA-Z]:[\\/]/;

async function loadFs(path: string) {
  try {
    listing.value = await api.fsList(path || '');
    fsInput.value = listing.value.path || '';
  } catch (e: any) {
    ElMessage.error(e.message);
  }
}

function openPicker() {
  const cur = workspace.value.trim();
  const isAbsolute = /^[a-zA-Z]:[\\/]/.test(cur) || cur.startsWith('/');
  pickerVisible.value = true;
  void loadFs(cur && isAbsolute ? cur : '');
}

function fsGo(path: string) {
  void loadFs(path);
}

function fsUp() {
  if (!listing.value?.path) return;
  const trimmed = listing.value.path.replace(/[\\/][^\\/]+[\\/]?$/, '');
  void loadFs(trimmed);
}

function pick() {
  if (listing.value?.path) workspace.value = listing.value.path;
  pickerVisible.value = false;
}

async function submit() {
  if (!description.value.trim()) {
    hint.value = '请先描述任务';
    return;
  }
  if (!ABSOLUTE.test(workspace.value.trim()) && !workspace.value.trim().startsWith('/')) {
    hint.value = '[x] 请填写绝对路径，或点击「选择目录」；相对路径会在服务器端解析，容易出错';
    return;
  }
  submitting.value = true;
  hint.value = '提交中...';
  try {
    // tasks land in "planned" state: the plan review dialog decides when to run
    const d = await api.createTask(description.value.trim(), workspace.value.trim(), false);
    hint.value = `[ok] 计划已生成: ${d.task_id}（等待审核）`;
    ElMessage.success(`计划已生成，请审核: ${d.task_id}`);
    description.value = '';
    emit('planned', d.task_id);
  } catch (e: any) {
    hint.value = `[x] ${e.message}`;
  } finally {
    submitting.value = false;
  }
}
</script>

<style scoped>
.form-row { display: flex; gap: 12px; margin-top: 12px; }
.form-hint { font-size: 12px; color: var(--ct-text3); margin-top: 8px; min-height: 16px; }
.fs-path { display: flex; gap: 8px; margin-bottom: 12px; }
.fs-list { max-height: 320px; overflow-y: auto; background: var(--ct-bg); border: 1px solid var(--el-border-color); border-radius: 8px; }
.fs-row { display: flex; align-items: center; gap: 10px; padding: 8px 12px; border-bottom: 1px solid var(--el-border-color); cursor: pointer; font-size: 13px; }
.fs-row:hover { background: var(--ct-panel2); }
.fs-sub { color: var(--ct-text3); font-size: 11px; }
.fs-empty { padding: 24px; text-align: center; color: var(--ct-text3); font-size: 12px; }
</style>
