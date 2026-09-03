<template>
  <div class="section">
    <div class="section-title">模型池</div>
    <div v-if="!status" class="muted">加载中...</div>
    <div v-for="(m, name) in status?.model_pool || {}" :key="name" class="model-card">
      <div class="model-name">{{ name }}<span v-if="!m.healthy" class="warn">[degraded]</span></div>
      <div class="model-meta">
        <span>{{ m.tags.join(' · ') }}</span>
        <span>余量 {{ m.available }}/{{ m.concurrency }}</span>
      </div>
      <div class="slot-bar"><div class="slot-fill" :style="{ width: Math.round((m.available / m.concurrency) * 100) + '%' }"></div></div>
    </div>
  </div>
</template>

<script setup lang="ts">
import type { StatusResponse } from '../api';
defineProps<{ status: StatusResponse | null }>();
</script>

<style scoped>
.model-card { background: var(--ct-bg); border: 1px solid var(--el-border-color); border-radius: 8px; padding: 10px; margin-bottom: 8px; }
.model-name { font-size: 12px; font-weight: 600; }
.model-meta { font-size: 11px; color: var(--ct-text3); margin-top: 2px; display: flex; justify-content: space-between; }
.slot-bar { height: 4px; background: var(--ct-panel2); border-radius: 2px; margin-top: 6px; overflow: hidden; }
.slot-fill { height: 100%; background: var(--ct-accent); transition: width 0.4s; }
.muted { color: var(--ct-text3); font-size: 12px; }
</style>

<style scoped>
.warn { color: var(--ct-yellow); font-family: var(--ct-mono); font-size: 10px; }
</style>
