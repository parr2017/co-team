import * as fs from 'node:fs';
import * as path from 'node:path';
import { simpleGit, SimpleGit } from 'simple-git';
import { isIgnoredRelPath } from './sandbox';

function git(workspace: string): SimpleGit {
  return simpleGit({ baseDir: workspace, timeout: { block: 60_000 } });
}

export async function isGitRepo(workspace: string): Promise<boolean> {
  try {
    return await git(workspace).checkIsRepo();
  } catch {
    return false;
  }
}

/** Ensure the sandbox is a git repo with a baseline commit on coteam/base. */
export async function ensureBase(workspace: string): Promise<string> {
  const g = git(workspace);
  if (!(await g.checkIsRepo())) {
    await g.init();
    await g.addConfig('user.name', 'co-team');
    await g.addConfig('user.email', 'coteam@local');
  }
  const branches = await g.branchLocal();
  if (!branches.all.includes('coteam/base')) {
    const log = await g.log({ maxCount: 1 }).catch(() => null);
    if (log?.latest) {
      // repo already has history: branch from HEAD
      await g.checkoutLocalBranch('coteam/base');
    } else {
      // empty repo: create a root commit with current files
      await g.checkout(['--orphan', 'coteam/base']);
      await g.add('-A').catch(() => {});
      let status = await g.status();
      if (!status.staged.length && !status.files.length) {
        // nothing to commit: leave a baseline marker so the branch exists
        fs.mkdirSync(path.join(workspace, '.coteam'), { recursive: true });
        fs.writeFileSync(path.join(workspace, '.coteam', 'baseline'), 'coteam task baseline\n');
        await g.add('-A');
        status = await g.status();
      }
      if (status.staged.length || status.files.length) {
        await g.commit('coteam: task baseline');
      }
    }
  }
  await g.checkout('coteam/base').catch(() => {});
  return 'coteam/base';
}

/** Create a working branch for a node, branching off the given parent branch. */
export async function createNodeBranch(workspace: string, branch: string, fromBranch: string): Promise<boolean> {
  const g = git(workspace);
  try {
    const branches = await g.branchLocal();
    if (branches.all.includes(branch)) {
      await g.checkout(branch);
      return true;
    }
    await g.checkout(fromBranch).catch(() => {});
    await g.checkoutLocalBranch(branch);
    return true;
  } catch {
    return false;
  }
}

/** Commit the node's changes on its current branch. Returns commit hash or null. */
export async function commitOnBranch(workspace: string, message: string, paths: string[]): Promise<string | null> {
  const g = git(workspace);
  try {
    for (const p of paths) {
      const candidate = p.includes(':') ? p.split(':')[0].trim() : p;
      try {
        await g.add(['--', candidate]);
      } catch {
        /* invalid pathspec: skip */
      }
    }
    const status = await g.status();
    if (status.staged.length === 0) return null;
    const commit = await g.commit(message);
    return commit.commit;
  } catch {
    return null;
  }
}

export interface MergeResult {
  merged: string[];
  conflicts: string[];
  head: string | null;
}

/** Merge all node branches back into the base branch, in the given order. */
export async function mergeAllNodes(workspace: string, branches: string[]): Promise<MergeResult> {
  const g = git(workspace);
  const result: MergeResult = { merged: [], conflicts: [], head: null };
  await g.checkout('coteam/base').catch(() => {});
  for (const branch of branches) {
    try {
      const summary = await g.merge([branch, '--no-ff', '-m', `coteam: merge ${branch}`]);
      if (summary.failed) {
        result.conflicts.push(branch);
        await g.merge(['--abort']).catch(() => {});
      } else {
        result.merged.push(branch);
      }
    } catch {
      result.conflicts.push(branch);
      await g.merge(['--abort']).catch(() => {});
    }
  }
  try {
    const log = await g.log({ maxCount: 1 });
    result.head = log.latest?.hash ?? null;
  } catch {
    /* empty repo */
  }
  return result;
}

/** List all coteam/* branches with their latest commit message. */
export async function listTaskBranches(workspace: string): Promise<{ name: string; commit: string }[]> {
  const g = git(workspace);
  try {
    const branches = await g.branchLocal();
    return branches.all
      .filter((b) => b.startsWith('coteam/'))
      .map((b) => ({ name: b, commit: branches.branches[b]?.commit?.slice(0, 8) ?? '' }));
  } catch {
    return [];
  }
}

/** A3: pick the workspace repo's main branch ('main' preferred, then 'master', then current). */
export async function detectMainBranch(workspace: string): Promise<string> {
  const g = git(workspace);
  const branches = await g.branchLocal().catch(() => null);
  if (!branches) return 'main';
  if (branches.all.includes('main')) return 'main';
  if (branches.all.includes('master')) return 'master';
  return branches.current || 'main';
}

export interface TaskMergeResult {
  ok: boolean;
  target: string;
  taskBranch: string;
  commit: string | null;
  conflicts: string[];
  message: string;
}

/**
 * A3 验收合并闭环: merge a task's deliverable branch into the repo's main branch.
 * dryRun performs a real merge WITHOUT committing and aborts it, so the user can
 * preview conflicts before committing to the merge. Refuses to touch a dirty
 * worktree (tracked modifications) so user edits are never clobbered.
 */
