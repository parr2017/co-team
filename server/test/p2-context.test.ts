/**
 * P2 批次单测：token 估算校准、四级水位线（snip/elide 冻结不变量）、scratchpad、
 * 字节稳定性断言（同输入同字节——前缀缓存回归防线）。
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';

import { estimateTokensRaw, noteRealUsage, estimateTokensCalibrated, calibrationSnapshot } from '../src/tokenEstimator';
import { snipOldToolResults, elideLongToolResults } from '../src/contextWaterline';
import { scratchPut, scratchSearch, scratchFromToolCall } from '../src/scratchpad';
import { buildAgentHarness } from '../src/harness';
import { foldMessagesInto } from '../src/orchestrator/orchestrator';
import { initBus, closeBus } from '../src/bus';

beforeEach(async () => {
  process.env.COTEAM_FORCE_MEMORY = '1';
  closeBus();
  await initBus({ host: '127.0.0.1', port: 6399, db: 0 });
});

afterEach(() => {
  closeBus();
});

describe('P2.1 token 基线', () => {
  it('CJK ≈1 token/字，ASCII ≈4.2 字符/token', () => {
    const cjk = estimateTokensRaw('一二三四五');
    expect(cjk).toBe(5);
    const ascii = estimateTokensRaw('abcdefghij'); // 10 字符
    expect(ascii).toBeGreaterThanOrEqual(2);
    expect(ascii).toBeLessThanOrEqual(3);
    expect(estimateTokensRaw('')).toBe(0);
  });

  it('校准环：真实用量拉近估算比（EMA），限幅防遥测炸穿', () => {
    const before = calibrationSnapshot();
    noteRealUsage(1000, 'a'.repeat(1000)); // raw ≈ 238 → sample ≈ 4.2 → clamp 2.0
    const after = calibrationSnapshot();
    expect(after.calibrated).toBe(true);
    expect(after.ratio).toBeGreaterThan(before.ratio);
    expect(after.ratio).toBeLessThanOrEqual(2.0);
    // 反向：真实远小于估算 → 比值下调但不低于 0.6
    noteRealUsage(10, 'a'.repeat(10000)); // raw ≈ 2381 → sample ≈ 0.004 → clamp 0.6
    expect(calibrationSnapshot().ratio).toBeGreaterThanOrEqual(0.6);
    // 校准后的估算 = raw × ratio
    const raw = estimateTokensRaw('hello world');
    expect(estimateTokensCalibrated('hello world')).toBe(Math.ceil(raw * calibrationSnapshot().ratio));
  });
});

describe('P2.2 四级水位线（snip/elide）', () => {
  const longText = 'x'.repeat(6000);
  const mkMsgs = () => [
    { role: 'system', content: 'sys' },
    { role: 'user', content: '任务指令' },
    { role: 'assistant', content: '{"tool_calls":[{"tool":"read_file","path":"a.txt"}]}' },
    { role: 'user', content: `工具执行结果：\n${JSON.stringify([{ tool: 'read_file', path: 'a.txt', ok: true, content: longText }])}` },
    { role: 'assistant', content: '{"tool_calls":[{"tool":"read_file","path":"b.txt"}]}' },
    { role: 'user', content: `工具执行结果：\n${JSON.stringify([{ tool: 'read_file', path: 'b.txt', ok: true, content: longText }])}` },
  ];

  it('snip：超长值掐头去尾 + SNIPPED 标记；幂等（再次调用字节不变）', () => {
    const msgs = mkMsgs();
    const n = snipOldToolResults(msgs, { snipChars: 1500, protectTail: 0 });
    expect(n).toBe(2);
    const snippedJson = JSON.parse(msgs[3].content.split('工具执行结果：\n')[1]);
    expect(snippedJson[0].content).toContain('SNIPPED');
    expect((snippedJson[0].content as string).length).toBeLessThan(2000);
    // 幂等：再跑一次没有任何改写（冻结不变量——跨轮字节稳定）
    const snapshot = JSON.stringify(msgs);
    const n2 = snipOldToolResults(msgs, { snipChars: 1500, protectTail: 0 });
    expect(n2).toBe(0);
    expect(JSON.stringify(msgs)).toBe(snapshot);
  });

  it('snip：错误文本永不裁剪（自我纠正依据）', () => {
    const msgs: { role: string; content: string }[] = [
      { role: 'user', content: 'x' },
      { role: 'user', content: 'x' },
      { role: 'user', content: 'x' },
      { role: 'user', content: `工具执行结果：\n${JSON.stringify([{ tool: 'exec', ok: false, error: 'E'.repeat(5000) }])}` },
    ];
    snipOldToolResults(msgs, { snipChars: 200, protectTail: 0 });
    const parsed = JSON.parse(msgs[3].content.split('工具执行结果：\n')[1]);
    expect((parsed[0].error as string).length).toBe(5000);
  });

  it('尾部保护区：最近 N 条工具结果消息不动', () => {
    const msgs = mkMsgs();
    snipOldToolResults(msgs, { snipChars: 1500, protectTail: 2 });
    const last = JSON.parse(msgs[5].content.split('工具执行结果：\n')[1]);
    expect((last[0].content as string).length).toBe(6000); // 原文未动
  });

  it('elide：超长条目整体占位符化（保留 tool/path 定位字段 + 找回指引）', () => {
    const msgs = mkMsgs();
    elideLongToolResults(msgs, { elideChars: 3000, protectTail: 0 });
    const elided = JSON.parse(msgs[3].content.split('工具执行结果：\n')[1]);
    expect(elided[0]._elided).toBe(true);
    expect(elided[0].tool).toBe('read_file');
    expect(elided[0].path).toBe('a.txt');
    expect(String(elided[0].note)).toContain('重新调用同一工具');
  });
});

describe('P2.4 scratchpad', () => {
  it('确定性提取：read_file 成功 → 文件要点；失败 → 不记录；grep/exec 各按形态', () => {
    const se1 = scratchFromToolCall('read_file', { path: 'src/main.ts' }, { ok: true, content: 'import x\n// 注释\nfunction bootstrap() { init(); }' });
    expect(se1?.kind).toBe('file');
    expect(se1?.key).toBe('src/main.ts');
    expect(se1?.summary).toContain('bootstrap');
    const se2 = scratchFromToolCall('read_file', { path: 'a' }, { ok: false, error: 'x' });
    expect(se2).toBeNull();
    const se3 = scratchFromToolCall('grep', { pattern: 'TODO', path: 'src' }, { ok: true, output: 'src/a.ts:1: TODO fix' });
    expect(se3?.summary).toContain('TODO fix');
    const se4 = scratchFromToolCall('exec', { command: 'npm test' }, { ok: true, returncode: 0, stdout: 'all passed\n' });
    expect(se4?.summary).toContain('exit 0');
  });

  it('put/search：同 key 覆盖、关键词命中排序', async () => {
    await scratchPut('t-scr', { kind: 'file', key: 'src/main.ts', summary: '入口 bootstrap 初始化' });
    await scratchPut('t-scr', { kind: 'file', key: 'src/main.ts', summary: '入口 bootstrap 初始化（更新版）' });
    await scratchPut('t-scr', { kind: 'command', key: 'npm test', summary: 'exit 0 全部通过' });
    const all = await scratchSearch('t-scr', '');
    expect(all).toHaveLength(2); // 同 key 覆盖
    const hits = await scratchSearch('t-scr', 'bootstrap');
    expect(hits).toHaveLength(1);
    expect(hits[0].summary).toContain('更新版');
  });
});

describe('P2.6 字节稳定性断言（前缀缓存回归防线）', () => {
  it('buildAgentHarness：同参数两次调用逐字节一致', () => {
    const args = { name: 'dev', role: '开发', description: '实现', prompt: '你是开发。' };
    const a = buildAgentHarness(args);
    const b = buildAgentHarness(args);
    expect(a).toBe(b);
    expect(a.length).toBeGreaterThan(500);
  });

  it('foldMessagesInto：同输入两次折叠产出逐字节一致（确定性折叠）', () => {
    const mk = () => [
      { role: 'system', content: 'sys' },
      { role: 'user', content: '任务指令' },
      { role: 'assistant', content: '{"tool_calls":[{"tool":"read_file","path":"a.txt"}]}' },
      { role: 'user', content: `工具执行结果：\n${JSON.stringify([{ tool: 'read_file', path: 'a.txt', ok: true, content: 'content-a' }])}` },
      { role: 'assistant', content: '{"tool_calls":[{"tool":"grep","pattern":"x"}]}' },
      { role: 'user', content: `工具执行结果：\n${JSON.stringify([{ tool: 'grep', ok: true, output: 'hit' }])}` },
      { role: 'assistant', content: 'final text' },
      { role: 'user', content: '工具执行结果：\n[]' },
    ];
    const m1 = mk();
    const m2 = mk();
    expect(foldMessagesInto(m1)).toBe(true);
    expect(foldMessagesInto(m2)).toBe(true);
    expect(JSON.stringify(m1)).toBe(JSON.stringify(m2));
  });
});
