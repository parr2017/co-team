<template>
  <div class="md" v-html="html" @click="onClick"></div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { renderMarkdown, tryCopyCode } from '../utils/md';

const props = defineProps<{ source: string }>();
const html = computed(() => renderMarkdown(props.source));
function onClick(e: MouseEvent) {
  tryCopyCode(e);
}
</script>
