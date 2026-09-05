import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { parseArgs, usage, runInit } from '../src/cli';

let tmp: string;

beforeEach(() => {
  process.env.COTEAM_FORCE_MEMORY = '1';
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-cli-'));
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('coteam init CLI (R8)', () => {
  it('parses init with dir, name and description', () => {
    const args = parseArgs(['node', 'cli.js', 'init', './myproj', '--name', 'My Project', '--description', '一个演示项目']);
    expect(args).toEqual({ command: 'init', dir: './myproj', name: 'My Project', description: '一个演示项目' });
  });

  it('defaults the name to the directory basename when --name is omitted', async () => {
    const target = path.join(tmp, 'demo-app');
    const { workspace, name, result } = await runInit({ command: 'init', dir: target });
    expect(workspace).toBe(path.resolve(target));
    expect(name).toBe('demo-app');
    // standard scaffold produced
    expect(result.dirs).toContain('docs');
    expect(result.files).toContain('README.md');
    expect(result.git_initialized).toBe(true);
  });

  it('bare coteam / --help parse to null (caller prints usage, exit 0)', () => {
    expect(parseArgs(['node', 'cli.js'])).toBeNull();
    expect(parseArgs(['node', 'cli.js', '--help'])).toBeNull();
    expect(usage()).toContain('coteam init');
    expect(usage()).toContain('npm start');
  });

  it('rejects unknown subcommands and flag misuse with null', () => {
    expect(parseArgs(['node', 'cli.js', 'serve'])).toBeNull();
    expect(parseArgs(['node', 'cli.js', 'init'])).toBeNull(); // missing dir
    expect(parseArgs(['node', 'cli.js', 'init', 'dir', '--name'])).toBeNull(); // flag without value
    expect(parseArgs(['node', 'cli.js', 'init', 'a', 'b'])).toBeNull(); // two positionals
  });

  it('runInit actually scaffolds the target directory', async () => {
    const target = path.join(tmp, 'proj-x');
    const { result } = await runInit({ command: 'init', dir: target, name: 'X', description: '描述' });
    expect(fs.existsSync(path.join(target, 'docs'))).toBe(true);
    expect(fs.existsSync(path.join(target, 'src'))).toBe(true);
    expect(fs.existsSync(path.join(target, 'README.md'))).toBe(true);
    expect(fs.existsSync(path.join(target, '.git'))).toBe(true);
    // the description lands in the README
    expect(fs.readFileSync(path.join(target, 'README.md'), 'utf-8')).toContain('X');
  });
});
