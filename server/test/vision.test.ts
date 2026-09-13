import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import { ModelPool } from '../src/scheduler';
import { analyzeImages, IMAGE_MEDIA_TYPES, MAX_IMAGE_BYTES } from '../src/vision';
import { applyToolCalls, checkPage, lookImage, screenshotPage } from '../src/tools';

const WS = path.resolve(os.tmpdir(), `coteam-vision-test-${Date.now()}`);
const VISION_BRIDGE = {
  analyze: async (prompt: string) => ({ ok: true, analysis: `视觉分析结果（prompt ${prompt.length} 字）` }),
};

beforeAll(() => {
  fs.mkdirSync(WS, { recursive: true });
});

afterAll(() => {
  fs.rmSync(WS, { recursive: true, force: true });
});

// 最小合法 PNG（1x1 像素）
const TINY_PNG = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c626001000000ffff03000006000557bfabd40000000049454e44ae426082',
  'hex'
);

describe('ModelPool.selectVisionModel（严格 image 定点选型）', () => {
  it('只选带 image tag 的模型，绝不回退全池', () => {
    const pool = new ModelPool([
      { name: 'text-model', api_key: 'k', base_url: 'http://localhost:9', tags: ['code'] },
      { name: 'vision-model', api_key: 'k', base_url: 'http://localhost:9', tags: ['image', 'doc'] },
    ]);
    for (let i = 0; i < 20; i++) {
      const m = pool.selectVisionModel();
      expect(m?.name).toBe('vision-model');
    }
  });

  it('池内无 image 模型时返回 null（不静默降级到纯文本模型）', () => {
    const pool = new ModelPool([{ name: 'text-only', api_key: 'k', base_url: 'http://localhost:9', tags: ['code'] }]);
    expect(pool.selectVisionModel()).toBeNull();
    expect(pool.hasTag('image')).toBe(false);
  });

  it('image 模型全忙或冷却时返回 null', () => {
    const pool = new ModelPool([{ name: 'vision', api_key: 'k', base_url: 'http://localhost:9', tags: ['image'], concurrency: 1 }]);
    const m = pool.selectVisionModel()!;
    expect(m).not.toBeNull();
    pool.tryAcquire(m);
    expect(pool.selectVisionModel()).toBeNull(); // 槽位占满
    pool.release(m);
    pool.markFailure(m); pool.markFailure(m); pool.markFailure(m); // 连续 3 次失败进冷却
    expect(pool.selectVisionModel()).toBeNull();
    expect(pool.hasTag('image')).toBe(true);
  });
});

describe('analyzeImages（软错误分型）', () => {
  it('未配置 image 模型 → 不可重试软错误 + 文本降级指引', async () => {
    const pool = new ModelPool([{ name: 'text-only', api_key: 'k', base_url: 'http://localhost:9', tags: ['code'] }]);
    const r = await analyzeImages(pool, '看图', [{ base64: 'aGk=', mediaType: 'image/png' }]);
    expect(r.ok).toBe(false);
    expect(r.retryable).toBe(false);
    expect(r.error).toContain('未配置');
    expect(r.error).toContain('需人工复核');
  });

  it('image 模型全忙 → 等待后可重试软错误', async () => {
    const pool = new ModelPool([{ name: 'vision', api_key: 'k', base_url: 'http://localhost:9', tags: ['image'], concurrency: 1 }]);
    const m = pool.getModel('vision')!;
    pool.tryAcquire(m);
    const r = await analyzeImages(pool, '看图', [{ base64: 'aGk=', mediaType: 'image/png' }]);
    expect(r.ok).toBe(false);
    expect(r.retryable).toBe(true);
    expect(r.error).toContain('可重试') || expect(r.error).toContain('稍后');
  });

  it('空图片数组 → 直接拒绝', async () => {
    const pool = new ModelPool([{ name: 'vision', api_key: 'k', base_url: 'http://localhost:9', tags: ['image'] }]);
    const r = await analyzeImages(pool, '看图', []);
    expect(r.ok).toBe(false);
    expect(r.error).toContain('没有可分析的图片');
  });
});

