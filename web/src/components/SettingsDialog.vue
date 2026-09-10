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
        <div class="provider-list">
          <div v-for="(g, gi) in providers" :key="gi" class="provider-card">
            <div class="pv-head">
              <span class="pv-title">服务接入点</span>
              <span class="pv-host mono">{{ providerLabel(g) }}</span>
              <el-tag size="small" type="info">{{ g.models.length }} 个模型</el-tag>
              <div class="spacer" />
              <el-button size="small" @click="pullUpstream(g, gi)" :loading="pullingIndex === gi">拉取模型</el-button>
              <el-button size="small" @click="addModelTo(g)">+ 添加模型</el-button>
              <el-button size="small" link type="danger" @click="removeProvider(gi)">删除服务</el-button>
            </div>
            <div class="pv-shared">
              <label class="field">
                <span>Base URL（本服务下所有模型共用）</span>
                <el-input v-model="g.base_url" size="small" placeholder="https://.../v1" />
              </label>
              <label class="field">
                <span>API Key（本服务下所有模型共用）</span>
                <el-input v-model="g.api_key" size="small" type="password" show-password placeholder="sk-..." />
              </label>
            </div>
            <div v-if="!g.models.length" class="pv-empty">
              还没有模型——点「拉取模型」从该服务导入，或「+ 添加模型」手动输入。
            </div>
            <div v-for="(m, mi) in g.models" :key="mi" class="model-row">
              <div class="mr-line">
                <el-input v-model="m.name" size="small" placeholder="model-name" class="mr-name" />
                <el-select v-model="m.tags" multiple filterable allow-create default-first-option size="small" placeholder="擅长领域 / 标签" class="mr-tags">
                  <el-option v-for="t in CAPABILITY_TAGS" :key="t" :label="CAPABILITY_TAG_LABELS[t] || t" :value="t" />
                </el-select>
                <el-button size="small" plain @click="testOne(g, m)" :loading="testingName === m.name">测试</el-button>
                <el-button size="small" link type="danger" @click="g.models.splice(mi, 1)">删除</el-button>
              </div>
              <div class="mr-nums">
                <label class="field"><span>并发</span><el-input-number v-model="m.concurrency" size="small" :min="1" :max="32" controls-position="right" /></label>
                <label class="field"><span>优先级</span><el-input-number v-model="m.priority" size="small" :min="1" :max="99" controls-position="right" /></label>
                <label class="field"><span>权重</span><el-input-number v-model="m.professional_weight" size="small" :min="1" :max="100" controls-position="right" /></label>
                <label class="field"><span>成本/1k($)</span><el-input-number v-model="m.cost_per_1k" size="small" :min="0" :step="0.001" controls-position="right" /></label>
                <label class="field"><span>输出上限</span><el-input-number v-model="m.max_tokens" size="small" :min="1024" :max="1000000" :step="1024" controls-position="right" /></label>
                <label class="field"><span>上下文</span><el-input-number v-model="m.context_length" size="small" :min="4096" :max="2000000" :step="4096" controls-position="right" /></label>
              </div>
            </div>
          </div>
          <el-button size="small" style="width: 100%" @click="addProvider">+ 添加服务（一个 Base URL + API Key 下可挂多个模型）</el-button>
        </div>
        <div class="toolbar">
          <span class="note">
            数字越小越优先；权重用于同优先级内随机加权；simple 任务自动选成本最低的模型
          </span>
          <el-button size="small" @click="loadAll">放弃修改</el-button>
          <el-button size="small" @click="testModelPool" :loading="testingModel">测试全部</el-button>
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
            <el-option v-for="m in allModels" :key="m.name" :label="m.name || '(未命名模型)'" :value="m.name" />
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

    <!-- 上游模型导入弹窗（模型池·拉取模型） -->
    <el-dialog v-model="importVisible" :title="`导入模型 · ${importLabel}`" width="480px" append-to-body>
      <div class="import-note">从该服务上游实际可用的模型中勾选，加入本服务分组（默认调度参数导入后可再调）。</div>
      <el-select v-model="importSelected" multiple filterable placeholder="选择要导入的模型" style="width: 100%" max-collapse-tags="8">
        <el-option v-for="n in importChoices" :key="n" :label="n" :value="n" />
      </el-select>
      <template #footer>
        <el-button size="small" @click="importVisible = false">取消</el-button>
        <el-button size="small" type="primary" :disabled="!importSelected.length" @click="confirmImport">加入模型池（{{ importSelected.length }}）</el-button>
      </template>
    </el-dialog>
  </el-dialog>
