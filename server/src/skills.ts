/**
 * Agent Skill system (SKILL.md convention):
 *
 *   skills/<skill-name>/SKILL.md                    — global library, every agent can match
 *   agents/<agent>/skills/<skill-name>/SKILL.md     — agent-private, only that agent
 *
 * A skill is frontmatter (name/description/tags) + an instruction body that gets
 * injected into the agent's harness context when the skill applies. Users inject
 * skills by dropping folders into the library, via the API, or by binding them in
 * agent.yaml (`skills: [name, ...]`).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as yaml from 'js-yaml';

export interface SkillMeta {
  name: string;
  description: string;
  tags: string[];
  /** 'global' or the agent name for agent-private skills */
  source: string;
  dir: string;
  body: string;
}

const MAX_BOUND_BODY = 6000;
const MAX_AUTO_BODY = 2000;
const MAX_AUTO_SKILLS = 2;

function parseSkillMd(dir: string, source: string, raw: string): SkillMeta | null {
  const trimmed = raw.trim();
  if (!trimmed.startsWith('---')) return null;
  const end = trimmed.indexOf('\n---', 3);
  if (end === -1) return null;
  let meta: Record<string, any> = {};
  try {
    meta = (yaml.load(trimmed.slice(3, end).trim()) as Record<string, any>) || {};
  } catch {
    return null;
  }
  const name = String(meta.name || path.basename(dir));
  const body = trimmed.slice(end + 4).trim();
  return {
    name,
    description: String(meta.description || ''),
    tags: Array.isArray(meta.tags) ? meta.tags.map(String) : [],
    source,
    dir,
    body,
  };
}

function scanDir(root: string, source: string, out: SkillMeta[]): void {
  if (!fs.existsSync(root)) return;
  for (const entry of fs.readdirSync(root, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory()) continue;
    const skillFile = path.join(root, entry.name, 'SKILL.md');
    if (!fs.existsSync(skillFile)) continue;
    try {
      const parsed = parseSkillMd(path.join(root, entry.name), source, fs.readFileSync(skillFile, 'utf-8'));
      if (parsed) out.push(parsed);
    } catch {
      /* a broken skill must never break discovery */
    }
  }
}

// ---------- cache ----------

let cache: SkillMeta[] = [];
let cacheKey = '';

/**
 * Rescan the global library + every agent's private skills dir.
 * Call on server start, on `loadAgents()`, and on the reload endpoint.
 */
export function reloadSkills(agentsDir: string, globalDir: string): SkillMeta[] {
  const key = `${agentsDir}|${globalDir}|${mtimeOf(globalDir)}|${mtimeOf(agentsDir)}`;
  cacheKey = key;
  const out: SkillMeta[] = [];
  scanDir(globalDir, 'global', out);
  if (fs.existsSync(agentsDir)) {
    for (const entry of fs.readdirSync(agentsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      scanDir(path.join(agentsDir, entry.name, 'skills'), entry.name, out);
    }
  }
  cache = out;
  return out;
}

function mtimeOf(dir: string): number {
  try {
    return fs.statSync(dir).mtimeMs;
  } catch {
    return 0;
  }
}

export function getSkills(): SkillMeta[] {
  return cache;
}

/** Write (create or update) a skill from structured fields. Returns its dir. */
export function writeSkill(globalDir: string, input: { name: string; description?: string; tags?: string[]; content?: string; originalName?: string }): string {
  const safe = input.name.trim().toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff_-]+/g, '-').replace(/^-+|-+$/g, '');
  if (!safe) throw new Error('skill name is required');
  const dir = path.join(globalDir, safe);
  // rename: move the folder when updating under a new name
  if (input.originalName && input.originalName !== safe) {
    const src = path.join(globalDir, input.originalName);
    if (fs.existsSync(src)) fs.rmSync(dir, { recursive: true, force: true });
  }
  fs.mkdirSync(dir, { recursive: true });
  const fm = [
    '---',
    `name: ${safe}`,
    `description: ${input.description || ''}`,
    input.tags?.length ? `tags: [${input.tags.join(', ')}]` : 'tags: []',
    '---',
  ].join('\n');
  fs.writeFileSync(path.join(dir, 'SKILL.md'), `${fm}\n\n${input.content || ''}\n`, 'utf-8');
  return dir;
}

