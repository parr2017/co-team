/**
 * Embedding support for the knowledge base (RAG upgrade): OpenAI-compatible
 * /v1/embeddings via the existing model pool, vectors cached in sidecar JSON
 * files next to the markdown entries ({id}.vec.json), cosine similarity.
 *
 * Zero new dependencies; when no embedding model is configured (or the call
 * fails) every consumer degrades to the keyword search untouched.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import type { ModelPool, ModelEntry } from './scheduler';
import { embed } from './llm';
import type { KnowledgeEntry } from './knowledge';
import { getLogger } from './logger';

export interface EmbeddingConfig {
  pool: ModelPool | null;
  model?: string;
}

let cfg: EmbeddingConfig = { pool: null };

/** Called once at startup when knowledge.embedding is configured. */
export function setEmbeddingConfig(c: EmbeddingConfig): void {
  cfg = c;
}

export function embeddingEnabled(): boolean {
  return !!(cfg.pool && cfg.model && cfg.pool.getModel(cfg.model));
}

export function embeddingModelName(): string {
  return cfg.model || '';
}

function entryModel(): ModelEntry | null {
  return cfg.pool && cfg.model ? cfg.pool.getModel(cfg.model) : null;
}

export function contentHash(entry: KnowledgeEntry): string {
  return createHash('sha1').update(`${entry.title}\n${entry.content}`).digest('hex').slice(0, 16);
}

export function cosine(a: number[], b: number[]): number {
  if (!a?.length || a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom ? dot / denom : 0;
}

interface Sidecar {
  hash: string;
  model: string;
  vector: number[];
}

export function sidecarPath(dir: string, id: string): string {
  return path.join(dir, `${id}.vec.json`);
}

function readSidecar(file: string, entry: KnowledgeEntry): Sidecar | null {
  try {
    if (!fs.existsSync(file)) return null;
    const sc = JSON.parse(fs.readFileSync(file, 'utf-8')) as Sidecar;
    if (sc.hash !== contentHash(entry) || sc.model !== cfg.model || !Array.isArray(sc.vector)) return null;
    return sc;
  } catch {
    return null;
  }
}

/** Embed the texts that have no valid sidecar yet; returns id → vector for all entries with vectors. */
export async function ensureEntryVectors(entries: KnowledgeEntry[], dirOf: (entry: KnowledgeEntry) => string): Promise<Map<string, number[]>> {
  const out = new Map<string, number[]>();
  const pending: { entry: KnowledgeEntry; file: string }[] = [];
  for (const entry of entries) {
    const file = sidecarPath(dirOf(entry), entry.id);
    const cached = readSidecar(file, entry);
    if (cached) {
      out.set(entry.id, cached.vector);
    } else {
      pending.push({ entry, file });
    }
  }
  const model = entryModel();
  if (!model || pending.length === 0) return out;

  const logger = getLogger();
  const CHUNK = 16;
  try {
    for (let i = 0; i < pending.length; i += CHUNK) {
      const batch = pending.slice(i, i + CHUNK);
      const texts = batch.map((p) => `${p.entry.title}\n${p.entry.content.slice(0, 2000)}`);
      const vectors = await embed(model, texts);
      batch.forEach((p, j) => {
        const vector = vectors[j];
        if (!Array.isArray(vector)) return;
        fs.writeFileSync(p.file, JSON.stringify({ hash: contentHash(p.entry), model: cfg.model || '', vector } satisfies Sidecar), 'utf-8');
        out.set(p.entry.id, vector);
      });
    }
  } catch (e) {
    // embedding is an enhancement — a failed call degrades to keyword search
    logger.warn('Knowledge embedding pass failed (keyword search stays active)', { error: String(e).slice(0, 200) });
  }
  return out;
}

/** Embed a search query; null → caller should fall back to keyword-only. */
export async function embedQuery(text: string): Promise<number[] | null> {
  const model = entryModel();
  if (!model || !text.trim()) return null;
  try {
    const vectors = await embed(model, [text.slice(0, 2000)]);
    return vectors[0] ?? null;
  } catch (e) {
    getLogger().warn('Query embedding failed (keyword search fallback)', { error: String(e).slice(0, 200) });
    return null;
  }
}
