import type { Complexity, ModelConfig } from './types';

export interface ModelEntry extends ModelConfig {
  concurrency: number;
  professional_weight: number;
  priority: number;
  tags: string[];
  cost_per_1k: number;
  activeSlots: number;
  failCount: number;
  lastFailureAt: number;
  /** slow-but-successful streak — demotes selection order without cooldown (超时语义重做) */
  slowCount: number;
}

export interface UsageEntry {
  prompt_tokens: number;
  completion_tokens: number;
  calls: number;
  cost: number;
}

export function makeEntry(cfg: ModelConfig): ModelEntry {
  return {
    ...cfg,
    // 兼容旧配置：无 id（调度唯一键）时回退 name——旧池 name 本就全池唯一，新保存的条目总带 id
    id: cfg.id || cfg.name,
    concurrency: cfg.concurrency ?? 4,
    professional_weight: cfg.professional_weight ?? 50,
    priority: cfg.priority ?? 1,
    tags: cfg.tags ?? [],
    cost_per_1k: cfg.cost_per_1k ?? 0,
    max_tokens: cfg.max_tokens ?? 128000,
    context_length: cfg.context_length ?? 131072,
    activeSlots: 0,
    failCount: 0,
    lastFailureAt: 0,
    slowCount: 0,
  };
}

export class ModelPool {
  private models: ModelEntry[];
  private usage = new Map<string, UsageEntry>();
  /** endpoint 组最近一次容量信号（429）时间戳。不落健康分——容量≠无能，到期自愈。 */
  private capacityHits = new Map<string, number>();
  /** 同端点组 429 的软避让窗口 */
  static readonly CAPACITY_AVOID_MS = 60_000;

  constructor(configs: ModelConfig[]) {
    this.models = configs.map(makeEntry);
  }

  /** Hot-replace the pool from new config, preserving usage stats. */
  replaceModels(configs: ModelConfig[]): void {
    this.models = configs.map(makeEntry);
    this.capacityHits.clear();
  }

  /**
   * 配额是跟 key/端点走的，不是跟模型名走的（2026-09-14 群聊全员沉默复盘：池里多个模型
   * 共享一个 api_key，"个别模型 429"实际是整组限流）。同 base_url+api_key 视为一组。
   */
  private endpointKey(m: ModelEntry): string {
    return `${m.base_url}|${m.api_key}`;
  }

  /** 外部报告：该模型所在端点组刚吃了 429（软信号，只影响选择顺序，不进冷却/健康度）。 */
  noteCapacityHit(m: ModelEntry): void {
    this.capacityHits.set(this.endpointKey(m), Date.now());
  }

  /** 该模型所在端点组是否处于限流避让窗口内。 */
  capacityBlocked(m: ModelEntry): boolean {
    const t = this.capacityHits.get(this.endpointKey(m));
    return !!t && Date.now() - t < ModelPool.CAPACITY_AVOID_MS;
  }

  /** 容量稳定度秩（jgfhfaux 复盘）：0 = 近 10 分钟无 429；1 = 近 10 分钟吃过 429 但已出避让窗口；2 = 正处避让窗口。 */
  capacityStabilityRank(m: ModelEntry): 0 | 1 | 2 {
    if (this.capacityBlocked(m)) return 2;
    const t = this.capacityHits.get(this.endpointKey(m));
    return !!t && Date.now() - t < 10 * 60_000 ? 1 : 0;
  }

  /** Cooldown for a model with >=3 consecutive failures, doubling per extra failure (capped at 15 min). */
  cooldownRemainingMs(m: ModelEntry): number {
    if (m.failCount < 3) return 0;
    const window = Math.min(15 * 60_000, 60_000 * Math.pow(2, Math.min(m.failCount - 3, 4)));
    return Math.max(0, m.lastFailureAt + window - Date.now());
  }

  isHealthy(m: ModelEntry): boolean {
    return this.cooldownRemainingMs(m) === 0;
  }

  /** Look up a model entry by id (used for task-pinned main-agent models). */
  getModel(id: string): ModelEntry | null {
    return this.models.find((m) => m.id === id) ?? null;
  }

  availableSlots(m: ModelEntry): number {
    return Math.max(0, m.concurrency - m.activeSlots);
  }

  tryAcquire(m: ModelEntry): boolean {
    if (this.availableSlots(m) <= 0) return false;
    m.activeSlots += 1;
    return true;
  }

  release(m: ModelEntry): void {
    m.activeSlots = Math.max(0, m.activeSlots - 1);
  }

  private filterByTags(models: ModelEntry[], tags?: string[]): ModelEntry[] {
    if (!tags || tags.length === 0) return models;
    const tagSet = new Set(tags.map((t) => t.toLowerCase()));
    const matched = models.filter((m) => m.tags.some((t) => tagSet.has(t.toLowerCase())));
    return matched.length ? matched : models;
  }