export function deleteSkill(globalDir: string, name: string): boolean {
  const dir = path.join(globalDir, name);
  if (!fs.existsSync(dir)) return false;
  fs.rmSync(dir, { recursive: true, force: true });
  return true;
}

// ---------- matching ----------

export interface SkillPick {
  skill: SkillMeta;
  /** bound skills ride in full; auto-matched ones get truncated */
  body: string;
  reason: 'bound' | 'tags' | 'keyword';
}

function tokenize(text: string): string[] {
  // CJK bigrams + latin words — enough signal for name/description ↔ node-name overlap
  const tokens = new Set<string>();
  for (const w of text.match(/[a-zA-Z]{2,}/g) || []) tokens.add(w.toLowerCase());
  const cjk = text.replace(/[^\u4e00-\u9fff]/g, '');
  for (let i = 0; i < cjk.length - 1; i++) tokens.add(cjk.slice(i, i + 2));
  return [...tokens];
}

/**
 * Pick the skills to inject for one node:
 * - agent-bound skills (agent.yaml `skills`) always ride, full body
 * - then up to MAX_AUTO_SKILLS auto-matched by tags intersection or keyword overlap
 */
export function pickSkillsForNode(
  all: SkillMeta[],
  plugin: { name: string; tags: string[]; skills?: string[] },
  nodeName: string,
): SkillPick[] {
  const picks: SkillPick[] = [];
  const taken = new Set<string>();
  const bound = plugin.skills || [];

  for (const name of bound) {
    const s = all.find((x) => x.name === name && (x.source === 'global' || x.source === plugin.name));
    if (s && !taken.has(s.name)) {
      picks.push({ skill: s, body: s.body.slice(0, MAX_BOUND_BODY), reason: 'bound' });
      taken.add(s.name);
    }
  }

  const nodeTokens = new Set(tokenize(nodeName));
  let autoCount = 0;
  for (const s of all) {
    if (taken.has(s.name) || autoCount >= MAX_AUTO_SKILLS) break;
    if (s.source !== 'global' && s.source !== plugin.name) continue;
    const byTags = s.tags.length > 0 && s.tags.some((t) => plugin.tags.includes(t));
    // keyword channel needs >=2 distinct token overlaps: CJK bigrams make a single
    // hit far too weak (e.g. "结构" alone pulled a Vue scaffold skill into a docs task)
    const overlap = tokenize(`${s.name} ${s.description}`).filter((t) => nodeTokens.has(t)).length;
    const byKeyword = overlap >= 2;
    if (byTags || byKeyword) {
      picks.push({ skill: s, body: s.body.slice(0, MAX_AUTO_BODY), reason: byTags ? 'tags' : 'keyword' });
      taken.add(s.name);
      autoCount += 1;
    }
  }
  return picks;
}

/** Look a loaded skill up by name, honoring agent-private scope (load_skill tool). */
export function findSkillForAgent(name: string, agent: string): SkillMeta | null {
  return getSkills().find((s) => s.name === name && (s.source === 'global' || s.source === agent)) || null;
}

/**
 * Format the picked skills into the harness L3 block — INDEX ONLY (2026-09-09
 * 缓存优先裁剪): the full bodies used to ride in every system prompt (8 bound
 * skills × up to 6000 chars = the single largest fixed context tax seen on
 * i6efv5h2 node 6). The model now sees name+description and pulls the body via
 * the load_skill tool when the skill is actually relevant; bodies arrive as
 * appended tool results, which keeps the system prefix byte-stable for KV caching.
 */
export function formatSkillsBlock(picks: SkillPick[]): string {
  if (!picks.length) return '';
  const lines = picks.map((p) => {
    const obligation = p.reason === 'bound' ? '本 agent 绑定技能：动手前若与该任务相关必须先拉取正文并遵循' : '自动匹配技能：酌情拉取';
    return `- ${p.skill.name}${p.skill.description ? ` — ${p.skill.description}` : ''}（${obligation}）`;
  });
  return [
    '本节点可用技能（正文未注入，按需拉取）：',
    ...lines,
    '拉取方式：`{"tool_calls":[{"tool":"load_skill","name":"技能名"}]}`（可与侦查工具合并同一轮）；与本任务无关的技能无需拉取。',
  ].join('\n');
}
