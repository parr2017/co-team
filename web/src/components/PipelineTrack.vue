<template>
  <div class="track">
    <div v-for="(n, i) in nodes" :key="n.id" class="station-wrap">
      <div class="rail" :class="{ first: i === 0, last: i === nodes.length - 1 }"></div>
      <div
        class="station"
        :class="[n.status, { selected: n.id === selectedId, running: isRunning(n) }]"
        :data-node="n.id"
        @click="$emit('select', n.id)"
      >
        <div class="dot" :class="n.status"></div>
        <div class="s-main">
          <div class="s-top">
            <span class="s-name">{{ n.name }}</span>
            <span class="s-status" :class="n.status">{{ statusText(n.status) }}</span>
          </div>
          <div class="s-meta mono">
            <span class="agent-badge">{{ badge(n.agent) }} {{ n.agent }}</span>
            <span v-if="n.branch" class="branch">⎇ {{ n.branch.replace('coteam/', '') }}</span>
            <span v-if="dur(n)">{{ dur(n) }}</span>
            <span v-if="n.retry_count" class="retry">重试 ×{{ n.retry_count }}</span>
          </div>
          <!-- 2.2 节点心跳卡：运行中节点的实时执行态（模型/耗时/token/退避/换模） -->
          <div v-if="isRunning(n) && rt(n)" class="heartbeat mono">
            <span v-if="rt(n)!.model" class="hb-chip model">{{ rt(n)!.model }}</span>
            <span v-if="rt(n)!.tokens" class="hb-chip">{{ fmtTok(rt(n)!.tokens!) }} tok</span>
            <span v-if="rt(n)!.round" class="hb-chip">第 {{ rt(n)!.round }} 轮</span>
            <span v-if="rt(n)!.retryCount" class="hb-chip warn">重试 {{ rt(n)!.retryCount }}</span>
            <span v-if="rt(n)!.backoffSec" class="hb-chip warn">⏳ 限流退避 {{ rt(n)!.backoffSec }}s</span>
            <span v-else-if="rt(n)!.failoverFrom" class="hb-chip warn">↯ 自 {{ rt(n)!.failoverFrom }} 换入</span>
            <span class="hb-live"><i></i>生成中</span>
          </div>
          <!-- 2.1 生成直播：打字机滚动预览（末 200 字） -->
          <div v-if="isRunning(n) && liveText(n)" class="delta mono">{{ liveText(n) }}</div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted, onUnmounted } from 'vue';
import type { TaskNode } from '../api';
import { statusText } from '../utils/events';
import { useDashboard, type NodeRuntime } from '../composables/useDashboard';

defineProps<{ nodes: TaskNode[]; selectedId?: string }>();
defineEmits<{ (e: 'select', nodeId: string): void }>();

const { getNodeRuntime, liveDelta } = useDashboard();

const CODES: Record<string, string> = { orchestrator: 'OR', dev: 'DV', deploy: 'DP', docs: 'DO', refactor: 'RF', review: 'RV', test: 'TE' };
function badge(agent: string) { return CODES[agent] || agent.slice(0, 2).toUpperCase(); }
function isRunning(n: TaskNode): boolean { return n.status === 'running' || n.status === 'retrying'; }

// 每秒心跳：让"已耗时"和 delta 新鲜度（3s 窗口）动起来
const nowTick = ref(0);
let timer: number | null = null;
onMounted(() => {
  timer = window.setInterval(() => { nowTick.value += 1; }, 1000);
});
onUnmounted(() => { if (timer !== null) window.clearInterval(timer); });

function rt(n: TaskNode): NodeRuntime | null {
  void nowTick.value; // 心跳依赖：每秒刷新
  return getNodeRuntime(n.task_id, n.id);
}
function liveText(n: TaskNode): string | null {
  void nowTick.value;
  return liveDelta(n.task_id, n.id);
}
function dur(n: TaskNode): string {
  void nowTick.value; // 运行中节点耗时每秒跳动
  if (!n.started_at) return '';
  const end = n.finished_at ? new Date(n.finished_at).getTime() : Date.now();
  const sec = Math.max(0, Math.round((end - new Date(n.started_at).getTime()) / 100) / 10);
  return sec + 's';
}
function fmtTok(n: number): string {
  return n >= 1000 ? (Math.round(n / 100) / 10) + 'k' : String(n);
}
</script>

