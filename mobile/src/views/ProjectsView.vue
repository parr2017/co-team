<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { showToast } from 'vant';
import { api } from '../api';
import type { ProjectSummary } from '../api';
import DirPicker from '../components/DirPicker.vue';

defineOptions({ name: 'ProjectsView' });

const router = useRouter();
const projects = ref<ProjectSummary[]>([]);
const loading = ref(true);
const error = ref('');

async function load() {
  loading.value = true;
  error.value = '';
  try {
    const d = await api.listProjects();
    projects.value = d.projects || [];
  } catch (e: any) {
    error.value = e.message || '加载失败';
  } finally {
    loading.value = false;
  }
}

onMounted(() => void load());

function donePct(p: ProjectSummary): number {
  return p.task_count ? Math.round((p.done_count / p.task_count) * 100) : 0;
}

function open(p: ProjectSummary) {
  router.push(`/project/${p.id}`);
}

// ---------- 新建项目（POST /api/projects） ----------

const showCreate = ref(false);
const showDir = ref(false);
const creating = ref(false);
const projectsRootPath = ref('');
let wsTouched: boolean = false;
const form = ref({ name: '', workspace: '', description: '', allow_self_ref: false });

function prefillWorkspace() {
  if (wsTouched || !projectsRootPath.value) return;
  const slug = (form.value.name || '').trim().replace(/[\\/:*?"<>|\s]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'project';
  form.value.workspace = `${projectsRootPath.value.replace(/[\\/]$/, '')}\\${slug}`;
}
function markWorkspaceTouched() {
  wsTouched = true;
}

async function openCreate() {
  wsTouched = false;
  form.value = { name: '', workspace: '', description: '', allow_self_ref: false };
  showCreate.value = true;
  if (!projectsRootPath.value) {
    try { projectsRootPath.value = (await api.projectsRoot()).root; } catch { /* 拿不到就手填 */ }
  }
}

async function submitCreate() {
  if (!form.value.name.trim()) {
    showToast('请填写项目名称');
    return;
  }
  creating.value = true;
  try {
    await api.createProject({
      name: form.value.name.trim(),
      workspace: form.value.workspace.trim() || undefined,
      description: form.value.description.trim() || undefined,
      allow_self_ref: form.value.allow_self_ref || undefined,
    });
    showCreate.value = false;
    showToast('项目已创建');
    await load();
  } catch (e: any) {
    showToast(e.message || '创建失败');
  } finally {
    creating.value = false;
  }
}
</script>

<template>
  <div class="page">
    <van-nav-bar title="项目" fixed placeholder>
      <template #right>
        <van-icon name="plus" size="22" color="var(--green)" @click="openCreate" />
      </template>
    </van-nav-bar>

    <van-pull-refresh :model-value="false" class="pull-wrap" @refresh="load">
      <div class="pull">
      <van-loading v-if="loading" class="loading" vertical>加载中…</van-loading>

      <div v-else-if="error" class="err-state">
        <van-icon name="warning-o" size="48" color="var(--yellow)" />
        <div class="err-text">{{ error }}</div>
        <button class="wx-btn err-btn" @click="load">重新加载</button>
      </div>

      <div v-else-if="!projects.length" class="empty">
        <van-icon name="apps-o" size="52" color="var(--text-3)" />
        <div class="empty-title">暂无项目</div>
        <div class="empty-text">点右上角 + 创建第一个项目</div>
      </div>

      <template v-else>
        <div class="wx-caption">共 {{ projects.length }} 个项目</div>
        <div class="wx-group">
          <div
            v-for="p in projects"
            :key="p.id"
            class="wx-cell proj-cell"
            @click="open(p)"
          >
            <div class="p-icon" :class="{ running: p.running }">
              <span class="p-initial">{{ p.name.slice(0, 1) }}</span>
              <span v-if="p.running" class="p-dot"></span>
            </div>
            <div class="p-body">
              <div class="p-name">{{ p.name }}</div>
              <div class="p-sub">
                {{ p.task_count }} 个任务 · 完成 {{ p.done_count }}
                <template v-if="p.issues"> · {{ p.issues }} 问题</template>
              </div>
              <div class="p-prog">
                <div class="p-track"><div class="p-fill" :style="{ width: donePct(p) + '%' }"></div></div>
                <span class="p-pct">{{ donePct(p) }}%</span>
              </div>
            </div>
            <van-icon name="arrow" size="14" color="#b2b2b2" />
          </div>
        </div>
        <div class="wx-caption hint">监控进度与下发任务；项目初始化（脚手架/git）由服务端自动完成</div>
      </template>
      </div>
    </van-pull-refresh>

    <van-popup v-model:show="showCreate" position="bottom" round class="create-pop" :style="{ background: 'var(--panel)' }">
      <div class="create-head">新建项目</div>
      <van-field v-model="form.name" label="名称" placeholder="如 accountapp" class="create-field" @update:model-value="prefillWorkspace" />
      <van-field v-model="form.workspace" label="工作区" placeholder="留空 = 项目根目录下自动建独立目录" class="create-field" @update:model-value="markWorkspaceTouched">
        <template #button><span class="pick-dir" @click="showDir = true">选择</span></template>
      </van-field>
      <div v-if="projectsRootPath" class="ws-hint">项目根：{{ projectsRootPath }}（独立目录+独立仓库，任务操作仅限该目录）</div>
      <van-field label="自指任务" class="create-field">
        <template #input>
          <van-switch v-model="form.allow_self_ref" size="18" />
          <span class="self-ref-hint">允许工作区在 co-team 内（隔离克隆执行）</span>
        </template>
      </van-field>
      <van-field v-model="form.description" label="描述" type="textarea" rows="2" autosize placeholder="一句话说明项目用途（可选）" class="create-field" />
      <div class="create-actions">
        <van-button size="small" plain @click="showCreate = false">取消</van-button>
        <van-button size="small" type="primary" :loading="creating" @click="submitCreate">创建</van-button>
      </div>
    </van-popup>

    <DirPicker v-model:show="showDir" title="选择工作区目录" @pick="form.workspace = $event" />
  </div>
</template>

<style scoped>
.ws-hint { font-size: 10px; color: var(--text-3); padding: 2px 16px 8px; }
.self-ref-hint { font-size: 11px; color: var(--text-3); margin-left: 8px; }
.page { height: 100%; display: flex; flex-direction: column; background: var(--bg); }
.pull-wrap { flex: 1; min-height: 0; overflow: hidden; }
.pull { height: 100%; overflow-y: auto; -webkit-overflow-scrolling: touch; }
.loading { margin: 60px auto; }

.proj-cell { padding: 15px 16px; }
.proj-cell:active { background: var(--panel-2); }

.p-icon {
  position: relative; width: 46px; height: 46px; border-radius: 11px;
  background: linear-gradient(145deg, var(--accent), var(--accent));
  color: #04121d; display: flex; align-items: center; justify-content: center;
  font-size: 19px; font-weight: 800; flex-shrink: 0;
  border: 1px solid rgba(255, 255, 255, 0.18);
  box-shadow: 0 0 14px rgba(34, 211, 238, 0.3);
  overflow: visible;
}
.p-icon.running {
  background: linear-gradient(145deg, var(--yellow), var(--yellow));
  
}
.p-dot {
  position: absolute; top: -2px; right: -2px; width: 10px; height: 10px;
  border-radius: 50%; background: var(--red);
  
  animation: wx-pulse 1.6s ease-in-out infinite;
}
.p-body { flex: 1; min-width: 0; }
.p-name { font-size: 16.5px; font-weight: 600; color: var(--text); margin-bottom: 4px; }
.p-sub { font-size: 12.5px; color: var(--text-2); margin-bottom: 7px; }
.p-prog { display: flex; align-items: center; gap: 8px; }
.p-track { flex: 1; height: 5px; border-radius: 3px; background: var(--panel-2); overflow: hidden; }
.p-fill { height: 100%; border-radius: 3px; background: linear-gradient(90deg, var(--accent), #0369a1); box-shadow: 0 0 8px rgba(34, 211, 238, 0.45); transition: width 0.5s ease; }
.p-pct { font-size: 12px; font-weight: 600; color: var(--text-2); width: 36px; text-align: right; }

.empty { display: flex; flex-direction: column; align-items: center; gap: 6px; padding: 72px 0; }
.empty-title { font-size: 16px; color: var(--text-2); font-weight: 600; margin-top: 6px; }
.empty-text { font-size: 13px; color: var(--text-3); text-align: center; line-height: 1.6; }
.err-state { display: flex; flex-direction: column; align-items: center; gap: 8px; padding: 72px 0; }
.err-text { font-size: 14px; color: var(--text-2); }
.err-btn { margin-top: 12px; max-width: 180px; }
.hint { text-align: center; padding-bottom: 16px; }

.create-head { padding: 16px 16px 6px; font-size: 16px; font-weight: 600; color: var(--text); }
.create-field { background: transparent; }
.pick-dir { font-size: 13px; color: var(--accent); padding: 2px 8px; border: 1px solid var(--panel-2); border-radius: 4px; background: var(--panel-2); }
.create-actions { display: flex; justify-content: flex-end; gap: 10px; padding: 12px 16px calc(16px + env(safe-area-inset-bottom)); }
</style>
