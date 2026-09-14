/**
 * 用户发图（media.ts）单测：校验门、落盘与 workspace 拷贝、视觉软失败降级。
 * 视觉旁路不真调模型——analyzeImages 走 vision.ts 内部池逻辑，测试池不配置
 * image tag 模型即命中"未配置"软失败路径，与 tools.ts 的视觉纪律同源。
 */
import { describe, expect, it, beforeEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

vi.setConfig({ testTimeout: 30000 });

const { ingestUserImages, renderImagesForContext, mediaDir, MEDIA_FILE_RE, MAX_IMAGES_PER_MESSAGE, pruneForTest } = await import('../src/media');
import { ModelPool } from '../src/scheduler';

/** 1x1 红色 PNG 的 dataURL（无需依赖 canvas） */
const TINY_PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

let tmpDir: string;
let poolNoVision: ModelPool;

beforeEach(() => {
  // media.ts 用 process.cwd()/data/media 落盘：把 cwd 指到临时目录，测试互不污染
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-media-'));
  process.chdir(tmpDir);
  fs.mkdirSync(path.join(tmpDir, 'data'), { recursive: true });
  // 无 image tag 模型池：视觉描述走"未配置"软失败（desc 缺省，消息不被阻塞）
  poolNoVision = new ModelPool([{ name: 'text-only', api_key: 'k', base_url: 'u', priority: 1, professional_weight: 50, cost_per_1k: 0, tags: ['code'] }]);
});

describe('ingestUserImages：校验门', () => {
  it('拒绝超量附图（>3 张）', async () => {
    const imgs = Array.from({ length: MAX_IMAGES_PER_MESSAGE + 1 }, (_, i) => ({ name: `i${i}.png`, dataUrl: TINY_PNG }));
    const r = await ingestUserImages(poolNoVision, imgs);
    expect(r.error).toBeTruthy();
    expect(r.error).toMatch(/最多/);
    expect(r.stored).toHaveLength(0);
  });

  it('拒绝不支持的 mime 与空内容', async () => {
    const bad = await ingestUserImages(poolNoVision, [{ name: 'x.tiff', dataUrl: 'data:image/tiff;base64,AAAA' }]);
    expect(bad.error).toMatch(/不支持的图片类型/);
    const empty = await ingestUserImages(poolNoVision, [{ name: 'x.png', dataUrl: 'not-a-dataurl' }]);
    expect(empty.error).toBeTruthy();
  });

  it('拒绝超过 10MB 的图', async () => {
    // 构造 >10MB 的"png" dataURL（内容字节数按 base64 解码计）
    const big = Buffer.alloc(10 * 1024 * 1024 + 1024, 1).toString('base64');
    const r = await ingestUserImages(poolNoVision, [{ name: 'big.png', dataUrl: `data:image/png;base64,${big}` }]);
    expect(r.error).toMatch(/超过.*上限/);
  });
});

describe('ingestUserImages：落盘与 workspace 拷贝', () => {
  it('无 workspace：只落 data/media，url 可回读', async () => {
    const r = await ingestUserImages(poolNoVision, [{ name: 'shot.png', dataUrl: TINY_PNG }]);
    expect(r.error).toBeUndefined();
    expect(r.stored).toHaveLength(1);
    const s = r.stored[0];
    expect(s.url).toMatch(/^\/media\/img-[a-z0-9]+\.(png|jpg|jpeg|webp|gif|bmp)$/);
    expect(s.wsPath).toBeUndefined();
    expect(s.desc).toBeUndefined(); // 无视觉模型 → 软失败，不阻塞
    expect(MEDIA_FILE_RE.test(path.basename(s.url))).toBe(true);
    // 文件真实存在且可读
    const file = path.join(mediaDir(), path.basename(s.url));
    expect(fs.existsSync(file)).toBe(true);
    expect(fs.statSync(file).size).toBeGreaterThan(50);
  });

  it('带 workspace：拷入 .coteam/user-images（look_image 可读的相对路径）', async () => {
    const ws = path.join(tmpDir, 'proj');
    fs.mkdirSync(ws, { recursive: true });
    const r = await ingestUserImages(poolNoVision, [{ name: 'ui.png', dataUrl: TINY_PNG }], { workspace: ws });
    const s = r.stored[0];
    expect(s.wsPath).toMatch(/^\.coteam\/user-images\/img-/);
    expect(fs.existsSync(path.join(ws, s.wsPath!))).toBe(true);
  });
});

describe('视觉软失败与富化渲染', () => {
  it('无视觉模型：desc 缺省 + 富化文本降级为自查/追问指引', async () => {
    const r = await ingestUserImages(poolNoVision, [{ name: 'a.png', dataUrl: TINY_PNG }]);
    const s = r.stored[0];
    expect(s.desc).toBeUndefined();
    const text = renderImagesForContext(r.stored);
    expect(text).toContain('[用户附图 1: a.png]');
    expect(text).toContain('视觉描述不可用');
  });

  it('有描述时：富化文本带视觉描述与 look_image 指引', () => {
    const text = renderImagesForContext([
      { id: '1', name: 'ui.png', url: '/media/img-x.png', wsPath: '.coteam/user-images/img-x.png', desc: '登录页截图，含账号密码输入框' },
      { id: '2', name: 'err.png', url: '/media/img-y.png', wsPath: '.coteam/user-images/img-y.png' },
    ]);
    expect(text).toContain('[用户附图 1: ui.png]');
    expect(text).toContain('视觉描述: 登录页截图，含账号密码输入框');
    expect(text).toContain('look_image');
    expect(text).toContain('[用户附图 2: err.png]');
    expect(text).toContain('视觉描述不可用');
  });
});

describe('GET /media/:file 白名单', () => {
  it('文件名正则拒绝路径穿越与任意名', () => {
    expect(MEDIA_FILE_RE.test('img-abc123.png')).toBe(true);
    expect(MEDIA_FILE_RE.test('img-abc123.jpg')).toBe(true);
    expect(MEDIA_FILE_RE.test('img-abc123.bmp')).toBe(true);
    expect(MEDIA_FILE_RE.test('../../config.yaml')).toBe(false);
    expect(MEDIA_FILE_RE.test('img-..\\..\\x.png')).toBe(false);
    expect(MEDIA_FILE_RE.test('evil.php')).toBe(false);
    expect(MEDIA_FILE_RE.test('img-short.png.png')).toBe(false);
  });
});

describe('保留策略', () => {
  it('超量删最旧（只留最新 MEDIA_RETENTION 张）', async () => {
    const { MEDIA_RETENTION } = await import('../src/media');
    const dir = mediaDir();
    fs.mkdirSync(dir, { recursive: true });
    // 造 RETENTION+5 个"旧"文件（mtime 早于新文件即可）
    const old = new Date(Date.now() - 3600_000);
    for (let i = 0; i < MEDIA_RETENTION + 5; i++) {
      const f = path.join(dir, `img-old${String(i).padStart(4, '0')}.png`);
      fs.writeFileSync(f, 'x');
      fs.utimesSync(f, old, old);
    }
    pruneForTest();
    const left = fs.readdirSync(dir).filter((f) => f.startsWith('img-'));
    expect(left.length).toBeLessThanOrEqual(MEDIA_RETENTION);
  });
});
