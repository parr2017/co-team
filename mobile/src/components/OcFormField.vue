<template>
  <div class="ocf">
    <div class="ocf-label">
      <span :class="{ miss: showErrors && missing }">{{ displayLabel }}</span>
      <span v-if="isRecommended" class="rec">推荐</span>
      <span v-if="field.required" class="req">必填</span>
      <span v-if="showErrors && missing" class="req err">未作答</span>
    </div>
    <div v-if="field.description" class="ocf-desc">{{ field.description }}</div>

    <!-- 单选 / 多选 -->
    <div v-if="hasOptions" class="ocf-opts">
      <button
        v-for="o in field.options"
        :key="o.value"
        type="button"
        class="ocf-opt"
        :class="{ on: isSelected(o.value) }"
        :disabled="disabled"
        @click="toggleOption(o.value)"
      >
        <span class="omain">
          <span class="orow">
            <i class="tick" :class="[field.multiple ? 'multi' : 'single', { on: isSelected(o.value) }]" />
            <span class="olabel">{{ displayOptionLabel(o.label) }}</span>
            <span v-if="isRecommendedOption(o.label)" class="rec">推荐</span>
          </span>
          <span v-if="o.description" class="odesc">{{ o.description }}</span>
        </span>
      </button>
      <div v-if="field.custom" class="ocf-other">
        <button type="button" class="ocf-opt other" :class="{ on: value.custom }" :disabled="disabled" @click="toggleCustom">
          <span class="orow">
            <i class="tick edit" :class="{ on: value.custom }">✎</i>
            <span class="olabel">其他（自行填写）</span>
          </span>
        </button>
        <input
          v-if="value.custom"
          :value="value.text"
          class="ocf-custom"
          :placeholder="field.placeholder || '输入你的回答'"
          :disabled="disabled"
          @input="emit('update', { text: ($event.target as HTMLInputElement).value })"
          @keydown.enter="onEnter"
        />
      </div>
    </div>

    <!-- 自由输入 -->
    <input
      v-else-if="field.type === 'input'"
      :value="value.text"
      class="ocf-text"
      :placeholder="field.placeholder || '输入你的回答'"
      :disabled="disabled"
      @input="emit('update', { text: ($event.target as HTMLInputElement).value })"
      @keydown.enter="onEnter"
    />

    <!-- 数字 -->
    <input
      v-else-if="field.type === 'number'"
      :value="value.num === null ? '' : String(value.num)"
      class="ocf-text"
      type="number"
      inputmode="decimal"
      :min="field.minimum"
      :max="field.maximum"
      :placeholder="field.placeholder || '输入数字'"
      :disabled="disabled"
      @input="emit('update', { num: ($event.target as HTMLInputElement).value === '' ? null : Number(($event.target as HTMLInputElement).value) })"
      @keydown.enter="onEnter"
    />

    <!-- 布尔 -->
    <button
      v-else-if="field.type === 'boolean'"
      type="button"
      class="ocf-bool"
      :class="{ on: value.bool }"
      :disabled="disabled"
      @click="emit('update', { bool: !value.bool })"
    >
      <i class="tick multi" :class="{ on: value.bool }" />{{ value.bool ? '是' : '否' }}
    </button>

    <!-- 外部链接：打开即确认 -->
    <div v-else-if="field.type === 'external'" class="ocf-ext">
      <a :href="field.externalUrl || '#'" target="_blank" rel="noreferrer noopener" @click="emit('update', { ack: true })">
        打开链接查看（打开即视为确认）↗
      </a>
      <span v-if="value.ack" class="rec ok">已确认</span>
    </div>
  </div>
</template>

<script setup lang="ts">
/**
 * OpenCode 提问表单的单字段控件（mobile 端；与 web OcFormField 同构行为）：
 * 单选 radio / 多选 checkbox（"其他"自由输入与勾选共存）/ 自由输入 / 数字（min-max）/
 * 布尔 / 外部链接（打开即确认）。recommended 标记转徽章；Enter 提交带 IME 防护。
 * 状态机与提交值收口在 @co-team/opencode-sync/form。
 */
import { computed } from 'vue';
import { isRecommendedOption, stripRecommendedMarker, type FormFieldView, type FormFieldValue } from '@co-team/opencode-sync';

const props = defineProps<{
  field: FormFieldView;
  value: FormFieldValue;
  disabled?: boolean;
  showErrors?: boolean;
  /** 本字段是否在必填缺失名单里 */
  missing?: boolean;
}>();

const emit = defineEmits<{
  (e: 'update', patch: Partial<FormFieldValue>): void;
  (e: 'submit'): void;
}>();

