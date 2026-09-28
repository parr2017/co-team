/**
 * 权限申请归一化（opencode-sync/perm）单测。
 * 载荷样本全部来自实盘抓包（GET /api/opencode/pending 与 permission.asked 事件），
 * 不再用早期虚构的 { title, pattern, command, type } 形状——那套字段在 2.x 根本不存在，
 * 正是"飞书看不出申请的是什么权限"的根因。
 */
import { describe, expect, it } from 'vitest';
import { normalizePermAction, permActionLabel, permSummaryOf, permViewOf } from '@co-team/opencode-sync';

/** 实盘：desktop 实例待批的读取权限 */
const REAL_READ = {
  instance: 'desktop',
  id: 'per_0e577dab90010sz8Y9JHoQYXhd',
  sessionID: 'ses_f1af29bbeffeLM333ibG510SCJ',
  action: 'read',
  resources: ['backend/.env'],
  save: ['*'],
  source: { type: 'tool', messageID: 'msg_0e577d076001EBPKjLyEEBSJ0U', id: 'call_function_g7b613bbna04_1' },
  instance_label: '桌面版 / TUI（自动发现）',
};

/** 实盘：跨项目目录访问 */
const REAL_EXTERNAL = {
  ...REAL_READ,
  id: 'per_0e575ed77001p6XCMrYHihOcui',
  action: 'external_directory',
  resources: ['D:/Develop/qdrant/*'],
  save: ['D:/Develop/qdrant/*'],
};

describe('permViewOf 实盘载荷', () => {
  it('read：动作中文化 + 目标/总是批准规则都取自 v2 字段', () => {
    const v = permViewOf(REAL_READ)!;
    expect(v.action).toBe('read');
    expect(v.label).toBe('读取文件');
    expect(v.resources).toEqual(['backend/.env']);
    expect(v.alwaysRule).toBe('*');
    expect(v.summary).toBe('读取文件 backend/.env');
    expect(v.lines.map((l) => l.label)).toEqual(['动作', '目标', '总是批准将记住']);
    expect(v.lines[0].value).toBe('读取文件（read）');
    expect(v.lines[1].value).toBe('backend/.env');
  });

  it('external_directory：带下划线的动作名也能中文化', () => {
    const v = permViewOf(REAL_EXTERNAL)!;
    expect(v.label).toBe('访问项目外目录');
    expect(v.resources).toEqual(['D:/Develop/qdrant/*']);
    expect(v.summary).toBe('访问项目外目录 D:/Develop/qdrant/*');
  });

  it('多资源：摘要给计数，主行只给前 3 条 + 计数（全量留给折叠区）', () => {
    const v = permViewOf({ id: 'p1', action: 'bash', resources: ['rm -rf dist', 'rm -rf build'], save: ['rm -rf *'] })!;
    expect(v.label).toBe('执行命令');
    expect(v.summary).toBe('执行命令 rm -rf dist 等 2 项');
    expect(v.alwaysRule).toBe('rm -rf *');
    const many = Array.from({ length: 8 }, (_, i) => `pkg-${i}`);
    const mv = permViewOf({ id: 'p2', action: 'bash', resources: many })!;
    expect(mv.lines.find((l) => l.label === '目标')!.value).toBe('pkg-0 , pkg-1 , pkg-2 , 等 8 项');
  });

  it('alwaysRule 为通配时点明含义（别让「记住 *」被读成只放行一次）', () => {
    const v = permViewOf(REAL_READ)!;
    expect(v.alwaysRule).toBe('*');                                   // 原始值不动
    expect(v.lines.find((l) => l.label === '总是批准将记住')!.value).toBe('*（该动作不限具体对象）');
  });

  it('超长资源截断到 300 字（卡片主行不被撑爆）', () => {
    const long = 'echo '.repeat(400);
    const v = permViewOf({ id: 'p1', action: 'bash', resources: [long] })!;
    const target = v.lines.find((l) => l.label === '目标')!;
    expect(target.value.length).toBeLessThanOrEqual(301);
    expect(target.value.endsWith('…')).toBe(true);
  });

  it('metadata 剩余项进 extra，已消费的 command/pattern 不重复出现', () => {
    const v = permViewOf({ id: 'p1', action: 'bash', resources: [], metadata: { command: 'ls -la', reason: '排查' } })!;
    expect(v.resources).toEqual(['ls -la']);          // command 被消费成资源
    expect(v.extra).toContain('排查');
    expect(v.extra).not.toContain('ls -la');
  });
});

describe('permViewOf 旧字段兜底（v1 / 更早形状）', () => {
  it('v1 permission+patterns 仍能读出动作与目标', () => {
    const v = permViewOf({ id: 'p1', permission: 'edit', patterns: ['src/a.ts'] })!;
    expect(v.label).toBe('修改文件');
    expect(v.resources).toEqual(['src/a.ts']);
  });

  it('早期虚构形状（title/pattern/command）不再退化成空文案', () => {
    // 无 action 但有 title+pattern：标题当说明、pattern 当目标，信息照样出得来
    const v = permViewOf({ id: 'p1', title: 'rm -rf dist', pattern: ['rm -rf dist'] })!;
    expect(v.summary).toBe('权限请求 rm -rf dist');
    expect(v.lines.map((l) => l.label)).toEqual(['动作', '目标']);
    expect(permViewOf({ id: 'p1', command: 'npm install', type: 'bash' })!.summary).toBe('执行命令 npm install');
  });

  it('空载荷给出可读兜底，不返回空串', () => {
    expect(permViewOf({ id: 'p1' })!.summary).toBe('权限请求');
    expect(permSummaryOf({})).toBe('权限请求');
    expect(permSummaryOf(null)).toBe('权限请求');
    expect(permViewOf(null)).toBeNull();
  });

  it('未登记的动作回落原名（宁可 ugly 也不空手）', () => {
    expect(permActionLabel('quantum_teleport')).toBe('quantum_teleport');
    expect(normalizePermAction('External-Directory')).toBe('externaldirectory');
  });
});
