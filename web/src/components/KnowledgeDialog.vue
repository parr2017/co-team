<template>
  <el-dialog :model-value="modelValue" title="知识库" width="880px" top="4vh" @open="onOpen" @close="$emit('close')">
    <div class="kb">
      <div class="kb-toolbar">
        <el-radio-group v-model="category" size="small" @change="load">
          <el-radio-button value="">全部</el-radio-button>
          <el-radio-button value="general-tech">通用经验</el-radio-button>
          <el-radio-button value="project">项目经验</el-radio-button>
        </el-radio-group>
        <el-input v-model="keyword" size="small" placeholder="语义搜索（关键词 + 相似度）..." style="width: 260px" clearable @keydown.enter="load" @clear="load" />
        <el-button size="small" @click="load">搜索</el-button>
        <el-button size="small" type="primary" @click="openCreate">+ 新增条目</el-button>
      </div>

      <div v-if="!entries.length" class="empty mono">暂无知识条目 — Agent 会在任务中自动沉淀，你也可以手动添加</div>
      <div class="kb-list">
        <div v-for="e in entries" :key="e.id" class="kb-item">
          <div class="kb-main" @click="e._open = !e._open">
            <div class="kb-title">
              {{ e.title }}
              <el-tag size="small" :type="e.category === 'project' ? 'warning' : 'success'">{{ e.category === 'project' ? '项目' : '通用' }}</el-tag>
              <el-tag v-if="e.updated_by === 'user'" size="small" type="info">已人工编辑</el-tag>
              <el-tag v-if="typeof e.score === 'number'" size="small" type="primary" effect="dark" class="mono">相关度 {{ e.score.toFixed(2) }}</el-tag>
            </div>
            <div class="kb-meta mono">
              <span v-if="e.project_id">项目 {{ e.project_id }} ·</span>
              <span>{{ e.source }} · {{ fmtTime(e.updated_at) }}</span>
              <el-tag v-for="t in e.tags" :key="t" size="small" effect="plain">{{ t }}</el-tag>
            </div>
            <div v-if="e._open" class="kb-content">{{ e.content }}</div>
          </div>
          <div class="kb-ops">
            <el-button size="small" link type="primary" @click="openEdit(e)">修改</el-button>
            <el-button size="small" link type="danger" @click="remove(e)">删除</el-button>
          </div>
        </div>
      </div>

      <!-- 编辑 / 新建 -->
      <el-dialog v-model="editVisible" :title="editingId ? '编辑条目' : '新增条目'" width="620px" append-to-body>
        <el-form label-width="70px" size="small">
          <el-form-item label="标题"><el-input v-model="form.title" /></el-form-item>
          <el-form-item label="分类">
            <el-radio-group v-model="form.category" :disabled="!!editingId">
              <el-radio value="general-tech">通用经验</el-radio>
              <el-radio value="project">项目经验</el-radio>
            </el-radio-group>
          </el-form-item>
          <el-form-item v-if="form.category === 'project'" label="项目ID"><el-input v-model="form.project_id" placeholder="如 p1（可在项目页查看）" /></el-form-item>
          <el-form-item label="标签"><el-input v-model="form.tagsText" placeholder="逗号分隔，如 redis,最佳实践" /></el-form-item>
          <el-form-item label="内容">
            <el-input v-model="form.content" type="textarea" :rows="12" placeholder="支持 Markdown" />
          </el-form-item>
        </el-form>
        <template #footer>
          <el-button size="small" @click="editVisible = false">取消</el-button>
          <el-button size="small" type="primary" :loading="saving" @click="save">保存</el-button>
        </template>
      </el-dialog>
    </div>
  </el-dialog>
</template>

<script setup lang="ts">
import { ref } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { api, type KnowledgeEntry } from '../api';

const props = defineProps<{ modelValue: boolean; projectId?: string }>();
defineEmits<{ (e: 'close'): void }>();

const entries = ref<(KnowledgeEntry & { _open?: boolean })[]>([]);
const category = ref('');
const keyword = ref('');
const editVisible = ref(false);
const editingId = ref('');
const saving = ref(false);
const form = ref({ title: '', content: '', category: 'general-tech', project_id: '', tagsText: '' });

async function load() {
  try {
    const d = await api.listKnowledge({ category: category.value || undefined, q: keyword.value.trim() || undefined, limit: 100 });
    entries.value = d.entries.map((e) => ({ ...e, _open: false }));
  } catch (e: any) {
    ElMessage.error(e.message);
  }
}

function onOpen() {
  if (props.projectId) {
    category.value = 'project';
  }
  void load();
}

function openCreate() {
  editingId.value = '';
  form.value = { title: '', content: '', category: props.projectId ? 'project' : 'general-tech', project_id: props.projectId || '', tagsText: '' };
  editVisible.value = true;
}

function openEdit(e: KnowledgeEntry) {
  editingId.value = e.id;
  form.value = { title: e.title, content: e.content, category: e.category, project_id: e.project_id || '', tagsText: e.tags.join(', ') };
  editVisible.value = true;
}

async function save() {
  if (!form.value.title.trim() || !form.value.content.trim()) {
    ElMessage.warning('标题和内容不能为空');
    return;
  }
  saving.value = true;
  try {
    const tags = form.value.tagsText.split(/[,，]/).map((t) => t.trim()).filter(Boolean);
    if (editingId.value) {
      await api.updateKnowledge(editingId.value, { title: form.value.title, content: form.value.content, tags });
      ElMessage.success('已保存');
    } else {
      await api.createKnowledge({
        title: form.value.title,
        content: form.value.content,
        category: form.value.category,
        project_id: form.value.category === 'project' ? form.value.project_id || undefined : undefined,
        tags,
      });
      ElMessage.success('已添加');
    }
    editVisible.value = false;
    await load();
  } catch (e: any) {
    ElMessage.error(e.message);
  } finally {
    saving.value = false;
  }
}

async function remove(e: KnowledgeEntry) {
  try {
    await ElMessageBox.confirm(`确定删除「${e.title}」？该操作不可恢复。`, '删除确认', { type: 'warning' });
  } catch {
    return;
  }
  try {
    await api.deleteKnowledge(e.id);
    ElMessage.success('已删除');
    await load();
  } catch (err: any) {
    ElMessage.error(err.message);
  }
}

function fmtTime(ts: string): string {
  try {
    return new Date(ts).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
  } catch {
    return ts;
  }
}
</script>

<style scoped>
.kb { font-size: 13px; }
.kb-toolbar { display: flex; gap: 10px; align-items: center; margin-bottom: 12px; flex-wrap: wrap; }
.kb-list { max-height: calc(80vh - 180px); overflow-y: auto; display: flex; flex-direction: column; gap: 8px; }
.kb-item { display: flex; align-items: flex-start; gap: 10px; border: 1px solid var(--ct-border); border-radius: 8px; padding: 10px 12px; }
.kb-main { flex: 1; min-width: 0; cursor: pointer; }
.kb-title { font-weight: 600; color: var(--ct-text); display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.kb-meta { display: flex; gap: 8px; align-items: center; font-size: 10px; color: var(--ct-text3); margin-top: 4px; flex-wrap: wrap; }
.kb-content { margin-top: 8px; white-space: pre-wrap; font-size: 12px; color: var(--ct-text2); background: var(--ct-panel2); border-radius: 6px; padding: 10px; }
.kb-ops { display: flex; flex-direction: column; gap: 2px; flex-shrink: 0; }
.empty { text-align: center; color: var(--ct-text3); padding: 30px; font-size: 12px; }
</style>
