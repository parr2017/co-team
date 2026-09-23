/**
 * P1.5 Dream 整理线程（星瑶 /dream 改造移植）：
 * - 蒸馏转正：项目记忆里超过 7 天的 auto 散条（问题/解决/经验一行句）由 LLM 提炼为
 *   结构化知识条目（feedback/project，带 Why/How to apply），已吸收的散条从记忆中移除——
 *   项目记忆从"50 条 FIFO 悄悄丢最旧"变为"老条目蒸馏沉淀、新条目常驻"。
 * - 治理候选：low-confidence 且零命中的过期知识条目列成治理清单（落 KV 供查询），
 *   不自动删除——删除是人工裁决。
 *
 * 触发：每日定时（缺省 04:30，服务启动时挂载）或 POST /api/dream/run 手动触发。
 * 纯后台运行：失败只记日志，绝不影响主流程。
 */
import { busGet, busSet, busDel } from './bus';
import { listProjects, getProjectMemory, replaceProjectMemory, emitProgress } from './store';
import { writeKnowledge, listKnowledge, FEEDBACK_STRUCTURE_HINT } from './knowledge';
import { chatStructured } from './structured';
import type { ModelPool } from './scheduler';
import type { Logger } from './logger';

const DREAM_LAST_RUN_KEY = 'dream:last_run';
/** 散条超过该天数才有资格被蒸馏转正（太新的还在活跃引用期） */
const MEMORY_AGE_DAYS = 7;
/** 单项目单次蒸馏的散条上限（防超长 prompt） */
const MAX_ABSORB_PER_PROJECT = 30;

export interface DreamResult {
  ran_at: string;
  projects_scanned: number;
  absorbed: number;
  governance_candidates: number;
  skipped?: string;
}

/** 项目记忆散条 → 结构化知识条目（单项目一次 LLM 调用）。 */
async function distillProjectMemory(pool: ModelPool, projectName: string, items: { text: string }[], log?: Logger): Promise<{ title: string; content: string; category: 'feedback' | 'project' }[]> {
  const entry = pool.selectStrongModel(['code']) ?? pool.selectStrongModel();
  if (!entry) return [];
  try {
    const { parsed } = await chatStructured(entry, [
      { role: 'system', content: `你是知识整理员（Dream）。下面是项目「${projectName}」积累的零散经验记录。把它们提炼合并为 1-4 条结构化知识条目（去重、去粗取精、合并同类）。
- content 必须三段：规则本体（一句话祈使句）；**Why:** 为什么；**How to apply:** 什么场景怎么用。${FEEDBACK_STRUCTURE_HINT}
- category：用户纠正/规范/避坑 → feedback；项目特有事实/方案 → project
- 零散记录里没有可提炼的就返回 entries 空数组。禁止编造。` },
      { role: 'user', content: items.map((it, i) => `${i + 1}. ${it.text}`).join('\n').slice(0, 10000) },
    ], {
      toolName: 'distill_memory',
      description: '把项目零散经验提炼为结构化知识条目。输出：entries（知识条目数组：category/title/content）。',
      schema: {
        type: 'object',
        properties: {
          entries: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                category: { type: 'string', enum: ['feedback', 'project', 'general-tech'] },
                title: { type: 'string' },
                content: { type: 'string' },
              },
              required: ['category', 'title', 'content'],
              additionalProperties: false,
            },
          },
        },
        required: ['entries'],
        additionalProperties: false,
      },
    });
    if (!parsed || !Array.isArray(parsed.entries)) return [];
    const out: { title: string; content: string; category: 'feedback' | 'project' }[] = [];
    for (const raw of parsed.entries.slice(0, 4)) {
      const e = (raw || {}) as Record<string, unknown>;
      const title = String(e.title || '').trim();
      const content = String(e.content || '').trim();
      if (!title || !content) continue;
      out.push({ title: title.slice(0, 60), content: content.slice(0, 800), category: e.category === 'general-tech' || e.category === 'feedback' ? (e.category as 'feedback') : 'project' });
    }
    return out;
  } catch (e) {
    log?.warn?.('dream distillProjectMemory failed (non-fatal)', { error: String((e as Error)?.message || e) });
    return [];
  }
}

