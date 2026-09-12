<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { showToast } from 'vant';
import { api } from '../api';
import type { ProjectSummary } from '../api';
import { useDiscussion } from '../composables/useDiscussion';

defineOptions({ name: 'DiscussionListView' });

const router = useRouter();
const { list, loadList, create } = useDiscussion();

const loading = ref(true);
const agentNames = ref<string[]>([]);
const projects = ref<ProjectSummary[]>([]);
const showProjectPicker = ref(false);
const pendingCount = computed(() => list.value.filter((d) => d.pending_user).length);

async function loadMeta() {
  try {
    agentNames.value = await api.listAgents();
  } catch { /* ignore */ }
  try {
    projects.value = (await api.listProjects()).projects || [];
  } catch { /* ignore */ }
}

onMounted(async () => {
  await Promise.all([loadList(), loadMeta()]);
  loading.value = false;
});

function statusLabel(s: string): string {
  return ({ discussing: '讨论中', converged: '方案已生成', converted: '已转项目' } as Record<string, string>)[s] || s;
}

function shortTime(ts?: string): string {
  if (!ts) return '';
  const diff = Date.now() - new Date(ts.replace(' ', 'T')).getTime();
  if (diff < 60_000) return '刚刚';
  if (diff < 3600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86400_000) return `${Math.floor(diff / 3600_000)} 小时前`;
  return ts.slice(5, 10);
}

function open(d: { id: string }) {
  router.push(`/discussion/${d.id}`);
}

// ---------- 发起讨论 ----------

const showCreate = ref(false);
const creating = ref(false);
const form = ref({ title: '', topic: '', members: [] as string[], mode: 'manual' as 'manual' | 'auto', project_id: '' });

function openCreate() {
  form.value = { title: '', topic: '', members: agentNames.value.slice(0, 3), mode: 'manual', project_id: '' };
  showCreate.value = true;
}

async function doCreate() {
  if (!form.value.title.trim()) { showToast('填写讨论话题'); return; }
  if (!form.value.members.length) { showToast('至少选择一位成员'); return; }
  creating.value = true;
  try {
    const d = await create({
      title: form.value.title.trim(),
      topic: form.value.topic.trim() || undefined,
      members: form.value.members,
      mode: form.value.mode,
      project_id: form.value.project_id || undefined,
    });
    showCreate.value = false;
    router.push(`/discussion/${d.id}`);
  } catch (e: any) {
    showToast(String(e?.message || e));
  } finally {
    creating.value = false;
  }
}
</script>

<template>
  <div class="discuss-list">
    <div class="page-head">
      <div class="ph-row">
        <div>
          <div class="ph-title">群组沟通</div>
          <div class="ph-sub" v-if="pendingCount">{{ pendingCount }} 个讨论等你拍板</div>
          <div class="ph-sub" v-else>讨论 → 方案 → 项目开发，经验自动沉淀</div>
        </div>
        <van-button round type="primary" size="small" @click="openCreate">发起讨论</van-button>
      </div>
    </div>

    <van-empty v-if="!loading && !list.length" description="还没有讨论，点右下角发起第一场">
      <van-button round type="primary" size="small" @click="openCreate">发起讨论</van-button>
    </van-empty>

    <van-cell
      v-for="d in list"
      :key="d.id"
      :title="d.title"
      :label="`${d.members.length} 成员 · ${d.message_count || 0} 条 · ${shortTime(d.updated_at)}`"
      is-link
      @click="open(d)"
    >
      <template #value>
        <span :class="['st', d.status]">{{ statusLabel(d.status) }}</span>
        <van-tag v-if="d.pending_user" type="warning" class="pend-tag">待拍板</van-tag>
      </template>
    </van-cell>

    <van-popup v-model:show="showCreate" position="bottom" round :style="{ maxHeight: '82%' }">
      <div class="sheet">
        <div class="sheet-title">发起群组讨论</div>
        <van-field v-model="form.title" label="话题" placeholder="一句话概括想规划什么" />
        <van-field v-model="form.topic" label="背景" type="textarea" rows="2" autosize placeholder="可选：目标用户、约束、偏好技术" />
        <van-field label="成员" input-align="left">
          <template #input>
            <div class="mem-picker">
              <span
                v-for="a in agentNames"
                :key="a"
                :class="['mem-chip', { on: form.members.includes(a) }]"
                @click="form.members.includes(a) ? form.members.splice(form.members.indexOf(a), 1) : form.members.push(a)"
              >@{{ a }}</span>
            </div>
          </template>
        </van-field>
        <van-field label="模式">
          <template #input>
            <van-radio-group v-model="form.mode" direction="horizontal">
              <van-radio name="manual">手动</van-radio>
              <van-radio name="auto">自动</van-radio>
            </van-radio-group>
          </template>
        </van-field>
        <van-field label="挂入项目" input-align="right" readonly is-link :model-value="projects.find(p => p.id === form.project_id)?.name || '可选'" @click="showProjectPicker = true" />
        <div class="sheet-ops">
          <van-button block round type="primary" :loading="creating" @click="doCreate">开始讨论</van-button>
        </div>
      </div>
    </van-popup>

    <van-popup v-model:show="showProjectPicker" position="bottom" round>
      <van-picker
        :columns="[{ text: '不挂入', value: '' }, ...projects.map((p) => ({ text: p.name, value: p.id }))]"
        @confirm="({ selectedValues }) => { form.project_id = String(selectedValues[0] || ''); showProjectPicker = false; }"
        @cancel="showProjectPicker = false"
      />
    </van-popup>
  </div>
</template>

<style scoped>
.page-head { padding: 14px 16px 6px; }
.ph-row { display: flex; justify-content: space-between; align-items: center; gap: 10px; }
.ph-title { font-size: 18px; font-weight: 700; }
.ph-sub { font-size: 11px; color: var(--text-3); margin-top: 2px; }
.st { font-size: 11px; color: var(--text-3); }
.st.converged { color: var(--yellow); }
.st.converted { color: var(--green); }
.pend-tag { margin-left: 6px; }
.sheet { padding: 16px; }
.sheet-title { font-size: 16px; font-weight: 700; margin-bottom: 8px; }
.sheet-ops { margin-top: 16px; }
.mem-picker { display: flex; flex-wrap: wrap; gap: 6px; padding: 4px 0; }
.mem-chip { font-size: 12px; padding: 3px 10px; border-radius: 12px; border: 1px solid var(--border); color: var(--text-2); background: var(--panel-2); }
.mem-chip.on { border-color: var(--accent); color: var(--accent); background: var(--accent-soft); }
</style>
