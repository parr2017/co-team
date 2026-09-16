/**
 * 编排锁（2026-09-17，E16 dev watch 误杀在线任务）：
 * sweepInterruptedTasks 是全局动作——tsx watch 热重载重启进程必触发启动清扫，
 * 会把另一实例正在执行的任务标 interrupted（无任何属主校验，开发路线.md E16）。
 *
 * 方案：文件锁 data/leader.json（bootId+pid+mtime）。持锁者定期续期（重写 mtime），
 * 锁过期（TTL 内无续期 = 持锁进程已死）才可被接管；接管瞬间触发 onBecomeLeader 回调
 * （补跑启动清扫）。文件落在共享磁盘——不依赖 Redis，内存 bus 多实例同样生效。
 *
 * 语义取舍：漏 sweep 是安全的（延迟续跑，下次接管补上）；误杀不可逆——宁漏勿杀。
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { PROJECT_ROOT } from './config';
import { getLogger } from './logger';

const LOCK_TTL_MS = 30_000;
const LOOP_INTERVAL_MS = 10_000;

interface LeaderInfo {
  boot_id: string;
  pid: number;
  at: string;
}

let instanceId = '';
let leaderFlag = false;
let loopTimer: ReturnType<typeof setInterval> | null = null;

function lockPath(): string {
  const dir = process.env.COTEAM_LEADER_DIR || path.join(PROJECT_ROOT, 'data');
  return path.join(dir, 'leader.json');
}

function readLock(): LeaderInfo | null {
  try {
    const raw = fs.readFileSync(lockPath(), 'utf-8');
    const info = JSON.parse(raw) as LeaderInfo;
    if (!info?.boot_id) return null;
    // mtime 以文件系统为准（JSON 里的 at 仅作展示）：持锁进程活着会定期重写文件
    return info;
  } catch {
    return null;
  }
}

function lockFresh(): boolean {
  try {
    const st = fs.statSync(lockPath());
    return Date.now() - st.mtimeMs < LOCK_TTL_MS;
  } catch {
    return false;
  }
}

function writeLock(info: LeaderInfo): void {
  const p = lockPath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = `${p}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(info), 'utf-8');
  fs.renameSync(tmp, p);
}

/** 单次尝试获取/续期锁。返回调用者当前是否 leader。供测试与主循环复用。 */
export async function tryAcquireLeaderLock(id?: string): Promise<boolean> {
  const id0 = id || instanceId || randomUUID();
  if (!instanceId) instanceId = id0;
  const current = readLock();
  if (current && current.boot_id !== id0 && lockFresh()) return false;
  writeLock({ boot_id: id0, pid: process.pid, at: new Date().toISOString() });
  return true;
}

/** 启动 leader 选举循环：抢到锁（含接管过期锁）瞬间触发 onBecomeLeader。 */
export function startLeaderLoop(opts: { onBecomeLeader?: () => void; intervalMs?: number } = {}): void {
  const logger = getLogger();
  if (!instanceId) instanceId = randomUUID();
  const interval = Math.max(1_000, opts.intervalMs ?? LOOP_INTERVAL_MS);
  const tick = async () => {
    const wasLeader = leaderFlag;
    try {
      leaderFlag = await tryAcquireLeaderLock();
    } catch {
      return; // 磁盘异常：维持原状态，下轮再试
    }
    if (leaderFlag && !wasLeader) {
      logger.info('Orchestrator leadership acquired', { pid: process.pid });
      try {
        opts.onBecomeLeader?.();
      } catch (e) {
        logger.warn('onBecomeLeader callback failed', { error: String(e) });
      }
    } else if (!leaderFlag && wasLeader) {
      logger.warn('Orchestrator leadership lost', { pid: process.pid });
    }
  };
  void tick();
  loopTimer = setInterval(() => { void tick(); }, interval);
  loopTimer.unref?.();
}

/** 当前进程是否 leader（启动清扫等全局动作的前置条件） */
export function isLeader(): boolean {
  return leaderFlag;
}

/** 进程退出时释放锁（仅当自己是持锁者） */
export function releaseLeaderLock(): void {
  if (loopTimer) { clearInterval(loopTimer); loopTimer = null; }
  try {
    const current = readLock();
    if (current?.boot_id === instanceId) fs.rmSync(lockPath(), { force: true });
    leaderFlag = false;
  } catch { /* best effort */ }
}

/** 测试辅助：重置模块内状态 */
export function _resetLeaderLock(): void {
  if (loopTimer) { clearInterval(loopTimer); loopTimer = null; }
  instanceId = '';
  leaderFlag = false;
}
