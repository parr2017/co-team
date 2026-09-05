import { describe, expect, it } from 'vitest';
import { buildAgentHarness, validateAgentResult, buildRepairMessage } from '../src/harness';

const baseCtx = {
  name: 'dev',
  role: '开发',
  description: '负责代码实现',
  prompt: '你擅长 TypeScript 后端开发。',
  projectBlock: '- 使用 UTF-8 编码',
  goalBlock: '消除项目缺陷，交付可靠代码',
  docsBlock: '### TASK_SPEC v3\n实现 X 模块',
  knowledgeBlock: '- 【踩坑】时间单位陷阱',
  memories: ['上次在 auth 模块踩过序列化的坑'],
  round: 0,
  maxRounds: 3,
};

describe('harness: layered system prompt', () => {
  const prompt = buildAgentHarness(baseCtx);

  it('contains all seven layers', () => {
    expect(prompt).toContain('# 身份与使命');
    expect(prompt).toContain('# 行为准则（不可协商）');
    expect(prompt).toContain('# 协同上下文');
    expect(prompt).toContain('# 工作流契约');
    expect(prompt).toContain('# 工具策略');
    expect(prompt).toContain('# 输出契约');
    expect(prompt).toContain('# 升级语义');
  });

  it('L1 carries the agent identity and specialty prompt', () => {
    expect(prompt).toContain('「dev」Agent');
    expect(prompt).toContain('你擅长 TypeScript 后端开发。');
  });

  it('L3 carries every injected context block', () => {
    expect(prompt).toContain('使用 UTF-8 编码');
    expect(prompt).toContain('消除项目缺陷');
    expect(prompt).toContain('TASK_SPEC v3');
    expect(prompt).toContain('时间单位陷阱');
    expect(prompt).toContain('序列化的坑');
  });

  it('L5 shows the current round budget', () => {
    const r1 = buildAgentHarness({ ...baseCtx, round: 0, maxRounds: 3 });
    const r3 = buildAgentHarness({ ...baseCtx, round: 2, maxRounds: 3 });
    expect(r1).toContain('当前第 1/3 轮，剩余 2 轮');
    expect(r3).toContain('当前第 3/3 轮，剩余 0 轮');
    expect(r3).toContain('最后的侦查机会');
  });

  it('L6 output contract names the verification field', () => {
    expect(prompt).toContain('"verification"');
    expect(prompt).toContain('高频错误');
  });

  it('escalation context is appended when escalate=true', () => {
    const p = buildAgentHarness({ ...baseCtx, escalate: true, lastError: '测试连续失败' });
    expect(p).toContain('此前已尝试多次均失败');
    expect(p).toContain('测试连续失败');
  });

  it('skills block lands in L3 when provided (skill system seam)', () => {
    const p = buildAgentHarness({ ...baseCtx, skillsBlock: '### feishu-integration\n接入步骤…' });
    expect(p).toContain('已装载技能');
    expect(p).toContain('接入步骤…');
  });
});

describe('harness: validateAgentResult schema gate', () => {
  it('accepts a fully valid result', () => {
    const r = validateAgentResult({
      status: 'success', summary: '实现了 X', verification: '运行 vitest 全绿',
      changes: ['a.ts: added'], errors: [], files: [{ path: 'a.ts', content: '...' }], commands: ['vitest'],
    });
    expect(r.ok).toBe(true);
  });

  it('rejects non-object output', () => {
    expect(validateAgentResult(null).ok).toBe(false);
    expect(validateAgentResult('text').ok).toBe(false);
    expect(validateAgentResult([1]).ok).toBe(false);
  });

  it('flags missing status / empty summary / missing verification with specific messages', () => {
    const r = validateAgentResult({ summary: '', changes: [] });
    expect(r.ok).toBe(false);
    expect(r.violations.join('\n')).toContain('status');
    expect(r.violations.join('\n')).toContain('summary');
    expect(r.violations.join('\n')).toContain('verification');
  });

  it('flags wrong field types', () => {
    const r = validateAgentResult({
      status: 'ok', summary: 'x', verification: 'y',
      changes: 'not-array', files: [{ path: 'a.ts' }], commands: [1],
    });
    expect(r.ok).toBe(false);
    const joined = r.violations.join('\n');
    expect(joined).toContain('status');
    expect(joined).toContain('changes');
    expect(joined).toContain('files[0]');
    expect(joined).toContain('commands');
  });

  it('buildRepairMessage lists each violation numbered', () => {
    const msg = buildRepairMessage(['summary 为空', 'changes 必须是字符串数组']);
    expect(msg).toContain('1. summary 为空');
    expect(msg).toContain('2. changes 必须是字符串数组');
    expect(msg).toContain('输出契约');
  });
});