const hasOptions = computed(() => (props.field.type === 'select' || props.field.type === 'multiselect') && !!props.field.options?.length);
const displayLabel = computed(() => stripRecommendedMarker(props.field.question || props.field.key));
const isRecommended = computed(() => isRecommendedOption(props.field.question));
const displayOptionLabel = (label: string) => stripRecommendedMarker(label);

function isSelected(v: string): boolean {
  return !props.value.custom && props.value.selected.includes(v);
}

function toggleOption(v: string): void {
  if (props.disabled) return;
  if (props.field.multiple) {
    const next = props.value.selected.includes(v)
      ? props.value.selected.filter((x) => x !== v)
      : [...props.value.selected, v];
    emit('update', { selected: next, custom: false });
  } else {
    emit('update', { selected: [v], custom: false });
  }
}

function toggleCustom(): void {
  if (props.disabled) return;
  // 单选切到"其他"清空勾选；多选保留勾选（文本并入答案尾部）
  emit('update', { custom: !props.value.custom, selected: props.field.multiple ? props.value.selected : [] });
}

function onEnter(e: KeyboardEvent): void {
  // IME 组合输入（拼音选词）的 Enter 不算提交
  if (e.isComposing || e.keyCode === 229) return;
  e.preventDefault();
  emit('submit');
}
</script>

<style scoped>
.ocf { padding: 3px 0; }
.ocf-label { display: flex; align-items: center; gap: 6px; font-size: 12.5px; font-weight: 600; color: var(--text-1); flex-wrap: wrap; }
.ocf-label .miss { color: var(--danger); }
.ocf-label .req { font-size: 10px; font-weight: 400; color: var(--text-3); }
.ocf-label .req.err { color: var(--danger); }
.ocf .rec { font-size: 10px; color: var(--accent); background: color-mix(in srgb, var(--accent) 10%, transparent); border-radius: 3px; padding: 0 5px; }
.ocf .rec.ok { color: var(--ok, #2e9e5b); background: color-mix(in srgb, var(--ok, #2e9e5b) 10%, transparent); }
.ocf-desc { font-size: 11px; color: var(--text-3); margin: 2px 0; line-height: 1.45; }
.ocf-opts { display: flex; flex-direction: column; gap: 3px; margin-top: 3px; }
.ocf-opt { display: flex; align-items: flex-start; gap: 7px; width: 100%; text-align: left; border: none; background: var(--bg-inset); padding: 6px 8px; border-radius: 7px; cursor: pointer; font-size: 12.5px; color: var(--text-1); }
.ocf-opt.on { background: color-mix(in srgb, var(--accent) 14%, var(--bg-inset)); }
.ocf-opt:disabled { opacity: 0.6; }
.ocf-opt .omain { display: flex; flex-direction: column; gap: 1px; min-width: 0; }
.ocf-opt .orow { display: flex; align-items: center; gap: 6px; }
.ocf-opt .olabel { min-width: 0; word-break: break-all; }
.ocf-opt .odesc { font-size: 11px; color: var(--text-3); }
.ocf-opt .tick { flex: none; margin-top: 2px; width: 13px; height: 13px; border-radius: 50%; border: 1.5px solid var(--line-strong); display: inline-flex; align-items: center; justify-content: center; font-size: 10px; font-style: normal; }
.ocf-opt .tick.multi { border-radius: 3px; }
.ocf-opt .tick.on { background: var(--accent); border-color: var(--accent); }
.ocf-opt .tick.on::after { content: ''; width: 5px; height: 5px; border-radius: inherit; background: var(--accent-text); }
.ocf-opt .tick.edit { border: none; color: var(--text-3); }
.ocf-opt .tick.edit.on { background: none; color: var(--accent); }
.ocf-opt .tick.edit.on::after { content: none; }
.ocf-other { border-left: 2px solid var(--line); padding-left: 8px; margin: 2px 0 2px 6px; }
.ocf-custom, .ocf-text { margin-top: 4px; width: 100%; background: var(--bg-overlay); border: 1px solid var(--border); border-radius: 4px; font-size: 13px; padding: 6px 8px; outline: none; color: var(--text-1); }
.ocf-bool { margin-top: 4px; display: inline-flex; align-items: center; gap: 6px; padding: 6px 10px; border-radius: 7px; border: 1px solid var(--line-strong); background: var(--bg-inset); font-size: 12.5px; color: var(--text-1); }
.ocf-bool.on { border-color: var(--accent); color: var(--accent); }
.ocf-ext { margin-top: 4px; display: flex; align-items: center; gap: 8px; font-size: 12px; flex-wrap: wrap; }
.ocf-ext a { color: var(--accent); word-break: break-all; }
</style>
