import * as fs from 'node:fs';
import * as path from 'node:path';
import { PROJECT_ROOT } from './config';

export type KnowledgeCategory = 'general-tech' | 'project';

export interface KnowledgeEntry {
  id: string;
  title: string;
  category: KnowledgeCategory;
  project_id?: string;
  tags: string[];
  source: string;
  created_at: string;
  updated_at: string;
  updated_by?: string;
  content: string;
}

export interface KnowledgeWriteInput {
  title: string;
  content: string;
  category?: KnowledgeCategory;
  project_id?: string;
  tags?: string[];
  source?: string;
}

export interface KnowledgeQuery {
  category?: KnowledgeCategory;
  project_id?: string;
  limit?: number;
}

function defaultRoot(): string {
  return process.env.COTEAM_KNOWLEDGE_DIR || path.join(PROJECT_ROOT, 'data', 'knowledge');
}

function rootDir(root?: string): string {
  return path.resolve(root || defaultRoot());
}

function categoryDir(category: KnowledgeCategory, projectId: string | undefined, root?: string): string {
  const base = rootDir(root);
  return category === 'project' && projectId
    ? path.join(base, 'projects', projectId)
    : path.join(base, 'general-tech');
}

function slugify(title: string): string {
  const ascii = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return ascii || 'entry';
}

function shortHash(text: string): string {
  let h = 5381;
  for (let i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) >>> 0;
  return h.toString(36).slice(0, 6);
}

// ---------- frontmatter serialization ----------

export function entryToMarkdown(entry: KnowledgeEntry): string {
  const fm = [
    '---',
    `id: ${entry.id}`,
    `title: ${JSON.stringify(entry.title)}`,
    `category: ${entry.category}`,
    ...(entry.project_id ? [`project_id: ${entry.project_id}`] : []),
    `tags: [${entry.tags.map((t) => JSON.stringify(t)).join(', ')}]`,
    `source: ${JSON.stringify(entry.source)}`,
    `created_at: ${entry.created_at}`,
    `updated_at: ${entry.updated_at}`,
    ...(entry.updated_by ? [`updated_by: ${entry.updated_by}`] : []),
    '---',
  ].join('\n');
  return `${fm}\n\n${entry.content}\n`;
}

export function markdownToEntry(fileName: string, raw: string): KnowledgeEntry | null {
  const match = raw.match(/^---\n([\s\S]*?)\n---\n?/);
  if (!match) return null;
  try {
    const fm = parseFrontmatter(match[1]);
    if (!fm.id || !fm.title) return null;
    return {
      id: String(fm.id),
      title: String(fm.title),
      category: (fm.category === 'project' ? 'project' : 'general-tech') as KnowledgeCategory,
      project_id: fm.project_id ? String(fm.project_id) : undefined,
      tags: Array.isArray(fm.tags) ? fm.tags.map(String) : [],
      source: String(fm.source ?? 'unknown'),
      created_at: String(fm.created_at ?? new Date().toISOString()),
      updated_at: String(fm.updated_at ?? fm.created_at ?? new Date().toISOString()),
      updated_by: fm.updated_by ? String(fm.updated_by) : undefined,
      content: raw.slice(match[0].length).trim(),
    };
  } catch {
    return null;
  }
}

