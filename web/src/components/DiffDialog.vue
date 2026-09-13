<template>
  <el-dialog :model-value="modelValue" :title="title" width="960px" top="4vh" @close="$emit('close')" @open="load">
    <div v-if="loading" class="mono state">加载 diff…</div>
    <template v-else-if="diff">
      <div v-if="!diff.available" class="mono state">{{ diff.reason || '暂无代码变更' }}</div>
      <template v-else>
        <!-- 文件列表：点击滚动到对应分块 -->
        <div class="files mono">
          <button v-for="f in parsedFiles" :key="f.path" type="button" class="file-row" @click="scrollToFile(f.path)">
            <span class="f-path" :title="f.path">{{ f.path }}</span>
            <span class="f-ins">+{{ f.insertions }}</span>
            <span class="f-del">−{{ f.deletions }}</span>
          </button>
        </div>
        <div class="toolbar">
          <span class="mono stat">{{ stats }}</span>
          <el-button size="small" link type="primary" @click="copyAll">复制全部 patch</el-button>
        </div>
        <!-- 按文件分块渲染：行号 + 变更着色，代码行不折行保持对齐（横向滚动） -->
        <div ref="patchWrap" class="patch-wrap">
          <div v-for="f in parsedFiles" :key="f.path" class="file-block">
            <div class="fb-head mono">
              <span class="fb-path" :title="f.path">{{ f.path }}</span>
              <span class="f-ins">+{{ f.insertions }}</span>
              <span class="f-del">−{{ f.deletions }}</span>
              <button type="button" class="fb-copy" @click="copyFile(f)">复制</button>
            </div>
            <div v-for="(ln, i) in f.lines" :key="i" class="row" :class="ln.kind">
              <span class="no mono">{{ ln.oldNo || '' }}</span>
              <span class="no mono">{{ ln.newNo || '' }}</span>
              <span class="sign mono">{{ ln.kind === 'add' ? '+' : ln.kind === 'del' ? '-' : '' }}</span>
              <span class="code mono">{{ ln.text || ' ' }}</span>
            </div>
          </div>
        </div>
      </template>
    </template>
    <div v-else class="mono state">加载 diff…</div>
    <template #footer>
      <el-button size="small" @click="$emit('close')">关闭</el-button>
    </template>
  </el-dialog>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { ElMessage } from 'element-plus';
import { api, type NodeDiffResponse } from '../api';

interface DiffLine { kind: 'meta' | 'hunk' | 'add' | 'del' | 'ctx'; oldNo: number; newNo: number; text: string }
interface DiffFile { path: string; insertions: number; deletions: number; lines: DiffLine[]; patch: string }

const props = defineProps<{ modelValue: boolean; taskId: string; nodeId: string; nodeName?: string }>();
defineEmits<{ (e: 'close'): void }>();

const diff = ref<NodeDiffResponse | null>(null);
const loading = ref(false);
const patchWrap = ref<HTMLElement>();

const title = computed(() => `代码变更 · ${props.nodeName || props.nodeId}`);

