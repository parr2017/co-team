/**
 * 用户发图（聊天附件）：ingest 即富化的入口收口（2026-09-14）。
 *
 * 架构决策：图片不进主模型——主对话保持 content:string 契约与前缀缓存，发图在
 * 服务端入口统一处理（校验→落盘→视觉旁路生成中文描述→按需拷入 workspace→
 * 富化文本/meta），下游（讨论 transcript、orchestrator 介入注入、ask 等待者）
 * 只消费富化后的文本。视觉分析沿用 tools.ts 的软失败纪律：模型不可用绝不
 * 阻塞发消息，降级为"路径 + 自查指引"。
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ModelPool } from './scheduler';
import { analyzeImages, IMAGE_MEDIA_TYPES, MAX_IMAGE_BYTES } from './vision';
export { IMAGE_MEDIA_TYPES };

export interface IncomingImage {
  /** 原始文件名（仅展示用） */
  name: string;
  /** data:image/...;base64,.... */
  dataUrl: string;
}

/** 落库后随消息持久化的图片引用（前端据此渲染，agent 上下文据此注入） */
export interface StoredImage {
  id: string;
  name: string;
  /** GET /media/:file 相对路径 */
  url: string;
  /** workspace 内相对路径（.coteam/user-images/xxx，look_image 可读；无 workspace 时缺省） */
  wsPath?: string;
  /** 视觉旁路生成的中文描述；软失败时缺省，由消费方降级渲染 */
  desc?: string;
  /** 实际使用的视觉模型名（成功时带，便于观察） */
  descModel?: string;
}

/** 每条消息最多附图数：与气泡九宫格和上下文预算匹配的上限 */
export const MAX_IMAGES_PER_MESSAGE = 3;
/** data/media 保留策略：超量删最旧（与消息裁剪同款纪律） */
export const MEDIA_RETENTION = 500;

const MEDIA_TYPES_REVERSE: Record<string, string> = Object.fromEntries(
  Object.entries(IMAGE_MEDIA_TYPES).map(([ext, mime]) => [mime, ext]),
);
/** 落盘文件名白名单：img-<base36id>.<ext>——GET 路由以此正则拒绝路径穿越 */
export const MEDIA_FILE_RE = /^img-[a-z0-9]{6,14}\.(png|jpg|jpeg|webp|gif|bmp)$/;

export function mediaDir(): string {
  return path.resolve(process.cwd(), 'data', 'media');
}

function newId(): string {
  return Math.random().toString(36).slice(2, 10);
}

/** 保留策略：只留最新 MEDIA_RETENTION 张，超量删最旧（mtime 排序）。测试经 pruneForTest 验证 */
function pruneMediaDir(dir: string): void {
  try {
    const files = fs.readdirSync(dir)
      .map((f) => ({ f, t: fs.statSync(path.join(dir, f)).mtimeMs }))
      .sort((a, b) => a.t - b.t);
    for (const { f } of files.slice(0, Math.max(0, files.length - MEDIA_RETENTION))) {
      try { fs.rmSync(path.join(dir, f)); } catch { /* best-effort */ }
    }
  } catch { /* dir missing — fine */ }
}

/** 对默认目录执行一次保留策略（ingest 后自动调用；测试钩子） */
export function pruneForTest(): void { pruneMediaDir(mediaDir()); }

/**
 * 解析并校验一张 dataURL：返回 {ext, base64}；不合法抛带行动指引的错误
 * （前端直接展示，agent 无关——这是用户输入校验，不是 agent 工具软错误）。
 */
function parseDataUrl(dataUrl: string): { ext: string; base64: string } {
  const m = /^data:([a-zA-Z0-9/+.-]+);base64,(.+)$/s.exec((dataUrl || '').trim());
  if (!m) throw new Error('图片格式不对：仅支持粘贴/上传 png、jpg、webp、gif、bmp');
  const ext = MEDIA_TYPES_REVERSE[m[1].toLowerCase()];
  if (!ext) throw new Error(`不支持的图片类型 ${m[1]}：仅支持 png、jpg、webp、gif、bmp`);
  if (!m[2]) throw new Error('图片内容为空');
  return { ext, base64: m[2] };
}