/** 执行一次整理。幂等：同一天已跑过则跳过（force=true 强制）。 */
export async function runDreamConsolidation(pool: ModelPool, log?: Logger, opts?: { force?: boolean; staleDays?: number }): Promise<DreamResult> {
  const today = new Date().toISOString().slice(0, 10);
  if (!opts?.force && (await busGet<string>(DREAM_LAST_RUN_KEY)) === today) {
    return { ran_at: new Date().toISOString(), projects_scanned: 0, absorbed: 0, governance_candidates: 0, skipped: 'already ran today' };
  }
  const cutoff = Date.now() - MEMORY_AGE_DAYS * 24 * 3600 * 1000;
  const projects = await listProjects();
  let absorbed = 0;
  for (const p of projects) {
    try {
      const items = await getProjectMemory(p.id, 200);
      const old = items.filter((m) => m.kind === 'auto' && new Date(m.ts).getTime() < cutoff);
      if (old.length < 3) continue; // 太少不值得一次 LLM 调用
      const slice = old.slice(-MAX_ABSORB_PER_PROJECT);
      const entries = await distillProjectMemory(pool, p.name, slice, log);
      if (!entries.length) continue;
      for (const e of entries) {
        writeKnowledge({
          title: e.title,
          content: e.content,
          category: e.category,
          project_id: p.id,
          tags: ['Dream 整理'],
          source: `dream:${p.id}`,
          confidence: 'low',
        });
      }
      // 已吸收的散条从记忆中移除（蒸馏淘汰——原文留在知识条目里）
      const absorbedTexts = new Set(slice.map((m) => m.text));
      await replaceProjectMemory(p.id, items.filter((m) => !absorbedTexts.has(m.text)));
      absorbed += slice.length;
      log?.info?.('dream absorbed project memory into knowledge', { projectId: p.id, absorbed: slice.length, entries: entries.length });
    } catch (e) {
      log?.warn?.('dream project scan failed (non-fatal)', { projectId: p.id, error: String((e as Error)?.message || e) });
    }
  }

  // 治理候选：low-confidence 且零命中的过期条目（只列清单，不自动删除）
  const staleDays = opts?.staleDays ?? 30;
  const cutoffStale = Date.now() - staleDays * 24 * 3600 * 1000;
  const candidates = listKnowledge({})
    .filter((k) => k.confidence === 'low' && !k.hits && new Date(k.updated_at).getTime() < cutoffStale)
    .map((k) => ({ id: k.id, title: k.title, category: k.category, source: k.source, updated_at: k.updated_at }));
  if (candidates.length) {
    await busSet(`dream:governance:${today}`, { at: new Date().toISOString(), candidates }, 7 * 24 * 3600);
  }
  await busSet(DREAM_LAST_RUN_KEY, today, 48 * 3600);
  const result: DreamResult = { ran_at: new Date().toISOString(), projects_scanned: projects.length, absorbed, governance_candidates: candidates.length };
  emitProgress('dream_complete', { ...result }).catch(() => undefined);
  return result;
}

/** 每日定时扫描器：每小时整点检查，到达配置小时且当天未跑则执行。返回 stop 函数。 */
export function startDreamScanner(pool: ModelPool, log?: Logger, hour = 4): () => void {
  const timer = setInterval(() => {
    const now = new Date();
    if (now.getHours() !== hour) return;
    void runDreamConsolidation(pool, log).catch((e) => log?.warn?.('dream scanner run failed', { error: String((e as Error)?.message || e) }));
  }, 60 * 60 * 1000);
  return () => clearInterval(timer);
}

export async function clearDreamState(): Promise<void> {
  await busDel(DREAM_LAST_RUN_KEY);
}
