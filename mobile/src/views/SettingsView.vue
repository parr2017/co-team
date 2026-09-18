<template>
  <div class="settings-page">
    <van-nav-bar title="设置" left-arrow @click-left="$router.back()" />

    <div class="section">
      <div class="section-title">命令权限</div>
      <div class="section-desc">所有新任务的缺省命令执行策略；高危命令任何级别都强制人工审批，越界路径一律拒绝。</div>

      <van-cell-group inset>
        <van-cell title="默认权限级别" :value="levelLabel" is-link @click="showLevelPicker = true" />
        <van-field
          v-model="cmdDraft"
          label="白名单命令"
          placeholder="输入命令回车添加"
          input-align="right"
          @keydown.enter.prevent="addCmd"
        >
          <template #button>
            <van-button size="small" type="primary" plain @click="addCmd">添加</van-button>
          </template>
        </van-field>
        <div class="whitelist">
          <span v-for="(cmd, i) in whitelist" :key="cmd + i" class="cmd-tag mono" @click="whitelist.splice(i, 1)">{{ cmd }} ×</span>
          <span v-if="!whitelist.length" class="empty">白名单为空——「白名单自动」级别下所有命令都将待审批</span>
        </div>
      </van-cell-group>

      <div class="save-bar">
        <van-button class="save-btn" plain :loading="saving" @click="save">保存并生效</van-button>
      </div>
    </div>

    <van-popup v-model:show="showLevelPicker" round position="bottom">
      <van-picker
        :columns="levelColumns"
        @confirm="onLevelPicked"
        @cancel="showLevelPicker = false"
      />
    </van-popup>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue';
import { showSuccessToast, showFailToast } from 'vant';
import { api } from '../api';

const LEVEL_LABELS: Record<string, string> = {
  plan_only: '只出方案',
  readonly: '只读',
  approve_required: '改动需审批',
  whitelist_auto: '白名单自动',
  full: '目录内完全控制',
};

const level = ref('approve_required');
const whitelist = ref<string[]>([]);
const cmdDraft = ref('');
const saving = ref(false);
const showLevelPicker = ref(false);
const levelColumns = Object.entries(LEVEL_LABELS).map(([key, text]) => ({ text, value: key }));
const levelLabel = computed(() => LEVEL_LABELS[level.value] || level.value);

function addCmd() {
  const cmd = cmdDraft.value.trim().split(/\s+/)[0];
  if (cmd && !whitelist.value.includes(cmd)) whitelist.value.push(cmd);
  cmdDraft.value = '';
}

async function save() {
  saving.value = true;
  try {
    await api.savePermissions(level.value, whitelist.value);
    showSuccessToast('已保存并即时生效');
  } catch (e: any) {
    showFailToast(e?.message || '保存失败');
  } finally {
    saving.value = false;
  }
}

function onLevelPicked({ selectedOptions }: { selectedOptions: { value: string; text: string }[] }) {
  level.value = selectedOptions[0]?.value || level.value;
  showLevelPicker.value = false;
}

(async () => {
  try {
    const d = await api.getPermissions();
    level.value = d.permissions.level || 'approve_required';
    whitelist.value = d.permissions.whitelist_commands || [];
  } catch {
    /* 服务器不可达保持默认 */
  }
})();
</script>

<style scoped>
.settings-page { min-height: 100vh; background: var(--bg-page); padding-bottom: 60px; }
.section { margin-top: 12px; }
.section-title {
  font-size: var(--fs-meta); color: var(--text-3); font-family: var(--font-mono);
  letter-spacing: .08em; text-transform: uppercase; padding: 14px 14px 6px;
  display: flex; align-items: center; gap: 8px;
}
.section-title::after { content: ""; flex: 1; height: 1px; background: var(--line); }
.section-desc { font-size: var(--fs-meta); color: var(--text-3); padding: 2px 20px 8px; line-height: 1.5; }
.whitelist { display: flex; flex-wrap: wrap; gap: 6px; padding: 10px 16px; }
.cmd-tag { font-size: var(--fs-aux); color: var(--text-2); background: var(--bg-inset); border: 1px solid var(--line); border-radius: 4px; padding: 2px 8px; }
.whitelist .empty { font-size: var(--fs-meta); color: var(--text-3); }
.save-bar { display: flex; justify-content: center; margin-top: 16px; }
.mono { font-family: Consolas, monospace; }

.save-btn { width: 100%; height: 40px; border-radius: var(--r-ctl); background: var(--bg-raised); color: var(--text-1); border: 1px solid var(--line-strong); font-weight: 500; }
</style>
