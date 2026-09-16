import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * 编排锁（E16 dev watch 误杀在线任务）：先到者持锁，非主实例不抢；
 * 持锁进程死亡（锁过期）后其他实例可接管。文件锁跨进程生效。
 */
import { tryAcquireLeaderLock, _resetLeaderLock } from '../src/leaderLock';

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-leader-'));
  process.env.COTEAM_LEADER_DIR = tmp;
  _resetLeaderLock();
});

afterEach(() => {
  _resetLeaderLock();
  delete process.env.COTEAM_LEADER_DIR;
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('编排锁', () => {
  it('先到者持锁：A 获取后 B 拒绝，A 释放后 B 可接管', async () => {
    expect(await tryAcquireLeaderLock('boot-A')).toBe(true);
    expect(await tryAcquireLeaderLock('boot-B')).toBe(false);
    // A 释放（模拟正常退出）：锁文件被 A 的 release 清掉——这里直接删文件模拟
    fs.rmSync(path.join(tmp, 'leader.json'), { force: true });
    expect(await tryAcquireLeaderLock('boot-B')).toBe(true);
  });

  it('持锁进程死亡（锁过期）→ 其他实例接管；锁新鲜时不可抢', async () => {
    expect(await tryAcquireLeaderLock('boot-A')).toBe(true);
    // 模拟 A 死亡：mtime 回拨到 TTL 之外
    const lockFile = path.join(tmp, 'leader.json');
    const past = new Date(Date.now() - 60_000);
    fs.utimesSync(lockFile, past, past);
    expect(await tryAcquireLeaderLock('boot-B')).toBe(true);
    // 接管后 B 续期（锁新鲜）→ 第三者不可抢
    expect(await tryAcquireLeaderLock('boot-C')).toBe(false);
  });

  it('同一实例重复获取 = 续期，恒为 leader', async () => {
    expect(await tryAcquireLeaderLock('boot-A')).toBe(true);
    expect(await tryAcquireLeaderLock('boot-A')).toBe(true);
    expect(await tryAcquireLeaderLock('boot-A')).toBe(true);
  });
});
