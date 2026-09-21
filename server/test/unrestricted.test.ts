import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  policyFromConfig, policyWithLevel, canExecute, isPermissionLevel,
  PERMISSION_LEVELS, GLOBAL_PERMISSION_LEVELS, executeCommand, writeFiles,
} from '../src/sandbox';
import { readFile } from '../src/tools';
import { looksLikeMutating } from '../src/commandGuard';

// unrestricted（无边界）：会话级——命令与读取解除目录监狱；写/删文件仍锁项目内。
describe('unrestricted 权限等级', () => {
  let ws: string;
  let outside: string;
  const full = policyFromConfig({ level: 'full' });
  const unrest = policyFromConfig({ level: 'unrestricted' });

  beforeAll(() => {
    ws = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-unrest-ws-'));
    outside = path.join(os.tmpdir(), `ct-unrest-outside-${Date.now()}.txt`);
    fs.writeFileSync(outside, 'hello-outside', 'utf-8');
  });
  afterAll(() => {
    fs.rmSync(ws, { recursive: true, force: true });
    try { fs.unlinkSync(outside); } catch { /* ignore */ }
  });

  it('等级/策略：isPermissionLevel、PERMISSION_LEVELS 含、GLOBAL_PERMISSION_LEVELS 不含', () => {
    expect(isPermissionLevel('unrestricted')).toBe(true);
    expect(PERMISSION_LEVELS).toContain('unrestricted');
    expect(GLOBAL_PERMISSION_LEVELS).not.toContain('unrestricted');
    expect(unrest.level).toBe('unrestricted');
    expect(unrest.jailBypass).toBe(true);
    expect(full.jailBypass).toBeFalsy();
    expect(canExecute(unrest, 'anything --goes')).toBe(true);
  });

  it('任务执行策略（policyWithLevel）不接受 unrestricted：回退 base.level', () => {
    const base = policyFromConfig({ level: 'whitelist_auto', whitelist_commands: ['cat'] });
    const merged = policyWithLevel(base, { level: 'unrestricted' });
    expect(merged.level).toBe('whitelist_auto');
    expect(merged.jailBypass).toBeFalsy();
  });

  it('命令监狱：full 拒绝越界；unrestricted 放行', () => {
    const cmd = `cat "${outside}"`;
    const rFull = executeCommand(cmd, ws, full);
    expect(rFull.allowed).toBe(false);
    expect(String(rFull.stderr)).toContain('路径越界');
    const rUnrest = executeCommand(cmd, ws, unrest);
    expect(rUnrest.allowed).toBe(true);
  });

  it('读取：full 越界被拒；unrestricted 可读项目外文件', () => {
    const blocked = readFile(ws, outside, undefined, undefined, false);
    expect(blocked.ok).toBe(false);
    const allowed = readFile(ws, outside, undefined, undefined, true);
    expect(allowed.ok).toBe(true);
    expect(allowed.content).toContain('hello-outside');
  });

  it('写入：任何级别（含 unrestricted）都锁项目内——越界写被丢弃', () => {
    const target = path.join(os.tmpdir(), `ct-unrest-should-not-write-${Date.now()}.txt`);
    const written = writeFiles(ws, [{ path: target, content: 'x' }]);
    expect(written).toEqual([]);
    expect(fs.existsSync(target)).toBe(false);
  });
});

describe('looksLikeMutating（越界写/删特征识别）', () => {
  it('命中：重定向 / rm / cp / git 变更 / powershell 写', () => {
    for (const c of [
      'echo hi > out.txt',
      'echo hi >> out.txt',
      'node app.js 2> err.log',
      'rm -rf build',
      'del C:\\x\\y',
      'cp a b',
      'mv a b',
      'mkdir newdir',
      'git reset --hard',
      'git clean -fd',
      'powershell -Command "Set-Content x 1"',
      'sed -i s/a/b/ f.txt',
    ]) {
      expect(looksLikeMutating(c), c).toBe(true);
    }
  });

  it('不命中：纯读/查询命令；引号内的 > 不算重定向', () => {
    for (const c of [
      'cat a.txt',
      'ls -la',
      'grep -rn foo src/',
      'git log --oneline',
      'git diff --stat',
      'echo "a > b"',
      'node --version',
    ]) {
      expect(looksLikeMutating(c), c).toBe(false);
    }
  });
});
