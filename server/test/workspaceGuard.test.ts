import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { simpleGit } from 'simple-git';
import { initBus, closeBus } from '../src/bus';
import { saveProject } from '../src/store';
import { ModelPool } from '../src/scheduler';
import { Orchestrator } from '../src/orchestrator/orchestrator';
import {
  WorkspaceError, isInside, slugifyProjectName, assertStandaloneWorkspace,
  restoreStaleTaskHeads, prepareSelfdevClone, removeSelfdev,
} from '../src/workspace';

let tmp: string;

async function makeRepo(dir: string): Promise<ReturnType<typeof simpleGit>> {
  fs.mkdirSync(dir, { recursive: true });
  const g = simpleGit({ baseDir: dir });
  await g.init();
  await g.addConfig('user.name', 't');
  await g.addConfig('user.email', 't@t');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'a\n');
  await g.add('-A');
  await g.commit('chore: init');
  return g;
}

beforeEach(async () => {
  process.env.COTEAM_FORCE_MEMORY = '1';
  closeBus();
  await initBus({ host: '127.0.0.1', port: 6399, db: 0 });
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-ws-'));
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
  closeBus();
});

describe('slugifyProjectName', () => {
  it('keeps CJK, collapses path-unsafe chars, falls back to project', () => {
    expect(slugifyProjectName('会员系统 v2')).toBe('会员系统-v2');
    expect(slugifyProjectName('a/b:c*d?')).toBe('a-b-c-d');
    expect(slugifyProjectName('   ')).toBe('project');
  });
});

describe('assertStandaloneWorkspace', () => {
  it('rejects a workspace inside co-team itself unless allowSelfRef', async () => {
    const projectRoot = path.resolve(tmp, 'coteam-repo');
    fs.mkdirSync(projectRoot, { recursive: true });
    await expect(assertStandaloneWorkspace(projectRoot, { projectRoot })).rejects.toBeInstanceOf(WorkspaceError);
    await expect(assertStandaloneWorkspace(path.join(projectRoot, 'sub'), { projectRoot })).rejects.toThrow(/co-team/);
    const ok = await assertStandaloneWorkspace(path.join(projectRoot, 'sub'), { projectRoot, allowSelfRef: true });
    expect(isInside(projectRoot, ok)).toBe(true);
  });

  it('rejects a directory nested inside another git repo, accepts the repo root itself', async () => {
    const projectRoot = path.resolve(tmp, 'coteam-repo');
    const outer = path.join(tmp, 'outer');
    await makeRepo(outer);
    const inner = path.join(outer, 'nested-proj');
    let err: unknown = null;
    try {
      await assertStandaloneWorkspace(inner, { projectRoot });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(WorkspaceError);
    expect(String((err as Error).message)).toContain(outer.replace(/\\/g, '/')); // message names the owner repo
    // the outer repo root is standalone → passes
    await expect(assertStandaloneWorkspace(outer, { projectRoot })).resolves.toBeDefined();
  });

  it('accepts a plain directory that is not in any repo', async () => {
    const plain = path.join(tmp, 'plain-proj');
    fs.mkdirSync(plain);
    await expect(assertStandaloneWorkspace(plain, { projectRoot: path.resolve(tmp, 'coteam-repo') })).resolves.toBeDefined();
  });
});

describe('gitCommit restores HEAD', () => {
  it('commits on the task branch and returns the repo to its original branch', async () => {
    const repo = path.join(tmp, 'proj');
    const g = await makeRepo(repo);
    const agentsDir = path.join(tmp, 'agents');
    fs.mkdirSync(path.join(agentsDir, 'dev'), { recursive: true });
    fs.writeFileSync(path.join(agentsDir, 'dev', 'agent.yaml'), 'name: dev\n');
    const orch = new Orchestrator({
      agentsDir, modelPool: new ModelPool([{ name: 'm', api_key: 'k', base_url: 'http://x', tags: [] }]),
      policy: { whitelistCommands: null, maxTimeSec: 10 }, maxRetries: 1, sandboxEnabled: false, gitEnabled: false, branchWorkflow: false,
    });
    fs.writeFileSync(path.join(repo, 'b.txt'), 'b\n');
    const res = await (orch as any).gitCommit('t1', repo, ['b.txt: 新增'], 'coteam: task t1 auto-commit');
    expect(res).toBeTruthy();
    expect(res.branch).toBe('coteam/task-t1');
    expect(res.commit).toBeTruthy();
    // HEAD must be back where the user's working copy was
    const cur = (await g.revparse(['--abbrev-ref', 'HEAD'])).trim();
    expect(['main', 'master']).toContain(cur);
    const branches = await g.branchLocal();
    expect(branches.all).toContain('coteam/task-t1');
  });
});

describe('restoreStaleTaskHeads', () => {
  it('restores task-branch HEADs with no unique commits and holds ones with human work', async () => {
    const clean = path.join(tmp, 'clean-proj');
    const gClean = await makeRepo(clean);
    await gClean.checkoutLocalBranch('coteam/task-abc');
    const held = path.join(tmp, 'held-proj');
    const gHeld = await makeRepo(held);
    await gHeld.checkoutLocalBranch('coteam/task-def');
    fs.writeFileSync(path.join(held, 'human.txt'), 'work\n');
    await gHeld.add('-A');
    await gHeld.commit('feat: human work on task branch');

    await saveProject({ id: 'p-clean', name: 'clean', workspace: clean, created_at: new Date().toISOString() });
    await saveProject({ id: 'p-held', name: 'held', workspace: held, created_at: new Date().toISOString() });

    const res = await restoreStaleTaskHeads();
    expect(res.restored.some((r) => r.includes(clean))).toBe(true);
    expect(res.held.some((r) => r.workspace === held && r.ahead === 1)).toBe(true);
    expect((await gClean.revparse(['--abbrev-ref', 'HEAD'])).trim()).not.toBe('coteam/task-abc');
    // held repo keeps its HEAD — human commits are never silently moved
    expect((await gHeld.revparse(['--abbrev-ref', 'HEAD'])).trim()).toBe('coteam/task-def');
  });
});

describe('prepareSelfdevClone', () => {
  it('clones the source repo into an isolated dir and is idempotent', async () => {
    const source = path.join(tmp, 'source');
    await makeRepo(source);
    const root = path.join(tmp, 'selfdev');
    const first = await prepareSelfdevClone('t9', root, source);
    expect(fs.existsSync(path.join(first, '.git'))).toBe(true);
    expect(fs.existsSync(path.join(first, 'a.txt'))).toBe(true);
    const second = await prepareSelfdevClone('t9', root, source);
    expect(second).toBe(first);
    removeSelfdev(first);
    expect(fs.existsSync(first)).toBe(false);
  });
});
