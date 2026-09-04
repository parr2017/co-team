import { chat, extractJson, stripCodeFence } from './llm';
import type { ModelPool } from './scheduler';

export interface ClarificationAssessment {
  clear: boolean;
  missing: string[];
  questions: string[];
  summary?: string;
}

export const MAX_CLARIFY_ROUNDS = 3;

export interface ClarifyAnswer {
  question: string;
  answer: string;
}

const DIMENSIONS = ['目标（要做成什么）', '约束（技术/范围/时间限制）', '验收条件（怎样算完成）'];

const SYSTEM = `你是需求澄清评估器。评估开发需求是否足够清晰，只输出 JSON，不要其他内容。
判断维度：${DIMENSIONS.join('、')}。
若需求已足够清晰（可以开始规划开发），clear 为 true，questions 为空数组。
若不清晰，提出最多 3 个具体、有建设性的针对性问题（不要泛泛而问），summary 用一两句话复述你理解的需求。
JSON 格式：{"clear": true|false, "missing": ["目标","约束","验收条件"], "questions": ["问题1","问题2"], "summary": "需求复述"}`;

/** LLM-backed requirement assessment; falls back to heuristics when no model pool is available. */
export async function assessRequirement(request: string, pool: ModelPool | null, priorAnswers: ClarifyAnswer[] = []): Promise<ClarificationAssessment> {
  if (!pool) return heuristicAssessment(request);
  const model = pool.selectModel(['code'], 'simple');
  if (!model) return heuristicAssessment(request);
  const prior = priorAnswers.length
    ? `\n\n此前已进行的澄清问答：\n${priorAnswers.map((a, i) => `${i + 1}. 问：${a.question}\n   答：${a.answer}`).join('\n')}`
    : '';
  try {
    const resp = await chat(
      model,
      [
        { role: 'system', content: SYSTEM },
        { role: 'user', content: `需求原文：\n${request.slice(0, 4000)}${prior}` },
      ],
      2048,
      0
    );
    pool.recordUsage(model.name, resp.promptTokens, resp.completionTokens);
    const parsed = extractJson(stripCodeFence(resp.content));
    if (!parsed || typeof parsed.clear !== 'boolean') return heuristicAssessment(request);
    return {
      clear: parsed.clear === true,
      missing: Array.isArray(parsed.missing) ? parsed.missing.map(String).slice(0, 3) : [],
      questions: Array.isArray(parsed.questions) ? parsed.questions.map(String).filter(Boolean).slice(0, 3) : [],
      summary: typeof parsed.summary === 'string' ? parsed.summary : undefined,
    };
  } catch {
    return heuristicAssessment(request);
  }
}

/** Offline / fallback assessment: only flag vague requirements to avoid over-communication. */
export function heuristicAssessment(request: string): ClarificationAssessment {
  const text = (request || '').trim();
  // explicit action verbs make even short requirements actionable enough to plan
  const hasAction = /(实现|开发|创建|修复|新增|修改|删除|写|搭建|生成|部署|重构|更新|优化|分析|调研|配置)/.test(text);
  if (text.length >= 15 || hasAction) return { clear: true, missing: [], questions: [] };
  return {
    clear: false,
    missing: ['目标'],
    questions: ['请补充说明这个需求：要实现什么？有没有范围或验收上的要求？'],
    summary: text.slice(0, 100),
  };
}

/** Detect an explicit human confirmation reply (used as the pre-execution checkpoint). */
export function isConfirmation(text: string): boolean {
  const t = (text || '').trim().toLowerCase();
  if (!t) return false;
  if (t.length > 30) return false;
  return /^(确认|确定|同意|没错|可以|开始|执行|ok|yes|confirm|confirmed|go|通过)[!！。.~\s]*$/.test(t);
}
