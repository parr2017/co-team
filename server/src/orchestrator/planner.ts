import { chat, extractJson, stripCodeFence } from '../llm';
import { getMemory } from '../store';
import type { ModelPool } from '../scheduler';
import type { Router } from '../router';
import type { Complexity, TaskLevel } from '../types';
import { relevantKnowledge } from '../knowledge';
import { LEVEL_PROFILES } from '../grader';

export interface PlannedGraph {
  nodes: Record<string, any>[];
  edges: [string, string][];
  summary: string;
}

function fallbackGraph(request: string, plugins: Map<string, any>): PlannedGraph {
  const pick = (name: string) => (plugins.has(name) ? name : 'dev');
  const nodes = [
    { id: 'main', name: 'Main Task', agent: 'orchestrator', complexity: 'simple' as Complexity, requires_approval: false, reason: '任务基线' },
    { id: 'dev', name: `Development: ${request.slice(0, 40)}`, agent: 'dev', complexity: 'normal' as Complexity, requires_approval: false, reason: '通用开发实现' },
    { id: 'test', name: 'Testing', agent: pick('test'), complexity: 'normal' as Complexity, requires_approval: false, reason: '验证功能可用' },
    { id: 'merge', name: '主 Agent 合并分支', agent: 'orchestrator', complexity: 'simple' as Complexity, requires_approval: false, reason: '全部节点分支合并回基线' },
  ];
  return {
    nodes,
    edges: [['main', 'dev'], ['dev', 'test'], ['test', 'merge']],
    summary: '（离线回退计划）',
  };
}

const GRANULARITY_RULES = [
  '拆解粒度要求：',
  '1. 每个节点只做一件事，有明确可验收的产出（一个接口/一个模块/一份配置/一组测试）',
  '2. 禁止笼统的大节点（如“开发”“实现功能”）；必须拆到具体功能点、接口或文件级别',
  '3. 中等复杂度的需求至少 4-6 个节点；每个开发节点之后应紧跟对应的测试或验证节点',
  '4. 节点命名格式「动作 + 对象」，例如：实现用户注册接口 /api/register',
  '5. 每个节点给出 agent 分配理由 reason（一句话，中文），说明为什么这个 agent 适合',
].join('\n');

const SKILL_RULES = [
  '技能标注要求：',
  '1. 每个节点必须输出 required_skills 字段：该节点所需的技能标签数组（从各 agent 的 tags 中取词，如 ["code"]、["test"]）',
  '2. 所选 agent 的 tags 必须覆盖 required_skills；系统会校验并自动改选不匹配的节点',
].join('\n');

function buildPlanMessages(request: string, available: string[], agentDesc: string, memory: string, previousPlan: PlannedGraph | null, feedbacks: string[], level?: TaskLevel, knowledge?: string[], goalContributionRule = true) {
  const levelRule = level ? LEVEL_PROFILES[level].planRule : '';
  const maxNodesRule = level ? `本次计划节点数不超过 ${LEVEL_PROFILES[level].maxNodes} 个。` : '';
  const content = [
    '你是任务规划器。你只能使用这些 agent 名字：' + available.join(', ') + '。不要发明新的 agent 名字。',
    '',
    '可用 agent 及职责：',
    agentDesc,
    '',
    '历史经验（跨任务记忆，避免重复犯错）：',
    memory,
    ...(knowledge && knowledge.length
      ? ['', '相关知识库条目（通用经验/项目经验，规划时参考）：', ...knowledge.map((k) => `- ${k}`)]
      : []),
    '',
    GRANULARITY_RULES,
    ...(levelRule ? ['', levelRule, maxNodesRule] : []),
    '',
    SKILL_RULES,
    '',
    '把需求拆解为有序任务节点。注意：',
    '1. 节点按依赖排序，edges 描述依赖关系（[前, 后]）；无依赖的节点可以并行',
    '2. 涉及部署/删除等危险操作的节点标记 requires_approval: true',
    '3. 为每个节点标注 complexity: simple|normal|complex',
    ...(goalContributionRule
      ? ['4. 每个节点给出 goal_link 字段：一句话说明该节点对全局目标的贡献（所有节点共同服务同一目标）']
      : []),
    '5. 每个开发节点应产出代码并由后续节点验证；系统会在计划末尾自动追加主 Agent 合并分支的节点，你不需要规划合并',
    '6. 计划末尾给出 summary（一句话概括拆解思路）',
    '返回 JSON：{"nodes":[{"id":"1","name":"...","agent":"dev","reason":"...","required_skills":["code"],"complexity":"normal","requires_approval":false,"goal_link":"对全局目标的贡献"}],"edges":[["1","2"]],"summary":"..."}',
  ];
  if (previousPlan) {
    content.push('', '当前已生成的计划（将被替换）：', JSON.stringify({ nodes: previousPlan.nodes, edges: previousPlan.edges }, null, 1).slice(0, 4000));
  }
  if (feedbacks.length) {
    content.push('', '用户的调整反馈（按先后顺序，必须逐条响应）：', ...feedbacks.map((f, i) => `${i + 1}. ${f}`));
  }
  content.push('', '需求：' + request);
  return content.join('\n');
}

