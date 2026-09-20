<script setup lang="ts">
/**
 * 设置（2026-09-20）：由 SettingsDialog 弹窗迁移为独立全页选项卡（/settings，与工作台同级）。
 * 左侧锚点导航 + 右侧分区内容；本页新增三块能力：
 * 1. 长度模板 —— 上下文/输出上限的「模板按钮」一键填值（内置预设 + config.yaml 自定义），
 *    支持供应商组级「批量应用长度」；
 * 2. 调度优先级 · 降级路线图 —— 真实数据（/api/config/model-pool + /api/status 8s 轮询），
 *    节点可拖拽调序（自动重排优先级）、P/W 内联编辑、标签过滤与复杂度切换；
 * 3. 原六分区（通用/命令权限/模型池/Agent/技能/MCP）交互不变。
 */
import { ref, reactive, computed, onMounted, onBeforeUnmount, nextTick } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { ArrowDown } from '@element-plus/icons-vue';
import { api, getApiToken, setApiToken, PERMISSION_LEVELS, PERMISSION_LEVEL_LABELS, type AgentDefinition, type ModelConfig, type SkillMeta, type McpServerConfig, type McpServerStatus, type TagTemplate, type LengthTemplate } from '../api';
import { useDashboard } from '../composables/useDashboard';
import { useNotifier } from '../composables/useNotifier';

// 模型池按「服务接入点」分组编辑：同一 base_url + api_key 下可挂任意多个模型；
// 存储/接口契约仍是扁平 model_pool（id 为调度唯一键，自动生成、用户不可见），保存时展平。
interface ProviderGroup {
  base_url: string;
  api_key: string;
  /** 供应商名称（组级必填，组内所有模型共享——同名模型靠它区分） */
  provider_name: string;
  models: ModelConfig[];
}

// feature: 模型擅长领域标签 —— 预设能力词表 + 允许自定义
const CAPABILITY_TAGS = ['reasoning', 'code', 'doc', 'image', 'debug', 'review', 'test', 'deploy'];
const CAPABILITY_TAG_LABELS: Record<string, string> = {
  reasoning: '推理',
  code: '代码',
  doc: '文档编写',
  image: '视觉',
  debug: '调试',
  review: '审查',
  test: '测试',
  deploy: '部署',
};

