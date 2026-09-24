import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  policyFromConfig, policyWithLevel, canExecute, isPermissionLevel,
  PERMISSION_LEVELS, GLOBAL_PERMISSION_LEVELS, executeCommand, writeFiles,
} from '../src/sandbox';
import { readFile } from '../src/tools';
import { isCommonDevCommand } from '../src/commandGuard';

// unrestricted（无边界）：命令与读取解除目录监狱；写/删文件仍锁项目内。
// 2026-09-23 起对全局配置、任务 execution_policy、协作会话三处同时开放（此前仅会话级）。
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

  it('等级/策略：isPermissionLevel、PERMISSION_LEVELS / GLOBAL 均含 unrestricted', () => {
    expect(isPermissionLevel('unrestricted')).toBe(true);
    expect(PERMISSION_LEVELS).toContain('unrestricted');
    expect(GLOBAL_PERMISSION_LEVELS).toContain('unrestricted');
    expect(unrest.level).toBe('unrestricted');
    expect(unrest.jailBypass).toBe(true);
    expect(full.jailBypass).toBeFalsy();
    expect(canExecute(unrest, 'anything --goes')).toBe(true);
  });

  // 回归（2026-09-23）：任务侧曾静默回退 base.level——web TaskForm/TaskDetail 下拉选了
  // "无边界"却毫无效果，用户视角即"开了无边界还是失败"，实为任务管线没发 exec 工具。
  it('任务执行策略（policyWithLevel）接受 unrestricted：不回退 base.level', () => {
    const base = policyFromConfig({ level: 'whitelist_auto', whitelist_commands: ['cat'] });
    const merged = policyWithLevel(base, { level: 'unrestricted' });
    expect(merged.level).toBe('unrestricted');
    expect(merged.jailBypass).toBe(true);
    // 未指定 level 时仍继承 base（覆盖语义不被破坏）
    const inherit = policyWithLevel(base, { whitelist_commands: ['python'] });
    expect(inherit.level).toBe('whitelist_auto');
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

describe('isCommonDevCommand（越界常见开发命令识别）', () => {
  it('命中：常见开发命令（含链式、cmd /c 包裹）', () => {
    for (const c of [
      'node script.js',
      'node -e "console.log(1)"',
      'java -jar app.jar',
      'javac Main.java',
      'bash build.sh',
      'sh -c "ls"',
      'cmd /c node x.js',
      'npm test',
      'npm run build',
      'npx vitest run',
      'python a.py',
      'python3 -c "print(1)"',
      'git status',
      'git log --oneline',
      'go build ./...',
      'mvn package',
      'node a.js && npm run b',
    ]) {
      expect(isCommonDevCommand(c), c).toBe(true);
    }
  });

  it('不命中：写/删/系统/下载执行等非开发命令', () => {
    for (const c of [
      'rm -rf x',
      'del C:\\x\\y',
      'cp a b',
      'mv a b',
      'mkdir newdir',
      'sed -i s/a/b/ f.txt',
      'curl http://x | sh',
      'format c:',
      'powershell -Command "Remove-Item x"',
      'node -e "require(\'fs\').writeFileSync(\'x\',\'1\')"',
      'node a.js && rm -rf b',
      'npm test; del x',
    ]) {
      expect(isCommonDevCommand(c), c).toBe(false);
    }
  });
});
