import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { policyFromConfig, policyWithLevel, canExecute } from '../src/sandbox';
import { applyFinalOutput } from '../src/tools';

// feature: 命令执行分级 —— 五级策略解析与 applyFinalOutput 行为

describe('policy levels', () => {
  it('parses config: explicit level wins, legacy whitelist-only config behaves as whitelist_auto', () => {
    expect(policyFromConfig({ level: 'full', whitelist_commands: ['git'] }).level).toBe('full');
    expect(policyFromConfig({ whitelist_commands: ['git'] }).level).toBe('whitelist_auto');
    expect(policyFromConfig({}).level).toBe('approve_required');
    expect(policyFromConfig(null).level).toBe('approve_required');
    expect(policyFromConfig({ level: 'nonsense' }).level).toBe('approve_required');
  });

  it('policyWithLevel overlays a task-level policy onto the global one', () => {
    const base = policyFromConfig({ level: 'approve_required', whitelist_commands: ['git'] });
    expect(policyWithLevel(base, { level: 'full' }).level).toBe('full');
    expect(policyWithLevel(base, { level: 'full' }).whitelistCommands).toEqual(['git']);
    expect(policyWithLevel(base, { level: 'plan_only', whitelist_commands: ['npm'] }).whitelistCommands).toEqual(['npm']);
    // 无效 level 保持 base
    expect(policyWithLevel(base, { level: 'bogus' }).level).toBe('approve_required');
    // 无 override 原样返回
    expect(policyWithLevel(base, null)).toBe(base);
  });

  it('plan_only: nothing is written or executed, everything becomes a proposal', () => {
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-pol-'));
    try {
      const policy = { level: 'plan_only' as const, whitelistCommands: null, maxTimeSec: 10 };
      const out = applyFinalOutput(ws, {
        files: [{ path: 'a.txt', content: 'hello' }],
        commands: ['git status'],
        changes: [],
        summary: '方案',
      }, policy);
      expect(out.plan_only).toBe(true);
      expect(out.proposed.files).toEqual([{ path: 'a.txt', bytes: 5 }]);
      expect(out.proposed.commands).toEqual(['git status']);
      expect(fs.existsSync(path.join(ws, 'a.txt'))).toBe(false);
      expect(out.changes).toEqual([]);
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
    }
  });

  it('readonly: file writes are withheld, whitelisted commands still run', () => {
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-pol-'));
    try {
      const policy = { level: 'readonly' as const, whitelistCommands: ['git'], maxTimeSec: 10 };
      const out = applyFinalOutput(ws, {
        files: [{ path: 'a.txt', content: 'hello' }],
        commands: ['git log --oneline -1', 'npm install'],
        changes: [],
        summary: '',
      }, policy);
      expect(fs.existsSync(path.join(ws, 'a.txt'))).toBe(false);
      expect(out.proposed.files).toHaveLength(1);
      const results = out.command_results as { command: string; returncode: number; stderr: string }[];
      // git log 在白名单内（可能没有仓库但命令被允许执行）
      expect(results[0].stderr).not.toMatch('not in whitelist');
      // npm 不在白名单内 → 拒绝
      expect(results[1].returncode).toBe(-1);
      expect(results[1].stderr).toMatch('not in whitelist');
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
    }
  });

  it('approve_required: whitelisted runs, the rest is parked as pending_commands', () => {
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-pol-'));
    try {
      const policy = { level: 'approve_required' as const, whitelistCommands: ['git'], maxTimeSec: 10 };
      const out = applyFinalOutput(ws, {
        files: [{ path: 'a.txt', content: 'hello' }],
        commands: ['git status', 'python train.py --all'],
        changes: [],
        summary: '',
      }, policy);
      // 文件写入沙箱目录（approve_required 允许）
      expect(fs.readFileSync(path.join(ws, 'a.txt'), 'utf-8')).toBe('hello');
      expect(out.pending_commands).toEqual(['python train.py --all']);
      const results = out.command_results as { command: string; needs_approval?: boolean; returncode: number }[];
      expect(results[0].needs_approval).toBeFalsy();
      expect(results[1].needs_approval).toBe(true);
      expect(results[1].returncode).toBe(-1);
      // 待审批命令不算失败
      expect((out.errors as string[]).filter((e) => e.includes('train.py'))).toHaveLength(0);
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
    }
  });

  it('full: every command runs; whitelist_auto: non-whitelisted is rejected outright', () => {
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-pol-'));
    try {
      const full = { level: 'full' as const, whitelistCommands: ['git'], maxTimeSec: 10 };
      const auto = { level: 'whitelist_auto' as const, whitelistCommands: ['git'], maxTimeSec: 10 };
      const echo = 'echo ct-policy-probe';
      expect(canExecute(full, echo)).toBe(true);
      expect(canExecute(auto, echo)).toBe(false);

      const outFull = applyFinalOutput(ws, { files: [], commands: [echo], changes: [], summary: '' }, full);
      expect((outFull.command_results as { returncode: number }[])[0].returncode).toBe(0);
      expect(outFull.pending_commands).toBeUndefined();

      const outAuto = applyFinalOutput(ws, { files: [], commands: [echo], changes: [], summary: '' }, auto);
      expect((outAuto.command_results as { stderr: string }[])[0].stderr).toMatch('not in whitelist');
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
    }
  });
});
