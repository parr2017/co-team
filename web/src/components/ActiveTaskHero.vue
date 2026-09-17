<template>
  <div v-if="hero" class="hero" :class="{ queued: hero.status === 'queued' }">
    <div class="hero-top">
      <div class="info">
        <div class="sup">
          <span class="dot-run"></span>
          <span>{{ statusText(hero.status) }}</span>
          <span class="mono">· {{ hero.task_id }}</span>
          <span v-if="hero.rolling" class="mono">· 第 {{ hero.stage }} 阶段</span>
        </div>
        <h2>{{ hero.description || hero.task_id }}</h2>
        <div v-if="hero.stageGoal" class="desc">{{ hero.stageGoal }}</div>
      </div>
      <div class="hero-cta">
        <button class="cta-primary" @click="$emit('open', hero.task_id)">进入战情室 →</button>
      </div>
    </div>

    <div class="hero-bottom">
      <div class="pbar"><i :style="{ width: hero.percent + '%' }"></i></div>
      <span class="pct mono">{{ hero.percent }}%</span>
    </div>

    <!-- 心跳卡：正在执行节点的实时执行态（agent/模型/token/重试/限流/耗时） -->
    <div v-if="activeNodes.length" class="heartbeat">
      <div v-for="n in activeNodes" :key="n.id" class="hb-group">
        <div class="hb"><span class="k">执行 Agent</span><span class="v">{{ n.agent }}</span></div>
        <div class="hb" v-if="n.model"><span class="k">模型</span><span class="v mono">{{ n.model }}</span></div>
        <div class="hb" v-if="n.tokens"><span class="k">Token</span><span class="v mono">{{ fmtTok(n.tokens) }}</span></div>
        <div class="hb"><span class="k">重试</span><span class="v mono">{{ n.retryCount || 0 }}</span></div>
        <div class="hb"><span class="k">限流等待</span><span class="v mono">{{ n.backoffSec ? n.backoffSec + 's' : '0s' }}</span></div>
        <div class="hb"><span class="k">节点耗时</span><span class="v mono">{{ elapsed(n) }}</span></div>
      </div>
      <!-- 生成直播：最近一次 delta（全任务维度取最新鲜的） -->
      <div v-if="latestDelta" class="hb live-delta mono">✓ {{ latestDelta }}</div>
    </div>

    <!-- 并行任务徽标（Phase 2）：hero 之外的其他活跃任务，点击直达对应战情室 -->
    <div v-if="others.length" class="hero-par">
      <span class="par-label">另有 {{ others.length }} 个任务并行中：</span>
      <button v-for="o in others" :key="o.task_id" class="par-chip mono" :title="o.description" @click="$emit('open', o.task_id)">
        {{ o.task_id }} · {{ o.description }}
      </button>
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
  const sec = Math.max(0, Math.round((Date.now() - new Date(n.startedAt).getTime()) / 1000));
  return sec >= 60 ? `${Math.floor(sec / 60)}m ${sec % 60}s` : sec + 's';
}
function fmtTok(n: number): string {
  return n >= 1000 ? (Math.round(n / 100) / 10) + 'k' : String(n);
}
</script>

<style scoped>
/* 通栏 hero：面板卡 + 左缘强调条（预览样式） */
.hero {
  position: relative; overflow: hidden;
  background: var(--bg-panel); border: 1px solid var(--line);
  border-radius: var(--r-panel); padding: 18px 20px 16px; margin-bottom: 14px;
}
.hero::before { content: ""; position: absolute; inset: 0 auto 0 0; width: 3px; background: var(--accent); }
.hero.queued::before { background: var(--text-3); }
.hero-top { display: flex; align-items: flex-start; gap: 16px; }
.hero-top .info { flex: 1; min-width: 0; }
.sup {
  display: flex; align-items: center; gap: 8px; margin-bottom: 6px;
  font-size: var(--fs-meta); color: var(--text-3); font-family: var(--font-mono); text-transform: uppercase; letter-spacing: .04em;
}
.dot-run { width: 7px; height: 7px; border-radius: 50%; background: var(--accent); animation: pulse 1.6s infinite; flex: none; }
@keyframes pulse { 50% { opacity: .35; } }
.hero-top h2 { font-size: var(--fs-h1); font-weight: 700; letter-spacing: -.01em; line-height: 1.3; color: var(--text-1); margin: 0; }
.desc { font-size: 13px; color: var(--text-2); margin-top: 5px; max-width: 720px; }
.hero-cta { display: flex; flex-direction: column; gap: 8px; align-items: flex-end; flex: none; }
.cta-primary {
  height: 32px; padding: 0 16px; border: none; border-radius: var(--r-ctl);
  background: var(--accent); color: var(--accent-text); font-size: 13px; font-weight: 600; cursor: pointer;
  transition: filter .15s;
}
.cta-primary:hover { filter: brightness(1.08); }
.hero-bottom { display: flex; align-items: center; gap: 16px; margin-top: 14px; }
.pbar { flex: 1; height: 5px; border-radius: 3px; background: var(--bg-inset); overflow: hidden; }
.pbar i { display: block; height: 100%; background: var(--accent); border-radius: 3px; transition: width 0.6s ease; }
.pct { font-size: 13px; color: var(--accent); font-weight: 700; }

/* 心跳卡：k/v 列（mono 数值） */
.heartbeat {
  margin-top: 14px; border-top: 1px dashed var(--line); padding-top: 12px;
  display: flex; gap: 22px; flex-wrap: wrap; align-items: center;
}
.hb-group { display: flex; gap: 22px; flex-wrap: wrap; align-items: center; }
.hb { display: flex; flex-direction: column; gap: 1px; }
.hb .k { font-size: var(--fs-meta); color: var(--text-3); }
.hb .v { font-family: var(--font-mono); font-size: 13px; color: var(--text-1); }
.hb.live-delta {
  color: var(--ok); font-size: var(--fs-aux); max-width: 100%; overflow: hidden;
  text-overflow: ellipsis; white-space: nowrap; align-self: center;
}

.hero-par { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; margin-top: 10px; }
.par-label { font-size: var(--fs-meta); color: var(--text-3); }
.par-chip {
  border: 1px solid var(--line); background: transparent; color: var(--text-2);
  font-family: var(--font-mono); font-size: var(--fs-meta); border-radius: 999px; padding: 2px 10px; cursor: pointer;
  max-width: 260px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.par-chip:hover { border-color: var(--accent-line); color: var(--accent); }
.hero-note { margin-top: 8px; font-size: var(--fs-aux); }
.hero-note.warn { color: var(--warn); }
.hero-empty { border-color: var(--line); }
.hero-empty::before { background: var(--line-strong); }
.hero-empty-title { font-size: var(--fs-sub); font-weight: 600; color: var(--text-2); }
.hero-empty-sub { font-size: var(--fs-aux); color: var(--text-3); margin-top: 4px; }
</style>
