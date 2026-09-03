import type { AgentPlugin } from './agents';

export interface RouteRule {
  pattern: string;
  action: string;
  match_tags?: string[];
}

export const DEFAULT_RULES: RouteRule[] = [
  { pattern: '(测试|test|用例)', action: 'test', match_tags: ['test'] },
  { pattern: '(部署|发布|deploy)', action: 'deploy', match_tags: ['deploy'] },
  { pattern: '(审查|review|检查)', action: 'review', match_tags: ['review'] },
];

export class Router {
  private plugins: Map<string, AgentPlugin>;
  private rules: RouteRule[];
  private llmRouter: ((description: string, available: string[]) => Promise<string | null>) | null;

  constructor(
    plugins: AgentPlugin[],
    rules: RouteRule[] = DEFAULT_RULES,
    llmRouter?: (description: string, available: string[]) => Promise<string | null>
  ) {
    this.plugins = new Map(plugins.map((p) => [p.name, p]));
    this.rules = rules;
    this.llmRouter = llmRouter ?? null;
  }

  getAvailable(): Map<string, AgentPlugin> {
    return this.plugins;
  }

  async route(task: { description?: string; tags?: string[] }): Promise<string> {
    const byRule = this.matchRules(task);
    if (byRule) return byRule;
    const description = task.description || '';
    if (this.llmRouter && this.plugins.size > 1) {
      try {
        const picked = await this.llmRouter(description, [...this.plugins.keys()]);
        if (picked && this.plugins.has(picked)) return picked;
      } catch {
        /* fall through to keyword routing */
      }
    }
    return this.keywordRoute(task);
  }

  private matchRules(task: { description?: string; tags?: string[] }): string | null {
    const description = task.description || '';
    for (const rule of this.rules) {
      if (new RegExp(rule.pattern, 'i').test(description) && this.plugins.has(rule.action)) return rule.action;
      for (const tag of task.tags || []) {
        if (rule.match_tags?.includes(tag) && this.plugins.has(rule.action)) return rule.action;
      }
    }
    return null;
  }

  private keywordRoute(task: { description?: string; tags?: string[] }): string {
    const available = [...this.plugins.keys()];
    if (available.length === 1) return available[0];

    const taskTags = new Set((task.tags || []).map((t) => t.toLowerCase()));
    for (const [name, plugin] of this.plugins) {
      if (plugin.tags.some((t) => taskTags.has(t.toLowerCase()))) return name;
    }

    const description = (task.description || '').toLowerCase();
    const groups: [string[], string[]][] = [
      [['代码', '实现', '开发', '函数', '类', '模块', 'api'], ['dev', 'develop']],
      [['测试', 'test', '用例'], ['test']],
      [['部署', '发布', 'docker', 'server'], ['deploy']],
      [['审查', 'review', '检查'], ['review']],
    ];
    for (const [keywords, candidates] of groups) {
      if (keywords.some((k) => description.includes(k))) {
        for (const c of candidates) if (this.plugins.has(c)) return c;
      }
    }
    return available[0];
  }
}
