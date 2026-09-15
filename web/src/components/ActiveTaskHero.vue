<template>
  <div v-if="hero" class="hero" :class="{ queued: hero.status === 'queued' }">
    <div class="hero-head">
      <span class="hero-tag" :class="hero.status">{{ statusText(hero.status) }}</span>
      <span v-if="hero.rolling" class="hero-stage mono">第 {{ hero.stage }} 阶段</span>
      <span class="hero-pct mono">{{ hero.percent }}%</span>
      <button class="hero-open mono" @click="$emit('open', hero.task_id)">进入战情室 →</button>
    </div>
    <div class="hero-title">{{ hero.description || hero.task_id }}</div>
    <div class="hero-bar"><div class="fill" :style="{ width: hero.percent + '%' }"></div></div>

    <!-- 并行任务徽标（Phase 2）：hero 之外的其他活跃任务，点击直达对应战情室 -->
    <div v-if="others.length" class="hero-par">
      <span class="par-label">另有 {{ others.length }} 个任务并行中：</span>
      <button v-for="o in others" :key="o.task_id" class="par-chip mono" :title="o.description" @click="$emit('open', o.task_id)">
        {{ o.task_id }} · {{ o.description }}
      </button>
    </div>

    <!-- 正在执行的节点（心跳卡串联） -->
    <div v-if="activeNodes.length" class="hero-nodes">
      <div v-for="n in activeNodes" :key="n.id" class="hero-node">
        <span class="hn-dot"></span>
        <span class="hn-agent mono">{{ n.agent }}</span>
        <span class="hn-name">{{ n.name }}</span>
        <span v-if="n.model" class="hn-chip mono">{{ n.model }}</span>
        <span v-if="n.tokens" class="hn-chip mono">{{ fmtTok(n.tokens) }} tok</span>
        <span v-if="n.retryCount" class="hn-chip warn mono">重试 {{ n.retryCount }}</span>
        <span v-if="n.backoffSec" class="hn-chip warn mono">⏳ 限流 {{ n.backoffSec }}s</span>
        <span class="hn-elapsed mono">{{ elapsed(n) }}</span>
      </div>
      <!-- 生成直播：最近一次 delta（全任务维度取最新鲜的） -->
      <div v-if="latestDelta" class="hero-delta mono">{{ latestDelta }}</div>
    </div>

    <!-- 中断/重排提示 -->
    <div v-if="hero.status === 'interrupted'" class="hero-note warn">⚡ 服务重启中断，将自动续跑（已完成节点成果保留）</div>
    <div v-else-if="hero.infraRetries" class="hero-note warn">⚡ 曾因模型池不稳自动重排 {{ hero.infraRetries }} 次——永续开发兜底生效</div>
  </div>
  <div v-else class="hero hero-empty">
    <div class="hero-empty-title">没有正在执行的任务</div>
    <div class="hero-empty-sub">在下方下发任务，或到「项目开发」继续项目里程碑——执行过程中的每一步都会在这里直播。</div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { useDashboard } from '../composables/useDashboard';
import { statusText } from '../utils/events';
import type { TaskGraph } from '../api';

const emit = defineEmits<{ (e: 'open', taskId: string): void }>();

const { tasks, getNodeRuntime, liveDelta } = useDashboard();

const ACTIVE = ['running', 'finalizing', 'interrupted', 'queued'];
const PRIORITY: Record<string, number> = { running: 0, finalizing: 1, interrupted: 2, queued: 3 };

const nowTick = ref(0);
let timer: number | null = null;
onMounted(() => { timer = window.setInterval(() => { nowTick.value += 1; }, 1000); });
onUnmounted(() => { if (timer !== null) window.clearInterval(timer); });

const activeList = computed(() => {
  void nowTick.value;
  return Object.values(tasks as Record<string, TaskGraph>)
    .filter((t: TaskGraph) => ACTIVE.includes(t.status))
    .sort((a: TaskGraph, b: TaskGraph) => (PRIORITY[a.status] ?? 9) - (PRIORITY[b.status] ?? 9) || (b.updated_at || '').localeCompare(a.updated_at || ''));
});

const hero = computed(() => {
  const t = activeList.value[0] as TaskGraph | undefined;
  if (!t) return null;
  const done = t.nodes.filter((n) => n.status === 'completed').length;
  return {
    task_id: t.task_id,
    status: t.status,
    description: (t.description || '').split('\n')[0].slice(0, 80),
    percent: t.nodes.length ? Math.round((done / t.nodes.length) * 100) : 0,
    rolling: !!t.rolling,
    stage: t.stage || 0,
    stageGoal: t.stage_goal || '',
    infraRetries: t.infra_retries || 0,
  };
});

// 并行加固（Phase 2）：hero 之外的活跃任务——车道并行后首页必须看得见"还有谁在跑"
const others = computed(() => {
  return (activeList.value.slice(1) as TaskGraph[]).map((t) => ({
    task_id: t.task_id,
    status: t.status,
    description: (t.description || '').split('\n')[0].slice(0, 30),
  }));
});

const activeNodes = computed(() => {
  void nowTick.value;
  if (!hero.value) return [];
  const t = (tasks as Record<string, TaskGraph>)[hero.value.task_id];
  if (!t) return [];
  return t.nodes
    .filter((n) => ['running', 'retrying'].includes(n.status))
    .map((n) => {
      const r = getNodeRuntime(t.task_id, n.id);
      return { id: n.id, name: n.name, agent: n.agent, model: r?.model, tokens: r?.tokens, retryCount: r?.retryCount, backoffSec: r?.backoffSec, startedAt: n.started_at };
    })
    .slice(0, 4);
});

