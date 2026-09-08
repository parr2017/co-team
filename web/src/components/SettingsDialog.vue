<template>
  <el-dialog :model-value="modelValue" title="设置" width="760px" @open="loadAll" @close="$emit('close')">
    <el-tabs v-model="tab">
      <!-- 模型池 -->
      <el-tab-pane label="通用" name="general">
        <div class="general">
          <div class="gen-row">
            <div class="gen-info">
              <div class="gen-title">桌面通知</div>
              <div class="gen-desc">任务完成、失败、等待审批、需要澄清时弹出系统通知（需浏览器授权）</div>
            </div>
            <el-switch :model-value="notifyEnabled" @change="(v: any) => emit('notify-toggle', Boolean(v))" />
          </div>
          <div class="gen-row">
            <div class="gen-info">
              <div class="gen-title">每日问题报告</div>
              <div class="gen-desc">开启后，每天在指定时刻汇总运行中的报错与功能性问题，由你决定是否转为修复任务（关闭则完全不触发）</div>
              <div class="gen-ctrl">
                <el-switch v-model="dailyReport.enabled" @change="saveDailyReport" />
                <span class="gen-time">报告时刻</span>
                <el-input-number v-model="dailyReport.hour" size="small" :min="0" :max="23" controls-position="right" style="width: 100px" @change="saveDailyReport" />
                <span class="gen-time">点（本地时间）</span>
              </div>
            </div>
          </div>
        </div>
      </el-tab-pane>
      <el-tab-pane label="模型池" name="models">
        <div class="model-list">
          <div v-for="(m, i) in pool" :key="i" class="model-editor">
            <div class="me-head">
              <span class="me-index mono">#{{ i + 1 }}</span>
              <el-input v-model="m.name" size="small" placeholder="model-name" class="me-name" />
              <el-tag v-if="i === 0" size="small" type="info">最高优先级</el-tag>
              <el-button size="small" link type="danger" style="margin-left: auto" @click="pool.splice(i, 1)">删除</el-button>
            </div>
            <div class="me-grid">
              <label class="field">
                <span>Base URL</span>
                <el-input v-model="m.base_url" size="small" placeholder="https://.../v1" />
              </label>
              <label class="field">
                <span>API Key</span>
                <el-input v-model="m.api_key" size="small" type="password" show-password />
              </label>
              <label class="field">
                <span>擅长领域 / 标签</span>
                <el-select v-model="m.tags" multiple filterable allow-create default-first-option size="small" placeholder="选择或输入自定义标签" style="width: 100%">
                  <el-option v-for="t in CAPABILITY_TAGS" :key="t" :label="CAPABILITY_TAG_LABELS[t] || t" :value="t" />
                </el-select>
              </label>
              <div class="field-row">
                <label class="field">
                  <span>并发</span>
                  <el-input-number v-model="m.concurrency" size="small" :min="1" :max="32" controls-position="right" style="width: 100%" />
                </label>
                <label class="field">
                  <span>优先级</span>
                  <el-input-number v-model="m.priority" size="small" :min="1" :max="99" controls-position="right" style="width: 100%" />
                </label>
                <label class="field">
                  <span>权重</span>
                  <el-input-number v-model="m.professional_weight" size="small" :min="1" :max="100" controls-position="right" style="width: 100%" />
                </label>
                <label class="field">
                  <span>成本/1k($)</span>
                  <el-input-number v-model="m.cost_per_1k" size="small" :min="0" :step="0.001" controls-position="right" style="width: 100%" />
                </label>
              </div>
              <div class="field-row">
                <label class="field">
                  <span>输出上限 Max Tokens</span>
                  <el-input-number v-model="m.max_tokens" size="small" :min="1024" :max="1000000" :step="1024" controls-position="right" style="width: 100%" />
                </label>
                <label class="field">
                  <span>上下文长度</span>
                  <el-input-number v-model="m.context_length" size="small" :min="4096" :max="2000000" :step="4096" controls-position="right" style="width: 100%" />
                </label>
              </div>
            </div>
          </div>
          <el-button size="small" style="width: 100%" @click="addModel">+ 添加模型</el-button>
        </div>
        <div class="toolbar">
          <span class="note">
            数字越小越优先；权重用于同优先级内随机加权；simple 任务自动选成本最低的模型
          </span>
          <el-button size="small" @click="loadAll">放弃修改</el-button>
          <el-button size="small" @click="testModelPool" :loading="testingModel">测试连通性</el-button>
          <el-button size="small" type="primary" :loading="savingModels" @click="saveModels">保存并热生效</el-button>
        </div>
      </el-tab-pane>

      <!-- Agent 管理 -->
      <el-tab-pane label="Agent 管理" name="agents">
        <el-table :data="agents" size="small">
          <el-table-column prop="name" label="名称" width="110" />
          <el-table-column prop="role" label="角色" width="90" />
          <el-table-column prop="description" label="描述" min-width="180" show-overflow-tooltip />
          <el-table-column label="标签" width="160">
            <template #default="{ row }"><span class="mono">{{ row.tags.join(', ') }}</span></template>
          </el-table-column>
          <el-table-column prop="timeout" label="预算(秒)" width="80">
            <template #header><el-tooltip content="节点级总时长预算：超时后节点停靠人工（非模型失败），时长本身不再判死" placement="top"><span>预算(秒) ⓘ</span></el-tooltip></template>
          </el-table-column>
          <el-table-column label="" width="130" align="center">
            <template #default="{ row }">
              <el-button size="small" link type="primary" @click="editAgent(row)">编辑</el-button>
              <el-button size="small" link type="danger" @click="removeAgent(row)">删除</el-button>
            </template>
          </el-table-column>
        </el-table>
        <div class="toolbar">
          <el-button size="small" @click="editAgent(null)">+ 新增 Agent</el-button>
          <div class="spacer" />
          <el-button size="small" @click="loadAgents">刷新</el-button>
        </div>
      </el-tab-pane>

      <!-- 技能库 -->
      <el-tab-pane label="技能库" name="skills">
        <el-table :data="skills" size="small">
          <el-table-column prop="name" label="技能名" width="170" />
          <el-table-column prop="description" label="描述" min-width="220" show-overflow-tooltip />
          <el-table-column label="适用标签" width="140">
            <template #default="{ row }"><span class="mono">{{ (row.tags || []).join(', ') || '全体' }}</span></template>
          </el-table-column>
          <el-table-column label="来源" width="110">
            <template #default="{ row }">
              <el-tag size="small" :type="row.source === 'global' ? 'info' : 'primary'">{{ row.source === 'global' ? '全局库' : row.source + ' 专属' }}</el-tag>
            </template>
          </el-table-column>
          <el-table-column label="绑定 Agent" width="150">
            <template #default="{ row }">
              <span class="mono">{{ skillBindingsOf(row.name) || '自动匹配' }}</span>
            </template>
          </el-table-column>
          <el-table-column label="" width="130" align="center">
            <template #default="{ row }">
              <el-button size="small" link type="primary" @click="editSkill(row)" :disabled="row.source !== 'global'">编辑</el-button>
              <el-button size="small" link type="danger" @click="removeSkill(row)" :disabled="row.source !== 'global'">删除</el-button>
            </template>
          </el-table-column>
        </el-table>
        <div class="toolbar">
          <el-button size="small" @click="editSkill(null)">+ 注入技能</el-button>
          <div class="spacer" />
          <el-button size="small" :loading="reloadingSkills" @click="doReloadSkills">重扫磁盘</el-button>
        </div>
        <div class="note" style="margin-top: 8px">
          技能 = skills/&lt;名称&gt;/SKILL.md（frontmatter: name/description/tags + 正文指令）。绑定 Agent 后每次执行全量注入；未绑定的按标签/关键词自动匹配。也可直接把文件夹丢进 skills/ 目录后点「重扫磁盘」。
        </div>
      </el-tab-pane>
    </el-tabs>

    <!-- Agent 编辑弹窗 -->
    <el-dialog v-model="agentEditorVisible" :title="editingOriginal ? `编辑 Agent：${editingOriginal}` : '新增 Agent'" width="640px" append-to-body>
      <el-form label-width="90px" size="small">
        <el-form-item label="名称">
          <el-input v-model="editing.name" placeholder="小写字母/数字/-，如 devops" :disabled="!!editingOriginal" />
        </el-form-item>
        <el-form-item label="角色"><el-input v-model="editing.role" placeholder="如 运维" /></el-form-item>
        <el-form-item label="描述"><el-input v-model="editing.description" /></el-form-item>
        <el-form-item label="标签"><el-input v-model="editing.tagsText" placeholder="deploy,ops（逗号分隔，用于路由匹配）" /></el-form-item>
        <el-form-item label="绑定技能">
          <el-select v-model="editing.skills" multiple clearable placeholder="未绑定则按标签/关键词自动匹配" style="width: 100%">
            <el-option v-for="sk in skills" :key="sk.name" :label="sk.name" :value="sk.name" />
          </el-select>
        </el-form-item>
        <el-form-item label="模型覆盖">
          <el-select v-model="editing.model_override" clearable filterable placeholder="留空使用模型池调度" style="width: 100%">
            <el-option v-for="m in pool" :key="m.name" :label="m.name || '(未命名模型)'" :value="m.name" />
          </el-select>
        </el-form-item>
        <el-form-item label="节点预算(秒)">
          <el-input-number v-model="editing.timeout" :min="60" :max="14400" controls-position="right" />
          <div class="field-hint">节点级总时长预算，超线后节点停靠人工处理（不再作为单次模型调用超时——时长不判死）</div>
        </el-form-item>
        <el-form-item label="系统提示词">
          <el-input v-model="editing.prompt" type="textarea" :rows="12" class="mono-input" placeholder="系统提示词（Markdown）" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button size="small" @click="agentEditorVisible = false">取消</el-button>
        <el-button size="small" type="primary" :loading="savingAgent" @click="saveAgent">保存</el-button>
      </template>
    </el-dialog>

    <!-- 技能编辑弹窗 -->
    <el-dialog v-model="skillEditorVisible" :title="editingSkillOriginal ? `编辑技能：${editingSkillOriginal}` : '注入新技能'" width="680px" append-to-body>
      <el-form label-width="90px" size="small">
        <el-form-item label="技能名">
          <el-input v-model="editingSkill.name" placeholder="小写字母/数字/-，如 feishu-integration" :disabled="!!editingSkillOriginal" />
        </el-form-item>
        <el-form-item label="描述">
          <el-input v-model="editingSkill.description" placeholder="一句话说明何时使用（Agent 据此匹配）" />
        </el-form-item>
        <el-form-item label="适用标签">
          <el-input v-model="editingSkill.tagsText" placeholder="review,docs（逗号分隔；留空=全体可用）" />
        </el-form-item>
        <el-form-item label="技能正文">
          <el-input v-model="editingSkill.content" type="textarea" :rows="14" class="mono-input" placeholder="操作步骤/规范/示例（Markdown）——Agent 装载后照此执行" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button size="small" @click="skillEditorVisible = false">取消</el-button>
        <el-button size="small" type="primary" :loading="savingSkill" @click="saveSkill">保存并生效</el-button>
      </template>
    </el-dialog>
  </el-dialog>
