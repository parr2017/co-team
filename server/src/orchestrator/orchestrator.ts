import * as fs from 'node:fs';
import * as path from 'node:path';
import { generateTaskGraph, PlannedGraph } from './planner';
import type { ModelPool, ModelEntry } from '../scheduler';
import { Router, DEFAULT_RULES } from '../router';
import type { AgentPlugin, AgentTask } from '../agents';
import { createSandbox, cleanupSandbox, mergeChanges, PermissionPolicy } from '../sandbox';
import { applyFinalOutput, applyToolCalls, listFiles } from '../tools';
import type { KnowledgeToolContext } from '../tools';
import * as gitTool from '../git';
import { simpleGit } from 'simple-git';
import { saveConversation } from '../transcript';
import { notify } from '../notify';
import { chat, extractJson, stripCodeFence } from '../llm';
import { busGet, busSet, busKeys, busDel } from '../bus';
import {
  addAgentMemory,
  addMemory,
  appendJournal,
  clearCancelled,
  emitProgress,
  getAgentMemory,
  getApprovals,
  getMemory,
  getTaskGraph,
  isCancelled,
  persistGraph,
  recordAgentTask,
  saveTaskGraph,
  getTaskGraph as loadGraph,
  getProject,
  getProjectMemory,
  addProjectMemory,
} from '../store';
import { TaskGraph, TaskNode, TaskStatus, TaskLevel, AgentResult, AgentConversation, ProgressInfo } from '../types';
import { getLogger } from '../logger';
import { assessRequirement, isConfirmation, MAX_CLARIFY_ROUNDS, type ClarifyAnswer } from '../clarify';
import { gradeTask, normalizeLevel, LEVEL_PROFILES } from '../grader';
import { computeProgress, shouldBroadcast, clearProgressThrottle } from '../progress';
import { writeKnowledge, relevantKnowledge } from '../knowledge';
import { writeDoc, checkDocs, buildTaskSpec, buildStatusReport, buildApiContract, docsSection, getDocRegistry } from '../ssot';
import { findTestFailure, parseTestOutput, buildFixPrompt, isTestCommand, MAX_FIX_ROUNDS } from '../testloop';
import { createSnapshot } from '../snapshot';

export interface OrchestratorOptions {
  agentsDir: string;
  modelPool: ModelPool | null;
  policy: PermissionPolicy;
  maxRetries: number;
  sandboxEnabled: boolean;
  gitEnabled: boolean;
  branchWorkflow?: boolean;
  tokenBudget?: number;
  maxFixRounds?: number;
}

const MERGE_NODE_NAME = '主 Agent 合并分支';