const latestDelta = computed(() => {
  void nowTick.value;
  if (!hero.value) return null;
  const t = (tasks as Record<string, TaskGraph>)[hero.value.task_id];
  if (!t) return null;
  let best: { text: string; at: number } | null = null;
  for (const n of t.nodes.filter((x) => ['running', 'retrying'].includes(x.status))) {
    const text = liveDelta(t.task_id, n.id);
    if (!text) continue;
    const r = getNodeRuntime(t.task_id, n.id);
    if (r?.deltaAt && (!best || r.deltaAt > best.at)) best = { text, at: r.deltaAt };
  }
  return best?.text || null;
});

function elapsed(n: { startedAt?: string }): string {
  void nowTick.value;
  if (!n.startedAt) return '';
  return Math.max(0, Math.round((Date.now() - new Date(n.startedAt).getTime()) / 1000)) + 's';
}
function fmtTok(n: number): string {
  return n >= 1000 ? (Math.round(n / 100) / 10) + 'k' : String(n);
}
</script>

<style scoped>
.hero {
  position: relative; overflow: hidden;
  background: var(--ct-panel, var(--el-bg-color));
  border: 1px solid var(--ct-accent, #4a8dff);
  border-radius: 12px; padding: 14px 18px; margin-bottom: 14px;
  box-shadow: 0 0 0 1px rgba(74, 141, 255, 0.08), 0 4px 20px rgba(74, 141, 255, 0.06);
  animation: heroIn 0.3s ease;
}
@keyframes heroIn { from { opacity: 0; transform: translateY(-4px); } to { opacity: 1; transform: none; } }
.hero.queued { border-color: var(--ct-border2, var(--el-border-color)); box-shadow: none; }
.hero-head { display: flex; align-items: center; gap: 10px; }
.hero-tag { font-size: 11px; font-weight: 600; padding: 2px 10px; border-radius: 999px; }
.hero-tag.running, .hero-tag.retrying { color: var(--ct-yellow, #d29922); border: 1px solid var(--ct-yellow, #d29922); }
.hero-tag.finalizing { color: var(--ct-accent, #4a8dff); border: 1px solid var(--ct-accent, #4a8dff); }
.hero-tag.interrupted { color: var(--ct-red, #e5534b); border: 1px solid var(--ct-red, #e5534b); }
.hero-tag.queued { color: var(--ct-text3, #666b75); border: 1px solid var(--ct-border2, #26272c); }
.hero-stage { font-size: 11px; color: var(--ct-accent, #4a8dff); }
.hero-pct { margin-left: auto; font-size: 18px; font-weight: 700; color: var(--ct-text); font-variant-numeric: tabular-nums; }
.hero-open { border: none; background: transparent; color: var(--ct-accent, #4a8dff); font-size: 12px; cursor: pointer; padding: 2px 4px; }
.hero-open:hover { text-decoration: underline; }
.hero-title { font-size: 13px; color: var(--ct-text); margin-top: 8px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.hero-bar { height: 6px; border-radius: 3px; background: var(--ct-bg2, rgba(127,127,127,0.12)); overflow: hidden; margin-top: 8px; }
.hero-bar .fill { height: 100%; background: linear-gradient(90deg, var(--ct-accent, #4a8dff), var(--ct-green, #3fb950)); border-radius: 3px; transition: width 0.6s ease; }
.hero-nodes { margin-top: 10px; display: flex; flex-direction: column; gap: 6px; }
.hero-node { display: flex; align-items: center; gap: 8px; font-size: 12px; flex-wrap: wrap; }
.hn-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--ct-yellow, #d29922); animation: blink 1.2s ease-in-out infinite; }
@keyframes blink { 0%, 100% { opacity: 1; } 50% { opacity: 0.25; } }
.hn-agent { color: var(--ct-accent, #4a8dff); }
.hn-name { color: var(--ct-text); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.hn-chip { font-size: 10px; border: 1px solid var(--ct-border2, #26272c); border-radius: 999px; padding: 1px 8px; color: var(--ct-text2); }
.hn-chip.warn { color: var(--ct-yellow, #d29922); border-color: var(--ct-yellow, #d29922); }
.hn-elapsed { margin-left: auto; color: var(--ct-text3); font-variant-numeric: tabular-nums; }
.hero-delta {
  margin-top: 2px; padding: 6px 10px; font-size: 11px; line-height: 1.5;
  color: var(--ct-text2); background: var(--ct-bg2, rgba(127,127,127,0.06));
  border-left: 2px solid var(--ct-accent, #4a8dff); border-radius: 0 6px 6px 0;
  white-space: pre-wrap; word-break: break-all; max-height: 56px; overflow: hidden;
}
.hero-note { margin-top: 8px; font-size: 12px; }
.hero-note.warn { color: var(--ct-yellow, #d29922); }
.hero-par { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; margin-top: 8px; }
.par-label { font-size: 11px; color: var(--ct-text3, #666b75); }
.par-chip {
  border: 1px solid var(--ct-border2, #26272c); background: transparent; color: var(--ct-text2);
  font-size: 11px; border-radius: 999px; padding: 2px 10px; cursor: pointer; max-width: 260px;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.par-chip:hover { border-color: var(--ct-accent, #4a8dff); color: var(--ct-accent, #4a8dff); }
.hero-empty { border-color: var(--ct-border, #26272c); box-shadow: none; }
.hero-empty-title { font-size: 13px; font-weight: 600; color: var(--ct-text2); }
.hero-empty-sub { font-size: 12px; color: var(--ct-text3); margin-top: 4px; }
</style>
