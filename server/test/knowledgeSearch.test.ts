import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { writeKnowledge, searchKnowledge } from '../src/knowledge';

function kbRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ct-kbs-'));
}

describe('knowledge semantic search (R3: synonyms + CJK fuzzy)', () => {
  it('searching "javascript" hits a "js"-tagged entry', () => {
    const root = kbRoot();
    writeKnowledge({ title: 'js 事件循环踩坑', content: '宏任务与微任务的执行顺序', category: 'general-tech', tags: ['js', 'async'] }, root);
    const hits = searchKnowledge('javascript', {}, root);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].title).toContain('js');
  });

  it('searching "js" also hits "javascript" entries (symmetric expansion)', () => {
    const root = kbRoot();
    writeKnowledge({ title: 'JavaScript closure basics', content: 'closures capture variables', category: 'general-tech', tags: ['frontend'] }, root);
    const hits = searchKnowledge('js', {}, root);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].title).toContain('JavaScript');
  });

  it('searching "登陆" (typo) still hits "登录" entries via CJK fuzzy match', () => {
    const root = kbRoot();
    writeKnowledge({ title: '登录鉴权最佳实践', content: '使用 JWT 与刷新令牌', category: 'general-tech', tags: ['auth'] }, root);
    const hits = searchKnowledge('登陆', {}, root);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].title).toContain('登录');
  });

  it('exact matches still outrank fuzzy/synonym hits', () => {
    const root = kbRoot();
    writeKnowledge({ title: '登录鉴权最佳实践', content: 'JWT 刷新令牌', category: 'general-tech', tags: ['auth'] }, root);
    writeKnowledge({ title: '注册与登陆方式调研', content: '调研了三种登陆方式', category: 'general-tech', tags: ['auth'] }, root);
    const hits = searchKnowledge('登录', {}, root);
    expect(hits.length).toBeGreaterThan(0);
    // the exact-title entry must sort first
    expect(hits[0].title).toContain('登录鉴权最佳实践');
  });

  it('synonym search "retry" hits "重试" content', () => {
    const root = kbRoot();
    writeKnowledge({ title: '失败重试策略', content: '指数退避，最多重试三次', category: 'general-tech', tags: ['reliability'] }, root);
    const hits = searchKnowledge('retry', {}, root);
    expect(hits.length).toBeGreaterThan(0);
  });

  it('no-match still returns empty (synonyms do not create noise)', () => {
    const root = kbRoot();
    writeKnowledge({ title: '登录鉴权最佳实践', content: 'JWT 刷新令牌', category: 'general-tech', tags: ['auth'] }, root);
    expect(searchKnowledge('kubernetes ingress', {}, root)).toEqual([]);
  });
});
