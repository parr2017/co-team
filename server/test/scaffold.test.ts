import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { initGitOnly, scaffoldProject } from '../src/scaffold';
import { simpleGit } from 'simple-git';

function tmpDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

describe('project scaffold (improvement 1)', () => {
  it('creates standard dirs and non-empty structured docs', async () => {
    const ws = tmpDir('ct-scaf-');
    const result = await scaffoldProject(ws, { name: 'demo-app', description: '演示项目' });
    expect(result.dirs).toEqual(expect.arrayContaining(['docs', 'src', 'tests', 'config']));
    for (const f of ['README.md', 'CONTRIBUTING.md', 'ARCHITECTURE.md']) {
      const p = path.join(ws, f);
      expect(fs.existsSync(p), f).toBe(true);
      expect(fs.readFileSync(p, 'utf-8').length).toBeGreaterThan(50);
    }
    expect(fs.readFileSync(path.join(ws, 'README.md'), 'utf-8')).toContain('demo-app');
    expect(fs.readFileSync(path.join(ws, 'ARCHITECTURE.md'), 'utf-8')).toContain('演示项目');
    fs.rmSync(ws, { recursive: true, force: true });
  });

  it('initializes git with a root commit', async () => {
    const ws = tmpDir('ct-scaf-');
    const result = await scaffoldProject(ws, { name: 'demo-app' });
    expect(result.git_initialized).toBe(true);
    const log = await simpleGit({ baseDir: ws }).log({ maxCount: 1 });
    expect(log.latest?.message).toContain('demo-app');
    fs.rmSync(ws, { recursive: true, force: true });
  });

  it('is idempotent: rerun keeps existing files and skips empty commit', async () => {
    const ws = tmpDir('ct-scaf-');
    await scaffoldProject(ws, { name: 'demo-app' });
    const before = (await simpleGit({ baseDir: ws }).log()).total;
    const result = await scaffoldProject(ws, { name: 'demo-app' });
    expect(result.git_initialized).toBe(false);
    expect(result.root_commit).toBeNull();
    expect((await simpleGit({ baseDir: ws }).log()).total).toBe(before);
    fs.rmSync(ws, { recursive: true, force: true });
  });

  it('initGitOnly only initializes git without scaffold files', async () => {
    const ws = tmpDir('ct-gitonly-');
    expect(await initGitOnly(ws)).toBe(true);
    expect(fs.existsSync(path.join(ws, 'README.md'))).toBe(false);
    expect(await initGitOnly(ws)).toBe(false); // already a repo
    fs.rmSync(ws, { recursive: true, force: true });
  });
});
