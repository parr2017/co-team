import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// deterministic embedding mock: vector by content marker so cosine outcomes are stable
vi.mock('../src/llm', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/llm')>();
  return {
    ...actual,
    embed: async (_entry: unknown, input: string[]) =>
      input.map((text) => {
        if (/kubernetes|kubectl|rollout/i.test(text)) return [1, 0, 0];
        if (/redis|缓存/i.test(text)) return [0.9, 0.44, 0];
        return [0, 0.99, 0.1];
      }),
  };
});

import { initBus, closeBus } from '../src/bus';
import { setEmbeddingConfig, embeddingEnabled } from '../src/embeddings';
import { writeKnowledge, searchKnowledge, searchKnowledgeHybrid, listStaleKnowledge } from '../src/knowledge';
import { createApi } from '../src/api';

let tmp: string;

beforeEach(async () => {
  process.env.COTEAM_FORCE_MEMORY = '1';
  closeBus();
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-rag-'));
  await initBus({ host: '127.0.0.1', port: 6399, db: 0 });
  setEmbeddingConfig({ pool: null }); // tests opt in per-case
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
  closeBus();
});

function seed(root: string): { cacheId: string; kubeId: string; gitId: string } {
  const cache = writeKnowledge({ title: 'Redis 缓存穿透的解决方案', content: '布隆过滤器 + 空值缓存', tags: ['redis', 'cache'], source: 'test' }, root);
  const kube = writeKnowledge({ title: 'Kubernetes 滚动更新要点', content: 'kubectl rollout undo 可回滚', tags: ['k8s'], source: 'test' }, root);
  const git = writeKnowledge({ title: '变基与合并的选择', content: 'rebase 保持线性历史', tags: ['git'], source: 'test' }, root);
  return { cacheId: cache.id, kubeId: kube.id, gitId: git.id };
}

describe('knowledge RAG: hybrid search', () => {
  it('degrades to pure keyword search when embedding is not configured', async () => {
    const ids = seed(tmp);
    const base = searchKnowledge('缓存穿透', {}, tmp);
    const hybrid = await searchKnowledgeHybrid('缓存穿透', {}, tmp);
    expect(embeddingEnabled()).toBe(false);
    expect(hybrid.map((h) => h.id)).toEqual(base.map((h) => h.id));
    expect(hybrid[0].id).toBe(ids.cacheId);
  });

  it('boosts keyword hits and surfaces semantically close entries the keyword pass missed', async () => {
    const ids = seed(tmp);
    setEmbeddingConfig({
      pool: { getModel: () => ({ name: 'fake-embed', api_key: 'k', base_url: 'http://localhost:9' }) } as any,
      model: 'fake-embed',
    });
    const query = '缓存穿透应对手段';
    const base = searchKnowledge(query, {}, tmp);
    const baseCache = base.find((h) => h.id === ids.cacheId)!;
    expect(base.find((h) => h.id === ids.kubeId)).toBeUndefined(); // keyword-only: no hit

    const hybrid = await searchKnowledgeHybrid(query, {}, tmp);
    const hybridCache = hybrid.find((h) => h.id === ids.cacheId)!;
    const hybridKube = hybrid.find((h) => h.id === ids.kubeId)!;
    // the cache entry keeps its keyword score + semantic boost and ranks first
    expect(hybridCache.score).toBeGreaterThan(baseCache.score);
    expect(hybrid[0].id).toBe(ids.cacheId);
    // the kubernetes entry shares no keywords/bigrams with the query but is
    // semantically closest (mocked vector) — it enters the result set
    expect(hybridKube.score).toBeGreaterThanOrEqual(0.5);

    // vectors are cached as sidecars next to the markdown files
    const sidecars = [...fs.readdirSync(path.join(tmp, 'general-tech'))].filter((f) => f.endsWith('.vec.json'));
    expect(sidecars).toHaveLength(3);
  });

  it('falls back to keyword results when the embedding model is missing from the pool', async () => {
    seed(tmp);
    setEmbeddingConfig({ pool: { getModel: () => null } as any, model: 'gone' });
    const base = searchKnowledge('缓存穿透', {}, tmp);
    const hybrid = await searchKnowledgeHybrid('缓存穿透', {}, tmp);
    expect(hybrid).toHaveLength(base.length);
  });
});

describe('knowledge governance', () => {
  it('lists stale candidates (updated_at older than the cutoff)', () => {
    seed(tmp);
    expect(listStaleKnowledge(3650, {}, tmp)).toHaveLength(0);
    const all = listStaleKnowledge(0, {}, tmp);
    expect(all).toHaveLength(3);
    expect(all[0].age_days).toBeGreaterThanOrEqual(0);
  });
});

describe('knowledge API: GBK-tolerant intake', () => {
  const gbkDecoder: TextDecoder | null = (() => {
    try { return new TextDecoder('gbk'); } catch { return null; }
  })();

  beforeEach(() => {
    // the API writes to the default knowledge root — point it at the tmp dir
    process.env.COTEAM_KNOWLEDGE_DIR = tmp;
  });

  afterEach(() => {
    delete process.env.COTEAM_KNOWLEDGE_DIR;
  });

  (gbkDecoder ? it : it.skip)('recovers a GBK-encoded title instead of storing mojibake', async () => {
    const app = createApi({ config: {} as any, orchestrator: {} as any, modelPool: {} as any, taskQueue: {} as any });
    // 0xBB 0xBA 0xB4 0xE6 = a 4-byte GBK sequence (invalid as UTF-8 — strict decode throws)
    const gbkTitleBytes = new Uint8Array([0xbb, 0xba, 0xb4, 0xe6]);
    const prefix = new TextEncoder().encode('{"title":"');
    const suffix = new TextEncoder().encode('","content":"正文内容","category":"general-tech"}');
    const body = new Uint8Array([...prefix, ...gbkTitleBytes, ...suffix]);

    const res = await app.request('/api/knowledge', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    });
    expect(res.status).toBe(200);
    const created = (await res.json()) as { id: string };
    expect(created.status).toBe('created');

    const stored = fs.readFileSync(path.join(tmp, 'general-tech', `${created.id}.md`), 'utf-8');
    const expected = gbkDecoder!.decode(gbkTitleBytes);
    expect(stored).toContain(expected);
    expect(stored).not.toContain('\ufffd');
  });
});
