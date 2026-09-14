import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Logger } from '../src/logger';

const dirs: string[] = [];
const loggers: Logger[] = [];
function tmpDir(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'coteam-logger-'));
  dirs.push(d);
  return d;
}

function logFileOf(dir: string): string {
  return path.join(dir, `co-team-${new Date().toISOString().split('T')[0]}.log`);
}

/** createWriteStream 异步打开文件——等 flush 落盘再断言 */
async function flush(logger: Logger): Promise<void> {
  await new Promise<void>((resolve) => {
    const stream = (logger as any).stream as fs.WriteStream | undefined;
    if (!stream) return resolve();
    stream.write('', () => resolve());
  });
}

afterEach(() => {
  for (const l of loggers.splice(0)) {
    try { (l as any).stream?.end(); } catch { /* already closed */ }
  }
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe('logger EPIPE 熔断（2026-09-15）', () => {
  it('console 写入抛 EPIPE 后拉闸 consoleDead，文件日志继续', async () => {
    const dir = tmpDir();
    const logger = new Logger({ level: 'info', logDir: dir, prefix: '[t]' });
    loggers.push(logger);

    // 模拟 console.error 抛 EPIPE（管道对端死亡）
    const originalError = console.error;
    let consoleCalls = 0;
    console.error = () => {
      consoleCalls += 1;
      const e: any = new Error('write EPIPE');
      e.code = 'EPIPE';
      throw e;
    };
    try {
      expect(() => logger.error('boom', { code: 1 })).not.toThrow();
      // 第二条不再触碰 console（熔断），也不再抛
      expect(() => logger.error('boom2')).not.toThrow();
      expect(() => logger.info('info still fine')).not.toThrow();
    } finally {
      console.error = originalError;
    }
    expect(consoleCalls).toBe(1); // 只有第一条触达 console，之后熔断

    await flush(logger);
    const content = fs.readFileSync(logFileOf(dir), 'utf-8');
    expect(content).toContain('boom');
    expect(content).toContain('boom2');
    expect(content).toContain('info still fine');
  });

  it('非 EPIPE 的 console 异常同样熔断（防御一切管道类错误炸穿进程）', () => {
    const dir = tmpDir();
    const logger = new Logger({ level: 'info', logDir: dir, prefix: '[t]' });
    loggers.push(logger);
    const originalLog = console.log;
    console.log = () => {
      const e: any = new Error('write after end');
      e.code = 'ERR_STREAM_WRITE_AFTER_END';
      throw e;
    };
    try {
      expect(() => logger.info('x')).not.toThrow();
      expect(() => logger.info('y')).not.toThrow();
    } finally {
      console.log = originalLog;
    }
  });

  it('大小滚动清理：同日分卷只保留最近 KEEP-1 份，主文件不动', async () => {
    const dir = tmpDir();
    const logger = new Logger({ level: 'info', logDir: dir, prefix: '[t]' });
    loggers.push(logger);
    logger.info('main file');
    // 伪造 8 份历史分卷（模拟滚动产物）
    const today = new Date().toISOString().split('T')[0];
    for (let i = 1; i <= 8; i++) {
      fs.writeFileSync(path.join(dir, `co-team-${today}.${i}.log`), `part${i}`);
    }
    (logger as any).pruneOldParts(today);
    const partNums = fs.readdirSync(dir)
      .filter((f) => new RegExp(`^co-team-${today}\\.\\d+\\.log$`).test(f))
      .map((f) => Number(f.match(/\.(\d+)\.log$/)![1]))
      .sort((a, b) => b - a);
    expect(partNums).toEqual([8, 7, 6, 5]); // KEEP_LOG_PARTS-1 = 4 份，最新优先
    await flush(logger);
    expect(fs.readFileSync(logFileOf(dir), 'utf-8')).toContain('main file');
  });

  it('ensureStream 尺寸滚动：bytesWritten 达到 MAX 时切下一分卷并清理', async () => {
    const dir = tmpDir();
    const logger = new Logger({ level: 'info', logDir: dir, prefix: '[t]' });
    loggers.push(logger);
    logger.info('before rotate');
    // 伪造流字节数已超限（直接改写 bytesWritten 不可行——它是 getter，
    // 用写满语义的替代：Monkey-patch stream.bytesWritten 只在测试里可行，
    // 因此这里直接驱动 ensureStream 的滚动分支：把内部 stream 换成已超限的替身）
    const fake = Object.create(Object.getPrototypeOf((logger as any).stream));
    Object.defineProperty(fake, 'bytesWritten', { value: 51 * 1024 * 1024 });
    fake.end = () => {};
    fake.write = () => true;
    (logger as any).stream = fake;
    logger.info('trigger rotate');
    // 滚动后：旧流被 end、新流指向 .1 分卷
    expect((logger as any).streamSeq).toBe(1);
    const rotated = path.join(dir, `co-team-${new Date().toISOString().split('T')[0]}.1.log`);
    // 新 createWriteStream 异步打开，等一拍
    await new Promise((r) => setTimeout(r, 30));
    expect(fs.existsSync(rotated)).toBe(true);
  });
});
