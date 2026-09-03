import * as path from 'node:path';
import { generateTaskGraph, PlannedGraph } from './planner';
import type { ModelPool, ModelEntry } from '../scheduler';
import { Router, DEFAULT_RULES } from '../router';
import type { AgentPlugin, AgentTask } from '../agents';
import { createSandbox, cleanupSandbox, mergeChanges, PermissionPolicy } from '../sandbox';
import { applyFinalOutput, applyToolCalls, listFiles } from '../tools';
import * as gitTool from '../git';
import { simpleGit } from 'simple-git';
import { saveConversation } from '../transcript';
import { notify } from '../notify';
import { chat, extractJson, stripCodeFence } from '../llm';
import { busGet, busSet } from '../bus';
import {
  addAgentMemory,
  addMemory,
  appendJournal,
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
} from '../store';
import { TaskGraph, TaskNode, TaskStatus, AgentResult, AgentConversation } from '../types';

export interface OrchestratorOptions {
  agentsDir: string;
  modelPool: ModelPool | null;
  policy: PermissionPolicy;
  maxRetries: number;
  sandboxEnabled: boolean;
  gitEnabled: boolean;
  branchWorkflow?: boolean;
  tokenBudget?: number;
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
  private agentsDir: string;
  private taskTokens = new Map<string, number>();
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
    this.router = new Router([], DEFAULT_RULES, this.makeLlmRouter());
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

  async createTask(description: string, workspace: string): Promise<{ taskId: string; graph: PlannedGraph }> {
    const planned = appendMergeNode(stripMergeNodes(await this.plan(description)));
    const taskId = Math.random().toString(36).slice(2, 10);
    const nodes = planned.nodes.map((n) => newNode(n, taskId));
    // plans wait for user review: status stays "planned" until explicitly executed
    await saveTaskGraph(taskId, nodes, planned.edges, { description, workspace, status: 'planned' });
    return { taskId, graph: planned };
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

    const planned = appendMergeNode(stripMergeNodes(await generateTaskGraph(graph.description, this.pool, this.router, { previousPlan, feedbacks })));
    const nodes = planned.nodes.map((n) => {
      const existing = graph.nodes.find((old) => old.id === String(n.id) && old.status === 'completed');
      return existing ? existing : newNode(n, taskId);
    });
    graph.nodes = nodes;
    graph.edges = planned.edges.map(([a, b]) => [a, b] as [string, string]);
    graph.status = 'planned';
    await persistGraph(graph);
    await emitProgress('task_replanned', { task_id: taskId, feedback, summary: planned.summary });
    return planned;
  }

