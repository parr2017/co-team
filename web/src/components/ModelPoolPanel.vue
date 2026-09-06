<template>
  <div class="section">
    <div class="section-head">
      <div class="section-title">模型池 / {{ Object.keys(status?.model_pool || {}).length }} 个模型</div>
      <el-button size="small" link @click="$emit('refresh')">刷新</el-button>
    </div>
    <div v-if="!status" class="muted mono">加载中...</div>
    <div v-else class="pool-grid">
      <div v-for="(m, name) in status.model_pool" :key="name" class="model-card">
        <div class="m-head">
          <span class="m-dot" :class="m.healthy ? 'on' : 'off'"></span>
          <span class="m-name mono">{{ name }}</span>
          <span v-if="m.cost_per_1k" class="m-cost mono">${{ m.cost_per_1k }}/1k</span>
        </div>
        <div class="m-meta mono">{{ m.tags.join(' · ') }}</div>
        <div class="slot-bar"><div class="slot-fill" :style="{ width: Math.round((m.available / m.concurrency) * 100) + '%' }"></div></div>
        <div class="m-slots mono">余量 {{ m.available }}/{{ m.concurrency }} · 活跃 {{ m.active }}</div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import type { StatusResponse } from '../api';
defineProps<{ status: StatusResponse | null }>();
defineEmits<{ (e: 'refresh'): void }>();
</script>

<style scoped>
.pool-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(230px, 1fr)); gap: 10px; }
.model-card { background: var(--ct-bg); border: 1px solid var(--el-border-color); border-radius: 6px; padding: 10px 12px; }
.m-head { display: flex; align-items: center; gap: 7px; }
.m-dot { width: 7px; height: 7px; border-radius: 50%; flex-shrink: 0; }
.m-dot.on { background: var(--ct-green); }
.m-dot.off { background: var(--ct-red); }
.m-name { font-size: 12px; font-weight: 600; color: var(--ct-text); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.m-cost { margin-left: auto; font-size: 10px; color: var(--ct-text3); flex-shrink: 0; }
.m-meta { font-size: 10px; color: var(--ct-text3); margin-top: 3px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.slot-bar { height: 4px; background: var(--ct-panel2); border-radius: 2px; margin-top: 8px; overflow: hidden; }
.slot-fill { height: 100%; background: var(--ct-accent); transition: width 0.4s; }
.m-slots { font-size: 10px; color: var(--ct-text3); margin-top: 5px; }
.muted { color: var(--ct-text3); font-size: 12px; }
.section-head { display: flex; align-items: baseline; gap: 10px; margin-bottom: 10px; }
</style>