export interface AgentSkillInfo {
  name: string;
  tags: string[];
}

/**
 * Validate the planned agent against the node's required_skills (improvement 9 / R2):
 * - keep the chosen agent if its tags cover every required skill
 * - otherwise pick the available agent with the largest tag intersection
 * - if NO agent intersects at all, keep the original choice + warn (plan still runs)
 */
function enforceSkills(
  nodeId: string,
  nodeName: string,
  chosen: string,
  requiredSkills: string[],
  availableAgents: Map<string, AgentSkillInfo>,
  warn: (msg: string, meta?: Record<string, unknown>) => void
): string {
  if (!requiredSkills.length || chosen === 'orchestrator') return chosen;
  const info = availableAgents.get(chosen);
  const covered = (info?.tags || []).length > 0 && requiredSkills.every((s) => info!.tags.includes(s));
  if (covered) return chosen;

  // pick the available agent with the largest tag intersection over required_skills
  let best: string | null = null;
  let bestOverlap = 0;
  for (const [name, ai] of availableAgents) {
    const overlap = ai.tags.filter((t) => requiredSkills.includes(t)).length;
    if (overlap > bestOverlap) {
      best = name;
      bestOverlap = overlap;
    }
  }
  if (best) {
    warn(`node ${nodeId}(${nodeName}) required_skills [${requiredSkills.join(',')}] not fully covered by agent ${chosen}; reassigned to ${best}`, {
      nodeId, from: chosen, to: best, requiredSkills,
    });
    return best;
  }
  warn(`node ${nodeId}(${nodeName}) required_skills [${requiredSkills.join(',')}] has no agent with matching tags; kept ${chosen}`, {
    nodeId, agent: chosen, requiredSkills,
  });
  return chosen;
}

export function normalizePlan(graph: any, available: string[], availableAgents?: Map<string, AgentSkillInfo>): PlannedGraph | null {
  if (!graph || !Array.isArray(graph.nodes) || graph.nodes.length === 0) return null;
  const loggerWarn = (msg: string, meta?: Record<string, unknown>) => {
    // imported lazily to avoid a cycle at module load
    import('../logger').then(({ getLogger }) => getLogger().warn(msg, meta)).catch(() => {});
  };
  const skillMap =
    availableAgents ??
    new Map<string, AgentSkillInfo>(available.map((name) => [name, { name, tags: [] }]));
  const nodeIds = new Set<string>();
  const nodes = graph.nodes.map((n: any, i: number) => {
    const id = String(n.id ?? i + 1);
    nodeIds.add(id);
    const requiredSkills: string[] = Array.isArray(n.required_skills) ? n.required_skills.map(String) : [];
    let agent = available.includes(n.agent) ? n.agent : 'dev';
    // hard skill check (R2): reassign when the chosen agent's tags don't cover the skills
    agent = enforceSkills(id, String(n.name ?? `Task ${i + 1}`), agent, requiredSkills, skillMap, loggerWarn);
    return {
      id,
      name: String(n.name ?? `Task ${i + 1}`),
      agent,
      reason: String(n.reason ?? ''),
      required_skills: requiredSkills,
      complexity: (['simple', 'normal', 'complex'] as Complexity[]).includes(n.complexity) ? n.complexity : 'normal',
      requires_approval: !!n.requires_approval,
      goal_link: String(n.goal_link ?? ''),
    };
  });
  let edges: [string, string][] = (graph.edges || [])
    .filter((e: any) => Array.isArray(e) && e.length === 2 && nodeIds.has(String(e[0])) && nodeIds.has(String(e[1])))
    .map((e: any) => [String(e[0]), String(e[1])]);
  if (edges.length === 0 && nodes.length > 1) {
    edges = nodes.slice(0, -1).map((n: any, i: number) => [n.id, nodes[i + 1].id]);
  }
  return { nodes, edges, summary: String(graph.summary || '') };
}

