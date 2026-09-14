<template>
  <div class="attach-picker">
    <el-tooltip content="发送图片（最多 3 张，单张 ≤10MB）" placement="top">
      <el-button class="clip-btn" text :disabled="disabled" @click="fileEl?.click()">📎</el-button>
    </el-tooltip>
    <input
      ref="fileEl"
      type="file"
      accept="image/png,image/jpeg,image/webp,image/gif,image/bmp"
      multiple
      hidden
      @change="onPick"
    />
    <div v-if="pending.length" class="strip">
      <div v-for="(img, i) in pending" :key="i" class="thumb">
        <img :src="img.dataUrl" :alt="img.name" @click="$emit('preview', img.dataUrl)" />
        <span class="del" :disabled="disabled" @click="remove(i)">×</span>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
/**
 * 聊天发图附件选择器（web）：📎 选图 + 待发缩略图条，客户端预检大小/数量/类型。
 * 与移动端 mobile/src/components/AttachPicker.vue 保持同一行为契约。
 */
import { ref } from 'vue';
import { ElMessage, ElTooltip, ElButton } from 'element-plus';

const props = defineProps<{ disabled?: boolean; max?: number; maxMb?: number }>();
const emit = defineEmits<{ (e: 'preview', url: string): void }>();

const MAX = 3;
const ACCEPT_MIME = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/bmp']);

const fileEl = ref<HTMLInputElement>();
/** v-model：待发图片（dataURL），父组件随消息一起 POST */
const pending = defineModel<{ name: string; dataUrl: string }[]>({ default: () => [] });

function remove(i: number) {
  if (props.disabled) return;
  pending.value = pending.value.filter((_, j) => j !== i);
}

async function onPick(e: Event) {
  const input = e.target as HTMLInputElement;
  const files = [...(input.files || [])];
  input.value = '';
  const max = props.max ?? MAX;
  const maxMb = props.maxMb ?? 10;
  for (const f of files) {
    if (pending.value.length >= max) { ElMessage.warning(`最多附 ${max} 张图`); break; }
    if (!ACCEPT_MIME.has(f.type)) { ElMessage.warning(`${f.name}：不支持的图片类型`); continue; }
    if (f.size > maxMb * 1024 * 1024) { ElMessage.warning(`${f.name} 超过 ${maxMb}MB，请压缩后再发`); continue; }
    try {
      const dataUrl = await new Promise<string>((resolve, reject) => {
        const r = new FileReader();
        r.onload = () => resolve(String(r.result));
        r.onerror = () => reject(new Error('read failed'));
        r.readAsDataURL(f);
      });
      pending.value = [...pending.value, { name: f.name, dataUrl }];
    } catch {
      ElMessage.error(`${f.name} 读取失败`);
    }
  }
}
</script>

<style scoped>
.attach-picker { display: inline-flex; align-items: flex-end; gap: 8px; }
.clip-btn { padding: 4px 6px; font-size: 16px; line-height: 1; }
.strip { display: flex; gap: 6px; align-items: center; }
.thumb { position: relative; width: 44px; height: 44px; border-radius: 6px; overflow: hidden; border: 1px solid var(--el-border-color); }
.thumb img { width: 100%; height: 100%; object-fit: cover; cursor: pointer; display: block; }
.del {
  position: absolute; top: -1px; right: -1px; width: 16px; height: 16px; line-height: 15px;
  text-align: center; border-radius: 0 0 0 6px; cursor: pointer; font-size: 12px;
  background: rgba(0, 0, 0, 0.55); color: #fff;
}
</style>