</template>

<script setup lang="ts">
import { ref, reactive, computed } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { api, type AgentDefinition, type ModelConfig, type SkillMeta } from '../api';

// 模型池按「服务接入点」分组编辑：同一 base_url + api_key 下可挂任意多个模型；
// 存储/接口契约仍是扁平 model_pool（name 为调度唯一键），保存时展平。
interface ProviderGroup {
  base_url: string;
  api_key: string;
  models: ModelConfig[];
}

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
const providers = ref<ProviderGroup[]>([]);
// 拉取/导入上游模型
const pullingIndex = ref(-1);
const importVisible = ref(false);
const importLabel = ref('');
const importChoices = ref<string[]>([]);
const importSelected = ref<string[]>([]);
let importTarget: ProviderGroup | null = null;
const testingName = ref('');

const allModels = computed(() => providers.value.flatMap((g) => g.models));

function newModel(name = ''): ModelConfig {
  return {
    name,
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
  };
}

/** 扁平 model_pool → 服务分组（按 base_url+api_key 相同归组，保持原顺序） */
function groupPool(pool: ModelConfig[]): ProviderGroup[] {
  const groups: ProviderGroup[] = [];
  const index = new Map<string, ProviderGroup>();
  for (const m of pool) {
    const key = JSON.stringify([(m.base_url || '').trim(), (m.api_key || '').trim()]);
    let g = index.get(key);
    if (!g) {
      g = { base_url: m.base_url || '', api_key: m.api_key || '', models: [] };
      index.set(key, g);
      groups.push(g);
    }
    g.models.push({ ...m, tags: m.tags || [] });
  }
  return groups;
}

/** 服务分组 → 扁平 model_pool（公共字段从组头同步进每个模型） */
function flattenProviders(): ModelConfig[] {
  return providers.value.flatMap((g) =>
    g.models.map((m) => ({
      ...m,
      tags: (m.tags || []).map((t) => t.trim()).filter(Boolean),
      base_url: (g.base_url || '').trim(),
      api_key: (g.api_key || '').trim(),
    }))
  );
}