export async function mergeTaskBranch(workspace: string, taskBranch: string, targetBranch?: string, dryRun = false): Promise<TaskMergeResult> {
  const g = git(workspace);
  const result: TaskMergeResult = { ok: false, target: targetBranch || '', taskBranch, commit: null, conflicts: [], message: '' };
  const branches = await g.branchLocal().catch(() => null);
  if (!branches) { result.message = '工作区不是 git 仓库'; return result; }
  if (!branches.all.includes(taskBranch)) { result.message = `任务分支不存在: ${taskBranch}`; return result; }
  const target = targetBranch || (await detectMainBranch(workspace));
  result.target = target;
  if (target === taskBranch) { result.message = '任务分支与目标分支相同，无需合并'; return result; }
  if (!branches.all.includes(target)) { result.message = `目标分支不存在: ${target}`; return result; }

  const status = await g.status();
  const dirtyTracked = status.modified.length + status.created.length + status.deleted.length + status.staged.length;
  if (dirtyTracked > 0) {
    result.message = `工作区有 ${dirtyTracked} 个未提交改动，为保护你的修改已拒绝合并——请先提交或暂存（git stash）`;
    return result;
  }

  try {
    await g.checkout(target);
  } catch (e) {
    result.message = `切换到 ${target} 失败: ${String(e).slice(0, 120)}`;
    return result;
  }

  try {
    if (dryRun) {
      await g.merge([taskBranch, '--no-ff', '--no-commit', '-m', `coteam: dry-run merge ${taskBranch}`]);
      const st = await g.status();
      if (st.conflicted.length) {
        result.conflicts = st.conflicted;
        result.message = `试运行发现冲突（${st.conflicted.length} 个文件），未做任何改动`;
      } else {
        result.ok = true;
        result.message = `试运行通过：${taskBranch} 可无冲突合并到 ${target}（已还原，未落盘）`;
      }
      await g.merge(['--abort']).catch(() => {});
      await g.checkout(taskBranch).catch(() => {});
      return result;
    }
    await g.merge([taskBranch, '--no-ff', '-m', `coteam: merge ${taskBranch} into ${target}`]);
    const st = await g.status();
    if (st.conflicted.length) {
      result.conflicts = st.conflicted;
      await g.merge(['--abort']).catch(() => {});
      result.message = `合并存在冲突（${st.conflicted.length} 个文件），已自动中止`;
      return result;
    }
    const head = await g.log({ maxCount: 1 }).catch(() => null);
    result.ok = true;
    result.commit = head?.latest?.hash?.slice(0, 8) ?? null;
    result.message = `已合并 ${taskBranch} → ${target}（${result.commit ?? 'no commit'}）`;
    return result;
  } catch (e) {
    await g.merge(['--abort']).catch(() => {});
    result.message = `合并失败: ${String(e).slice(0, 160)}`;
    return result;
  }
}

export async function commitChanges(workspace: string, message: string, paths: string[]): Promise<string | null> {
  return commitOnBranch(workspace, message, paths);
}

export interface NodeDiff {
  patch: string;
  files: { path: string; insertions: number; deletions: number }[];
}

/**
 * 一个节点的全部代码变更 = 节点分支相对其切出点（与父分支的 merge-base）的 diff。
 * 包含测试修复轮在该分支上的追加提交；分支不存在或无法计算时返回 null。
 */
export async function nodeDiff(workspace: string, branch: string, parentBranch: string): Promise<NodeDiff | null> {
  const g = git(workspace);
  try {
    const branches = await g.branchLocal();
    if (!branches.all.includes(branch)) return null;
    const base = (await g.raw(['merge-base', parentBranch, branch])).trim();
    if (!base) return null;
    const range = `${base}..${branch}`;
    const patch = await g.raw(['diff', range, '--']);
    const numstat = await g.raw(['diff', '--numstat', range, '--']);
    const files = numstat
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const [ins, del, ...rest] = line.split('\t');
        return { path: rest.join('\t'), insertions: Number(ins) || 0, deletions: Number(del) || 0 };
      });
    return { patch, files };
  } catch {
    return null;
  }
}

/** Sync merged result from sandbox back to the real workspace git branch. */
export async function syncToWorkspace(sandbox: string, workspace: string, branch: string): Promise<boolean> {
  // files were merged in the sandbox; copy them over like the file-merge path does
  try {
    if (!fs.existsSync(workspace)) fs.mkdirSync(workspace, { recursive: true });
    if (path.resolve(sandbox) === path.resolve(workspace)) return true;
    fs.cpSync(sandbox, workspace, {
      recursive: true,
      force: true,
      filter: (src) => {
        const rel = path.relative(sandbox, src);
        if (rel === '.git' || rel.startsWith('.git' + path.sep) || rel.startsWith('.git/')) return false;
        return !isIgnoredRelPath(rel);
      },
    });
    void branch;
    return true;
  } catch (e) {
    // a silent false previously made the orchestrator report success while the
    // deliverables stayed trapped in the sandbox — surface the cause for the log
    console.error('[git] syncToWorkspace failed:', String((e as Error)?.message || e));
    return false;
  }
}
