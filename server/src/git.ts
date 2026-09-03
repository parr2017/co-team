import * as fs from 'node:fs';
import * as path from 'node:path';
import { simpleGit, SimpleGit } from 'simple-git';

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

export async function commitChanges(workspace: string, message: string, paths: string[]): Promise<string | null> {
  return commitOnBranch(workspace, message, paths);
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
        return rel !== '.git' && !rel.startsWith('.git' + path.sep);
      },
    });
    void branch;
    return true;
  } catch {
    return false;
  }
}
