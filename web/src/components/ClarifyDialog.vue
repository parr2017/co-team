<template>
  <el-dialog :model-value="modelValue" title="需求澄清" width="680px" @open="onOpen" @close="$emit('close')">
    <div v-if="task" class="clarify">
      <div class="head mono">
        <span>CLARIFY {{ taskId }}</span>
        <span>第 {{ round }} 次澄清</span>
      </div>
      <div class="req"><span class="mono label">原始需求 ></span>{{ task.description }}</div>
      <div v-if="summary" class="summary"><span class="mono label">Agent 理解 ></span>{{ summary }}</div>

      <div class="qa">
        <div v-if="!questions.length" class="empty mono">需求已清晰，可直接确认</div>
        <div v-for="(q, i) in questions" :key="i" class="qa-item">
          <div class="q mono">Q{{ i + 1 }} · {{ q }}</div>
          <el-input v-model="answers[i]" type="textarea" :rows="2" placeholder="输入你的回答..." />
        </div>
        <div class="qa-item">
          <div class="q mono">补充说明（可选）</div>
          <el-input v-model="extra" type="textarea" :rows="2" placeholder="补充需求背景、约束、验收标准等" />
        </div>
      </div>

      <div class="actions">
        <el-button size="small" @click="cancelTask">取消任务</el-button>
        <el-button size="small" :loading="submitting" @click="submitAnswers">提交答复</el-button>
        <el-button size="small" type="primary" :loading="confirming" @click="confirm">确认需求，开始规划</el-button>
      </div>
      <div class="hint mono">「确认」后 Agent 将基于问答结果生成计划；答复后 Agent 会重新评估需求清晰度（最多 3 轮）。</div>
    </div>
  </el-dialog>
</template>

<script setup lang="ts">
import { ref } from 'vue';
import { ElMessage } from 'element-plus';
import { api, type TaskGraph } from '../api';

const props = defineProps<{ modelValue: boolean; taskId: string }>();
const emit = defineEmits<{ (e: 'close'): void; (e: 'planned', taskId: string): void; (e: 'cancelled'): void; (e: 'changed'): void }>();

const task = ref<TaskGraph | null>(null);
const questions = ref<string[]>([]);
const answers = ref<string[]>([]);
const extra = ref('');
const summary = ref('');
const round = ref(1);
const submitting = ref(false);
const confirming = ref(false);

async function onOpen() {
  try {
    task.value = await api.getTask(props.taskId);
    answers.value = [];
    extra.value = '';
    round.value = 1;
    summary.value = '';
    questions.value = [];
  } catch (e: any) {
    ElMessage.error(e.message);
  }
}

async function submitAnswers() {
  submitting.value = true;
  try {
    const payloadAnswers = questions.value
      .map((q, i) => ({ question: q, answer: (answers.value[i] || '').trim() }))
      .filter((a) => a.answer);
    const d = await api.clarifyTask(props.taskId, { answers: payloadAnswers, text: extra.value.trim() || undefined });
    if (d.status === 'clarifying') {
      round.value += 1;
      questions.value = d.questions || [];
      answers.value = [];
      extra.value = '';
      ElMessage.info('Agent 评估后仍有疑问，请继续回答');
      emit('changed');
    } else {
      ElMessage.success('需求已确认，计划已生成');
      emit('planned', props.taskId);
      emit('close');
    }
  } catch (e: any) {
    ElMessage.error(e.message);
  } finally {
    submitting.value = false;
  }
}

async function confirm() {
  confirming.value = true;
  try {
    const payloadAnswers = questions.value
      .map((q, i) => ({ question: q, answer: (answers.value[i] || '').trim() }))
      .filter((a) => a.answer);
    const d = await api.clarifyTask(props.taskId, { answers: payloadAnswers, confirm: true, text: extra.value.trim() || undefined });
    if (d.status === 'planned') {
      ElMessage.success('需求已确认，计划已生成，请审核');
      emit('planned', props.taskId);
      emit('close');
    } else {
      ElMessage.warning('任务状态已变化');
      emit('changed');
      emit('close');
    }
  } catch (e: any) {
    ElMessage.error(e.message);
  } finally {
    confirming.value = false;
  }
}

async function cancelTask() {
  try {
    await api.cancelTask(props.taskId);
    ElMessage.info('任务已取消');
    emit('cancelled');
    emit('close');
  } catch (e: any) {
    ElMessage.error(e.message);
  }
}
</script>

<style scoped>
.clarify { font-size: 13px; }
.head { display: flex; justify-content: space-between; font-size: 10px; color: var(--ct-text3); letter-spacing: 1px; border-bottom: 1px dashed var(--ct-border2); padding-bottom: 8px; }
.req { margin: 12px 0 8px; color: var(--ct-text); }
.summary { margin: 8px 0; color: var(--ct-text2); font-style: italic; }
.label { color: var(--ct-accent); margin-right: 8px; font-size: 11px; }
.qa { display: flex; flex-direction: column; gap: 12px; margin: 14px 0; }
.qa-item .q { font-size: 12px; color: var(--ct-yellow); margin-bottom: 6px; }
.empty { text-align: center; color: var(--ct-text3); padding: 12px; }
.actions { display: flex; justify-content: flex-end; gap: 8px; border-top: 2px solid var(--ct-border2); padding-top: 12px; }
.hint { font-size: 10px; color: var(--ct-text3); margin-top: 8px; }
</style>
