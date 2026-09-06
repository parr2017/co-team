import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { commitOnBranch, createNodeBranch, ensureBase, mergeAllNodes, nodeDiff } from '../src/git';
import { MemoryBus } from '../src/bus';
import { emitProgress, getTaskEvents } from '../src/store';

describe('branch workflow (git.ts)', () => {
  it('initializes a baseline branch in an empty directory', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-git-'));
    const base = await ensureBase(tmp);
    expect(base).toBe('coteam/base');
    const branches = await import('simple-git').then(({ simpleGit }) => simpleGit({ baseDir: tmp }).branchLocal());
    expect(branches.all).toContain('coteam/base');
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('creates node branches, commits on them, and merges cleanly', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-git-'));
    await ensureBase(tmp);

    await createNodeBranch(tmp, 'coteam/n1-dev', 'coteam/base');
    fs.writeFileSync(path.join(tmp, 'a.txt'), 'from dev');
    expect(await commitOnBranch(tmp, 'dev work', ['a.txt'])).not.toBeNull();

    await createNodeBranch(tmp, 'coteam/n2-test', 'coteam/n1-dev');
    fs.writeFileSync(path.join(tmp, 'b.txt'), 'from test');
    await commitOnBranch(tmp, 'test work', ['b.txt']);

    const result = await mergeAllNodes(tmp, ['coteam/n1-dev', 'coteam/n2-test']);
    expect(result.conflicts).toEqual([]);
    expect(result.merged).toEqual(['coteam/n1-dev', 'coteam/n2-test']);
    expect(fs.existsSync(path.join(tmp, 'a.txt'))).toBe(true);
    expect(fs.existsSync(path.join(tmp, 'b.txt'))).toBe(true);
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('flags conflicting branches instead of failing', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-git-'));
    await ensureBase(tmp);
    fs.writeFileSync(path.join(tmp, 'same.txt'), 'base');
    await commitOnBranch(tmp, 'baseline', ['same.txt']);

    for (const branch of ['coteam/a', 'coteam/b']) {
      await createNodeBranch(tmp, branch, 'coteam/base');
      fs.writeFileSync(path.join(tmp, 'same.txt'), `changed by ${branch}`);
      await commitOnBranch(tmp, `conflict ${branch}`, ['same.txt']);
    }
    const result = await mergeAllNodes(tmp, ['coteam/a', 'coteam/b']);
    // first merge succeeds; second conflicts on same.txt
    expect(result.merged).toContain('coteam/a');
    expect(result.conflicts).toContain('coteam/b');
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('nodeDiff returns only the node own changes relative to its fork point', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-git-'));
    await ensureBase(tmp);
    fs.writeFileSync(path.join(tmp, 'base.txt'), 'baseline');
    await commitOnBranch(tmp, 'baseline', ['base.txt']);

    // n1 branches off base and adds a.txt
    await createNodeBranch(tmp, 'coteam/n1-dev', 'coteam/base');
    fs.writeFileSync(path.join(tmp, 'a.txt'), 'from dev\nline2');
    await commitOnBranch(tmp, 'dev work', ['a.txt']);

    // n2 branches off n1 (chained dependency) and adds b.txt
    await createNodeBranch(tmp, 'coteam/n2-test', 'coteam/n1-dev');
    fs.writeFileSync(path.join(tmp, 'b.txt'), 'from test');
    await commitOnBranch(tmp, 'test work', ['b.txt']);

    const d1 = await nodeDiff(tmp, 'coteam/n1-dev', 'coteam/base');
    expect(d1).not.toBeNull();
    expect(d1!.files.map((f) => f.path)).toEqual(['a.txt']);
    expect(d1!.patch).toContain('+from dev');

    const d2 = await nodeDiff(tmp, 'coteam/n2-test', 'coteam/n1-dev');
    expect(d2).not.toBeNull();
    // merge-base 切出点保证只含本节点变更，不含父分支的 a.txt
    expect(d2!.files.map((f) => f.path)).toEqual(['b.txt']);
    expect(d2!.files[0].insertions).toBe(1);

    // 分支不存在 → null
    expect(await nodeDiff(tmp, 'coteam/ghost', 'coteam/base')).toBeNull();
    fs.rmSync(tmp, { recursive: true, force: true });
  });
});

describe('task event persistence', () => {
  it('emitProgress records events for the task', async () => {
    const bus = new MemoryBus();
    // store module reads via busGet on the global bus; init with memory
    const { initBus, closeBus } = await import('../src/bus');
    closeBus();
    await initBus({ host: '127.0.0.1', port: 6399, db: 0 });
    await emitProgress('execute_start', { task_id: 't-ev', workspace: '/x' });
    await emitProgress('node_start', { task_id: 't-ev', node_id: 'n1', agent: 'dev' });
    const events = await getTaskEvents('t-ev');
    expect(events.map((e) => e.type)).toEqual(['execute_start', 'node_start']);
    closeBus();
    void bus;
  });
});