export async function generateTaskGraph(request: string, pool: ModelPool | null, router: Router, options?: { previousPlan?: PlannedGraph | null; feedbacks?: string[]; level?: TaskLevel; pinnedModel?: string; projectId?: string }): Promise<PlannedGraph> {
  const previousPlan = options?.previousPlan ?? null;
  const feedbacks = options?.feedbacks ?? [];
  const level = options?.level;
  const pinnedModel = options?.pinnedModel;
  const projectId = options?.projectId;
  if (pool) {
    // main-agent model pinning (improvement 11): the pinned model wins at creation;
    // only a hard failure degrades to dynamic selection (logged, never silently re-pinned)
    const pinnedEntry = pinnedModel ? pool.getModel(pinnedModel) : null;
    if (pinnedModel && !pinnedEntry) {
      const { getLogger } = await import('../logger');
      getLogger().warn('Pinned main-agent model not found in pool, degrading to dynamic selection', { pinnedModel });
    }
    const model = pinnedEntry ?? pool.selectModel(['code'], 'complex');
    if (model) {
      const result = await llmPlan(request, pool, router, model, previousPlan, feedbacks, level, pinnedEntry ? pinnedModel : undefined, projectId);
      if (result) return result;
    }
  }
  if (previousPlan && feedbacks.length) {
    // offline: apply feedback as best effort (keep previous plan)
    return { ...previousPlan, summary: (previousPlan.summary || '') + '（离线模式：反馈未应用，保留原计划）' };
  }
  return fallbackGraph(request, router.getAvailable());
}

async function llmPlan(request: string, pool: ModelPool, router: Router, model: any, previousPlan: PlannedGraph | null, feedbacks: string[], level?: TaskLevel, pinnedModel?: string, projectId?: string): Promise<PlannedGraph | null> {
  const available = [...router.getAvailable().keys()];
  const agentDesc =
    [...router.getAvailable().values()].map((p) => `- ${p.name}: ${p.role || p.description} (tags: ${p.tags.join(',')})`).join('\n') || '- dev: 开发实现';
  const memory = (await getMemory()).map((m) => `- ${m}`).join('\n') || '（暂无历史经验）';
  const knowledge = (await relevantKnowledge(request, { project_id: projectId, limit: 4 })).map((k) => `${k.title}：${k.content.slice(0, 160)}`);
  // skill map (R2): normalizePlan needs the agents' tags to enforce required_skills
  const skillMap = new Map<string, AgentSkillInfo>(
    [...router.getAvailable().values()].map((p) => [p.name, { name: p.name, tags: p.tags as string[] }])
  );

  try {
    const resp = await chat(model, [
      { role: 'system', content: 'You are a task planner. Use ONLY the given agent names. Output valid JSON only.' },
      { role: 'user', content: buildPlanMessages(request, available, agentDesc, memory, previousPlan, feedbacks, level, knowledge) },
    ], 8192);
    pool.recordUsage(model.name, resp.promptTokens, resp.completionTokens);
    const graph = extractJson(stripCodeFence(resp.content));
    return normalizePlan(graph, available, skillMap);
  } catch (e) {
    if (pinnedModel) {
      // pinned main-agent model failed: degradation is allowed but must be traceable
      const { getLogger } = await import('../logger');
      getLogger().warn('Pinned main-agent model failed, degrading to dynamic selection', { pinnedModel, error: String(e).slice(0, 200) });
    }
    return null;
  }
}
