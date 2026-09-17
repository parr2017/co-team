<template>
  <el-dialog :model-value="modelValue" :title="`对话回放 · ${nodeName || nodeId}`" width="860px" @open="onOpen" @close="$emit('close')">
    <div class="chat-sub mono">
      任务 {{ taskId }} · agent: {{ nodeAgent }} · 状态: {{ nodeStatus }}
      <el-radio-group v-model="mode" size="small" style="margin-left: 12px">
        <el-radio-button value="chat">任务频道流</el-radio-button>
        <el-radio-button value="full">完整会话回放</el-radio-button>
      </el-radio-group>
    </div>
    <div v-show="mode === 'chat'" class="chat-wrap">
      <ChatStream :task-id="taskId" :filter-node-id="nodeId" />
    </div>
    <!-- 完整会话回放：api.taskLogs 的逐轮 transcript（含用户消息/助手输出/工具结果） -->
    <div v-if="mode === 'full'" class="full-wrap">
      <div v-if="fullLoading" class="state mono">加载完整会话…</div>
      <div v-else-if="!conversations.length" class="state mono">该节点暂无完整会话记录</div>
      <div v-for="(c, ci) in conversations" :key="ci" class="conv">
        <div class="conv-head mono">
          <span class="conv-agent">{{ c.agent }}</span>
          <span class="conv-node">{{ c.node_name || nodeName }}</span>
          <span class="conv-meta">{{ c.model }} · {{ c.rounds?.length || 0 }} 轮 · {{ (c.tokens || 0).toLocaleString() }} tok</span>
        </div>
        <div v-for="(r, ri) in c.rounds || []" :key="ri" class="round">
          <div v-if="r.user" class="r-line r-user"><span class="r-tag mono">user</span><span class="r-text">{{ clip(r.user) }}</span></div>
          <div v-if="r.assistant" class="r-line r-assistant"><span class="r-tag mono">assistant</span><span class="r-text pre">{{ r.assistant }}</span></div>
          <div v-if="r.tool_results?.length" class="r-line r-tools">
            <span class="r-tag mono">tools</span>
            <span class="r-text mono tools">{{ JSON.stringify(r.tool_results).slice(0, 400) }}{{ JSON.stringify(r.tool_results).length > 400 ? '…' : '' }}</span>
          </div>
          <div v-if="r.parse_error" class="r-line r-error"><span class="r-tag mono">error</span><span class="r-text">{{ r.parse_error }}</span></div>
        </div>
      </div>
    </div>
  </el-dialog>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { api, type AgentConversation, type TaskGraph } from '../api';
import ChatStream from './ChatStream.vue';

const props = defineProps<{ modelValue: boolean; taskId: string; nodeId: string; task: TaskGraph | null }>();
defineEmits<{ (e: 'close'): void }>();

const mode = ref<'chat' | 'full'>('chat');
const conversations = ref<AgentConversation[]>([]);
const fullLoading = ref(false);

const nodeAgent = computed(() => props.task?.nodes.find((n) => n.id === props.nodeId)?.agent || '?');
const nodeName = computed(() => props.task?.nodes.find((n) => n.id === props.nodeId)?.name || '');
const nodeStatus = computed(() => props.task?.nodes.find((n) => n.id === props.nodeId)?.status || '?');

function clip(s: string): string {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  return t.length > 220 ? t.slice(0, 220) + '…' : t;
}

async function loadFull() {
  fullLoading.value = true;
  conversations.value = [];
  try {
    const d = await api.taskLogs(props.taskId);
    const all = Object.values(d.logs || {}).flat();
    // 该节点的会话（transcript 以 node_name/agent 归属，与 nodeId 不同源）
    conversations.value = all.filter((c) => !props.nodeId || c.node_name === nodeName.value || c.agent === nodeAgent.value);
  } catch {
    conversations.value = [];
  } finally {
    fullLoading.value = false;
  }
}

function onOpen() {
  mode.value = 'chat';
  conversations.value = [];
}
watch(mode, (v) => {
  if (v === 'full' && !conversations.value.length) void loadFull();
});
</script>

<style scoped>
.chat-sub { font-size: 11px; color: var(--text-3); margin-bottom: 10px; display: flex; align-items: center; }
.chat-wrap { max-height: 520px; overflow-y: auto; display: flex; flex-direction: column; background: var(--bg-page); border: 1px solid var(--line); border-radius: 6px; padding: 4px; }
.full-wrap { max-height: 560px; overflow-y: auto; background: var(--bg-page); border: 1px solid var(--line); border-radius: 6px; padding: 8px; }
.state { color: var(--text-3); text-align: center; padding: 30px 0; font-size: 12px; }
.conv { margin-bottom: 12px; }
.conv-head { display: flex; align-items: center; gap: 10px; padding: 6px 10px; background: var(--bg-raised); border-radius: 5px; font-size: 11px; }
.conv-agent { color: var(--accent); font-weight: 700; }
.conv-node { color: var(--text-1); }
.conv-meta { margin-left: auto; color: var(--text-3); }
.round { border-bottom: 1px dashed var(--line); padding: 6px 10px; }
.round:last-child { border-bottom: none; }
.r-line { display: flex; gap: 8px; align-items: baseline; margin: 3px 0; }
.r-tag { flex: 0 0 62px; text-align: right; font-size: 10px; color: var(--text-3); }
.r-user .r-text { color: var(--text-2); font-size: 12px; }
.r-assistant .r-text { color: var(--text-1); font-size: 12px; }
.r-text.pre { white-space: pre-wrap; overflow-wrap: anywhere; max-height: 180px; overflow-y: auto; }
.r-tools .r-text { font-size: 10.5px; color: var(--text-3); word-break: break-all; }
.r-error .r-text { color: var(--danger); font-size: 12px; }
</style>