  async execute(taskId: string, workspace: string): Promise<Record<string, any>> {
    const graph = await loadGraph(taskId);
    if (!graph) return { status: 'error', message: 'Task graph not found' };

    // reset non-completed nodes so re-runs (after approval) resume cleanly
    for (const node of graph.nodes) {
      if (node.status !== 'completed' && node.status !== 'cancelled') node.status = 'pending';
    }
    graph.workspace = workspace;
    graph.status = 'running';
    await persistGraph(graph);
    await emitProgress('execute_start', { task_id: taskId, workspace, total_nodes: graph.nodes.length });

    const sandbox = this.sandboxEnabled ? createSandbox(workspace) : workspace;
    if (this.branchWorkflow && this.gitEnabled) {
      // baseline snapshot: all agent branches start from here
      await gitTool.ensureBase(sandbox).catch(() => {});
    }
    let result: Record<string, any> = { status: 'failed', error: 'execution did not run' };
    try {
      result = await this.runGraph(taskId, graph, sandbox);
    } finally {
      if (this.sandboxEnabled && sandbox !== workspace) {
        if (result?.status === 'success') {
          if (this.branchWorkflow && this.gitEnabled) {
            // merged result lives on the sandbox base branch; sync files to the real workspace
            await gitTool.syncToWorkspace(sandbox, workspace, 'coteam/base');
            result.merged_branches = result.merged_branches || [];
          } else {
            result.merged_files = mergeChanges(sandbox, workspace);
          }
        }
        cleanupSandbox(sandbox);
      }
    }

    const status = String(result.status);
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

      await Promise.all(runnable.map((node) => this.executeNode(taskId, graph, node, sandbox, maxWorkers)));

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

    const completed = graph.nodes.filter((n) => n.status === 'completed');
    if (completed.length === 0 && graph.nodes.some((n) => n.status === 'waiting_approval')) {
      return { status: 'waiting_approval', changes: [] };
    }
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

  private async executeNode(taskId: string, graph: TaskGraph, node: TaskNode, sandbox: string, _workers: number): Promise<void> {
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
    for (let attempt = 0; attempt < Math.max(1, this.maxRetries); attempt++) {
      if (attempt > 0) {
        node.status = 'retrying';
        node.retry_count = attempt;
        await persistGraph(graph);
        await emitProgress('node_retry', { task_id: taskId, node_id: node.id, attempt: attempt + 1 });
      }
      const result = await this.dispatch(taskId, node, plugin, sandbox, false, '', `第 ${attempt + 1} 次尝试`);
      if (result.status === 'success') {
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
    await this.checkBudget(taskId);
    if (!this.pool) return { status: 'failed', error: 'No available model' };

    const primary = this.pool.selectModel(plugin.tags, node.complexity);
    if (!primary) return { status: 'failed', error: 'No available model' };

    const chain = this.pool.fallbackChain(primary, plugin.tags);
    let lastErr = '';
    for (const entry of chain) {
      const acquired = await this.acquireWithWait(entry);
      if (!acquired) continue;
      try {
        const result = await this.callAgent(taskId, node, plugin, entry, workspace, escalate, lastError, attemptLabel);
        this.pool.markSuccess(entry);
        return result;
      } catch (e: any) {
        if (String(e?.message).includes('token budget')) {
          return { status: 'failed', error: 'token budget exceeded for this task' };
        }
        lastErr = String(e).slice(0, 500);
        this.pool.markFailure(entry);
      } finally {
        this.pool.release(entry);
      }
    }
    return { status: 'failed', error: `all models failed: ${lastErr || 'unknown'}` };
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

    // per-agent life: cross-task lessons ride along in the system prompt
    const memories = await getAgentMemory(plugin.name, 5);

    const systemMsg = [
      plugin.prompt || '你是开发 Agent。',
      memories.length ? '\n\n## 你过往的经验记忆\n' + memories.map((m) => '- ' + m).join('\n') : '',
      '\n你可以请求读取工具（返回 JSON 时附带 tool_calls 字段）:',
      ' {"tool_calls":[{"tool":"list_files"}]} 或 {"tool_calls":[{"tool":"read_file","path":"xxx"}]}',
      '\n最终输出必须是 JSON（不要 markdown 代码块）：',
      '{"status":"success|failed","changes":["file: desc"],"summary":"摘要","errors":[],',
      '"files":[{"path":"相对路径","content":"完整文件内容"}],"commands":["要执行的命令"]}',
      '\nfiles 中给出需要创建或修改的文件的完整内容；commands 会在沙箱中执行（仅限白名单命令）。',
    ].join('\n');

    const userMsg = [
      `工作目录: ${workspace}`,
      `现有文件: ${workspaceFiles}`,
      `任务: ${node.name}`,
      `节点复杂度: ${node.complexity}`,
      context ? `前置节点成果:\n${context}\n` : '',
      escalationBlock,
    ].join('\n');

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
          roundEntry.parse_error = 'output was not valid JSON';
          record.rounds.push(roundEntry);
          record.error = 'failed to parse agent output as JSON';
          await appendJournal(taskId, plugin.name, { role: 'agent', kind: 'error', text: '输出无法解析为 JSON', ts: new Date().toISOString(), node_id: node.id, node_name: node.name, model: entry.name, tokens: resp.completionTokens, meta: { raw: content.slice(0, 1500) } });
          await emitProgress('agent_round', { task_id: taskId, node_id: node.id, agent: plugin.name, model: entry.name, round: round + 1, tokens: resp.completionTokens, parse_error: true });
          return { status: 'failed', error: record.error, raw_output: content.slice(0, 2000), tokens: record.tokens };
        }
        const toolCalls = parsed.tool_calls || [];
        if (toolCalls.length === 0) {
          record.rounds.push(roundEntry);
          await emitProgress('agent_round', { task_id: taskId, node_id: node.id, agent: plugin.name, model: entry.name, round: round + 1, tokens: resp.completionTokens });
          break;
        }
        await emitProgress('agent_activity', {
          task_id: taskId, node_id: node.id, agent: plugin.name,
          text: '请求读取工具: ' + toolCalls.map((t: any) => t.tool + (t.path ? ':' + t.path : '')).join(', '),
          model: entry.name,
        });
        const results = applyToolCalls(workspace, toolCalls);
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
