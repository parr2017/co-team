import type { TaskLevel } from './types';

export interface LevelProfile {
  level: TaskLevel;
  label: string;
  /** planner instruction appended for this level */
  planRule: string;
  /** structured docs required by the SSOT pipeline for this level */
  docs: boolean;
  /** max nodes the planner should produce */
  maxNodes: number;
  // ---------- P3 档级驱动执行管线：执行链按档裁剪（轻的是"仪式"，不是"安全"） ----------
  /** 是否走沙箱 worktree + 每节点 git 分支；false = 直接在 execWorkspace 执行（git 任务分支提交兜底） */
  sandbox: boolean;
  /** 合并后验收深度：full=跑全量测试套件；smoke=仅构建冒烟（build 命令） */
  acceptance: 'full' | 'smoke';
  /** 滚动任务的最终清单机审（finalAcceptanceGate）是否执行 */
  finalGate: boolean;
  /** 是否允许滚动规划（false = 强制静态整图） */
  rolling: boolean;
  /** 节点交付报告：true = 一行简版（做了什么/变更/状态），不套全模板 */
  briefDeliverable: boolean;
  /** 任务复盘是否写知识库（typo 级复盘是噪音且膨胀知识库——193MB 知识怪兽教训） */
  knowledge: boolean;
  /** 任务成败是否写全局记忆（占 20 条记忆槽，轻任务纯噪音） */
  memory: boolean;
}

export const LEVEL_PROFILES: Record<TaskLevel, LevelProfile> = {
  light: {
    level: 'light',
    label: '轻量级',
    planRule: '该任务为轻量级：拆解为 1-2 个节点即可，不要生成文档类节点，跳过非必要检查步骤，追求快速完成。',
    docs: false,
    maxNodes: 2,
    sandbox: false,
    acceptance: 'smoke',
    finalGate: false,
    rolling: false,
    briefDeliverable: true,
    knowledge: false,
    memory: false,
  },
  standard: {
    level: 'standard',
    label: '标准级',
    planRule: '该任务为标准级：按常规粒度拆解（4-8 个节点），每个开发节点后紧跟验证节点。',
    docs: true,
    maxNodes: 10,
    sandbox: true,
    acceptance: 'full',
    finalGate: true,
    rolling: true,
    briefDeliverable: false,
    knowledge: true,
    memory: true,
  },
  heavy: {
    level: 'heavy',
    label: '重量级',
    planRule: '该任务为重量级（架构级变更）：拆解务必充分，先有设计/评审节点，再分步实现，每个关键模块单独验证，并在实现前增加一个 review 审查节点把关方案。',
    docs: true,
    maxNodes: 16,
    sandbox: true,
    acceptance: 'full',
    finalGate: true,
    rolling: true,
    briefDeliverable: false,
    knowledge: true,
    memory: true,
  },
};

const HEAVY_PATTERNS = /(重构|架构|迁移|重新设计|整体升级|微服务|拆分模块|引入框架|技术选型|rearchitect|migrat)/i;
const LIGHT_PATTERNS = /(typo|错别字|改文案|文案修改|调整样式|改颜色|颜色|单个文件|单文件|一行|小改动|微调|重命名变量|rename variable)/i;

/**
 * Custom grading keywords injected from config.yaml (improvement 7 / R6).
 * They are APPENDED to the built-in patterns so behavior never changes
 * unless configureGrader is explicitly called at startup.
 */
const customHeavy: string[] = [];
const customLight: string[] = [];

export interface GraderConfig {
  /** extra keywords that classify a task as heavy (appended to built-ins) */
  heavy?: string[];
  /** extra keywords that classify a task as light (appended to built-ins) */
  light?: string[];
}

export function configureGrader(config: GraderConfig): void {
  customHeavy.length = 0;
  customLight.length = 0;
  if (config.heavy?.length) customHeavy.push(...config.heavy.map((k) => String(k)).filter(Boolean));
  if (config.light?.length) customLight.push(...config.light.map((k) => String(k)).filter(Boolean));
}

function matchesAny(text: string, builtin: RegExp, keywords: string[]): boolean {
  if (builtin.test(text)) return true;
  for (const k of keywords) {
    if (text.includes(k)) return true;
  }
  return false;
}

/**
 * Task complexity grading (improvement 7). Rule-based; explicit user override wins.
 * light = trivial tweaks (typo/文案/样式); heavy = architecture-level work or
 * multi-feature descriptions; everything else = standard.
 */
export function gradeTask(description: string): TaskLevel {
  const text = (description || '').trim();
  if (matchesAny(text, HEAVY_PATTERNS, customHeavy)) return 'heavy';
  if (matchesAny(text, LIGHT_PATTERNS, customLight)) return 'light';
  // long, multi-feature descriptions with explicit module boundaries lean heavy
  const featureMarkers = (text.match(/(模块|接口|页面|服务|功能点|并且|同时|以及|此外|第[一二三四五1-5][、，,])/g) || []).length;
  if (featureMarkers >= 4 || text.length > 600) return 'heavy';
  return 'standard';
}

export function normalizeLevel(level?: string | null): TaskLevel | null {
  if (level === 'light' || level === 'standard' || level === 'heavy') return level;
  if (level === 'auto' || level === null || level === undefined || level === '') return null; // auto → grade
  return null;
}