/** Minimal YAML frontmatter parser (flat keys, JSON-ish scalars & arrays). */
function parseFrontmatter(block: string): Record<string, any> {
  const out: Record<string, any> = {};
  for (const line of block.split('\n')) {
    const idx = line.indexOf(':');
    if (idx <= 0) continue;
    const key = line.slice(0, idx).trim();
    let value = line.slice(idx + 1).trim();
    if (value.startsWith('[') && value.endsWith(']')) {
      const inner = value.slice(1, -1).trim();
      out[key] = inner ? inner.match(/(?:[^,\[\]"']+|"[^"]*"|'[^']*')+/g)!.map((s) => s.trim().replace(/^["']|["']$/g, '')) : [];
    } else if (value.startsWith('"') && value.endsWith('"')) {
      out[key] = value.slice(1, -1);
    } else if (value.startsWith("'") && value.endsWith("'")) {
      out[key] = value.slice(1, -1);
    } else {
      out[key] = value;
    }
  }
  return out;
}

// ---------- core operations (file-based, synchronous) ----------

function readAll(root?: string): KnowledgeEntry[] {
  const base = rootDir(root);
  const entries: KnowledgeEntry[] = [];
  const scan = (dir: string) => {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        scan(full);
        continue;
      }
      if (!entry.name.endsWith('.md')) continue;
      try {
        const parsed = markdownToEntry(entry.name, fs.readFileSync(full, 'utf-8'));
        if (parsed) entries.push(parsed);
      } catch {
        /* skip unreadable entries */
      }
    }
  };
  scan(base);
  return entries;
}

function matchQuery(entry: KnowledgeEntry, query: KnowledgeQuery): boolean {
  if (query.category && entry.category !== query.category) return false;
  if (query.category === 'project' && query.project_id && entry.project_id !== query.project_id) return false;
  return true;
}

/** Write a knowledge entry; deduplicates by title within the same category+project (updates in place). */
export function writeKnowledge(input: KnowledgeWriteInput, root?: string): { id: string; updated: boolean } {
  const title = (input.title || '').trim();
  if (!title) throw new Error('knowledge title is required');
  if (!input.content || !input.content.trim()) throw new Error('knowledge content is required');
  const category: KnowledgeCategory = input.category === 'project' ? 'project' : 'general-tech';
  const dir = categoryDir(category, input.project_id, root);
  fs.mkdirSync(dir, { recursive: true });

  const now = new Date().toISOString();
  const existing = readAll(root).find(
    (e) => e.title === title && e.category === category && (e.project_id ?? undefined) === (input.project_id ?? undefined)
  );
  if (existing) {
    const updated: KnowledgeEntry = { ...existing, content: input.content.trim(), tags: input.tags ?? existing.tags, updated_at: now };
    fs.writeFileSync(path.join(categoryDir(existing.category, existing.project_id, root), `${existing.id}.md`), entryToMarkdown(updated), 'utf-8');
    return { id: existing.id, updated: true };
  }

  const date = now.slice(0, 10).replace(/-/g, '');
  const id = `${date}-${slugify(title)}-${shortHash(title + now)}`;
  const entry: KnowledgeEntry = {
    id,
    title,
    category,
    project_id: category === 'project' ? input.project_id : undefined,
    tags: input.tags ?? [],
    source: input.source || 'system',
    created_at: now,
    updated_at: now,
    content: input.content.trim(),
  };
  fs.writeFileSync(path.join(dir, `${id}.md`), entryToMarkdown(entry), 'utf-8');
  return { id, updated: false };
}

export function listKnowledge(query: KnowledgeQuery = {}, root?: string): KnowledgeEntry[] {
  const entries = readAll(root)
    .filter((e) => matchQuery(e, query))
    .sort((a, b) => b.updated_at.localeCompare(a.updated_at));
  return query.limit ? entries.slice(0, query.limit) : entries;
}

export function getKnowledge(id: string, root?: string): KnowledgeEntry | null {
  return readAll(root).find((e) => e.id === id) ?? null;
}

export interface SearchHit extends KnowledgeEntry {
  score: number;
}

/** Keyword search: title match ×3, tag match ×2, body match ×1. */
export function searchKnowledge(keyword: string, query: KnowledgeQuery = {}, root?: string): SearchHit[] {
  const terms = (keyword || '')
    .toLowerCase()
    .split(/[\s,，。;；、]+/)
    .map((t) => t.trim())
    .filter((t) => t.length >= 2)
    .slice(0, 8);
  if (terms.length === 0) return [];
  const hits: SearchHit[] = [];
  for (const entry of readAll(root)) {
    if (!matchQuery(entry, query)) continue;
    const title = entry.title.toLowerCase();
    const tags = entry.tags.map((t) => t.toLowerCase()).join(' ');
    const body = entry.content.toLowerCase();
    let score = 0;
    for (const term of terms) {
      if (title.includes(term)) score += 3;
      if (tags.includes(term)) score += 2;
      if (body.includes(term)) score += 1;
    }
    if (score > 0) hits.push({ ...entry, score });
  }
  return hits.sort((a, b) => b.score - a.score || b.updated_at.localeCompare(a.updated_at)).slice(0, query.limit ?? 10);
}

/** Manual edit via UI/API: marks updated_by so agent-written vs human-edited entries are distinguishable. */
export function updateKnowledge(id: string, patch: { title?: string; content?: string; tags?: string[] }, root?: string): KnowledgeEntry | null {
  const existing = getKnowledge(id, root);
  if (!existing) return null;
  const dir = categoryDir(existing.category, existing.project_id, root);
  const updated: KnowledgeEntry = {
    ...existing,
    title: patch.title?.trim() || existing.title,
    content: patch.content !== undefined ? patch.content.trim() : existing.content,
    tags: patch.tags ?? existing.tags,
    updated_at: new Date().toISOString(),
    updated_by: 'user',
  };
  // title change may move the file into a different slug — keep the same id (filename)
  fs.writeFileSync(path.join(dir, `${existing.id}.md`), entryToMarkdown(updated), 'utf-8');
  return updated;
}

export function deleteKnowledge(id: string, root?: string): boolean {
  const existing = getKnowledge(id, root);
  if (!existing) return false;
  const file = path.join(categoryDir(existing.category, existing.project_id, root), `${existing.id}.md`);
  if (!fs.existsSync(file)) return false;
  fs.rmSync(file);
  return true;
}

/** Retrieve knowledge relevant to a free-text query, for prompt injection. */
export function relevantKnowledge(query: string, opts: { project_id?: string; limit?: number } = {}, root?: string): KnowledgeEntry[] {
  const hits = searchKnowledge(query, { project_id: opts.project_id, limit: opts.limit ?? 3 }, root);
  // general knowledge is always eligible; project knowledge only when the project matches
  return hits.filter((h) => h.category === 'general-tech' || (h.project_id && h.project_id === opts.project_id));
}