</template>

<script setup lang="ts">
import { ref, reactive } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { api, type AgentDefinition, type ModelConfig, type SkillMeta } from '../api';

// feature: 模型擅长领域标签 —— 预设能力词表 + 允许自定义
const CAPABILITY_TAGS = ['reasoning', 'code', 'doc', 'image', 'debug', 'review', 'test', 'deploy'];
const CAPABILITY_TAG_LABELS: Record<string, string> = {
  reasoning: '推理',
  code: '代码',
  doc: '文档编写',
  image: '生图',
  debug: '调试',
  review: '审查',
  test: '测试',
  deploy: '部署',
};

defineProps<{ modelValue: boolean; notifyEnabled?: boolean }>();
const emit = defineEmits<{ (e: 'close'): void; (e: 'changed'): void; (e: 'notify-toggle', v: boolean): void }>();

const tab = ref('general');
const pool = ref<ModelConfig[]>([]);
// feature: 每日问题报告 —— 界面开关（开启才触发）
const dailyReport = reactive({ enabled: false, hour: 9 });
const savingDailyReport = ref(false);
const agents = ref<AgentDefinition[]>([]);
const skills = ref<SkillMeta[]>([]);
const skillBindings = ref<Record<string, string[]>>({});
const savingSkill = ref(false);
const reloadingSkills = ref(false);
const skillEditorVisible = ref(false);
const editingSkillOriginal = ref<string | null>(null);
const editingSkill = ref<{ name: string; description: string; tagsText: string; content: string }>({ name: '', description: '', tagsText: '', content: '' });

