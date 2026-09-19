<template>
  <div class="page">
    <van-nav-bar title="协作会话" fixed placeholder>
      <template #right>
        <van-icon name="plus" size="18" @click="newDlg = true" />
      </template>
    </van-nav-bar>

    <van-search v-model="search" placeholder="搜索会话"  />

    <van-pull-refresh :model-value="refreshing" @refresh="onRefresh">
      <div class="groups">
        <template v-for="g in grouped" :key="g.name">
          <div class="group-label">{{ g.name }}</div>
          <div v-for="c in g.items" :key="c.id" class="conv-card" @click="router.push(`/convo/${c.id}`)">
            <div class="t">
              <span class="dot" :class="c.status" />
              <span class="title">{{ c.title }}</span>
            </div>
            <div class="m">
              <span class="mono">{{ c.model_id || '自动选模' }}</span>
              <span class="st">{{ STATUS_LABEL[c.status] || c.status }}</span>
              <span v-if="c.status !== 'idle'" class="st accent">{{ c.status === 'running' ? '·' : '' }}</span>
              <span class="sp" />
              <span>{{ relTime(c.updated_at) }}</span>
            </div>
          </div>
        </template>
        <van-empty v-if="!grouped.length" description="还没有会话，点右上角新建" />
      </div>
    </van-pull-refresh>

    <!-- 新建会话 -->
    <van-popup v-model:show="newDlg" position="bottom" round :style="{ maxHeight: '80%' }">
      <div class="sheet">
        <div class="sh">新建协作会话</div>
        <div class="frow">
          <label>项目</label>
          <select v-model="form.project_id">
            <option value="" disabled>选择项目（决定工作区）</option>
            <option v-for="p in projects" :key="p.id" :value="p.id">{{ p.name }}</option>
          </select>
        </div>
        <div class="frow">
          <label>标题（留空自动生成）</label>
          <input v-model="form.title" placeholder="例如：修复登录页遮挡" maxlength="120" />
        </div>
        <div class="frow">
          <label>主模型</label>
          <select v-model="form.model_id">
            <option value="">自动选模</option>
            <option v-for="m in models" :key="m.id" :value="m.id">{{ m.name }}{{ m.provider ? " · " + m.provider : "" }}</option>
          </select>
        </div>
        <div class="frow">
          <label>人设</label>
          <select v-model="form.agent_id">
            <option v-for="a in agents" :key="a.name" :value="a.name">{{ a.name }}{{ a.role ? ' · ' + a.role : '' }}</option>
          </select>
        </div>
        <div class="btnrow">
          <button class="btn-g" @click="newDlg = false">取消</button>
          <button class="btn-p" :disabled="creating" @click="create">创建</button>
        </div>
      </div>
    </van-popup>
  </div>
</template>

<script setup lang="ts">
import { computed, onActivated, onMounted, reactive, ref } from 'vue';
import { useRouter } from 'vue-router';
import { showFailToast } from 'vant';
import { api, type ConvoSummary } from '../api';

const router = useRouter();
const STATUS_LABEL: Record<string, string> = { idle: '空闲', running: '运行中', waiting_approval: '待审批', waiting_ask: '待回答' };

const convos = ref<ConvoSummary[]>([]);
const projects = ref<{ id: string; name: string }[]>([]);
const agents = ref<{ name: string; role?: string }[]>([]);
const models = ref<{ id: string; name: string; provider?: string }[]>([]);
const search = ref('');
const refreshing = ref(false);
const newDlg = ref(false);
const creating = ref(false);
const form = reactive({ project_id: '', title: '', model_id: '', agent_id: 'partner' });

const grouped = computed(() => {
  const q = search.value.trim().toLowerCase();
  const map = new Map<string, ConvoSummary[]>();
  for (const c of convos.value) {
    if (q && !c.title.toLowerCase().includes(q)) continue;
    const name = projects.value.find((p) => p.id === c.project_id)?.name || '未绑定项目';
    if (!map.has(name)) map.set(name, []);
    map.get(name)!.push(c);
  }
  return [...map.entries()].map(([name, items]) => ({ name, items }));
});

