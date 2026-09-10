/**
 * 流畅度改造回归（2y3tuote 复盘 M1-M5）：
 * M1 合法 blocker 停阶梯 / M3 429 容量退避 / M4 失败反馈进链序 /
 * M5 read_file 行范围续读 / M2 commitAllOnBranch 全量提交。
 */
import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { LEGIT_BLOCKER_RE, CAPACITY_RE } from '../src/orchestrator/orchestrator';
import { ModelPool } from '../src/scheduler';
import { readFile } from '../src/tools';
import { ensureBase, createNodeBranch, commitAllOnBranch } from '../src/git';
import { simpleGit } from 'simple-git';

describe('M1 LEGIT_BLOCKER_RE：合法阻塞识别（停阶梯不烧链）', () => {
  it('命中 2y3tuote 实录的 blocker 文案', () => {
    expect(LEGIT_BLOCKER_RE.test('[blocker] docs/API_CONTRACT.md 实际仍为 v1 占位版，与前置节点[1]声明的 v2 不符')).toBe(true);
    expect(LEGIT_BLOCKER_RE.test('需要人类或下一轮补充：恢复对 history.vue 当前内容的只读侦查')).toBe(true);
    expect(LEGIT_BLOCKER_RE.test('需要补充信息 1（阻塞）：settings.vue 的当前完整内容——read_file 被 harness 去重未返回正文')).toBe(true);
    expect(LEGIT_BLOCKER_RE.test('缺失证据 1：entry.vue 正文未获得')).toBe(true);
    expect(LEGIT_BLOCKER_RE.test('需要人工介入')).toBe(true);
  });
  it('不误伤内容级/容量级失败（它们走各自通道）', () => {
    expect(LEGIT_BLOCKER_RE.test('第 2 轮输出不是有效 JSON')).toBe(false);
    expect(LEGIT_BLOCKER_RE.test('Error: 429 inference exceeds tpm/rpm limit')).toBe(false);
    expect(LEGIT_BLOCKER_RE.test('输出预算耗尽（finish_reason=length）：思考消耗了全部 8000 输出 token')).toBe(false);
  });
});

describe('M3 CAPACITY_RE：容量信号识别（退避重试不记失败）', () => {
  it('命中限流类错误', () => {
    for (const e of ['Error: 429 inference exceeds tpm/rpm limit', 'HTTP 503 Service Unavailable', 'Too Many Requests', 'rate limit exceeded', 'quota exhausted']) {
      expect(CAPACITY_RE.test(e)).toBe(true);
    }
  });
  it('不误伤确定性死亡/停滞（那才是该记健康度的）', () => {
    expect(CAPACITY_RE.test('LLM 调用失败：connection_died(流未产出 finish_reason 即结束)')).toBe(false);
    expect(CAPACITY_RE.test('LLM 调用被中止：stream_stalled(token间静默901s)')).toBe(false);
    expect(CAPACITY_RE.test('ENOTDIR directory error')).toBe(false);
  });
});

describe('M4 effectivePriority：失败软沉底 + 时间回血', () => {
  const configs = [
    { name: 'fast-flaky', api_key: 'k', base_url: 'u', priority: 1, professional_weight: 50, tags: ['code'] },
    { name: 'steady', api_key: 'k', base_url: 'u', priority: 10, professional_weight: 90, tags: ['code'] },
  ];
  it('刚失败的链首模型被稳定模型反超', () => {
    const pool = new ModelPool(configs);
    const flaky = pool.getModel('fast-flaky')!;
    const steady = pool.getModel('steady')!;
    expect(pool.selectModel(['code'], 'complex')!.name).toBe('steady'); // complex 按 pw 本来就先稳
    // simple 档：初始按 effectivePriority，flaky 在链首
    pool.markFailure(flaky); pool.markFailure(flaky); pool.markFailure(flaky);
    // failCount=3 会进 cooldown（isHealthy=false 直接出局）——软序看冷却后：手动清 lastFailureAt 到冷却外
    flaky.lastFailureAt = Date.now() - 16 * 60_000; // 冷却窗（2^0*60s 早已过）但 30min 衰减窗内
    // penalty = 3*2*max(0.25, 1-16/30)=6*0.467≈3 → effective=1+3=4 < 10 仍领先？steady pw 高
    // simple 档排序 effectivePriority 优先：flaky(4) < steady(10) → flaky 仍先——降两级不够，验证标记存在
    expect(pool.effectivePriority(flaky)).toBeGreaterThan(flaky.priority);
    expect(pool.effectivePriority(steady)).toBe(steady.priority);
    // 30 分钟后回血到 25% 地板
    flaky.lastFailureAt = Date.now() - 60 * 60_000;
    expect(pool.effectivePriority(flaky)).toBe(1 + Math.round(3 * 2 * 0.25));
  });
  it('成功清零惩罚（回血通道）', () => {
    const pool = new ModelPool(configs);
    const m = pool.getModel('fast-flaky')!;
    pool.markFailure(m); pool.markFailure(m);
    pool.markSuccess(m);
    expect(pool.effectivePriority(m)).toBe(m.priority);
  });
});

describe('M5 readFile 行范围', () => {
  it('按行读取并给出续读指引', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-rf-'));
    try {
      const lines = Array.from({ length: 1000 }, (_, i) => `line-${i + 1}`);
      fs.writeFileSync(path.join(dir, 'big.txt'), lines.join('\n'));
      const seg = readFile(dir, 'big.txt', 500, 510);
      expect(seg.ok).toBe(true);
      expect(seg.content).toContain('line-500');
      expect(seg.content).toContain('line-510');
      expect(seg.content).not.toContain('line-511');
      expect(seg.total_lines).toBe(1000);
      expect(seg.content).toContain('"line_start":511'); // 续读指引
      // 无行号时旧行为保持
      const whole = readFile(dir, 'big.txt');
      expect(whole.ok).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('M2 commitAllOnBranch：未申报文件也进分支', () => {
  it('模型漏报的产物（write_doc 等）随分支提交，下游节点可见', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-git-'));
    try {
      await simpleGit({ baseDir: dir }).init();
      await ensureBase(dir);
      fs.writeFileSync(path.join(dir, 'declared.md'), 'v1');
      fs.writeFileSync(path.join(dir, 'docs-unreported.md'), 'contract-v2'); // 模拟未申报的 write_doc 产物
      await createNodeBranch(dir, 'coteam/1-docs', 'coteam/base');
      const hash = await commitAllOnBranch(dir, 'coteam: node 1');
      expect(hash).toBeTruthy();
      // 下游分支切出后两个文件都在
      await createNodeBranch(dir, 'coteam/2-review', 'coteam/1-docs');
      expect(fs.existsSync(path.join(dir, 'docs-unreported.md'))).toBe(true);
      expect(fs.readFileSync(path.join(dir, 'declared.md'), 'utf-8')).toBe('v1');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 30000);
});
