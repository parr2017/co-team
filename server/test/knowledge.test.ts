import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  deleteKnowledge,
  getKnowledge,
  listKnowledge,
  recordKnowledgeHits,
  searchKnowledge,
  updateKnowledge,
  writeKnowledge,
} from '../src/knowledge';

function kbRoot(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-kb-'));
  return dir;
}

describe('knowledge base (improvement 3)', () => {
  it('writes markdown entries with frontmatter into category dirs', () => {
    const root = kbRoot();
    const { id } = writeKnowledge({ title: 'Redis key design', content: 'use short keys with TTL', category: 'general-tech', tags: ['redis', 'best-practice'], source: 'agent:dev task:t1' }, root);
    const file = fs.readdirSync(path.join(root, 'general-tech'))[0];
    expect(file).toBe(`${id}.md`);
    const raw = fs.readFileSync(path.join(root, 'general-tech', file), 'utf-8');
    expect(raw).toContain('title: "Redis key design"');
    expect(raw).toContain('use short keys with TTL');
  });

  it('routes project knowledge into projects/{projectId}', () => {
    const root = kbRoot();
    writeKnowledge({ title: '项目坑：exceljs 导出', content: '记得设置 stream', category: 'project', project_id: 'p1' }, root);
    expect(fs.existsSync(path.join(root, 'projects', 'p1'))).toBe(true);
    const entries = listKnowledge({ category: 'project', project_id: 'p1' }, root);
    expect(entries).toHaveLength(1);
    expect(entries[0].project_id).toBe('p1');
  });

  it('deduplicates by title within the same category+project (update in place)', () => {
    const root = kbRoot();
    const first = writeKnowledge({ title: 'Same Title', content: 'v1', category: 'general-tech' }, root);
    const second = writeKnowledge({ title: 'Same Title', content: 'v2', category: 'general-tech' }, root);
    expect(first.id).toBe(second.id);
    expect(second.updated).toBe(true);
    expect(listKnowledge({}, root)).toHaveLength(1);
    expect(getKnowledge(first.id, root)!.content).toBe('v2');
  });

  it('searches by keyword with title/tag/body scoring', () => {
    const root = kbRoot();
    writeKnowledge({ title: 'Redis retry best practice', content: 'exponential backoff for redis', tags: ['redis'] }, root);
    writeKnowledge({ title: 'Vue composable patterns', content: 'use provide/inject carefully', tags: ['vue'] }, root);
    const hits = searchKnowledge('redis', {}, root);
    expect(hits.length).toBeGreaterThanOrEqual(1);
    expect(hits[0].title).toContain('Redis');
    expect(searchKnowledge('vue', {}, root)[0].title).toContain('Vue');
    expect(searchKnowledge('完全不相关', {}, root)).toHaveLength(0);
  });

  it('supports manual update and delete via API helpers', () => {
    const root = kbRoot();
    const { id } = writeKnowledge({ title: 'to edit', content: 'original' }, root);
    const updated = updateKnowledge(id, { content: 'edited by human', tags: ['edited'] }, root);
    expect(updated!.updated_by).toBe('user');
    expect(updated!.content).toBe('edited by human');
    expect(deleteKnowledge(id, root)).toBe(true);
    expect(getKnowledge(id, root)).toBeNull();
    expect(deleteKnowledge(id, root)).toBe(false);
  });

  it('rejects empty title/content', () => {
    const root = kbRoot();
    expect(() => writeKnowledge({ title: '', content: 'x' }, root)).toThrow();
    expect(() => writeKnowledge({ title: 't', content: '  ' }, root)).toThrow();
  });
});

describe('转义翻倍循环回归（2026-09-15 193MB 怪兽复盘）', () => {
  it('write → 多次 recordKnowledgeHits → 标题稳定不翻倍、文件体积有界', () => {
    const root = kbRoot();
    const { id } = writeKnowledge(
      { title: '任务复盘 t1：UI 重构\前端分层', content: '教训正文', category: 'project', project_id: 'p1' },
      root
    );
    const file = path.join(root, 'projects', 'p1', `${id}.md`);
    const size0 = fs.statSync(file).size;
    for (let i = 0; i < 5; i++) {
      const n = recordKnowledgeHits([id], root);
      expect(n).toBe(1);
    }
    const entry = getKnowledge(id, root)!;
    expect(entry.title).toBe('任务复盘 t1：UI 重构\前端分层');
    const size1 = fs.statSync(file).size;
    // P1.2 起 hits/last_hit_at 落 frontmatter：首次命中使文件增长一次，之后体积恒定（不再指数翻倍）
    expect(size1).toBeGreaterThanOrEqual(size0);
    const size5 = fs.statSync(file).size;
    expect(size5).toBe(size1);
    expect(size5).toBeLessThan(100_000);
  });

  it('超尺寸知识文件被 readAll 体积门跳过（损坏条目不进管线）', () => {
    const root = kbRoot();
    writeKnowledge({ title: 'healthy entry', content: 'ok', category: 'general-tech' }, root);
    // 伪造一个 3MB 的损坏条目（超过 2MB 体积门）
    const dir = path.join(root, 'general-tech');
    fs.writeFileSync(path.join(dir, '99999999-monster-md.md'), '---\nid: monster\ntitle: "monster"\ncategory: general-tech\n---\n\n' + 'x'.repeat(3 * 1024 * 1024), 'utf-8');
    const listed = listKnowledge({}, root);
    expect(listed.map((e) => e.title)).toContain('healthy entry');
    expect(listed.map((e) => e.title)).not.toContain('monster');
  });

  it('writeKnowledge 净化：失控反斜杠坍缩、标题封顶 200 字', () => {
    const root = kbRoot();
    const runAway = '标题' + String.fromCharCode(92).repeat(5000);
    const { id } = writeKnowledge({ title: runAway, content: 'c', category: 'general-tech' }, root);
    const entry = getKnowledge(id, root)!;
    expect(entry.title.length).toBeLessThanOrEqual(200);
    expect(entry.title).not.toContain('\\\\');
  });
});