function skillBindingsOf(name: string): string {
  return Object.entries(skillBindings.value).filter(([, list]) => list.includes(name)).map(([agent]) => agent).join(', ');
}
const savingModels = ref(false);
const savingAgent = ref(false);
const testingModel = ref(false);
const agentEditorVisible = ref(false);
const editingOriginal = ref<string | null>(null);
const editing = ref<Partial<AgentDefinition> & { tagsText?: string; skills?: string[] }>({});

async function loadAll() {
  await Promise.all([loadModels(), loadAgents(), loadSkills(), loadDailyReport()]);
}

async function loadDailyReport() {
  try {
    const d = await api.getDailyReportConfig();
    dailyReport.enabled = d.enabled;
    dailyReport.hour = d.hour;
  } catch {
    /* 保持默认值 */
  }
}

async function saveDailyReport() {
  savingDailyReport.value = true;
  try {
    await api.saveDailyReportConfig(dailyReport.enabled, dailyReport.hour);
    ElMessage.success(dailyReport.enabled ? `每日问题报告已开启（每天 ${dailyReport.hour} 点）` : '每日问题报告已关闭');
  } catch (e: any) {
    ElMessage.error(e.message);
  } finally {
    savingDailyReport.value = false;
  }
}

async function loadSkills() {
  try {
    const d = await api.listSkills();
    skills.value = d.skills;
    skillBindings.value = d.bindings;
  } catch (e: any) {
    ElMessage.error(e.message);
  }
}