  selectModel(tags?: string[], complexity: Complexity = 'normal', opts?: { preferStable?: boolean }): ModelEntry | null {
    const healthy = this.filterByTags(this.models, tags).filter((m) => this.isHealthy(m));
    let available = healthy.filter((m) => this.availableSlots(m) > 0);
    if (available.length === 0) available = this.models.filter((m) => this.isHealthy(m) && this.availableSlots(m) > 0);
    if (available.length === 0) return null;
    // 容量软避让：有未限流的端点组可用就绕开刚吃 429 的组（组全灭则照常返回，由调用方退避）
    const open = available.filter((m) => !this.capacityBlocked(m));
    if (open.length > 0) available = open;

    // heavy 任务容量稳定优先（jgfhfaux 复盘）：429 风暴把 heavy 任务全程逼进降级弱模型是
    // 幻觉交付的诱因——heavy 不做加权随机的"赌运气"，在容量稳定的候选里确定性取最优，
    // 让强模型/稳定端点在风暴期也被优先吃到槽位（并发上限仍由 slot 机制约束）。
    if (opts?.preferStable) {
      return [...available].sort(
        (a, b) =>
          this.capacityStabilityRank(a) - this.capacityStabilityRank(b) ||
          this.effectivePriority(a) - this.effectivePriority(b) ||
          b.professional_weight - a.professional_weight
      )[0];
    }

    if (complexity === 'simple') {
      // cost optimization: cheapest healthy model
      return available.sort((a, b) => this.effectivePriority(a) - this.effectivePriority(b) || a.cost_per_1k - b.cost_per_1k)[0];
    }
    if (complexity === 'complex') {
      return available.sort((a, b) => b.professional_weight - a.professional_weight || this.effectivePriority(a) - this.effectivePriority(b))[0];
    }
    const sorted = [...available].sort((a, b) => this.effectivePriority(a) - this.effectivePriority(b) || b.professional_weight - a.professional_weight);
    const top = sorted.slice(0, Math.max(3, Math.floor(sorted.length / 2)));
    const totalWeight = top.reduce((s, m) => s + m.professional_weight, 0);
    let roll = Math.random() * totalWeight;
    for (const m of top) {
      roll -= m.professional_weight;
      if (roll <= 0) return m;
    }
    return top[top.length - 1];
  }

  /** 池中是否存在带指定 tag 的模型（严格选型的可解释性：区分"未配置"与"全忙"） */
  hasTag(tag: string): boolean {
    return this.models.some((m) => m.tags.some((t) => t.toLowerCase() === tag.toLowerCase()));
  }

  /**
   * 协作会话/子智能体的主模型选择（2026-09-20 修复）：normal 档加权随机会在多组 priority=1
   * 的弱闲聊模型并池时把它们送进 top 档，会话主模型被选成"只会聊天不动手"的模型。
   * 这里改为按 professional_weight 取强模型（同权重再按有效优先级排序），保证会话主模型
   * 偏向能干活的高质量模型；容量软避让与 slot 检查逻辑与 selectModel 同源。
   * P0.6 池隔离（ignoreCooldown）：任务管线 markFailure 的冷却与健康分是任务侧启发式，
   * 不该饿死协作会话——会话侧在常规选型返回 null 时以此兜底（宁撞一次也不哑火）。
   */
  selectStrongModel(tags?: string[], opts?: { ignoreCooldown?: boolean }): ModelEntry | null {
    const healthOk = (m: ModelEntry) => opts?.ignoreCooldown || this.isHealthy(m);
    const healthy = this.filterByTags(this.models, tags).filter((m) => healthOk(m));
    let available = healthy.filter((m) => this.availableSlots(m) > 0);
    if (available.length === 0) available = this.models.filter((m) => healthOk(m) && this.availableSlots(m) > 0);
    if (available.length === 0) return null;
    const open = available.filter((m) => !this.capacityBlocked(m));
    if (open.length > 0) available = open;
    return [...available].sort(
      (a, b) => b.professional_weight - a.professional_weight || this.effectivePriority(a) - this.effectivePriority(b)
    )[0] || null;
  }

  /**
   * 严格 image 定点选型（多模态旁路 screenshot/look_image 专用）：只在带 image tag
   * 的健康模型中按 normal 档加权随机，绝不回退全池——纯文本模型收到图只会产出
   * 垃圾结论，宁缺毋滥。无候选（未配置/全忙/冷却）返回 null，由工具层给软错误与
   * 文本降级指引（vision.ts analyzeImages）。
   */
  selectVisionModel(): ModelEntry | null {
    const candidates = this.models.filter(
      (m) => m.tags.some((t) => t.toLowerCase() === 'image') && this.isHealthy(m) && this.availableSlots(m) > 0
    );
    if (!candidates.length) return null;
    const sorted = [...candidates].sort((a, b) => this.effectivePriority(a) - this.effectivePriority(b) || b.professional_weight - a.professional_weight);
    const top = sorted.slice(0, Math.max(2, Math.floor(sorted.length / 2)));
    const totalWeight = top.reduce((s, m) => s + m.professional_weight, 0);
    let roll = Math.random() * totalWeight;
    for (const m of top) {
      roll -= m.professional_weight;
      if (roll <= 0) return m;
    }
    return top[top.length - 1];
  }

