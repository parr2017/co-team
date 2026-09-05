import { describe, expect, it } from 'vitest';
import { gradeTask, configureGrader } from '../src/grader';

describe('grading keywords configurable (R6)', () => {
  it('built-in behavior is unchanged before any configuration', () => {
    expect(gradeTask('重构用户模块')).toBe('heavy');
    expect(gradeTask('修正 typo 错别字')).toBe('light');
    expect(gradeTask('实现一个登录接口')).toBe('standard');
  });

  it('custom heavy keywords classify matching tasks as heavy', () => {
    configureGrader({ heavy: ['多租户', '国际化'] });
    expect(gradeTask('为系统增加多租户支持')).toBe('heavy');
    expect(gradeTask('把文案改成国际化')).toBe('heavy');
    // built-ins still work alongside custom keywords
    expect(gradeTask('重构用户模块')).toBe('heavy');
    // non-matching stays standard
    expect(gradeTask('实现一个导出按钮')).toBe('standard');
  });

  it('custom light keywords classify matching tasks as light', () => {
    configureGrader({ light: ['改注释', '升级版本号'] });
    expect(gradeTask('改注释里的错别字说明')).toBe('light');
    expect(gradeTask('升级版本号到 1.2.3')).toBe('light');
    expect(gradeTask('实现复杂的分布式事务')).toBe('standard');
  });

  it('heavy wins over light when both match (built-in precedence preserved)', () => {
    configureGrader({ heavy: ['大扫除'], light: ['小清理'] });
    expect(gradeTask('大扫除式重构')).toBe('heavy');
  });

  it('reconfiguration replaces previous custom keywords', () => {
    configureGrader({ heavy: ['多租户'] });
    expect(gradeTask('多租户改造')).toBe('heavy');
    configureGrader({ light: ['改注释'] });
    // '多租户' is no longer a custom heavy keyword → back to standard
    expect(gradeTask('多租户改造')).toBe('standard');
    expect(gradeTask('改注释拼写')).toBe('light');
  });

  it('empty config resets custom keywords entirely', () => {
    configureGrader({ heavy: ['多租户'] });
    configureGrader({});
    expect(gradeTask('多租户改造')).toBe('standard');
  });
});
