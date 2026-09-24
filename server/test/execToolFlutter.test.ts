import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { applyToolCalls } from '../src/tools';
import { policyFromConfig, policyWithLevel, canExecute } from '../src/sandbox';

/**
 * 端到端（learn-english 真实场景）：任务 agent 在 whitelist_auto 策略下
 * 要跑 `tool\flutterw.bat test`——
 *  1. canExecute 因扩展名归一化而命中；
 *  2. exec 工具真实 spawn 并把 stdout 回给模型；
 *  3. 非白名单命令（flutter build）park 成 pending_command。
 */
describe('exec 工具端到端（flutter 场景）', () => {
  let ws: string;

  // 生成一个假的 flutterw.bat 包装器（不依赖真 SDK，只验证调用链）
  const BAT = [
    '@echo off',
    'if "%1"=="test" (echo 00:12 +78: All tests passed! & exit /b 0)',
    'if "%1"=="analyze" (echo 2 issues found. & exit /b 0)',
    'echo unknown & exit /b 1',
  ].join('\r\n');

  it('白名单内包装器命令：真实执行且 stdout 回传', async () => {
    ws = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-flut-'));
    fs.mkdirSync(path.join(ws, 'tool'), { recursive: true });
    fs.writeFileSync(path.join(ws, 'tool', 'flutterw.bat'), BAT);

    const policy = policyFromConfig({ level: 'whitelist_auto', whitelist_commands: ['flutterw'] });
    expect(canExecute(policy, 'tool\\flutterw.bat test')).toBe(true);

    const [r] = await applyToolCalls(ws, [{ tool: 'exec', command: 'tool\\flutterw.bat test' }], undefined, policy) as any[];
    expect(r.ok).toBe(true);
    expect(r.returncode).toBe(0);
    expect(r.tool).toBe('exec');
    // stdout 尾部 3000 内保留真标记
    expect(r.stdout).toContain('All tests passed');

    const [a] = await applyToolCalls(ws, [{ tool: 'exec', command: 'tool\\flutterw.bat analyze --no-pub' }], undefined, policy) as any[];
    expect(a.ok).toBe(true);
    expect(a.stdout).toContain('2 issues found');
    fs.rmSync(ws, { recursive: true, force: true });
  });

  it('白名单外命令：park 成 pending_command，不硬拒不假完成', async () => {
    ws = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-flut2-'));
    fs.mkdirSync(path.join(ws, 'tool'), { recursive: true });
    fs.writeFileSync(path.join(ws, 'tool', 'flutterw.bat'), BAT);

    const policy = policyFromConfig({ level: 'whitelist_auto', whitelist_commands: ['echo'] });
    const [r] = await applyToolCalls(ws, [{ tool: 'exec', command: 'tool\\flutterw.bat test' }], undefined, policy) as any[];
    expect(r.ok).toBe(false);
    expect(r.needs_approval).toBe(true);
    expect(r.pending_command).toBe('tool\\flutterw.bat test');
    expect(String(r.error)).toContain('command not in whitelist');
    fs.rmSync(ws, { recursive: true, force: true });
  });

  it('approve_required：白名单外 park 且文案是"等待人工审批"', async () => {
    ws = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-flut3-'));
    fs.mkdirSync(path.join(ws, 'tool'), { recursive: true });
    fs.writeFileSync(path.join(ws, 'tool', 'flutterw.bat'), BAT);
    const policy = policyFromConfig({ level: 'approve_required', whitelist_commands: ['echo'] });
    const [r] = await applyToolCalls(ws, [{ tool: 'exec', command: 'flutter test' }], undefined, policy) as any[];
    expect(r.needs_approval).toBe(true);
    expect(String(r.error)).toContain('等待人工审批');
    fs.rmSync(ws, { recursive: true, force: true });
  });

  it('full 策略：目录内完全控制，flutterw 直接跑（无需白名单）', async () => {
    ws = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-flut4-'));
    fs.mkdirSync(path.join(ws, 'tool'), { recursive: true });
    fs.writeFileSync(path.join(ws, 'tool', 'flutterw.bat'), BAT);
    const policy = policyFromConfig({ level: 'full' });
    expect(canExecute(policy, 'anything')).toBe(true);
    const [r] = await applyToolCalls(ws, [{ tool: 'exec', command: 'tool\\flutterw.bat test' }], undefined, policy) as any[];
    expect(r.ok).toBe(true);
    fs.rmSync(ws, { recursive: true, force: true });
  });

  it('unrestricted 任务策略：jailBypass 生效（越界非开发命令 park）', async () => {
    ws = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-flut5-'));
    fs.writeFileSync(path.join(ws, 'a.txt'), 'x');
    const policy = policyWithLevel(policyFromConfig({ level: 'whitelist_auto', whitelist_commands: ['cat'] }), { level: 'unrestricted' });
    expect(policy.jailBypass).toBe(true);
    // 越界 + 非常见开发命令（rm）→ park，reason=jail_out_of_scope
    const [rm] = await applyToolCalls(ws, [{ tool: 'exec', command: 'rm ..\\outside.txt' }], undefined, policy) as any[];
    expect(rm.needs_approval).toBe(true);
    expect(rm.reason).toBe('jail_out_of_scope');
    // 越界 + 常见开发命令（node）→ 直接执行（不 park）
    const [node] = await applyToolCalls(ws, [{ tool: 'exec', command: 'node -e "process.exit(0)"' }], undefined, policy) as any[];
    expect(node.needs_approval).toBeFalsy();
    expect(node.returncode).toBe(0);
    fs.rmSync(ws, { recursive: true, force: true });
  });

  it('plan_only / readonly：exec 硬拒', async () => {
    ws = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-flut6-'));
    for (const lv of ['plan_only', 'readonly']) {
      const policy = policyFromConfig({ level: lv });
      const [r] = await applyToolCalls(ws, [{ tool: 'exec', command: 'echo hi' }], undefined, policy) as any[];
      expect(r.ok).toBe(false);
      expect(String(r.error)).toContain('不允许执行命令');
    }
    fs.rmSync(ws, { recursive: true, force: true });
  });
});