// ===================== 分区导航 =====================
const SECTIONS = [
  { id: 'general', idx: '01', label: '通用' },
  { id: 'permissions', idx: '02', label: '命令权限' },
  { id: 'models', idx: '03', label: '模型池' },
  { id: 'agents', idx: '04', label: 'Agent 管理' },
  { id: 'skills', idx: '05', label: '技能库' },
  { id: 'mcp', idx: '06', label: 'MCP 服务' },
];
const activeSection = ref('general');
const mainRef = ref<HTMLElement | null>(null);
function goto(id: string) {
  document.getElementById('sec-' + id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// ===================== 通用 =====================
const { enabled: notifyEnabled, setEnabled: setNotifyEnabled } = useNotifier();
async function onNotifyToggle(v: boolean) {
  const ok = await setNotifyEnabled(v);
  if (ok) ElMessage.success(v ? '桌面通知已开启' : '桌面通知已关闭');
}

// SEC-P0 API Token（本浏览器凭据）
const apiTokenDraft = ref(getApiToken());
function saveApiToken() {
  setApiToken(apiTokenDraft.value.trim());
  // 保存即热重连：WS 与后续请求立即使用新 token（重连成功后会自动补拉全量数据）
  useDashboard().reconnectWs();
  ElMessage.success('API Token 已保存，立即生效');
}

const dailyReport = reactive({ enabled: false, hour: 9 });
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
  try {
    await api.saveDailyReportConfig(dailyReport.enabled, dailyReport.hour);
    ElMessage.success(dailyReport.enabled ? `每日问题报告已开启（每天 ${dailyReport.hour} 点）` : '每日问题报告已关闭');
  } catch (e: any) {
    ElMessage.error(e.message);
  }
}

// ===================== 包 D：命令权限 =====================
const perm = ref<{ level: string; whitelist: string[] }>({ level: 'approve_required', whitelist: [] });
const permDraft = ref('');
const permSaving = ref(false);
async function loadPerm() {
  try {
    const d = await api.getPermissions();
    perm.value = { level: d.permissions.level || 'approve_required', whitelist: d.permissions.whitelist_commands || [] };
  } catch {
    /* 保持默认值 */
  }
}
function addWhitelist() {
  const cmd = permDraft.value.trim().split(/\s+/)[0];
  if (cmd && !perm.value.whitelist.includes(cmd)) perm.value.whitelist.push(cmd);
  permDraft.value = '';
}
async function savePerm() {
  permSaving.value = true;
  try {
    await api.savePermissions(perm.value.level, perm.value.whitelist);
    ElMessage.success('权限配置已保存并即时生效');
  } catch (e: any) {
    ElMessage.error(e?.message || '保存失败');
  } finally {
    permSaving.value = false;
  }
}

// ===================== 模型池（编辑态） =====================
const providers = ref<ProviderGroup[]>([]);
const savingModels = ref(false);
const testingModel = ref(false);
const testingName = ref('');

const allModels = computed(() => providers.value.flatMap((g) => g.models));

function newModel(name = ''): ModelConfig {
  return {
    id: crypto.randomUUID().slice(0, 12),
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

/** 扁平 model_pool → 服务分组（按 base_url+api_key 相同归组，保持原顺序）。
 * 旧配置可能缺 id（id 是调度唯一键、用户不可见）——加载时即补齐，保证选择器等引用可用。 */
function groupPool(pool: ModelConfig[]): ProviderGroup[] {
  const groups: ProviderGroup[] = [];
  const index = new Map<string, ProviderGroup>();
  for (const m of pool) {
    const key = JSON.stringify([(m.base_url || '').trim(), (m.api_key || '').trim()]);
    let g = index.get(key);
    if (!g) {
      g = { base_url: m.base_url || '', api_key: m.api_key || '', provider_name: (m.provider || '').trim(), models: [] };
      index.set(key, g);
      groups.push(g);
    }
    if (!g.provider_name && (m.provider || '').trim()) g.provider_name = (m.provider || '').trim();
    g.models.push({ ...m, id: m.id || crypto.randomUUID().slice(0, 12), tags: m.tags || [] });
  }
  return groups;
}

/** 服务分组 → 扁平 model_pool（公共字段从组头同步进每个模型）。
 * id 是调度唯一键，用户不可见不可编辑——已有则保留，缺失时自动生成短 UUID。 */
function flattenProviders(): ModelConfig[] {
  return providers.value.flatMap((g) =>
    g.models.map((m) => ({
      ...m,
      id: m.id || crypto.randomUUID().slice(0, 12),
      tags: (m.tags || []).map((t) => t.trim()).filter(Boolean),
      base_url: (g.base_url || '').trim(),
      api_key: (g.api_key || '').trim(),
      provider: (g.provider_name || '').trim(),
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

async function loadModels() {
  try {
    const d = await api.getModelPool();
    providers.value = groupPool(d.model_pool || []);
    if (!providers.value.length) providers.value.push({ base_url: '', api_key: '', provider_name: '', models: [] });
  } catch (e: any) {
    ElMessage.error(e.message);
  }
}

function addProvider() {
  providers.value.push({ base_url: '', api_key: '', provider_name: '', models: [] });
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
const pullingIndex = ref(-1);
const importVisible = ref(false);
const importLabel = ref('');
const importChoices = ref<string[]>([]);
const importSelected = ref<string[]>([]);
let importTarget: ProviderGroup | null = null;

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
    if (!String(g.provider_name || '').trim()) {
      try { g.provider_name = new URL((g.base_url || '').trim()).hostname; } catch { g.provider_name = ''; }
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
    let host = '';
    try { host = new URL(importTarget.base_url).hostname; } catch { host = ''; }
    importTarget.models.push({ ...newModel(n), base_url: importTarget.base_url, api_key: importTarget.api_key, provider: host });
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
    // id 是调度唯一键、用户不可见（缺失时 flattenProviders 已自动补 UUID），防御性校验碰撞
    if (seen.has(m.id)) {
      ElMessage.error(`模型 ID 重复：${m.id}（请重试保存，ID 会重新生成）`);
      return;
    }
    seen.add(m.id);
  }
  savingModels.value = true;
  try {
    // 供应商名称组级必填：同名模型靠它区分（下拉展示 name · provider）；flattenProviders 已同步进每条
    const badGroup = providers.value.findIndex((g) => !String(g.provider_name || '').trim());
    if (badGroup >= 0) {
      ElMessage.error(`第 ${badGroup + 1} 个服务接入点缺少供应商名称（必填）`);
      return;
    }
    await api.saveModelPool(models);
    ElMessage.success('模型池已保存并热生效');
    void loadPoolStatus();
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

// ===================== 标签模板（既有） =====================
const tagTemplates = ref<TagTemplate[]>([]);
const tagTplEditing = ref<TagTemplate[]>([]);
const tagTplVisible = ref(false);
const tagTplSaving = ref(false);

function applyTagTemplate(m: ModelConfig, tpl: TagTemplate) {
  m.tags = [...tpl.tags];
}

/** 模型行「模板」下拉命令：选模板填充标签，或打开模板管理 */
function onTplCommand(cmd: string, m: ModelConfig) {
  if (cmd === '__manage') {
    openTagTplManager();
    return;
  }
  const tpl = tagTemplates.value.find((t) => t.name === cmd);
  if (tpl) applyTagTemplate(m, tpl);
}

async function loadTagTemplates() {
  try {
    const d = await api.getTagTemplates();
    tagTemplates.value = d.templates || [];
  } catch {
    tagTemplates.value = [];
  }
}

function openTagTplManager() {
  tagTplEditing.value = tagTemplates.value.map((t) => ({ name: t.name, tags: [...t.tags] }));
  tagTplVisible.value = true;
}

function addTagTemplate() {
  tagTplEditing.value.push({ name: '', tags: [] });
}

async function saveTagTemplates() {
  const cleaned = tagTplEditing.value
    .map((t) => ({ name: (t.name || '').trim(), tags: (t.tags || []).map((x) => x.trim()).filter(Boolean) }))
    .filter((t) => t.name);
  const names = new Set<string>();
  for (const t of cleaned) {
    if (names.has(t.name)) {
      ElMessage.error(`模板名称重复：${t.name}`);
      return;
    }
    names.add(t.name);
  }
  tagTplSaving.value = true;
  try {
    const d = await api.saveTagTemplates(cleaned);
    tagTemplates.value = d.templates || cleaned;
    tagTplVisible.value = false;
    ElMessage.success('标签模板已保存');
  } catch (e: any) {
    ElMessage.error(e.message);
  } finally {
    tagTplSaving.value = false;
  }
}

// ===================== 长度模板（新） =====================
// 内置预设只读；自定义存 config.yaml model_length_templates（GET/PUT /api/config/model-length-templates）
const BUILTIN_LENGTH_TPL: LengthTemplate[] = [
  { name: '1M', value: 1000000 },
  { name: '512K', value: 524288 },
  { name: '256K', value: 262144 },
  { name: '128K', value: 131072 },
  { name: '64K', value: 65536 },
  { name: '32K', value: 32768 },
];
const lenTemplates = ref<LengthTemplate[]>([]);
/** 合并下发：自定义与内置同名时自定义优先 */
const allLenTpl = computed<LengthTemplate[]>(() => {
  const customNames = new Set(lenTemplates.value.map((t) => t.name));
  return [...BUILTIN_LENGTH_TPL.filter((b) => !customNames.has(b.name)), ...lenTemplates.value];
});
const isCustomTpl = (t: LengthTemplate) => lenTemplates.value.some((c) => c.name === t.name);
const fmtLen = (n: number) => Number(n).toLocaleString('en-US');
const shortLen = (n?: number) => (n === undefined ? '-' : n >= 1000000 ? String(n / 1000000).replace(/\.0$/, '') + 'M' : Math.round(n / 1024) + 'K');

const lenTplEditing = ref<LengthTemplate[]>([]);
const lenTplVisible = ref(false);
const lenTplSaving = ref(false);

async function loadLengthTemplates() {
  try {
    const d = await api.getLengthTemplates();
    lenTemplates.value = d.templates || [];
  } catch {
    lenTemplates.value = [];
  }
}

function openLenTplManager() {
  lenTplEditing.value = lenTemplates.value.map((t) => ({ ...t }));
  lenTplVisible.value = true;
}
function addLenTplRow() {
  lenTplEditing.value.push({ name: '', value: NaN });
}
async function saveLenTpl() {
  const cleaned = lenTplEditing.value
    .map((t) => ({ name: (t.name || '').trim(), value: Math.floor(Number(t.value)) }))
    .filter((t) => t.name);
  for (const t of cleaned) {
    if (!Number.isFinite(t.value) || t.value <= 0) {
      ElMessage.error(`模板 ${t.name} 需要正整数数值`);
      return;
    }
  }
  const names = new Set<string>();
  for (const t of cleaned) {
    if (names.has(t.name)) {
      ElMessage.error(`模板名称重复：${t.name}`);
      return;
    }
    names.add(t.name);
  }
  lenTplSaving.value = true;
  try {
    const d = await api.saveLengthTemplates(cleaned);
    lenTemplates.value = d.templates || cleaned;
    lenTplVisible.value = false;
    ElMessage.success('长度模板已保存');
  } catch (e: any) {
    ElMessage.error(e.message);
  } finally {
    lenTplSaving.value = false;
  }
}

// ===================== 批量应用长度（供应商组级，新） =====================
const baVisible = ref(false);
const baGi = ref(-1);
const baSel = reactive<{ ctx: number | null; out: number | null }>({ ctx: null, out: null });
const baManualCtx = ref<number | undefined>(undefined);
const baManualOut = ref<number | undefined>(undefined);
const baGroup = computed(() => providers.value[baGi.value] || null);
const baCount = computed(() => baGroup.value?.models.length ?? 0);

function openBatch(gi: number) {
  baGi.value = gi;
  baSel.ctx = null;
  baSel.out = null;
  baManualCtx.value = undefined;
  baManualOut.value = undefined;
  baVisible.value = true;
}
function baPick(field: 'ctx' | 'out', value: number) {
  baSel[field] = baSel[field] === value ? null : value;
}
async function applyBatch() {
  const g = baGroup.value;
  if (!g) return;
  if (baSel.ctx === null && baSel.out === null) {
    ElMessage.warning('请先选择模板或手填数值（留空表示不改）');
    return;
  }
  for (const m of g.models) {
    if (baSel.ctx !== null) m.context_length = baSel.ctx;
    if (baSel.out !== null) m.max_tokens = baSel.out;
  }
  baVisible.value = false;
  ElMessage.success(`已应用到 ${g.models.length} 个模型（上下文${baSel.ctx !== null ? ' ✓' : '未改'} / 输出上限${baSel.out !== null ? ' ✓' : '未改'}）——点「保存并热生效」落盘`);
}

// ===================== 调度优先级 · 降级路线图（真实数据，新） =====================
// 配置态 providers（可编辑）+ 运行态 /api/status（8s 轮询）：冷却/慢/失败实时上节点。
// 排序与 server/src/scheduler.ts fallbackChain 同款：P_eff 升序 → 权重降序（429 端点组
// 软避让信号未暴露，属已知近似）。
interface ChainRef { m: ModelConfig; gi: number; mi: number; prov: string }
const runtimePool = ref<Record<string, any>>({});

async function loadPoolStatus() {
  try {
    const st = await api.status();
    runtimePool.value = (st.model_pool || {}) as Record<string, any>;
  } catch { /* 只读区加载失败不阻塞设置页 */ }
}

const runtimeOf = (m: ModelConfig) => runtimePool.value[m.id] || null;
/**
 * 有效优先级 = 本地（未保存）priority + 运行态惩罚差值。
 * 服务端 effective_priority 基于「已保存」的 priority 算出，直接用它会让拖拽重排在
 * 保存前不生效——故取差值（effective_priority - priority = 慢+失败惩罚）叠加到本地值。
 */
const effOf = (m: ModelConfig): number => {
  const rt = runtimeOf(m);
  const penalty = rt && typeof rt.effective_priority === 'number' && typeof rt.priority === 'number' ? rt.effective_priority - rt.priority : 0;
  return (m.priority ?? 99) + penalty;
};

function rmState(m: ModelConfig): { cls: string; txt: string } {
  const rt = runtimeOf(m);
  if (!rt) return { cls: 'idle', txt: '未运行' };
  if ((rt.cooldown_ms || 0) > 0) return { cls: 'bad', txt: `冷却 ${Math.ceil(rt.cooldown_ms / 1000)}s` };
  if (!rt.healthy) return { cls: 'bad', txt: '不可用' };
  if (rt.slow_count > 0) return { cls: 'warn', txt: `慢 ×${rt.slow_count}` };
  if (rt.fail_count > 0) return { cls: 'warn', txt: `败 ${rt.fail_count}` };
  return { cls: 'ok', txt: '健康' };
}
const rmDead = (m: ModelConfig) => rmState(m).cls !== 'ok';

const rmTag = ref('');
const rmCx = ref<'normal' | 'simple' | 'complex'>('normal');
const tagOptions = computed(() => {
  const set = new Set<string>();
  for (const m of allModels.value) for (const t of m.tags || []) set.add(t);
  return [...set];
});
/** 三档复杂度的链排序（与 scheduler.selectModel 的选型序一致） */
const CX_SORT: Record<string, (a: ChainRef, b: ChainRef) => number> = {
  normal: (a, b) => effOf(a.m) - effOf(b.m) || (b.m.professional_weight || 0) - (a.m.professional_weight || 0),
  simple: (a, b) => effOf(a.m) - effOf(b.m) || (a.m.cost_per_1k || 0) - (b.m.cost_per_1k || 0),
  complex: (a, b) => (b.m.professional_weight || 0) - (a.m.professional_weight || 0) || effOf(a.m) - effOf(b.m),
};
const chainRefs = computed<ChainRef[]>(() => {
  let list = providers.value.flatMap((g, gi) => g.models.map((m, mi) => ({ m, gi, mi, prov: g.provider_name })));
  if (rmTag.value) list = list.filter((r) => (r.m.tags || []).includes(rmTag.value));
  return [...list].sort(CX_SORT[rmCx.value]);
});

// 拖拽调序：落点 = 链上顺序，可见模型优先级重排 1..n；过滤外模型按 P_eff 顺延
const dragIdx = ref(-1);
const dropIdx = ref(-1);
function onChainMouseDown(e: MouseEvent) {
  // 输入框内按下不启用拖拽（保证 P/W 数字编辑可用）
  const node = (e.target as HTMLElement).closest?.('.rm-node') as HTMLElement | null;
  if (node) node.draggable = (e.target as HTMLElement).tagName !== 'INPUT';
}
function onDragStart(i: number, e: DragEvent) {
  dragIdx.value = i;
  if (e.dataTransfer) {
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', String(i)); // Firefox 需要 setData 才会启动拖拽
  }
}
function onDragEnd() {
  dragIdx.value = -1;
  dropIdx.value = -1;
}
function onDropAt(i: number) {
  if (dragIdx.value < 0 || i < 0 || i === dragIdx.value) {
    onDragEnd();
    return;
  }
  const list = [...chainRefs.value];
  const [moved] = list.splice(dragIdx.value, 1);
  list.splice(i > dragIdx.value ? i - 1 : i, 0, moved);
  dragIdx.value = -1;
  dropIdx.value = -1;
  // 重排优先级：可见 1..n；过滤外模型按当前 P_eff 排在后面顺延
  list.forEach((r, idx) => { r.m.priority = idx + 1; });
  const inList = new Set(list.map((r) => r.m));
  providers.value
    .flatMap((g) => g.models)
    .filter((m) => !inList.has(m))
    .sort((a, b) => effOf(a) - effOf(b))
    .forEach((m, idx) => { m.priority = list.length + idx + 1; });
  ElMessage.success(`顺序已重排（优先级 1..${list.length}）——点「保存并热生效」落盘，保存前不影响运行中任务`);
}

// ===================== Agent 管理 =====================
const agents = ref<AgentDefinition[]>([]);
const savingAgent = ref(false);
const agentEditorVisible = ref(false);
const editingOriginal = ref<string | null>(null);
const editing = ref<Partial<AgentDefinition> & { tagsText?: string; skills?: string[] }>({});

async function loadAgents() {
  try {
    const d = await api.agentDefinitions();
    agents.value = d.agents;
  } catch (e: any) {
    ElMessage.error(e.message);
  }
}

function editAgent(row: AgentDefinition | null) {
  editingOriginal.value = row ? row.dir : null;
  editing.value = row
    ? { ...row, tagsText: row.tags.join(','), skills: row.skills || [], mcp_servers: row.mcp_servers || [] }
    : { name: '', role: '', description: '', tagsText: '', model_override: '', timeout: 3600, prompt: '', skills: [], mcp_servers: [] };
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
  } catch (e: any) {
    ElMessage.error(e.message);
  }
}

// ===================== 技能库 =====================
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

// ===================== 外部 MCP 服务 =====================
// 列表本地编辑（增/删/改/启停）→「保存并热生效」一次性 PUT；测试连接走不落盘探测接口
interface McpRow {
  name: string;
  type: 'stdio' | 'http';
  enabled: boolean;
  target: string;
  connected: boolean;
  toolCount: number;
  error?: string;
  cfg: McpServerConfig;
}

const mcpServers = ref<McpServerConfig[]>([]);
const mcpRuntime = ref<Record<string, McpServerStatus>>({});
const mcpSavingList = ref(false);
const mcpTesting = ref('');
const mcpEditorVisible = ref(false);
const mcpAdvancedOpen = ref(false);
const mcpSaving = ref(false);
const editingMcpOriginal = ref<string | null>(null);
const editingMcp = ref<{ name: string; enabled: boolean; type: 'stdio' | 'http'; command: string; argsText: string; url: string; advancedJson: string }>({
  name: '', enabled: true, type: 'stdio', command: '', argsText: '', url: '', advancedJson: '',
});

const mcpRows = computed<McpRow[]>(() =>
  mcpServers.value.map((cfg) => {
    const rt = mcpRuntime.value[cfg.name];
    return {
      name: cfg.name,
      type: cfg.type,
      enabled: cfg.enabled !== false,
      target: cfg.type === 'http' ? (cfg.url || '') : [cfg.command || '', ...(cfg.args || [])].join(' ').trim(),
      connected: !!rt?.connected,
      toolCount: rt?.toolCount || 0,
      error: rt?.error,
      cfg,
    };
  })
);

function mcpStatusLabel(row: McpRow): string {
  if (!row.enabled) return '已禁用';
  if (row.connected) return '已连接';
  return row.error ? '未连接' : '连接中';
}

async function loadMcp() {
  try {
    const d = await api.getMcpConfig();
    mcpServers.value = d.servers || [];
    mcpRuntime.value = Object.fromEntries((d.runtime || []).map((s) => [s.name, s]));
  } catch {
    /* 服务端未就绪等场景保持当前值 */
  }
}

/** 编辑态的「高级 JSON」= 完整配置剔除基础表单字段（name/type/enabled/command/args/url 已随表单展示） */
function mcpAdvancedOf(cfg: McpServerConfig): string {
  const { name, type, enabled, command, args, url, ...rest } = cfg;
  const adv: Record<string, unknown> = { ...rest };
  return JSON.stringify(adv, null, 2);
}

function editMcp(row: McpRow | null) {
  editingMcpOriginal.value = row ? row.name : null;
  editingMcp.value = row
    ? {
        name: row.cfg.name,
        enabled: row.cfg.enabled !== false,
        type: row.cfg.type,
        command: row.cfg.command || '',
        argsText: (row.cfg.args || []).join(' '),
        url: row.cfg.url || '',
        advancedJson: mcpAdvancedOf(row.cfg),
      }
    : { name: '', enabled: true, type: 'stdio', command: '', argsText: '', url: '', advancedJson: '{}' };
  mcpAdvancedOpen.value = false;
  mcpEditorVisible.value = true;
}

/** 表单 + 高级 JSON → 完整配置；校验失败返回 null（已弹错误） */
function buildMcpConfig(): McpServerConfig | null {
  const e = editingMcp.value;
  const name = e.name.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(name)) {
    ElMessage.error('名称必须是 小写字母/数字 开头，仅含 a-z0-9_-');
    return null;
  }
  if (e.type === 'stdio' && !e.command.trim()) {
    ElMessage.error('stdio 服务必须填写启动命令');
    return null;
  }
  if (e.type === 'http' && !e.url.trim()) {
    ElMessage.error('http 服务必须填写服务地址');
    return null;
  }
  let advanced: Record<string, unknown> = {};
  const raw = (e.advancedJson || '').trim();
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('高级设置必须是 JSON 对象');
      advanced = parsed;
    } catch (err: any) {
      ElMessage.error(`高级设置 JSON 无效：${err.message}`);
      return null;
    }
  }
  const base: McpServerConfig = { name, type: e.type, enabled: e.enabled };
  if (e.type === 'stdio') {
    base.command = e.command.trim();
    const args = e.argsText.trim().split(/\s+/).filter(Boolean);
    if (args.length) base.args = args;
  } else {
    base.url = e.url.trim();
  }
  // 决策 D5：高级 JSON 与基础表单字段冲突时以 JSON 为准
  return { ...base, ...advanced } as McpServerConfig;
}

function formatMcpJson() {
  const raw = (editingMcp.value.advancedJson || '').trim();
  if (!raw) {
    editingMcp.value.advancedJson = '{}';
    return;
  }
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      ElMessage.error('高级设置必须是 JSON 对象');
      return;
    }
    editingMcp.value.advancedJson = JSON.stringify(parsed, null, 2);
    ElMessage.success('JSON 格式正确');
  } catch (err: any) {
    ElMessage.error(`JSON 无效：${err.message}`);
  }
}

async function testMcpDialog() {
  const cfg = buildMcpConfig();
  if (!cfg) return;
  mcpTesting.value = '__dialog__';
  try {
    const r = await api.testMcpServer(cfg);
    if (r.ok) {
      const names = (r.tools || []).slice(0, 5).map((t) => t.name).join('、');
      ElMessage.success(`连接成功，发现 ${r.tools?.length ?? 0} 个工具${names ? `：${names}${(r.tools?.length || 0) > 5 ? ' …' : ''}` : ''}`);
    } else {
      ElMessage.error(r.error || '连接失败');
    }
  } catch (e: any) {
    ElMessage.error(e.message);
  } finally {
    mcpTesting.value = '';
  }
}

async function saveMcpDialog() {
  const cfg = buildMcpConfig();
  if (!cfg) return;
  const originalIdx = mcpServers.value.findIndex((s) => s.name === (editingMcpOriginal.value || ''));
  const dupIdx = mcpServers.value.findIndex((s) => s.name === cfg.name);
  if (dupIdx >= 0 && dupIdx !== originalIdx) {
    ElMessage.error(`服务名已存在：${cfg.name}`);
    return;
  }
  if (originalIdx >= 0) mcpServers.value.splice(originalIdx, 1, cfg);
  else mcpServers.value.push(cfg);
  mcpEditorVisible.value = false;
  await saveMcpList();
}

async function saveMcpList() {
  mcpSavingList.value = true;
  try {
    const d = await api.saveMcpConfig(mcpServers.value);
    mcpServers.value = d.servers || mcpServers.value;
    mcpRuntime.value = Object.fromEntries((d.runtime || []).map((s) => [s.name, s]));
    ElMessage.success('MCP 服务已保存并热生效');
  } catch (e: any) {
    ElMessage.error(e.message);
  } finally {
    mcpSavingList.value = false;
  }
}

async function removeMcp(index: number) {
  const row = mcpRows.value[index];
  try {
    await ElMessageBox.confirm(`确定删除 MCP 服务「${row.name}」？保存后立即断开连接并从 Agent 工具面移除。`, '删除确认', { type: 'warning' });
  } catch {
    return;
  }
  mcpServers.value.splice(index, 1);
  await saveMcpList();
}

async function testMcpRow(row: McpRow) {
  mcpTesting.value = row.name;
  try {
    const r = await api.testMcpServer(row.cfg);
    if (r.ok) ElMessage.success(`${row.name}: 连接成功，${r.tools?.length ?? 0} 个工具`);
    else ElMessage.error(`${row.name}: ${r.error || '连接失败'}`);
  } catch (e: any) {
    ElMessage.error(`${row.name}: ${e.message}`);
  } finally {
    mcpTesting.value = '';
  }
}

// ===================== 加载 / 轮询 =====================
async function loadAll() {
  await Promise.all([loadModels(), loadAgents(), loadSkills(), loadDailyReport(), loadPerm(), loadMcp(), loadPoolStatus(), loadTagTemplates(), loadLengthTemplates()]);
}

let pollTimer: ReturnType<typeof setInterval> | null = null;
let secObs: IntersectionObserver | null = null;

onMounted(() => {
  void loadAll();
  // 运行态按分区轮询：模型池页看降级路线图（/api/status），MCP 页看连接状态
  pollTimer = setInterval(() => {
    if (activeSection.value === 'models') void loadPoolStatus();
    else if (activeSection.value === 'mcp') void loadMcp();
  }, 8000);
  nextTick(() => {
    if (!mainRef.value) return;
    secObs = new IntersectionObserver(
      (entries) => {
        for (const en of entries) if (en.isIntersecting) activeSection.value = en.target.id.replace('sec-', '');
      },
      { root: mainRef.value, threshold: 0.12 }
    );
    document.querySelectorAll('.sv-sec').forEach((s) => secObs!.observe(s));
  });
});

onBeforeUnmount(() => {
  if (pollTimer) clearInterval(pollTimer);
  if (secObs) secObs.disconnect();
});
</script>

<template>
  <div class="sv-root">
    <!-- 左侧锚点导航 -->
    <aside class="sv-nav">
      <div class="sv-cap">Settings</div>
      <button v-for="s in SECTIONS" :key="s.id" class="sv-item" :class="{ active: activeSection === s.id }" @click="goto(s.id)">
        <span class="idx mono">{{ s.idx }}</span><span class="txt">{{ s.label }}</span>
      </button>
      <div class="sv-sep"></div>
      <div class="sv-cap">config.yaml</div>
      <div class="sv-note">保存即热生效<br />密钥不入库</div>
    </aside>

    <main ref="mainRef" class="sv-main">
      <div class="sv-inner">
        <div class="sv-head">
          <span class="sv-title">设置</span>
          <span class="sv-sub mono">config/config.yaml · 保存即热生效</span>
        </div>

        <!-- ========== 01 通用 ========== -->
        <section id="sec-general" class="sv-sec">
          <div class="sec-head"><h2>通用</h2><span class="hint">通知与凭据</span></div>
          <div class="gen">
            <div class="gen-row">
              <div class="gen-info">
                <div class="gen-title">桌面通知</div>
                <div class="gen-desc">任务完成、失败、等待审批、需要澄清时弹出系统通知（需浏览器授权）</div>
              </div>
              <el-switch :model-value="notifyEnabled" @change="(v: any) => onNotifyToggle(Boolean(v))" />
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
            <!-- SEC-P0 API Token：服务端 dashboard.token 配置后，此处填入同一值即可通过门禁 -->
            <div class="gen-row">
              <div class="gen-info">
                <div class="gen-title">API Token</div>
                <div class="gen-desc">服务端 config.yaml 配置了 dashboard.token 时必填——本浏览器访问 API 的门禁凭据（存本地，不落服务端）</div>
                <div class="gen-ctrl">
                  <el-input
                    v-model="apiTokenDraft"
                    size="small"
                    style="width: 260px"
                    placeholder="粘贴服务端 dashboard.token"
                    show-password
                    @change="saveApiToken"
                  />
                  <el-button size="small" @click="saveApiToken">保存</el-button>
                </div>
              </div>
            </div>
          </div>
        </section>

        <!-- ========== 02 命令权限 ========== -->
        <section id="sec-permissions" class="sv-sec">
          <div class="sec-head"><h2>命令权限</h2><span class="hint">级别 + 白名单，保存即热更</span></div>
          <div class="perm">
            <div class="perm-row">
              <div class="gen-info">
                <div class="gen-title">默认权限级别</div>
                <div class="gen-desc">所有新任务的缺省命令执行策略（单个任务可在创建时或任务详情里覆盖）。高危命令（删除/系统级/内联代码/强推）任何级别都强制人工审批，越界路径一律拒绝。</div>
              </div>
              <el-select v-model="perm.level" size="small" style="width: 180px">
                <el-option v-for="lv in PERMISSION_LEVELS" :key="lv" :value="lv" :label="PERMISSION_LEVEL_LABELS[lv] || lv" />
              </el-select>
            </div>
            <div class="perm-row">
              <div class="gen-info">
                <div class="gen-title">白名单命令</div>
                <div class="gen-desc">「白名单自动」级别下免审批直接执行的命令首词；「改动需审批」级别下白名单内命令免审批、其余待你批准。</div>
              </div>
            </div>
            <div class="perm-tags">
              <el-tag v-for="(cmd, i) in perm.whitelist" :key="cmd + i" closable size="small" class="perm-tag mono" @close="perm.whitelist.splice(i, 1)">{{ cmd }}</el-tag>
              <el-input v-model="permDraft" size="small" style="width: 170px" placeholder="输入命令回车添加" @keydown.enter.prevent="addWhitelist" />
            </div>
            <div class="perm-actions">
              <el-button size="small" type="primary" :loading="permSaving" @click="savePerm">保存权限配置</el-button>
              <el-button size="small" @click="loadPerm">放弃修改</el-button>
            </div>
          </div>
        </section>

        <!-- ========== 03 模型池 ========== -->
        <section id="sec-models" class="sv-sec">
          <div class="sec-head"><h2>模型池</h2><span class="hint">供应商分组编辑 · 数字越小越优先</span></div>

          <!-- 健康快照（只读行区） -->
          <div v-if="Object.keys(runtimePool).length" class="pool-health">
            <div class="dtitle">模型池健康 · {{ Object.keys(runtimePool).length }} 个模型（实时快照）</div>
            <div v-for="(st, name) in runtimePool" :key="name" class="poolrow">
              <span class="dot" :class="st.healthy ? ((st.cooldown_ms || 0) > 0 || st.active >= st.concurrency ? 'warn' : 'ok') : 'danger'"></span>
              <span class="nm mono">{{ st.name || name }}</span>
              <span class="mt mono">优先 {{ st.priority }} · 并发 {{ st.concurrency }}</span>
              <div class="tags"><span v-for="t in (st.tags || [])" :key="t" class="tag">{{ t }}</span></div>
              <span class="rt mono">{{ (st.cooldown_ms || 0) > 0 ? `冷却 ${Math.round(st.cooldown_ms / 1000)}s` : st.healthy ? `${st.active}/${st.concurrency} 在用` : '不可用' }}</span>
            </div>
          </div>

          <!-- 调度优先级 · 降级路线图（真实数据 + 可拖拽调序） -->
          <div class="roadmap-box">
            <div class="rm-toolbar">
              <span class="cap">标签过滤</span>
              <div class="seg">
                <button :class="{ on: rmTag === '' }" @click="rmTag = ''">全部</button>
                <button v-for="t in tagOptions" :key="t" :class="{ on: rmTag === t }" @click="rmTag = t">{{ CAPABILITY_TAG_LABELS[t] || t }}</button>
              </div>
              <span class="cap">复杂度</span>
              <div class="seg">
                <button :class="{ on: rmCx === 'normal' }" @click="rmCx = 'normal'">正常</button>
                <button :class="{ on: rmCx === 'simple' }" @click="rmCx = 'simple'">简单</button>
                <button :class="{ on: rmCx === 'complex' }" @click="rmCx = 'complex'">复杂</button>
              </div>
              <div class="rm-legend">
                <span><i class="dot ok"></i>健康</span>
                <span><i class="dot warn"></i>慢/失败（降序）</span>
                <span><i class="dot danger"></i>冷却</span>
                <span class="mono">P_eff = 优先级+慢+失败惩罚</span>
              </div>
            </div>
            <div class="rm-chain" @mousedown="onChainMouseDown" @dragover.prevent @drop.prevent="onDropAt(dropIdx)">
              <template v-for="(r, i) in chainRefs" :key="r.m.id">
                <div v-if="i > 0" class="rm-arrow">→</div>
                <div
                  class="rm-node"
                  :class="{ first: i === 0, dead: rmDead(r.m), dragging: dragIdx === i, 'drop-before': dropIdx === i && dragIdx !== i }"
                  draggable="true"
                  title="拖拽调序（改优先级）"
                  @dragstart="onDragStart(i, $event)"
                  @dragover.prevent="dropIdx = i"
                  @dragend="onDragEnd"
                >
                  <span class="rm-order">{{ i + 1 }}</span>
                  <div class="rm-name mono">{{ r.m.name || '(未命名)' }}<span v-if="i === 0" class="rm-first">首选</span></div>
                  <div class="rm-prov">{{ r.prov }} · ${{ r.m.cost_per_1k ?? 0 }}/1k</div>
                  <div class="rm-meta">
                    <span>ctx <b class="mono">{{ shortLen(r.m.context_length) }}</b></span>
                    <span>P_eff <b class="mono">{{ effOf(r.m) }}</b></span>
                  </div>
                  <div class="rm-state" :class="rmState(r.m).cls"><i class="dot" :class="rmState(r.m).cls === 'idle' ? 'warn' : rmState(r.m).cls"></i>{{ rmState(r.m).txt }}</div>
                  <div class="pin">
                    P <el-input-number v-model="r.m.priority" size="small" :min="1" :max="99" controls-position="right" class="pin-num" />
                    W <el-input-number v-model="r.m.professional_weight" size="small" :min="1" :max="100" controls-position="right" class="pin-num" />
                  </div>
                </div>
              </template>
              <div class="rm-arrow">→</div>
              <div class="rm-tail">
                <div class="rm-name">主 Agent 兜底</div>
                <div class="rm-prov">链耗尽 · 破冷却玻璃</div>
                <div class="rm-meta"><span>再败 → 停靠人工</span></div>
              </div>
            </div>
            <div class="rm-rules">
              <div class="rm-rule"><b>① 重试</b>失败后先对同一模型原样重试 1 次（带失败反馈），不立刻换模。</div>
              <div class="rm-rule"><b>② 沿链换模</b>按本路线图顺序换下一个健康模型立即重试；429 端点组沉底避让。</div>
              <div class="rm-rule"><b>③ 413 超窗重排</b>上下文超限时，剩余链按上下文长度降序重排——大窗口优先。</div>
              <div class="rm-rule"><b>④ 兜底</b>链耗尽 → 主 Agent 模型硬闯（破冷却玻璃），再败则节点停靠人工。</div>
            </div>
            <div class="rm-note">
              实现绑定真实数据：配置态 <span class="mono">/api/config/model-pool</span> + 运行态 <span class="mono">/api/status</span>（8s 轮询）。拖拽调序或改 P/W = 修改模型池编辑态，统一「保存并热生效」落盘，保存前不影响运行中任务。
              提示：正常档在候选前 50% 内按权重随机——拖成严格 1,2,3… 即完全确定顺序；把若干模型优先级设为相同、用权重分配概率。
            </div>
          </div>

          <!-- 服务接入点（编辑区） -->
          <div class="provider-list">
            <div v-for="(g, gi) in providers" :key="gi" class="provider-card">
              <div class="pv-head">
                <span class="pv-title">服务接入点</span>
                <span class="pv-host mono">{{ providerLabel(g) }}</span>
                <el-tag size="small" type="info">{{ g.models.length }} 个模型</el-tag>
                <div class="spacer" />
                <el-button size="small" @click="openBatch(gi)">批量应用长度</el-button>
                <el-button size="small" @click="pullUpstream(g, gi)" :loading="pullingIndex === gi">拉取模型</el-button>
                <el-button size="small" @click="addModelTo(g)">+ 添加模型</el-button>
                <el-button size="small" link type="danger" @click="removeProvider(gi)">删除服务</el-button>
              </div>
              <div class="pv-shared">
                <label class="field">
                  <span>供应商名称（必填，下拉展示 name · provider）</span>
                  <el-input v-model="g.provider_name" size="small" placeholder="如 智谱 / DeepSeek 官方 / 本地vLLM" />
                </label>
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
                  <el-dropdown trigger="click" @command="(cmd: string) => onTplCommand(cmd, m)">
                    <el-button size="small" plain>
                      模板<el-icon style="margin-left:4px"><ArrowDown /></el-icon>
                    </el-button>
                    <template #dropdown>
                      <el-dropdown-menu>
                        <el-dropdown-item v-if="!tagTemplates.length" disabled>暂无模板，点「管理模板」创建</el-dropdown-item>
                        <el-dropdown-item v-for="t in tagTemplates" :key="t.name" :command="t.name">
                          {{ t.name }}<span class="tpl-cnt mono">{{ t.tags.map((x) => CAPABILITY_TAG_LABELS[x] || x).join('·') }}</span>
                        </el-dropdown-item>
                        <el-dropdown-item divided command="__manage">管理模板…</el-dropdown-item>
                      </el-dropdown-menu>
                    </template>
                  </el-dropdown>
                  <el-button size="small" plain @click="testOne(g, m)" :loading="testingName === m.name">测试</el-button>
                  <el-button size="small" link type="danger" @click="g.models.splice(mi, 1)">删除</el-button>
                </div>
                <div class="mr-nums">
                  <label class="field"><span>并发</span><el-input-number v-model="m.concurrency" size="small" :min="1" :max="32" controls-position="right" /></label>
                  <label class="field"><span>优先级</span><el-input-number v-model="m.priority" size="small" :min="1" :max="99" controls-position="right" /></label>
                  <label class="field"><span>权重</span><el-input-number v-model="m.professional_weight" size="small" :min="1" :max="100" controls-position="right" /></label>
                  <label class="field"><span>成本/1k($)</span><el-input-number v-model="m.cost_per_1k" size="small" :min="0" :step="0.001" controls-position="right" /></label>
                  <label class="field">
                    <span>输出上限</span>
                    <el-input-number v-model="m.max_tokens" size="small" :min="1024" :max="10000000" :step="1024" controls-position="right" />
                    <div class="tpl-btns">
                      <button v-for="t in allLenTpl" :key="'o' + t.name" class="tpl-btn" :class="{ custom: isCustomTpl(t) }" :title="`${t.name} = ${fmtLen(t.value)}`" @click="m.max_tokens = t.value">{{ t.name }}</button>
                      <button class="tpl-manage" @click="openLenTplManager">管理</button>
                    </div>
                  </label>
                  <label class="field">
                    <span>上下文</span>
                    <el-input-number v-model="m.context_length" size="small" :min="4096" :max="10000000" :step="4096" controls-position="right" />
                    <div class="tpl-btns">
                      <button v-for="t in allLenTpl" :key="'c' + t.name" class="tpl-btn" :class="{ custom: isCustomTpl(t) }" :title="`${t.name} = ${fmtLen(t.value)}`" @click="m.context_length = t.value">{{ t.name }}</button>
                      <button class="tpl-manage" @click="openLenTplManager">管理</button>
                    </div>
                  </label>
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
        </section>

        <!-- ========== 04 Agent 管理 ========== -->
        <section id="sec-agents" class="sv-sec">
          <div class="sec-head"><h2>Agent 管理</h2><span class="hint">{{ agents.length }} 个 Agent</span></div>
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
        </section>

        <!-- ========== 05 技能库 ========== -->
        <section id="sec-skills" class="sv-sec">
          <div class="sec-head"><h2>技能库</h2><span class="hint">SKILL.md 注入</span></div>
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
        </section>

        <!-- ========== 06 MCP 服务 ========== -->
        <section id="sec-mcp" class="sv-sec">
          <div class="sec-head"><h2>MCP 服务</h2><span class="hint">状态灯实时反映可连接性，保存即热生效</span></div>
          <el-table :data="mcpRows" size="small">
            <el-table-column prop="name" label="名称" width="110">
              <template #default="{ row }"><span class="mono">{{ row.name }}</span></template>
            </el-table-column>
            <el-table-column label="类型" width="70" align="center">
              <template #default="{ row }"><el-tag size="small" :type="row.type === 'http' ? 'warning' : 'info'">{{ row.type }}</el-tag></template>
            </el-table-column>
            <el-table-column label="目标" min-width="190">
              <template #default="{ row }"><span class="mono mcp-target">{{ row.target || '（未填写）' }}</span></template>
            </el-table-column>
            <el-table-column label="状态" width="100" align="center">
              <template #default="{ row }">
                <el-tooltip v-if="row.error" :content="row.error" placement="top">
                  <el-tag size="small" :type="!row.enabled ? 'info' : row.connected ? 'success' : 'danger'">{{ mcpStatusLabel(row) }}</el-tag>
                </el-tooltip>
                <el-tag v-else size="small" :type="!row.enabled ? 'info' : row.connected ? 'success' : 'danger'">{{ mcpStatusLabel(row) }}</el-tag>
              </template>
            </el-table-column>
            <el-table-column label="工具数" width="70" align="center">
              <template #default="{ row }">{{ row.enabled ? row.toolCount : '-' }}</template>
            </el-table-column>
            <el-table-column label="启用" width="60" align="center">
              <template #default="{ row }"><el-switch v-model="row.cfg.enabled" size="small" /></template>
            </el-table-column>
            <el-table-column label="" width="150" align="center">
              <template #default="{ row, $index }">
                <el-button size="small" link type="primary" :loading="mcpTesting === row.name" @click="testMcpRow(row)">测试</el-button>
                <el-button size="small" link type="primary" @click="editMcp(row)">编辑</el-button>
                <el-button size="small" link type="danger" @click="removeMcp($index)">删除</el-button>
              </template>
            </el-table-column>
          </el-table>
          <div class="toolbar">
            <el-button size="small" @click="editMcp(null)">+ 新增 MCP 服务</el-button>
            <div class="spacer" />
            <el-button size="small" :loading="mcpSavingList" @click="saveMcpList">保存并热生效</el-button>
          </div>
          <div class="note" style="margin-top: 8px">
            外部工具以 mcp__&lt;服务&gt;__&lt;工具&gt; 暴露给 Agent（需在「Agent 管理」编辑框勾选绑定，默认不可见）。测试连接不落盘；密钥用 ${ENV_VAR} 占位走环境变量；「启用」切换后需点保存才热生效。
          </div>
        </section>
      </div>
    </main>

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
        <el-form-item label="绑定 MCP">
          <el-select v-model="editing.mcp_servers" multiple clearable placeholder="未绑定则不可用外部 MCP 工具（安全默认）" style="width: 100%">
            <el-option v-for="s in mcpServers" :key="s.name" :label="s.name" :value="s.name" />
          </el-select>
        </el-form-item>
        <el-form-item label="模型覆盖">
          <el-select v-model="editing.model_override" clearable filterable placeholder="留空使用模型池调度" style="width: 100%">
            <el-option v-for="m in allModels" :key="m.id" :label="m.name || '(未命名模型)'" :value="m.id" />
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

    <!-- MCP 服务编辑弹窗：基础表单 + 可折叠高级 JSON（格式化/校验、测试连接不落盘） -->
    <el-dialog v-model="mcpEditorVisible" :title="editingMcpOriginal ? `编辑 MCP 服务：${editingMcpOriginal}` : '新增 MCP 服务'" width="640px" append-to-body>
      <el-form label-width="90px" size="small">
        <el-form-item label="名称">
          <el-input v-model="editingMcp.name" placeholder="小写字母/数字开头，仅 a-z0-9_-（agent 绑定用此名）" class="mono-input" />
        </el-form-item>
        <el-form-item label="启用"><el-switch v-model="editingMcp.enabled" /></el-form-item>
        <el-form-item label="类型">
          <el-radio-group v-model="editingMcp.type">
            <el-radio value="stdio">stdio（本地命令进程）</el-radio>
            <el-radio value="http">http（远程 Streamable HTTP）</el-radio>
          </el-radio-group>
        </el-form-item>
        <template v-if="editingMcp.type === 'stdio'">
          <el-form-item label="启动命令">
            <el-input v-model="editingMcp.command" placeholder="如 npx / node / python" class="mono-input" />
          </el-form-item>
          <el-form-item label="启动参数">
            <el-input v-model="editingMcp.argsText" placeholder="空格分隔，如：-y @modelcontextprotocol/server-filesystem D:/pxx/projects" class="mono-input" />
          </el-form-item>
        </template>
        <el-form-item v-else label="服务地址">
          <el-input v-model="editingMcp.url" placeholder="http://host:port/mcp" class="mono-input" />
        </el-form-item>
        <el-form-item label="高级设置">
          <div style="width: 100%">
            <el-button size="small" link type="primary" @click="mcpAdvancedOpen = !mcpAdvancedOpen">{{ mcpAdvancedOpen ? '▲ 收起 JSON' : '▼ 展开 JSON' }}</el-button>
            <template v-if="mcpAdvancedOpen">
              <el-input
                v-model="editingMcp.advancedJson"
                type="textarea"
                :rows="10"
                class="mono-input"
                style="margin-top: 4px"
                placeholder='{ "env": {}, "headers": {}, "allow_tools": [], "max_result_chars": 16000, "timeout_sec": 60 }'
              />
              <div class="field-hint">
                除 名称/类型/启用/命令/参数/地址 外的全部字段（env / headers / allow_tools / max_result_chars / timeout_sec 等，可透传任意扩展字段）。
                密钥用 ${ENV_VAR} 占位走环境变量；与基础表单字段冲突时以 JSON 为准。
              </div>
            </template>
          </div>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button size="small" @click="formatMcpJson">格式化/校验</el-button>
        <el-button size="small" :loading="mcpTesting === '__dialog__'" @click="testMcpDialog">测试连接</el-button>
        <el-button size="small" @click="mcpEditorVisible = false">取消</el-button>
        <el-button size="small" type="primary" :loading="mcpSaving" @click="saveMcpDialog">保存到列表</el-button>
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

    <!-- 标签模板管理弹窗：自定义命名标签组合，模型行「模板」下拉一键应用 -->
    <el-dialog v-model="tagTplVisible" title="管理标签模板" width="560px" append-to-body>
      <div class="import-note">给常用标签组合起个名字（如「视觉+推理」），在模型行的「模板」下拉里一键应用。</div>
      <div v-if="!tagTplEditing.length" class="pv-empty">还没有模板——点下方「+ 添加模板」创建第一个。</div>
      <div v-for="(t, ti) in tagTplEditing" :key="ti" class="tpl-row">
        <el-input v-model="t.name" size="small" placeholder="模板名（如：视觉+推理）" class="tpl-name" />
        <el-select v-model="t.tags" multiple filterable allow-create default-first-option size="small" placeholder="标签组合" class="tpl-tags">
          <el-option v-for="x in CAPABILITY_TAGS" :key="x" :label="CAPABILITY_TAG_LABELS[x] || x" :value="x" />
        </el-select>
        <el-button size="small" link type="danger" @click="tagTplEditing.splice(ti, 1)">删除</el-button>
      </div>
      <el-button size="small" style="width: 100%; margin-top: 8px" @click="addTagTemplate">+ 添加模板</el-button>
      <template #footer>
        <el-button size="small" @click="tagTplVisible = false">取消</el-button>
        <el-button size="small" type="primary" :loading="tagTplSaving" @click="saveTagTemplates">保存模板</el-button>
      </template>
    </el-dialog>

    <!-- 长度模板管理弹窗：内置预设只读 + 自定义命名长度值（保存后即为模板按钮） -->
    <el-dialog v-model="lenTplVisible" title="管理长度模板" width="560px" append-to-body>
      <div class="import-note">给常用长度起名（如 <span class="mono">256K = 262144</span>），保存后即为「输出上限 / 上下文」下方的<b>模板按钮</b>，也可在「批量应用长度」中使用。内置预设只读。</div>
      <div class="tpl-row" v-for="t in BUILTIN_LENGTH_TPL" :key="'b' + t.name">
        <el-tag size="small" type="info" style="width: 64px; justify-content: center">内置</el-tag>
        <el-input :model-value="t.name" size="small" disabled class="tpl-name" />
        <el-input :model-value="fmtLen(t.value)" size="small" disabled />
      </div>
      <div v-for="(t, ti) in lenTplEditing" :key="ti" class="tpl-row">
        <el-tag size="small" style="width: 64px; justify-content: center">自定义</el-tag>
        <el-input v-model="t.name" size="small" placeholder="名称 如 200K" class="tpl-name" />
        <el-input-number v-model="t.value" size="small" :min="1" :step="1024" :controls="false" placeholder="数值 如 200000" style="flex: 1" />
        <el-button size="small" link type="danger" @click="lenTplEditing.splice(ti, 1)">删除</el-button>
      </div>
      <el-button size="small" style="width: 100%; margin-top: 8px" @click="addLenTplRow">+ 添加模板</el-button>
      <template #footer>
        <el-button size="small" @click="lenTplVisible = false">取消</el-button>
        <el-button size="small" type="primary" :loading="lenTplSaving" @click="saveLenTpl">保存模板</el-button>
      </template>
    </el-dialog>

    <!-- 批量应用长度弹窗（供应商组级） -->
    <el-dialog v-model="baVisible" :title="`批量应用长度 · ${baGroup?.provider_name || ''}`" width="520px" append-to-body>
      <div class="import-note">
        选择的模板会覆盖该服务下 <b>{{ baCount }}</b> 个模型的对应字段；再点一次可取消选择。应用后需点「保存并热生效」落盘。
      </div>
      <div class="ba-field">
        <div class="ba-label">上下文长度 <span class="ba-preview mono">{{ baSel.ctx === null ? '未选择' : fmtLen(baSel.ctx) }}</span></div>
        <div class="tpl-btns">
          <button v-for="t in allLenTpl" :key="'ba-c' + t.name" class="tpl-btn" :class="{ custom: isCustomTpl(t), picked: baSel.ctx === t.value }" :title="`${t.name} = ${fmtLen(t.value)}`" @click="baPick('ctx', t.value)">{{ t.name }}</button>
          <el-input-number v-model="baManualCtx" size="small" :min="1024" :step="1024" :controls="false" placeholder="手填数值" style="width: 130px" @change="(v: number | undefined) => { baSel.ctx = v ?? null; }" />
        </div>
      </div>
      <div class="ba-field">
        <div class="ba-label">输出上限 <span class="ba-preview mono">{{ baSel.out === null ? '未选择' : fmtLen(baSel.out) }}</span></div>
        <div class="tpl-btns">
          <button v-for="t in allLenTpl" :key="'ba-o' + t.name" class="tpl-btn" :class="{ custom: isCustomTpl(t), picked: baSel.out === t.value }" :title="`${t.name} = ${fmtLen(t.value)}`" @click="baPick('out', t.value)">{{ t.name }}</button>
          <el-input-number v-model="baManualOut" size="small" :min="1024" :step="1024" :controls="false" placeholder="手填数值" style="width: 130px" @change="(v: number | undefined) => { baSel.out = v ?? null; }" />
        </div>
      </div>
      <template #footer>
        <el-button size="small" @click="baVisible = false">取消</el-button>
        <el-button size="small" type="primary" :disabled="!baCount" @click="applyBatch">应用到 {{ baCount }} 个模型</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
/* ============ 布局：左锚点导航 + 右内容 ============ */
.sv-root { height: 100%; display: flex; min-height: 0; overflow: hidden; }
.sv-nav { width: 196px; flex: none; overflow-y: auto; padding: 20px 12px; border-right: 1px solid var(--line); background: var(--bg-panel); }
.sv-cap { font-family: var(--font-mono); font-size: var(--fs-meta); color: var(--text-3); text-transform: uppercase; letter-spacing: 0.08em; margin: 0 8px 10px; }
.sv-item { display: flex; align-items: center; gap: 8px; width: 100%; padding: 7px 10px; margin-bottom: 2px; border: none; border-radius: var(--r-ctl); background: transparent; color: var(--text-2); font-size: 13px; text-align: left; cursor: pointer; font-family: var(--font-ui); }
.sv-item .idx { font-size: var(--fs-meta); color: var(--text-3); width: 18px; flex: none; }
.sv-item:hover { background: var(--bg-raised); color: var(--text-1); }
.sv-item.active { background: var(--accent-soft); color: var(--text-1); font-weight: 600; }
.sv-item.active .idx { color: var(--accent); }
.sv-sep { height: 1px; background: var(--line); margin: 10px 8px; }
.sv-note { padding: 0 8px; font-size: var(--fs-meta); color: var(--text-3); line-height: 1.6; }
.sv-main { flex: 1; min-width: 0; overflow-y: auto; padding: 20px 28px 60px; }
.sv-inner { max-width: 1060px; margin: 0 auto; }
.sv-head { display: flex; align-items: baseline; gap: 12px; margin-bottom: 18px; }
.sv-title { font-size: var(--fs-h2); font-weight: 700; color: var(--text-1); }
.sv-sub { font-size: var(--fs-meta); color: var(--text-3); }
.sv-sec { margin-bottom: 34px; scroll-margin-top: 8px; }
.sec-head { display: flex; align-items: baseline; gap: 10px; margin-bottom: 12px; }
.sec-head h2 { margin: 0; font-size: var(--fs-title); font-weight: 700; color: var(--text-1); }
.sec-head .hint { font-size: var(--fs-meta); color: var(--text-3); }
.mono { font-family: var(--font-mono); }

/* ============ 通用行卡 / 权限 ============ */
.gen, .perm { display: flex; flex-direction: column; gap: 12px; }
.gen-row, .perm-row { display: flex; align-items: center; gap: 16px; padding: 12px 14px; border: 1px solid var(--line); border-radius: 8px; }
.gen-info { flex: 1; min-width: 0; }
.gen-title { font-size: 13px; font-weight: 500; color: var(--text-1); }
.gen-desc { font-size: var(--fs-aux); color: var(--text-3); margin-top: 3px; }
.gen-ctrl { display: flex; align-items: center; gap: 8px; margin-top: 8px; }
.gen-time { font-size: var(--fs-meta); color: var(--text-3); }
.perm-tags { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; padding: 10px 14px; border: 1px dashed var(--line); border-radius: 8px; }
.perm-tag { font-family: var(--font-mono); }
.perm-actions { display: flex; gap: 8px; }

/* ============ 模型池 ============ */
.pool-health { margin-bottom: 14px; }
.pool-health .dtitle {
  font-size: var(--fs-meta); color: var(--text-3); font-family: var(--font-mono);
  letter-spacing: 0.08em; text-transform: uppercase; margin-bottom: 8px;
  display: flex; align-items: center; gap: 8px;
}
.pool-health .dtitle::after { content: ""; flex: 1; height: 1px; background: var(--line); }
.poolrow {
  display: flex; align-items: center; gap: 12px; padding: 7px 10px; margin-bottom: 6px;
  border: 1px solid var(--line); border-radius: var(--r-ctl); background: var(--bg-raised);
}
.poolrow .dot { width: 6px; height: 6px; border-radius: 50%; flex: none; }
.poolrow .dot.ok { background: var(--ok); }
.poolrow .dot.warn { background: var(--warn); }
.poolrow .dot.danger { background: var(--danger); }
.poolrow .nm { font-family: var(--font-mono); font-size: 12.5px; width: 200px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: none; }
.poolrow .mt { font-family: var(--font-mono); font-size: var(--fs-meta); color: var(--text-3); width: 150px; flex: none; }
.poolrow .tags { display: flex; gap: 4px; flex: 1; flex-wrap: wrap; min-width: 0; }
.poolrow .tags .tag { font-size: var(--fs-meta); font-family: var(--font-mono); color: var(--text-2); background: var(--bg-inset); border: 1px solid var(--line); border-radius: 4px; padding: 0 5px; height: 16px; display: inline-flex; align-items: center; }
.poolrow .rt { font-family: var(--font-mono); font-size: var(--fs-meta); color: var(--text-3); flex: none; }

/* ---- 降级路线图 ---- */
.roadmap-box { border: 1px solid var(--line); border-radius: var(--r-panel); background: var(--bg-panel); padding: 14px 16px; margin-bottom: 16px; }
.rm-toolbar { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-bottom: 14px; }
.rm-toolbar .cap { font-size: var(--fs-aux); color: var(--text-2); font-weight: 600; }
.seg { display: inline-flex; border: 1px solid var(--line-strong); border-radius: var(--r-ctl); overflow: hidden; }
.seg button { padding: 3px 10px; font-size: var(--fs-meta); font-family: var(--font-mono); color: var(--text-2); background: var(--bg-page); border: none; cursor: pointer; border-right: 1px solid var(--line); }
.seg button:last-child { border-right: none; }
.seg button.on { background: var(--accent-soft); color: var(--accent); font-weight: 700; }
.rm-legend { margin-left: auto; display: flex; align-items: center; gap: 12px; font-size: var(--fs-meta); color: var(--text-3); flex-wrap: wrap; }
.rm-legend span { display: inline-flex; align-items: center; gap: 4px; }
.rm-chain { display: flex; align-items: stretch; overflow-x: auto; padding: 4px 2px 10px; }
.rm-node { flex: none; width: 208px; border: 1px solid var(--line-strong); border-radius: 8px; background: var(--bg-raised); padding: 9px 11px; position: relative; cursor: grab; }
.rm-node.first { border-color: var(--accent-line); box-shadow: inset 0 0 0 1px var(--accent-line); }
.rm-node.dead { opacity: 0.78; }
.rm-node.dragging { opacity: 0.45; }
.rm-node.drop-before { box-shadow: -3px 0 0 var(--accent); }
.rm-order { position: absolute; top: -9px; left: -9px; width: 20px; height: 20px; border-radius: 50%; background: var(--accent); color: var(--accent-text); font-family: var(--font-mono); font-size: var(--fs-meta); font-weight: 700; display: grid; place-items: center; }
.rm-node.dead .rm-order { background: var(--text-3); }
.rm-name { font-family: var(--font-mono); font-size: 12.5px; font-weight: 700; color: var(--text-1); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.rm-first { font-family: var(--font-mono); font-size: var(--fs-meta); color: var(--accent); border: 1px solid var(--accent-line); border-radius: 4px; padding: 0 4px; margin-left: 4px; font-weight: 400; }
.rm-prov { font-size: var(--fs-meta); color: var(--text-3); margin-top: 1px; }
.rm-meta { display: flex; flex-wrap: wrap; gap: 4px 10px; margin-top: 7px; font-size: var(--fs-meta); color: var(--text-3); }
.rm-meta b { color: var(--text-2); font-weight: 600; }
.rm-state { display: inline-flex; align-items: center; gap: 5px; font-family: var(--font-mono); font-size: var(--fs-meta); margin-top: 7px; }
.rm-state.ok { color: var(--ok); }
.rm-state.warn { color: var(--warn); }
.rm-state.bad { color: var(--danger); }
.rm-state.idle { color: var(--text-3); }
.rm-state .dot { width: 6px; height: 6px; border-radius: 50%; }
.rm-state .dot.ok { background: var(--ok); }
.rm-state .dot.warn { background: var(--warn); }
.rm-state .dot.bad { background: var(--danger); }
.pin { display: flex; align-items: center; gap: 4px; margin-top: 7px; font-family: var(--font-mono); font-size: var(--fs-meta); color: var(--text-3); }
.pin-num { width: 82px; }
.pin-num :deep(.el-input__inner) { font-family: var(--font-mono); font-size: var(--fs-meta); }
.rm-tail { flex: none; width: 150px; border: 1px dashed var(--line-strong); border-radius: 8px; padding: 9px 11px; color: var(--text-2); background: var(--bg-page); }
.rm-tail .rm-name { color: var(--text-2); }
.rm-arrow { flex: none; align-self: center; width: 26px; text-align: center; color: var(--text-3); font-family: var(--font-mono); font-size: 13px; }
.rm-rules { display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; margin-top: 12px; }
.rm-rule { border: 1px solid var(--line); border-radius: var(--r-ctl); background: var(--bg-page); padding: 8px 10px; font-size: var(--fs-meta); color: var(--text-2); line-height: 1.5; }
.rm-rule b { display: block; font-family: var(--font-mono); font-size: var(--fs-meta); color: var(--accent); margin-bottom: 2px; }
.rm-note { font-size: var(--fs-meta); color: var(--text-3); margin-top: 10px; line-height: 1.6; }

/* ---- 服务接入点编辑区 ---- */
.provider-list { display: flex; flex-direction: column; gap: 12px; }
.provider-card { background: var(--bg-page); border: 1px solid var(--line); border-radius: 6px; padding: 12px; }
.pv-head { display: flex; align-items: center; gap: 10px; margin-bottom: 10px; flex-wrap: wrap; }
.pv-title { font-size: 12px; font-weight: 500; color: var(--text-1); }
.pv-host { font-size: var(--fs-meta); color: var(--text-3); max-width: 260px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pv-head .spacer { flex: 1; }
.pv-shared { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 10px; margin-bottom: 6px; }
.pv-empty { font-size: 12px; color: var(--text-3); padding: 6px 0 2px; }
.model-row { border-top: 1px dashed var(--line); padding: 8px 0; display: flex; flex-direction: column; gap: 6px; }
.mr-line { display: flex; align-items: center; gap: 8px; }
.mr-name { width: 200px; flex: none; }
.mr-tags { flex: 1; min-width: 200px; }
.mr-nums { display: grid; grid-template-columns: repeat(6, 1fr); gap: 8px; align-items: start; }
.mr-nums :deep(.el-input-number) { width: 100%; }
.field { display: flex; flex-direction: column; gap: 4px; flex: 1; min-width: 0; }
.field > span { font-size: var(--fs-meta); color: var(--text-3); }
/* 长度模板按钮行 */
.tpl-btns { display: flex; flex-wrap: wrap; gap: 3px; align-items: center; }
.tpl-btn { padding: 1px 6px; font-family: var(--font-mono); font-size: var(--fs-meta); line-height: 1.5; color: var(--text-2); background: var(--bg-inset); border: 1px solid var(--line); border-radius: 4px; cursor: pointer; transition: all 0.12s; }
.tpl-btn:hover { color: var(--accent); border-color: var(--accent-line); background: var(--accent-soft); }
.tpl-btn.custom { color: var(--accent); border-color: var(--accent-line); background: var(--accent-soft); }
.tpl-btn.picked { outline: 2px solid var(--accent); outline-offset: -1px; }
.tpl-manage { padding: 1px 6px; font-size: var(--fs-meta); color: var(--text-3); background: transparent; border: 1px dashed var(--line-strong); border-radius: 4px; cursor: pointer; }
.tpl-manage:hover { color: var(--accent); border-color: var(--accent-line); }
/* 批量应用长度弹窗 */
.ba-field { margin-bottom: 14px; }
.ba-label { font-size: var(--fs-aux); font-weight: 600; color: var(--text-1); margin-bottom: 6px; display: flex; align-items: center; gap: 8px; }
.ba-preview { font-size: var(--fs-meta); color: var(--text-3); font-weight: 400; }
.import-note { font-size: 12px; color: var(--text-3); margin-bottom: 10px; line-height: 1.6; }
.tpl-row { display: flex; align-items: center; gap: 8px; padding: 6px 0; border-top: 1px dashed var(--line); }
.tpl-row:first-of-type { border-top: none; }
.tpl-name { width: 160px; flex: none; }
.tpl-tags { flex: 1; min-width: 180px; }
.tpl-cnt { margin-left: 10px; font-size: var(--fs-meta); color: var(--text-3); }

.toolbar { display: flex; gap: 8px; align-items: center; margin-top: 14px; }
.toolbar .spacer { flex: 1; }
.toolbar .note { flex: 1; font-size: var(--fs-meta); color: var(--text-3); }
.note { font-size: var(--fs-meta); color: var(--text-3); }
.mono-input :deep(textarea) { font-family: var(--font-mono); font-size: 12px; }
.field-hint { font-size: var(--fs-meta); color: var(--el-text-color-secondary); line-height: 1.4; margin-top: 2px; }
.mcp-target { max-width: 240px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; display: inline-block; vertical-align: bottom; }

/* ============ 窄屏：导航收窄为图标列 ============ */
@media (max-width: 900px) {
  .sv-nav { width: 52px; padding: 16px 6px; }
  .sv-nav .sv-cap, .sv-item .txt, .sv-note { display: none; }
  .sv-item { justify-content: center; padding: 8px 0; }
  .pv-shared { grid-template-columns: 1fr; }
  .mr-nums { grid-template-columns: repeat(3, 1fr); }
  .rm-rules { grid-template-columns: 1fr 1fr; }
  .sv-main { padding: 16px 14px 40px; }
}
</style>