/**
 * 入口收口：校验→落盘 data/media→（有 workspace 时）拷入 <ws>/.coteam/user-images/
 * →视觉旁路逐图生成中文描述。
 *
 * 视觉描述失败是软失败：StoredImage 照常返回（desc 缺省），由消费方降级为
 * "视觉描述不可用，可 look_image <wsPath> 细看"。绝不因模型全忙/未配置阻塞发消息。
 */
export async function ingestUserImages(
  pool: ModelPool | null,
  images: IncomingImage[],
  opts?: { workspace?: string },
): Promise<{ stored: StoredImage[]; error?: string }> {
  if (!images?.length) return { stored: [] };
  if (images.length > MAX_IMAGES_PER_MESSAGE) {
    return { stored: [], error: `一条消息最多附 ${MAX_IMAGES_PER_MESSAGE} 张图` };
  }
  const dir = mediaDir();
  fs.mkdirSync(dir, { recursive: true });
  const stored: StoredImage[] = [];
  try {
    for (const img of images) {
      const { ext, base64 } = parseDataUrl(img.dataUrl);
      const bytes = Buffer.from(base64, 'base64');
      if (bytes.byteLength > MAX_IMAGE_BYTES) {
        return { stored: [], error: `${img.name || '图片'} 超过 ${Math.round(MAX_IMAGE_BYTES / 1024 / 1024)}MB 上限，请压缩后再发` };
      }
      if (!bytes.byteLength) throw new Error(`${img.name || '图片'} 内容为空`);
      const id = newId();
      const file = `img-${id}${ext}`;
      fs.writeFileSync(path.join(dir, file), bytes);
      const item: StoredImage = { id, name: (img.name || file).slice(0, 80), url: `/media/${file}` };
      if (opts?.workspace) {
        const wsDir = path.join(opts.workspace, '.coteam', 'user-images');
        fs.mkdirSync(wsDir, { recursive: true });
        fs.writeFileSync(path.join(wsDir, file), bytes);
        item.wsPath = `.coteam/user-images/${file}`;
      }
      stored.push(item);
    }
  } catch (e: any) {
    return { stored: [], error: String(e?.message || e) };
  }
  pruneMediaDir(dir);
  // 视觉描述：逐图旁路（模型槽位有限，一问一图比打包更稳）；失败降级不阻塞
  if (pool) {
    for (const item of stored) {
      const file = path.join(dir, path.basename(item.url));
      const ext = path.extname(file).toLowerCase();
      const r = await analyzeImages(pool,
        '用户在聊天中发来这张图片。请用中文客观描述你看到的内容（界面截图请说明是什么页面/有哪些元素；照片请说明主体与场景），150字以内，不要猜测图外信息。',
        [{ base64: fs.readFileSync(file).toString('base64'), mediaType: IMAGE_MEDIA_TYPES[ext] }],
      );
      if (r.ok && r.analysis) {
        item.desc = r.analysis.trim();
        item.descModel = r.model;
      }
    }
  }
  return { stored };
}

/**
 * 把落库图片富化成 agent 可读的文本块（transcript / 介入注入 / ask 回答共用）。
 * 描述缺省时降级为路径自查指引——文字模型至少知道"有图、看哪里"。
 */
export function renderImagesForContext(images: StoredImage[], indexBase = 1): string {
  return images.map((img, i) => {
    const no = indexBase + i;
    if (img.desc) {
      return `[用户附图 ${no}: ${img.name}]\n视觉描述: ${img.desc}${img.wsPath ? `\n原图: ${img.wsPath}（需要更仔细地看细节可用 look_image）` : ''}`;
    }
    return `[用户附图 ${no}: ${img.name}]\n视觉描述不可用${img.wsPath ? `——可执行 look_image 查看工作区内原图 ${img.wsPath}` : '，建议请用户补充文字说明'}`;
  }).join('\n');
}
