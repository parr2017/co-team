import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Router, DEFAULT_RULES } from '../src/router';
import { AgentPlugin } from '../src/agents';
import { MemoryBus } from '../src/bus';
import { applyFinalOutput, listFiles, readFile } from '../src/tools';
import { canExecute, createSandbox, executeCommand, mergeChanges, policyFromConfig, writeFiles } from '../src/sandbox';
import type { PermissionPolicy } from '../src/sandbox';

function agent(name: string, tags: string[]): AgentPlugin {
  return { name, role: '', description: '', tags, modelOverride: null, maxTokens: 4096, timeout: 300, prompt: '', handler: {}, dir: '', version: '1.0.0' };
}

describe('Router', () => {
  it('routes by rules and tags', async () => {
    const router = new Router([agent('dev', ['code']), agent('test', ['test']), agent('deploy', ['deploy'])], DEFAULT_RULES);
    expect(await router.route({ description: '实现用户登录', tags: ['code'] })).toBe('dev');
    expect(await router.route({ description: '写测试用例', tags: ['test'] })).toBe('test');
  });

  it('falls back to llm router then keywords then first', async () => {
    const plugins = [agent('dev', ['code']), agent('review', ['review'])];
    const llmRouter = async (description: string) => (description.includes('审查') ? 'review' : null);
    const router = new Router(plugins, DEFAULT_RULES, llmRouter);
    expect(await router.route({ description: '帮我审查这段代码' })).toBe('review');
    expect(await router.route({ description: '写个函数' })).toBe('dev');

    const fallbackRouter = new Router([agent('dev', ['code'])], DEFAULT_RULES, async () => 'nonexistent');
    expect(await fallbackRouter.route({ description: '任意任务' })).toBe('dev');
  });
});

describe('sandbox & tools', () => {
  const policy: PermissionPolicy = { whitelistCommands: ['python'], maxTimeSec: 10 };

  it('writeFiles refuses path traversal', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-'));
    const written = writeFiles(tmp, [
      { path: 'a/b.txt', content: 'hello' },
      { path: '../evil.txt', content: 'nope' },
    ]);
    expect(written).toEqual(['a/b.txt']);
    expect(fs.readFileSync(path.join(tmp, 'a', 'b.txt'), 'utf-8')).toBe('hello');
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('sandbox isolates and merges changes', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-'));
    fs.writeFileSync(path.join(tmp, 'base.txt'), 'v1');
    const sandbox = createSandbox(tmp);
    try {
      writeFiles(sandbox, [{ path: 'base.txt', content: 'v2' }, { path: 'new.txt', content: 'n' }]);
      const merged = mergeChanges(sandbox, tmp);
      expect(new Set(merged)).toEqual(new Set(['base.txt', 'new.txt']));
      expect(fs.readFileSync(path.join(tmp, 'base.txt'), 'utf-8')).toBe('v2');
    } finally {
      fs.rmSync(sandbox, { recursive: true, force: true });
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('command whitelist enforced', () => {
    expect(canExecute(policy, 'python -V')).toBe(true);
    expect(canExecute(policy, 'rm -rf /')).toBe(false);
    expect(executeCommand('echo nope', '.', policy).allowed).toBe(false);
    const ok = executeCommand('python -c "print(1+1)"', '.', policy);
    expect(ok.allowed).toBe(true);
    expect(ok.returncode).toBe(0);
  });

  it('readFile guards traversal', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-'));
    fs.writeFileSync(path.join(tmp, 'x.txt'), 'data');
    expect(readFile(tmp, 'x.txt').content).toBe('data');
    expect(readFile(tmp, '../outside.txt').ok).toBe(false);
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('applyFinalOutput merges declared and written changes and runs commands', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-'));
    const out = applyFinalOutput(tmp, {
      status: 'success',
      changes: ['declared.txt: said'],
      files: [{ path: 'w.txt', content: 'w' }],
      commands: ['python -c "print(\'ok\')"'],
    }, policy);
    expect(out.changes).toContain('w.txt');
    expect(out.changes.some((c: string) => c.startsWith('declared.txt'))).toBe(true);
    expect(out.command_results[0].returncode).toBe(0);
    expect(fs.existsSync(path.join(tmp, 'w.txt'))).toBe(true);
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('listFiles ignores noise dirs', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-'));
    fs.mkdirSync(path.join(tmp, '.git'));
    fs.writeFileSync(path.join(tmp, '.git', 'config'), 'x');
    fs.writeFileSync(path.join(tmp, 'keep.py'), 'x');
    const files = listFiles(tmp);
    expect(files).toContain('keep.py');
    expect(files.some((f) => f.startsWith('.git'))).toBe(false);
    fs.rmSync(tmp, { recursive: true, force: true });
  });
});

describe('MemoryBus', () => {
  it('persists across instances', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-'));
    const stateFile = path.join(dir, 'state.json');
    const bus1 = new MemoryBus(stateFile);
    bus1.set('task:graph:abc', { nodes: [1, 2], status: 'success' });
    bus1.set('ephemeral', 'x', 1);
    bus1.close();

    const bus2 = new MemoryBus(stateFile);
    expect(bus2.get('task:graph:abc')).toEqual({ nodes: [1, 2], status: 'success' });
    expect(bus2.get('ephemeral')).toBe('x');
    bus2.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('supports keys pattern', () => {
    const bus = new MemoryBus();
    bus.set('task:graph:a', 1);
    bus.set('task:log:a:n1', 2);
    expect(bus.keys('task:graph:*')).toEqual(['task:graph:a']);
    bus.close();
  });
});
