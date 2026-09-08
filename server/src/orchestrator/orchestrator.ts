import * as fs from 'node:fs';
import * as path from 'node:path';
import { generateTaskGraph, PlannedGraph } from './planner';
import type { ModelPool, ModelEntry } from '../scheduler';
import { Router, DEFAULT_RULES } from '../router';
import type { AgentPlugin, AgentTask } from '../agents';
import { createSandbox, cleanupSandbox, mergeChanges, policyWithLevel, executeCommandAsync, PermissionPolicy } from '../sandbox';
import { applyFinalOutput, applyToolCalls, listFiles } from '../tools';
import type { KnowledgeToolContext } from '../tools';
import { consumeAgentMessages, drainSystemMessages, flushUndelivered } from '../agentMessages';
import * as gitTool from '../git';
import { simpleGit } from 'simple-git';
import { saveConversation } from '../transcript';
import { notify } from '../notify';
import { chat, extractJson, salvageToolCalls, stripCodeFence } from '../llm';
import { busGet, busSet, busKeys, busDel } from '../bus';
import {
  addAgentMemory,
  addMemory,
  appendJournal,
  clearCancelled,
  consumeInterventions,
  emitProgress,
  getAgentMemory,
  getApprovals,
  getMemory,
  getTaskGraph,
  isCancelled,
  listTaskGraphs,
  persistGraph,
  recordAgentTask,
  saveNodeDiff,
  saveTaskGraph,
  getTaskGraph as loadGraph,
  getProject,
  getProjectMemory,
  addProjectMemory,
} from '../store';
import { TaskGraph, TaskNode, TaskStatus, TaskLevel, ClarifyMode, Complexity, AgentResult, AgentConversation, ProgressInfo } from '../types';
import { getLogger } from '../logger';
import { assessRequirement, isConfirmation, MAX_CLARIFY_ROUNDS, generateNodeBrief, type ClarificationAssessment, type ClarifyAnswer, type NodeBrief } from '../clarify';
import { gradeTask, normalizeLevel, LEVEL_PROFILES } from '../grader';
import { computeProgress, shouldBroadcast, clearProgressThrottle } from '../progress';
import { writeKnowledge, relevantKnowledge } from '../knowledge';
import { writeDoc, checkDocs, buildTaskSpec, buildStatusReport, buildApiContract, docsSection, getDocRegistry } from '../ssot';
import { findTestFailure, parseTestOutput, buildFixPrompt, isTestCommand, detectStackMismatch, MAX_FIX_ROUNDS, type ParsedTestOutput } from '../testloop';
import { createSnapshot } from '../snapshot';
import { buildAgentHarness, validateAgentResult, buildRepairMessage } from '../harness';
import { reloadSkills, getSkills, pickSkillsForNode, formatSkillsBlock } from '../skills';
import { saveDeliverable } from '../deliverable';
import { PROJECT_ROOT, DEFAULT_META_PATHS, type SelfModGateConfig } from '../config';
import { sampleTaskRun } from '../metrics';

/** persisted clarification-loop state (task:clarify:* bus key) */
export interface ClarifyLoopState {
  rounds: number;
  questions: string[];
  answers: ClarifyAnswer[];
  level: TaskLevel;
  main_model_id?: string;
  execution_policy?: { level?: string; whitelist_commands?: string[] };
  node_clarify?: ClarifyMode;
  assessment?: unknown;
  done?: boolean;
  confirmed_at?: string;
}

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
  /** how long dispatch waits for model capacity (cooldown expiry / slot release) before breaking the glass */
  modelWaitTimeoutSec?: number;
  /** global default for the per-node pre-execution clarification gate (feature: 实施前澄清) */
  nodeClarify?: ClarifyMode;
  /** global SKILL.md library dir (defaults to PROJECT_ROOT/skills) */
  skillsGlobalDir?: string;
  /** P0-1 self-modification gate config (defaults to enabled with DEFAULT_META_PATHS) */
  selfModGate?: SelfModGateConfig;
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
    model_id: base.model_id ? String(base.model_id) : undefined,
    clarify_mode: base.clarify_mode ?? undefined,
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