  /** 有序降级链：primary 之后按优先级排健康模型（容量命中端点组沉底，不剔除——全灭时仍可硬撞）。 */
  fallbackChain(primary: ModelEntry, tags?: string[]): ModelEntry[] {
    const rest = this.filterByTags(this.models, tags)
      .filter((m) => m !== primary && this.isHealthy(m))
      .sort(
        (a, b) =>
          Number(this.capacityBlocked(a)) - Number(this.capacityBlocked(b)) ||
          this.effectivePriority(a) - this.effectivePriority(b) ||
          b.professional_weight - a.professional_weight
      );
    return [primary, ...rest];
  }

  /**
   * Last-resort capacity (feature: 降级策略优化): models with free slots IGNORING the
   * cooldown circuit breaker, ordered by priority. Used only after the regular
   * selection and the wait window both come up empty — breaking the glass beats
   * failing the node while the main agent could still run it.
   */
  emergencyCandidates(): ModelEntry[] {
    return this.models
      .filter((m) => this.availableSlots(m) > 0)
      .sort((a, b) => this.effectivePriority(a) - this.effectivePriority(b) || b.professional_weight - a.professional_weight);
  }

  markFailure(m: ModelEntry): void {
    m.failCount += 1;
    m.lastFailureAt = Date.now();
  }

  markSuccess(m: ModelEntry): void {
    m.failCount = 0;
    m.slowCount = 0;
  }

  /** 慢但成功：不是失败（不进冷却），只降权——本地慢模型与快模型混池时的正确记账方式 */
  markSlow(m: ModelEntry): void {
    m.failCount = 0;
    m.slowCount += 1;
  }

  /**
   * 选择/降级链排序用的有效优先级：慢成功降一级；失败降两级且 30 分钟线性回血。
   * M4（2y3tuote 实证）：此前失败只进 cooldown，冷却一过坏模型立刻弹回链首——
   * 33 次失败没有改变过任何一次首撞顺序。冷却是硬闸，这是软序。
   */
  effectivePriority(m: ModelEntry): number {
    let failPenalty = 0;
    if (m.failCount > 0 && m.lastFailureAt) {
      const decay = Math.max(0.25, 1 - (Date.now() - m.lastFailureAt) / (30 * 60_000));
      failPenalty = Math.round(m.failCount * 2 * decay);
    }
    return m.priority + m.slowCount + failPenalty;
  }

  recordUsage(modelId: string, promptTokens: number, completionTokens: number): void {
    const entry = this.models.find((m) => m.id === modelId);
    const cost = entry ? ((promptTokens + completionTokens) / 1000) * entry.cost_per_1k : 0;
    const u = this.usage.get(modelId) || { prompt_tokens: 0, completion_tokens: 0, calls: 0, cost: 0 };
    u.prompt_tokens += promptTokens;
    u.completion_tokens += completionTokens;
    u.calls += 1;
    u.cost = Math.round((u.cost + cost) * 1e6) / 1e6;
    this.usage.set(modelId, u);
  }

  totalTokens(): number {
    return [...this.usage.values()].reduce((s, u) => s + u.prompt_tokens + u.completion_tokens, 0);
  }

  totalCost(): number {
    return Math.round([...this.usage.values()].reduce((s, u) => s + u.cost, 0) * 1e6) / 1e6;
  }

  totalAvailable(): number {
    return this.models.reduce((s, m) => s + this.availableSlots(m), 0);
  }

  /** Free slots on healthy models only — the capacity a new task can actually use. */
  usableCapacity(): number {
    return this.models.filter((m) => this.isHealthy(m)).reduce((s, m) => s + this.availableSlots(m), 0);
  }

  getUsage(): Record<string, UsageEntry> {
    return Object.fromEntries(this.usage);
  }

  getStatus(): Record<string, unknown> {
    return Object.fromEntries(
      this.models.map((m) => [
        m.id,
        {
          name: m.name,
          provider: m.provider,
          concurrency: m.concurrency,
          active: m.activeSlots,
          available: this.availableSlots(m),
          priority: m.priority,
          tags: m.tags,
          healthy: this.isHealthy(m),
          fail_count: m.failCount,
          slow_count: m.slowCount,
          effective_priority: this.effectivePriority(m),
          cooldown_ms: this.cooldownRemainingMs(m),
          cost_per_1k: m.cost_per_1k,
        },
      ])
    );
  }
}
