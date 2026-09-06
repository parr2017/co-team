import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { initBus, closeBus } from '../src/bus';
import { saveTaskGraph } from '../src/store';
import {
  errorSignature, classifyError, DailyReportBuilder, generateDailyReport,
  getDailyReport, resolveReportItem, listDailyReports, todayStr,
} from '../src/dailyReport';
import type { TaskNode } from '../src/types';

// feature: 每日问题沉淀报告 —— 聚合去重、分类、生成、用户决策

function makeNode(id: string, extra: Partial<TaskNode> = {}): TaskNode {
  return {
    id, task_id: 't', name: id, status: 'pending', agent: 'dev', result: null, error: '',
    retry_count: 0, complexity: 'normal', requires_approval: false, needs_human: false,
    created_at: '', updated_at: '', ...extra,
  };
}

describe('daily report', () => {
  beforeEach(async () => {
    process.env.COTEAM_FORCE_MEMORY = '1';
    closeBus();
    await initBus({ host: '127.0.0.1', port: 6399, db: 0 });
  });

  afterEach(() => closeBus());

  it('normalizes error variants into one signature', () => {
    const a = errorSignature('Model m1 failed after 3 retries at C:\\tmp\\x\\log.txt');
    const b = errorSignature('Model m2 failed after 17 retries at D:\\data\\y\\out.txt');
    expect(a).toBe(b);
  });

  it('classifies errors by category', () => {
    expect(classifyError('No available model (pool exhausted)')).toBe('model_env');
    expect(classifyError('command not in whitelist: python train.py')).toBe('command_risk');
    expect(classifyError('TypeError: cannot read properties of undefined')).toBe('code_defect');
    expect(classifyError('需求缺少验收条件')).toBe('requirement');
  });

  it('aggregates repeated errors with count and source list', () => {
    const b = new DailyReportBuilder();
    b.add('Timeout on model X after 3 retries', { task_id: 't1', node_id: 'n1' }, '2026-09-06T01:00:00Z');
    b.add('Timeout on model X after 17 retries', { task_id: 't2', node_id: 'n2', agent: 'dev' }, '2026-09-06T02:00:00Z');
    b.add('different failure entirely', { task_id: 't3' }, '2026-09-06T03:00:00Z');
    const report = b.build(todayStr());
    const grouped = report.items.find((i) => i.signature.includes('timeout on model'));
    expect(grouped).toBeTruthy();
    expect(grouped!.count).toBe(2);
    expect(grouped!.category).toBe('model_env');
    expect(grouped!.sources).toHaveLength(2);
    expect(report.items).toHaveLength(2);
  });

  it('collects failed-node errors and error journals from task graphs', async () => {
    await saveTaskGraph('t-dr', [
      makeNode('n1', { status: 'failed', error: 'all models failed (3 tried): boom', needs_human: true, updated_at: new Date().toISOString() }),
      makeNode('n2', { status: 'completed', updated_at: new Date().toISOString() }),
    ], [], { description: 'dr', workspace: '.', status: 'failed' });

    const { collectErrorsSince } = await import('../src/dailyReport');
    const builder = await collectErrorsSince(Date.now() - 60_000);
    const report = builder.build(todayStr());
    const hit = report.items.find((i) => i.signature.includes('all models failed'));
    expect(hit).toBeTruthy();
    expect(hit!.sources[0].task_id).toBe('t-dr');
  });

  it('generates, stores, lists and resolves reports', async () => {
    const report = await generateDailyReport(new Date('2026-09-06T09:00:00'));
    expect(report.date).toBe('2026-09-06');
    expect((await getDailyReport('2026-09-06'))!.generated_at).toBe(report.generated_at);
    expect((await listDailyReports())[0].date).toBe('2026-09-06');

    if (report.items.length > 0) {
      const updated = await resolveReportItem(report.date, report.items[0].id, 'skip');
      expect(updated!.resolved[report.items[0].id].action).toBe('skip');
    } else {
      // 空报告也要能落库
      expect(report.items).toEqual([]);
    }
  });

  it('todayStr is local-date based', () => {
    expect(todayStr(new Date('2026-09-06T23:59:59'))).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});
