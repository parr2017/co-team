import { describe, expect, it, vi, beforeEach } from 'vitest';
import { heuristicAssessment, isConfirmation, MAX_CLARIFY_ROUNDS } from '../src/clarify';
import { gradeTask, LEVEL_PROFILES, normalizeLevel } from '../src/grader';
import { parseTestOutput, buildFixPrompt, isTestCommand, findTestFailure, MAX_FIX_ROUNDS } from '../src/testloop';

describe('requirement clarification (improvement 5)', () => {
  it('heuristic accepts actionable short requirements without over-asking', () => {
    expect(heuristicAssessment('创建 hello.txt').clear).toBe(true);
    expect(heuristicAssessment('实现一个用户注册 API，要求密码加密存储，接口返回 JWT，验收标准为测试全部通过').clear).toBe(true);
  });

  it('heuristic flags vague requirements with targeted questions', () => {
    const a = heuristicAssessment('嗯');
    expect(a.clear).toBe(false);
    expect(a.questions.length).toBeGreaterThanOrEqual(1);
  });

  it('detects explicit human confirmation replies', () => {
    expect(isConfirmation('确认')).toBe(true);
    expect(isConfirmation('OK')).toBe(true);
    expect(isConfirmation('confirm!')).toBe(true);
    expect(isConfirmation('不确认')).toBe(false);
    expect(isConfirmation('确认一下，另外这个需求还要……')).toBe(false);
    expect(MAX_CLARIFY_ROUNDS).toBe(3);
  });
});

describe('task grading (improvement 7)', () => {
  it('grades architecture work as heavy and single-file tweaks as light', () => {
    expect(gradeTask('对整个系统进行架构重构，引入微服务')).toBe('heavy');
    expect(gradeTask('数据库从 MySQL 迁移到 PostgreSQL')).toBe('heavy');
    expect(gradeTask('修复 README 里的 typo')).toBe('light');
    expect(gradeTask('改一下按钮颜色')).toBe('light');
    expect(gradeTask('实现用户注册 API')).toBe('standard');
  });

  it('level profiles map to pipeline templates and human override wins', () => {
    expect(LEVEL_PROFILES.light.maxNodes).toBeLessThan(LEVEL_PROFILES.standard.maxNodes);
    expect(LEVEL_PROFILES.heavy.docs).toBe(true);
    expect(LEVEL_PROFILES.light.docs).toBe(false);
    expect(normalizeLevel('heavy')).toBe('heavy');
    expect(normalizeLevel('bogus')).toBeNull();
    expect(normalizeLevel('auto')).toBeNull();
  });
});

describe('test-fix loop parsing (improvement 8)', () => {
  it('detects test commands', () => {
    expect(isTestCommand('npm test')).toBe(true);
    expect(isTestCommand('npx vitest run src')).toBe(true);
    expect(isTestCommand('pytest -q')).toBe(true);
    expect(isTestCommand('python -m pytest tests/')).toBe(true);
    expect(isTestCommand('node build.js')).toBe(false);
    expect(isTestCommand('python main.py')).toBe(false);
  });

  it('finds a failing test command among results', () => {
    const fail = findTestFailure([
      { command: 'node build.js', returncode: 0, stderr: '' },
      { command: 'npm test', returncode: 1, stderr: 'FAIL src/a.test.ts' },
    ]);
    expect(fail?.command).toBe('npm test');
    expect(findTestFailure([{ command: 'npm test', returncode: 0, stderr: '' }])).toBeNull();
  });

  it('parses pytest failures with case names and messages', () => {
    const out = `
============================= short test summary info =============================
FAILED tests/test_calc.py::test_add - AssertionError: assert 3 == 4
FAILED tests/test_calc.py::test_sub - AssertionError: assert 1 == 0
========================= 2 failed, 5 passed in 0.12s =============================
`;
    const parsed = parseTestOutput(out, 'pytest');
    expect(parsed.framework).toBe('pytest');
    expect(parsed.passed).toBe(false);
    expect(parsed.failures).toHaveLength(2);
    expect(parsed.failures[0].name).toContain('test_add');
    expect(parsed.failures[0].message).toContain('assert 3 == 4');
  });

  it('parses vitest/jest failures', () => {
    const out = `
FAIL  src/math.test.ts ( 5 tests )
✕ adds numbers 12 ms
✕ subtracts numbers
Tests:  2 failed, 3 passed, 5 total
`;
    const parsed = parseTestOutput(out);
    expect(parsed.passed).toBe(false);
    expect(parsed.failures.map((f) => f.name)).toContain('adds numbers');
    expect(parsed.summary).toContain('failed');
  });

  it('builds a targeted fix prompt capped by max rounds', () => {
    const parsed = parseTestOutput('FAILED tests/test_a.py::test_x - AssertionError: boom', 'pytest');
    const prompt = buildFixPrompt(parsed, 'pytest -q', 2);
    expect(prompt).toContain('第 2/3 轮');
    expect(prompt).toContain('test_x');
    expect(prompt).toContain('boom');
    expect(MAX_FIX_ROUNDS).toBe(3);
  });
});