describe('lookImage', () => {
  it('越界路径拒绝（目录监狱）', async () => {
    const r = await lookImage(WS, '../outside.png', undefined, VISION_BRIDGE);
    expect(r.ok).toBe(false);
    expect(r.error).toContain('outside workspace');
  });

  it('不支持的图片扩展拒绝', async () => {
    fs.writeFileSync(path.join(WS, 'evil.exe'), 'MZ');
    const r = await lookImage(WS, 'evil.exe', undefined, VISION_BRIDGE);
    expect(r.ok).toBe(false);
    expect(r.error).toContain('不支持的图片格式');
  });

  it('文件不存在 → file not found', async () => {
    const r = await lookImage(WS, 'missing.png', undefined, VISION_BRIDGE);
    expect(r.ok).toBe(false);
    expect(r.error).toContain('file not found');
  });

  it('超过大小上限拒绝', async () => {
    const big = path.join(WS, 'big.png');
    fs.writeFileSync(big, Buffer.alloc(MAX_IMAGE_BYTES + 1));
    const r = await lookImage(WS, 'big.png', undefined, VISION_BRIDGE);
    expect(r.ok).toBe(false);
    expect(r.error).toContain('MB');
  });

  it('vision bridge 缺失 → 软错误门控', async () => {
    fs.writeFileSync(path.join(WS, 'a.png'), TINY_PNG);
    const r = await lookImage(WS, 'a.png', undefined, undefined);
    expect(r.ok).toBe(false);
    expect(r.error).toContain('vision bridge');
  });

  it('合法图片经 bridge 返回文字分析', async () => {
    fs.writeFileSync(path.join(WS, 'shot.png'), TINY_PNG);
    const r = await lookImage(WS, 'shot.png', '按钮是否溢出', VISION_BRIDGE);
    expect(r.ok).toBe(true);
    expect(r.analysis).toContain('视觉分析结果');
  });

  it('applyToolCalls 路由：look_image 结果带 tool 字段回流', async () => {
    fs.writeFileSync(path.join(WS, 'pw-shot.png'), TINY_PNG);
    const results = await applyToolCalls(WS, [{ tool: 'look_image', path: 'pw-shot.png', question: '布局是否正常' }], { agent: 'test', vision: VISION_BRIDGE });
    expect(results[0]).toMatchObject({ tool: 'look_image', ok: true });
  });
});

describe('screenshotPage（校验层，不依赖浏览器/真实模型）', () => {
  it('URL 无效拒绝', async () => {
    const r = await screenshotPage(WS, 'not-a-url', { vision: VISION_BRIDGE });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('URL 无效');
  });

  it('非 http(s) 协议拒绝', async () => {
    const r = await screenshotPage(WS, 'ftp://localhost/x', { vision: VISION_BRIDGE });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('仅支持 http(s)');
  });

  it('非 localhost 拒绝（SSRF 防护）', async () => {
    const r = await screenshotPage(WS, 'https://example.com/', { vision: VISION_BRIDGE });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('localhost');
  });

  it('vision bridge 缺失拒绝', async () => {
    const r = await screenshotPage(WS, 'http://127.0.0.1:9/', {});
    expect(r.ok).toBe(false);
    expect(r.error).toContain('vision bridge');
  });
});

describe('screenshotPage 集成（本机有 Chrome/Edge 时才跑）', () => {
  it('对 localhost 页面截图并回流视觉分析', async () => {
    const server = http.createServer((_req, res) => {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end('<html><head><title>vision it</title></head><body><h1>视觉冒烟页</h1></body></html>');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as { port: number }).port;
    try {
      const r = await screenshotPage(WS, `http://127.0.0.1:${port}/`, { question: '页面是否空白', vision: VISION_BRIDGE });
      if (r.error?.includes('未找到 Chrome/Edge')) return; // 无浏览器环境跳过
      expect(r.ok).toBe(true);
      expect(r.path).toMatch(/^\.coteam\/shots\/shot-.*\.png$/);
      expect(fs.existsSync(path.join(WS, r.path!))).toBe(true);
      expect(r.analysis).toContain('视觉分析结果');
    } finally {
      server.close();
    }
  });
});

describe('check_page hint（现场提醒层）', () => {
  it('渲染成功结果带 screenshot 引导 hint', async () => {
    const server = http.createServer((_req, res) => {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end('<html><head><title>hint it</title></head><body><h1>文本验证页</h1></body></html>');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as { port: number }).port;
    try {
      const r = await checkPage(`http://127.0.0.1:${port}/`, ['文本验证页']);
      if (r.error?.includes('未找到 Chrome/Edge')) return;
      expect(r.ok).toBe(true);
      expect(r.hint).toContain('screenshot');
    } finally {
      server.close();
    }
  });
});

describe('IMAGE_MEDIA_TYPES', () => {
  it('常见截图格式覆盖', () => {
    expect(IMAGE_MEDIA_TYPES['.png']).toBe('image/png');
    expect(IMAGE_MEDIA_TYPES['.jpg']).toBe('image/jpeg');
    expect(IMAGE_MEDIA_TYPES['.webp']).toBe('image/webp');
    expect(IMAGE_MEDIA_TYPES['.txt']).toBeUndefined();
  });
});