<style scoped>
.track { position: relative; display: flex; flex-direction: column; }
.station-wrap { position: relative; padding-left: 26px; }
.rail { position: absolute; left: 9px; top: 0; bottom: 0; width: 2px; background: var(--ct-border); }
.rail.first { top: 26px; }
.rail.last { bottom: auto; height: 26px; }
.station {
  position: relative; display: flex; gap: 10px; align-items: flex-start;
  padding: 9px 12px; margin: 6px 0;
  background: var(--ct-panel); border: 1px solid var(--ct-border); border-radius: 6px;
  cursor: pointer; transition: border-color 0.15s, box-shadow 0.15s;
}
.station:hover { border-color: var(--ct-border2); }
.station.selected { border-color: var(--ct-accent); box-shadow: 0 0 0 2px rgba(47, 111, 237, 0.12); }
.dot { position: absolute; left: -21px; top: 18px; width: 9px; height: 9px; border-radius: 50%; background: var(--ct-text3); border: 2px solid var(--ct-panel); box-sizing: content-box; margin-left: 1px; }
.dot.completed { background: var(--ct-green); }
.dot.running, .dot.retrying { background: var(--ct-yellow); animation: pulse 1.6s ease-in-out infinite; }
.dot.failed { background: var(--ct-red); }
.dot.waiting_approval { background: var(--ct-accent); }
.station.running { border-color: var(--ct-border2); }
@keyframes pulse {
  0%, 100% { box-shadow: 0 0 0 0 rgba(154, 108, 10, 0.35); }
  50% { box-shadow: 0 0 0 5px rgba(154, 108, 10, 0.08); }
}
.s-main { flex: 1; min-width: 0; }
.s-top { display: flex; align-items: baseline; gap: 8px; }
.s-name { font-size: 12px; color: var(--ct-text); font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.s-status { flex-shrink: 0; font-size: 10px; margin-left: auto; }
.s-status.completed { color: var(--ct-green); }
.s-status.running, .s-status.retrying { color: var(--ct-yellow); }
.s-status.failed { color: var(--ct-red); }
.s-status.waiting_approval { color: var(--ct-accent); }
.s-status.pending, .s-status.planned, .s-status.cancelled, .s-status.queued { color: var(--ct-text3); }
.s-meta { display: flex; gap: 8px; align-items: center; margin-top: 4px; font-size: 10px; color: var(--ct-text3); flex-wrap: wrap; }
.agent-badge { border: 1px solid var(--ct-border2); border-radius: 3px; padding: 0 4px; color: var(--ct-text2); }
.branch { color: var(--ct-accent); }
.retry { color: var(--ct-yellow); }

/* ---- 2.2 心跳卡 ---- */
.heartbeat { display: flex; gap: 6px; align-items: center; margin-top: 6px; font-size: 10px; flex-wrap: wrap; }
.hb-chip { border: 1px solid var(--ct-border2); border-radius: 999px; padding: 1px 8px; color: var(--ct-text2); background: var(--ct-panel2, transparent); }
.hb-chip.warn { color: var(--ct-yellow); border-color: var(--ct-yellow); }
.hb-chip.model { color: var(--ct-accent); border-color: var(--ct-accent); }
.hb-live { display: inline-flex; align-items: center; gap: 4px; color: var(--ct-green); margin-left: auto; }
.hb-live i { width: 6px; height: 6px; border-radius: 50%; background: var(--ct-green); animation: blink 1.2s ease-in-out infinite; }
@keyframes blink { 0%, 100% { opacity: 1; } 50% { opacity: 0.25; } }

/* ---- 2.1 生成直播打字机 ---- */
.delta {
  margin-top: 6px; padding: 6px 8px;
  font-size: 10px; line-height: 1.5; color: var(--ct-text2);
  background: var(--ct-bg2, rgba(127, 127, 127, 0.06));
  border-left: 2px solid var(--ct-accent);
  border-radius: 0 4px 4px 0;
  white-space: pre-wrap; word-break: break-all;
  max-height: 64px; overflow: hidden;
  animation: deltaIn 0.25s ease;
}
@keyframes deltaIn { from { opacity: 0.4; } to { opacity: 1; } }
</style>