function editSkill(row: SkillMeta | null) {
  editingSkillOriginal.value = row && row.source === 'global' ? row.name : null;
  editingSkill.value = row
    ? { name: row.name, description: row.description, tagsText: (row.tags || []).join(','), content: row.body || '' }
    : { name: '', description: '', tagsText: '', content: '' };
  skillEditorVisible.value = true;
}

async function saveSkill() {
  if (!editingSkill.value.name.trim()) {
    ElMessage.error('请填写技能名');
    return;
  }
  savingSkill.value = true;
  try {
    const payload = {
      description: editingSkill.value.description,
      tags: (editingSkill.value.tagsText || '').split(',').map((t) => t.trim()).filter(Boolean),
      content: editingSkill.value.content,
    };
    if (editingSkillOriginal.value) await api.updateSkill(editingSkillOriginal.value, { ...payload, name: editingSkill.value.name });
    else await api.createSkill({ name: editingSkill.value.name, ...payload });
    ElMessage.success('技能已保存并热生效');
    skillEditorVisible.value = false;
    await loadSkills();
  } catch (e: any) {
    ElMessage.error(e.message);
  } finally {
    savingSkill.value = false;
  }
}

async function removeSkill(row: SkillMeta) {
  try {
    await ElMessageBox.confirm(`确定删除技能「${row.name}」？`, '删除确认', { type: 'warning' });
  } catch {
    return;
  }
  try {
    await api.deleteSkill(row.name);
    ElMessage.success('技能已删除');
    await loadSkills();
  } catch (e: any) {
    ElMessage.error(e.message);
  }
}

async function doReloadSkills() {
  reloadingSkills.value = true;
  try {
    const d = await api.reloadSkills();
    ElMessage.success(`已重扫磁盘：${d.total} 个技能`);
    await loadSkills();
  } catch (e: any) {
    ElMessage.error(e.message);
  } finally {
    reloadingSkills.value = false;
  }
}

async function loadModels() {
  try {
    const d = await api.getModelPool();
    pool.value = d.model_pool.map((m) => ({ ...m, tags: m.tags || [] }));
  } catch (e: any) {
    ElMessage.error(e.message);
  }
}

async function loadAgents() {
  try {
    const d = await api.agentDefinitions();
    agents.value = d.agents;
  } catch (e: any) {
    ElMessage.error(e.message);
  }
}

function addModel() {
  pool.value.push({
    name: '',
    provider: '',
    api_key: '',
    base_url: '',
    concurrency: 4,
    priority: 1,
    professional_weight: 50,
    cost_per_1k: 0,
    max_tokens: 128000,
    context_length: 131072,
    tags: [],
  });
}

async function saveModels() {
  const models = pool.value.map((m) => ({
    ...m,
    tags: (m.tags || []).map((t: string) => t.trim()).filter(Boolean),
  }));
  for (const m of models) {
    if (!m.name || !m.api_key || !m.base_url) {
      ElMessage.error('每个模型都需要填写名称、Base URL 和 API Key');
      return;
    }
  }
  savingModels.value = true;
  try {
    await api.saveModelPool(models);
    ElMessage.success('模型池已保存并热生效');
    emit('changed');
  } catch (e: any) {
    ElMessage.error(e.message);
  } finally {
    savingModels.value = false;
  }
}

