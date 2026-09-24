/**
 * 模型注入（场景 B）——把 co-team 模型池翻译成 opencode 实例的 provider 配置。
 *
 * managed 实例启动前（manager 的 prepare 钩子）：
 * 1. 在实例 project_root 写 opencode.json：provider 用 `@ai-sdk/openai-compatible`
 *    指向模型池的 OpenAI 兼容接入点；apiKey 用 `{env:COTEAM_OC_KEY_<PROVIDER>}` 占位——
 *    密钥绝不落盘，由钩子回注进 serve 子进程环境变量；
 * 2. 已存在的 opencode.json 做合并写入（保留用户其余配置，providers 深合并），
 *    与已有 provider id 冲突时加 `-coteam` 后缀，绝不静默覆盖用户配置；
 * 3. 顶层 `model` 指向池内首个可用条目，作为 prompt 未显式指定 model 时的兜底。
 *
 * 逐 prompt 的模型选择（scheduler 降级链 → {providerID, modelID}）见 resolveModelRef。
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { getLogger } from '../logger';
import type { ModelConfig } from '../types';
import type { OpencodeInstanceConfig } from './types';
import type { OpencodeManager } from './manager';

/** provider id 归一：小写 kebab（opencode provider id 规范） */
export function sanitizeProviderId(raw: string): string {
  const s = String(raw || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return s || 'coteam';
}

/** provider → 环境变量名（apiKey 占位符引用） */
function keyEnvVar(providerId: string): string {
  return `COTEAM_OC_KEY_${providerId.replace(/-/g, '_').toUpperCase()}`;
}

/** 模型池分组：同 provider 的条目合并为一个 opencode provider（base_url 不一致取首个并告警） */
interface ProviderGroup {
  id: string;
  name: string;
  base_url: string;
  api_key: string;
  models: { id: string; name: string; context_length?: number; max_tokens?: number }[];
}

export function groupPoolByProvider(pool: ModelConfig[]): ProviderGroup[] {
  const groups = new Map<string, ProviderGroup>();
  for (const m of pool) {
    if (!m?.name) continue;
    const id = sanitizeProviderId(m.provider || 'coteam');
    const g = groups.get(id);
    if (!g) {
      groups.set(id, {
        id,
        name: m.provider || 'co-team 模型池',
        base_url: m.base_url || '',
        api_key: m.api_key || '',
        models: [],
      });
    } else if (m.base_url && g.base_url && m.base_url !== g.base_url) {
      getLogger().warn('Opencode model injection: provider base_url mismatch, using first', { provider: id, first: g.base_url, skipped: m.base_url });
    }
    const grp = groups.get(id)!;
    grp.models.push({
      id: m.name,
      name: m.name,
      ...(m.context_length ? { context_length: m.context_length } : {}),
      ...(m.max_tokens ? { max_tokens: m.max_tokens } : {}),
    });
  }
  return [...groups.values()].filter((g) => g.models.length && g.base_url);
}

/** 模型池 → opencode.json 对象（导出供单测对照） */
export function buildOpencodeJson(pool: ModelConfig[], defaultModelRef?: string): Record<string, unknown> {
  const providers: Record<string, unknown> = {};
  for (const g of groupPoolByProvider(pool)) {
    const models: Record<string, unknown> = {};
    for (const m of g.models) {
      models[m.id] = {
        name: m.name,
        ...(m.context_length || m.max_tokens
          ? { limit: { ...(m.context_length ? { context: m.context_length } : {}), ...(m.max_tokens ? { output: m.max_tokens } : {}) } }
          : {}),
      };
    }
    providers[g.id] = {
      npm: '@ai-sdk/openai-compatible',
      name: g.name,
      options: { baseURL: g.base_url, apiKey: `{env:${keyEnvVar(g.id)}}` },
      models,
    };
  }
  const first = groupPoolByProvider(pool)[0]?.models[0];
  const modelRef = defaultModelRef || (first ? `${groupPoolByProvider(pool)[0].id}/${first.id}` : '');
  return {
    $schema: 'https://opencode.ai/config.json',
    // 标记由 co-team 托管：合并写入时识别，用户手动删掉这行后我们再写会整体重建
    'x-coteam-managed': true,
    provider: providers,
    ...(modelRef ? { model: modelRef } : {}),
    // 会话标题等轻任务同样走池内模型，避免 opencode 回落到 Zen 默认模型
    ...(modelRef ? { small_model: modelRef } : {}),
    // 托管实例默认的全部操作都经 co-team 侧权限模型（send/abort 需 control 档），
    // opencode 自身的 permission 保持 ask——关键写操作由 co-team 审批收件箱代答
    permission: { edit: 'ask', bash: 'ask' },
  };
}

/**
 * 写实例的 opencode.json（合并语义：保留用户既有键；provider id 冲突加后缀）。
 * 返回需要注入 serve 进程的 env（provider apiKey）。
 */
export function writeInstanceConfig(projectRoot: string, pool: ModelConfig[]): Record<string, string> {
  const logger = getLogger();
  const file = path.join(projectRoot, 'opencode.json');
  const generated = buildOpencodeJson(pool);
  const env: Record<string, string> = {};
  for (const g of groupPoolByProvider(pool)) {
    if (g.api_key) env[keyEnvVar(g.id)] = g.api_key;
  }
  let merged: Record<string, unknown> = generated;
  try {
    if (fs.existsSync(file)) {
      const existing = JSON.parse(fs.readFileSync(file, 'utf-8')) as Record<string, unknown>;
      merged = { ...existing };
      const genProviders = (generated.provider || {}) as Record<string, unknown>;
      const exProviders = ((existing.provider || {}) as Record<string, unknown>) || {};
      const finalProviders: Record<string, unknown> = { ...exProviders };
      for (const [id, cfg] of Object.entries(genProviders)) {
        let pid = id;
        if (exProviders[pid]) {
          pid = `${id}-coteam`;
          logger.warn('Opencode model injection: provider id collision, using suffixed id', { original: id, suffixed: pid });
        }
        finalProviders[pid] = cfg;
      }
      merged.provider = finalProviders;
      // model 缺省才补，不覆盖用户显式选择
      if (!merged.model && generated.model) merged.model = generated.model;
      if (!merged.small_model && generated.small_model) merged.small_model = generated.small_model;
      merged['x-coteam-managed'] = true;
    }
  } catch (e) {
    logger.warn('Opencode model injection: existing opencode.json unreadable, regenerating', { file, error: String(e).slice(0, 200) });
    merged = generated;
  }
  fs.writeFileSync(file, `${JSON.stringify(merged, null, 2)}\n`, 'utf-8');
  logger.info('Opencode model injection: opencode.json written', {
    file,
    providers: Object.keys((merged.provider || {}) as Record<string, unknown>).length,
    models: groupPoolByProvider(pool).reduce((n, g) => n + g.models.length, 0),
  });
  return env;
}

/**
 * 模型引用解析：co-team 池内模型名 → opencode 的 {providerID, modelID}。
 * W1 的 oc_send / oc_run_task 用它在 prompt 级注入模型（降级链逐个换 ref 重试）。
 */
export function resolveModelRef(pool: ModelConfig[], modelName: string): { providerID: string; modelID: string } | undefined {
  const hit = pool.find((m) => m.name === modelName);
  if (!hit) return undefined;
  return { providerID: sanitizeProviderId(hit.provider || 'coteam'), modelID: hit.name };
}

/** 供 index.ts 装配：给 manager 注册模型注入准备钩子 */
export function registerModelInjection(manager: OpencodeManager, pool: ModelConfig[]): void {
  manager.setPrepareHook(async (cfg: OpencodeInstanceConfig) => {
    if (!cfg.project_root) throw new Error('managed 实例必须配置 project_root');
    return writeInstanceConfig(cfg.project_root, pool);
  });
}
