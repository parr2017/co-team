<template>
  <el-drawer v-model="visible" :title="`项目规划方案 · v${disc?.scheme_version || 0}`" size="640px">
    <div v-if="!disc?.scheme" class="empty mono">
      方案尚未生成。先在群里讨论，再点「生成方案」由主持人收敛各成员观点与用户指示。
    </div>
    <template v-else>
      <div v-if="!editing" class="scheme-md md" v-html="md(disc.scheme)"></div>
      <el-input v-else v-model="buffer" type="textarea" :rows="24" resize="none" class="mono" />
    </template>
    <template #footer>
      <div class="foot">
        <el-button size="small" :disabled="!disc?.scheme" @click="editing ? cancel() : (buffer = disc!.scheme, editing = true)">
          {{ editing ? '取消编辑' : '人工编辑' }}
        </el-button>
        <template v-if="editing">
          <el-button size="small" type="primary" @click="save">保存（版本 +1）</el-button>
        </template>
        <template v-else>
          <el-button size="small" :loading="regen" :disabled="!disc" @click="regenerate">重新生成</el-button>
          <el-button size="small" :disabled="!disc?.scheme" @click="copy">复制 Markdown</el-button>
        </template>
      </div>
    </template>
  </el-drawer>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue';
import { ElMessage } from 'element-plus';
import { marked } from 'marked';
import { useDiscussion } from '../composables/useDiscussion';

const props = defineProps<{ modelValue: boolean }>();
const emit = defineEmits<{ (e: 'update:modelValue', v: boolean): void }>();

const { current, generateScheme, saveScheme } = useDiscussion();
const visible = computed({ get: () => props.modelValue, set: (v) => emit('update:modelValue', v) });
const disc = computed(() => current.value);
const editing = ref(false);
const buffer = ref('');
const regen = ref(false);

function md(text: string): string {
  const escaped = (text || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return String(marked.parse(escaped, { async: false, breaks: true }));
}

async function save() {
  try {
    await saveScheme(buffer.value.trim());
    editing.value = false;
    ElMessage.success('方案已保存为新版本');
  } catch (e: any) {
    ElMessage.error(String(e?.message || e));
  }
}

async function cancel() {
  editing.value = false;
}

async function regenerate() {
  regen.value = true;
  try {
    await generateScheme();
    ElMessage.success('方案已重新生成');
  } catch (e: any) {
    ElMessage.error(String(e?.message || e));
  } finally {
    regen.value = false;
  }
}

function copy() {
  void navigator.clipboard?.writeText(disc.value?.scheme || '');
  ElMessage.success('已复制');
}
</script>

<style scoped>
.empty { color: var(--ct-text3); font-size: 12px; padding: 30px 10px; text-align: center; }
.scheme-md { line-height: 1.7; font-size: 13px; }
.scheme-md :deep(h1) { font-size: 17px; margin: 4px 0 12px; }
.scheme-md :deep(h2) { font-size: 14px; margin: 16px 0 6px; border-bottom: 1px solid var(--ct-border); padding-bottom: 4px; }
.scheme-md :deep(table) { border-collapse: collapse; margin: 8px 0; }
.scheme-md :deep(th), .scheme-md :deep(td) { border: 1px solid var(--ct-border); padding: 4px 10px; font-size: 12px; }
.scheme-md :deep(code) { font-family: var(--ct-mono); font-size: 11px; background: var(--ct-panel2); border-radius: 3px; padding: 0 4px; }
.foot { display: flex; gap: 8px; justify-content: flex-end; }
</style>
