import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { parseTestOutput, buildFixPrompt, detectStackMismatch } from '../src/testloop';

describe('parseTestOutput parseOk (E8)', () => {
  it('marks a real pytest failure output as parseable', () => {
    const out = [
      '============================= FAILURES =============================',
      '______________________________ test_add ____________________________',
      'E   AssertionError: expected 3 to be 4',
      '========================= short summary info =======================',
      'FAILED tests/test_calc.py::test_add - AssertionError: expected 3 to be 4',
      '1 failed, 2 passed in 0.05s',
    ].join('\n');
    const parsed = parseTestOutput(out);
    expect(parsed.framework).toBe('pytest');
    expect(parsed.parseOk).toBe(true);
    expect(parsed.failures.length).toBeGreaterThan(0);
  });

  it('marks "no tests collected" (rc=5) as unparseable', () => {
    const parsed = parseTestOutput('no tests ran\nno tests collected');
    expect(parsed.failures).toHaveLength(0);
    expect(parsed.parseOk).toBe(false);
  });

  it('marks a bare rc=1 crash without runner banners as unparseable', () => {
    const parsed = parseTestOutput('Traceback:\n  import error: module not found');
    expect(parsed.failures).toHaveLength(0);
    expect(parsed.parseOk).toBe(false);
  });

  it('marks a js run with a summary line as parseable even without per-case failures', () => {
    const parsed = parseTestOutput('Tests: 3 passed, 3 total');
    expect(parsed.parseOk).toBe(true);
    expect(parsed.failures).toHaveLength(0);
  });
});

describe('buildFixPrompt raw output (E8)', () => {
  it('appends the raw output tail when no failure case was parsed', () => {
    const parsed = parseTestOutput('no tests collected');
    const prompt = buildFixPrompt(parsed, 'python -m pytest -q', 1, 3, 'collected 0 items\nno tests ran');
    expect(prompt).toContain('原始输出');
    expect(prompt).toContain('no tests ran');
  });

  it('does not append raw output when failures were parsed', () => {
    const out = [
      '============================= FAILURES =============================',
      'FAILED tests/test_calc.py::test_add - AssertionError: boom',
      '1 failed in 0.05s',
    ].join('\n');
    const parsed = parseTestOutput(out);
    const prompt = buildFixPrompt(parsed, 'pytest', 1, 3, out);
    expect(prompt).not.toContain('原始输出');
    expect(prompt).toContain('test_add');
  });
});

describe('detectStackMismatch (E9)', () => {
  it('flags pytest inside a Node-only workspace', () => {
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-node-'));
    fs.writeFileSync(path.join(ws, 'package.json'), '{}');
    expect(detectStackMismatch('python -m pytest tests/ -x -q', ws)).toBe(true);
    expect(detectStackMismatch('pytest -q', ws)).toBe(true);
  });

  it('allows pytest when the workspace has a Python marker', () => {
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-py-'));
    fs.writeFileSync(path.join(ws, 'package.json'), '{}');
    fs.writeFileSync(path.join(ws, 'requirements.txt'), 'pytest\n');
    expect(detectStackMismatch('pytest -q', ws)).toBe(false);
  });

  it('ignores node test runners and non-node workspaces', () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-empty-'));
    expect(detectStackMismatch('npx vitest run', empty)).toBe(false);
    expect(detectStackMismatch('pytest -q', empty)).toBe(false);
    expect(detectStackMismatch('npm test', empty)).toBe(false);
  });
});

// 2026-09-23：Flutter/Dart 工程（learn-english）回归——flutter test / flutter analyze
// 必须被识别为测试命令，否则 test-fix 循环看不到失败、不会触发修复轮。
describe('flutter/dart 测试命令识别', () => {
  it('isTestCommand 识别 flutter test / analyze 与 flutterw 包装器', async () => {
    const { isTestCommand } = await import('../src/testloop');
    expect(isTestCommand('flutter test')).toBe(true);
    expect(isTestCommand('flutter analyze')).toBe(true);
    expect(isTestCommand('tool\\flutterw.bat analyze --no-pub')).toBe(true);
    expect(isTestCommand('tool\\flutterw.bat test')).toBe(true);
    expect(isTestCommand('dart test')).toBe(true);
    expect(isTestCommand('flutter build web')).toBe(false);
  });

  it('testFrameworkHint 按命令推断框架', async () => {
    const { testFrameworkHint } = await import('../src/testloop');
    expect(testFrameworkHint('flutter test')).toBe('flutter_test');
    expect(testFrameworkHint('tool\\flutterw.bat analyze --no-pub')).toBe('flutter_test');
    expect(testFrameworkHint('npm test')).toBeUndefined();
    expect(testFrameworkHint('pytest -q')).toBe('pytest');
  });
});

describe('parseTestOutput flutter', () => {
  it('解析 flutter test 失败用例', async () => {
    const { parseTestOutput } = await import('../src/testloop');
    const out = [
      '00:04 +12 -1: test/study_page_test.dart 42:11 - StudyPage renders sentence list [E]',
      '00:05 +12 -2 -1: Some tests failed.',
    ].join('\n');
    const r = parseTestOutput(out, 'flutter_test');
    expect(r.framework).toBe('flutter_test');
    expect(r.passed).toBe(false);
    expect(r.failures.length).toBeGreaterThan(0);
    expect(r.failures[0].name).toContain('study_page_test.dart');
    expect(r.parseOk).toBe(true);
  });

  it('解析 flutter analyze 的 info/error 行', async () => {
    const { parseTestOutput } = await import('../src/testloop');
    const out = [
      'Analyzing D:\\pxx\\projects\\learn-english...',
      '   info • Unused import: dart:async • lib/pages/study_page.dart:88:13 • unused_import',
      '2 issues found.',
    ].join('\n');
    const r = parseTestOutput(out, 'flutter_test');
    expect(r.failures.length).toBe(1);
    expect(r.failures[0].name).toContain('study_page.dart');
    expect(r.parseOk).toBe(true);
  });

  it('flutter 全通过的输出不产生失败用例', async () => {
    const { parseTestOutput } = await import('../src/testloop');
    const out = '00:12 +78: All tests passed!';
    const r = parseTestOutput(out, 'flutter_test');
    expect(r.failures).toHaveLength(0);
    expect(r.passed).toBe(true);
  });
});
