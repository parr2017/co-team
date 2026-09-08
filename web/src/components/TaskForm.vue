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
    <div class="form-row opts-row">
      <div class="opt">
        <span class="opt-label">模式</span>
        <el-switch v-model="simpleMode" active-text="简单模式" inactive-text="专家模式" />
        <span class="opt-hint">{{ simpleMode ? '自动澄清/自动执行/白名单放行，提交后直接开跑' : '完整控制：分级、模型、策略、澄清逐项可调' }}</span>
      </div>
    </div>
    <div v-if="!simpleMode" class="form-row opts-row">
      <div class="opt">
        <span class="opt-label">任务分级</span>
        <el-select v-model="level" size="small" style="width: 130px">
          <el-option label="自动评估" value="auto" />
          <el-option label="轻量级（单文件）" value="light" />
          <el-option label="标准级（功能开发）" value="standard" />
          <el-option label="重量级（架构级）" value="heavy" />
        </el-select>
      </div>
      <div class="opt">
        <span class="opt-label">主 Agent 模型</span>
        <el-select v-model="mainModel" size="small" style="width: 220px" :loading="modelsLoading" placeholder="自动选择">
          <el-option v-for="m in modelOptions" :key="m.name" :label="m.label" :value="m.name">
            <span class="model-opt">
              <i class="dot" :class="m.healthy ? 'on' : 'off'"></i>
              {{ m.name }}
              <span class="model-hint mono">{{ m.healthy ? '可用' : '冷却中' }}</span>
            </span>
          </el-option>
        </el-select>
        <span class="opt-hint">创建后锁定，任务全程使用；可随时在详情中手动更换</span>
      </div>
    </div>
    <div v-if="!simpleMode" class="form-row opts-row">
      <div class="opt">
        <span class="opt-label">执行策略</span>
        <el-select v-model="policy" size="small" style="width: 150px">
          <el-option label="跟随全局设置" value="" />
          <el-option v-for="lv in PERMISSION_LEVELS" :key="lv" :label="PERMISSION_LEVEL_LABELS[lv]" :value="lv" />
        </el-select>
        <span class="opt-hint">控制 Agent 命令/文件写入的自主程度</span>
      </div>
      <div class="opt">
        <span class="opt-label">实施前澄清</span>
        <el-select v-model="nodeClarify" size="small" style="width: 150px">
          <el-option label="关闭" value="off" />
          <el-option label="简报确认（推荐）" value="brief" />
          <el-option label="逐步确认" value="confirm" />
        </el-select>
        <span class="opt-hint">每个步骤实施前先给简报，经你确认再动手</span>
      </div>
      <div class="opt">
        <el-checkbox v-model="allowSelfRef">自指任务（co-team 开发 co-team）</el-checkbox>
        <span class="opt-hint">工作区在 co-team 内时必勾：任务在隔离克隆中执行，不碰主副本</span>
      </div>
    </div>
    <div class="form-hint">{{ hint }}</div>

    <DirPickerDialog v-model:show="pickerVisible" :start-path="workspace" @pick="workspace = $event" />
  </div>
</template>

<script setup lang="ts">
import { onMounted, ref, watch } from 'vue';
import { ElMessage } from 'element-plus';
import { api, PERMISSION_LEVELS, PERMISSION_LEVEL_LABELS } from '../api';
import { useDashboard } from '../composables/useDashboard';
import DirPickerDialog from './DirPickerDialog.vue';

const description = ref('');
const workspace = ref('');
const submitting = ref(false);
const hint = ref('');
const pickerVisible = ref(false);
const allowSelfRef = ref(false);
const emit = defineEmits<{ (e: 'planned', taskId: string): void; (e: 'needs-clarify', taskId: string, questions: string[], summary?: string): void }>();

// live stage feedback while the (synchronous) create request is in flight
const { createStage } = useDashboard();
watch(createStage, (stage) => {
  if (!submitting.value) return;
  if (stage === 'assessing') hint.value = '正在评估需求清晰度...';
  else if (stage === 'planning') hint.value = '正在生成任务计划（可能需要 1-3 分钟）...';
});
watch(submitting, (on) => { if (!on && createStage.value) createStage.value = ''; });

// improvement 7: task grading; improvement 11: main-agent model pinning
// features: 命令执行分级 + 实施前澄清 + A4 模式档位
const simpleMode = ref(false);
const level = ref('auto');
const mainModel = ref('');
const policy = ref('');
const nodeClarify = ref('brief');
const modelOptions = ref<{ name: string; healthy: boolean; label: string }[]>([]);
const modelsLoading = ref(false);

async function loadModels() {
  modelsLoading.value = true;
  try {
    const d = await api.getModelPool();
    const health = (d as any).health || {};
    modelOptions.value = d.model_pool.map((m) => ({
      name: m.name,
      healthy: health[m.name]?.healthy !== false,
      label: m.name,
    }));
  } catch {
    modelOptions.value = [];
  } finally {
    modelsLoading.value = false;
  }
}
onMounted(() => void loadModels());

const ABSOLUTE = /^[a-zA-Z]:[\\/]/;

function openPicker() {
  pickerVisible.value = true;
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
    // tasks land in "planned" state: the plan review dialog decides when to run;
    // unclear requirements land in "clarifying" state: the clarify dialog takes over
    const d = await api.createTask(description.value.trim(), workspace.value.trim(), simpleMode.value, undefined, {
      level: level.value === 'auto' ? undefined : level.value,
      mainModelId: mainModel.value || undefined,
      executionPolicy: policy.value ? { level: policy.value } : undefined,
      nodeClarify: nodeClarify.value === 'off' ? undefined : nodeClarify.value,
      profile: simpleMode.value ? 'simple' : undefined,
      allowSelfRef: allowSelfRef.value || undefined,
    });
    if (d.status === 'needs_clarification') {
      hint.value = `[?] 需求不够清晰，请回答澄清问题: ${d.task_id}`;
      ElMessage.warning('需求需要澄清，请回答 Agent 的问题');
      emit('needs-clarify', d.task_id, d.questions || [], d.summary);
      description.value = '';
      return;
    }
    if (simpleMode.value) {
      hint.value = `[ok] 任务已提交并自动执行: ${d.task_id}`;
      ElMessage.success(`简单模式：任务已自动开始执行 ${d.task_id}`);
    } else {
      hint.value = `[ok] 计划已生成: ${d.task_id}（等待审核）`;
      ElMessage.success(`计划已生成，请审核: ${d.task_id}`);
    }
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
.opts-row { align-items: center; flex-wrap: wrap; }
.opt { display: flex; align-items: center; gap: 8px; }
.opt-label { font-size: 12px; color: var(--ct-text3); white-space: nowrap; }
.opt-hint { font-size: 11px; color: var(--ct-text3); }
.model-opt { display: inline-flex; align-items: center; gap: 6px; }
.model-opt .dot { width: 6px; height: 6px; border-radius: 50%; display: inline-block; }
.model-opt .dot.on { background: var(--ct-green); }
.model-opt .dot.off { background: var(--ct-red); }
.model-hint { font-size: 10px; color: var(--ct-text3); }
.form-hint { font-size: 12px; color: var(--ct-text3); margin-top: 8px; min-height: 16px; }
</style>