function newNode(base: Record<string, any>, taskId: string): TaskNode {
  return {
    id: String(base.id),
    task_id: taskId,
    name: String(base.name ?? ''),
    status: 'pending',
    agent: String(base.agent ?? 'dev'),
    result: null,
    error: '',
    retry_count: 0,
    complexity: base.complexity ?? 'normal',
    requires_approval: !!base.requires_approval,
    needs_human: false,
    reason: String(base.reason ?? ''),
    goal_link: String(base.goal_link ?? ''),
    branch: '',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
}

/** Strip any planner-produced merge nodes; the orchestrator appends its own. */
function stripMergeNodes(planned: PlannedGraph): PlannedGraph {
  const nodes = planned.nodes.filter((n) => !(n.agent === 'orchestrator' && String(n.name).includes('合并')));
  const ids = new Set(nodes.map((n) => String(n.id)));
  const edges = planned.edges.filter(([a, b]) => ids.has(a) && ids.has(b));
  return { ...planned, nodes, edges };
}

/** Append the final 主 Agent 合并 node; it waits for EVERY agent node so no branch is left unmerged. */
function appendMergeNode(planned: PlannedGraph): PlannedGraph {
  const nodes = [...planned.nodes];
  const edges = planned.edges.filter(([src, dst]) => src !== 'merge-auto' && dst !== 'merge-auto');
  const mergeId = 'merge-auto';
  nodes.push({ id: mergeId, name: MERGE_NODE_NAME, agent: 'orchestrator', complexity: 'simple', requires_approval: false, reason: '全部节点分支按拓扑序合并回基线，测试通过后执行' });
  for (const n of nodes) {
    if (String(n.id) !== mergeId && n.agent !== 'orchestrator') {
      edges.push([String(n.id), mergeId]);
    }
  }
  return { ...planned, nodes, edges };
}

export class Orchestrator {
  plugins: Map<string, AgentPlugin>;
  router: Router;
  private pool: ModelPool | null;
  private policy: PermissionPolicy;
  private maxRetries: number;
  private sandboxEnabled: boolean;
  private gitEnabled: boolean;
  private branchWorkflow: boolean;
  private tokenBudget?: number;
  private maxFixRounds: number;
  private agentsDir: string;
  private taskTokens = new Map<string, number>();
  private logger = getLogger();
  onProgress: ((type: string, payload: Record<string, unknown>) => void) | null = null;

  constructor(opts: OrchestratorOptions) {
    this.plugins = new Map();
    this.agentsDir = opts.agentsDir;
    this.pool = opts.modelPool;
    this.policy = opts.policy;
    this.maxRetries = opts.maxRetries;
    this.sandboxEnabled = opts.sandboxEnabled;
    this.gitEnabled = opts.gitEnabled;
    this.branchWorkflow = opts.branchWorkflow ?? true;
    this.tokenBudget = opts.tokenBudget;
    this.maxFixRounds = opts.maxFixRounds ?? MAX_FIX_ROUNDS;
    this.router = new Router([], DEFAULT_RULES, this.makeLlmRouter());
    this.logger.info('Orchestrator initialized', {
      agentsDir: opts.agentsDir,
      maxRetries: opts.maxRetries,
      sandboxEnabled: opts.sandboxEnabled,
      gitEnabled: opts.gitEnabled,
    });
  }

  async loadAgents(): Promise<void> {
    const { discoverAgents } = await import('../agents');
    const plugins = await discoverAgents(this.agentsDir);
    this.plugins = new Map(plugins.map((p) => [p.name, p]));
    this.router = new Router([...this.plugins.values()], DEFAULT_RULES, this.makeLlmRouter());
  }

  async reloadAgents(): Promise<string[]> {
    await this.loadAgents();
    return [...this.plugins.keys()];
  }

  private makeLlmRouter() {
    if (!this.pool) return undefined;
    return async (description: string, available: string[]): Promise<string | null> => {
      const entry = this.pool!.selectModel(['code'], 'simple');
      if (!entry) return null;
      const resp = await chat(entry, [
        { role: 'system', content: '你是任务路由器。只输出一个 agent 名字，不要输出其他内容。' },
        { role: 'user', content: `可选 agent：${available.join(', ')}\n任务：${description}\n输出最合适的 agent 名字：` },
      ], 1024, 0);
      return resp.content.trim();
    };
  }

  async plan(request: string): Promise<PlannedGraph> {
    return generateTaskGraph(request, this.pool, this.router);
  }

  /** Plan with grading level, pinned main model and clarified context (improvements 5/7/11). */
  private async planFor(request: string, opts: { level?: TaskLevel; mainModelId?: string; projectId?: string }): Promise<PlannedGraph> {
    return generateTaskGraph(request, this.pool, this.router, {
      level: opts.level,
      pinnedModel: opts.mainModelId,
      projectId: opts.projectId,
    });
  }

  async createTask(
    description: string,
    workspace: string,
    projectId?: string,
    opts?: { mainModelId?: string; level?: string }
  ): Promise<{ taskId: string; graph: PlannedGraph; needsClarification?: boolean; questions?: string[]; summary?: string; level?: TaskLevel }> {
    this.logger.info('Creating task', { description, workspace, projectId });

    // improvement 7: task grading (explicit user level wins, otherwise auto-graded)
    const level: TaskLevel = normalizeLevel(opts?.level) ?? gradeTask(description);

    // improvement 11: main-agent model pinned at creation (manual selection, validated)
    let mainModelId = opts?.mainModelId?.trim() || undefined;
    if (mainModelId && this.pool && !this.pool.getModel(mainModelId)) {
      throw new Error(`model not in pool: ${mainModelId}`);
    }

    // improvement 5: requirement clarification loop — ambiguous requirements must be
    // resolved with the human before any planning/execution happens
    const assessment = await assessRequirement(description, this.pool);
    const taskId = Math.random().toString(36).slice(2, 10);

    if (!assessment.clear) {
      this.logger.info('Requirement unclear, entering clarification loop', { taskId, missing: assessment.missing });
      await saveTaskGraph(taskId, [], [], {
        description,
        workspace,
        status: 'clarifying',
        project_id: projectId,
      });
      await busSet(`task:clarify:${taskId}`, {
        rounds: 1,
        questions: assessment.questions,
        answers: [] as ClarifyAnswer[],
        assessment,
        level,
        main_model_id: mainModelId,
      });
      const graph = { nodes: [], edges: [], summary: assessment.summary || '' } as PlannedGraph;
      await emitProgress('task_needs_clarification', { task_id: taskId, questions: assessment.questions, missing: assessment.missing });
      notify('task_needs_clarification', { task_id: taskId }, `[Co-Team] 任务 ${taskId} 需求不清晰，请回答澄清问题`);
      return { taskId, graph, needsClarification: true, questions: assessment.questions, summary: assessment.summary, level };
    }

    const planned = await this.planAndSave(taskId, description, workspace, projectId, { level, mainModelId });
    return { taskId, graph: planned.graph, level: planned.level };
  }

  /** Generate + persist the plan for a (possibly clarified) requirement. */
  private async planAndSave(
    taskId: string,
    description: string,
    workspace: string,
    projectId: string | undefined,
    opts: { level: TaskLevel; mainModelId?: string; clarifyContext?: string }
  ): Promise<{ graph: PlannedGraph; level: TaskLevel }> {
    // project mode: agents get up to speed from the project's accumulated memory
    let requestWithContext = description;
    if (projectId) {
      const pm = await getProjectMemory(projectId, 10);
      if (pm.length) requestWithContext += '\n\n[本项目开发背景与规范]\n' + pm.map((m) => '- ' + m.text).join('\n');
    }
    if (opts.clarifyContext) {
      requestWithContext += `\n\n[需求澄清问答（人类已确认）]\n${opts.clarifyContext}`;
    }

    this.logger.debug('Generating task graph', { description: requestWithContext.slice(0, 100) });
    const planned = appendMergeNode(stripMergeNodes(await this.planFor(requestWithContext, { level: opts.level, mainModelId: opts.mainModelId, projectId })));

    const nodes = planned.nodes.map((n) => newNode(n, taskId));

    this.logger.info('Task created', {
      taskId,
      nodesCount: nodes.length,
      edgesCount: planned.edges.length,
      agents: [...new Set(nodes.map((n) => n.agent))],
      level: opts.level,
      mainModelId: opts.mainModelId,
    });

    // plans wait for user review: status stays "planned" until explicitly executed
    await saveTaskGraph(taskId, nodes, planned.edges, {
      description,
      workspace,
      status: 'planned',
      project_id: projectId,
      level: opts.level,
      main_model_id: opts.mainModelId,
    });
    return { graph: planned, level: opts.level };
  }

  /**
   * Clarification loop step (improvement 5): record human answers, re-assess, and only
   * proceed to planning on explicit confirmation, a clear re-assessment, or round limit.
   */
  async clarify(taskId: string, input: { answers?: { question: string; answer: string }[]; confirm?: boolean; text?: string }): Promise<{ status: string; questions?: string[]; graph?: PlannedGraph; summary?: string }> {
    const graph = await loadGraph(taskId);
    if (!graph) throw new Error('Task graph not found');
    if (graph.status !== 'clarifying') return { status: graph.status };

    const state = (await busGet<{ rounds: number; questions: string[]; answers: ClarifyAnswer[]; level: TaskLevel; main_model_id?: string }>(`task:clarify:${taskId}`)) || {
      rounds: 1,
      questions: [],
      answers: [],
      level: 'standard' as TaskLevel,
    };

    for (const a of input.answers || []) {
      if (a.answer?.trim()) state.answers.push({ question: a.question || '', answer: a.answer.trim() });
    }
    if (input.text?.trim()) {
      state.answers.push({ question: '(补充说明)', answer: input.text.trim() });
    }

    const clarifiedContext = state.answers.map((a, i) => `${i + 1}. ${a.question} → ${a.answer}`).join('\n');
    const explicitConfirm = input.confirm === true || state.answers.some((a) => isConfirmation(a.answer));

    if (!explicitConfirm && state.rounds < MAX_CLARIFY_ROUNDS) {
      // re-assess with the accumulated answers
      const assessment = await assessRequirement(graph.description, this.pool, state.answers);
      if (!assessment.clear) {
        state.rounds += 1;
        state.questions = assessment.questions;
        await busSet(`task:clarify:${taskId}`, state);
        await emitProgress('task_needs_clarification', { task_id: taskId, round: state.rounds, questions: assessment.questions });
        return { status: 'clarifying', questions: assessment.questions, summary: assessment.summary };
      }
    }

    // confirmed / clear / max rounds reached → proceed to planning
    const planned = await this.planAndSave(taskId, graph.description, graph.workspace, graph.project_id, {
      level: state.level,
      mainModelId: state.main_model_id,
      clarifyContext: clarifiedContext || undefined,
    });
    await busSet(`task:clarify:${taskId}`, { ...state, done: true, confirmed_at: new Date().toISOString() });
    await emitProgress('task_clarified', { task_id: taskId, rounds: state.rounds, answers: state.answers.length });
    this.logger.info('Requirement confirmed, plan generated', { taskId, rounds: state.rounds });
    return { status: 'planned', graph: planned.graph };
  }

  /** Re-generate the plan for a task from user feedback (multi-round refinement). */
  async replan(taskId: string, feedback: string): Promise<PlannedGraph> {
    const graph = await loadGraph(taskId);
    if (!graph) throw new Error('Task graph not found');

    const feedbacksKey = `task:feedbacks:${taskId}`;
    const feedbacks = (await busGet<string[]>(feedbacksKey)) || [];
    if (feedback) feedbacks.push(feedback);
    await busSet(feedbacksKey, feedbacks);

    const previousPlan: PlannedGraph = {
      nodes: graph.nodes
        .filter((n) => n.agent !== 'orchestrator' || !n.name.includes('合并'))
        .map((n) => ({ id: n.id, name: n.name, agent: n.agent, reason: n.reason || '', complexity: n.complexity, requires_approval: n.requires_approval })),
      edges: graph.edges,
      summary: graph.description,
    };

    const planned = appendMergeNode(
      stripMergeNodes(
        await generateTaskGraph(graph.description, this.pool, this.router, {
          previousPlan,
          feedbacks,
          level: graph.level,
          pinnedModel: graph.main_model_id,
          projectId: graph.project_id,
        })
      )
    );
    const nodes = planned.nodes.map((n) => {
      const existing = graph.nodes.find((old) => old.id === String(n.id) && old.status === 'completed');
      return existing ? existing : newNode(n, taskId);
    });
    graph.nodes = nodes;
    graph.edges = planned.edges.map(([a, b]) => [a, b] as [string, string]);
    graph.status = 'planned';
    await persistGraph(graph);
    await emitProgress('task_replanned', { task_id: taskId, feedback, summary: planned.summary });
    // improvement 10: a replan is a key decision point — snapshot the state before re-execution
    await createSnapshot(taskId, { tag: 'decision', note: `replan: ${feedback.slice(0, 80)}` }).catch(() => {});
    return planned;
  }

  /** Mid-task main-agent model change (improvement 11) — user-initiated only, always audited. */
  async setMainModel(taskId: string, modelId: string): Promise<{ ok: boolean; model: string }> {
    const graph = await loadGraph(taskId);
    if (!graph) throw new Error('Task graph not found');
    if (!this.pool || !this.pool.getModel(modelId)) throw new Error(`model not in pool: ${modelId}`);
    const previous = graph.main_model_id || '(auto)';
    graph.main_model_id = modelId;
    await persistGraph(graph);
    await appendJournal(taskId, 'orchestrator', {
      role: 'master',
      kind: 'brief',
      text: `主 Agent 模型已由「${previous}」切换为「${modelId}」（用户手动修改）`,
      ts: new Date().toISOString(),
      node_id: 'model-change',
      node_name: '主 Agent 模型变更',
    });
    await emitProgress('task_model_changed', { task_id: taskId, previous, model: modelId });
    notify('task_model_changed', { task_id: taskId, model: modelId }, `[Co-Team] 任务 ${taskId} 主 Agent 模型切换为 ${modelId}`);
    return { ok: true, model: modelId };
  }

  /** Global goal management (improvement 9): update goal + invalidate agent sessions. */
  async updateGoal(taskId: string, content: string): Promise<{ ok: boolean }> {
    const graph = await loadGraph(taskId);
    if (!graph) throw new Error('Task graph not found');
    if (!content.trim()) throw new Error('goal content is required');
    await busSet(`task:goal:${taskId}`, { content: content.trim(), updated_at: new Date().toISOString(), updated_by: 'user' });
    // sessions carry stale context — force agents to re-read the goal on their next call
    const sessionKeys = await busKeys(`task:${taskId}:agent:*:session`);
    for (const key of sessionKeys) await busDel(key);
    await appendJournal(taskId, 'orchestrator', {
      role: 'master',
      kind: 'brief',
      text: `全局目标已更新：${content.trim().slice(0, 200)}`,
      ts: new Date().toISOString(),
      node_id: 'goal-update',
      node_name: '全局目标变更',
    });
    await emitProgress('goal_updated', { task_id: taskId });
    return { ok: true };
  }

  async getGoal(taskId: string): Promise<{ content: string; updated_at?: string; updated_by?: string }> {
    return (await busGet(`task:goal:${taskId}`)) || { content: '' };
  }

  async execute(taskId: string, workspace: string): Promise<Record<string, any>> {
    this.logger.taskStart(taskId, '');
    
    const graph = await loadGraph(taskId);
    if (!graph) {
      this.logger.error('Task graph not found', { taskId });
      return { status: 'error', message: 'Task graph not found' };
    }
    // a task without a plan (clarification pending / shell) must not execute
    if (graph.status === 'clarifying' || graph.nodes.length === 0) {
      this.logger.warn('Execution blocked: task has no plan yet', { taskId, status: graph.status });
      return { status: 'error', message: 'Task has no plan yet (clarification or plan review pending)' };
    }

    this.logger.info('Task execution started', { 
      taskId, 
      workspace, 
      nodesCount: graph.nodes.length,
      description: graph.description?.slice(0, 50)
    });

    // a fresh run clears any previous cancel flag so the task can execute again
    await clearCancelled(taskId);
    clearProgressThrottle(taskId);

    // reset non-completed nodes so re-runs (after approval) resume cleanly
    for (const node of graph.nodes) {
      if (node.status !== 'completed' && node.status !== 'cancelled') node.status = 'pending';
    }
    graph.workspace = workspace;
    graph.status = 'running';
    await persistGraph(graph);
    await emitProgress('execute_start', { task_id: taskId, workspace, total_nodes: graph.nodes.length });

    let sandbox: string;
    try {
      sandbox = this.sandboxEnabled ? createSandbox(workspace) : workspace;
      this.logger.debug('Sandbox created', { taskId, sandbox, sandboxEnabled: this.sandboxEnabled });
    } catch (error) {
      // persist the failure — otherwise the graph stays 'running' forever
      this.logger.error('Failed to create sandbox', { taskId, error: String(error) });
      graph.status = 'failed';
      await persistGraph(graph);
      await emitProgress('execute_failed', {
        task_id: taskId,
        completed: 0,
        total: graph.nodes.length,
        status: 'failed',
        error: `Failed to create sandbox: ${error}`,
      });
      return { status: 'failed', error: `Failed to create sandbox: ${error}` };
    }

    if (this.branchWorkflow && this.gitEnabled) {
      // baseline snapshot: all agent branches start from here
      await gitTool.ensureBase(sandbox).catch(() => {});
    }

    // improvement 9: global goal — one shared target every agent must serve
    const clarifyState = await busGet<{ answers?: ClarifyAnswer[] }>(`task:clarify:${taskId}`);
    const goalContent = [graph.description, ...(clarifyState?.answers || []).map((a) => `- ${a.question} → ${a.answer}`)].join('\n');
    await busSet(`task:goal:${taskId}`, { content: goalContent, updated_at: new Date().toISOString(), updated_by: 'system' });
    const goalDir = this.sandboxEnabled && sandbox !== workspace ? sandbox : null;
    if (goalDir) {
      try { fs.writeFileSync(path.join(sandbox, 'GLOBAL_GOAL.md'), `# GLOBAL_GOAL\n\n${goalContent}\n`, 'utf-8'); } catch { /* best effort */ }
    }

    // improvement 4: SSOT documents — the single source of truth for agent collaboration
    const docTarget = this.sandboxEnabled && sandbox !== workspace ? sandbox : undefined;
    const levelLabel = LEVEL_PROFILES[graph.level ?? 'standard'].label;
    try {
      await writeDoc(taskId, 'TASK_SPEC', buildTaskSpec(
        graph.description,
        `${levelLabel} (${graph.level ?? 'standard'})`,
        graph.nodes.filter((n) => n.agent !== 'orchestrator').map((n) => ({ id: n.id, name: n.name, agent: n.agent })),
        goalContent
      ), 'orchestrator', docTarget);
      if (/api|接口|endpoint/i.test(graph.description)) {
        await writeDoc(taskId, 'API_CONTRACT', buildApiContract(graph.description), 'orchestrator', docTarget);
      }
      await writeDoc(taskId, 'STATUS_REPORT', buildStatusReport(graph.description, [], [], graph.nodes.filter((n) => n.status === 'pending').map((n) => n.name)), 'orchestrator', docTarget);
    } catch (e) {
      this.logger.warn('SSOT doc initialization failed (non-fatal)', { taskId, error: String(e) });
    }

    // improvement 10: task-start snapshot (git ref + collaboration state)
    await createSnapshot(taskId, { tag: 'task-start', workspace, sandbox }).catch((e) => this.logger.warn('task-start snapshot failed', { taskId, error: String(e) }));
    await emitProgress('progress_update', { task_id: taskId, progress: computeProgress(graph) });

    let result: Record<string, any> = { status: 'failed', error: 'execution did not run' };
    try {
      result = await this.runGraph(taskId, graph, sandbox);
    } catch (error) {
      this.logger.error('Task execution failed', { taskId, error: String(error) });
      result = { status: 'failed', error: `Execution failed: ${error}` };
    } finally {
      if (this.sandboxEnabled && sandbox !== workspace) {
        if (result?.status === 'success') {
          try {
            if (this.branchWorkflow && this.gitEnabled) {
              // merged result lives on the sandbox base branch; sync files to the real workspace
              await gitTool.syncToWorkspace(sandbox, workspace, 'coteam/base');
              result.merged_branches = result.merged_branches || [];
            } else {
              result.merged_files = mergeChanges(sandbox, workspace);
            }
          } catch (mergeError) {
            // a failed merge must NOT be reported as success — the work never reached the workspace
            this.logger.error('Failed to merge sandbox changes into workspace', { taskId, error: String(mergeError) });
            result = {
              status: 'failed',
              error: `Failed to merge changes into workspace: ${String(mergeError).slice(0, 300)}`,
              changes: result.changes || [],
            };
          }
        }
        try {
          cleanupSandbox(sandbox);
          this.logger.debug('Sandbox cleaned up', { taskId });
        } catch (cleanupError) {
          // cleanup failures (e.g. fs.rmSync EBUSY on Windows) must not swallow the final status write
          this.logger.warn('Sandbox cleanup failed (non-fatal)', { taskId, error: String(cleanupError) });
        }
      }
    }

    const status = String(result.status);
    this.logger.info('Task execution completed', { 
      taskId, 
      status, 
      changes: (result.changes || []).length,
      completedNodes: graph.nodes.filter((n) => n.status === 'completed').length,
      totalNodes: graph.nodes.length,
    });

    if (status === 'success' && this.gitEnabled && (result.changes || []).length) {
      result.git_commit = await this.gitCommit(taskId, workspace, result.changes as string[]);
    }

    graph.status = status === 'success' ? 'success' : status;
    await persistGraph(graph);
    await emitProgress(status === 'success' ? 'execute_complete' : `execute_${status}`, {
      task_id: taskId,
      completed: graph.nodes.filter((n) => n.status === 'completed').length,
      total: graph.nodes.length,
      all_changes: result.changes || [],
      status,
      ...(result.error ? { error: result.error } : {}),
    });

    const description = graph.description || taskId;
    if (status === 'success') {
      notify('task_success', { task_id: taskId }, `[Co-Team] 任务 ${taskId} 完成，${(result.changes || []).length} 个文件变更`);
      await addMemory(`任务「${description}」成功完成，产出了 ${(result.changes || []).length} 个文件变更。`);
    } else if (status === 'failed') {
      notify('task_failed', { task_id: taskId, error: result.error }, `[Co-Team] 任务 ${taskId} 失败：${result.error}`);
      await addMemory(`任务「${description}」失败于节点：${result.error}。后续类似任务注意规避。`);
    }

    // improvement 10: task-end snapshot for post-hoc rollback / audit
    await createSnapshot(taskId, { tag: 'task-end', workspace, note: `status=${status}` }).catch(() => {});
    clearProgressThrottle(taskId);

    // improvement 3: post-task review deposits a structured lesson into the knowledge base
    try {
      const changes = (result.changes || []) as string[];
      if (changes.length > 0 || status === 'failed') {
        await writeKnowledge({
          title: `任务复盘 ${taskId}：${description.slice(0, 40)}`,
          content: [
            `状态: ${status}`,
            changes.length ? `产出变更:\n${changes.slice(0, 10).map((c) => '- ' + c).join('\n')}` : '产出变更: 无',
            result.error ? `失败原因: ${String(result.error).slice(0, 300)}` : '',
            graph.project_id ? `项目: ${graph.project_id}` : '',
          ].filter(Boolean).join('\n\n'),
          category: graph.project_id ? 'project' : 'general-tech',
          project_id: graph.project_id,
          tags: ['任务复盘', status],
          source: `task:${taskId}`,
        });
      }
    } catch (e) {
      this.logger.warn('Knowledge review deposit failed (non-fatal)', { taskId, error: String(e) });
    }
    return result;
  }

  // ---------- DAG execution ----------

  private async runGraph(taskId: string, graph: TaskGraph, sandbox: string): Promise<Record<string, any>> {
    const upstream = new Map<string, string[]>();
    for (const node of graph.nodes) upstream.set(node.id, []);
    for (const [src, dst] of graph.edges) upstream.get(dst)?.push(src);

    const maxWorkers = Math.max(1, this.pool ? this.pool.totalAvailable() : 2);

    while (!(await isCancelled(taskId))) {
      const ready = graph.nodes.filter((node) => {
        if (node.status !== 'pending') return false;
        return (upstream.get(node.id) || []).every((dep) => this.statusOf(graph, dep) === 'completed');
      });
      if (ready.length === 0) break;

      const approvals = await getApprovals(taskId);
      const blocked = ready.filter((n) => n.requires_approval && !approvals.includes(n.id));
      const runnable = ready.filter((n) => !blocked.includes(n));
      for (const node of blocked) {
        await this.setNodeStatus(graph, node, 'waiting_approval', 'needs human approval');
        await emitProgress('node_waiting_approval', { task_id: taskId, node_id: node.id, name: node.name });
        notify('approval_required', { task_id: taskId, node_id: node.id }, `[Co-Team] 节点「${node.name}」等待人工审批`);
      }
      if (runnable.length === 0) return { status: 'waiting_approval', changes: [] };

      // improvement 4: document check before execution — agents must read the latest SSOT
      if (this.sandboxEnabled && sandbox !== graph.workspace) {
        const check = await checkDocs(taskId, sandbox).catch(() => null);
        if (check && !check.ok) {
          this.logger.warn('SSOT doc check restored inconsistent documents', { taskId, restored: check.restored });
          await appendJournal(taskId, 'orchestrator', {
            role: 'master',
            kind: 'brief',
            text: `文档检查发现不一致并已恢复: ${check.issues.join('; ')}`,
            ts: new Date().toISOString(),
            node_id: runnable[0].id,
            node_name: runnable[0].name,
          });
        }
      }

      await Promise.all(runnable.map((node) => this.executeNode(taskId, graph, node, sandbox, maxWorkers)));

      // improvement 4: keep STATUS_REPORT in sync after every execution wave
      // improvement 6: node transitions are milestones — broadcast progress (throttled)
      try {
        const done = graph.nodes.filter((n) => n.status === 'completed' && n.agent !== 'orchestrator').map((n) => n.name);
        const runningNow = graph.nodes.filter((n) => n.status === 'running' || n.status === 'retrying').map((n) => n.name);
        const pendingNow = graph.nodes.filter((n) => n.status === 'pending').map((n) => n.name);
        const docTarget = this.sandboxEnabled && sandbox !== graph.workspace ? sandbox : undefined;
        await writeDoc(taskId, 'STATUS_REPORT', buildStatusReport(graph.description, done, runningNow, pendingNow), 'orchestrator', docTarget);
      } catch { /* best effort */ }
      await emitProgress('progress_update', { task_id: taskId, progress: computeProgress(graph) });

      const failed = runnable.find((n) => n.status === 'failed');
      if (failed) {
        await this.cancelDownstream(graph, upstream, failed.id);
        return { status: 'failed', node: failed.id, error: failed.error };
      }
    }

    if (await isCancelled(taskId)) {
      for (const node of graph.nodes) {
        if (node.status === 'pending') await this.setNodeStatus(graph, node, 'cancelled', 'task cancelled');
      }
      return { status: 'cancelled' };
    }

    // guard: never report success while some nodes are still waiting for approval
    // (they are no longer 'pending', so the ready-loop above exits without touching them)
    if (graph.nodes.some((n) => n.status === 'waiting_approval' || n.status === 'running' || n.status === 'retrying')) {
      return { status: 'waiting_approval', changes: [] };
    }

    const completed = graph.nodes.filter((n) => n.status === 'completed');
    return {
      status: 'success',
      completed: completed.length,
      total: graph.nodes.length,
      changes: this.collectChanges(graph.nodes),
    };
  }

  private statusOf(graph: TaskGraph, nodeId: string): TaskStatus {
    return graph.nodes.find((n) => n.id === nodeId)?.status ?? 'pending';
  }

  private async cancelDownstream(graph: TaskGraph, upstream: Map<string, string[]>, failedId: string): Promise<void> {
    let changed = true;
    const cancelled = new Set<string>([failedId]);
    while (changed) {
      changed = false;
      for (const node of graph.nodes) {
        if (node.status === 'pending' && (upstream.get(node.id) || []).some((d) => cancelled.has(d) || this.statusOf(graph, d) === 'cancelled' || this.statusOf(graph, d) === 'failed')) {
          await this.setNodeStatus(graph, node, 'cancelled', 'upstream failed');
          cancelled.add(node.id);
          changed = true;
        }
      }
    }
  }

  private collectChanges(nodes: TaskNode[]): string[] {
    const all: string[] = [];
    for (const n of nodes) {
      if (n.result?.changes) all.push(...n.result.changes);
    }
    return [...new Set(all)];
  }

  // ---------- single node ----------

  /** Safety wrapper: a node must ALWAYS land on a terminal status, even if the inner pipeline throws. */
  private async executeNode(taskId: string, graph: TaskGraph, node: TaskNode, sandbox: string, workers: number): Promise<void> {
    try {
      await this.executeNodeInner(taskId, graph, node, sandbox, workers);
    } catch (e: any) {
      if (node.status === 'completed' || node.status === 'cancelled') return;
      this.logger.error('Node execution crashed unexpectedly', { taskId, nodeId: node.id, error: String(e) });
      node.status = 'failed';
      node.finished_at = new Date().toISOString();
      node.error = node.error || String(e?.message || e).slice(0, 300);
      node.needs_human = true;
      await persistGraph(graph).catch(() => {});
      await emitProgress('node_error', { task_id: taskId, node_id: node.id, name: node.name, agent: node.agent, error: node.error }).catch(() => {});
    }
  }

  private async executeNodeInner(taskId: string, graph: TaskGraph, node: TaskNode, sandbox: string, _workers: number): Promise<void> {
    this.logger.nodeStart(taskId, node.id, node.agent, node.name);
    
    node.status = 'running';
    node.started_at = new Date().toISOString();
    node.updated_at = node.started_at;
    await persistGraph(graph);
    await emitProgress('node_start', { task_id: taskId, node_id: node.id, name: node.name, agent: node.agent, branch: node.branch });

    if (node.agent === 'orchestrator') {
      if (node.name.includes('合并')) {
        await this.runMergeNode(graph, node, sandbox);
      } else {
        node.status = 'completed';
        node.finished_at = new Date().toISOString();
        node.result = { status: 'success', summary: 'orchestrator step' };
        await persistGraph(graph);
        await emitProgress('node_complete', { task_id: taskId, node_id: node.id, name: node.name, agent: node.agent, changes: [] });
      }
      return;
    }

    const plugin = this.router.getAvailable().get(node.agent);
    if (!plugin) {
      node.status = 'failed';
      node.finished_at = new Date().toISOString();
      node.error = `Agent ${node.agent} not found`;
      await persistGraph(graph);
      await emitProgress('node_error', { task_id: taskId, node_id: node.id, error: node.error });
      return;
    }

    // branch workflow: each agent works on its own branch off its dependencies
    const useBranch = this.branchWorkflow && this.gitEnabled && this.sandboxEnabled;
    if (useBranch) {
      const parent = this.parentBranchFor(graph, node);
      const branch = `coteam/${node.id}-${node.agent}`;
      const ok = await gitTool.createNodeBranch(sandbox, branch, parent).catch(() => false);
      node.branch = ok ? branch : '';
      await persistGraph(graph);
      await emitProgress('node_branch_created', { task_id: taskId, node_id: node.id, branch: node.branch, parent });
    }

    let error = '';
    let fixRound = 0;
    // regular attempts are bounded by maxRetries; test-fix rounds extend the budget
    // separately (improvement 8) so a broken commit is never accepted
    for (let attempt = 0; attempt < Math.max(1, this.maxRetries) + fixRound; attempt++) {
      // Check for cancellation before each retry attempt
      if (await isCancelled(taskId)) {
        node.status = 'cancelled';
        node.finished_at = new Date().toISOString();
        node.error = 'task cancelled';
        await persistGraph(graph);
        await emitProgress('node_cancelled', { task_id: taskId, node_id: node.id, name: node.name });
        return;
      }
      if (attempt > 0) {
        node.status = 'retrying';
        node.retry_count = attempt;
        await persistGraph(graph);
        await emitProgress('node_retry', { task_id: taskId, node_id: node.id, attempt: attempt + 1 });
      }
      const result = await this.dispatch(taskId, node, plugin, sandbox, false, error, `第 ${attempt + 1} 次尝试`);
      if (result.status === 'success') {
        // improvement 8: test-fix loop — a failing test command blocks the commit and
        // triggers a targeted repair round instead of accepting broken code
        const testFail = findTestFailure(result.command_results);
        if (testFail && fixRound < this.maxFixRounds) {
          fixRound += 1;
          const parsed = parseTestOutput(testFail.output);
          error = buildFixPrompt(parsed, testFail.command, fixRound, this.maxFixRounds);
          node.status = 'retrying';
          node.retry_count = attempt + 1;
          await persistGraph(graph);
          await appendJournal(taskId, plugin.name, {
            role: 'master',
            kind: 'error',
            text: `测试修复循环 第 ${fixRound}/${this.maxFixRounds} 轮：${parsed.summary}。失败用例: ${parsed.failures.map((f) => f.name).slice(0, 5).join(', ') || '（未解析出具体用例）'}`,
            ts: new Date().toISOString(),
            node_id: node.id,
            node_name: node.name,
            meta: { command: testFail.command, failures: parsed.failures },
          });
          await emitProgress('test_fix_round', { task_id: taskId, node_id: node.id, round: fixRound, max: this.maxFixRounds, failures: parsed.failures.length, summary: parsed.summary });
          continue;
        }
        if (testFail) {
          // max fix rounds reached: produce a clear report and escalate to the main agent
          const parsed = parseTestOutput(testFail.output);
          result.status = 'failed';
          result.error = `测试修复循环达上限（${this.maxFixRounds} 轮）仍未通过: ${parsed.summary}`;
          result.errors = [...(result.errors || []), ...parsed.failures.map((f) => `${f.name}: ${f.message}`)];
          error = result.error;
          await appendJournal(taskId, plugin.name, {
            role: 'master',
            kind: 'error',
            text: result.error,
            ts: new Date().toISOString(),
            node_id: node.id,
            node_name: node.name,
            meta: { failures: parsed.failures },
          });
          break;
        }
        this.logger.nodeComplete(taskId, node.id, node.agent);
        
        node.status = 'completed';
        node.finished_at = new Date().toISOString();
        node.result = result;
        node.error = '';
        if (useBranch && node.branch) {
          const commit = await gitTool.commitOnBranch(sandbox, `coteam: ${node.name}`, result.changes || []).catch(() => null);
          if (commit && node.result) (node.result as AgentResult).git_commit = { branch: node.branch, commit };
        }
        await persistGraph(graph);
        await this.recordAgentLife(taskId, graph, node, true, result.tokens || 0);
        await emitProgress('node_complete', { task_id: taskId, node_id: node.id, name: node.name, agent: node.agent, branch: node.branch, changes: result.changes || [], summary: result.summary || '' });
        return;
      }
      error = result.error || 'unknown error';
      if (error.toLowerCase().includes('token budget')) break;
    }

    // escalation: main agent takes over with an adjusted strategy
    await emitProgress('node_escalate', { task_id: taskId, node_id: node.id, name: node.name, error });
    const result = await this.dispatch(taskId, node, plugin, sandbox, true, error, '主 Agent 接管');
    if (result.status === 'success') {
      node.status = 'completed';
      node.finished_at = new Date().toISOString();
      node.result = { ...result, escalated: true };
      node.error = '';
      if (useBranch && node.branch) {
        const commit = await gitTool.commitOnBranch(sandbox, `coteam: ${node.name} (escalated)`, result.changes || []).catch(() => null);
        if (commit) (node.result as any).git_commit = { branch: node.branch, commit };
      }
      await persistGraph(graph);
      await this.recordAgentLife(taskId, graph, node, true, result.tokens || 0);
      await emitProgress('node_complete', { task_id: taskId, node_id: node.id, name: node.name, agent: node.agent, branch: node.branch, changes: result.changes || [], summary: (result.summary || '') + '（主 Agent 接管后完成）' });
      return;
    }

    node.status = 'failed';
    node.finished_at = new Date().toISOString();
    node.error = result.error || error;
    node.result = result;
    node.needs_human = true;
    
    this.logger.nodeFailed(taskId, node.id, node.agent, node.error);
    
    await persistGraph(graph);
    await this.recordAgentLife(taskId, graph, node, false, result.tokens || 0);
    await emitProgress('node_error', { task_id: taskId, node_id: node.id, name: node.name, agent: node.agent, error: node.error });
    notify('node_needs_human', { task_id: taskId, node_id: node.id }, `[Co-Team] 节点「${node.name}」重试与接管均失败，需要人工介入`);
  }

  /** Agent life: update its persistent profile and write a lesson to its memory. */
  private async recordAgentLife(taskId: string, graph: TaskGraph, node: TaskNode, success: boolean, tokens: number): Promise<void> {
    if (node.agent === 'orchestrator') return;
    try {
      await recordAgentTask(node.agent, {
        task_id: taskId,
        description: graph.description || taskId,
        node: node.name,
        status: success ? 'completed' : 'failed',
        ts: new Date().toISOString(),
        tokens,
        model: node.result?.model,
      });
      const lesson = success
        ? `任务「${(graph.description || taskId).slice(0, 30)}」中完成「${node.name}」，产出: ${(node.result?.changes || []).slice(0, 3).join('; ') || '无文件变更'}`
        : `任务「${(graph.description || taskId).slice(0, 30)}」中节点「${node.name}」失败: ${(node.error || '').slice(0, 120)}`;
      await addAgentMemory(node.agent, lesson);
      if (graph.project_id) {
        if (!success) {
          await addProjectMemory(graph.project_id, `问题: 节点「${node.name}」失败 — ${(node.error || '').slice(0, 100)}`, 'auto', taskId);
        } else if (node.retry_count > 0) {
          await addProjectMemory(graph.project_id, `已解决: 「${node.name}」曾失败，经重试与主 Agent 接管后完成，产出: ${(node.result?.changes || []).slice(0, 2).join('; ') || '无'}`, 'auto', taskId);
        }
      }
    } catch {
      /* life bookkeeping is best-effort */
    }
  }

  // ---------- dispatch with degradation chain ----------

  /** Branch a node starts from: its last dependency's branch, else the task base. */
  private parentBranchFor(graph: TaskGraph, node: TaskNode): string {
    const deps = graph.edges.filter(([, dst]) => dst === node.id).map(([src]) => src);
    const depBranches = deps
      .map((d) => graph.nodes.find((n) => n.id === d)?.branch)
      .filter((b): b is string => !!b);
    return depBranches[depBranches.length - 1] || 'coteam/base';
  }

  /** 主 Agent merge: fold every completed agent branch back into coteam/base. */
  private async runMergeNode(graph: TaskGraph, node: TaskNode, sandbox: string): Promise<void> {
    const branches = graph.nodes
      .filter((n) => n.agent !== 'orchestrator' && n.branch && n.status === 'completed')
      .map((n) => n.branch as string);

    if (branches.length === 0) {
      node.status = 'completed';
      node.finished_at = new Date().toISOString();
      node.result = { status: 'success', summary: '没有需要合并的 agent 分支', changes: [] };
      await persistGraph(graph);
      await emitProgress('node_complete', { task_id: graph.task_id, node_id: node.id, name: node.name, agent: node.agent, changes: [] });
      return;
    }

    const merge = await gitTool.mergeAllNodes(sandbox, branches);
    if (merge.conflicts.length) {
      node.status = 'failed';
      node.finished_at = new Date().toISOString();
      node.error = `分支合并冲突: ${merge.conflicts.join(', ')}`;
      node.result = { status: 'failed', error: node.error, conflicts: merge.conflicts, merged: merge.merged };
      node.needs_human = true;
      await persistGraph(graph);
      await emitProgress('node_error', { task_id: graph.task_id, node_id: node.id, name: node.name, agent: node.agent, error: node.error });
      notify('node_needs_human', { task_id: graph.task_id, node_id: node.id }, `[Co-Team] 节点「${node.name}」分支合并冲突，需要人工介入`);
      return;
    }

    node.status = 'completed';
    node.finished_at = new Date().toISOString();
    node.result = {
      status: 'success',
      summary: `已合并 ${merge.merged.length} 个分支: ${merge.merged.join(', ')}`,
      changes: [],
      git_commit: { branch: 'coteam/base', commit: merge.head },
    };
    await persistGraph(graph);
    await emitProgress('node_complete', { task_id: graph.task_id, node_id: node.id, name: node.name, agent: node.agent, changes: [], summary: node.result.summary });
  }

  private async dispatch(taskId: string, node: TaskNode, plugin: AgentPlugin, workspace: string, escalate: boolean, lastError: string, attemptLabel: string): Promise<AgentResult> {
    try {
      await this.checkBudget(taskId);
    } catch (e: any) {
      // budget exhaustion must surface as a normal failed result, not an exception
      return { status: 'failed', error: String(e?.message || e) };
    }
    if (!this.pool) {
      this.logger.error('No model pool available', { taskId, nodeId: node.id });
      return { status: 'failed', error: 'No available model' };
    }

    const primary = this.pool.selectModel(plugin.tags, node.complexity);
    if (!primary) {
      this.logger.error('No model available for agent', { taskId, nodeId: node.id, agent: plugin.name });
      return { status: 'failed', error: 'No available model' };
    }

    this.logger.agentDispatch(taskId, node.id, plugin.name, primary.name);
    
    const chain = this.pool.fallbackChain(primary, plugin.tags);
    let lastErr = '';
    let triedCount = 0;
    for (const entry of chain) {
      // Check for cancellation before trying each model in fallback chain
      if (await isCancelled(taskId)) {
        return { status: 'failed', error: 'task cancelled' };
      }
      const acquired = await this.acquireWithWait(entry);
      if (!acquired) {
        this.logger.warn('Could not acquire model slot', { taskId, model: entry.name });
        continue;
      }
      triedCount++;
      try {
        const result = await this.callAgent(taskId, node, plugin, entry, workspace, escalate, lastError, attemptLabel);
        if (result.status === 'success') {
          this.pool.markSuccess(entry);
          this.logger.agentResponse(taskId, node.id, plugin.name, result.tokens || 0);
          if (triedCount > 1) this.logger.info('Model degraded successfully', { taskId, nodeId: node.id, agent: plugin.name, tried: triedCount, finalModel: entry.name });
          return result;
        }
        // Failed result — try next model in chain
        lastErr = result.error || 'agent reported failure';
        this.logger.warn('Model returned failure, trying next', { taskId, nodeId: node.id, agent: plugin.name, model: entry.name, error: lastErr });
        this.pool.markFailure(entry);
      } catch (e: any) {
        if (String(e?.message).includes('token budget')) {
          this.logger.error('Token budget exceeded', { taskId, nodeId: node.id });
          return { status: 'failed', error: 'token budget exceeded for this task' };
        }
        lastErr = String(e).slice(0, 500);
        this.logger.error('Agent dispatch failed', { 
          taskId, 
          nodeId: node.id, 
          agent: plugin.name, 
          model: entry.name, 
          error: lastErr 
        });
        this.pool.markFailure(entry);
      } finally {
        this.pool.release(entry);
      }
    }
    return { status: 'failed', error: `all models failed (${triedCount} tried): ${lastErr || 'unknown'}` };
  }

  private async acquireWithWait(entry: ModelEntry, timeoutMs = 120_000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (this.pool!.tryAcquire(entry)) return true;
      await new Promise((r) => setTimeout(r, 200));
    }
    return false;
  }

  private async checkBudget(taskId: string): Promise<void> {
    if (!this.tokenBudget) return;
    const used = this.taskTokens.get(taskId) || 0;
    if (used > this.tokenBudget) throw new Error(`token budget ${this.tokenBudget} exceeded (used ${used})`);
  }

  // ---------- agent LLM call with tool loop ----------

  private async callAgent(
    taskId: string,
    node: TaskNode,
    plugin: AgentPlugin,
    entry: ModelEntry,
    workspace: string,
    escalate: boolean,
    lastError: string,
    attemptLabel: string
  ): Promise<AgentResult> {
    const context = await this.upstreamContext(taskId, node);
    const workspaceFiles = listFiles(workspace, 50).join(', ');
    const maxTokens = plugin.maxTokens ?? 8192;

    const escalationBlock = escalate
      ? `\n\n## 重要：主 Agent 接管\n该任务之前已尝试 ${this.maxRetries} 次均失败，最近一次错误：${lastError}\n请调整策略：换一种实现思路，或把任务范围缩小到可完成的最小闭环，确保本次成功。`
      : '';

    // improvement 8: non-escalated retries carry the previous failure / fix prompt so
    // the agent repairs the actual problem instead of repeating the same attempt
    const fixContextBlock = !escalate && lastError ? `\n\n## 上一次尝试的问题（请针对性修复）\n${lastError.slice(0, 1800)}` : '';

    // per-agent life: cross-task lessons ride along in the system prompt
    const memories = await getAgentMemory(plugin.name, 5);
    // project mode: the project's own rules & lessons make agents productive immediately
    const projectId = (await getTaskGraph(taskId))?.project_id;
    const projectMemory = projectId ? await getProjectMemory(projectId, 8) : [];
    const projectBlock = projectMemory.length
      ? '\n\n## 本项目开发规范与经验\n' + projectMemory.map((m) => '- ' + m.text).join('\n')
      : '';

    // improvement 9: the global goal rides along with every agent call
    const goal = await busGet<{ content: string }>(`task:goal:${taskId}`);
    const goalBlock = goal?.content
      ? `\n\n## 全局目标（所有工作必须服务于此目标）\n${goal.content}\n在 summary 的开头用一句话说明本次工作对全局目标的贡献。`
      : '';

    // improvement 4: SSOT documents available in docs/
    const docsBlock = await docsSection(taskId);

    // improvement 3: relevant knowledge base entries are injected for immediate reuse
    const knowledgeHits = relevantKnowledge(`${node.name} ${context}`, { project_id: projectId, limit: 3 });
    const knowledgeBlock = knowledgeHits.length
      ? '\n\n## 相关知识库条目\n' + knowledgeHits.map((k) => `- 【${k.title}】${k.content.slice(0, 200)}`).join('\n')
      : '';

    const systemMsg = [
      plugin.prompt || '你是开发 Agent。',
      projectBlock,
      goalBlock,
      docsBlock,
      knowledgeBlock,
      memories.length ? '\n\n## 你过往的经验记忆\n' + memories.map((m) => '- ' + m).join('\n') : '',
      '\n你可以请求读取工具（返回 JSON 时附带 tool_calls 字段）:',
      ' {"tool_calls":[{"tool":"list_files"}]}',
      ' {"tool_calls":[{"tool":"read_file","path":"src/main.py"}]}',
      ' {"tool_calls":[{"tool":"grep","pattern":"正则表达式","path":"src/"}]}',
      ' {"tool_calls":[{"tool":"read_dir","path":"src/components/"}]}',
      ' {"tool_calls":[{"tool":"git_log"}]}',
      ' {"tool_calls":[{"tool":"git_diff"}]}',
      '\n沉淀经验（推荐）：执行中遇到通用经验（API 用法、最佳实践、踩坑记录）或项目特定经验时，主动调用知识写入工具:',
      ' {"tool_calls":[{"tool":"write_knowledge","category":"general-tech|project","title":"条目标题","tags":["标签"],"content":"经验内容（Markdown）"}]}',
      '\n最终输出必须是 JSON（不要 markdown 代码块）：',
      '{"status":"success|failed","changes":["file: desc"],"summary":"摘要","errors":[],',
      '"files":[{"path":"相对路径","content":"完整文件内容"}],"commands":["要执行的命令"]}',
      '\n如果任务是分析/调查类（不需要写代码），可在 summary 中写详细分析结果，files 和 commands 留空即可。',
      '\nfiles 中给出需要创建或修改的文件的完整内容；commands 会在沙箱中执行（仅限白名单命令）。',
    ].join('\n');

    const userMsg = [
      `工作目录: ${workspace}`,
      `现有文件: ${workspaceFiles}`,
      `任务: ${node.name}`,
      node.goal_link ? `对全局目标的贡献: ${node.goal_link}` : '',
      `节点复杂度: ${node.complexity}`,
      context ? `前置节点成果:\n${context}\n` : '',
      escalationBlock,
      fixContextBlock,
    ].filter(Boolean).join('\n');

    const record: AgentConversation = {
      label: attemptLabel || (escalate ? '主 Agent 接管' : '尝试'),
      agent: plugin.name,
      model: entry.name,
      node_name: node.name,
      started_at: new Date().toISOString(),
      system: systemMsg,
      rounds: [],
      tokens: 0,
      error: '',
    };
    const startedAt = Date.now();

    // session continuity: same agent keeps its conversation across nodes of this task
    const sessionKey = `task:${taskId}:agent:${plugin.name}:session`;
    const priorSession = (await busGet<{ role: 'user' | 'assistant'; content: string }[]>(sessionKey)) || [];
    const compacted = priorSession.slice(-10).map((m) =>
      m.role === 'assistant' ? { role: m.role, content: this.compactAssistant(m.content) } : m
    );
    const messages: { role: string; content: string }[] = [
      { role: 'system', content: systemMsg },
      ...compacted,
      { role: 'user', content: userMsg },
    ];

    // war-room journal: master briefing
    await appendJournal(taskId, plugin.name, {
      role: 'master', kind: 'brief', text: userMsg, ts: new Date().toISOString(), node_id: node.id, node_name: node.name, model: entry.name,
    });
    await emitProgress('agent_activity', { task_id: taskId, node_id: node.id, agent: plugin.name, text: '接收任务简报', model: entry.name });

    try {
      let parsed: Record<string, any> | null = null;
      let content = '';
      for (let round = 0; round < 3; round++) {
        // Check for cancellation before each LLM call
        if (await isCancelled(taskId)) {
          return { status: 'failed', error: 'task cancelled', tokens: record.tokens };
        }
        await emitProgress('agent_activity', {
          task_id: taskId, node_id: node.id, agent: plugin.name,
          text: `第 ${round + 1} 轮对话中…`, model: entry.name,
        });
        const resp = await chat(entry, messages, maxTokens, escalate ? 0.3 : 0);
        this.pool!.recordUsage(entry.name, resp.promptTokens, resp.completionTokens);
        this.taskTokens.set(taskId, (this.taskTokens.get(taskId) || 0) + resp.promptTokens + resp.completionTokens);
        record.tokens += resp.promptTokens + resp.completionTokens;
        content = stripCodeFence(resp.content);
        parsed = extractJson(content);
        const roundEntry: Record<string, any> = { assistant: content, tool_results: null, parse_error: null };
        if (!parsed) {
          // If this is the last round and the model returned substantial text,
          // treat it as a successful analysis result (wrap as JSON)
          if (round >= 2 && content.trim().length > 20) {
            parsed = {
              status: 'success',
              summary: content.trim(),
              changes: [],
              errors: [],
              files: [],
              commands: [],
            };
            this.logger.info('Auto-wrapped non-JSON output as analysis result', { taskId, nodeId: node.id, agent: plugin.name, model: entry.name, contentLength: content.length });
          } else {
            roundEntry.parse_error = 'output was not valid JSON';
            record.rounds.push(roundEntry);
            await appendJournal(taskId, plugin.name, { role: 'agent', kind: 'error', text: '输出无法解析为 JSON', ts: new Date().toISOString(), node_id: node.id, node_name: node.name, model: entry.name, tokens: resp.completionTokens, meta: { raw: content.slice(0, 1500) } });
            await emitProgress('agent_round', { task_id: taskId, node_id: node.id, agent: plugin.name, model: entry.name, round: round + 1, tokens: resp.completionTokens, parse_error: true });
            // If this was the last round, return failure
            if (round >= 2) {
              record.error = 'failed to parse agent output as JSON';
              return { status: 'failed', error: record.error, raw_output: content.slice(0, 2000), tokens: record.tokens };
            }
            // Otherwise, inject correction message and retry
            messages.push({ role: 'assistant', content });
            messages.push({ role: 'user', content: '你返回的内容无法解析为 JSON。请严格按照以下格式输出（不要包含任何 markdown 或额外文字）：\n{"status":"success|failed","changes":[],"summary":"你的分析或结果","errors":[],"files":[],"commands":[]}' });
            continue;
          }
        }
        const toolCalls = parsed.tool_calls || [];
        if (toolCalls.length === 0) {
          record.rounds.push(roundEntry);
          await emitProgress('agent_round', { task_id: taskId, node_id: node.id, agent: plugin.name, model: entry.name, round: round + 1, tokens: resp.completionTokens });
          break;
        }
        // If this is the last round and model still requests tools, force final output
        if (round >= 2) {
          messages.push({ role: 'assistant', content });
          messages.push({ role: 'user', content: '工具调用已达上限。请立即基于已有信息输出最终 JSON 结果，不要再请求工具。格式：\n{"status":"success|failed","changes":[],"summary":"分析结果","errors":[],"files":[],"commands":[]}' });
          // Do one more round to get final output
          const finalResp = await chat(entry, messages, maxTokens, escalate ? 0.3 : 0);
          this.pool!.recordUsage(entry.name, finalResp.promptTokens, finalResp.completionTokens);
          this.taskTokens.set(taskId, (this.taskTokens.get(taskId) || 0) + finalResp.promptTokens + finalResp.completionTokens);
          record.tokens += finalResp.promptTokens + finalResp.completionTokens;
          content = stripCodeFence(finalResp.content);
          parsed = extractJson(content);
          if (parsed && !parsed.tool_calls) {
            roundEntry.assistant = content;
            record.rounds.push(roundEntry);
            await emitProgress('agent_round', { task_id: taskId, node_id: node.id, agent: plugin.name, model: entry.name, round: round + 1, tokens: finalResp.completionTokens });
            break;
          }
          // If still tool_calls or no JSON, return failure
          record.error = 'agent failed to produce final output after tool calls';
          return { status: 'failed', error: record.error, raw_output: content.slice(0, 2000), tokens: record.tokens };
        }
        await emitProgress('agent_activity', {
          task_id: taskId, node_id: node.id, agent: plugin.name,
          text: '请求读取工具: ' + toolCalls.map((t: any) => t.tool + (t.path ? ':' + t.path : '')).join(', '),
          model: entry.name,
        });
        const knowledgeCtx: KnowledgeToolContext = { agent: plugin.name, task_id: taskId, project_id: projectId || undefined };
        const results = applyToolCalls(workspace, toolCalls, knowledgeCtx);
        // improvement 3: agent-driven knowledge deposits are audited in the war room
        for (const r of results as Record<string, any>[]) {
          if (r?.tool === 'write_knowledge' && r.ok) {
            const call = toolCalls.find((t: any) => t.tool === 'write_knowledge');
            await appendJournal(taskId, plugin.name, {
              role: 'agent',
              kind: 'round',
              text: `沉淀知识: ${call?.title || r.id}（${r.category}${r.updated ? '，更新已有条目' : ''}）`,
              ts: new Date().toISOString(),
              node_id: node.id,
              node_name: node.name,
              model: entry.name,
              meta: { knowledge_id: r.id },
            });
            await emitProgress('knowledge_deposited', { task_id: taskId, node_id: node.id, agent: plugin.name, id: r.id, updated: r.updated });
          }
        }
        roundEntry.tool_results = results;
        record.rounds.push(roundEntry);
        await emitProgress('agent_round', { task_id: taskId, node_id: node.id, agent: plugin.name, model: entry.name, round: round + 1, tokens: resp.completionTokens, tool_calls: toolCalls });
        await appendJournal(taskId, plugin.name, { role: 'agent', kind: 'round', text: `请求读取工具: ${toolCalls.map((t: any) => t.tool + (t.path ? ':' + t.path : '')).join(', ')}`, ts: new Date().toISOString(), node_id: node.id, node_name: node.name, model: entry.name, tokens: resp.completionTokens });
        messages.push({ role: 'assistant', content });
        messages.push({ role: 'user', content: `工具执行结果：\n${JSON.stringify(results).slice(0, 8000)}\n\n请基于以上信息给出最终 JSON 结果。` });
        record.rounds.push({ user: '（工具执行结果已提供，见上一轮 tool_results）', tool_results: results });
        await appendJournal(taskId, plugin.name, { role: 'master', kind: 'tool_results', text: '', ts: new Date().toISOString(), node_id: node.id, node_name: node.name, meta: { results } });
      }

      if (parsed!.status !== 'success') {
        record.error = (parsed!.errors || []).join('; ') || parsed!.summary || 'agent reported failure';
        await appendJournal(taskId, plugin.name, { role: 'agent', kind: 'error', text: record.error, ts: new Date().toISOString(), node_id: node.id, node_name: node.name, model: entry.name, tokens: record.tokens });
        await emitProgress('agent_final', { task_id: taskId, node_id: node.id, agent: plugin.name, model: entry.name, ok: false, summary: record.error });
        return { status: 'failed', error: record.error, raw_output: content.slice(0, 2000), tokens: record.tokens };
      }

      let result: AgentResult = parsed as AgentResult;
      result = applyFinalOutput(workspace, result as Record<string, any>, this.policy) as AgentResult;
      result = plugin.handler.postRun ? plugin.handler.postRun(result) : result;
      delete (result as Record<string, any>).tool_calls;
      result.tokens = record.tokens;
      result.model = entry.name;

      // session continuity: remember this exchange for the agent's next node in this task
      await busSet(sessionKey, [...priorSession, { role: 'user', content: userMsg }, { role: 'assistant', content }].slice(-20));

      // war-room journal: agent's final report
      await appendJournal(taskId, plugin.name, {
        role: 'agent', kind: 'final',
        text: result.summary || '完成',
        ts: new Date().toISOString(), node_id: node.id, node_name: node.name,
        model: entry.name, tokens: record.tokens,
        meta: { changes: result.changes || [], errors: result.errors || [], files: (result.files || []).map((f) => f.path), commands: result.commands || [] },
      });
      await emitProgress('agent_final', { task_id: taskId, node_id: node.id, agent: plugin.name, model: entry.name, ok: true, summary: result.summary || '', changes: result.changes || [] });
      if ((result.files || []).length) {
        await emitProgress('agent_activity', { task_id: taskId, node_id: node.id, agent: plugin.name, text: `写入文件: ${(result.files || []).map((f) => f.path).join(', ')}`, model: entry.name });
      }
      return result;
    } finally {
      record.duration_sec = Math.round((Date.now() - startedAt) / 100) / 10;
      await saveConversation(taskId, node.id, record);
    }
  }

  /** Shrink a stored assistant turn so old sessions fit the context budget. */
  private compactAssistant(content: string): string {
    const parsed = extractJson(content);
    if (!parsed) return content.slice(0, 1500);
    return JSON.stringify({ status: parsed.status, summary: parsed.summary, changes: parsed.changes });
  }

  private async upstreamContext(taskId: string, node: TaskNode): Promise<string> {
    const graph = await getTaskGraph(taskId);
    if (!graph) return '';
    const nodeMap = new Map(graph.nodes.map((n) => [n.id, n]));
    const deps = graph.edges.filter(([, dst]) => dst === node.id).map(([src]) => src);
    const lines: string[] = [];
    for (const dep of deps) {
      const d = nodeMap.get(dep);
      if (d && d.status === 'completed' && d.result) {
        const changes = d.result.changes || [];
        lines.push(`- [${d.name}] ${d.result.summary || ''}` + (changes.length ? `（变更: ${changes.slice(0, 5).join(', ')}）` : ''));
      }
    }
    return lines.join('\n');
  }

  private async gitCommit(taskId: string, workspace: string, changes: string[]): Promise<{ branch: string; commit: string | null } | null> {
    if (!(await gitTool.isGitRepo(workspace))) return null;
    const branch = `coteam/task-${taskId}`;
    const branches = await simpleGit({ baseDir: workspace }).branchLocal().catch(() => null);
    if (!branches) return null;
    if (!branches.all.includes(branch)) {
      try { await simpleGit({ baseDir: workspace }).checkoutLocalBranch(branch); } catch { return null; }
    } else {
      try { await simpleGit({ baseDir: workspace }).checkout(branch); } catch { return null; }
    }
    const commit = await gitTool.commitOnBranch(workspace, `coteam: task ${taskId} auto-commit`, changes);
    return { branch, commit };
  }

  private async setNodeStatus(graph: TaskGraph, node: TaskNode, status: TaskStatus, error: string): Promise<void> {
    node.status = status;
    node.error = error;
    node.updated_at = new Date().toISOString();
    await persistGraph(graph);
    if (status === 'cancelled') {
      await emitProgress('node_cancelled', { task_id: graph.task_id, node_id: node.id, name: node.name });
    }
  }
}
