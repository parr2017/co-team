import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  deleteKnowledge,
  getKnowledge,
  listKnowledge,
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