/** improvement #4 (B2 partial): doc attribution appended to an upstream node's handoff line. */
export function formatDocAttribution(docUpdates?: { type: string; version: number }[]): string {
  if (!docUpdates?.length) return '';
  return `；该节点更新了协同文档: ${docUpdates.map((u) => `docs/${u.type}.md (v${u.version})`).join(', ')}`;
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
  private modelWaitTimeoutMs: number;
  private nodeClarify: ClarifyMode;
  private agentsDir: string;
  private skillsGlobalDir: string;
  private selfModGate: SelfModGateConfig;
  private taskTokens = new Map<string, number>();
  private logger = getLogger();
  onProgress: ((type: string, payload: Record<string, unknown>) => void) | null = null;

  constructor(opts: OrchestratorOptions) {
    this.plugins = new Map();
    this.agentsDir = opts.agentsDir;
    this.skillsGlobalDir = opts.skillsGlobalDir || path.join(PROJECT_ROOT, 'skills');
    this.pool = opts.modelPool;
    this.policy = opts.policy;
    this.maxRetries = opts.maxRetries;
    this.sandboxEnabled = opts.sandboxEnabled;
    this.gitEnabled = opts.gitEnabled;
    this.branchWorkflow = opts.branchWorkflow ?? true;
    this.tokenBudget = opts.tokenBudget;
    this.maxFixRounds = opts.maxFixRounds ?? MAX_FIX_ROUNDS;
    this.modelWaitTimeoutMs = Math.max(0, (opts.modelWaitTimeoutSec ?? 120) * 1000);
    this.nodeClarify = opts.nodeClarify ?? 'off';
    this.selfModGate = opts.selfModGate || {
      enabled: true,
      test_command: 'npm test',
      meta_paths: DEFAULT_META_PATHS,
      timeout_sec: 600,
    };
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
    // skill system: rescan global library + every agent's private skills dir
    reloadSkills(this.agentsDir, this.skillsGlobalDir);
  }

  async reloadAgents(): Promise<string[]> {
    await this.loadAgents();
    return [...this.plugins.keys()];
  }

  /** E7: 服务重启会杀掉在途执行循环，发现的 running 任务背后已没有进程驱动，
   *  不清扫就永远僵尸。节点不可重入（沙箱/模型调用状态未知），不做自动续跑，
   *  诚实标记 failed 并留痕，已完成节点的成果保留。 */
  async sweepInterruptedTasks(): Promise<string[]> {
    const swept: string[] = [];
    for (const graph of await listTaskGraphs()) {
      if (graph.status !== 'running') continue;
      for (const node of graph.nodes) {
        if (node.status === 'running' || node.status === 'retrying' || node.status === 'waiting_approval') {
          node.status = 'failed';
          node.error = node.error || '服务重启导致执行中断';
          node.finished_at = new Date().toISOString();
        }
      }
      graph.status = 'failed';
      graph.updated_at = new Date().toISOString();
      await persistGraph(graph);
      await appendJournal(graph.task_id, 'orchestrator', {
        role: 'master', kind: 'error',
        text: '服务重启导致任务执行中断，已将任务标记为失败（节点不可安全续跑）。已完成节点的成果保留，可基于它们重新发起任务。',
        ts: new Date().toISOString(), node_id: '', node_name: '',
      });
      notify('task_interrupted', { task_id: graph.task_id, reason: 'server_restart' }, `[Co-Team] 任务 ${graph.task_id} 因服务重启被中断，已标记为失败`);
      this.logger.warn('Startup sweep marked interrupted task as failed', { taskId: graph.task_id });
      swept.push(graph.task_id);
    }
    return swept;
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
    opts?: { mainModelId?: string; level?: string; executionPolicy?: { level?: string; whitelist_commands?: string[] }; nodeClarify?: ClarifyMode; planAsync?: boolean; skipClarification?: boolean }
  ): Promise<{ taskId: string; graph: PlannedGraph; needsClarification?: boolean; questions?: string[]; summary?: string; level?: TaskLevel }> {
    this.logger.info('Creating task', { description, workspace, projectId, planAsync: opts?.planAsync === true });

    // improvement 7: task grading (explicit user level wins, otherwise auto-graded)
    const level: TaskLevel = normalizeLevel(opts?.level) ?? gradeTask(description);

    // improvement 11: main-agent model pinned at creation (manual selection, validated)
    let mainModelId = opts?.mainModelId?.trim() || undefined;
    if (mainModelId && this.pool && !this.pool.getModel(mainModelId)) {
      throw new Error(`model not in pool: ${mainModelId}`);
    }

    // plan_async (mobile): LLM assessment + planning run in the background so the HTTP
    // response returns immediately — phone browsers abort fetches around 60s ("Load failed"),
    // while model_wait_timeout_sec alone can hold a request for 120s+
    if (opts?.planAsync) {
      const taskId = Math.random().toString(36).slice(2, 10);
      await saveTaskGraph(taskId, [], [], {
        description,
        workspace,
        status: 'pending',
        project_id: projectId,
        level,
        main_model_id: mainModelId,
      });
      void this.assessThenPlan(taskId, description, workspace, projectId, {
        level,
        mainModelId,
        executionPolicy: opts?.executionPolicy,
        nodeClarify: opts?.nodeClarify,
        skipClarification: opts?.skipClarification,
      });
      return { taskId, graph: { nodes: [], edges: [], summary: '' } as PlannedGraph, level };
    }

    // improvement 5: requirement clarification loop — ambiguous requirements must be
    // resolved with the human before any planning/execution happens
    // staged feedback: the API request is synchronous and can take minutes on a slow
    // upstream — emit the current stage so the UI can show progress instead of a spinner
    await emitProgress('task_creating', { stage: 'assessing', description: description.slice(0, 80) });
    // A4 简单模式: explicit skip wins over the clarification loop
    const assessment = opts?.skipClarification ? ({ clear: true } as ClarificationAssessment) : await assessRequirement(description, this.pool);
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
        execution_policy: opts?.executionPolicy,
        node_clarify: opts?.nodeClarify,
      });
      const graph = { nodes: [], edges: [], summary: assessment.summary || '' } as PlannedGraph;
      await emitProgress('task_needs_clarification', { task_id: taskId, questions: assessment.questions, missing: assessment.missing });
      notify('task_needs_clarification', { task_id: taskId }, `[Co-Team] 任务 ${taskId} 需求不清晰，请回答澄清问题`);
      return { taskId, graph, needsClarification: true, questions: assessment.questions, summary: assessment.summary, level };
    }

    await emitProgress('task_creating', { stage: 'planning', task_id: taskId, description: description.slice(0, 80) });
    const planned = await this.planAndSave(taskId, description, workspace, projectId, {
      level,
      mainModelId,
      executionPolicy: opts?.executionPolicy,
      nodeClarify: opts?.nodeClarify,
    });
    return { taskId, graph: planned.graph, level: planned.level };
  }

  /** Generate + persist the plan for a (possibly clarified) requirement. */
  private async planAndSave(
    taskId: string,
    description: string,
    workspace: string,
    projectId: string | undefined,
    opts: { level: TaskLevel; mainModelId?: string; clarifyContext?: string; executionPolicy?: { level?: string; whitelist_commands?: string[] }; nodeClarify?: ClarifyMode }
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
      execution_policy: opts.executionPolicy?.level || opts.executionPolicy?.whitelist_commands ? { level: opts.executionPolicy!.level || 'approve_required', whitelist_commands: opts.executionPolicy!.whitelist_commands } : undefined,
      node_clarify: opts.nodeClarify,
    });
    return { graph: planned, level: opts.level };
  }

  /**
   * Clarification loop step (improvement 5): record human answers, re-assess, and only
   * proceed to planning on explicit confirmation, a clear re-assessment, or round limit.
   * plan_async (mobile): acknowledges immediately and finishes assessment/planning in the
   * background — the next round's questions arrive via the task_needs_clarification event.
   */
  async clarify(taskId: string, input: { answers?: { question: string; answer: string }[]; confirm?: boolean; text?: string; planAsync?: boolean }): Promise<{ status: string; questions?: string[]; graph?: PlannedGraph; summary?: string }> {
    const graph = await loadGraph(taskId);
    if (!graph) throw new Error('Task graph not found');
    if (graph.status !== 'clarifying') return { status: graph.status };

    const state = (await busGet<ClarifyLoopState>(`task:clarify:${taskId}`)) || {
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
    const planOpts = {
      level: state.level,
      mainModelId: state.main_model_id,
      clarifyContext: clarifiedContext || undefined,
      executionPolicy: state.execution_policy,
      nodeClarify: state.node_clarify,
    };

    // plan_async: no LLM work on the request path (mobile fetch dies at ~60s)
    if (input.planAsync) {
      if (explicitConfirm || state.rounds >= MAX_CLARIFY_ROUNDS) {
        await busSet(`task:clarify:${taskId}`, { ...state, done: true, confirmed_at: new Date().toISOString() });
        await this.setGraphStatus(taskId, 'pending');
        await emitProgress('task_clarified', { task_id: taskId, rounds: state.rounds, answers: state.answers.length });
        void this.planInBackground(taskId, graph.description, graph.workspace, graph.project_id, planOpts);
        return { status: 'pending' };
      }
      void this.assessNextRound(taskId, graph, state);
      return { status: 'assessing' };
    }

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
    const planned = await this.planAndSave(taskId, graph.description, graph.workspace, graph.project_id, planOpts);
    await busSet(`task:clarify:${taskId}`, { ...state, done: true, confirmed_at: new Date().toISOString() });
    await emitProgress('task_clarified', { task_id: taskId, rounds: state.rounds, answers: state.answers.length });
    this.logger.info('Requirement confirmed, plan generated', { taskId, rounds: state.rounds });
    return { status: 'planned', graph: planned.graph };
  }

  /** status-only graph update (plan_async background flow) */
  private async setGraphStatus(taskId: string, status: TaskStatus): Promise<void> {
    const g = await loadGraph(taskId);
    if (!g) return;
    g.status = status;
    await persistGraph(g);
  }

  /** plan_async background failure: park the task in `failed` so the UI never waits forever */
  private async failGraph(taskId: string, e: unknown): Promise<void> {
    this.logger.error('Background task flow failed', { taskId, error: String((e as any)?.message || e) });
    const g = await loadGraph(taskId);
    if (g && g.status !== 'cancelled') {
      g.status = 'failed';
      await persistGraph(g);
    }
    await emitProgress('task_plan_failed', { task_id: taskId, error: String((e as any)?.message || e) });
  }

  /** plan_async background: assess requirement → clarification loop setup or background planning */
  private async assessThenPlan(
    taskId: string,
    description: string,
    workspace: string,
    projectId: string | undefined,
    opts: { level: TaskLevel; mainModelId?: string; executionPolicy?: { level?: string; whitelist_commands?: string[] }; nodeClarify?: ClarifyMode; skipClarification?: boolean }
  ): Promise<void> {
    try {
      await emitProgress('task_creating', { stage: 'assessing', task_id: taskId, description: description.slice(0, 80) });
      if (await isCancelled(taskId)) return;
      const assessment = opts?.skipClarification ? ({ clear: true } as ClarificationAssessment) : await assessRequirement(description, this.pool);
      if (await isCancelled(taskId)) return;
      if (!assessment.clear) {
        this.logger.info('Requirement unclear, entering clarification loop', { taskId, missing: assessment.missing });
        await busSet(`task:clarify:${taskId}`, {
          rounds: 1,
          questions: assessment.questions,
          answers: [] as ClarifyAnswer[],
          assessment,
          level: opts.level,
          main_model_id: opts.mainModelId,
          execution_policy: opts.executionPolicy,
          node_clarify: opts.nodeClarify,
        });
        await this.setGraphStatus(taskId, 'clarifying');
        await emitProgress('task_needs_clarification', { task_id: taskId, questions: assessment.questions, missing: assessment.missing });
        notify('task_needs_clarification', { task_id: taskId }, `[Co-Team] 任务 ${taskId} 需求不清晰，请回答澄清问题`);
        return;
      }
      await this.planInBackground(taskId, description, workspace, projectId, opts);
    } catch (e) {
      await this.failGraph(taskId, e);
    }
  }

  /** plan_async background re-assessment: next clarification round or transition to planning */
  private async assessNextRound(taskId: string, graph: TaskGraph, state: ClarifyLoopState): Promise<void> {
    try {
      if (state.rounds < MAX_CLARIFY_ROUNDS) {
        const assessment = await assessRequirement(graph.description, this.pool, state.answers);
        if (await isCancelled(taskId)) return;
        if (!assessment.clear) {
          state.rounds += 1;
          state.questions = assessment.questions;
          await busSet(`task:clarify:${taskId}`, state);
          await emitProgress('task_needs_clarification', { task_id: taskId, round: state.rounds, questions: assessment.questions });
          return;
        }
      }
      // clear / max rounds reached → plan in the background
      await busSet(`task:clarify:${taskId}`, { ...state, done: true, confirmed_at: new Date().toISOString() });
      await this.setGraphStatus(taskId, 'pending');
      const clarifiedContext = state.answers.map((a, i) => `${i + 1}. ${a.question} → ${a.answer}`).join('\n');
      await emitProgress('task_clarified', { task_id: taskId, rounds: state.rounds, answers: state.answers.length });
      await this.planInBackground(taskId, graph.description, graph.workspace, graph.project_id, {
        level: state.level,
        mainModelId: state.main_model_id,
        clarifyContext: clarifiedContext || undefined,
        executionPolicy: state.execution_policy,
        nodeClarify: state.node_clarify,
      });
    } catch (e) {
      await this.failGraph(taskId, e);
    }
  }

  /** plan_async background wrapper: generate the plan off the request path, keep the graph status truthful */
  private async planInBackground(
    taskId: string,
    description: string,
    workspace: string,
    projectId: string | undefined,
    opts: { level: TaskLevel; mainModelId?: string; clarifyContext?: string; executionPolicy?: { level?: string; whitelist_commands?: string[] }; nodeClarify?: ClarifyMode }
  ): Promise<void> {
    try {
      if (await isCancelled(taskId)) return;
      await emitProgress('task_creating', { stage: 'planning', task_id: taskId, description: description.slice(0, 80) });
      await this.planAndSave(taskId, description, workspace, projectId, opts);
      this.logger.info('Background planning finished', { taskId });
    } catch (e) {
      await this.failGraph(taskId, e);
    }
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
      // A1 实时产出视图: remember where the work is happening so the API can browse it
      graph.sandbox_path = sandbox;
      await persistGraph(graph);
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

    // improvement 4: SSOT documents — the single source of truth for agent collaboration.
    // improvement 7: light-level tasks skip the doc pipeline entirely (LEVEL_PROFILES.docs)
    const levelProfile = LEVEL_PROFILES[graph.level ?? 'standard'];
    const docTarget = this.sandboxEnabled && sandbox !== workspace ? sandbox : undefined;
    if (levelProfile.docs) {
      try {
        await writeDoc(taskId, 'TASK_SPEC', buildTaskSpec(
          graph.description,
          `${levelProfile.label} (${graph.level ?? 'standard'})`,
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
    } else {
      this.logger.info('Light-level task: SSOT doc pipeline skipped', { taskId, level: graph.level });
    }

    // improvement 10: task-start snapshot (git ref + collaboration state)
    await createSnapshot(taskId, { tag: 'task-start', workspace, sandbox }).catch((e) => this.logger.warn('task-start snapshot failed', { taskId, error: String(e) }));
    await emitProgress('progress_update', { task_id: taskId, progress: computeProgress(graph) });

    // feature: 命令执行分级 — task-level policy overrides the global default
    const policy = policyWithLevel(this.policy, graph.execution_policy);

    let result: Record<string, any> = { status: 'failed', error: 'execution did not run' };
    try {
      result = await this.runGraph(taskId, graph, sandbox, policy);
    } catch (error) {
      this.logger.error('Task execution failed', { taskId, error: String(error) });
      result = { status: 'failed', error: `Execution failed: ${error}` };
    } finally {
      if (this.sandboxEnabled && sandbox !== workspace) {
        if (result?.status === 'success') {
          try {
            if (this.branchWorkflow && this.gitEnabled) {
              // merged result lives on the sandbox base branch; sync files to the real workspace.
              // a failed sync must NOT stay 'success' — the deliverables would stay trapped
              // in the sandbox and the user would never see them (observed in task gnq6h5p6)
              const synced = await gitTool.syncToWorkspace(sandbox, workspace, 'coteam/base');
              if (!synced) throw new Error('syncToWorkspace returned false (copy failed, e.g. a locked target file)');
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
        // recovery runs for genuinely failed/cancelled tasks AND for tasks whose
        // success-path sync just failed above — completed nodes must still be salvaged
        if (result?.status !== 'success') {
          // failure/cancel recovery: the completed nodes' work still lives only in the
          // sandbox — salvage it into the workspace instead of silently deleting it
          const completedNodes = graph.nodes.filter((n) => n.status === 'completed' && n.agent !== 'orchestrator').length;
          let recovered = false;
          if (completedNodes > 0) {
            try {
              let changes: string[] = [];
              if (this.branchWorkflow && this.gitEnabled && await gitTool.isGitRepo(sandbox)) {
                // drop the failed node's uncommitted partial edits (node branches chain their
                // ancestors, so nothing completed is lost), then merge every completed node
                // branch — parallel siblings are not reachable from HEAD alone
                await simpleGit({ baseDir: sandbox }).reset(['--hard', 'HEAD']).catch(() => {});
                const branches = graph.nodes
                  .filter((n) => n.agent !== 'orchestrator' && n.branch && n.status === 'completed')
                  .map((n) => n.branch as string);
                if (branches.length > 0) await gitTool.mergeAllNodes(sandbox, branches).catch(() => null);
                // syncToWorkspace (not mergeChanges): the sandbox here has its own .git,
                // which must never leak into the workspace repo
                await gitTool.syncToWorkspace(sandbox, workspace, 'coteam/base');
                const dirty = await simpleGit({ baseDir: workspace }).status();
                changes = dirty.files.map((f) => f.path);
              } else {
                changes = mergeChanges(sandbox, workspace);
              }
              if (changes.length > 0) {
                const commit = this.gitEnabled
                  ? await this.gitCommit(taskId, workspace, changes, `coteam: task ${taskId} partial recovery (${completedNodes} nodes, failed: ${String(result?.error || 'unknown').slice(0, 60)})`)
                  : null;
                result.merged_files = changes;
                result.recovered_partial = { nodes: completedNodes, files: changes.length, commit: commit?.commit ?? null };
                this.logger.warn('Recovered completed-node changes from non-success task', { taskId, status: result?.status, nodes: completedNodes, files: changes.length, commit: commit?.commit });
              }
              recovered = true;
            } catch (recoverError) {
              this.logger.error('Partial recovery failed — sandbox PRESERVED for manual recovery', { taskId, sandbox, error: String(recoverError) });
              result.sandbox_preserved = sandbox;
            }
          }
          if (recovered || completedNodes === 0) {
            try {
              cleanupSandbox(sandbox);
              this.logger.debug('Sandbox cleaned up', { taskId });
            } catch (cleanupError) {
              // cleanup failures (e.g. fs.rmSync EBUSY on Windows) must not swallow the final status write
              this.logger.warn('Sandbox cleanup failed (non-fatal)', { taskId, error: String(cleanupError) });
            }
          }
        }
      }
    }

    const status = String(result.status);
    // improvement #4 (C4): task terminal — report messages nobody consumed into the journal
    await flushUndelivered(taskId).catch(() => {});
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

    // P0-1/P0-2 measurement: append a daily sample for /api/metrics/trend
    await sampleTaskRun(graph, status).catch((e) => this.logger.warn('metrics sample failed', { taskId, error: String(e) }));

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
      const recoveredInfo = result.recovered_partial ? `（已完成 ${result.recovered_partial.nodes} 个节点的成果已回写工作区：${result.recovered_partial.files} 个文件）` : (result.sandbox_preserved ? `（沙箱已保留供人工恢复：${result.sandbox_preserved}）` : '');
      notify('task_failed', { task_id: taskId, error: result.error, recovered: result.recovered_partial || null }, `[Co-Team] 任务 ${taskId} 失败：${result.error}${recoveredInfo}`);
      await addMemory(`任务「${description}」失败于节点：${result.error}${recoveredInfo}。后续类似任务注意规避。`);
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

  private async runGraph(taskId: string, graph: TaskGraph, sandbox: string, policy: PermissionPolicy): Promise<Record<string, any>> {
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

      // improvement 4: document check before execution — agents must read the latest SSOT.
      // improvement 7: light-level tasks run without the doc pipeline, so no doc check either.
      if (LEVEL_PROFILES[graph.level ?? 'standard'].docs && this.sandboxEnabled && sandbox !== graph.workspace) {
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

      await Promise.all(runnable.map((node) => this.executeNode(taskId, graph, node, sandbox, maxWorkers, policy)));

      // improvement 4: keep STATUS_REPORT in sync after every execution wave
      // improvement 6: node transitions are milestones — broadcast progress (throttled)
      // improvement 7: light-level tasks skip the doc pipeline
      if (LEVEL_PROFILES[graph.level ?? 'standard'].docs) {
        try {
          const done = graph.nodes.filter((n) => n.status === 'completed' && n.agent !== 'orchestrator').map((n) => n.name);
          const runningNow = graph.nodes.filter((n) => n.status === 'running' || n.status === 'retrying').map((n) => n.name);
          const pendingNow = graph.nodes.filter((n) => n.status === 'pending').map((n) => n.name);
          const docTarget = this.sandboxEnabled && sandbox !== graph.workspace ? sandbox : undefined;
          await writeDoc(taskId, 'STATUS_REPORT', buildStatusReport(graph.description, done, runningNow, pendingNow), 'orchestrator', docTarget);
        } catch { /* best effort */ }
      }
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

    // guard: never report success while some nodes still wait on a human gate or run
    // (they are no longer 'pending', so the ready-loop above exits without touching them)
    const humanGate = graph.nodes.find((n) => n.status === 'waiting_clarify' || n.status === 'waiting_approval');
    if (humanGate || graph.nodes.some((n) => n.status === 'running' || n.status === 'retrying')) {
      return { status: humanGate?.status === 'waiting_clarify' ? 'waiting_clarify' : 'waiting_approval', changes: [] };
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

  // ---------- P0-1 self-modification gate & delivery consistency ----------

  /** Is this task pointing at the co-team codebase itself? */
  private isSelfRef(graph: TaskGraph): boolean {
    try {
      const ws = path.resolve(graph.workspace || '');
      return ws.toLowerCase() === PROJECT_ROOT.toLowerCase();
    } catch {
      return false;
    }
  }

  /** Normalize a reported change entry ("path: desc" / "path") into a repo-relative path. */
  private normalizeReportedPath(entry: string): string {
    return (entry || '').split(':')[0].trim().replace(/\\/g, '/').replace(/^\.\//, '').toLowerCase();
  }

  /** Repo-relative paths the agent claims to have touched (files[] + changes[]). */
  private reportedPaths(result: AgentResult): string[] {
    return [
      ...(result.files || []).map((f) => f.path),
      ...(result.changes || []),
    ].filter(Boolean);
  }

  /** First reported path that touches a meta facility, if any. */
  private metaHit(paths: string[], metaPaths: string[]): string | null {
    for (const raw of paths) {
      const rel = this.normalizeReportedPath(raw);
      if (!rel) continue;
      for (const mp of metaPaths) {
        const norm = mp.replace(/\\/g, '/').toLowerCase();
        if (rel === norm || rel.startsWith(norm) || rel.endsWith(norm)) return rel;
      }
    }
    return null;
  }

  /**
   * The sandbox copy skips node_modules — a self-test inside it would fail on
   * missing deps. Link the workspace's node_modules in (junction: no admin rights).
   */
  private ensureDepsLink(workspace: string, sandbox: string): void {
    try {
      const wsNm = path.join(workspace, 'node_modules');
      const sbNm = path.join(sandbox, 'node_modules');
      if (!fs.existsSync(sbNm) && fs.existsSync(wsNm)) fs.symlinkSync(wsNm, sbNm, 'junction');
    } catch { /* best effort */ }
  }

  /** Run the configured self-test command in the sandbox; parse + journal the result. */
  private async runGateTest(taskId: string, node: TaskNode, graph: TaskGraph, sandbox: string): Promise<{ passed: boolean; returncode: number; parsed: ParsedTestOutput } | null> {
    const gate = this.selfModGate;
    this.ensureDepsLink(graph.workspace, sandbox);
    const res = await executeCommandAsync(gate.test_command, sandbox, this.policy, gate.timeout_sec ?? 600);
    const output = `${res.stderr || ''}\n${res.stdout || ''}`.trim();
    const parsed = parseTestOutput(output);
    const passed = res.returncode === 0;
    this.logger.info('Self-modification gate test', { taskId, nodeId: node.id, command: gate.test_command, returncode: res.returncode, passed });
    await appendJournal(taskId, node.agent, {
      role: 'master',
      kind: passed ? 'round' : 'error',
      text: `自修改门禁：${gate.test_command} ${passed ? '通过' : `失败（returncode=${res.returncode}）`}${parsed.summary ? ' · ' + parsed.summary : ''}`,
      ts: new Date().toISOString(),
      node_id: node.id,
      node_name: node.name,
      meta: { command: gate.test_command, failures: parsed.failures },
    });
    await emitProgress('gate_test', { task_id: taskId, node_id: node.id, passed, command: gate.test_command, summary: parsed.summary, failures: parsed.failures.length });
    return { passed, returncode: res.returncode, parsed };
  }

  /**
   * P0-1 self-modification gate applied to a successful node result:
   *  (a) the repo's own test suite must pass — failure loops into the fix cycle
   *      ('retry') or fails the node ('fail') instead of accepting a broken system;
   *  (b) meta-facility edits are held for human approval ('waiting') unless the
   *      node has already been approved for this task.
   * Mutates `result` / `node` and returns the action the caller must take.
   */
  private async enforceSelfModGate(
    taskId: string,
    graph: TaskGraph,
    node: TaskNode,
    plugin: AgentPlugin,
    sandbox: string,
    result: AgentResult,
    fixRound: number,
    allowFix: boolean
  ): Promise<{ action: 'pass' | 'retry' | 'fail' | 'waiting'; fixPrompt?: string }> {
    if (!this.selfModGate.enabled || !this.isSelfRef(graph)) return { action: 'pass' };

    const gateTest = await this.runGateTest(taskId, node, graph, sandbox);
    if (gateTest) {
      result.gate_test = {
        command: this.selfModGate.test_command,
        returncode: gateTest.returncode,
        passed: gateTest.passed,
        summary: gateTest.parsed.summary || undefined,
      };
      if (!gateTest.passed) {
        if (allowFix && fixRound < this.maxFixRounds) {
          await appendJournal(taskId, plugin.name, {
            role: 'master',
            kind: 'error',
            text: `自修改门禁未通过，进入测试修复循环（第 ${fixRound + 1}/${this.maxFixRounds} 轮）：${gateTest.parsed.summary}`,
            ts: new Date().toISOString(),
            node_id: node.id,
            node_name: node.name,
            meta: { failures: gateTest.parsed.failures },
          });
          return { action: 'retry', fixPrompt: buildFixPrompt(gateTest.parsed, this.selfModGate.test_command, fixRound + 1, this.maxFixRounds) };
        }
        result.status = 'failed';
        result.error = `自修改门禁：${this.selfModGate.test_command} ${fixRound} 轮修复后仍未通过: ${gateTest.parsed.summary}`;
        result.report = {
          framework: this.selfModGate.test_command,
          attempts: Math.max(1, fixRound),
          failures: gateTest.parsed.failures.map((f) => ({ name: f.name, message: f.message })),
          summary: `自修改门禁 ${Math.max(1, fixRound)} 轮后仍有 ${gateTest.parsed.failures.length} 个用例失败：${gateTest.parsed.summary}`,
        };
        await appendJournal(taskId, plugin.name, {
          role: 'master',
          kind: 'error',
          text: result.error,
          ts: new Date().toISOString(),
          node_id: node.id,
          node_name: node.name,
          meta: { failures: gateTest.parsed.failures },
        });
        return { action: 'fail' };
      }
    }

    const touched = this.metaHit(this.reportedPaths(result), this.selfModGate.meta_paths);
    if (!touched) return { action: 'pass' };

    const approvals = await getApprovals(taskId);
    if (approvals.includes(node.id)) return { action: 'pass' };

    node.requires_approval = true;
    node.status = 'waiting_approval';
    node.updated_at = new Date().toISOString();
    node.result = result;
    await persistGraph(graph);
    await appendJournal(taskId, plugin.name, {
      role: 'master',
      kind: 'brief',
      text: `自修改门禁：节点改动触及元设施「${touched}」，已挂起等待人工审批`,
      ts: new Date().toISOString(),
      node_id: node.id,
      node_name: node.name,
      meta: { meta_path: touched },
    });
    await emitProgress('node_waiting_approval', { task_id: taskId, node_id: node.id, name: node.name, reason: 'meta-facility change', meta_path: touched });
    notify('approval_required', { task_id: taskId, node_id: node.id, reason: 'meta-facility change' }, `[Co-Team] 自修改门禁：节点「${node.name}」改动触及元设施（${touched}），等待人工审批`);
    return { action: 'waiting' };
  }

  /**
   * Quality metric: compare the agent's reported change paths against the actual
   * git working-tree diff in the sandbox. Flags both unreported real changes and
   * phantom claims (reported files that do not exist) — the "fake completion" detector.
   */
  private async recordDeliveryCheck(graph: TaskGraph, node: TaskNode, sandbox: string, result: AgentResult): Promise<void> {
    try {
      if (!this.gitEnabled || !this.sandboxEnabled || sandbox === graph.workspace) return;
      const looksLikePath = (p: string) => /[/\\]/.test(p) || /\.[a-z0-9]{1,6}$/i.test(p);
      const reported = this.reportedPaths(result).map((p) => this.normalizeReportedPath(p)).filter(Boolean);
      const repSet = new Set(reported);

      const status = await simpleGit({ baseDir: sandbox }).status();
      const actual = [...status.modified, ...status.created, ...status.not_added, ...status.renamed.map((r) => r.to), ...status.deleted]
        .map((p) => p.replace(/\\/g, '/').replace(/^\.\//, '').toLowerCase())
        .filter(Boolean);

      const covered = (actualPath: string) => [...repSet].some((r) => r === actualPath || actualPath.endsWith('/' + r) || r.endsWith('/' + actualPath));
      const unreported = actual.filter((a) => !covered(a));

      const phantom: string[] = [];
      for (const rep of new Set(reported)) {
        if (!looksLikePath(rep)) continue;
        if (![...actual].some((a) => a === rep || rep.endsWith('/' + a) || a.endsWith('/' + rep)) && !fs.existsSync(path.join(sandbox, rep))) {
          phantom.push(rep);
        }
      }

      result.delivery_check = {
        consistent: unreported.length === 0 && phantom.length === 0,
        reported_count: repSet.size,
        actual_count: actual.length,
        unreported: unreported.slice(0, 10),
        phantom: phantom.slice(0, 10),
      };
      if (!result.delivery_check.consistent) {
        this.logger.warn('Delivery consistency check flagged mismatches', {
          taskId: graph.task_id, nodeId: node.id, unreported: unreported.length, phantom: phantom.length,
        });
      }
    } catch (e) {
      this.logger.debug?.('delivery check skipped', { taskId: graph.task_id, nodeId: node.id, error: String(e) });
    }
  }

  // ---------- single node ----------

  /** Safety wrapper: a node must ALWAYS land on a terminal status, even if the inner pipeline throws. */
  private async executeNode(taskId: string, graph: TaskGraph, node: TaskNode, sandbox: string, workers: number, policy: PermissionPolicy): Promise<void> {
    try {
      await this.executeNodeInner(taskId, graph, node, sandbox, workers, policy);
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

  private async executeNodeInner(taskId: string, graph: TaskGraph, node: TaskNode, sandbox: string, _workers: number, policy: PermissionPolicy): Promise<void> {
    this.logger.nodeStart(taskId, node.id, node.agent, node.name);
    
    node.status = 'running';
    node.started_at = new Date().toISOString();
    node.updated_at = node.started_at;
    await persistGraph(graph);
    await emitProgress('node_start', { task_id: taskId, node_id: node.id, name: node.name, agent: node.agent, branch: node.branch });

    // improvement #4 (C4): surface deferred messages addressed to the orchestrator / the
    // user before this node runs — best-effort, never blocks execution
    try {
      const drained = await drainSystemMessages(taskId);
      for (const m of drained.orchestrator) {
        await appendJournal(taskId, m.from, {
          role: 'master', kind: 'message',
          text: `给主 Agent 留言：${m.text}`,
          ts: new Date().toISOString(), node_id: m.node_id || '', node_name: m.node_name || '',
          meta: { to: 'orchestrator', text: m.text },
        });
      }
      for (const m of drained.user) {
        await appendJournal(taskId, m.from, {
          role: 'agent', kind: 'message',
          text: `给用户留言：${m.text}`,
          ts: new Date().toISOString(), node_id: m.node_id || '', node_name: m.node_name || '',
          meta: { to: 'user', text: m.text },
        });
        notify('agent_user_message', { task_id: taskId, node_id: m.node_id }, `[Co-Team] ${m.from} 给你留言：${m.text.slice(0, 80)}`);
      }
    } catch { /* messaging is best-effort */ }

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

    // feature: 实施前澄清门 — brief/confirm 模式下节点首次执行前先给用户一份实施简报，
    // 用户确认（或补充答复）后节点才会真正开始实施
    const clarifyMode = node.clarify_mode || graph.node_clarify || this.nodeClarify;
    const alreadyClarified = await busGet(`task:node:clarified:${taskId}:${node.id}`);
    if (clarifyMode && clarifyMode !== 'off' && !alreadyClarified) {
      const brief = await generateNodeBrief({
        taskDescription: graph.description || '',
        nodeName: node.name,
        nodeReason: node.reason,
        goal: (await busGet<{ content: string }>(`task:goal:${taskId}`))?.content || '',
        upstream: await this.upstreamContext(taskId, node),
      }, this.pool);
      await busSet(`task:node:clarify:${taskId}:${node.id}`, { mode: clarifyMode, brief, ts: new Date().toISOString(), answers: [] as ClarifyAnswer[] });
      node.status = 'waiting_clarify';
      await persistGraph(graph);
      await appendJournal(taskId, plugin.name, {
        role: 'master',
        kind: 'brief',
        text: `实施前澄清（${clarifyMode === 'confirm' ? '需用户确认' : '实施简报'}）：\n${brief.approach}` +
          (brief.files.length ? `\n预计改动: ${brief.files.join(', ')}` : '') +
          (brief.risks.length ? `\n风险: ${brief.risks.join('; ')}` : '') +
          (brief.questions.length ? `\n待确认问题:\n${brief.questions.map((q, i) => `${i + 1}. ${q}`).join('\n')}` : ''),
        ts: new Date().toISOString(),
        node_id: node.id,
        node_name: node.name,
        meta: { brief },
      });
      await emitProgress('node_awaiting_clarify', { task_id: taskId, node_id: node.id, name: node.name, agent: node.agent, mode: clarifyMode, brief });
      notify('node_awaiting_clarify', { task_id: taskId, node_id: node.id }, `[Co-Team] 节点「${node.name}」等待实施前澄清，请查看简报并确认`);
      return;
    }

    // branch workflow: each agent works on its own branch off its dependencies
    const useBranch = this.branchWorkflow && this.gitEnabled && this.sandboxEnabled;
    if (useBranch) {
      const parent = this.parentBranchFor(graph, node);
      const branch = `coteam/${node.id}-${node.agent}`;
      const ok = await gitTool.createNodeBranch(sandbox, branch, parent).catch(() => false);
      node.branch = ok ? branch : '';
      // 记录切出分支，节点完成后以此计算该节点的代码变更（diff 基准）
      node.branch_base = ok ? parent : '';
      await persistGraph(graph);
      await emitProgress('node_branch_created', { task_id: taskId, node_id: node.id, branch: node.branch, parent });
    }

    let error = '';
    let fixRound = 0;
    // E8: consecutive fix rounds whose failed test output yields zero parseable cases
    let noInfoRounds = 0;
    // R9: survives past the loop so the terminal node.result carries the fix-loop report
    // even after the escalation attempt overwrites the intermediate result
    let fixReport: AgentResult['report'] = undefined;
    // gate evidence from the last gated attempt survives the escalation dispatch
    let lastGateTest: AgentResult['gate_test'] = undefined;
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
      const result = await this.dispatch(taskId, node, plugin, sandbox, false, error, `第 ${attempt + 1} 次尝试`, undefined, policy);
      if (result.status === 'success') {
        // improvement 8: test-fix loop — a failing test command blocks the commit and
        // triggers a targeted repair round instead of accepting broken code
        const testFail = findTestFailure(result.command_results);
        if (testFail && fixRound < this.maxFixRounds) {
          const parsed = parseTestOutput(testFail.output);
          // E9: a wrong-stack test run (pytest inside a Node workspace) never exercises
          // the project code — its "failures" are noise; escalate instead of repairing.
          if (detectStackMismatch(testFail.command, graph.workspace)) {
            result.status = 'failed';
            result.error = `测试命令与项目技术栈不匹配：Node 项目（package.json）不应执行「${testFail.command}」，请使用项目对应的测试器（vitest/jest/node --test）`;
            result.errors = [...(result.errors || []), result.error];
            result.report = { framework: 'unknown', attempts: fixRound, failures: [], summary: result.error };
            fixReport = result.report;
            error = result.error;
            await appendJournal(taskId, plugin.name, {
              role: 'master', kind: 'error', text: result.error, ts: new Date().toISOString(),
              node_id: node.id, node_name: node.name, meta: { command: testFail.command },
            });
            break;
          }
          // E8: rc≠0 with zero parseable cases means the run itself is broken (command
          // crashed / nothing collected) — feed the raw output; two such rounds in a row
          // means the test setup is broken, stop burning repair rounds.
          const noCaseInfo = parsed.failures.length === 0;
          if (noCaseInfo) noInfoRounds += 1; else noInfoRounds = 0;
          if (noCaseInfo && noInfoRounds >= 2) {
            result.status = 'failed';
            result.error = `测试命令连续 ${noInfoRounds} 轮失败且解析不出任何失败用例（${testFail.command}），测试环境/命令可能已损坏`;
            result.errors = [...(result.errors || []), result.error];
            result.report = { framework: parsed.framework, attempts: fixRound + 1, failures: [], summary: result.error };
            fixReport = result.report;
            error = result.error;
            await appendJournal(taskId, plugin.name, {
              role: 'master', kind: 'error', text: result.error, ts: new Date().toISOString(),
              node_id: node.id, node_name: node.name, meta: { command: testFail.command, output: testFail.output.slice(-1500) },
            });
            break;
          }
          fixRound += 1;
          error = buildFixPrompt(parsed, testFail.command, fixRound, this.maxFixRounds, noCaseInfo ? testFail.output : undefined);
          node.status = 'retrying';
          node.retry_count = attempt + 1;
          await persistGraph(graph);
          await appendJournal(taskId, plugin.name, {
            role: 'master',
            kind: 'error',
            text: `测试修复循环 第 ${fixRound}/${this.maxFixRounds} 轮：${parsed.summary}。失败用例: ${parsed.failures.map((f) => f.name).slice(0, 5).join(', ') || (noCaseInfo ? '（无可解析用例，已附原始输出）' : '（未解析出具体用例）')}`,
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
          // improvement 8 (R9): structured report with the full failure detail
          result.report = {
            framework: testFail.command,
            attempts: this.maxFixRounds,
            failures: parsed.failures.map((f) => ({ name: f.name, message: f.message })),
            summary: `修复 ${this.maxFixRounds} 轮后仍有 ${parsed.failures.length} 个用例失败：${parsed.summary}`,
          };
          fixReport = result.report;
          error = result.error;
          await appendJournal(taskId, plugin.name, {
            role: 'master',
            kind: 'error',
            text: result.error,
            ts: new Date().toISOString(),
            node_id: node.id,
            node_name: node.name,
            meta: { failures: parsed.failures, report: result.report },
          });
          break;
        }
        // P0-1 self-modification gate: mandatory self-test + meta-facility approval
        // (only active when the task's workspace IS the co-team codebase)
        const gate = await this.enforceSelfModGate(taskId, graph, node, plugin, sandbox, result, fixRound, true);
        if (gate.action === 'waiting') return;
        if (gate.action === 'retry') {
          fixRound += 1;
          error = gate.fixPrompt || '';
          node.status = 'retrying';
          node.retry_count = attempt + 1;
          await persistGraph(graph);
          await emitProgress('test_fix_round', { task_id: taskId, node_id: node.id, round: fixRound, max: this.maxFixRounds, summary: '自修改门禁测试未通过，进入修复循环' });
          continue;
        }
        if (gate.action === 'fail') {
          fixReport = result.report;
          lastGateTest = result.gate_test;
          error = result.error || '';
          break;
        }

        // quality metric: reported changes vs the actual working tree (before the commit)
        await this.recordDeliveryCheck(graph, node, sandbox, result);

        this.logger.nodeComplete(taskId, node.id, node.agent);

        // improvement 8 (R9): a test-fix loop that ends green reports its rounds + zero failures
        if (fixRound > 0) {
          result.report = {
            framework: '',
            attempts: fixRound,
            failures: [],
            summary: `测试修复循环 ${fixRound} 轮后全部通过`,
          };
        }
        await this.finalizeNodeSuccess(taskId, graph, node, result, useBranch, sandbox, false);
        return;
      }
      error = result.error || 'unknown error';
      if (error.toLowerCase().includes('token budget')) break;
      // B4/E2: content refusals (missing info / needs human) won't heal through more
      // retries or a strategy change — surface for human intervention immediately.
      if (/需要人类|需要人工|需要补充|信息不足|素材不足|无法完成|缺少.{0,6}(信息|权限)|cannot proceed|need human/i.test(error)) {
        node.status = 'failed';
        node.finished_at = new Date().toISOString();
        node.error = `需人工介入：${error}`;
        node.result = { status: 'failed', error: node.error, summary: '节点因需要人工补充信息而停止，未产出变更' };
        node.needs_human = true;
        await saveDeliverable(taskId, node).catch(() => {});
        await persistGraph(graph);
        await this.recordAgentLife(taskId, graph, node, false, 0);
        await emitProgress('node_error', { task_id: taskId, node_id: node.id, name: node.name, agent: node.agent, error: node.error });
        notify('node_needs_human', { task_id: taskId, node_id: node.id }, `[Co-Team] 节点「${node.name}」需要人工补充信息，已暂停自动重试：${error.slice(0, 80)}`);
        return;
      }
    }

    // escalation: main agent takes over with an adjusted strategy
    await emitProgress('node_escalate', { task_id: taskId, node_id: node.id, name: node.name, error });
    const result = await this.dispatch(taskId, node, plugin, sandbox, true, error, '主 Agent 接管', undefined, policy);
    if (result.status === 'success') {
      // P0-1: the takeover result faces the same gate (no fix rounds left at this point)
      const gate = await this.enforceSelfModGate(taskId, graph, node, plugin, sandbox, result, this.maxFixRounds, false);
      if (gate.action === 'waiting') return;
      if (gate.action === 'fail') {
        fixReport = result.report || fixReport;
        lastGateTest = result.gate_test || lastGateTest;
        error = result.error || error;
      }
      if (result.status === 'success') {
        await this.recordDeliveryCheck(graph, node, sandbox, result);
        await this.finalizeNodeSuccess(taskId, graph, node, result, useBranch, sandbox, true);
        return;
      }
      // gate failed the takeover result — fall through to the failure handling below
    }

    // 主 Agent 兜底（feature: 降级策略优化）：接管也失败且败因是模型不可用时，
    // 用任务主模型或任意剩余容量执行最后一次——主 Agent 永远在线，不应因模型池空转而弃疗
    let finalResult = result;
    if (this.pool && /no available model|all models failed/i.test(result.error || error)) {
      const mainEntry = (graph.main_model_id ? this.pool.getModel(graph.main_model_id) : null) || this.pool.emergencyCandidates()[0] || null;
      if (mainEntry) {
        this.logger.warn('Main-agent fallback takeover', { taskId, nodeId: node.id, model: mainEntry.name });
        await appendJournal(taskId, plugin.name, {
          role: 'master',
          kind: 'brief',
          text: `主 Agent 兜底接管：常规调度与降级链均不可用，改用模型「${mainEntry.name}」执行本节点`,
          ts: new Date().toISOString(),
          node_id: node.id,
          node_name: node.name,
        });
        await emitProgress('node_main_takeover', { task_id: taskId, node_id: node.id, name: node.name, model: mainEntry.name });
        finalResult = await this.dispatch(taskId, node, plugin, sandbox, true, error, '主 Agent 兜底', mainEntry, policy);
        if (finalResult.status === 'success') {
          await this.finalizeNodeSuccess(taskId, graph, node, finalResult, useBranch, sandbox, true);
          return;
        }
      }
    }

    node.status = 'failed';
    node.finished_at = new Date().toISOString();
    node.error = finalResult.error || error;
    node.result = {
      ...finalResult,
      ...(lastGateTest ? { gate_test: lastGateTest } : {}),
      ...(fixReport ? { report: fixReport } : {}),
    };
    node.needs_human = true;
    await saveDeliverable(taskId, node).catch(() => {});

    this.logger.nodeFailed(taskId, node.id, node.agent, node.error);

    await persistGraph(graph);
    await this.recordAgentLife(taskId, graph, node, false, finalResult.tokens || 0);
    await emitProgress('node_error', { task_id: taskId, node_id: node.id, name: node.name, agent: node.agent, error: node.error });
    notify('node_needs_human', { task_id: taskId, node_id: node.id }, `[Co-Team] 节点「${node.name}」重试与接管均失败，需要人工介入`);
  }

  /** Shared success tail: persist result, commit branch, capture diff, bookkeeping.
   *  approve_required 策略下暂存的命令在节点完成的同时登记到任务级待审批队列。 */
  private async finalizeNodeSuccess(taskId: string, graph: TaskGraph, node: TaskNode, result: AgentResult, useBranch: boolean, sandbox: string, escalated: boolean): Promise<void> {
    node.status = 'completed';
    node.finished_at = new Date().toISOString();
    node.result = escalated ? { ...result, escalated: true } : result;
    node.error = '';
    const pendingCommands = ((result as Record<string, any>).pending_commands || []) as string[];
    if (pendingCommands.length) await this.registerPendingCommands(taskId, node, pendingCommands);
    await saveDeliverable(taskId, node).catch(() => {});
    if (useBranch && node.branch) {
      const commit = await gitTool.commitOnBranch(sandbox, `coteam: ${node.name}${escalated ? ' (escalated)' : ''}`, result.changes || []).catch(() => null);
      if (commit && node.result) (node.result as AgentResult).git_commit = { branch: node.branch, commit };
    }
    await this.captureNodeDiff(taskId, node, sandbox);
    await persistGraph(graph);
    await this.recordAgentLife(taskId, graph, node, true, result.tokens || 0);
    await emitProgress('node_complete', {
      task_id: taskId,
      node_id: node.id,
      name: node.name,
      agent: node.agent,
      branch: node.branch,
      changes: result.changes || [],
      summary: (result.summary || '') + (escalated ? '（主 Agent 接管后完成）' : ''),
      ...(pendingCommands.length ? { pending_commands: pendingCommands.length } : {}),
    });
  }

  /** feature: 命令执行分级 — 登记 approve_required 策略下等待人工审批的命令。 */
  private async registerPendingCommands(taskId: string, node: TaskNode, commands: string[]): Promise<void> {
    const key = `task:pending_commands:${taskId}`;
    const queue = (await busGet<{ id: string; node_id: string; node_name: string; command: string; ts: string }[]>(key)) || [];
    for (const command of commands) {
      queue.push({ id: Math.random().toString(36).slice(2, 10), node_id: node.id, node_name: node.name, command, ts: new Date().toISOString() });
    }
    await busSet(key, queue);
    await emitProgress('command_pending_approval', { task_id: taskId, node_id: node.id, node_name: node.name, commands });
    notify('command_pending_approval', { task_id: taskId, node_id: node.id }, `[Co-Team] 任务 ${taskId} 有 ${commands.length} 条命令等待审批（执行策略 approve_required）`);
  }

  /** feature: 命令执行分级 — 用户批准/拒绝一条待审批命令；批准后在任务工作区执行并留痕。 */
  async resolvePendingCommand(taskId: string, commandId: string, approved: boolean): Promise<{ ok: boolean; returncode?: number }> {
    const graph = await loadGraph(taskId);
    if (!graph) throw new Error('Task graph not found');
    const key = `task:pending_commands:${taskId}`;
    const queue = (await busGet<{ id: string; node_id: string; node_name: string; command: string; ts: string }[]>(key)) || [];
    const idx = queue.findIndex((q) => q.id === commandId);
    if (idx === -1) throw new Error('pending command not found');
    const [item] = queue.splice(idx, 1);
    await busSet(key, queue);

    if (!approved) {
      await appendJournal(taskId, 'orchestrator', {
        role: 'master',
        kind: 'error',
        text: `命令已拒绝（未执行）：${item.command}`,
        ts: new Date().toISOString(),
        node_id: item.node_id,
        node_name: item.node_name,
      });
      await emitProgress('command_resolved', { task_id: taskId, command_id: item.id, approved: false, command: item.command });
      return { ok: true };
    }

    const policy = policyWithLevel(this.policy, graph.execution_policy);
    const result = await executeCommandAsync(item.command, graph.workspace || '.', policy);
    await appendJournal(taskId, 'orchestrator', {
      role: 'master',
      kind: 'tool_results',
      text: `已批准执行：${item.command}\n退出码 ${result.returncode}` +
        (result.stdout ? `\nstdout: ${result.stdout.slice(-800)}` : '') +
        (result.stderr ? `\nstderr: ${result.stderr.slice(-400)}` : ''),
      ts: new Date().toISOString(),
      node_id: item.node_id,
      node_name: item.node_name,
      meta: { command: item.command, returncode: result.returncode },
    });
    await emitProgress('command_resolved', { task_id: taskId, command_id: item.id, approved: true, command: item.command, returncode: result.returncode });
    return { ok: true, returncode: result.returncode };
  }

  /** feature: 实施前澄清 — 记录用户对节点简报的确认/答复，节点回到待执行状态。 */
  async clarifyNode(taskId: string, nodeId: string, input: { approve?: boolean; answers?: { question: string; answer: string }[]; text?: string }): Promise<{ status: string }> {
    const graph = await loadGraph(taskId);
    if (!graph) throw new Error('Task graph not found');
    const node = graph.nodes.find((n) => n.id === nodeId);
    if (!node) throw new Error('node not found');
    if (node.status !== 'waiting_clarify') return { status: node.status };

    const key = `task:node:clarify:${taskId}:${nodeId}`;
    const state = (await busGet<{ mode: ClarifyMode; brief: NodeBrief; answers: ClarifyAnswer[] }>(key)) || {
      mode: 'brief' as ClarifyMode,
      brief: { approach: '', files: [], risks: [], questions: [] } as NodeBrief,
      answers: [] as ClarifyAnswer[],
    };
    for (const a of input.answers || []) {
      if (a.answer?.trim()) state.answers.push({ question: a.question || '', answer: a.answer.trim() });
    }
    if (input.text?.trim()) state.answers.push({ question: '(补充说明)', answer: input.text.trim() });
    await busSet(key, state);
    await busSet(`task:node:clarified:${taskId}:${nodeId}`, true);

    const answered = state.answers.map((a) => `- ${a.question} → ${a.answer}`).join('\n');
    await appendJournal(taskId, 'orchestrator', {
      role: 'master',
      kind: 'intervene',
      text: `节点「${node.name}」澄清确认：${input.approve === true ? '用户确认按简报执行' : '用户补充了说明后继续'}${answered ? `\n${answered}` : ''}`,
      ts: new Date().toISOString(),
      node_id: node.id,
      node_name: node.name,
    });
    await emitProgress('node_clarified', { task_id: taskId, node_id: node.id, name: node.name, approved: input.approve === true });

    node.status = 'pending';
    await persistGraph(graph);
    return { status: 'pending' };
  }

  /** Agent life: update its persistent profile and write a lesson to its memory. */  private async recordAgentLife(taskId: string, graph: TaskGraph, node: TaskNode, success: boolean, tokens: number): Promise<void> {
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

  /** 节点完成后立即固化其分支 diff（含测试修复轮提交），供作战室随时查看，不依赖沙箱存活。 */
  private async captureNodeDiff(taskId: string, node: TaskNode, sandbox: string): Promise<void> {
    if (!node.branch || !node.branch_base) return;
    try {
      const diff = await gitTool.nodeDiff(sandbox, node.branch, node.branch_base);
      if (diff) await saveNodeDiff(taskId, node.id, diff);
    } catch (e) {
      this.logger.warn('captureNodeDiff failed', { taskId, nodeId: node.id, error: String(e) });
    }
  }

  /** 人工补差：在指定节点之后插入一个节点，继承其全部出边（含到合并节点的边）。 */
  async addNode(taskId: string, opts: { name: string; agent: string; afterNodeId: string }): Promise<TaskNode> {
    const graph = await getTaskGraph(taskId);
    if (!graph) throw new Error('task not found');
    if (!['planned', 'pending', 'queued'].includes(graph.status)) {
      throw new Error('仅在计划待审核/待执行状态可插入节点；执行中的任务请用重新规划');
    }
    if (!opts.name?.trim()) throw new Error('节点名称不能为空');
    const after = graph.nodes.find((n) => n.id === opts.afterNodeId);
    if (!after || after.id === 'merge-auto') throw new Error('锚点节点不存在');
    if (opts.agent === 'orchestrator' || !this.plugins.has(opts.agent)) {
      throw new Error(`Agent ${opts.agent} 不存在`);
    }
    const node: TaskNode = {
      id: `n-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 5)}`,
      task_id: taskId,
      name: opts.name.trim(),
      status: 'pending',
      agent: opts.agent,
      result: null,
      error: '',
      retry_count: 0,
      complexity: 'normal',
      requires_approval: false,
      needs_human: false,
      reason: '人工插入节点',
      branch: '',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    // reroute：after 的每条出边 s→d 改为 s→new + new→d（merge-auto 边也随之自然衔接）
    const outgoing = graph.edges.filter(([src]) => src === after.id);
    graph.edges = graph.edges.filter(([src]) => src !== after.id);
    graph.edges.push([after.id, node.id]);
    for (const [, dst] of outgoing) graph.edges.push([node.id, dst]);
    graph.nodes.push(node);
    await persistGraph(graph);
    await emitProgress('node_added', { task_id: taskId, node_id: node.id, name: node.name, agent: node.agent, after: after.id });
    return node;
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

  /**
   * Primary-model resolution (features: 每步骤可用不同 LLM / 降级策略优化):
   * node pin → agent model_override → dynamic selection; on empty selection wait for
   * capacity, then break the cooldown glass. A node must not fail while any model
   * could still run it.
   */
  private async resolvePrimary(taskId: string, node: TaskNode, plugin: AgentPlugin): Promise<ModelEntry | null> {
    if (!this.pool) return null;
    const nodePin = node.model_id ? this.pool.getModel(node.model_id) : null;
    if (node.model_id && !nodePin) {
      this.logger.warn('Node-pinned model not in pool, falling back', { taskId, nodeId: node.id, model: node.model_id });
    }
    if (plugin.modelOverride && !this.pool.getModel(plugin.modelOverride)) {
      this.logger.warn('Agent model_override not in pool, falling back to dynamic selection', { taskId, nodeId: node.id, agent: plugin.name, model: plugin.modelOverride });
    }
    let primary = nodePin || (plugin.modelOverride ? this.pool.getModel(plugin.modelOverride) : null);
    if (!primary) primary = this.pool.selectModel(plugin.tags, node.complexity);
    if (!primary) primary = await this.waitForModel(taskId, plugin.tags, node.complexity);
    if (!primary) {
      primary = this.pool.emergencyCandidates()[0] || null;
      if (primary) {
        this.logger.warn('All healthy models exhausted — breaking cooldown glass', { taskId, nodeId: node.id, model: primary.name, failCount: primary.failCount });
      }
    }
    return primary;
  }

  /** Poll for model capacity (cooldown expiry / slot release) instead of failing immediately. */
  private async waitForModel(taskId: string, tags: string[], complexity: Complexity): Promise<ModelEntry | null> {
    if (!this.pool || this.modelWaitTimeoutMs <= 0) return null;
    const deadline = Date.now() + this.modelWaitTimeoutMs;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 2000));
      if (await isCancelled(taskId)) return null;
      const m = this.pool.selectModel(tags, complexity);
      if (m) {
        this.logger.info('Model became available after wait', { taskId, model: m.name, waitedMs: this.modelWaitTimeoutMs - (deadline - Date.now()) });
        return m;
      }
    }
    return null;
  }

  private async dispatch(
    taskId: string,
    node: TaskNode,
    plugin: AgentPlugin,
    workspace: string,
    escalate: boolean,
    lastError: string,
    attemptLabel: string,
    forceEntry?: ModelEntry,
    policy: PermissionPolicy = this.policy
  ): Promise<AgentResult> {
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

    let chain: ModelEntry[];
    if (forceEntry) {
      chain = [forceEntry];
    } else {
      const primary = await this.resolvePrimary(taskId, node, plugin);
      if (!primary) {
        this.logger.error('No model available even after wait & emergency bypass', { taskId, nodeId: node.id, agent: plugin.name });
        return { status: 'failed', error: 'No available model' };
      }
      chain = this.pool.fallbackChain(primary, plugin.tags);
    }

    this.logger.agentDispatch(taskId, node.id, plugin.name, chain[0].name);
    let lastErr = '';
    let triedCount = 0;
    // content failures (parse/schema/refusal) are usually not model-specific: retry the
    // SAME model once with the failure text as feedback before burning the fallback chain
    const CONTENT_FAIL_RE = /parse|schema violation|not valid JSON|failed to produce final output/i;
    const sameModelRetries = new Map<string, number>();
    for (let ci = 0; ci < chain.length; ci++) {
      const entry = chain[ci];
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
        const result = await this.callAgent(taskId, node, plugin, entry, workspace, escalate, lastErr || lastError, attemptLabel, policy);
        if (result.status === 'success') {
          this.pool.markSuccess(entry);
          this.logger.agentResponse(taskId, node.id, plugin.name, result.tokens || 0);
          if (triedCount > 1) this.logger.info('Model degraded successfully', { taskId, nodeId: node.id, agent: plugin.name, tried: triedCount, finalModel: entry.name });
          return result;
        }
        // Failed result (content-level: parse/schema/refusal) — do NOT poison model health;
        // retry the same model once with feedback, then move down the chain
        lastErr = result.error || 'agent reported failure';
        this.logger.warn('Model returned failure, trying next', { taskId, nodeId: node.id, agent: plugin.name, model: entry.name, error: lastErr });
        const retried = sameModelRetries.get(entry.name) ?? 0;
        if (CONTENT_FAIL_RE.test(lastErr) && retried < 1) {
          sameModelRetries.set(entry.name, retried + 1);
          ci--;
          continue;
        }
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
        // infra-level failure (network/5xx/crash) — count against model health
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
    attemptLabel: string,
    policy: PermissionPolicy = this.policy
  ): Promise<AgentResult> {
    const context = await this.upstreamContext(taskId, node);
    // B3a/B3b: recon rounds and visible file list scale with node complexity —
    // complex nodes get more tool rounds and a wider view of the workspace.
    const maxRounds = node.complexity === 'complex' ? 8 : node.complexity === 'simple' ? 3 : 5;
    const workspaceFiles = listFiles(workspace, node.complexity === 'complex' ? 200 : node.complexity === 'simple' ? 50 : 100).join(', ');
    const maxTokens = entry.max_tokens ?? 128000;

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
    const knowledgeHits = await relevantKnowledge(`${node.name} ${context}`, { project_id: projectId, limit: 3 });
    const knowledgeBlock = knowledgeHits.length
      ? '\n\n## 相关知识库条目\n' + knowledgeHits.map((k) => `- 【${k.title}】${k.content.slice(0, 200)}`).join('\n')
      : '';

    // harness (执行骨架): layered system prompt replacing the flat block concatenation —
    // identity / non-negotiable rules / context / workflow / tool policy / output contract / escalation
    // skill system: bound + auto-matched skills ride inside the harness context block
    const picks = pickSkillsForNode(getSkills(), plugin as any, node.name);
    const skillsBlock = formatSkillsBlock(picks);
    if (picks.length) {
      this.logger.info('Skills loaded for node', { taskId, nodeId: node.id, agent: plugin.name, skills: picks.map((p) => `${p.skill.name}(${p.reason})`) });
    }
    const systemMsg = buildAgentHarness({
      name: plugin.name,
      role: plugin.role,
      description: plugin.description,
      prompt: plugin.prompt || '你是开发 Agent。',
      projectBlock,
      goalBlock: goalBlock ? goalBlock.replace(/^\n\n/, '') : '',
      docsBlock: docsBlock ? docsBlock.replace(/^\n\n/, '') : '',
      knowledgeBlock: knowledgeBlock ? knowledgeBlock.replace(/^\n\n## 相关知识库条目\n/, '') : '',
      memories,
      skillsBlock,
      round: 0,
      maxRounds,
      escalate,
      lastError,
    });

    // improvement 6 (R1): message-style intervention — pending user messages are
    // consumed right before the userMsg is built and injected as a must-respond block
    const interventions = await consumeInterventions(taskId);
    const interveneBlock = interventions.length
      ? `\n\n## 用户介入指示（必须响应，并在汇报中说明如何落实）\n${interventions.map((m, i) => `${i + 1}. ${m.message}`).join('\n')}`
      : '';

    // improvement #4 (C4): deferred agent-to-agent messages consumed here so the
    // recipient answers them in this dispatch (mirrors the interventions contract)
    const agentMessages = await consumeAgentMessages(taskId, plugin.name);
    const agentMessageBlock = agentMessages.length
      ? `\n\n## 来自其他 Agent 的留言（必须响应，并在汇报中说明如何落实）\n${agentMessages.map((m, i) => `${i + 1}. [${m.from}] ${m.text}`).join('\n')}`
      : '';

    // feature: 实施前澄清 — 用户确认过的简报与答复作为强制上下文注入
    const nodeClarifyState = await busGet<{ brief: NodeBrief; answers: ClarifyAnswer[] }>(`task:node:clarify:${taskId}:${node.id}`);
    const clarifyBlock = nodeClarifyState
      ? '\n\n## 实施前澄清（用户已确认，必须按此执行）' +
        (nodeClarifyState.brief?.approach ? `\n实施思路: ${nodeClarifyState.brief.approach}` : '') +
        (nodeClarifyState.brief?.files?.length ? `\n预计改动: ${nodeClarifyState.brief.files.join(', ')}` : '') +
        (nodeClarifyState.answers?.length ? `\n用户答复:\n${nodeClarifyState.answers.map((a) => `- ${a.question} → ${a.answer}`).join('\n')}` : '')
      : '';

    const userMsg = [
      `工作目录: ${workspace}`,
      `现有文件: ${workspaceFiles}`,
      `任务: ${node.name}`,
      node.goal_link ? `对全局目标的贡献: ${node.goal_link}` : '',
      `节点复杂度: ${node.complexity}`,
      context ? `前置节点成果:\n${context}\n` : '',
      clarifyBlock,
      escalationBlock,
      fixContextBlock,
      interveneBlock,
      agentMessageBlock,
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
    // war-room journal: trace which interventions were injected into this node
    if (interventions.length) {
      await appendJournal(taskId, plugin.name, {
        role: 'master',
        kind: 'intervene',
        text: `介入消息已注入节点 ${node.name}（${interventions.length} 条，Agent 将在本轮响应）`,
        ts: new Date().toISOString(),
        node_id: node.id,
        node_name: node.name,
        meta: { interventions: interventions.map((m) => m.message) },
      });
      this.logger.info('User interventions injected into agent round', { taskId, nodeId: node.id, agent: plugin.name, count: interventions.length });
    }
    await emitProgress('agent_activity', { task_id: taskId, node_id: node.id, agent: plugin.name, text: '接收任务简报', model: entry.name });

    try {
      let parsed: Record<string, any> | null = null;
      let content = '';
      let parseErrorLogged = false;
      // improvement #4: SSOT docs this agent updated via write_doc during this dispatch
      const docUpdates: { type: string; version: number }[] = [];
      for (let round = 0; round < maxRounds; round++) {
        // Check for cancellation before each LLM call
        if (await isCancelled(taskId)) {
          return { status: 'failed', error: 'task cancelled', tokens: record.tokens };
        }
        await emitProgress('agent_activity', {
          task_id: taskId, node_id: node.id, agent: plugin.name,
          text: `第 ${round + 1} 轮对话中…`, model: entry.name,
        });
        const resp = await chat(entry, messages, maxTokens, escalate ? 0.3 : 0, undefined, plugin.timeout ? plugin.timeout * 1000 : undefined);
        this.pool!.recordUsage(entry.name, resp.promptTokens, resp.completionTokens);
        this.taskTokens.set(taskId, (this.taskTokens.get(taskId) || 0) + resp.promptTokens + resp.completionTokens);
        record.tokens += resp.promptTokens + resp.completionTokens;
        content = stripCodeFence(resp.content);
        // E5: empty content with finish_reason=length means the reasoning burned the
        // whole output budget — not a format problem. Skip the format-repair round and
        // fail over (the budget won't grow by re-prompting the same model).
        if (!content.trim() && resp.finishReason === 'length') {
          record.error = `输出预算耗尽（finish_reason=length）：思考消耗了全部 ${maxTokens} 输出 token，正文为空`;
          await appendJournal(taskId, plugin.name, { role: 'agent', kind: 'error', text: record.error, ts: new Date().toISOString(), node_id: node.id, node_name: node.name, model: entry.name, tokens: resp.completionTokens });
          await emitProgress('agent_final', { task_id: taskId, node_id: node.id, agent: plugin.name, model: entry.name, ok: false, summary: record.error });
          return { status: 'failed', error: record.error, tokens: record.tokens };
        }
        parsed = extractJson(content);
        // malformed tool-call JSON (nested/unclosed tool_calls) is recoverable:
        // pull out the individual {"tool":...} fragments and run them as a normal tool round
        if (!parsed) {
          const salvaged = salvageToolCalls(content);
          if (salvaged.length > 0) {
            parsed = { tool_calls: salvaged };
            this.logger.info('Salvaged tool calls from malformed output', { taskId, nodeId: node.id, agent: plugin.name, model: entry.name, count: salvaged.length });
          }
        }
        const roundEntry: Record<string, any> = { assistant: content, tool_results: null, parse_error: null };
        if (!parsed) {
          // If this is the last round and the model returned substantial text,
          // treat it as a successful analysis result (wrap as JSON)
          if (round >= maxRounds - 1 && content.trim().length > 20) {
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
            // war room chat gets one concise line per attempt (not one blob per round);
            // the raw output is kept as a short single-line excerpt for debugging
            if (!parseErrorLogged) {
              parseErrorLogged = true;
              const excerpt = content.replace(/\s+/g, ' ').trim().slice(0, 200);
              await appendJournal(taskId, plugin.name, { role: 'agent', kind: 'error', text: `第 ${round + 1} 轮输出不是有效 JSON，已要求按格式重新输出`, ts: new Date().toISOString(), node_id: node.id, node_name: node.name, model: entry.name, tokens: resp.completionTokens, meta: { raw: excerpt } });
            }
            await emitProgress('agent_round', { task_id: taskId, node_id: node.id, agent: plugin.name, model: entry.name, round: round + 1, tokens: resp.completionTokens, parse_error: true });
            // If this was the last round, return failure
            if (round >= maxRounds - 1) {
              record.error = 'failed to parse agent output as JSON';
              return { status: 'failed', error: record.error, raw_output: content.slice(0, 2000), tokens: record.tokens };
            }
            // Otherwise, inject correction message and retry
            messages.push({ role: 'assistant', content });
            // E5⑤: keep this example identical to the harness L6 contract (verification included),
            // otherwise the repaired JSON passes parse but fails the schema gate next round.
            messages.push({ role: 'user', content: '你返回的内容无法解析为 JSON。请严格按照以下格式输出（不要包含任何 markdown 或额外文字）：\n{"status":"success|failed","changes":[],"summary":"你的分析或结果","verification":"验证方式与结果","errors":[],"files":[],"commands":[]}' });
            continue;
          }
        }
        const toolCalls = parsed.tool_calls || [];
        if (toolCalls.length === 0) {
          // harness schema gate: the final JSON must satisfy the output contract;
          // violations feed a surgical repair round instead of vague retries
          const check = validateAgentResult(parsed);
          if (!check.ok) {
            roundEntry.parse_error = 'schema violations: ' + check.violations.join('; ');
            record.rounds.push(roundEntry);
            if (!parseErrorLogged) {
              parseErrorLogged = true;
              await appendJournal(taskId, plugin.name, { role: 'agent', kind: 'error', text: `第 ${round + 1} 轮输出违反契约：${check.violations.slice(0, 3).join('；')}，已要求修正`, ts: new Date().toISOString(), node_id: node.id, node_name: node.name, model: entry.name });
            }
            await emitProgress('agent_round', { task_id: taskId, node_id: node.id, agent: plugin.name, model: entry.name, round: round + 1, tokens: resp.completionTokens, parse_error: true });
            if (round >= maxRounds - 1) {
              record.error = 'result schema violations: ' + check.violations.join('; ');
              return { status: 'failed', error: record.error, raw_output: content.slice(0, 2000), tokens: record.tokens };
            }
            messages.push({ role: 'assistant', content });
            messages.push({ role: 'user', content: buildRepairMessage(check.violations) });
            continue;
          }
          record.rounds.push(roundEntry);
          await emitProgress('agent_round', { task_id: taskId, node_id: node.id, agent: plugin.name, model: entry.name, round: round + 1, tokens: resp.completionTokens });
          break;
        }
        // If this is the last round and model still requests tools, force final output
        if (round >= maxRounds - 1) {
          messages.push({ role: 'assistant', content });
          messages.push({ role: 'user', content: '工具调用已达上限。请立即基于已有信息输出最终 JSON 结果，不要再请求工具。格式：\n{"status":"success|failed","changes":[],"summary":"分析结果","verification":"验证方式与结果","errors":[],"files":[],"commands":[]}' });
          // Do one more round to get final output
          const finalResp = await chat(entry, messages, maxTokens, escalate ? 0.3 : 0, undefined, plugin.timeout ? plugin.timeout * 1000 : undefined);
          this.pool!.recordUsage(entry.name, finalResp.promptTokens, finalResp.completionTokens);
          this.taskTokens.set(taskId, (this.taskTokens.get(taskId) || 0) + finalResp.promptTokens + finalResp.completionTokens);
          record.tokens += finalResp.promptTokens + finalResp.completionTokens;
          content = stripCodeFence(finalResp.content);
          parsed = extractJson(content);
          if (parsed && !parsed.tool_calls) {
            // last-resort output still goes through the schema gate; with no repair
            // rounds left, violations become a precise failure instead of a fake success
            const check = validateAgentResult(parsed);
            if (!check.ok) {
              record.error = 'result schema violations: ' + check.violations.join('; ');
              return { status: 'failed', error: record.error, raw_output: content.slice(0, 2000), tokens: record.tokens };
            }
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
        const knowledgeCtx: KnowledgeToolContext = {
          agent: plugin.name,
          task_id: taskId,
          project_id: projectId || undefined,
          sandboxDir: workspace,
          availableAgents: [...this.router.getAvailable().keys()],
          node_id: node.id,
          node_name: node.name,
        };
        const results = await applyToolCalls(workspace, toolCalls, knowledgeCtx);
        // improvement 3: agent-driven knowledge deposits are audited in the war room;
        // improvement #4: doc updates and agent messages likewise
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
          } else if (r?.tool === 'write_doc' && r.ok) {
            docUpdates.push({ type: r.type, version: r.version });
            const call = toolCalls.find((t: any) => t.tool === 'write_doc' && String(t.type || '').toUpperCase() === r.type);
            await appendJournal(taskId, plugin.name, {
              role: 'agent',
              kind: 'doc',
              text: `更新协同文档 docs/${r.type}.md → v${r.version}`,
              ts: new Date().toISOString(),
              node_id: node.id,
              node_name: node.name,
              model: entry.name,
              meta: { doc_type: r.type, version: r.version, content: String(call?.content || '').slice(0, 16384) },
            });
            await emitProgress('agent_message', { task_id: taskId, node_id: node.id, agent: plugin.name, kind: 'doc', doc_type: r.type, version: r.version });
          } else if (r?.tool === 'send_message' && r.ok) {
            const call = toolCalls.find((t: any) => t.tool === 'send_message' && t.to === r.to);
            await appendJournal(taskId, plugin.name, {
              role: 'agent',
              kind: 'message',
              text: `给 ${r.to} 留言：${String(call?.text || '').slice(0, 500)}`,
              ts: new Date().toISOString(),
              node_id: node.id,
              node_name: node.name,
              meta: { to: r.to, text: call?.text },
            });
            await emitProgress('agent_message', { task_id: taskId, node_id: node.id, agent: plugin.name, kind: 'message', to: r.to });
          }
        }
        roundEntry.tool_results = results;
        record.rounds.push(roundEntry);
        await emitProgress('agent_round', { task_id: taskId, node_id: node.id, agent: plugin.name, model: entry.name, round: round + 1, tokens: resp.completionTokens, tool_calls: toolCalls });
        await appendJournal(taskId, plugin.name, { role: 'agent', kind: 'round', text: `请求读取工具: ${toolCalls.map((t: any) => t.tool + (t.path ? ':' + t.path : '')).join(', ')}`, ts: new Date().toISOString(), node_id: node.id, node_name: node.name, model: entry.name, tokens: resp.completionTokens });
        messages.push({ role: 'assistant', content });
        messages.push({ role: 'user', content: `工具执行结果：\n${JSON.stringify(results).slice(0, 8000)}\n\n请基于以上信息给出最终 JSON 结果。（第 ${round + 1}/${maxRounds} 轮完成，剩余 ${maxRounds - 1 - round} 轮——规划好是否还需要侦查）` });
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
      result = applyFinalOutput(workspace, result as Record<string, any>, policy) as AgentResult;
      result = plugin.handler.postRun ? plugin.handler.postRun(result) : result;
      delete (result as Record<string, any>).tool_calls;
      result.tokens = record.tokens;
      result.model = entry.name;
      if (docUpdates.length) result.doc_updates = docUpdates;

      // session continuity: remember this exchange for the agent's next node in this task
      await busSet(sessionKey, [...priorSession, { role: 'user', content: userMsg }, { role: 'assistant', content }].slice(-20));

      // war-room journal: agent's final report
      await appendJournal(taskId, plugin.name, {
        role: 'agent', kind: 'final',
        text: result.summary || '完成',
        ts: new Date().toISOString(), node_id: node.id, node_name: node.name,
        model: entry.name, tokens: record.tokens,
        meta: { changes: result.changes || [], errors: result.errors || [], files: (result.files || []).map((f) => f.path), commands: result.commands || [], verification: (result as any).verification || '' },
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
        lines.push(`- [${d.name}] ${d.result.summary || ''}` + (changes.length ? `（变更: ${changes.slice(0, 5).join(', ')}）` : '') + formatDocAttribution(d.result.doc_updates));
      }
    }
    return lines.join('\n');
  }

  private async gitCommit(taskId: string, workspace: string, changes: string[], message?: string): Promise<{ branch: string; commit: string | null } | null> {
    if (!(await gitTool.isGitRepo(workspace))) return null;
    const branch = `coteam/task-${taskId}`;
    const branches = await simpleGit({ baseDir: workspace }).branchLocal().catch(() => null);
    if (!branches) return null;
    if (!branches.all.includes(branch)) {
      try { await simpleGit({ baseDir: workspace }).checkoutLocalBranch(branch); } catch { return null; }
    } else {
      try { await simpleGit({ baseDir: workspace }).checkout(branch); } catch { return null; }
    }
    const commit = await gitTool.commitOnBranch(workspace, message || `coteam: task ${taskId} auto-commit`, changes);
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