async function testModelPool() {
  const models = pool.value.map((m) => ({
    ...m,
    tags: (m.tags || []).map((t: string) => t.trim()).filter(Boolean),
  }));
  const valid = models.filter((m) => m.name && m.api_key && m.base_url);
  if (!valid.length) {
    ElMessage.warning('请先填写至少一个完整的模型配置');
    return;
  }
  testingModel.value = true;
  let success = 0;
  let fail = 0;
  for (const m of valid) {
    try {
      const result = await api.testModel(m);
      if (result.ok) {
        success++;
        ElMessage.success(`${m.name}: 连通 (${result.latency_ms}ms)`);
      } else {
        fail++;
        ElMessage.error(`${m.name}: ${result.error || '连接失败'}`);
      }
    } catch (e: any) {
      fail++;
      ElMessage.error(`${m.name}: ${e.message}`);
    }
  }
  testingModel.value = false;
  ElMessage.info(`测试完成: ${success} 成功, ${fail} 失败`);
}

function editAgent(row: AgentDefinition | null) {
  editingOriginal.value = row ? row.dir : null;
  editing.value = row
    ? { ...row, tagsText: row.tags.join(','), skills: row.skills || [] }
    : { name: '', role: '', description: '', tagsText: '', model_override: '', timeout: 3600, prompt: '', skills: [] };
  agentEditorVisible.value = true;
}

async function saveAgent() {
  const { tagsText, ...rest } = editing.value;
  const def = {
    ...rest,
    // 空 model_override 归一为 null —— 留空即使用模型池调度
    model_override: rest.model_override || null,
    tags: (tagsText || '').split(',').map((t: string) => t.trim()).filter(Boolean),
  };
  if (!def.name && !editingOriginal.value) {
    ElMessage.error('请填写 agent 名称');
    return;
  }
  savingAgent.value = true;
  try {
    if (editingOriginal.value) await api.updateAgent(editingOriginal.value, def);
    else await api.createAgent(def);
    ElMessage.success('Agent 已保存并热加载');
    agentEditorVisible.value = false;
    await loadAgents();
    emit('changed');
  } catch (e: any) {
    ElMessage.error(e.message);
  } finally {
    savingAgent.value = false;
  }
}

async function removeAgent(row: AgentDefinition) {
  try {
    await ElMessageBox.confirm(`确定删除 agent「${row.name}」？其目录（含提示词）将被移除。`, '删除确认', { type: 'warning' });
  } catch {
    return;
  }
  try {
    await api.deleteAgent(row.dir);
    ElMessage.success('已删除');
    await loadAgents();
    emit('changed');
  } catch (e: any) {
    ElMessage.error(e.message);
  }
}
</script>

<style scoped>
.model-list { display: flex; flex-direction: column; gap: 12px; max-height: 480px; overflow-y: auto; padding-right: 4px; }
.model-editor { background: var(--ct-bg); border: 1px solid var(--ct-border); border-radius: 6px; padding: 12px; }
.me-head { display: flex; align-items: center; gap: 10px; margin-bottom: 10px; }
.me-index { font-size: 11px; color: var(--ct-text3); }
.me-name { max-width: 240px; }
.me-grid { display: flex; flex-direction: column; gap: 10px; }
.field { display: flex; flex-direction: column; gap: 4px; flex: 1; }
.field > span { font-size: 11px; color: var(--ct-text3); }
.field-row { display: grid; grid-template-columns: repeat(4, 1fr); gap: 10px; }
.toolbar { display: flex; gap: 8px; align-items: center; margin-top: 14px; }
.toolbar .spacer { flex: 1; }
.toolbar .note { flex: 1; font-size: 11px; color: var(--ct-text3); }
.mono { font-family: var(--ct-mono); font-size: 11px; }
.mono-input :deep(textarea) { font-family: var(--ct-mono); font-size: 12px; }
.field-hint { font-size: 11px; color: var(--el-text-color-secondary); line-height: 1.4; margin-top: 2px; }
.general { display: flex; flex-direction: column; gap: 12px; }
.gen-row { display: flex; align-items: center; gap: 16px; padding: 12px 14px; border: 1px solid var(--ct-border); border-radius: 8px; }
.gen-info { flex: 1; min-width: 0; }
.gen-title { font-size: 13px; font-weight: 500; color: var(--ct-text); }
.gen-desc { font-size: 11px; color: var(--ct-text3); margin-top: 3px; }
.gen-ctrl { display: flex; align-items: center; gap: 8px; margin-top: 8px; }
.gen-time { font-size: 11px; color: var(--ct-text3); }
</style>