function relTime(ts: string): string {
  const d = Date.now() - new Date(ts).getTime();
  if (d < 60_000) return '刚刚';
  if (d < 3600_000) return `${Math.floor(d / 60_000)}分钟前`;
  if (d < 86400_000) return `${Math.floor(d / 3600_000)}小时前`;
  return `${Math.floor(d / 86400_000)}天前`;
}

async function load() {
  const [r, p, ag, mp] = await Promise.allSettled([
    api.convoList(),
    api.listProjects(),
    api.listAgentInfos(),
    api.getModelPool(),
  ]);
  // 各自容错：列表/项目/人设/模型任一失败不拖垮其余（新建弹窗的项目下拉必须可用）
  if (r.status === 'fulfilled') convos.value = r.value.convos;
  else showFailToast(`会话列表加载失败：${(r.reason as Error)?.message || r.reason}`);
  if (p.status === 'fulfilled') projects.value = (p.value as any).projects || [];
  if (ag.status === 'fulfilled') {
    agents.value = ((ag.value as any).agents as { name: string; role?: string }[]) || [];
    if (!agents.value.some((a) => a.name === 'partner')) agents.value.unshift({ name: 'partner', role: '协作工程师' });
  }
  if (mp.status === 'fulfilled') models.value = (mp.value as any).model_pool || [];
}

async function onRefresh() {
  refreshing.value = true;
  await load();
  refreshing.value = false;
}

async function create() {
  if (!form.project_id) {
    showFailToast('请选择项目');
    return;
  }
  creating.value = true;
  try {
    const r = await api.convoCreate({ ...form, model_id: form.model_id || undefined, title: form.title || undefined });
    newDlg.value = false;
    form.title = '';
    await load();
    router.push(`/convo/${r.convo.id}`);
  } catch (e: any) {
    showFailToast(e.message);
  } finally {
    creating.value = false;
  }
}

onMounted(load);
onActivated(load);
</script>

<style scoped>
.page { min-height: 100vh; padding-bottom: 70px; }
.groups { padding: 10px 12px; display: flex; flex-direction: column; gap: 8px; }
.group-label { font-size: 11px; color: var(--text-3); padding: 4px 2px; }
.conv-card { background: var(--bg-panel); border: 1px solid var(--line); border-radius: 10px; padding: 11px 13px; display: flex; flex-direction: column; gap: 4px; }
.conv-card:active { border-color: var(--accent); }
.conv-card .t { display: flex; align-items: center; gap: 7px; font-size: 13px; font-weight: 600; }
.conv-card .title { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.conv-card .m { display: flex; gap: 7px; align-items: center; font-size: 11px; color: var(--text-3); }
.conv-card .sp { flex: 1; }
.dot { width: 6px; height: 6px; border-radius: 50%; background: var(--text-3); flex: none; }
.dot.run { background: var(--ok); }
.dot.waiting_approval, .dot.waiting_ask { background: var(--warn); }
.st.accent { color: var(--accent); }
.sheet { padding: 12px 16px 18px; }
.sh { text-align: center; font-size: 13px; color: var(--text-2); padding-bottom: 8px; }
.frow { display: flex; flex-direction: column; gap: 4px; margin-bottom: 10px; }
.frow label { font-size: 11px; color: var(--text-3); }
.frow input, .frow select { padding: 8px 10px; border-radius: 6px; border: 1px solid var(--line-strong); background: var(--bg-inset); color: var(--text-1); font-size: 13px; outline: none; }
.btnrow { display: flex; gap: 8px; margin-top: 6px; }
.btnrow button { flex: 1; padding: 10px; border-radius: 8px; font-size: 13px; }
.btn-g { border: 1px solid var(--line-strong); background: none; color: var(--text-2); }
.btn-p { border: none; background: var(--accent); color: var(--accent-text); }
</style>
