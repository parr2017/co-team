<template>
  <div class="chat-thread">
    <!-- 系统提示词折叠条 -->
    <details class="sys-bar">
      <summary class="mono">system prompt · {{ subAgent }}</summary>
      <pre class="sys-body mono">{{ conversations[0]?.system }}</pre>
    </details>

    <template v-for="(a, ai) in conversations" :key="ai">
      <!-- 会话块分隔 -->
      <div class="session mono">
        <span class="session-tag">{{ a.label }}</span>
        <span class="session-meta">{{ a.model }} · {{ a.duration_sec != null ? a.duration_sec + 's' : '…' }} · {{ a.tokens.toLocaleString() }} tok</span>
      </div>

      <template v-for="(rd, ri) in a.rounds" :key="ri">
        <!-- 主 Agent：任务简报（每会话第一轮由 user 消息体现，这里以 tool 结果补充） -->
        <div v-if="rd.tool_results && rd.user && !rd.user.includes('工具执行结果已提供')" class="row master">
          <div class="bubble master-b">
            <div class="b-head mono"><span class="who">主 Agent</span></div>
            <div class="b-text">{{ rd.user }}</div>
            <details class="attach">
              <summary class="mono">📎 工具数据 · {{ rd.tool_results.length }} 项</summary>
              <pre class="pre mono">{{ dump(rd.tool_results) }}</pre>
            </details>
          </div>
        </div>
        <div v-else-if="rd.tool_results" class="row master">
          <div class="bubble master-b">
            <div class="b-head mono"><span class="who">主 Agent</span></div>
            <details class="attach" open>
              <summary class="mono">📎 工具数据 · {{ rd.tool_results.length }} 项</summary>
              <pre class="pre mono">{{ dump(rd.tool_results) }}</pre>
            </details>
          </div>
        </div>

        <!-- 子 Agent 回复 -->
        <div v-if="rd.assistant !== undefined" class="row sub">
          <div class="bubble sub-b" :class="{ broken: rd.parse_error }">
            <div class="b-head mono">
              <span class="who">{{ subAgent }}</span>
              <span v-if="a.rounds.length > 1" class="round-no">round {{ ri + 1 }}</span>
            </div>
            <div v-if="rd.parse_error" class="b-error mono">!! {{ rd.parse_error }} — 原始输出见附件</div>
            <template v-else>
              <div v-if="parsed(rd.assistant)?.summary" class="b-text">{{ parsed(rd.assistant)!.summary }}</div>
              <div v-for="(er, ei) in parsed(rd.assistant)?.errors || []" :key="ei" class="b-error mono">✗ {{ er }}</div>
              <div v-if="parsed(rd.assistant)?.tool_calls?.length" class="tooling mono">
                ⚙ 请求读取工具：{{ (parsed(rd.assistant)!.tool_calls || []).map((t: any) => t.tool + (t.path ? ':' + t.path : '')).join(' / ') }}
              </div>
            </template>
            <details v-if="rd.assistant && rd.assistant.length > 120" class="attach">
              <summary class="mono">📎 技术详情 · {{ rd.assistant.length }} 字符</summary>
              <pre class="pre mono">{{ pretty(rd.assistant) }}</pre>
            </details>
          </div>
        </div>
      </template>

      <!-- 最终错误 -->
      <div v-if="a.error" class="row sub">
        <div class="bubble sub-b fatal"><div class="b-error mono">✗ {{ a.error }}</div></div>
      </div>
    </template>

    <div v-if="!conversations.length" class="empty mono">no conversation recorded</div>
  </div>
</template>

<script setup lang="ts">
import type { AgentConversation } from '../api';

const props = defineProps<{ conversations: AgentConversation[]; subAgent: string }>();

function parsed(content?: string): any {
  if (!content) return null;
  try {
    return JSON.parse(content);
  } catch {
    const m = content.match(/\{[\s\S]*\}/);
    try {
      return m ? JSON.parse(m[0]) : null;
    } catch {
      return null;
    }
  }
}
function dump(v: unknown): string {
  return JSON.stringify(v, null, 1);
}
function pretty(s: string): string {
  const p = parsed(s);
  return p ? JSON.stringify(p, null, 2) : s;
}
void props;
</script>

<style scoped>
.chat-thread { display: flex; flex-direction: column; gap: 6px; padding: 4px 2px; }
.sys-bar { margin-bottom: 8px; }
.sys-bar summary { cursor: pointer; font-size: 10px; color: var(--ct-text3); padding: 4px 8px; background: var(--ct-panel2); border-radius: 4px; }
.sys-body { max-height: 180px; overflow: auto; font-size: 10px; color: var(--ct-text3); background: var(--ct-bg); border-radius: 4px; padding: 8px; margin-top: 6px; white-space: pre-wrap; }
.session { display: flex; align-items: center; gap: 10px; margin: 12px 0 8px; font-size: 10px; color: var(--ct-text3); }
.session::before, .session::after { content: ''; flex: 1; height: 1px; background: var(--ct-border2); }
.session-tag { color: var(--ct-accent); font-weight: 600; }
.row { display: flex; }
.row.master { justify-content: flex-start; }
.row.sub { justify-content: flex-end; }
.bubble { max-width: 86%; padding: 8px 10px; border-radius: 8px; font-size: 12px; }
.master-b { background: var(--ct-panel2); border-left: 3px solid var(--ct-accent); border-radius: 2px 8px 8px 8px; }
.sub-b { background: var(--ct-panel); border: 1px solid var(--ct-border); border-right: 3px solid var(--ct-green); border-radius: 8px 2px 8px 8px; }
.bubble.fatal { border-right-color: var(--ct-red); }
.b-head { display: flex; justify-content: space-between; gap: 10px; font-size: 10px; color: var(--ct-text3); margin-bottom: 4px; }
.who { color: var(--ct-text2); font-weight: 600; }
.b-text { white-space: pre-wrap; word-break: break-word; color: var(--ct-text); }
.b-error { color: var(--ct-red); white-space: pre-wrap; }
.round-no { color: var(--ct-text3); }
.tooling { font-size: 11px; color: var(--ct-yellow); margin-top: 4px; }
.attach { margin-top: 6px; }
.attach summary { cursor: pointer; font-size: 10px; color: var(--ct-text3); }
.attach .pre { max-height: 200px; overflow: auto; background: var(--ct-bg); border-radius: 4px; padding: 6px; margin-top: 4px; font-size: 10px; white-space: pre-wrap; }
.empty { text-align: center; color: var(--ct-text3); padding: 24px; font-size: 12px; }
</style>
