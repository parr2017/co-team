<template>
  <div class="chat-thread">
    <div v-if="!entries.length" class="empty mono">该成员还没有对话记录</div>

    <template v-for="(e, i) in entries" :key="i">
      <!-- 主 Agent：任务简报 -->
      <div v-if="e.kind === 'brief'" class="row master">
        <div class="bubble master-b">
          <div class="b-head mono"><span class="who">主 Agent</span><span class="when">{{ fmt(e.ts) }}</span></div>
          <div class="brief">
            <div v-for="(line, li) in briefLines(e.text)" :key="li" class="brief-line">
              <span class="bl-k mono">{{ line.k }}</span><span class="bl-v">{{ line.v }}</span>
            </div>
          </div>
        </div>
      </div>

      <!-- 主 Agent：工具数据附件 -->
      <div v-else-if="e.kind === 'tool_results'" class="row master">
        <div class="bubble master-b slim">
          <div class="b-head mono"><span class="who">主 Agent</span><span class="when">{{ fmt(e.ts) }}</span></div>
          <details class="attach">
            <summary class="mono">📎 交付工具数据 · {{ (e.meta?.results || []).length }} 项</summary>
            <pre class="pre mono">{{ dump(e.meta?.results) }}</pre>
          </details>
        </div>
      </div>

      <!-- 子 Agent：动作行（请求工具） -->
      <div v-else-if="e.kind === 'round'" class="row action">
        <span class="action-line mono">⚙ {{ e.text }}</span>
        <span class="when mono">{{ e.model }} · {{ e.tokens }} tok</span>
      </div>

      <!-- 子 Agent：最终汇报 -->
      <div v-else-if="e.kind === 'final'" class="row sub">
        <div class="bubble sub-b">
          <div class="b-head mono"><span class="when">{{ fmt(e.ts) }}</span><span class="who">{{ subAgent }}</span></div>
          <div class="b-text">{{ e.text }}</div>
          <div v-if="(e.meta?.changes || []).length" class="chips mono">
            <span v-for="c in (e.meta?.changes || []).slice(0, 6)" :key="c" class="chip">✓ {{ c }}</span>
          </div>
          <details v-if="(e.meta?.files || []).length || (e.meta?.commands || []).length" class="attach">
            <summary class="mono">📎 附件 · {{ (e.meta?.files || []).length }} 文件 / {{ (e.meta?.commands || []).length }} 命令</summary>
            <pre class="pre mono">files: {{ (e.meta?.files || []).join(', ') }}
commands: {{ (e.meta?.commands || []).join(' | ') }}</pre>
          </details>
          <div class="b-foot mono">{{ e.model }} · {{ e.tokens }} tok</div>
        </div>
      </div>

      <!-- 子 Agent：错误 -->
      <div v-else-if="e.kind === 'error'" class="row sub">
        <div class="bubble sub-b fatal">
          <div class="b-head mono"><span class="when">{{ fmt(e.ts) }}</span><span class="who">{{ subAgent }}</span></div>
          <div class="b-error mono">✗ {{ e.text }}</div>
          <details v-if="e.meta?.raw" class="attach">
            <summary class="mono">📎 原始输出</summary>
            <pre class="pre mono">{{ e.meta.raw }}</pre>
          </details>
        </div>
      </div>
    </template>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import type { JournalEntry } from '../api';

const props = defineProps<{ journal: JournalEntry[]; subAgent: string; filterNodeId?: string }>();

const entries = computed(() => (props.filterNodeId ? props.journal.filter((e) => e.node_id === props.filterNodeId) : props.journal));

function briefLines(text: string): { k: string; v: string }[] {
  const out: { k: string; v: string }[] = [];
  for (const raw of (text || '').split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    const m = line.match(/^(工作目录|现有文件|任务|节点复杂度|前置节点成果)[:-]\s*(.*)$/);
    if (m) out.push({ k: m[1], v: m[2] });
    else if (line.startsWith('- ')) out.push({ k: '成果', v: line.slice(2) });
  }
  return out.length ? out : [{ k: '简报', v: text }];
}
function fmt(ts: string): string {
  return new Date(ts).toLocaleTimeString();
}
function dump(v: unknown): string {
  return JSON.stringify(v, null, 1);
}
</script>

<style scoped>
.chat-thread { display: flex; flex-direction: column; gap: 8px; padding: 2px; }
.empty { color: var(--ct-text3); text-align: center; padding: 24px; font-size: 12px; }
.row { display: flex; }
.row.master { justify-content: flex-start; }
.row.sub { justify-content: flex-end; }
.row.action { justify-content: center; }
.action-line { font-size: 11px; color: var(--ct-yellow); background: var(--ct-panel2); border: 1px dashed var(--ct-border2); border-radius: 4px; padding: 2px 10px; }
.when { font-size: 10px; color: var(--ct-text3); margin-left: 8px; }
.bubble { max-width: 88%; padding: 10px 12px; border-radius: 8px; font-size: 13px; }
.master-b { background: var(--ct-panel2); border-left: 3px solid var(--ct-accent); border-radius: 2px 8px 8px 8px; }
.sub-b { background: var(--ct-panel); border: 1px solid var(--ct-border); border-right: 3px solid var(--ct-green); border-radius: 8px 2px 8px 8px; }
.sub-b.fatal { border-right-color: var(--ct-red); }
.b-head { display: flex; justify-content: space-between; gap: 10px; font-size: 10px; color: var(--ct-text3); margin-bottom: 4px; }
.who { color: var(--ct-text2); font-weight: 700; }
.b-text { white-space: pre-wrap; word-break: break-word; color: var(--ct-text); line-height: 1.6; }
.b-error { color: var(--ct-red); white-space: pre-wrap; font-size: 12px; }
.b-foot { margin-top: 6px; font-size: 10px; color: var(--ct-text3); text-align: right; }
.brief { display: flex; flex-direction: column; gap: 3px; }
.brief-line { display: flex; gap: 8px; font-size: 12px; }
.bl-k { flex-shrink: 0; color: var(--ct-accent); min-width: 70px; }
.bl-v { color: var(--ct-text2); word-break: break-all; }
.chips { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 6px; }
.chip { font-size: 10px; color: var(--ct-green); border: 1px solid var(--ct-border); border-radius: 3px; padding: 1px 5px; background: var(--ct-bg); }
.attach { margin-top: 6px; }
.attach summary { cursor: pointer; font-size: 10px; color: var(--ct-text3); }
.attach .pre { max-height: 180px; overflow: auto; background: var(--ct-bg); border-radius: 4px; padding: 6px; margin-top: 4px; font-size: 10px; white-space: pre-wrap; }
</style>
