<template>
  <el-dialog v-model="visible" title="方案转项目开发" width="520px">
    <el-form label-width="96px" size="small">
      <el-form-item label="项目归属">
        <el-radio-group v-model="target">
          <el-radio value="new">新建项目</el-radio>
          <el-radio value="existing">挂入已有项目</el-radio>
        </el-radio-group>
      </el-form-item>

      <template v-if="target === 'new'">
        <el-form-item label="项目名称">
          <el-input v-model="name" :placeholder="disc?.title || '例如：会员系统'" />
        </el-form-item>
        <el-form-item label="工作区路径">
          <el-input v-model="workspace" placeholder="绝对路径，例如 D:\projects\member-system" style="width: 100%">
            <template #append>
              <el-button @click="dirPickerVisible = true">选择目录</el-button>
            </template>
          </el-input>
        </el-form-item>
        <el-form-item label="初始化">
          <el-checkbox v-model="scaffold">标准脚手架（docs/src/tests/config + 文档 + git）</el-checkbox>
        </el-form-item>
      </template>

      <el-form-item v-else label="已有项目">
        <el-select v-model="projectId" placeholder="选择项目" filterable style="width: 100%">
          <el-option v-for="p in projects" :key="p.id" :label="`${p.name}（${p.workspace}）`" :value="p.id" />
        </el-select>
      </el-form-item>

      <el-form-item label="执行方式">
        <el-checkbox v-model="autoRun">规划完成后直接进队列执行（不勾选则停留在「待审核」供你评审计划）</el-checkbox>
      </el-form-item>

      <el-alert type="info" :closable="false" show-icon>
        <template #title>讨论即澄清：任务不会再重复需求澄清；方案与讨论沉淀（知识库条目、项目记忆、待定事项）将随任务一并交付给执行团队。</template>
      </el-alert>
    </el-form>

    <template #footer>
      <el-button size="small" @click="visible = false">取消</el-button>
      <el-button size="small" type="primary" :loading="busy" @click="doConvert">转为项目开发</el-button>
    </template>

    <DirPickerDialog v-model:show="dirPickerVisible" :start-path="workspace" title="选择工作区目录" @pick="workspace = $event" />
  </el-dialog>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { ElMessage } from 'element-plus';
import { api, type ProjectSummary } from '../api';
import { useDiscussion } from '../composables/useDiscussion';
import DirPickerDialog from './DirPickerDialog.vue';

const props = defineProps<{ modelValue: boolean }>();
const emit = defineEmits<{ (e: 'update:modelValue', v: boolean): void; (e: 'converted', payload: { project_id: string; task_id: string }): void }>();

const { current, convert } = useDiscussion();
const visible = computed({ get: () => props.modelValue, set: (v) => emit('update:modelValue', v) });
const disc = computed(() => current.value);

const target = ref<'new' | 'existing'>('new');
const name = ref('');
const workspace = ref('');
const scaffold = ref(true);
const projectId = ref('');
const autoRun = ref(false);
const busy = ref(false);
const dirPickerVisible = ref(false);
const projects = ref<ProjectSummary[]>([]);
const projectsRootPath = ref('');

watch(visible, async (v) => {
  if (v && !projects.value.length) {
    try {
      projects.value = (await api.listProjects()).projects;
    } catch { /* ignore */ }
  }
  if (v && disc.value?.project_id) {
    target.value = 'existing';
    projectId.value = disc.value.project_id;
  }
  if (v && !name.value && disc.value) name.value = disc.value.title;
  // 新建项目：预填 <projects.root>/<方案标题 slug>，用户可改
  if (v && !workspace.value && !projectsRootPath.value) {
    try {
      projectsRootPath.value = (await api.projectsRoot()).root;
      const slug = (disc.value?.title || '').trim().replace(/[\\/:*?"<>|\s]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'project';
      workspace.value = `${projectsRootPath.value.replace(/[\\/]$/, '')}\\${slug}`;
    } catch { /* 拿不到就手填 */ }
  }
});

async function doConvert() {
  if (target.value === 'new' && !workspace.value.trim()) {
    ElMessage.warning('新建项目需要填写工作区绝对路径');
    return;
  }
  if (target.value === 'existing' && !projectId.value) {
    ElMessage.warning('请选择要挂入的项目');
    return;
  }
  busy.value = true;
  try {
    const res = await convert({
      target: target.value,
      name: name.value.trim() || undefined,
      workspace: workspace.value.trim() || undefined,
      scaffold: scaffold.value,
      project_id: projectId.value || undefined,
      auto_run: autoRun.value,
    });
    ElMessage.success(autoRun.value ? '已转项目开发，任务规划后进队列执行' : '已转项目开发，任务计划待你在任务中心评审');
    emit('converted', res);
    visible.value = false;
  } catch (e: any) {
    ElMessage.error(String(e?.message || e));
  } finally {
    busy.value = false;
  }
}
</script>
