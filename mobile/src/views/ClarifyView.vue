<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { showFailToast, showToast } from 'vant';
import { api } from '../api';
import type { TaskGraph } from '../api';

const route = useRoute();
const router = useRouter();

const taskId = computed(() => String(route.params.id));
const task = ref<TaskGraph | null>(null);
const questions = ref<{ question: string; answer: string }[]>([]);
const supplement = ref('');
const submitting = ref(false);

async function load() {
  try {
    const t = await api.getTask(taskId.value);
    task.value = t;
    if (t.status !== 'clarifying') {
      showToast('任务不在澄清状态');
      router.replace(`/task/${taskId.value}`);
      return;
    }
    // attempt to show the pending questions from the most recent clarification event
    try {
      const ev = await api.taskEvents(taskId.value);
      const last = [...ev.events].reverse().find((e) => e.type === 'task_needs_clarification');
      const qs: string[] = last?.payload?.questions || [];
      questions.value = qs.map((q) => ({ question: q, answer: '' }));
      if (!questions.value.length) questions.value = [{ question: '请补充说明需求细节', answer: '' }];
    } catch { /* ignore */ }
  } catch (e: any) {
    showFailToast(e.message || '任务不存在');
  }
}

watch(taskId, () => void load(), { immediate: true });

async function submit(confirm: boolean) {
  submitting.value = true;
  try {
    const r = await api.clarifyTask(taskId.value, {
      answers: questions.value.filter((q) => q.answer.trim()),
      confirm,
      text: supplement.value.trim() || undefined,
    });
    if (r.status === 'clarifying' && r.questions?.length) {
      // next clarification round with fresh questions
      questions.value = r.questions.map((q) => ({ question: q, answer: '' }));
      supplement.value = '';
      showToast('已回复，进入下一轮澄清');
    } else if (r.status === 'planned') {
      showToast('需求已明确，计划已生成');
      router.replace(`/plan/${taskId.value}`);
    } else {
      showToast(`当前状态：${r.status}`);
      if (r.status !== 'clarifying') router.replace(`/task/${taskId.value}`);
    }
  } catch (e: any) {
    showFailToast(e.message || '提交失败');
  } finally {
    submitting.value = false;
  }
}
</script>

<template>
  <div class="page">
    <van-nav-bar title="需求澄清" left-arrow fixed placeholder @click-left="router.back()" />

    <div class="content">
      <div class="wx-caption">任务描述</div>
      <div class="wx-group">
        <div class="wx-cell">
          <span class="task-desc">{{ task?.description || taskId }}</span>
        </div>
      </div>

      <div class="wx-caption">澄清问题</div>
      <div class="wx-group">
        <div v-for="(q, i) in questions" :key="i" class="q-card">
          <div class="q-text">{{ i + 1 }}. {{ q.question }}</div>
          <van-field
            v-model="q.answer"
            type="textarea"
            rows="2"
            autosize
            :border="false"
            placeholder="输入你的回答…"
            class="q-input"
          />
        </div>
      </div>

      <div class="wx-caption">补充说明（可选）</div>
      <div class="wx-group">
        <van-field
          v-model="supplement"
          type="textarea"
          rows="2"
          autosize
          :border="false"
          placeholder="其他需要说明的内容…"
          class="q-input"
        />
      </div>

      <div class="btns">
        <button class="wx-btn" :disabled="submitting" @click="submit(false)">{{ submitting ? '提交中…' : '提交回答' }}</button>
        <button class="wx-btn wx-btn-plain" :disabled="submitting" @click="submit(true)">按当前信息直接开始</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.page { height: 100%; overflow-y: auto; -webkit-overflow-scrolling: touch; background: var(--bg); }
.content { padding-bottom: 30px; }
.task-desc { font-size: 16px; line-height: 1.6; color: var(--text); white-space: pre-wrap; }

.q-card { padding: 12px 14px; }
.q-card + .q-card { position: relative; }
.q-card + .q-card::before {
  content: ''; position: absolute; left: 14px; right: 0; top: 0;
  height: 1px; background: var(--border); transform: scaleY(0.5);
}
.q-text { font-size: 15px; font-weight: 500; color: var(--text); margin-bottom: 8px; line-height: 1.5; }
.q-input { padding: 0; background: transparent; }
.q-input :deep(.van-field__control) { font-size: 16px; line-height: 1.5; background: var(--panel-2); border-radius: 6px; padding: 8px 10px; }

.btns { display: flex; flex-direction: column; gap: 12px; margin: 28px 16px 0; }
</style>
