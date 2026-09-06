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
    concurrency: cfg.concurrency ?? 4,
    professional_weight: cfg.professional_weight ?? 50,
    priority: cfg.priority ?? 1,
    tags: cfg.tags ?? [],
    cost_per_1k: cfg.cost_per_1k ?? 0,
    activeSlots: 0,
    failCount: 0,
    lastFailureAt: 0,
  };
}

export class ModelPool {
  private models: ModelEntry[];
  private usage = new Map<string, UsageEntry>();

  constructor(configs: ModelConfig[]) {
    this.models = configs.map(makeEntry);
  }

  /** Hot-replace the pool from new config, preserving usage stats. */
  replaceModels(configs: ModelConfig[]): void {
    this.models = configs.map(makeEntry);
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

  /** Look up a model entry by name (used for task-pinned main-agent models). */
  getModel(name: string): ModelEntry | null {
    return this.models.find((m) => m.name === name) ?? null;
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

  selectModel(tags?: string[], complexity: Complexity = 'normal'): ModelEntry | null {
    const healthy = this.filterByTags(this.models, tags).filter((m) => this.isHealthy(m));
    let available = healthy.filter((m) => this.availableSlots(m) > 0);
    if (available.length === 0) available = this.models.filter((m) => this.isHealthy(m) && this.availableSlots(m) > 0);
    if (available.length === 0) return null;

    if (complexity === 'simple') {
      // cost optimization: cheapest healthy model
      return available.sort((a, b) => a.priority - b.priority || a.cost_per_1k - b.cost_per_1k)[0];
    }
    if (complexity === 'complex') {
      return available.sort((a, b) => b.professional_weight - a.professional_weight || a.priority - b.priority)[0];
    }
    const sorted = [...available].sort((a, b) => a.priority - b.priority || b.professional_weight - a.professional_weight);
    const top = sorted.slice(0, Math.max(3, Math.floor(sorted.length / 2)));
    const totalWeight = top.reduce((s, m) => s + m.professional_weight, 0);
    let roll = Math.random() * totalWeight;
    for (const m of top) {
      roll -= m.professional_weight;
      if (roll <= 0) return m;
    }
    return top[top.length - 1];
  }

  /** Ordered degradation list: primary first, then remaining healthy models by priority. */
  fallbackChain(primary: ModelEntry, tags?: string[]): ModelEntry[] {
    const rest = this.filterByTags(this.models, tags)
      .filter((m) => m.name !== primary.name && this.isHealthy(m))
      .sort((a, b) => a.priority - b.priority || b.professional_weight - a.professional_weight);
    return [primary, ...rest];
  }

  markFailure(m: ModelEntry): void {
    m.failCount += 1;
    m.lastFailureAt = Date.now();
  }

  markSuccess(m: ModelEntry): void {
    m.failCount = 0;
  }

  recordUsage(modelName: string, promptTokens: number, completionTokens: number): void {
    const entry = this.models.find((m) => m.name === modelName);
    const cost = entry ? ((promptTokens + completionTokens) / 1000) * entry.cost_per_1k : 0;
    const u = this.usage.get(modelName) || { prompt_tokens: 0, completion_tokens: 0, calls: 0, cost: 0 };
    u.prompt_tokens += promptTokens;
    u.completion_tokens += completionTokens;
    u.calls += 1;
    u.cost = Math.round((u.cost + cost) * 1e6) / 1e6;
    this.usage.set(modelName, u);
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
        m.name,
        {
          concurrency: m.concurrency,
          active: m.activeSlots,
          available: this.availableSlots(m),
          priority: m.priority,
          tags: m.tags,
          healthy: this.isHealthy(m),
          fail_count: m.failCount,
          cooldown_ms: this.cooldownRemainingMs(m),
          cost_per_1k: m.cost_per_1k,
        },
      ])
    );
  }
}
