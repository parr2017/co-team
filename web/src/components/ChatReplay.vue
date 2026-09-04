<template>
  <el-dialog :model-value="modelValue" :title="`对话回放 · ${nodeName || nodeId}`" width="760px" @close="$emit('close')">
    <div class="chat-sub mono">任务 {{ taskId }} · agent: {{ nodeAgent }} · 状态: {{ nodeStatus }}</div>
    <div class="chat-wrap">
      <ChatStream :task-id="taskId" :filter-node-id="nodeId" />
    </div>
  </el-dialog>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import type { TaskGraph } from '../api';
import ChatStream from './ChatStream.vue';

const props = defineProps<{ modelValue: boolean; taskId: string; nodeId: string; task: TaskGraph | null }>();
defineEmits<{ (e: 'close'): void }>();

const nodeAgent = computed(() => props.task?.nodes.find((n) => n.id === props.nodeId)?.agent || '?');
const nodeName = computed(() => props.task?.nodes.find((n) => n.id === props.nodeId)?.name || '');
const nodeStatus = computed(() => props.task?.nodes.find((n) => n.id === props.nodeId)?.status || '?');
</script>

<style scoped>
.chat-sub { font-size: 11px; color: var(--ct-text3); margin-bottom: 10px; }
.chat-wrap { max-height: 520px; overflow-y: auto; display: flex; flex-direction: column; }
</style>
