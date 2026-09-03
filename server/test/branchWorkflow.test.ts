import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { commitOnBranch, createNodeBranch, ensureBase, mergeAllNodes } from '../src/git';
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
