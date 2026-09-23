/**
 * P1.4 经验候选提炼（半自动沉淀引擎）：LLM 判断对话/讨论材料中是否出现了
 * 值得沉淀的「决策/结论/用户偏好/踩坑」——值得则产出候选（title/content/category），
 * 由前端确认卡让用户拍板入库；忽略则不留存（防低质内容污染知识库）。
 *
 * 与 P1.3 任务复盘的分工：任务复盘面向任务执行材料（全自动入库、low-confidence 标）；
 * 本模块面向协作会话与群组讨论（半自动候选卡、用户确认才入库）。
 */
import { chatStructured } from './structured';
import type { ModelPool } from './scheduler';
import type { Logger } from './logger';

export interface KnowledgeCandidate {
  title: string;
  content: string;
  category: 'feedback' | 'project' | 'general-tech';
}

/** 提炼候选；返回空数组 = 材料里没有值得沉淀的内容（或 LLM 失败——候选提炼永不阻塞主流程）。 */
export async function distillKnowledgeCandidates(
  pool: ModelPool,
  materials: string,
  scopeHint: string,
  log?: Logger,
): Promise<KnowledgeCandidate[]> {
  const entry = pool.selectModel(undefined, 'simple') ?? pool.selectStrongModel();
  if (!entry) return [];
  try {
    const { parsed } = await chatStructured(entry, [
      { role: 'system', content: `你是经验提炼员。判断下面的${scopeHint}材料中是否出现了值得沉淀的「决策/结论/用户偏好/踩坑」——判据：下次还会用到、不是一次性流水账。值得就提炼 1-2 条，不值得就返回空数组。
category 选择：用户纠正/规范类 → feedback；本项目特有事实/方案 → project；通用技术经验 → general-tech。
每条 content：规则本体一句话 + Why（为什么/依据）+ How to apply（什么场景怎么用），合计 ≤300 字。
材料中没有值得沉淀的就返回空数组。禁止编造材料中没有的内容；不确定宁可返回空数组。` },
      { role: 'user', content: materials.slice(0, 12000) },
    ], {
      toolName: 'distill_candidates',
      description: '从材料中提炼值得沉淀的经验候选。输出：candidates（候选数组：category/title/content）。',
      schema: {
        type: 'object',
        properties: {
          candidates: {
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
        required: ['candidates'],
        additionalProperties: false,
      },
    });
    if (!parsed || !Array.isArray(parsed.candidates)) return [];
    const out: KnowledgeCandidate[] = [];
    for (const raw of parsed.candidates.slice(0, 2)) {
      const c = (raw || {}) as Record<string, unknown>;
      const title = String(c.title || '').trim();
      const content = String(c.content || '').trim();
      if (!title || !content) continue;
      const cat = String(c.category || '');
      out.push({
        title: title.slice(0, 60),
        content: content.slice(0, 600),
        category: (cat === 'feedback' || cat === 'general-tech' ? cat : 'project') as KnowledgeCandidate['category'],
      });
    }
    return out;
  } catch (e) {
    log?.warn?.('distillKnowledgeCandidates failed (non-fatal)', { error: String((e as Error)?.message || e) });
    return [];
  }
}
