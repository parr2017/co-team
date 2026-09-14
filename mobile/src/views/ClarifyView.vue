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
/** 每题待发附图（index -> 数组），随回答提交——服务端生成视觉描述进规划上下文 */
const answerImgs = ref<{ url?: string; name?: string; dataUrl?: string; file?: File }[][]>([]);
const imgTarget = ref(-1);
const imgInputEl = ref<HTMLInputElement | null>(null);
const supplement = ref('');
const submitting = ref(false);
const loading = ref(true);
const loadError = ref('');

async function load() {
  loading.value = true;
  loadError.value = '';
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
    // never strand the user on a dead page: show a retry-able error state
    loadError.value = e.message || '任务不存在';
  } finally {
    loading.value = false;
  }
}

watch(taskId, () => void load(), { immediate: true });

// ---------- 澄清回答附图（与 web ClarifyDialog 同一行为契约） ----------
const ACCEPT = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/bmp']);
function pickImg(i: number) {
  imgTarget.value = i;
  imgInputEl.value?.click();
}
async function onPickImg(e: Event) {
  const input = e.target as HTMLInputElement;
  const files = [...(input.files || [])];
  input.value = '';
  const idx = imgTarget.value;
  if (idx < 0) return;
  for (const f of files) {
    const cur = answerImgs.value[idx] || [];
    if (cur.length >= 3) { showToast('最多附 3 张图'); break; }
    if (!ACCEPT.has(f.type)) { showToast(`${f.name}：不支持的图片类型`); continue; }
    if (f.size > 10 * 1024 * 1024) { showToast(`${f.name} 超过 10MB`); continue; }
    const dataUrl = await new Promise<string>((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(String(r.result));
      r.onerror = () => reject(new Error('read failed'));
      r.readAsDataURL(f);
    }).catch(() => { showToast(`${f.name} 读取失败`); return ''; });
    if (!dataUrl) continue;
    answerImgs.value[idx] = [...cur, { url: dataUrl, name: f.name, dataUrl }];
  }
}

async function submit(confirm: boolean) {
  submitting.value = true;
  try {
    // plan_async: the server replies before any LLM work — the follow-up (next round of
    // questions / plan generation) happens in the background and lands via WS events
    const r = await api.clarifyTask(taskId.value, {
      answers: questions.value
        .map((q, i) => {
          const imgs = (answerImgs.value[i] || []).filter((p) => p.dataUrl).map((p) => ({ name: p.name || 'image', dataUrl: p.dataUrl as string }));
          return { question: q.question, answer: q.answer.trim(), images: imgs.length ? imgs : undefined };
        })
        .filter((q) => q.answer || q.images?.length),
      confirm,
      text: supplement.value.trim() || undefined,
    });
    if (r.status === 'clarifying' && r.questions?.length) {
      // next clarification round with fresh questions (sync/desktop-parity path)
      questions.value = r.questions.map((q) => ({ question: q, answer: '' }));
      answerImgs.value = [];
      supplement.value = '';
      showToast('已回复，进入下一轮澄清');
    } else if (r.status === 'planned') {
      showToast('需求已明确，计划已生成');
      router.replace(`/plan/${taskId.value}`);
    } else if (r.status === 'pending') {
      showToast('需求已确认，正在生成计划…');
      router.replace(`/task/${taskId.value}`);
    } else if (r.status === 'assessing') {
      showToast('已提交，团队评估需求中…');
      router.replace(`/task/${taskId.value}`);
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
    <van-nav-bar safe-area-inset-top title="需求澄清" left-arrow fixed placeholder @click-left="router.back()" />

    <van-loading v-if="loading" class="loading" vertical>加载中…</van-loading>

    <!-- 加载失败：可重试的错误态，替代无响应的空白页 -->
    <div v-else-if="loadError" class="err-state">
      <van-icon name="warning-o" size="56" color="var(--yellow)" />
      <div class="err-title">加载失败</div>
      <div class="err-sub">{{ loadError }}</div>
      <button class="wx-btn err-btn" @click="load">重新加载</button>
      <button class="wx-btn wx-btn-plain err-btn" @click="router.replace(`/task/${taskId}`)">查看任务详情</button>
    </div>

    <div v-else class="content">
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
            placeholder="输入你的回答…（可附图）"
            class="q-input"
          />
          <div class="q-img-row">
            <span class="q-clip" @click="pickImg(i)">📷</span>
            <van-uploader
              v-if="(answerImgs[i] || []).length"
              v-model="answerImgs[i]"
              :max-count="3"
              :deletable="true"
              :show-upload="false"
            />
          </div>
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
      <input ref="imgInputEl" type="file" accept="image/png,image/jpeg,image/webp,image/gif,image/bmp" hidden @change="onPickImg" />
    </div>
  </div>
</template>

<style scoped>
.page { height: 100%; overflow-y: auto; -webkit-overflow-scrolling: touch; background: var(--bg); }
.content { padding-bottom: 30px; }
.loading { margin: 80px auto; }
.task-desc { font-size: 16px; line-height: 1.6; color: var(--text); white-space: pre-wrap; }

.err-state { display: flex; flex-direction: column; align-items: center; gap: 8px; padding: 90px 40px 0; }
.err-title { font-size: 17px; font-weight: 600; color: var(--text); margin-top: 8px; }
.err-sub { font-size: 13px; color: var(--text-3); text-align: center; line-height: 1.6; }
.err-btn { margin-top: 16px; max-width: 220px; }

.q-card { padding: 12px 14px; }
.q-card + .q-card { position: relative; }
.q-card + .q-card::before {
  content: ''; position: absolute; left: 14px; right: 0; top: 0;
  height: 1px; background: var(--border); transform: scaleY(0.5);
}
.q-text { font-size: 15px; font-weight: 500; color: var(--text); margin-bottom: 8px; line-height: 1.5; }
.q-img-row { display: flex; align-items: center; gap: 8px; margin-top: 6px; }
.q-clip {
  width: 30px; height: 30px; border-radius: 50%; flex-shrink: 0;
  display: flex; align-items: center; justify-content: center;
  background: var(--panel-2); border: 1px solid var(--border);
  color: var(--accent); font-size: 15px;
}
.q-input { padding: 0; background: transparent; }
.q-input :deep(.van-field__control) { font-size: 16px; line-height: 1.5; background: var(--panel-2); border-radius: 6px; padding: 8px 10px; }

.btns { display: flex; flex-direction: column; gap: 12px; margin: 28px 16px 0; }
</style>