function providerLabel(g: ProviderGroup): string {
  const raw = (g.base_url || '').trim();
  if (!raw) return '未填写地址';
  try {
    return new URL(raw).host;
  } catch {
    return raw.replace(/^https?:\/\//, '').slice(0, 32);
  }
}

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
    providers.value = groupPool(d.model_pool || []);
    if (!providers.value.length) providers.value.push({ base_url: '', api_key: '', models: [] });
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

function addProvider() {
  providers.value.push({ base_url: '', api_key: '', models: [] });
}

function addModelTo(g: ProviderGroup) {
  g.models.push(newModel());
}

async function removeProvider(gi: number) {
  const g = providers.value[gi];
  if (g.models.length) {
    try {
      await ElMessageBox.confirm(
        `删除服务「${providerLabel(g)}」将同时移除其下 ${g.models.length} 个模型配置，确定？`,
        '删除确认',
        { type: 'warning' }
      );
    } catch {
      return;
    }
  }
  providers.value.splice(gi, 1);
}

/** 拉取该 base_url + api_key 上游实际可用的模型，勾选后批量入池 */
async function pullUpstream(g: ProviderGroup, gi: number) {
  if (!(g.base_url || '').trim() || !(g.api_key || '').trim()) {
    ElMessage.warning('请先填写该服务的 Base URL 与 API Key');
    return;
  }
  pullingIndex.value = gi;
  try {
    const d = await api.upstreamModels((g.base_url || '').trim(), (g.api_key || '').trim());
    if (!d.ok || !d.models) {
      ElMessage.error(d.error || '拉取失败');
      return;
    }
    const have = new Set(g.models.map((m) => m.name));
    importChoices.value = d.models.filter((n) => !have.has(n));
    if (!importChoices.value.length) {
      ElMessage.success('该服务下可用的模型均已在池中');
      return;
    }
    importSelected.value = [];
    importTarget = g;
    importLabel.value = providerLabel(g);
    importVisible.value = true;
  } catch (e: any) {
    ElMessage.error(e.message);
  } finally {
    pullingIndex.value = -1;
  }
}

function confirmImport() {
  if (!importTarget) return;
  let added = 0;
  for (const n of importSelected.value) {
    if (importTarget.models.some((m) => m.name === n)) continue;
    importTarget.models.push({ ...newModel(n), base_url: importTarget.base_url, api_key: importTarget.api_key });
    added += 1;
  }
  ElMessage.success(`已导入 ${added} 个模型（保存后生效）`);
  importVisible.value = false;
}

async function testOne(g: ProviderGroup, m: ModelConfig) {
  if (!m.name || !(g.base_url || '').trim() || !(g.api_key || '').trim()) {
    ElMessage.warning('测试前需要填写模型名称与该服务的 Base URL / API Key');
    return;
  }
  testingName.value = m.name;
  try {
    const r = await api.testModel({ ...m, base_url: (g.base_url || '').trim(), api_key: (g.api_key || '').trim() });
    if (r.ok) ElMessage.success(`${m.name}: 连通 (${r.latency_ms}ms)`);
    else ElMessage.error(`${m.name}: ${r.error || '连接失败'}`);
  } catch (e: any) {
    ElMessage.error(`${m.name}: ${e.message}`);
  } finally {
    testingName.value = '';
  }
}

async function saveModels() {
  for (const g of providers.value) {
    if (g.models.length && (!(g.base_url || '').trim() || !(g.api_key || '').trim())) {
      ElMessage.error('每个服务接入点都需要填写 Base URL 和 API Key（组内模型自动共用）');
      return;
    }
  }
  const models = flattenProviders();
  const seen = new Set<string>();
  for (const m of models) {
    if (!m.name) {
      ElMessage.error('每个模型都需要填写名称');
      return;
    }
    if (seen.has(m.name)) {
      ElMessage.error(`模型名称重复：${m.name}（名称是全池唯一键）`);
      return;
    }
    seen.add(m.name);
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
  const models = flattenProviders();
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
.provider-list { display: flex; flex-direction: column; gap: 12px; max-height: 480px; overflow-y: auto; padding-right: 4px; }
.provider-card { background: var(--ct-bg); border: 1px solid var(--ct-border); border-radius: 6px; padding: 12px; }
.pv-head { display: flex; align-items: center; gap: 10px; margin-bottom: 10px; }
.pv-title { font-size: 12px; font-weight: 500; color: var(--ct-text); }
.pv-host { font-size: 11px; color: var(--ct-text3); max-width: 260px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pv-head .spacer { flex: 1; }
.pv-shared { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin-bottom: 6px; }
.pv-empty { font-size: 12px; color: var(--ct-text3); padding: 6px 0 2px; }
.model-row { border-top: 1px dashed var(--ct-border); padding: 8px 0; display: flex; flex-direction: column; gap: 6px; }
.mr-line { display: flex; align-items: center; gap: 8px; }
.mr-name { width: 220px; flex: none; }
.mr-tags { flex: 1; min-width: 200px; }
.mr-nums { display: grid; grid-template-columns: repeat(6, 1fr); gap: 8px; }
.mr-nums :deep(.el-input-number) { width: 100%; }
.import-note { font-size: 12px; color: var(--ct-text3); margin-bottom: 10px; }
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
