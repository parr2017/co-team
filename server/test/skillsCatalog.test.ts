import { describe, expect, it } from 'vitest';
import { formatSkillsCatalog } from '../src/skills';

describe('formatSkillsCatalog', () => {
  it('全量名录：一行一条 name — 描述，无正文，含使用指引', () => {
    const out = formatSkillsCatalog([
      { name: 'code-review', description: '代码审查规范', body: 'x'.repeat(3000), tags: ['code'], source: 'global' },
      { name: 'pdf', description: '多行\n描述   收敛', body: 'y'.repeat(5000), tags: [], source: 'global' },
      { name: 'nodesc', description: '', body: 'z', tags: [], source: 'global' },
    ] as any);
    expect(out).toContain('- code-review — 代码审查规范');
    expect(out).toContain('- pdf — 多行 描述 收敛'); // 换行与多空白收敛
    expect(out).toContain('- nodesc'); // 无描述只出名字
    expect(out).not.toContain('x'.repeat(3000)); // 不含正文
    expect(out).toContain('load_skill');
  });

  it('空技能库返回空串（不注入空段）', () => {
    expect(formatSkillsCatalog([])).toBe('');
  });
});
