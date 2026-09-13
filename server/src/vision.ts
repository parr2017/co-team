/**
 * 多模态旁路（vision side-call）：screenshot / look_image 工具的视觉服务实现。
 *
 * 架构决策（2026-09-13）：主对话模型保持纯文本（content:string + 静态前缀缓存），
 * 图片只在这条旁路里以 OpenAI content 分片数组形态存在——vision 模型按需定点调度
 * （image tag 严格模式，绝不回退全池），文字结论以普通工具结果回流主上下文。
 * 看图是 UI 测试的辅助手段（Playwright E2E 仍是主门槛），失败一律软错误 + 文本降级指引。
 */
import type { ModelEntry, ModelPool } from './scheduler';
import { chatVision } from './llm';

export interface VisionResult {
  ok: boolean;
  analysis?: string;
  error?: string;
  /** true = 暂时性失败（模型全忙/冷却），稍后重试可能成功；false/缺省 = 不可重试 */
  retryable?: boolean;
  /** 实际使用的视觉模型名（成功与失败都带，便于观察） */
  model?: string;
}

/** tools.ts 通过此桥使用视觉服务，保持无状态、不感知模型池 */
export interface VisionBridge {
  analyze(prompt: string, images: { base64: string; mediaType: string }[]): Promise<VisionResult>;
}

/** 单图大小上限：base64 后约 13MB 注入，超过直接拒绝并让 agent 压缩 */
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

export const IMAGE_MEDIA_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.bmp': 'image/bmp',
};

/** 全忙时的槽位等待窗（工具级短等待，不同于节点的 model_wait_timeout_sec） */
const BUSY_WAIT_MS = 15_000;
/** 分析文本限幅：单次工具结果有 24000 字符总预算，视觉结论不该占大头 */
const MAX_ANALYSIS_CHARS = 4000;

function truncateAnalysis(s: string): string {
  return s.length > MAX_ANALYSIS_CHARS ? `${s.slice(0, MAX_ANALYSIS_CHARS)}\n…（视觉分析超长已截断）` : s;
}

/** 持续尝试获取一个有空闲槽位的 vision 模型，等待窗内拿不到返回 null */
async function acquireVision(pool: ModelPool, waitMs: number): Promise<ModelEntry | null> {
  const deadline = Date.now() + Math.max(0, waitMs);
  for (;;) {
    const entry = pool.selectVisionModel();
    if (entry && pool.tryAcquire(entry)) return entry;
    if (!entry || Date.now() >= deadline) return null;
    await new Promise((r) => setTimeout(r, 400));
  }
}

/**
 * 视觉分析一次调用：严格 image 选型 → 容量等待 → chatVision → 池记账（复用
 * cooldown/effectivePriority/usage 体系）。所有失败转 VisionResult 软错误，
 * 错误文案自带文本降级指引（check_page / 源码审查 / 注明需人工复核）。
 */
export async function analyzeImages(pool: ModelPool, prompt: string, images: { base64: string; mediaType: string }[]): Promise<VisionResult> {
  if (!images.length) return { ok: false, error: '没有可分析的图片' };
  const entry = await acquireVision(pool, BUSY_WAIT_MS);
  if (!entry) {
    const configured = pool.hasTag('image');
    return {
      ok: false,
      retryable: configured,
      error: configured
        ? `视觉模型当前全忙或冷却中（已等待 ${Math.round(BUSY_WAIT_MS / 1000)}s 仍无空闲，属可重试失败——可稍后重试本工具）；期间可先用 check_page 做文本渲染验证`
        : '模型池未配置带 image tag 的视觉模型——请改用 check_page（文本渲染验证）与源码审查替代，并在报告中注明"视觉项未经机器验证，需人工复核"',
    };
  }
  try {
    const resp = await chatVision(entry, prompt, images);
    pool.recordUsage(entry.name, resp.promptTokens, resp.completionTokens);
    if (!resp.content.trim()) {
      pool.markFailure(entry);
      return { ok: false, retryable: true, model: entry.name, error: `视觉模型 ${entry.name} 返回空分析（可稍后重试）` };
    }
    pool.markSuccess(entry);
    return { ok: true, analysis: truncateAnalysis(resp.content.trim()), model: entry.name };
  } catch (e: any) {
    pool.markFailure(entry);
    return { ok: false, retryable: false, model: entry.name, error: `视觉分析失败（${entry.name}）：${String(e?.message || e).slice(0, 200)}` };
  } finally {
    pool.release(entry);
  }
}
