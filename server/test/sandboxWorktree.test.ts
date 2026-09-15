import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { simpleGit } from 'simple-git';
import { createSandbox, cleanupSandbox, mergeChanges, worktreeRoot } from '../src/sandbox';

// worktree 沙箱迁移回归（o3xmkraj 复盘）：%TEMP% 全量拷贝绑定服务进程生命周期，
// 重启即作废丢中间态——git 仓库改用项目目录内 worktree，重启安全、git 原生可审。

const dirs: string[] = [];
async function makeGitWorkspace(): Promise<{ ws: string; mainBranch: string }> {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-wt-'));
  dirs.push(ws);
  const g = simpleGit({ baseDir: ws });
  await g.init();
  await g.addConfig('user.name', 'test');
  await g.addConfig('user.email', 'test@local');
  fs.writeFileSync(path.join(ws, 'base.txt'), 'v1');
  await g.add(['-A']);
  await g.commit('init');
  const mainBranch = (await g.revparse(['--abbrev-ref', 'HEAD'])).trim();
  return { ws, mainBranch };
}

afterEach(() => {
  for (const d of dirs.splice(0)) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* windows 抖动容忍 */ }
  }
});

describe('worktree 沙箱', () => {
  it('git 仓库创建 worktree：落在 .coteam/worktrees/<taskId>，脏改动进基线', async () => {
    const { ws } = await makeGitWorkspace();
    fs.writeFileSync(path.join(ws, 'dirty.txt'), 'uncommitted'); // 未提交改动
    const sandbox = await createSandbox(ws, 'task1');
    try {
      expect(sandbox).toBe(path.join(worktreeRoot(ws), 'task1'));
      expect(fs.statSync(path.join(sandbox, '.git')).isFile()).toBe(true); // worktree 的 .git 是文件指针
      expect(fs.readFileSync(path.join(sandbox, 'base.txt'), 'utf-8')).toBe('v1');
      expect(fs.readFileSync(path.join(sandbox, 'dirty.txt'), 'utf-8')).toBe('uncommitted');
      // 用户 HEAD 回切：主工作区不在任务分支上
      const cur = (await simpleGit({ baseDir: ws }).revparse(['--abbrev-ref', 'HEAD'])).trim();
      expect(cur.startsWith('coteam/')).toBe(false);
    } finally {
      await cleanupSandbox(sandbox);
    }
    expect(fs.existsSync(sandbox)).toBe(false);
  });

  it('worktree 内改动可 mergeChanges 回工作区；coteam/base 指向任务基线', async () => {
    const { ws } = await makeGitWorkspace();
    const sandbox = await createSandbox(ws, 'task2');
    try {
      fs.writeFileSync(path.join(sandbox, 'new.txt'), 'n');
      fs.writeFileSync(path.join(sandbox, 'base.txt'), 'v2');
      const merged = mergeChanges(sandbox, ws);
      expect(new Set(merged)).toEqual(new Set(['new.txt', 'base.txt']));
      const branches = await simpleGit({ baseDir: ws }).branchLocal();
      expect(branches.all).toContain('coteam/base');
      expect(branches.all).toContain('coteam/task-task2');
    } finally {
      await cleanupSandbox(sandbox);
    }
  });

  it('重复创建同任务沙箱：先清残留再重建，节点分支被清扫', async () => {
    const { ws, mainBranch } = await makeGitWorkspace();
    const g = simpleGit({ baseDir: ws });
    // 模拟上一任务的节点分支残留
    const sandbox0 = await createSandbox(ws, 'task3');
    fs.writeFileSync(path.join(sandbox0, 'x.txt'), 'x');
    await g.add(['-A']);
    await g.commit('node work');
    await g.checkoutLocalBranch('coteam/1-dev');
    await g.checkout(mainBranch);
    fs.rmSync(sandbox0, { recursive: true, force: true });
    await g.raw(['worktree', 'prune']).catch(() => {});

    const sandbox = await createSandbox(ws, 'task3');
    try {
      const branches = await g.branchLocal();
      expect(branches.all).not.toContain('coteam/1-dev'); // 上一任务节点分支被清扫
      expect(fs.existsSync(sandbox)).toBe(true);
    } finally {
      await cleanupSandbox(sandbox);
    }
  });

  it('非 git 目录回退 legacy 临时拷贝', async () => {
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-nogit-'));
    dirs.push(ws);
    fs.writeFileSync(path.join(ws, 'f.txt'), 'v');
    const sandbox = await createSandbox(ws, 'task4');
    try {
      expect(sandbox.startsWith(os.tmpdir())).toBe(true);
      expect(fs.readFileSync(path.join(sandbox, 'f.txt'), 'utf-8')).toBe('v');
    } finally {
      await cleanupSandbox(sandbox);
    }
    expect(fs.existsSync(sandbox)).toBe(false);
  });

  it('cleanupSandbox 对 worktree 执行 git worktree remove（分支引用随之释放）', async () => {
    const { ws } = await makeGitWorkspace();
    const sandbox = await createSandbox(ws, 'task5');
    await cleanupSandbox(sandbox);
    const list = await simpleGit({ baseDir: ws }).raw(['worktree', 'list', '--porcelain']);
    expect(list).not.toContain('task5');
    expect(fs.existsSync(sandbox)).toBe(false);
  });
});