/** unified patch 解析：按文件分块 + 双侧行号（服务端 files 元数据只用于兜底计数） */
const parsedFiles = computed<DiffFile[]>(() => {
  const patch = diff.value?.patch || '';
  if (!patch) return [];
  const out: DiffFile[] = [];
  let cur: DiffFile | null = null;
  let oldNo = 0;
  let newNo = 0;
  for (const raw of patch.split('\n')) {
    const line = raw.replace(/\r$/, '');
    if (line.startsWith('diff --git ')) {
      cur = { path: '(unknown)', insertions: 0, deletions: 0, lines: [], patch: line + '\n' };
      out.push(cur);
      continue;
    }
    if (line.startsWith('--- ')) {
      if (cur) cur.patch += line + '\n';
      continue;
    }
    if (line.startsWith('+++ ')) {
      // 以 +++ 侧为准（/dev/null 时回退 --- 侧），剥掉 a/ 前缀
      let p = line.slice(4).replace(/\t.*$/, '').trim();
      if (p === '/dev/null') {
        const prev = (patch.split('\n').find((l) => l.startsWith('--- ')) || '');
        p = prev.slice(4).trim();
      }
      p = p.replace(/^(a|b)\//, '');
      if (cur) { cur.path = p || cur.path; cur.patch += line + '\n'; }
      continue;
    }
    if (line.startsWith('@@')) {
      const m = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      if (m) { oldNo = parseInt(m[1], 10); newNo = parseInt(m[2], 10); }
      cur?.lines.push({ kind: 'hunk', oldNo: 0, newNo: 0, text: line });
      if (cur) cur.patch += line + '\n';
      continue;
    }
    if (!cur) continue;
    cur.patch += line + '\n';
    if (line.startsWith('+')) {
      cur.lines.push({ kind: 'add', oldNo: 0, newNo: newNo++, text: line.slice(1) });
      cur.insertions += 1;
    } else if (line.startsWith('-')) {
      cur.lines.push({ kind: 'del', oldNo: oldNo++, newNo: 0, text: line.slice(1) });
      cur.deletions += 1;
    } else if (line.startsWith('index ') || line.startsWith('\\')) {
      cur.lines.push({ kind: 'meta', oldNo: 0, newNo: 0, text: line });
    } else {
      cur.lines.push({ kind: 'ctx', oldNo: oldNo++, newNo: newNo++, text: line.replace(/^ /, '') });
    }
  }
  // 兜底：解析不出文件头时整包作为一个块
  if (!out.length && patch.trim()) {
    return [{ path: '(patch)', insertions: 0, deletions: 0, lines: patch.split('\n').map((t) => ({ kind: 'meta' as const, oldNo: 0, newNo: 0, text: t })), patch }];
  }
  return out;
});

const stats = computed(() => {
  const files = parsedFiles.value;
  const ins = files.reduce((s, f) => s + f.insertions, 0);
  const del = files.reduce((s, f) => s + f.deletions, 0);
  return `${files.length} 个文件 · +${ins} −${del}`;
});

function scrollToFile(path: string) {
  const blocks = patchWrap.value?.querySelectorAll('.file-block');
  const target = Array.from(blocks || []).find((b) => b.querySelector('.fb-path')?.textContent === path);
  target?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function copyText(text: string, okMsg: string) {
  if (navigator.clipboard?.writeText) {
    void navigator.clipboard.writeText(text).then(() => ElMessage.success(okMsg)).catch(() => ElMessage.error('复制失败'));
  } else {
    ElMessage.error('浏览器不支持剪贴板');
  }
}
function copyAll() { copyText(diff.value?.patch || '', '已复制全部 patch'); }
function copyFile(f: DiffFile) { copyText(f.patch, `已复制 ${f.path} 的 patch`); }

async function load() {
  if (!props.nodeId) return;
  loading.value = true;
  diff.value = null;
  try {
    diff.value = await api.nodeDiff(props.taskId, props.nodeId);
  } catch {
    diff.value = { node_id: props.nodeId, branch: '', available: false, reason: '加载失败', patch: '', files: [] };
  } finally {
    loading.value = false;
  }
}

watch(() => [props.modelValue, props.nodeId] as const, ([open]) => {
  if (open) void load();
});
</script>

<style scoped>
.state { color: var(--ct-text3); text-align: center; padding: 32px 0; font-size: 12px; }
.files { display: flex; flex-direction: column; margin-bottom: 8px; border: 1px solid var(--ct-border); border-radius: 6px; overflow: hidden; max-height: 180px; overflow-y: auto; }
.file-row { display: flex; align-items: center; gap: 10px; padding: 6px 12px; font-size: 11px; border-bottom: 1px solid var(--ct-border); background: var(--ct-panel2); border-left: none; border-right: none; border-top: none; cursor: pointer; width: 100%; text-align: left; }
.file-row:hover { background: var(--ct-bg); }
.file-row:last-child { border-bottom: none; }
.f-path { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--ct-text2); }
.f-ins { color: var(--ct-green); }
.f-del { color: var(--ct-red); }
.toolbar { display: flex; align-items: center; justify-content: space-between; margin-bottom: 6px; }
.stat { font-size: 11px; color: var(--ct-text3); }
.patch-wrap { max-height: 56vh; overflow: auto; background: var(--ct-bg); border: 1px solid var(--ct-border); border-radius: 6px; font-size: 11px; line-height: 1.5; }
.file-block { border-bottom: 1px solid var(--ct-border); }
.file-block:last-child { border-bottom: none; }
.fb-head { position: sticky; top: 0; z-index: 1; display: flex; align-items: center; gap: 10px; padding: 5px 12px; background: var(--ct-panel2); border-bottom: 1px solid var(--ct-border); }
.fb-path { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--ct-text); font-weight: 600; }
.fb-copy { border: 1px solid var(--ct-border); background: transparent; color: var(--ct-accent); font-size: 10px; padding: 1px 8px; border-radius: 3px; cursor: pointer; }
.fb-copy:hover { background: var(--ct-bg); }
.row { display: flex; align-items: baseline; min-width: 0; }
.row.add { background: rgba(63, 185, 80, 0.12); }
.row.del { background: rgba(229, 83, 75, 0.10); }
.row.hunk { color: var(--ct-accent); background: rgba(74, 141, 255, 0.08); }
.row.meta { color: var(--ct-text3); }
.no { flex: 0 0 38px; text-align: right; padding: 0 6px; color: var(--ct-text3); opacity: 0.7; user-select: none; font-size: 10px; }
.sign { flex: 0 0 14px; text-align: center; }
.row.add .sign { color: var(--ct-green); }
.row.del .sign { color: var(--ct-red); }
.code { flex: 1; min-width: 0; white-space: pre; color: var(--ct-text2); padding-right: 12px; }
.row.add .code { color: var(--ct-green); }
.row.del .code { color: var(--ct-red); }
</style>
