import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { generateTaskGraph, generateStagePlan, PlannedGraph } from './planner';
import type { ChecklistItem } from '../types';
import type { ModelPool, ModelEntry } from '../scheduler';
import { Router, DEFAULT_RULES } from '../router';
import type { AgentPlugin, AgentTask } from '../agents';
import { createSandbox, cleanupSandbox, mergeChanges, policyWithLevel, executeCommandAsync, PermissionPolicy } from '../sandbox';
import { runPostMergeAcceptance, runChecklistAudit, detectProjectProfile } from './acceptance';
import { applyFinalOutput, applyToolCalls, renderWorkspaceTree, estimateTokens, gitDiffFull, listTestAssets } from '../tools';
import type { AskBridge, KnowledgeToolContext } from '../tools';
import type { McpManager } from '../mcp/manager';
import { analyzeImages, type VisionBridge } from '../vision';
import { cancelAsks, consumeAskQueue, createAsk, flushAgentAsks, queueAskForAgent, resolveAsk, waitForAnswer, abandonAsk, settleTaskPendingAsks } from '../askGate';
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
  pushIntervention,
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
import { writeKnowledge, relevantKnowledge, recordKnowledgeHits, isSafeForInjection, KNOWLEDGE_DATA_TAG_OPEN, KNOWLEDGE_DATA_TAG_CLOSE } from '../knowledge';
import { writeDoc, checkDocs, buildTaskSpec, buildStatusReport, buildApiContract, docsSection, getDocRegistry } from '../ssot';
import { findTestFailure, parseTestOutput, buildFixPrompt, isTestCommand, detectStackMismatch, MAX_FIX_ROUNDS, type ParsedTestOutput } from '../testloop';
import { createSnapshot } from '../snapshot';
import { buildAgentHarness, validateAgentResult, buildRepairMessage } from '../harness';
import { TurnProgressGuard, EvidenceLedger, emptyObservation, readSignature, READ_ONLY_PROGRESS_TOOLS, type ProgressObservation } from '../progressGuard';
import { snipOldToolResults, elideLongToolResults } from '../contextWaterline';
import { scratchPut, scratchClear, scratchFromToolCall } from '../scratchpad';
import { buildOrchTools, nativeToolsOn } from '../toolSchema';
import { chatStructured } from '../structured';
import { reloadSkills, getSkills, pickSkillsForNode, formatSkillsBlock } from '../skills';
import { saveDeliverable } from '../deliverable';
import { PROJECT_ROOT, DEFAULT_META_PATHS, type SelfModGateConfig, type ContextConfig } from '../config';
import { prepareSelfdevClone } from '../workspace';
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
  /** 项目治理：自指任务的隔离克隆根目录所在配置（缺省则自指任务不隔离） */
  projects?: { root: string; selfdev_root: string };
  /** 超时语义重做：单轮 LLM 成功但耗时超该秒数 → slow 降权（不记失败） */
  slowSuccessSec?: number;
  /** 按节点复杂度的输出预算分档（模型 max_tokens 封顶）；undefined 关闭回退旧行为 */
  outputTiers?: { simple: number; normal: number; complex: number };
  /** 缓存优先上下文裁剪配置 */
  context?: ContextConfig;
  /** M2 阻塞问答：ask 等待超时秒数（缺省 900） */
  askTimeoutSec?: number;
  /** M4 滚动规划：rolling（缺省）| static */
  planningMode?: 'rolling' | 'static';
  /** M4 阶段数上限（缺省 5） */
  rollingMaxStages?: number;
  /** 外部 MCP 服务管理器（缺省=未接入 MCP） */
  mcp?: McpManager;
}

const MERGE_NODE_NAME = '主 Agent 合并分支';

/** 失败验尸用（2026-09-16）：堆栈头部若干行。此前 planStage1/failGraph 只记 String(e) 一行
 *  文字，"RangeError: Invalid array length" 五连败时无处定位抛点。meta 走 JSON 序列化，
 *  换行转义为 \n 保持单行可 grep。 */
function errorStackHead(e: unknown, lines = 10): string {
  return String((e as any)?.stack || '').split('\n').slice(0, lines).join(' | ').trim();
}

// ---------- i6efv5h2 复盘：错误分型（2026-09-09） ----------
// 时长/环境/前置类失败与"模型能力"无关：重试必复发，烧完整条模型阶梯只是浪费。
// 三类标记由 dispatch 打在 error 前缀上，executeNodeInner 命中即停止重试与接管、转人工。
export const ENV_DEFECT_PREFIX = '[env-defect]';
export const NODE_BUDGET_PREFIX = '[node-budget]';
export const PRECONDITION_PREFIX = '[precondition]';
/** fs 级系统缺陷（如 ENOTDIR）：harness/环境问题，不计模型健康度 */
export const SYSTEM_DEFECT_RE = /\bENOTDIR\b|\bEISDIR\b|\bEROFS\b|\bEDQUOT\b|\bENOSPC\b|\bEMFILE\b/i;
/** 模型明确申报的前置缺失（"缺源码/文件不在本沙箱"）：换模型没用，直接转人工 */
export const PRECONDITION_FAIL_RE = /缺少(项目)?源代码|文件不在本沙箱|前序节点产出的?代码不在|missing source( files)?|无 package\.json/i;
/**
 * M1（2y3tuote 实证）：模型申报"契约 v1/v2 不一致、需要补充信息、拿不到文件"这类**合法阻塞**
 * 是对环境的正确发现——换模型只会让每个模型把同一问题重新发现一遍（node2 十分钟烧 6 模型）。
 * 命中即停阶梯、不记模型健康度，由 executeNode 的 needs_human 分支收尾。
 */
export const LEGIT_BLOCKER_RE = /\[blocker\]|需要人类|需要人工|需要.{0,8}补充|信息不足|无法获得|未获得|缺少.{0,8}(信息|权限|证据)|上游.*(声明|实际).*(不符|不一致)|cannot proceed|need human/i;
/**
 * 幻觉阻塞证据门（2026-09-17，in6pe4qf 两次失败实证）：窄匹配"工具/权限类申诉"——
 * 零工具轮的此类申诉是幻觉（同节点强模型实测工具调用返回 18KB）。窗口 ≤20 字符
 * 覆盖实测文案"本轮未获得任何文件系统读取、写入或命令执行工具"；不含信息/证据类
 * 合法阻塞（那类由 LEGIT_BLOCKER_RE 原语义停靠人工）。
 */
export const TOOLCLAIM_RE = /(未获得|无法获得|缺少|没有)[^\n]{0,20}(工具|权限)|只读侦查|cannot (call|use) tools|no (file system|command execution|read\/write) tool|no tool access/i;

/**
 * 假完成拦截·产物核查（2026-09-17）：从节点名提取规格点名的文件路径 token（至少含一个 '/'）。
 * 先剥 URL（避免把 https://host/path 抓成路径）；裸文件名不提取（误报面大）；上限 10 条防膨胀。
 */
export function extractSpecPaths(name: string): string[] {
  const cleaned = String(name || '').replace(/\w+:\/\/\S+/g, ' ');
  const raw = cleaned.match(/[A-Za-z0-9_.\-]+(?:\/[A-Za-z0-9_.\-]+)+/g) || [];
  return [...new Set(raw.map((p) => p.replace(/\\/g, '/').replace(/^\.\//, '').toLowerCase()))].slice(0, 10);
}
/** M3：429/503/rate limit 是容量信号不是能力失败——退避重试同模型，不记健康度不烧链 */
export const CONTENT_FAIL_RE = /parse|schema violation|not valid JSON|failed to produce final output/i;
export const CAPACITY_RE = /429|503|rate.?limit|too many requests|tpm|rpm|quota/i;
/**
 * 上下文超限（2026-09-15，c2g0ya6d 复盘）：413/payload too large 是"请求体 vs 模型窗口/网关上限"
 * 的确定性拒绝——不是模型的错（markFailure 会毒化健康分让全池假死），也不是容量问题（换模不解决，
 * 得折叠瘦身或换更大窗口）。c2g0ya6d 节点 6 连续 413 烧光降级链、把 10 个模型全部拖进冷却，
 * 最后只剩一个免费模型独木桥——本分型就是那条根因。
 */
export const CONTEXT_OVERFLOW_RE = /413|payload too large|request too large|context length|maximum context|context_length_exceeded/i;
/**
 * 群聊化（批次一）：用户插话的三分支处理模板——attempt 开头与工具轮之间两处注入共用，
 * 语义单点。纪律与讨论引擎同源：引擎只陈述事实（送达/接力/重放），agent 态度只能来自模型输出；
 * 先核实再决定跳过/执行/接力，禁止未核实空口应承。
 */
export const INTERVENE_TEMPLATE =
  '## 用户插话（先对照现场核实，再逐条选一支处理；本轮最终输出必须包含 reply_to_user 直接回应用户）\n' +
  '① 已实现/已完成：不要重复劳动——reply_to_user 给出证据（文件:行 或 节点名）并说明跳过；\n' +
  '② 未实现且属于本节点范围：纳入本轮实现，reply_to_user 汇报结果；\n' +
  '③ 未实现且不归本节点管：把该条原文列入 intervene_defer 数组（引擎会接力给后续节点），reply_to_user 如实说明已接力。\n' +
  '禁止：未核实就应承、宣称做过但拿不出证据。';

/**
 * 断崖压缩：把最早的完整工具轮次折叠为一条确定性摘要（纯函数、不经 LLM、
 * 同输入同字节——失败重试/同模型再入场时前缀仍可复用）。
 * 保留结构：head（system+会话续传+简报，永不折叠）→ 折叠摘要 → 最近 2 条原文。
 * 返回是否实际发生了折叠（不足两轮完整历史时不折叠）。
 */
export function foldMessagesInto(messages: { role: string; content: string }[]): boolean {
  const firstResult = messages.findIndex((m) => m.role === 'user' && m.content.startsWith('工具执行结果：'));
  if (firstResult <= 1) return false;
  const head = firstResult - 1; // 折叠区从发起首轮工具调用的 assistant 消息开始（结果与请求成对折叠）
  const foldEnd = messages.length - 2; // 最近一条 assistant + 工具结果保持原文
  if (foldEnd - head < 2) return false; // 不足一轮完整往返，折叠无收益
  const folded = messages.slice(head, foldEnd);
  const lines: string[] = [];
  let roundNo = 1;
  for (const m of folded) {
    if (m.role === 'assistant') {
      const parsed = extractJson(m.content);
      if (parsed && Array.isArray(parsed.tool_calls) && parsed.tool_calls.length) {
        lines.push(`- 第 ${roundNo} 次请求工具: ${parsed.tool_calls.map((t: Record<string, any>) => `${t.tool}${t.path ? `(${t.path})` : ''}${t.pattern ? `[${String(t.pattern).slice(0, 24)}]` : ''}${t.name ? `(${t.name})` : ''}`).join('、')}`);
      } else if (parsed && parsed.status) {
        lines.push(`- 第 ${roundNo} 次中间产出(${parsed.status}): ${String(parsed.summary || '').replace(/\s+/g, ' ').slice(0, 100)}`);
      } else {
        lines.push(`- 第 ${roundNo} 次文本输出: ${m.content.replace(/\s+/g, ' ').slice(0, 100)}…`);
      }
      roundNo += 1;
    } else {
      if (m.content.startsWith('工具执行结果：')) {
        const tools = [...m.content.matchAll(/"tool"\s*:\s*"([^"]+)"/g)].map((x) => x[1]);
        lines.push(`- 工具结果: ${[...new Set(tools)].join('、') || '（见折叠内容）'}，共 ${m.content.length} 字符已折叠`);
      } else {
        lines.push(`- 系统指令: ${m.content.replace(/\s+/g, ' ').slice(0, 60)}…`);
      }
    }
  }
  const summary = {
    role: 'user',
    content: `## 更早侦查历史（系统确定性折叠，${lines.length} 条）\n${lines.join('\n')}\n（历史细节已折叠以控制上下文规模；结论以最近轮次为准，仍缺失的信息请重新用只读工具侦查，不要臆测。）`,
  };
  messages.splice(head, foldEnd - head, summary);
  return true;
}

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
/** M4：静态回退时的最小合成清单——从任务描述生成一条 command 证据项，结构保底（M5 由验收 agent 深化）。 */
function synthesizeChecklist(description: string): ChecklistItem[] {
  const req = description.replace(/\s+/g, ' ').trim().slice(0, 300);
  return req ? [{ id: 'auto-1', requirement: req, evidence_type: 'command', status: 'open', stage: 1 }] : [];
}

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
  /** 外部 MCP 服务管理器（MCP client）；缺省=未接入，mcp__ 工具全软错误 */
  mcp?: McpManager;
  router: Router;
  private pool: ModelPool | null;
  private policy: PermissionPolicy;

  /** 全局执行策略（群组讨论引擎复用时读取；监狱与分级闸门的依据） */
  get permissionPolicy(): PermissionPolicy {
    return this.policy;
  }
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
  private projects?: { root: string; selfdev_root: string };
  private slowSuccessMs: number;
  private outputTiers?: { simple: number; normal: number; complex: number };
  private contextCfg: ContextConfig;
  /** M2 阻塞问答：ask 等待超时（毫秒） */
  private askTimeoutMs: number;
  /** M2 实时问答：正在执行 callAgent 的 agent 计数（key: `${taskId}:${agent}`）——
   *  同名 agent 可并发多 dispatch，收尾清扫只在最后一个 dispatch 结束时触发 */
  private activeAgents = new Map<string, number>();
  /** M4 滚动规划 */
  private planningMode: 'rolling' | 'static';
  private rollingMaxStages: number;
  private taskTokens = new Map<string, number>();
  /** 2026-09-16：任务级流打断——cancel API 经 abortTask 中止 in-flight LLM 流
   *  （此前取消只能等轮边界轮询，卡死的流无法打断）。execute 创建、收尾清理。 */
  private taskSignals = new Map<string, AbortController>();
  /** E5 软重试防浪费记忆（o3xmkraj 复盘）：本任务内已"降思考强度重试仍烧穿"的模型——
   *  同模型只软重试一次，命中记忆直接换模（网关不认 reasoning_effort 时避免双倍烧） */
  private thinkingBurned = new Map<string, Set<string>>();
  private logger = getLogger();
  onProgress: ((type: string, payload: Record<string, unknown>) => void) | null = null;
  /** plan_async+auto_run：后台规划落到 planned 后的入队钩子（index.ts 装配 taskQueue.enqueue） */
  onTaskPlanned: ((taskId: string, projectId: string | null, workspace: string) => void) | null = null;
  /** 并行加固（Phase 2）：活跃任务数探针（index.ts 装配 taskQueue.activeTaskCount）——
   *  runGraph 据此把模型池槽位均分给并行任务，单任务行为不变 */
  private activeTaskCount: (() => number) | null = null;

  /** 注入活跃任务数探针（taskQueue 晚于 orchestrator 构造，经 setter 回接） */
  setActiveTaskCount(fn: () => number): void {
    this.activeTaskCount = fn;
  }

  /** 包 D（2026-09-16）：全局权限策略热更——设置界面保存后立即生效，无需重启 */
  setPolicy(policy: PermissionPolicy): void {
    this.policy = policy;
  }

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
    this.projects = opts.projects;
    this.slowSuccessMs = Math.max(0, (opts.slowSuccessSec ?? 300) * 1000);
    this.outputTiers = opts.outputTiers;
    this.contextCfg = opts.context || { max_prompt_tokens: 16000, workspace_tree_max_chars: 1500, goal_max_chars: 1500 };
    this.askTimeoutMs = Math.max(5000, (opts.askTimeoutSec ?? 900) * 1000);
    this.planningMode = opts.planningMode ?? 'rolling';
    this.rollingMaxStages = Math.max(1, opts.rollingMaxStages ?? 5);
    this.mcp = opts.mcp;
    // MCP agent 白名单挂到插件表（agent.yaml 的 mcp_servers）；plugins 重载后 provider 读的是最新表
    this.mcp?.setAgentServersProvider((agent) => this.plugins.get(agent)?.mcpServers);
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

  /**
   * E7 重做（2026-09-15）：服务重启不再宣判死刑。
   *  - running/finalizing 任务的在途节点 → `interrupted`（新状态，诚实反映"被中断"而非"失败"），
   *    任务整体标 interrupted，由调用方（index.ts）重新入队续跑——execute 的节点复位逻辑
   *    会把 interrupted 复位为 pending，completed 节点不重做；
   *  - 同一任务被中断次数达 infra_retries 上限 → 停靠人工（failed），防重启死循环；
   *  - 返回三类孤儿清单：resume（可自动续跑）、queued（重启丢车道的排队任务）、
   *    planning（planAsync 后台规划被打断的任务）。
   */
  async sweepInterruptedTasks(): Promise<{ resume: string[]; queued: string[]; planning: string[] }> {
    const resume: string[] = [];
    const queued: string[] = [];
    const planning: string[] = [];
    for (const graph of await listTaskGraphs()) {
      if (graph.status === 'queued') {
        // 车道状态纯内存（taskQueue），重启即丢——queued 任务重启后无人驱动，
        // 不清就是"永远挂在进行中"的僵尸（用户实测多个任务如此）
        queued.push(graph.task_id);
        continue;
      }
      if (graph.status === 'pending' && (graph.nodes?.length ?? 0) === 0) {
        // plan_async 的后台规划随上一进程死亡——任务停在 pending 无节点，重新规划
        planning.push(graph.task_id);
        continue;
      }
      if (graph.status !== 'running' && graph.status !== 'finalizing') continue;
      const interruptedNodeIds: string[] = [];
      for (const node of graph.nodes) {
        if (node.status === 'running' || node.status === 'retrying' || node.status === 'waiting_approval') {
          node.status = 'interrupted';
          node.error = node.error || '服务重启导致执行中断';
          node.finished_at = new Date().toISOString();
          interruptedNodeIds.push(node.id);
        }
      }
      const retries = (graph.infra_retries ?? 0) + 1;
      graph.infra_retries = retries;
      graph.status = 'interrupted';
      graph.updated_at = new Date().toISOString();
      await persistGraph(graph);
      if (retries > 3) {
        // 重启死循环保护：连续多次中断不再自动续跑，诚实停靠人工
        graph.status = 'failed';
        await persistGraph(graph);
        await appendJournal(graph.task_id, 'orchestrator', {
          role: 'master', kind: 'error',
          text: `服务重启中断已达 ${retries} 次，停止自动续跑转人工（已完成 ${graph.nodes.filter((n) => n.status === 'completed').length} 节点的成果保留）`,
          ts: new Date().toISOString(), node_id: '', node_name: '',
        });
        notify('task_interrupted', { task_id: graph.task_id, reason: 'server_restart', retries }, `[Co-Team] 任务 ${graph.task_id} 因反复重启中断 ${retries} 次，已停靠人工`);
        this.logger.warn('Startup sweep parked repeatedly interrupted task', { taskId: graph.task_id, retries });
        continue;
      }
      await appendJournal(graph.task_id, 'orchestrator', {
        role: 'master', kind: 'error',
        text: `服务重启导致执行中断（第 ${retries} 次），已标记 interrupted 并自动续跑——已完成节点的成果保留，中断节点将重新执行`,
        ts: new Date().toISOString(), node_id: interruptedNodeIds[0] || '', node_name: '',
        meta: { interrupted_nodes: interruptedNodeIds, auto_resume: true },
      });
      notify('task_interrupted', { task_id: graph.task_id, reason: 'server_restart', auto_resume: true }, `[Co-Team] 任务 ${graph.task_id} 因服务重启中断，将自动续跑`);
      this.logger.warn('Startup sweep marked interrupted task for auto-resume', { taskId: graph.task_id, retries, nodes: interruptedNodeIds.length });
      resume.push(graph.task_id);
    }
    return { resume, queued, planning };
  }

  /** planAsync 后台规划被打断的任务：重建规划流程（不自动执行，规划完等用户审阅/既有 autoRun 语义） */
  async resumeInterruptedPlanning(taskId: string): Promise<void> {
    const graph = await loadGraph(taskId);
    if (!graph || graph.nodes.length > 0) return;
    this.logger.info('Resuming interrupted background planning', { taskId });
    await this.planInBackground(taskId, graph.description, graph.workspace, graph.project_id, {
      level: graph.level || 'standard',
      mainModelId: graph.main_model_id,
      executionPolicy: graph.execution_policy,
      nodeClarify: graph.node_clarify,
    });
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

  /** M4 滚动规划：第 1 阶段计划（子图 + 阶段目标 + 全局验收清单）。
   *  生成失败回退静态整图 + 从任务描述合成的最小清单——结构在，深度后续由验收 agent 补。 */
  private async planStage1(
    request: string,
    opts: { level?: TaskLevel; mainModelId?: string; projectId?: string }
  ): Promise<{ planned: PlannedGraph; rolling: boolean; stageGoal: string; checklist: ChecklistItem[]; summary?: string }> {
    try {
      const stage = await generateStagePlan(request, this.pool, this.router, {
        stage: 1,
        globalGoal: request,
        stageHistory: [],
        checklist: [],
        projectId: opts.projectId,
        level: opts.level,
        pinnedModel: opts.mainModelId,
      });
      if (stage && stage.planned.nodes.length && stage.checklist.length) {
        return { planned: stage.planned, rolling: true, stageGoal: stage.stage_goal, checklist: stage.checklist, summary: stage.summary };
      }
    } catch (e) {
      this.logger.warn('stage-1 rolling plan failed, falling back to static', { error: String(e).slice(0, 200), stack: errorStackHead(e) });
    }
    const planned = await this.planFor(request, opts);
    return { planned, rolling: false, stageGoal: '', checklist: synthesizeChecklist(request), summary: planned.summary };
  }

  async createTask(
    description: string,
    workspace: string,
    projectId?: string,
    opts?: { mainModelId?: string; level?: string; executionPolicy?: { level?: string; whitelist_commands?: string[] }; nodeClarify?: ClarifyMode; planAsync?: boolean; skipClarification?: boolean; allowSelfRef?: boolean; autoRun?: boolean }
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
        self_ref: opts?.allowSelfRef,
      });
      void this.assessThenPlan(taskId, description, workspace, projectId, {
        level,
        mainModelId,
        executionPolicy: opts?.executionPolicy,
        nodeClarify: opts?.nodeClarify,
        skipClarification: opts?.skipClarification,
        // E20：plan_async + auto_run 组合此前被路由 early-return 吞掉——autoRun 随
        // 后台规划链传递，planned 落地后经 onTaskPlanned 钩子入队
        autoRun: opts?.autoRun,
      });
      return { taskId, graph: { nodes: [], edges: [], summary: '' } as PlannedGraph, level };
    }

    // improvement 5: requirement clarification loop — ambiguous requirements must be
    // resolved with the human before any planning/execution happens
    // staged feedback: the API request is synchronous and can take minutes on a slow
    // upstream — emit the current stage so the UI can show progress instead of a spinner
    await emitProgress('task_creating', { stage: 'assessing', description: description.slice(0, 80) });
    // A4 简单模式: explicit skip wins over the clarification loop。
    // P3 档级驱动：轻量任务跳过澄清（typo 级任务不该问 3 轮问题）
    const assessment = opts?.skipClarification || level === 'light' ? ({ clear: true } as ClarificationAssessment) : await assessRequirement(description, this.pool);
    const taskId = Math.random().toString(36).slice(2, 10);

    if (!assessment.clear) {
      this.logger.info('Requirement unclear, entering clarification loop', { taskId, missing: assessment.missing });
      await saveTaskGraph(taskId, [], [], {
        description,
        workspace,
        status: 'clarifying',
        project_id: projectId,
        self_ref: opts?.allowSelfRef,
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
      selfRef: opts?.allowSelfRef,
    });
    return { taskId, graph: planned.graph, level: planned.level };
  }

  /** Generate + persist the plan for a (possibly clarified) requirement. */
  private async planAndSave(
    taskId: string,
    description: string,
    workspace: string,
    projectId: string | undefined,
    opts: { level: TaskLevel; mainModelId?: string; clarifyContext?: string; executionPolicy?: { level?: string; whitelist_commands?: string[] }; nodeClarify?: ClarifyMode; selfRef?: boolean }
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
    // M4 滚动规划：rolling 模式下第 1 阶段只规划"可运行最小骨架"+ 全局验收清单；
    // 静态模式或滚动规划失败回退整图（回退时也带合成清单，保住结构）。
    // P3 档级驱动：轻量档强制静态整图（不进滚动 → 不触发最终清单机审）
    const stage1 = this.planningMode === 'rolling' && LEVEL_PROFILES[opts.level]?.rolling !== false
      ? await this.planStage1(requestWithContext, { level: opts.level, mainModelId: opts.mainModelId, projectId })
      : { planned: appendMergeNode(stripMergeNodes(await this.planFor(requestWithContext, { level: opts.level, mainModelId: opts.mainModelId, projectId }))), rolling: false, stageGoal: '', checklist: synthesizeChecklist(requestWithContext) };
    const planned = appendMergeNode(stripMergeNodes(stage1.planned));
    const nodes = planned.nodes.map((n) => newNode(n, taskId));
    // 阶段 1 的节点 id 记录（阶段闸门时只结算本阶段节点）
    const stageNodeIds = nodes.filter((n) => n.agent !== 'orchestrator').map((n) => n.id);

    this.logger.info('Task created', {
      taskId,
      nodesCount: nodes.length,
      edgesCount: planned.edges.length,
      agents: [...new Set(nodes.map((n) => n.agent))],
      level: opts.level,
      mainModelId: opts.mainModelId,
      rolling: stage1.rolling,
      checklistItems: stage1.checklist.length,
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
      self_ref: opts.selfRef,
      rolling: stage1.rolling,
      stage: 1,
      stage_count: stage1.rolling ? 1 : 1,
      stage_goal: stage1.stageGoal,
      stage_nodes: stageNodeIds,
      stage_history: [],
      checklist: stage1.checklist,
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
    this.logger.error('Background task flow failed', { taskId, error: String((e as any)?.message || e), stack: errorStackHead(e) });
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
    opts: { level: TaskLevel; mainModelId?: string; executionPolicy?: { level?: string; whitelist_commands?: string[] }; nodeClarify?: ClarifyMode; skipClarification?: boolean; autoRun?: boolean }
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
    opts: { level: TaskLevel; mainModelId?: string; clarifyContext?: string; executionPolicy?: { level?: string; whitelist_commands?: string[] }; nodeClarify?: ClarifyMode; autoRun?: boolean }
  ): Promise<void> {
    try {
      if (await isCancelled(taskId)) return;
      await emitProgress('task_creating', { stage: 'planning', task_id: taskId, description: description.slice(0, 80) });
      await this.planAndSave(taskId, description, workspace, projectId, opts);
      this.logger.info('Background planning finished', { taskId });
      if (opts.autoRun) this.onTaskPlanned?.(taskId, projectId ?? null, workspace);
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

  // ---------- 环境预检（o3xmkraj 复盘：规划零环境接地的根治） ----------

  /** 技术栈关键词 → 所需命令：规划文本命中即纳入预检。不预设"应该有 python/node"——
   *  一切以任务级/全局白名单与机器 PATH 的实际探测为准。 */
  private static readonly TECH_HINTS: [RegExp, string][] = [
    [/flutter/i, 'flutter'],
    [/\bdart\b/i, 'dart'],
    [/\brust\b|\bcargo\b/i, 'cargo'],
    [/\bgolang\b|\bgo\s+(开发|语言)|\bgo\b/i, 'go'],
    [/\bjava\b|maven|gradle|spring/i, 'java'],
    [/dotnet|\.net\b|c#\b/i, 'dotnet'],
  ];

  /** 命令是否存在于执行环境 PATH（win32 用 where，其余 which） */
  private commandExists(cmd: string): boolean {
    const checker = process.platform === 'win32' ? 'where' : 'which';
    try {
      const r = spawnSync(checker, [cmd], { encoding: 'utf-8', timeout: 5000 });
      return r.status === 0;
    } catch {
      return false;
    }
  }

  /** 发车前预检：计划所需命令 vs 白名单 vs PATH。不齐 → 停靠人工门（waiting_approval），
   *  缺白名单可由双端"补授白名单并开跑"一键续跑；机器未装的工具链明确告知需人工安装。 */
  private async preflightEnvironment(taskId: string, graph: TaskGraph, policy: PermissionPolicy): Promise<boolean> {
    const required = new Set<string>();
    for (const n of graph.nodes) for (const c of n.required_commands || []) required.add(String(c));
    const text = [graph.description, ...graph.nodes.map((n) => `${n.name} ${n.reason || ''} ${n.goal_link || ''}`)].join('\n');
    for (const [re, cmd] of Orchestrator.TECH_HINTS) if (re.test(text)) required.add(cmd);
    if (!required.size) {
      graph.preflight = { checked_at: new Date().toISOString(), ok: true };
      return true;
    }

    const missingWhitelist: string[] = [];
    const missingPath: string[] = [];
    for (const cmd of [...required].sort()) {
      if (!this.commandExists(cmd)) { missingPath.push(cmd); continue; }
      if (policy.level !== 'full' && policy.whitelistCommands && !policy.whitelistCommands.includes(cmd)) missingWhitelist.push(cmd);
    }
    graph.preflight = { checked_at: new Date().toISOString(), ok: !missingWhitelist.length && !missingPath.length, missing_whitelist: missingWhitelist, missing_path: missingPath };
    if (graph.preflight.ok) {
      this.logger.info('Preflight passed', { taskId, checked: [...required] });
      return true;
    }

    this.logger.warn('Preflight found missing commands — parking task at human gate', { taskId, missingWhitelist, missingPath });
    await appendJournal(taskId, 'orchestrator', {
      role: 'master', kind: 'error',
      text: `⛔ 环境预检未通过：` +
        (missingWhitelist.length ? `白名单缺 ${missingWhitelist.join('、')}（机器上已安装，可一键补授后开跑）` : '') +
        (missingPath.length ? `${missingWhitelist.length ? '；' : ''}机器未安装 ${missingPath.join('、')}（需人工安装，或调整任务技术栈）` : '') +
        '——任务已停靠，处理后点「开跑」',
      ts: new Date().toISOString(), node_id: '', node_name: '',
    });
    await emitProgress('task_preflight', { task_id: taskId, ok: false, missing_whitelist: missingWhitelist, missing_path: missingPath });
    notify('task_preflight', { task_id: taskId }, `[Co-Team] 任务 ${taskId} 环境预检未通过（${[...missingWhitelist, ...missingPath].join('、') || '未知缺失'}），已停靠待人工处理`);
    return false;
  }

  /** 取消打断：abort 本任务的 in-flight LLM 流（llm.ts externalSignal 消费分支接管）。 */
  abortTask(taskId: string): void {
    this.taskSignals.get(taskId)?.abort();
  }

  /** execute 包装：登记任务级 AbortController，收尾清理（流内可控性，2026-09-16）。 */
  async execute(taskId: string, workspace: string): Promise<Record<string, any>> {
    const controller = new AbortController();
    this.taskSignals.set(taskId, controller);
    try {
      return await this.executeInner(taskId, workspace);
    } finally {
      this.taskSignals.delete(taskId);
    }
  }

  private async executeInner(taskId: string, workspace: string): Promise<Record<string, any>> {
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

    // reset non-completed nodes so re-runs (after approval) resume cleanly.
    // E22：cancelled 也必须重置——"upstream failed 的连带取消"在上游修复重跑后应当续跑；
    // 排除它会让重跑只补 failed 节点、下游永远躺在 cancelled，最后拼出假 success（2y3tuote 实证）。
    for (const node of graph.nodes) {
      if (node.status !== 'completed') {
        node.status = 'pending';
        // 重跑即重新开工：清掉上一轮失败痕迹（error/error_type/needs_human）——
        // 监督者 buildDigest 读节点行的 error 字段，残留旧错误会每心跳重复催办
        // （o3xmkraj 实证单节点累积 15 条噪声干预）
        node.error = '';
        (node as any).error_type = undefined;
        node.needs_human = false;
      }
    }
    // M2 实时问答：重跑入口把上次运行遗留的 pending ask 落盘（服务重启后内存等待已失）
    await settleTaskPendingAsks(taskId).catch(() => {});
    // 自指任务物理隔离：在 projects.selfdev_root/<taskId> 的本地克隆中执行，
    // co-team 主副本的 HEAD/分支/工作树零触碰；成果留在克隆里由人审阅并回
    let execWorkspace = workspace;
    if (graph.self_ref && this.projects) {
      try {
        execWorkspace = await prepareSelfdevClone(taskId, this.projects.selfdev_root, PROJECT_ROOT);
        graph.selfdev_path = execWorkspace;
        this.logger.info('self-ref task isolated in local clone', { taskId, clone: execWorkspace });
      } catch (e) {
        const msg = `自指任务隔离克隆失败: ${String((e as Error)?.message || e)}`;
        this.logger.error(msg, { taskId });
        graph.status = 'failed';
        await persistGraph(graph);
        await emitProgress('execute_failed', { task_id: taskId, completed: 0, total: graph.nodes.length, status: 'failed', error: msg });
        return { status: 'error', message: msg };
      }
    }
    graph.workspace = execWorkspace;
    // 环境预检（o3xmkraj 复盘）：发车前确定性对齐"计划所需"与"环境现实"——
    // 工具链不在 PATH / 不在白名单即停靠人工门，不再让 13 个节点在执行中逐个撞墙
    const policy = policyWithLevel(this.policy, graph.execution_policy);
    const preflightOk = await this.preflightEnvironment(taskId, graph, policy);
    if (!preflightOk) {
      graph.status = 'waiting_approval';
      await persistGraph(graph);
      await emitProgress('execute_failed', { task_id: taskId, completed: 0, total: graph.nodes.length, status: 'waiting_approval', error: '环境预检未通过：所需命令缺失，已停靠人工门' });
      return { status: 'waiting_approval', changes: [] };
    }
    graph.status = 'running';
    await persistGraph(graph);
    await emitProgress('execute_start', { task_id: taskId, workspace: execWorkspace, total_nodes: graph.nodes.length });

    // P3 档级驱动执行管线：轻的是"仪式"不是"安全"——light 档跳过 worktree 舞步直接在
    // execWorkspace 执行（git 任务分支提交兜底 + 产物核查门保留），standard/heavy 行为不变
    const levelProfile = LEVEL_PROFILES[graph.level ?? 'standard'];
    const useSandbox = this.sandboxEnabled && levelProfile.sandbox;
    let sandbox: string;
    try {
      sandbox = useSandbox ? await createSandbox(execWorkspace, taskId) : execWorkspace;
      this.logger.debug('Sandbox created', { taskId, sandbox, sandboxEnabled: this.sandboxEnabled, useSandbox });
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

    // P3 档级驱动：light 直接在 execWorkspace 执行——不在用户仓库里跳每节点分支舞步
    if (this.branchWorkflow && this.gitEnabled && sandbox !== execWorkspace) {
      // baseline snapshot: all agent branches start from here
      await gitTool.ensureBase(sandbox).catch(() => {});
      // M6（2y3tuote 两次 merge 假冲突实证）：重跑时 completed 节点的 branch 指向上一次
      // 已销毁的沙箱——新沙箱里不存在，merge 必炸。自愈：分支不在即视为产物已落工作区，清空。
      const branchList = await simpleGit({ baseDir: sandbox }).branchLocal().catch(() => null);
      if (branchList) {
        let staleCleared = false;
        for (const n of graph.nodes) {
          if (n.status === 'completed' && n.branch && !branchList.all.includes(n.branch)) {
            this.logger.info('stale node branch from a previous sandbox — cleared', { taskId, nodeId: n.id, branch: n.branch });
            n.branch = '';
            n.branch_base = '';
            staleCleared = true;
          }
        }
        if (staleCleared) await persistGraph(graph);
      }
    }

    // improvement 9: global goal — one shared target every agent must serve
    const clarifyState = await busGet<{ answers?: ClarifyAnswer[] }>(`task:clarify:${taskId}`);
    const goalContent = [graph.description, ...(clarifyState?.answers || []).map((a) => `- ${a.question} → ${a.answer}`)].join('\n');
    await busSet(`task:goal:${taskId}`, { content: goalContent, updated_at: new Date().toISOString(), updated_by: 'system' });
    const goalDir = this.sandboxEnabled && sandbox !== execWorkspace ? sandbox : null;
    if (goalDir) {
      try { fs.writeFileSync(path.join(sandbox, 'GLOBAL_GOAL.md'), `# GLOBAL_GOAL\n\n${goalContent}\n`, 'utf-8'); } catch { /* best effort */ }
    }

    // improvement 4: SSOT documents — the single source of truth for agent collaboration.
    // improvement 7: light-level tasks skip the doc pipeline entirely (LEVEL_PROFILES.docs)
    const docTarget = this.sandboxEnabled && sandbox !== execWorkspace ? sandbox : undefined;
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
    await createSnapshot(taskId, { tag: 'task-start', workspace: execWorkspace, sandbox }).catch((e) => this.logger.warn('task-start snapshot failed', { taskId, error: String(e) }));
    await emitProgress('progress_update', { task_id: taskId, progress: computeProgress(graph) });

    let result: Record<string, any> = { status: 'failed', error: 'execution did not run' };
    try {
      result = await this.runGraph(taskId, graph, sandbox, policy);
      // M4 滚动规划阶段闸门：本阶段全绿后由 replanner 基于实际产出决定下一阶段/完成/转人工。
      // 循环在 execute 内进行以保持车道语义（一次 execute = 一个任务的完整滚动执行）。
      if (result.status === 'success' && graph.rolling && this.planningMode === 'rolling') {
        result = await this.rollingStageLoop(taskId, graph, sandbox, policy, result);
      }
    } catch (error) {
      this.logger.error('Task execution failed', { taskId, error: String(error) });
      result = { status: 'failed', error: `Execution failed: ${error}` };
    } finally {
      // E5 软重试防浪费记忆随任务收尾清理（记忆语义 = 本任务内）
      this.thinkingBurned.delete(taskId);
      // 已批准命令登记同样随任务收尾清理（续跑轮次消费后即失效）
      await busSet(`task:approved_commands:${taskId}`, []).catch(() => {});
      if (this.sandboxEnabled && sandbox !== workspace) {
        if (result?.status === 'success') {
          // 1.6 收尾黑洞可见化（2026-09-15）：节点全 completed 后还有同步/验收/git 一长串
          // 无进度条的收尾——落 finalizing 状态并广播，UI 不再把 100%+running 误读为卡死
          graph.status = 'finalizing';
          await persistGraph(graph);
          await emitProgress('task_finalizing', { task_id: taskId, stage: 'merge' });
          try {
            if (this.branchWorkflow && this.gitEnabled) {
              // merged result lives on the sandbox base branch; sync files to the real workspace.
              // a failed sync must NOT stay 'success' — the deliverables would stay trapped
              // in the sandbox and the user would never see them (observed in task gnq6h5p6)
              const synced = await gitTool.syncToWorkspace(sandbox, execWorkspace, 'coteam/base');
              if (!synced) throw new Error('syncToWorkspace returned false (copy failed, e.g. a locked target file)');
              result.merged_branches = result.merged_branches || [];
            } else {
              result.merged_files = mergeChanges(sandbox, execWorkspace);
            }
            // post-merge acceptance：合并后的真实工作区跑项目自身测试套件——每个节点
            // 验证自己的切片 ≠ 整体能跑（jr3gdkxq：验证节点全绿但页面全崩的根因补闸）
            const acc = await runPostMergeAcceptance(execWorkspace, 240, levelProfile.acceptance);
            result.acceptance = acc;
            if (acc.status === 'failed') {
              // M5：滚动任务的最终裁决交给 finalAcceptanceGate（清单机审 + 派生提案），
              // 这里不提前判死；静态模式按 acceptance_policy 裁决：
              // tolerant（缺省，B1 2026-09-17）→ completed_with_warnings（验收报告照常留证，
              // 不再把 23/25 节点全完成的任务因测试有败一刀切判死）；strict → 保持硬失败
              if (graph.rolling) {
                this.logger.warn('post-merge acceptance failed (rolling: deferred to final gate)', { taskId });
              } else if ((graph.acceptance_policy ?? 'tolerant') === 'tolerant') {
                this.logger.warn('post-merge acceptance failed (tolerant: completing with warnings)', { taskId, command: acc.command, exitCode: acc.exitCode });
              } else {
                throw new Error(`post-merge acceptance: ${acc.command} exit ${acc.exitCode}\n${acc.tail.slice(-600)}`);
              }
            }
            if (acc.status === 'no-test-command') {
              this.logger.warn('post-merge acceptance: no test command found', { taskId, workspace });
            } else {
              this.logger.info('post-merge acceptance passed', { taskId, command: acc.command });
            }
          } catch (mergeError) {
            // a failed merge must NOT be reported as success — the work never reached the workspace
            this.logger.error('Failed to merge sandbox changes into workspace', { taskId, error: String(mergeError) });
            const accFail = String(mergeError).startsWith('post-merge acceptance');
            result = {
              status: 'failed',
              error: accFail
                ? String(mergeError).slice(0, 900)
                : `Failed to merge changes into workspace: ${String(mergeError).slice(0, 300)}`,
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
                await gitTool.syncToWorkspace(sandbox, execWorkspace, 'coteam/base');
                const dirty = await simpleGit({ baseDir: execWorkspace }).status();
                changes = dirty.files.map((f) => f.path);
              } else {
                changes = mergeChanges(sandbox, execWorkspace);
              }
              if (changes.length > 0) {
                const commit = this.gitEnabled
                  ? await this.gitCommit(taskId, execWorkspace, changes, `coteam: task ${taskId} partial recovery (${completedNodes} nodes, failed: ${String(result?.error || 'unknown').slice(0, 60)})`)
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
              await cleanupSandbox(sandbox);
              this.logger.debug('Sandbox cleaned up', { taskId });
            } catch (cleanupError) {
              // cleanup failures (e.g. fs.rmSync EBUSY on Windows) must not swallow the final status write
              this.logger.warn('Sandbox cleanup failed (non-fatal)', { taskId, error: String(cleanupError) });
            }
          }
        }
      } else if (result?.status === 'success') {
        // 非沙箱模式（产物直接写在工作区）：同样过合并后全量验收闸
        graph.status = 'finalizing';
        await persistGraph(graph);
        await emitProgress('task_finalizing', { task_id: taskId, stage: 'acceptance' });
        const acc = await runPostMergeAcceptance(execWorkspace, 240, levelProfile.acceptance);
        result.acceptance = acc;
        if (acc.status === 'failed') {
          // M5：滚动任务延迟到最终闸统一裁决；静态按 acceptance_policy 裁决——
          // tolerant（缺省）不在此判死，留给下方软门转 completed_with_warnings；strict 硬失败
          if (!graph.rolling && (graph.acceptance_policy ?? 'tolerant') === 'strict') {
            result = { status: 'failed', error: `post-merge acceptance: ${acc.command} exit ${acc.exitCode}\n${acc.tail.slice(-600)}`, changes: result.changes || [] };
          }
        } else if (acc.status === 'no-test-command') {
          this.logger.warn('post-merge acceptance: no test command found', { taskId, workspace });
        }
      }
    }

    // M5 最终验收闸：滚动任务 success 后跑清单机审（构建/单测/E2E 平台矩阵）——
    // 红灯或降级项 → waiting_approval + 派生任务提案（一键批准全自动派生）；全绿 → success。
    // P3 档级驱动：light 档跳过清单机审（finalGate=false；且 light 已强制静态不进滚动）
    if (result.status === 'success' && graph.rolling && levelProfile.finalGate) {
      await emitProgress('task_finalizing', { task_id: taskId, stage: 'final_gate' });
      result = await this.finalAcceptanceGate(taskId, graph, execWorkspace, result);
    }

    // B1 验收软门（2026-09-17）：tolerant（缺省）下静态任务合并后验收失败不再一刀切判死——
    // 以 completed_with_warnings 交付（验收报告已挂 result.acceptance 留证，成功率口径计入成功）；
    // strict 任务在上方两条路径直接 throw/改 failed，不会走到这里
    if (result.status === 'success' && !graph.rolling
      && (result as Record<string, any>).acceptance?.status === 'failed'
      && (graph.acceptance_policy ?? 'tolerant') === 'tolerant') {
      result.status = 'completed_with_warnings';
      await emitProgress('task_completed_with_warnings', { task_id: taskId, acceptance: (result as Record<string, any>).acceptance });
    }

    const status = String(result.status);
    // improvement #4 (C4): task terminal — report messages nobody consumed into the journal
    await flushUndelivered(taskId).catch(() => {});
    // P2.4：任务终态清理 scratchpad（便签生命周期 = 任务生命周期）
    void scratchClear(taskId).catch(() => undefined);
    this.logger.info('Task execution completed', {
      taskId,
      status,
      changes: (result.changes || []).length,
      completedNodes: graph.nodes.filter((n) => n.status === 'completed').length,
      totalNodes: graph.nodes.length,
    });

    if ((status === 'success' || status === 'completed_with_warnings') && this.gitEnabled && (result.changes || []).length) {
      result.git_commit = await this.gitCommit(taskId, execWorkspace, result.changes as string[]);
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
    // P3 档级驱动：轻量任务不写全局记忆（typo 级成败记录占 20 条记忆槽是纯噪音）；通知保留
    const memorize = levelProfile.memory;
    if (status === 'success') {
      notify('task_success', { task_id: taskId }, `[Co-Team] 任务 ${taskId} 完成，${(result.changes || []).length} 个文件变更`);
      if (memorize) await addMemory(`任务「${description}」成功完成，产出了 ${(result.changes || []).length} 个文件变更。`);
    } else if (status === 'completed_with_warnings') {
      // B1（2026-09-17）：验收有失败但 tolerant 交付——通知明示 N 项未过，不与纯成功混同
      const acc = (result as Record<string, any>).acceptance as { command?: string; exitCode?: number } | undefined;
      notify('task_success', { task_id: taskId, warnings: true }, `[Co-Team] 任务 ${taskId} 完成（验收有警告：${acc?.command || '测试'} 退出码 ${acc?.exitCode ?? '?'}）——详见任务验收报告，${(result.changes || []).length} 个文件变更已交付`);
      if (memorize) await addMemory(`任务「${description}」完成但合并后验收有失败（tolerant 交付，${(result.changes || []).length} 个文件变更）——主体可用，遗留失败项见验收报告。`);
    } else if (status === 'failed') {
      const recoveredInfo = result.recovered_partial ? `（已完成 ${result.recovered_partial.nodes} 个节点的成果已回写工作区：${result.recovered_partial.files} 个文件）` : (result.sandbox_preserved ? `（沙箱已保留供人工恢复：${result.sandbox_preserved}）` : '');
      notify('task_failed', { task_id: taskId, error: result.error, recovered: result.recovered_partial || null }, `[Co-Team] 任务 ${taskId} 失败：${result.error}${recoveredInfo}`);
      if (memorize) await addMemory(`任务「${description}」失败于节点：${result.error}${recoveredInfo}。后续类似任务注意规避。`);
    }

    // P3-12 轻量档动态复核（防"说小了"绕过重管线）：实际改动超出轻量预估 → 明示提示人工确认
    if ((graph.level ?? 'standard') === 'light' && (status === 'success' || status === 'completed_with_warnings') && (result.changes || []).length > 3) {
      await emitProgress('light_escalated', { task_id: taskId, changes: (result.changes || []).length });
      notify('light_escalated', { task_id: taskId }, `[Co-Team] 轻量任务 ${taskId} 实际改动 ${(result.changes || []).length} 个文件，超出轻量预估——请人工确认交付物`);
      this.logger.warn('light task escalated: actual changes exceed light budget', { taskId, changes: (result.changes || []).length });
    }

    // improvement 10: task-end snapshot for post-hoc rollback / audit
    await createSnapshot(taskId, { tag: 'task-end', workspace: execWorkspace, note: `status=${status}` }).catch(() => {});
    clearProgressThrottle(taskId);

    // improvement 3: post-task review deposits a structured lesson into the knowledge base
    // P3 档级驱动：轻量任务不写知识库复盘（typo 级复盘是噪音且膨胀知识库——193MB 知识怪兽教训）
    // P1.3 改造：复盘不再是一行模板句——后台 LLM 消费 deliverable/defects/失败原因，
    // 提炼结构化经验（成果/踩坑 Why+How to apply/下次注意）写知识库（task_id 溯源 + low-confidence）
    try {
      const changes = (result.changes || []) as string[];
      if (levelProfile.knowledge && (changes.length > 0 || status === 'failed')) {
        void this.reviewTaskWithLlm(taskId, graph, status, result, description, changes).catch((e) => {
          this.logger.warn('LLM task review failed (non-fatal)', { taskId, error: String((e as Error)?.message || e) });
        });
      }
    } catch (e) {
      this.logger.warn('Knowledge review deposit failed (non-fatal)', { taskId, error: String(e) });
    }
    return result;
  }

  /**
   * P1.3 任务终局 LLM 复盘：LLM 从任务结果材料提炼 1-3 条结构化经验写知识库。
   * - LLM 失败/解析失败 → 回退到旧模板句写入（复盘永不因提炼失败而丢失）
   * - 全部条目带 task_id 溯源 + confidence=low（半自动治理：确认后转正）
   * - 后台执行，不阻塞任务完成返回
   */
  private async reviewTaskWithLlm(taskId: string, graph: TaskGraph, status: string, result: Record<string, any>, description: string, changes: string[]): Promise<void> {
    const materials = [
      `任务：${description.slice(0, 300)}`,
      `状态：${status}`,
      changes.length ? `变更文件（前 10）:\n${changes.slice(0, 10).map((c) => '- ' + c).join('\n')}` : '变更文件：无',
      result.error ? `失败原因（前 600 字）：${String(result.error).slice(0, 600)}` : '',
      Array.isArray(result.defects) && result.defects.length
        ? `未修复缺陷：\n${result.defects.map((d: any) => `- ${d?.title || '?'}: ${String(d?.detail || '').slice(0, 150)}`).join('\n')}`
        : '',
      (result as Record<string, any>).gate_test ? `测试闸：${JSON.stringify((result as Record<string, any>).gate_test).slice(0, 300)}` : '',
    ].filter(Boolean).join('\n\n');

    const entry = this.pool?.selectStrongModel(['code']) ?? this.pool?.selectStrongModel();
    if (!entry) throw new Error('模型池无可用模型');

    let llmOk = false;
    try {
      const { parsed } = await chatStructured(entry, [
        { role: 'system', content: `你是项目经验提炼员。根据任务执行材料，提炼可复用的结构化经验。
- 只提炼"下次还会用到"的通用经验；一次性的任务流水账不写
- 每条 content 必须三段：规则本体（一句话祈使句）；**Why:** 为什么（依据材料中的事实）；**How to apply:** 什么场景怎么用
- category 选择：用户纠正/规范类 → feedback；本项目特有事实/方案 → project；通用技术经验 → general-tech
- 最多 3 条；材料里没有值得提炼的就返回 lessons 空数组` },
        { role: 'user', content: materials },
      ], {
        toolName: 'review_lessons',
        description: '从任务执行材料提炼可复用经验。输出：review_summary（一句话总结）、lessons（经验条目数组：category/title/content）。',
        schema: {
          type: 'object',
          properties: {
            review_summary: { type: 'string' },
            lessons: {
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
          required: ['review_summary', 'lessons'],
          additionalProperties: false,
        },
      });
      if (parsed && Array.isArray(parsed.lessons)) {
        llmOk = true;
        const catMap: Record<string, 'feedback' | 'project' | 'general-tech'> = { feedback: 'feedback', project: 'project', 'general-tech': 'general-tech' };
        let deposited = 0;
        for (const lesson of parsed.lessons.slice(0, 3)) {
          const title = String(lesson?.title || '').trim();
          const content = String(lesson?.content || '').trim();
          if (!title || !content) continue;
          const category = catMap[String(lesson?.category || '')] || 'project';
          writeKnowledge({
            title: `${title}`,
            content,
            category,
            project_id: graph.project_id,
            tags: ['任务复盘', status === 'failed' ? '失败复盘' : '成功经验'],
            source: `task:${taskId}`,
            task_id: taskId,
            confidence: 'low',
          });
          deposited += 1;
        }
        if (deposited) {
          const summary = String(parsed.review_summary || '').trim().slice(0, 150);
          if (graph.project_id) {
            await addProjectMemory(graph.project_id, `任务复盘「${description.slice(0, 30)}」已沉淀 ${deposited} 条经验（low-confidence，待确认转正）`, 'auto', taskId).catch(() => undefined);
          }
          if (summary) await addMemory(`任务「${description.slice(0, 40)}」${summary}`);
          this.logger.info('LLM task review deposited', { taskId, lessons: deposited });
          await emitProgress('task_review_deposited', { task_id: taskId, lessons: deposited, summary });
        }
      }
    } catch (e) {
      this.logger.warn('LLM task review distill failed, falling back to template', { taskId, error: String((e as Error)?.message || e) });
    }

    if (!llmOk) {
      // 回退：模板句复盘（旧逻辑保留——提炼失败不丢复盘）
      writeKnowledge({
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
        task_id: taskId,
        confidence: 'low',
      });
    }
  }

  // ---------- M5 最终验收闸 ----------

  private async finalAcceptanceGate(taskId: string, graph: TaskGraph, workspace: string, result: Record<string, any>): Promise<Record<string, any>> {
    const checklist = graph.checklist || [];
    const audit = await runChecklistAudit(workspace, checklist, 240);
    graph.checklist = audit.items.map(({ id, requirement, evidence_type, target_platform, target, status, evidence, stage, audit_note }) => ({ id, requirement, evidence_type, target_platform, target, status, evidence, stage, audit_note } as any));
    await persistGraph(graph);
    const profile = detectProjectProfile(workspace);
    const failedItems = audit.items.filter((i) => i.status === 'failed');
    const openItems = audit.items.filter((i) => i.status !== 'done');
    const report = {
      task_id: taskId,
      platforms: profile.platforms,
      e2e: profile.e2e,
      test_command: profile.testCommand?.command || null,
      items: audit.items,
      at: new Date().toISOString(),
    };
    await busSet(`task:acceptance:${taskId}`, report);
    await appendJournal(taskId, 'orchestrator', {
      role: 'master', kind: 'round',
      text: `最终验收报告：平台[${profile.platforms.join('/')}] 机审红灯 ${failedItems.length} 项、降级/待人工 ${openItems.length} 项、通过 ${audit.items.length - failedItems.length - openItems.length} 项`,
      ts: new Date().toISOString(), node_id: '', node_name: '',
      meta: { acceptance_report: true, failed: failedItems.length, open: openItems.length },
    });
    await emitProgress('acceptance_report', { task_id: taskId, failed: failedItems.length, open: openItems.length, platforms: profile.platforms });
    if (failedItems.length || openItems.length) {
      await this.createDeriveProposal(taskId, graph, failedItems, openItems);
      const detail = failedItems.length
        ? `机审红灯：${failedItems.map((i) => `${i.id}.${i.requirement.slice(0, 40)}（${i.evidence || ''}）`).join('；').slice(0, 600)}`
        : `待人工裁决：${openItems.map((i) => `${i.id}.${i.requirement.slice(0, 40)}（${i.audit_note || '无证据'}）`).join('；').slice(0, 600)}`;
      return { ...result, status: 'waiting_approval', acceptance_failed: true, acceptance_detail: detail, acceptance_report: report };
    }
    return result;
  }

  /** 验收未过 → 生成派生任务提案：用户一键批准后自动创建只修缺陷的派生任务并全自动执行 */
  private async createDeriveProposal(taskId: string, graph: TaskGraph, failedItems: { requirement: string; evidence?: string; audit_note?: string }[], openItems: { requirement: string; audit_note?: string }[]): Promise<void> {
    const key = `task:proposals:${taskId}`;
    const list = (await busGet<any[]>(key)) || [];
    if (list.some((x) => x.status === 'pending' && x.type === 'derive_task')) return;
    const defectLines = [
      ...failedItems.map((i) => `- [机审红灯] ${i.requirement}：${i.evidence || ''} ${i.audit_note || ''}`),
      ...openItems.map((i) => `- [待补证据] ${i.requirement}：${i.audit_note || ''}`),
    ].join('\n').slice(0, 2000);
    const description = `【派生修复任务·来源 ${taskId}】修复上一任务最终验收未通过项。全局目标：${graph.description.slice(0, 200)}。缺陷清单：\n${defectLines}`;
    const proposal = {
      id: Math.random().toString(36).slice(2, 10),
      task_id: taskId,
      type: 'derive_task',
      reason: `最终验收未通过：红灯 ${failedItems.length} 项、待补证据 ${openItems.length} 项`,
      description,
      status: 'pending',
      created_at: new Date().toISOString(),
    };
    list.push(proposal);
    await busSet(key, list.slice(-50));
    await appendJournal(taskId, 'supervisor', {
      role: 'master', kind: 'message',
      text: '已生成派生修复任务提案——任务频道批准后将自动创建并执行',
      ts: new Date().toISOString(), node_id: '', node_name: '',
      meta: { supervisor: true, proposal_id: proposal.id, proposal_type: 'derive_task' },
    });
    notify('supervisor_proposal', { task_id: taskId, proposal_id: proposal.id }, `[Co-Team] 派生修复任务提案待批准（任务 ${taskId}）`);
  }

  // ---------- M4 滚动规划：阶段闸门 ----------

  /** 阶段闸门：结算当前阶段 → replanner 裁定 → 追加下一阶段或声明完成。
   *  返回值直接作为 execute 的 result（success 继续循环，waiting_* 转人工）。 */
  private async rollingStageLoop(taskId: string, graph: TaskGraph, sandbox: string, policy: PermissionPolicy, result: Record<string, any>): Promise<Record<string, any>> {
    for (;;) {
      // 1) 结算当前阶段历史
      const stage = graph.stage_count || 1;
      const stageNodeIds = new Set(graph.stage_nodes || []);
      const stageNodes = graph.nodes.filter((n) => stageNodeIds.has(n.id) || (!graph.stage_nodes && n.agent !== 'orchestrator'));
      const summaries = stageNodes
        .filter((n) => n.status === 'completed' && n.agent !== 'orchestrator')
        .map((n) => `${n.name}：${(n.result as AgentResult)?.summary || '完成'}`);
      graph.stage_history = [...(graph.stage_history || []), { stage, goal: graph.stage_goal || '', summaries }].slice(-10);
      graph.stage_nodes = [];

      // 2) 阶段数上限 → 转人工（防打转）
      if (stage >= this.rollingMaxStages) {
        this.logger.warn('rolling stage cap reached', { taskId, stage, max: this.rollingMaxStages });
        await appendJournal(taskId, 'orchestrator', {
          role: 'master', kind: 'round',
          text: `滚动规划已达阶段上限（${this.rollingMaxStages}），转人工裁决`,
          ts: new Date().toISOString(), node_id: '', node_name: '',
          meta: { rolling: true, stage_cap: true },
        });
        return { ...result, status: 'waiting_approval', stage_cap: true };
      }

      // 3) replanner 裁定：基于实际产出决定下一阶段或声明完成
      // 1.6 收尾黑洞可见化：规划间隙（免费模型下可达数分钟）广播"规划下一阶段中"
      await emitProgress('stage_planning', { task_id: taskId, next_stage: stage + 1, stage_goal: graph.stage_goal || '' });
      const decision = await generateStagePlan(graph.description, this.pool, this.router, {
        stage: stage + 1,
        globalGoal: graph.description,
        stageHistory: graph.stage_history,
        checklist: graph.checklist || [],
        projectId: graph.project_id,
        level: graph.level,
        pinnedModel: graph.main_model_id,
      });
      if (!decision) {
        await appendJournal(taskId, 'orchestrator', {
          role: 'master', kind: 'round',
          text: `第 ${stage + 1} 阶段滚动规划失败，转人工裁决`,
          ts: new Date().toISOString(), node_id: '', node_name: '',
          meta: { rolling: true, replan_failed: true },
        });
        return { ...result, status: 'waiting_approval', replan_failed: true };
      }

      if (decision.done) {
        // 完成声明：逐项裁定必须全部 done 且附证据，否则转人工（checklist 未达成禁止声明完成）
        const results = decision.checklist_results || [];
        let unmet = 0;
        for (const item of graph.checklist || []) {
          const verdict = results.find((r) => r.id === item.id);
          if (verdict?.done && verdict.evidence) {
            item.status = 'done';
            item.evidence = String(verdict.evidence).slice(0, 500);
          }
          if (item.status !== 'done') unmet += 1;
        }
        await persistGraph(graph);
        if (unmet > 0) {
          const unmetItems = (graph.checklist || []).filter((i) => i.status !== 'done').map((i) => `${i.id}. ${i.requirement}`).join('；');
          await appendJournal(taskId, 'orchestrator', {
            role: 'master', kind: 'round',
            text: `完成声明被清单拦截：${unmet} 项未达成（${unmetItems.slice(0, 300)}），转人工裁决`,
            ts: new Date().toISOString(), node_id: '', node_name: '',
            meta: { rolling: true, unmet_checklist: unmet },
          });
          return { ...result, status: 'waiting_approval', unmet_checklist: unmet };
        }
        return result; // 全部达成 → 正常 success 走合并后验收
      }

      // 4) 追加下一阶段子图并继续执行
      this.appendStageNodes(graph, decision.planned, decision.stage_goal, decision.checklist);
      await persistGraph(graph);
      await emitProgress('stage_started', { task_id: taskId, stage: graph.stage_count, stage_goal: decision.stage_goal });
      await appendJournal(taskId, 'orchestrator', {
        role: 'master', kind: 'round',
        text: `滚动规划：第 ${graph.stage_count} 阶段启动——${decision.stage_goal}（新增 ${decision.planned.nodes.length} 节点）`,
        ts: new Date().toISOString(), node_id: '', node_name: '',
        meta: { rolling: true, stage: graph.stage_count },
      });
      // 后续阶段继续跑（人类门/取消/失败都由 runGraph 内部守卫处理）
      result = await this.runGraph(taskId, graph, sandbox, policy);
      if (result.status !== 'success') return result;
    }
  }

  /** 把下一阶段的子图追加进任务图：节点 id 加阶段前缀防冲突，阶段根节点挂到上一阶段的合并节点之后 */
  private appendStageNodes(graph: TaskGraph, planned: PlannedGraph, stageGoal: string, checklist: ChecklistItem[]): void {
    const stage = (graph.stage_count || 1) + 1;
    const prefix = `s${stage}-`;
    const nodes = planned.nodes.map((n) => newNode({ ...n, id: prefix + n.id }, graph.task_id));
    const edges: [string, string][] = planned.edges.map(([a, b]) => [prefix + a, prefix + b]);
    const mergeId = `merge-s${stage}`;
    nodes.push(newNode({ id: mergeId, name: `${MERGE_NODE_NAME}（阶段${stage}）`, agent: 'orchestrator', complexity: 'simple', reason: `阶段${stage} 产物合并` }, graph.task_id));
    for (const n of nodes) {
      if (n.id !== mergeId && n.agent !== 'orchestrator') edges.push([n.id, mergeId]);
    }
    // 阶段根节点（阶段内无上游）依赖上一阶段的合并节点
    const prevMerge = stage === 2 ? 'merge-auto' : `merge-s${stage - 1}`;
    for (const n of nodes) {
      if (n.agent !== 'orchestrator' && !edges.some(([, d]) => d === n.id)) edges.push([prevMerge, n.id]);
    }
    graph.nodes.push(...nodes);
    graph.edges.push(...edges);
    graph.stage_count = stage;
    graph.stage = stage;
    graph.stage_goal = stageGoal;
    graph.stage_nodes = nodes.filter((n) => n.agent !== 'orchestrator').map((n) => n.id);
    graph.checklist = [...(graph.checklist || []), ...checklist];
    this.logger.info('rolling stage appended', { taskId: graph.task_id, stage, nodes: planned.nodes.length, checklist: checklist.length });
  }

  // ---------- DAG execution ----------

  private async runGraph(taskId: string, graph: TaskGraph, sandbox: string, policy: PermissionPolicy): Promise<Record<string, any>> {
    const upstream = new Map<string, string[]>();
    for (const node of graph.nodes) upstream.set(node.id, []);
    for (const [src, dst] of graph.edges) upstream.get(dst)?.push(src);

    // 并行加固（Phase 2，2026-09-16）：多任务并行时把模型池槽位均分给活跃任务——
    // 此前单任务 maxWorkers=全池总槽位可独占模型池，并行任务互相抢槽
    // （acquireWithWait 200ms 轮询 + 429 端点组避让）会放大限流风暴。单任务
    // floor(total/1)=total 行为不变。
    const totalSlots = this.pool ? this.pool.totalAvailable() : 2;
    const activeTasks = Math.max(1, this.activeTaskCount?.() ?? 1);
    const maxWorkers = Math.max(1, Math.floor(totalSlots / activeTasks));
    const inflight = new Set<Promise<void>>();
    let failedNode: TaskNode | null = null;

    // M1 连续调度：节点落地即收尾——STATUS_REPORT 同步、进度广播；失败节点立即 cancelDownstream，
    // 不再等"整波 Promise.all 跑完"才发现失败（旧波次制下下游白等一个波次）
    const onNodeSettled = async (node: TaskNode) => {
      await this.syncStatusReport(taskId, graph, sandbox);
      await emitProgress('progress_update', { task_id: taskId, progress: computeProgress(graph) });
      if (!failedNode && node.status === 'failed') {
        await this.cancelDownstream(graph, upstream, node.id);
        failedNode = node;
      }
    };

    const launch = (node: TaskNode) => {
      const p: Promise<void> = this.executeNode(taskId, graph, node, sandbox, maxWorkers, policy)
        .catch(() => {}) // executeNode 安全包裹保证节点必落终态；此处仅防意外 reject 击穿 race
        .then(() => onNodeSettled(node));
      inflight.add(p);
      void p.finally(() => {
        inflight.delete(p);
      });
    };

    while (!(await isCancelled(taskId)) && !failedNode) {
      const ready = graph.nodes.filter((node) => {
        if (node.status !== 'pending') return false;
        return (upstream.get(node.id) || []).every((dep) => this.statusOf(graph, dep) === 'completed');
      });

      const approvals = await getApprovals(taskId);
      const blocked = ready.filter((n) => n.requires_approval && !approvals.includes(n.id));
      const runnable = ready.filter((n) => !blocked.includes(n));
      for (const node of blocked) {
        await this.setNodeStatus(graph, node, 'waiting_approval', 'needs human approval');
        await emitProgress('node_waiting_approval', { task_id: taskId, node_id: node.id, name: node.name });
        notify('approval_required', { task_id: taskId, node_id: node.id }, `[Co-Team] 节点「${node.name}」等待人工审批`);
      }

      // 就绪即发射：槽位允许就启动，不等"整波就绪"（M1 连续调度——下游完成即刻解锁新节点）
      if (runnable.length > 0 && LEVEL_PROFILES[graph.level ?? 'standard'].docs && this.sandboxEnabled && sandbox !== graph.workspace) {
        // improvement 4: launch 前文档一致性检查——agents 必须读到最新 SSOT。
        // improvement 7: light 级任务不走文档管线，也不检查
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

      while (inflight.size < maxWorkers && runnable.length > 0) {
        launch(runnable.shift()!);
      }

      if (inflight.size === 0) break; // 无在飞且无就绪：进入终局守卫（waiting_* / success / cancelled）
      await Promise.race([...inflight]);
    }

    // 停止发射后立即释放所有阻塞问答（等待者按"任务已停止"收场，不再拖住 drain），
    // 然后等在飞节点全部落地再进终局守卫，保证状态完整
    await cancelAsks(taskId, '任务调度已停止').catch(() => {});
    if (inflight.size) await Promise.all([...inflight]);

    if (failedNode) {
      const failed = failedNode as TaskNode; // 闭包内赋值，TS 流分析不可见
      return { status: 'failed', node: failed.id, error: failed.error };
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
    // E21 guard：存在被取消的节点（upstream failed 连带）绝不是成功——完成数 ≠ 全部数时
    // 报 success 会把半截交付伪装成完整交付（2y3tuote：10/15 完成、merge 被取消仍 success）
    const cancelledNodes = graph.nodes.filter((n) => n.status === 'cancelled');
    if (cancelledNodes.length) {
      return {
        status: 'failed',
        error: `${cancelledNodes.length} 个节点未完成（上游失败被取消）：${cancelledNodes.map((n) => `${n.id}(${n.name})`).join('、')}`,
        completed: completed.length,
        total: graph.nodes.length,
        changes: this.collectChanges(graph.nodes),
      };
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

  /** M1 连续调度：STATUS_REPORT 同步从"波后"迁到"每节点落地后"调用（best effort）。 */
  private async syncStatusReport(taskId: string, graph: TaskGraph, sandbox: string): Promise<void> {
    if (!LEVEL_PROFILES[graph.level ?? 'standard'].docs) return;
    try {
      const done = graph.nodes.filter((n) => n.status === 'completed' && n.agent !== 'orchestrator').map((n) => n.name);
      const runningNow = graph.nodes.filter((n) => n.status === 'running' || n.status === 'retrying').map((n) => n.name);
      const pendingNow = graph.nodes.filter((n) => n.status === 'pending').map((n) => n.name);
      const docTarget = this.sandboxEnabled && sandbox !== graph.workspace ? sandbox : undefined;
      await writeDoc(taskId, 'STATUS_REPORT', buildStatusReport(graph.description, done, runningNow, pendingNow), 'orchestrator', docTarget);
    } catch { /* best effort */ }
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
    if (graph.self_ref === true) return true;
    try {
      const ws = path.resolve(graph.workspace || '');
      return ws.toLowerCase() === PROJECT_ROOT.toLowerCase();
    } catch {
      return false;
    }
  }

  /** Normalize a reported change entry ("path: desc" / "path") into a repo-relative path.
   *  先剥盘符前缀（d:/x.dart: 描述 若直接按 ':' 切会得到 'd'，豁免了 phantom 比对——假完成拦截 2026-09-17）。 */
  private normalizeReportedPath(entry: string): string {
    return (entry || '').replace(/^[a-zA-Z]:[\/\\]?/, '').split(':')[0].trim().replace(/\\/g, '/').replace(/^\.\//, '').toLowerCase();
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
  private async recordDeliveryCheck(graph: TaskGraph, node: TaskNode, sandbox: string, result: AgentResult): Promise<AgentResult['delivery_check'] | null> {
    try {
      if (!this.gitEnabled || !this.sandboxEnabled || sandbox === graph.workspace) return null;
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
      return result.delivery_check;
    } catch (e) {
      this.logger.debug?.('delivery check skipped', { taskId: graph.task_id, nodeId: node.id, error: String(e) });
      return null;
    }
  }

  /**
   * 假完成守卫（2026-09-16，o3xmkraj 实证）：429 限流风暴下 agent 抢不到写窗口却
   * "幻觉完成"——changes 申报的文件沙箱里不存在（两次复现：AiClient 账面 completed、
   * 分支无 lib/services/ai_client.dart），下游按申报等文件 → precondition blocker。
   * recordDeliveryCheck 已算出 phantom 但只记分；本守卫做分级裁决：
   * - 全 phantom（git 无实际变更且申报全缺失）→ 'fail'，调用点判节点失败转人工；
   * - 部分 phantom → 从 result.changes 剔除幻影条目（下游不再等不存在的文件），journal 审计。
   * orchestrator 合并节点无文件产出语义，跳过。
   */
  private applyPhantomGuard(taskId: string, graph: TaskGraph, node: TaskNode, result: AgentResult, delivery: NonNullable<AgentResult['delivery_check']>): 'fail' | 'ok' {
    if (node.agent === 'orchestrator') return 'ok';
    const phantom = delivery.phantom || [];
    if (!phantom.length) return 'ok';

    const phantomNorm = new Set(phantom.map((p) => this.normalizeReportedPath(p).toLowerCase()));
    const isPhantom = (entry: string) => {
      const p = String(entry).replace(/^[a-zA-Z]:[\/\\]?/, '').split(':')[0].trim().replace(/\\/g, '/').toLowerCase();
      if (!p) return false;
      return [...phantomNorm].some((ph) => ph === p || ph.endsWith('/' + p) || p.endsWith('/' + ph));
    };
    const before = (result.changes || []).length;
    if (result.changes) result.changes = result.changes.filter((c) => !isPhantom(c));
    const pruned = before - (result.changes || []).length;
    // 全 phantom = 申报条目经剔除后清零（SSOT 文档等未申报噪声不稀释判据——
    // 申报清单是下游的等待契约，全为幻影即假完成）
    const allPhantom = before > 0 && (result.changes || []).length === 0;
    const mode = allPhantom ? 'fail' : 'pruned';
    void emitProgress('node_phantom_detected', { task_id: taskId, node_id: node.id, node_name: node.name, agent: node.agent, phantom: phantom.slice(0, 10), mode });
    if (mode === 'fail') {
      this.logger.warn('Phantom completion intercepted', { taskId, nodeId: node.id, agent: node.agent, phantom: phantom.slice(0, 5) });
      return 'fail';
    }
    // 部分 phantom：剔除后照常交付（journal 留痕）
    void pruned;
    return 'ok';
  }

  /**
   * 假完成拦截·产物核查门（2026-09-17，ai_client.dart / 空申报两案例）：
   * 3a 规格点名核查——节点名点名的 lib/... 路径必须真实存在（fs 判定；git 显示已删除视同通过，
   * 覆盖"删除某文件"语义的节点）；
   * 3b 空申报空转核查——零申报 + 轮内零写盘 + git 实际零变更 + 无豁免说明（no_changes_reason）→ 违规。
   * 仅 parsed.status==='success' 时由调用点执行（模型已承认失败，不反向要求"补文件"）；
   * git 不可用优雅降级：status 失败 → 跳过 3b、3a 退化为纯 fs 判定——非 git 目录不误伤。
   */
  private async collectDeliveryViolations(node: TaskNode, workspace: string, parsed: Record<string, any>, midRunWritten: string[]): Promise<{ violations: string[]; specMissing: string[] }> {
    const violations: string[] = [];
    let specMissing: string[] = [];
    // 3a: 规格点名路径存在性
    const specPaths = extractSpecPaths(node.name);
    if (specPaths.length) {
      let deletedSet: Set<string> | null = null;
      try {
        const st = await simpleGit({ baseDir: workspace }).status();
        deletedSet = new Set([...(st.deleted || [])].map((p) => p.replace(/\\/g, '/').toLowerCase()));
      } catch { deletedSet = null; }
      specMissing = specPaths.filter((p) => {
        if (fs.existsSync(path.join(workspace, p))) return false;
        if (deletedSet?.has(p)) return false;
        return true;
      });
      if (specMissing.length) {
        violations.push(`规格点名的产物未落盘：${specMissing.slice(0, 3).join('、')}（用 write_file 真正写入工作区，别只在申报里写路径）`);
      }
    }
    // 3b: 空申报空转。midRunWritten 在闸后由 applyFinalOutput 并入申报——闸内需显式豁免，
    // 否则"写了文件忘申报"会被误拦；git status 失败（actual=null）跳过本核查。
    // 执行期自动落盘的协同文档（SSOT docs / global_goal）不算"实际改动"——否则
    // actual 恒 >0，守卫永不触发（实测：干净沙箱也带 3 个自动 md）。
    const AUTO_DOC_RE = /^(docs\/)?(task_spec|api_contract|status_report|global_goal)\.md$/i;
    const declared = [...(parsed.changes || []), ...(parsed.files || []).map((f: any) => f?.path)].filter(Boolean);
    const noReason = String(parsed.no_changes_reason || '').trim();
    if (declared.length === 0 && midRunWritten.length === 0 && !noReason) {
      let actual: number | null = null;
      try {
        const st = await simpleGit({ baseDir: workspace }).status();
        const all = [...st.modified, ...st.created, ...st.not_added, ...st.renamed.map((r: any) => r.to), ...st.deleted];
        actual = all.filter((p) => !AUTO_DOC_RE.test(String(p).replace(/\\/g, '/').toLowerCase())).length;
      } catch { actual = null; }
      if (actual === 0) {
        violations.push('零申报零改动却申报成功——若确有改动请用 changes 申报文件清单；若本节点确无需改动，请在最终 JSON 加 no_changes_reason 字段说明原因');
      }
    }
    return { violations, specMissing };
  }

  // ---------- single node ----------

  /** OBS-1 失败分型：把 node.error 归入结构化类别（供 /api/metrics 聚合失败构成） */
  private classifyNodeError(err: string): string {
    const e = err || '';
    if (e.startsWith(NODE_BUDGET_PREFIX)) return 'budget';
    // 假完成拦截（2026-09-17）：假完成/产物核查是内容失败——通用分支补分型后
    // 'other' 会走 infra 自动重排，这两类必须显式钉死 content 防止误重跑 3 次。
    // 用 includes 而非 startsWith：降级链耗尽后错误被 "all models failed(...)" 包装，
    // 原始前缀不再位于头部（tally 里仍可辨）。
    if (e.includes('假完成拦截') || e.includes('产物核查未通过')) return 'content';
    if (PRECONDITION_FAIL_RE.test(e)) return 'precondition';
    if (LEGIT_BLOCKER_RE.test(e)) return 'blocker';
    if (CONTEXT_OVERFLOW_RE.test(e)) return 'context_overflow';
    if (CAPACITY_RE.test(e)) return 'capacity';
    if (CONTENT_FAIL_RE.test(e)) return 'content';
    if (SYSTEM_DEFECT_RE.test(e)) return 'system';
    return 'other';
  }

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
      node.error_type = this.classifyNodeError(node.error);
      await persistGraph(graph).catch(() => {});
      await emitProgress('node_error', { task_id: taskId, node_id: node.id, name: node.name, agent: node.agent, error: node.error, error_type: node.error_type }).catch(() => {});
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

    // branch workflow: each agent works on its own branch off its dependencies。
    // P3 档级驱动：light 直接在 execWorkspace 执行（sandbox === graph.workspace）——
    // 绝不在用户仓库里切每节点分支，交付由任务末尾的 gitCommit 统一落任务分支
    const useBranch = this.branchWorkflow && this.gitEnabled && this.sandboxEnabled && sandbox !== graph.workspace;
    if (useBranch) {
      const parent = this.parentBranchFor(graph, node);
      const branch = `coteam/${node.id}-${node.agent}`;
      const ok = await gitTool.createNodeBranch(sandbox, branch, parent).catch(() => false);
      node.branch = ok ? branch : '';
      // 记录切出分支，节点完成后以此计算该节点的代码变更（diff 基准）
      node.branch_base = ok ? parent : '';
      // E25 多上游收敛：把其余上游兄弟分支全部并入本分支——只基于最后一个上游切出时，
      // 并行实现的兄弟节点产物不可见（g6704zpm：回归节点把已完成的四页判为占位符）
      if (ok) {
        const depBranches = graph.edges
          .filter(([, dst]) => dst === node.id)
          .map(([src]) => graph.nodes.find((n) => n.id === src)?.branch)
          .filter((b): b is string => !!b && b !== parent);
        if (depBranches.length) {
          const conv = await gitTool.mergeIntoCurrent(sandbox, depBranches).catch(() => null);
          if (conv?.conflicts.length) {
            this.logger.warn('upstream branch convergence conflicts (resolved with theirs)', { taskId, nodeId: node.id, conflicts: conv.conflicts });
            await appendJournal(taskId, plugin.name, {
              role: 'master', kind: 'round',
              text: `⚠ 上游分支收敛冲突 ${conv.conflicts.length} 个（${conv.conflicts.join('、')}），已以上游版本续合——动手前先核实相关文件版本`,
              ts: new Date().toISOString(), node_id: node.id, node_name: node.name,
              meta: { conflicts: conv.conflicts },
            });
            await emitProgress('branch_converge_conflict', { task_id: taskId, node_id: node.id, agent: plugin.name, conflicts: conv.conflicts });
          }
        }
      }
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
        const delivery = await this.recordDeliveryCheck(graph, node, sandbox, result);
        if (delivery && this.applyPhantomGuard(taskId, graph, node, result, delivery) === 'fail') {
          error = `假完成拦截：申报的 ${delivery.phantom.length} 个文件均未落盘（${delivery.phantom.slice(0, 3).join('、')}）——换模型重试或人工介入`;
          break;
        }

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
      // i6efv5h2 复盘：[env-defect]/[node-budget]/[precondition] 同理——重试、降级链、
      // 接管都改变不了事实，烧的是时间与冷却，必须在这里就停靠人工。
      const hardStop = error.startsWith(ENV_DEFECT_PREFIX) || error.startsWith(NODE_BUDGET_PREFIX) || error.startsWith(PRECONDITION_PREFIX);
      if (hardStop || /需要人类|需要人工|需要补充|信息不足|素材不足|无法完成|缺少.{0,6}(信息|权限)|cannot proceed|need human/i.test(error)) {
        const stopReason = error.startsWith(ENV_DEFECT_PREFIX)
          ? '系统/环境缺陷（重试不会好转，需修复设施或环境）'
          : error.startsWith(NODE_BUDGET_PREFIX)
            ? '节点总时长预算超线（模型慢或任务过大，请人工决定拆分或放宽预算）'
            : error.startsWith(PRECONDITION_PREFIX)
              ? '执行前置缺失（缺源码/信息，需人工补齐后重试）'
              : '需要人工补充信息';
        node.status = 'failed';
        node.finished_at = new Date().toISOString();
        node.error = `需人工介入（${stopReason}）：${error}`;
        node.result = { status: 'failed', error: node.error, summary: `节点停止（${stopReason}），未产出变更` };
        node.needs_human = true;
        // 人工门分型：车道不锁（taskQueue onFinished 保槽放行），等人在节点上"已处理，继续"
        node.error_type = 'human_gate';
        await saveDeliverable(taskId, node, LEVEL_PROFILES[graph.level ?? 'standard'].briefDeliverable).catch(() => {});
        await persistGraph(graph);
        await this.recordAgentLife(taskId, graph, node, false, 0);
        await emitProgress('node_error', { task_id: taskId, node_id: node.id, name: node.name, agent: node.agent, error: node.error });
        notify('node_needs_human', { task_id: taskId, node_id: node.id }, `[Co-Team] 节点「${node.name}」${stopReason}，已停止自动重试与接管：${error.slice(0, 80)}`);
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
        const delivery = await this.recordDeliveryCheck(graph, node, sandbox, result);
        if (delivery && this.applyPhantomGuard(taskId, graph, node, result, delivery) === 'fail') {
          // 主 Agent 接管后仍幻觉交付：无更多升级手段，停靠人工（error_type=content → 车道锁等人工决策）
          const msg = `假完成拦截：申报的 ${delivery.phantom.length} 个文件均未落盘（${delivery.phantom.slice(0, 3).join('、')}）——接管后仍幻觉交付，转人工`;
          node.status = 'failed';
          node.finished_at = new Date().toISOString();
          node.error = `需人工介入（假完成守卫）：${msg}`;
          // delivery_check 随节点结果落档——phantom 清单是人工排查的审计证据
          node.result = { status: 'failed', error: node.error, summary: '节点停止（假完成守卫），未产出变更', delivery_check: delivery };
          node.needs_human = true;
          node.error_type = 'content';
          await saveDeliverable(taskId, node, LEVEL_PROFILES[graph.level ?? 'standard'].briefDeliverable).catch(() => {});
          await persistGraph(graph);
          await this.recordAgentLife(taskId, graph, node, false, 0);
          await emitProgress('node_error', { task_id: taskId, node_id: node.id, name: node.name, agent: node.agent, error: node.error });
          notify('node_needs_human', { task_id: taskId, node_id: node.id }, `[Co-Team] 节点「${node.name}」假完成拦截（${delivery.phantom.length} 文件未落盘），转人工处理`);
          return;
        }
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
    // 假完成拦截（2026-09-17）：通用失败分支此前不写 error_type——taskQueue 把无分型
    // 一律当 content 锁道，模型池全灭/限流类本应 infra 自动重排自愈的失败也被锁死。
    // 与 crash 包装器（classifyNodeError 同款）口径对齐。
    if (!(node as any).error_type) node.error_type = this.classifyNodeError(node.error);
    node.needs_human = true;
    await saveDeliverable(taskId, node, LEVEL_PROFILES[graph.level ?? 'standard'].briefDeliverable).catch(() => {});

    this.logger.nodeFailed(taskId, node.id, node.agent, node.error);

    await persistGraph(graph);
    await this.recordAgentLife(taskId, graph, node, false, finalResult.tokens || 0);
    await emitProgress('node_error', { task_id: taskId, node_id: node.id, name: node.name, agent: node.agent, error: node.error });
    notify('node_needs_human', { task_id: taskId, node_id: node.id }, `[Co-Team] 节点「${node.name}」重试与接管均失败，需要人工介入`);
  }

  /** Shared success tail: persist result, commit branch, capture diff, bookkeeping.
   *  approve_required 策略下暂存的命令在节点完成的同时登记到任务级待审批队列。 */
  private async finalizeNodeSuccess(taskId: string, graph: TaskGraph, node: TaskNode, result: AgentResult, useBranch: boolean, sandbox: string, escalated: boolean): Promise<void> {
    const pendingCommands = ((result as Record<string, any>).pending_commands || []) as string[];
    if (pendingCommands.length) {
      // o3xmkraj 复盘：approve_required park 的命令此前不暂停任务——节点带着
      // "命令没跑"的状态照常完成，验证缺席、批准结果无处回流。挂起等人工，
      // 批准后命令结果回流会话、节点重置 pending 续跑（API 层重新入队）。
      // 注意：本节点未提交的 write_file 落盘会被任务收尾的 recovery reset 丢弃，
      // 续跑轮次会基于批准命令的真实输出重新生成——语义正确，代价是重做一遍。
      await this.registerPendingCommands(taskId, node, pendingCommands);
      node.status = 'waiting_approval';
      node.finished_at = new Date().toISOString();
      node.result = { status: 'waiting_approval', summary: `命令待人工审批后节点续跑：${pendingCommands.join('；').slice(0, 300)}`, changes: (result as Record<string, any>).changes || [] };
      node.error = '';
      await saveDeliverable(taskId, node, LEVEL_PROFILES[graph.level ?? 'standard'].briefDeliverable).catch(() => {});
      await persistGraph(graph);
      await emitProgress('node_waiting_approval', { task_id: taskId, node_id: node.id, name: node.name, agent: node.agent, commands: pendingCommands });
      notify('approval_required', { task_id: taskId, node_id: node.id }, `[Co-Team] 节点「${node.name}」命令待审批（${pendingCommands.length} 条），批准后自动续跑`);
      return;
    }
    node.status = 'completed';
    node.finished_at = new Date().toISOString();
    node.result = escalated ? { ...result, escalated: true } : result;
    node.error = '';
    await saveDeliverable(taskId, node, LEVEL_PROFILES[graph.level ?? 'standard'].briefDeliverable).catch(() => {});
    if (useBranch && node.branch) {
      // M2：全量提交节点工作树（不再依赖模型申报的 changes——漏报是常态，产物丢失才是灾难）
      const commit = await gitTool.commitAllOnBranch(sandbox, `coteam: ${node.name}${escalated ? ' (escalated)' : ''}`).catch(() => null);
      if (commit && node.result) (node.result as AgentResult).git_commit = { branch: node.branch, commit };
    } else if (useBranch && !node.branch) {
      // 分支缺失（创建失败）兜底：产物直提 base，绝不留在工作树等下一个节点 checkout 冲掉
      const docPaths = (((result as Record<string, any>).doc_updates || []) as { type: string }[]).map((u) => `docs/${u.type}.md`);
      if ((result.changes || []).length || docPaths.length) {
        await gitTool
          .commitChanges(sandbox, `coteam: ${node.name} (branchless fallback)`, [...(result.changes || []), ...docPaths])
          .catch(() => null);
      }
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
  async resolvePendingCommand(taskId: string, commandId: string, approved: boolean): Promise<{ ok: boolean; returncode?: number; node_resumed?: boolean }> {
    const graph = await loadGraph(taskId);
    if (!graph) throw new Error('Task graph not found');
    const key = `task:pending_commands:${taskId}`;
    const queue = (await busGet<{ id: string; node_id: string; node_name: string; command: string; ts: string }[]>(key)) || [];
    const idx = queue.findIndex((q) => q.id === commandId);
    if (idx === -1) throw new Error('pending command not found');
    const [item] = queue.splice(idx, 1);
    await busSet(key, queue);
    const node = graph.nodes.find((n) => n.id === item.node_id);

    if (!approved) {
      await appendJournal(taskId, 'orchestrator', {
        role: 'master',
        kind: 'error',
        text: `命令已拒绝（未执行）：${item.command}`,
        ts: new Date().toISOString(),
        node_id: item.node_id,
        node_name: item.node_name,
      });
      // o3xmkraj 复盘：拒绝后节点不能再悬在 waiting_approval——落 failed
      // （human_gate 分型：车道不锁，等人在任务上决定重试或放弃）
      if (node && node.status === 'waiting_approval') {
        node.status = 'failed';
        node.error_type = 'human_gate';
        node.needs_human = true;
        node.finished_at = new Date().toISOString();
        node.error = `命令被人工拒绝：${item.command}`;
        node.result = { status: 'failed', error: node.error, summary: '人工拒绝执行待批命令，节点未完成' };
        graph.status = 'failed';
        await persistGraph(graph);
      }
      await emitProgress('command_resolved', { task_id: taskId, command_id: item.id, approved: false, command: item.command });
      return { ok: true };
    }

    const policy = policyWithLevel(this.policy, graph.execution_policy);
    const result = await executeCommandAsync(item.command, graph.workspace || '.', policy);
    // 批准登记：节点续跑时若再次产出同一命令，直接放行执行（不再二次 park）
    const approvedKey = `task:approved_commands:${taskId}`;
    const approvedCmds = (await busGet<string[]>(approvedKey)) || [];
    if (!approvedCmds.includes(item.command)) {
      approvedCmds.push(item.command);
      await busSet(approvedKey, approvedCmds);
    }
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
    let nodeResumed = false;
    if (node && node.status === 'waiting_approval') {
      // 结果回流（o3xmkraj 复盘：批准后命令结果无处可去，agent 已离场）——
      // 写进该节点 agent 的会话历史，续跑轮次直接引用真实输出
      const sessionKey = `task:${taskId}:agent:${node.agent}:session`;
      const session = (await busGet<{ role: 'user' | 'assistant'; content: string }[]>(sessionKey)) || [];
      session.push({ role: 'user', content: `人工已批准并执行命令 \`${item.command}\`：\n退出码 ${result.returncode}\nstdout: ${result.stdout.slice(-1200) || '（无）'}\nstderr: ${result.stderr.slice(-800) || '（无）'}\n请基于以上真实结果继续完成本节点工作（文件用 write_file 渐进落盘）。` });
      await busSet(sessionKey, session.slice(-20));
      node.status = 'pending';
      node.result = null;
      node.error = '';
      await persistGraph(graph);
      nodeResumed = true;
    }
    await emitProgress('command_resolved', { task_id: taskId, command_id: item.id, approved: true, command: item.command, returncode: result.returncode, node_resumed: nodeResumed });
    return { ok: true, returncode: result.returncode, node_resumed: nodeResumed };
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

  /** 节点完成后立即固化其分支 diff（含测试修复轮提交），供任务频道随时查看，不依赖沙箱存活。 */
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
    // i6efv5h2 复盘：终局错误必须如实反映"几轮 × 哪些模型、各死于什么"，
    // 旧的 "(N tried): 末次错误" 掩盖了三种模型死于三种不同事实的真相
    const tally: string[] = [];
    // content failures (parse/schema/refusal) are usually not model-specific: retry the
    // SAME model once with the failure text as feedback before burning the fallback chain
    const sameModelRetries = new Map<string, number>();
    // 幻觉阻塞证据门：同模型对"零工具轮申诉"的重试计数（每模型一次，再犯沉底）
    const hallucinatedBlockers = new Map<string, number>();
    const capacityRetries = new Map<string, number>();
    // 上下文超限瘦身重试：整个 dispatch 至多折叠重试一次（prompt 是链上共享的，
    // 折叠一次对所有模型生效；仍超限就换更大窗口，不该反复折叠浪费轮次）
    let overflowFoldRetried = false;
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
      const attemptStartedAt = Date.now();
      try {
        const result = await this.callAgent(taskId, node, plugin, entry, workspace, escalate, lastErr || lastError, attemptLabel, policy, overflowFoldRetried);
        if (result.status === 'success') {
          const attemptMs = Date.now() - attemptStartedAt;
          if (this.slowSuccessMs > 0 && attemptMs > this.slowSuccessMs) {
            // 慢不是失败：只降权（本地慢模型与远程快模型混池的正确记账）
            this.pool.markSlow(entry);
            this.logger.warn('Model slow but usable', { taskId, nodeId: node.id, model: entry.name, attempt_sec: Math.round(attemptMs / 1000), slow_streak: (this.pool.getStatus()[entry.id] as Record<string, unknown> | undefined)?.slow_count });
            // OBS-1：慢成功可见——作战室 + 事件流
            const slowSec = Math.round(attemptMs / 1000);
            await emitProgress('model_slow', { task_id: taskId, node_id: node.id, model: entry.name, elapsed_sec: slowSec });
            await appendJournal(taskId, plugin.name, { role: 'master', kind: 'round', text: `🐌 ${entry.name} 慢成功（${slowSec}s），已降权`, ts: new Date().toISOString(), node_id: node.id, node_name: node.name });
          } else {
            this.pool.markSuccess(entry);
          }
          this.logger.agentResponse(taskId, node.id, plugin.name, result.tokens || 0);
          if (triedCount > 1) this.logger.info('Model degraded successfully', { taskId, nodeId: node.id, agent: plugin.name, tried: triedCount, finalModel: entry.name });
          return result;
        }
        // Failed result (content-level: parse/schema/refusal) — do NOT poison model health;
        // retry the same model once with feedback, then move down the chain
        lastErr = result.error || 'agent reported failure';
        tally.push(`${entry.name}: ${lastErr.slice(0, 120)}`);
        // 节点时长预算 / 前置缺失：换模型不会改变结局——立即终止阶梯转人工
        if (lastErr.startsWith(NODE_BUDGET_PREFIX)) {
          this.logger.warn('Node time budget exceeded — stopping ladder (not a model failure)', { taskId, nodeId: node.id, model: entry.name, error: lastErr });
          return { status: 'failed', error: lastErr, tokens: result.tokens };
        }
        if (PRECONDITION_FAIL_RE.test(lastErr)) {
          this.logger.warn('Precondition failure — stopping ladder, going straight to human', { taskId, nodeId: node.id, model: entry.name, error: lastErr });
          return { status: 'failed', error: `${PRECONDITION_PREFIX} ${lastErr}`, tokens: result.tokens };
        }
        if (LEGIT_BLOCKER_RE.test(lastErr)) {
          // 幻觉阻塞证据门（2026-09-17）：零工具轮 + 工具/权限类文案 → 判幻觉，
          // 不停阶梯：同模型重试一次（反馈注入），再犯 markFailure 沉底换下一候选；
          // 有工具轮的真阻塞维持原语义（环境问题换模型没用，停阶梯转人工）
          const zeroTools = (result.tool_rounds ?? 0) === 0;
          if (zeroTools && TOOLCLAIM_RE.test(lastErr)) {
            const hallucinated = hallucinatedBlockers.get(entry.name) ?? 0;
            if (hallucinated < 1) {
              hallucinatedBlockers.set(entry.name, hallucinated + 1);
              this.logger.warn('Hallucinated blocker (zero tool rounds) — same-model retry once', { taskId, nodeId: node.id, model: entry.name, error: lastErr.slice(0, 120) });
              await appendJournal(taskId, plugin.name, { role: 'master', kind: 'round', text: `🚫 ${entry.name} 零工具轮即申诉「${lastErr.slice(0, 80)}」——判幻觉阻塞（工具链可用），同模型重试一次`, ts: new Date().toISOString(), node_id: node.id, node_name: node.name });
              ci--;
              continue;
            }
            this.logger.warn('Hallucinated blocker repeated — sinking model, next candidate', { taskId, nodeId: node.id, model: entry.name, error: lastErr.slice(0, 120) });
            this.pool.markFailure(entry);
            await emitProgress('model_failover', { task_id: taskId, node_id: node.id, from: entry.name, to: chain[ci + 1]?.name ?? '', reason: '幻觉阻塞（零工具轮申诉）', error: String(lastErr).slice(0, 160) });
            await appendJournal(taskId, plugin.name, { role: 'master', kind: 'round', text: `↯ ${entry.name} 幻觉阻塞再犯（零工具轮申诉），沉底换下一候选`, ts: new Date().toISOString(), node_id: node.id, node_name: node.name });
            continue;
          }
          this.logger.warn('Legitimate blocker reported by model — stopping ladder (environment issue, not model failure)', { taskId, nodeId: node.id, model: entry.name, error: lastErr.slice(0, 120) });
          return { status: 'failed', error: lastErr, tokens: result.tokens };
        }
        this.logger.warn('Model returned failure, trying next', { taskId, nodeId: node.id, agent: plugin.name, model: entry.name, error: lastErr });
        // M4：思考耗尽（finish=length 正文空）是该模型的稳定特性而非偶发内容坏——
        // 计入健康度，让 effectivePriority 把它软沉底（2y3tuote：sensenova/glm 十次耗尽
        // 因走 content 路径从不记账，每个节点继续首撞）。
        if (/输出预算耗尽|finish_reason=length/.test(lastErr)) this.pool.markFailure(entry);
        const retried = sameModelRetries.get(entry.name) ?? 0;
        if (CONTENT_FAIL_RE.test(lastErr) && retried < 1) {
          sameModelRetries.set(entry.name, retried + 1);
          ci--;
          continue;
        }
      } catch (e: any) {
        lastErr = String(e).slice(0, 500);
        // 任务取消（abort 打断流）：不记账不换模，直接收场（isCancelled 检查接管后续清理）
        if (lastErr.includes('外部取消')) {
          return { status: 'failed', error: 'task cancelled' };
        }
        // 流内节点预算到线（wallclock_cap）：时间问题换谁都一样——停阶梯转人工，不记模型失败
        if (lastErr.includes('wallclock_cap')) {
          lastErr = `${NODE_BUDGET_PREFIX} 本节点单轮流内耗时超出总预算（${lastErr.slice(0, 140)}）`;
          this.logger.warn('Node time budget exceeded in-stream — stopping ladder', { taskId, nodeId: node.id, model: entry.name });
          await appendJournal(taskId, plugin.name, { role: 'agent', kind: 'error', text: lastErr, ts: new Date().toISOString(), node_id: node.id, node_name: node.name, model: entry.name });
          return { status: 'failed', error: lastErr };
        }
        if (String(e?.message).includes('token budget')) {
          this.logger.error('Token budget exceeded', { taskId, nodeId: node.id });
          return { status: 'failed', error: 'token budget exceeded for this task' };
        }
        lastErr = String(e).slice(0, 500);
        tally.push(`${entry.name}: ${lastErr.slice(0, 120)}`);
        // 系统缺陷（fs 异常等）：重试必复发——不计模型健康度、不烧阶梯，直接转人工
        if (SYSTEM_DEFECT_RE.test(lastErr)) {
          this.logger.error('System defect (harness/env), NOT counting model health', { taskId, nodeId: node.id, model: entry.name, error: lastErr });
          return { status: 'failed', error: `${ENV_DEFECT_PREFIX} ${lastErr}` };
        }
        // 上下文超限（413）：不是模型的错（不记健康）、换模也不解决（请求体没变）——
        // 先折叠历史瘦身同模型重试一次；仍超限说明请求本体就超过该模型窗口，
        // 剩余链按 context_length 降序重排（大窗口优先），全超窗才转人工
        if (CONTEXT_OVERFLOW_RE.test(lastErr)) {
          if (!overflowFoldRetried) {
            overflowFoldRetried = true;
            this.logger.warn('Context overflow (413) — folding history and retrying same model', { taskId, nodeId: node.id, model: entry.name, error: lastErr });
            await emitProgress('llm_overflow', { task_id: taskId, node_id: node.id, model: entry.name, action: 'fold_retry', error: lastErr.slice(0, 120) });
            await appendJournal(taskId, plugin.name, {
              role: 'master', kind: 'round',
              text: `📦 ${entry.name} 上下文超限（413），折叠历史瘦身重试——不是模型故障`,
              ts: new Date().toISOString(), node_id: node.id, node_name: node.name,
            });
            ci--;
            continue;
          }
          const rest = chain.slice(ci + 1).sort((a, b) => (b.context_length ?? 0) - (a.context_length ?? 0));
          chain.splice(ci + 1, chain.length - ci - 1, ...rest);
          this.logger.warn('Context overflow persists after fold — reordering rest of chain by larger context window', { taskId, nodeId: node.id, model: entry.name, rest: rest.map((m) => m.name).slice(0, 3) });
          await emitProgress('llm_overflow', { task_id: taskId, node_id: node.id, model: entry.name, action: 'larger_window', error: lastErr.slice(0, 120) });
          continue; // 跳过该模型但不 markFailure：窗口装不下≠模型无能
        }
        // M3：限流类错误退避重试同模型（tpm 窗口分钟级自愈），不记模型失败不烧链
        if (CAPACITY_RE.test(lastErr)) {
          const capTried = capacityRetries.get(entry.name) ?? 0;
          if (capTried < 2) {
            capacityRetries.set(entry.name, capTried + 1);
            const backoffMs = 20_000 * (capTried + 1);
            this.logger.warn('Model capacity limited (429) — backing off same model, health untouched', { taskId, nodeId: node.id, model: entry.name, backoff_sec: backoffMs / 1000, attempt: capTried + 1 });
            // OBS-1：限流退避可见（此前只写日志，用户看作战室只觉"卡住"）
            const backoffSec = Math.round(backoffMs / 1000);
            await emitProgress('llm_backoff', { task_id: taskId, node_id: node.id, model: entry.name, backoff_sec: backoffSec, attempt: capTried + 1 });
            await appendJournal(taskId, plugin.name, { role: 'master', kind: 'round', text: `⏳ ${entry.name} 限流（429），${backoffSec}s 后自动重试（第 ${capTried + 1}/2 次）——不是卡住`, ts: new Date().toISOString(), node_id: node.id, node_name: node.name });
            await new Promise((r) => setTimeout(r, backoffMs));
            ci--; // 重试同一模型
            continue;
          }
          this.logger.warn('Model capacity limit persists after backoffs — skipping without health penalty', { taskId, nodeId: node.id, model: entry.name });
          continue; // 跳过该模型但不 markFailure：容量≠无能
        }
        this.logger.error('Agent dispatch failed', {
          taskId,
          nodeId: node.id,
          agent: plugin.name,
          model: entry.name,
          error: lastErr
        });
        // 确定性模型侧失败（连接死亡/真停滞）——计入模型健康度
        this.pool.markFailure(entry);
        // OBS-1：降级链可见。B6（2026-09-17）：payload 补 from/to/reason——此前只带
        // model 名，双端映射显示 "? → ?"，用户既看不到从谁切到谁、也不知道为什么切
        const failoverReason = CAPACITY_RE.test(lastErr) ? '限流'
          : /ECONN|ECONNRESET|ETIMEDOUT|timeout|socket|fetch failed|stream|停滞|连接/i.test(lastErr) ? '连接失败/流停滞'
          : '执行失败';
        await emitProgress('model_failover', { task_id: taskId, node_id: node.id, from: entry.name, to: chain[ci + 1]?.name ?? '', reason: failoverReason, model: entry.name, error: String(lastErr).slice(0, 160) });
        await appendJournal(taskId, plugin.name, { role: 'master', kind: 'round', text: `↯ ${entry.name} 失败（${String(lastErr).slice(0, 80)}），切换下一候选`, ts: new Date().toISOString(), node_id: node.id, node_name: node.name });
      } finally {
        this.pool.release(entry);
      }
    }
    return {
      status: 'failed',
      error: `all models failed (${triedCount} 次尝试 / 链 ${chain.map((e) => e.name).join('→')}): ${tally.join(' ｜ ') || lastErr || 'unknown'}`.slice(0, 900),
    };
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
    policy: PermissionPolicy = this.policy,
    aggressiveFold = false
  ): Promise<AgentResult> {
    const context = await this.upstreamContext(taskId, node);
    // 协作可视化（2026-09-16）：上游→下游的接力此前只注入提示词、界面完全无感知——
    // 首次尝试时落一条作战室记录 + node_handoff 事件（重试/接管/换模不重复刷屏）
    if (context.trim() && !lastError) {
      await appendJournal(taskId, plugin.name, {
        role: 'agent', kind: 'handoff',
        text: `↳ 接力上游：${context.replace(/\n/g, ' ').slice(0, 300)}`,
        ts: new Date().toISOString(), node_id: node.id, node_name: node.name,
        meta: { handoff: context.slice(0, 2000) },
      });
      await emitProgress('node_handoff', { task_id: taskId, node_id: node.id, node_name: node.name, agent: plugin.name, handoff: context.slice(0, 1000) });
    }
    // M2 实时问答：登记本 agent 在执行中——ask_agent 据此选择"实时投递"还是"图外咨询"
    const activeKey = `${taskId}:${plugin.name}`;
    this.activeAgents.set(activeKey, (this.activeAgents.get(activeKey) || 0) + 1);
    // B3a/B3b: recon rounds and visible file list scale with node complexity —
    // complex nodes get more tool rounds and a wider view of the workspace.
    // 轮次预算（g6704zpm 实证上调）：分段读取大文件等"合并侦查"要消耗轮次，
    // 旧值 5 让实现节点"读完没空写"——模型被迫在证据不足时盲写或上报
    const maxRounds = node.complexity === 'complex' ? 12 : node.complexity === 'simple' ? 4 : 8;
    // 缓存优先裁剪：预算内的确定性目录树替代 flat 全量清单（同树同字节，前缀可缓存）
    const workspaceFiles = renderWorkspaceTree(workspace, this.contextCfg.workspace_tree_max_chars);
    // i6efv5h2 复盘：max_tokens 不再无脑取模型上限（128000）——超大输出预算让本地
    // 推理服务超额预留 KV、让慢模型的完成时间没有上界；按复杂度分档，模型配置仅封顶
    const tierCap = this.outputTiers
      ? this.outputTiers[node.complexity === 'complex' ? 'complex' : node.complexity === 'simple' ? 'simple' : 'normal']
      : undefined;
    // o3xmkraj 复盘：思考随任务深度膨胀（实测同节点 8k 档烧 8k、32k 档烧 38k），
    // 固定档位会让"思考+正文"挤爆单轮。动态预算：档位为基座按轮次阶梯放大（×2/轮，
    // 封顶模型上限与 128k）——早轮维持小预算守 KV 约束（i6efv5h2），深轮给足思考空间。
    const baseBudget = tierCap ? Math.min(entry.max_tokens ?? 128000, tierCap) : entry.max_tokens ?? 128000;
    const roundBudgetFor = (round: number): number =>
      Math.min(entry.max_tokens ?? 128000, Math.min(baseBudget * Math.pow(2, round), 128000));
    // M7 折叠线按模型上下文窗口动态化（P2.2 四级水位线改造）：
    //   0.50w snip（工具结果掐头去尾，免费）→ 0.62w elide（占位符化）→ 0.72w 断崖折叠 → 0.90w 物理上限
    // 便宜的本地改写先扛，付费/不可逆的动作留在高水位；每尝试至多折叠一次+确定性改写原则不变。
    const ctxWindow = (entry as any).context_length ?? 0;
    const baseWindow = ctxWindow > 0 ? ctxWindow : this.contextCfg.max_prompt_tokens * 4;
    const snipLimit = Math.floor(baseWindow * 0.5);
    const elideLimit = Math.floor(baseWindow * 0.62);
    let foldLimit = ctxWindow > 0 ? Math.min(Math.floor(ctxWindow * 0.72), ctxWindow - 4096) : this.contextCfg.max_prompt_tokens;
    if (node.complexity === 'complex') {
      foldLimit = Math.floor(foldLimit * 1.5);
    }
    // 节点级总时长预算：原 plugin.timeout 的单调用绞杀语义已废除（时长不判死），
    // 现在只在轮次之间检查"整个节点是否跑得过久"，超线转人工而不是记模型失败
    const nodeBudgetMs = plugin.timeout && plugin.timeout > 0 ? plugin.timeout * 1000 : 0;

    const escalationBlock = escalate
      ? `\n\n## 重要：主 Agent 接管\n该任务之前已尝试 ${this.maxRetries} 次均失败，最近一次错误：${lastError}\n请调整策略：换一种实现思路，或把任务范围缩小到可完成的最小闭环，确保本次成功。`
      : '';

    // improvement 8: non-escalated retries carry the previous failure / fix prompt so
    // the agent repairs the actual problem instead of repeating the same attempt
    const fixContextBlock = !escalate && lastError ? `\n\n## 上一次尝试的问题（请针对性修复）\n${lastError.slice(0, 1800)}` : '';

    // per-agent life: cross-task lessons ride along in the system prompt
    const memories = await getAgentMemory(plugin.name, 5);
    // project mode: the project's own rules & lessons make agents productive immediately
    const graphMeta = await getTaskGraph(taskId);
    const projectId = graphMeta?.project_id;
    // M7 修正（回归 mv4yq6n0 实证）：真实工作区路径注入——launcher 原提示词一直预期这一行
    // 但实现从未提供，走查节点因此申报"缺少项目真实绝对路径"合法 blocker。现在补上。
    const realWorkspaceBlock = this.sandboxEnabled && graphMeta?.workspace && graphMeta.workspace !== workspace
      ? `\n真实工作区路径: ${graphMeta.workspace}（任务成功合并后产物落在该路径；沙箱内验证用工作目录即可）`
      : '';
    const projectMemory = projectId ? await getProjectMemory(projectId, 8) : [];
    // P1.1 项目简报注入：brief（LLM 初稿+人工编辑）为概念基准；无简报时退化注入结构化字段
    const projectRec = projectId ? await getProject(projectId).catch(() => null) : null;
    const projectBriefLines: string[] = [];
    if (projectRec?.brief) {
      projectBriefLines.push(projectRec.brief.slice(0, 2000));
    } else if (projectRec) {
      if (projectRec.tech_stack) projectBriefLines.push(`技术栈：${projectRec.tech_stack}`);
      if (projectRec.conventions) projectBriefLines.push(`约定：${projectRec.conventions}`);
      if (projectRec.domain) projectBriefLines.push(`领域：${projectRec.domain}`);
      if (projectRec.stage) projectBriefLines.push(`阶段：${projectRec.stage}`);
    }
    const projectBlock = (projectBriefLines.length
      ? '\n\n## 项目简报（本项目的概念基准，与现场冲突时以实际侦查为准）\n' + projectBriefLines.join('\n\n')
      : '')
      + (projectMemory.length
        ? '\n\n## 本项目开发规范与经验\n' + projectMemory.map((m) => '- ' + m.text).join('\n')
        : '');

    // improvement 9: the global goal rides along with every agent call
    // 缓存优先裁剪：goal 全文（可能是整份规划方案）曾是每次调用的固定重税，截断为
    // 预算内摘要 + 指向工作区内的全文文件，需要精确边界时模型用 read_file 自取
    const goal = await busGet<{ content: string }>(`task:goal:${taskId}`);
    const goalFull = (goal?.content || '').trim();
    const goalShown = goalFull.length > this.contextCfg.goal_max_chars
      ? `${goalFull.slice(0, this.contextCfg.goal_max_chars)}\n…（目标全文 ${goalFull.length} 字已截断；全文见工作目录 GLOBAL_GOAL.md 或任务详情，需要精确对齐时用 read_file 查阅）`
      : goalFull;
    const goalBlock = goalShown
      ? `\n\n## 全局目标（所有工作必须服务于此目标）\n${goalShown}\n在 summary 的开头用一句话说明本次工作对全局目标的贡献。`
      : '';

    // improvement 4: SSOT documents available in docs/
    const docsBlock = await docsSection(taskId);

    // improvement 3: relevant knowledge base entries are injected for immediate reuse
    // M7 知识注入按角色加权：角色关键词并入检索查询，让 review/test 拿到各自相关的经验
    const roleKeywords: Record<string, string> = {
      review: '代码审查 质量 缺陷', test: '测试 验证 用例', 'front-dev': '前端 页面 UI',
      dev: '实现 接口', deploy: '部署 环境', launcher: '启动 运行 服务', docs: '文档', refactor: '重构',
    };
    const knowledgeHits = await relevantKnowledge(`${node.name} ${context} ${roleKeywords[plugin.name] || ''}`, { project_id: projectId, limit: 5 });
    // OBS-1 经验闭环度量：命中即计数（hits/last_hit_at 落盘知识条目）
    if (knowledgeHits.length) { try { recordKnowledgeHits(knowledgeHits.map((k) => k.id)); } catch { /* best effort */ } }
    // PH.7 防注入：指令词黑名单过滤 + 数据标签包裹——条目是模型/用户可控内容，不可当指令
    // P2.3b：片段 200→400 字符 + 指引 knowledge_search 取全文
    const safeHits = knowledgeHits.filter((k) => isSafeForInjection(k.title) && isSafeForInjection(k.content));
    const knowledgeBlock = safeHits.length
      ? `\n\n## 相关知识库条目\n${KNOWLEDGE_DATA_TAG_OPEN}\n${safeHits.map((k) => `- 【${k.title}】${k.content.slice(0, 400)}`).join('\n')}${KNOWLEDGE_DATA_TAG_CLOSE}\n（片段仅供索引——需要某条的完整内容时用 knowledge_search 工具按标题检索取全文）`
      : '';

    // harness (执行骨架): layered system prompt replacing the flat block concatenation —
    // identity / non-negotiable rules / context / workflow / tool policy / output contract / escalation
    // skill system: bound + auto-matched skills ride inside the harness context block
    const picks = pickSkillsForNode(getSkills(), plugin as any, node.name);
    const skillsBlock = formatSkillsBlock(picks);
    if (picks.length) {
      this.logger.info('Skills loaded for node', { taskId, nodeId: node.id, agent: plugin.name, skills: picks.map((p) => `${p.skill.name}(${p.reason})`) });
    }
    // 外部 MCP 工具清单：按 agent 白名单确定性渲染（字节稳定，前缀缓存友好）；无绑定返回空
    const mcpBlock = this.mcp ? this.mcp.toolsIndex(plugin.name) : '';
    // 原生 function calling（opencode/ZCode 同款工具通道，2026-09-20）：工具轮走供应商
    // tool_calls 字段而非正文 JSON；llm.native_tools=false 时整体回退 JSON 文本契约
    const nativeTools = nativeToolsOn();
    const orchTools = nativeTools ? buildOrchTools({ mcp: this.mcp ?? undefined, agent: plugin.name }) : undefined;
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
      mcpBlock: mcpBlock && !nativeTools ? mcpBlock : undefined,
      round: 0,
      maxRounds,
      escalate,
      lastError,
      nativeTools,
    });

    // improvement 6 (R1) + 群聊化：pending 用户消息在 userMsg 构建前消费，
    // 以三分支模板注入（核实→跳过/执行/接力，强制 reply_to_user 回应）
    const interventions = await consumeInterventions(taskId);
    const interveneBlock = interventions.length
      ? `\n\n${INTERVENE_TEMPLATE}\n${interventions.map((m, i) => `${i + 1}. ${m.message}`).join('\n')}`
      : '';

    // improvement #4 (C4): deferred agent-to-agent messages consumed here so the
    // recipient answers them in this dispatch (mirrors the interventions contract)
    const agentMessages = await consumeAgentMessages(taskId, plugin.name);
    // 协作可视化（2026-09-16）：收件侧此前纯提示词注入、界面无感知——每条留言落
    // 作战室记录 + 事件，让"发送→接收→接力"在战况室形成完整可见链路
    for (const m of agentMessages) {
      await appendJournal(taskId, plugin.name, {
        role: 'agent', kind: 'message_received',
        text: `收到来自 ${m.from} 的留言：${String(m.text || '').slice(0, 200)}`,
        ts: new Date().toISOString(), node_id: node.id, node_name: node.name,
        meta: { from: m.from, text: String(m.text || '') },
      });
      await emitProgress('agent_message', { task_id: taskId, node_id: node.id, node_name: node.name, agent: plugin.name, kind: 'received', from: m.from });
    }
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

    // M7 角色差异化上下文裁剪：review 看完整 diff、test 看测试资产索引，其余角色维持统一模板
    let roleBlock = '';
    if (plugin.name === 'review') {
      const d = gitDiffFull(workspace);
      if (d.ok && d.diff && d.diff !== '(no changes)') {
        roleBlock = `\n\n## 当前分支完整代码变更（审查输入）\n\`\`\`diff\n${d.diff}\n\`\`\``;
      }
    } else if (plugin.name === 'test') {
      roleBlock = `\n\n## 既有测试资产索引\n${listTestAssets(workspace)}`;
    }

    const userMsg = [
      `工作目录: ${workspace}`,
      realWorkspaceBlock,
      `现有文件树:\n${workspaceFiles}`,
      `任务: ${node.name}`,
      node.goal_link ? `对全局目标的贡献: ${node.goal_link}` : '',
      `节点复杂度: ${node.complexity}`,
      context ? `前置节点成果:\n${context}\n` : '',
      roleBlock,
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
    // 413 瘦身重试（2026-09-15）：出发前先断崖折叠一次（会话历史是超限最常见来源），
    // 折叠线减半让轮内压缩更早触发；纯历史不足折叠时由"更大窗口模型重排"兜底（dispatch 侧）
    if (aggressiveFold && foldMessagesInto(messages)) {
      foldLimit = Math.floor(foldLimit / 2);
      this.logger.info('Aggressive pre-fold applied (413 slimming retry)', { taskId, nodeId: node.id, model: entry.name, fold_limit: foldLimit });
    }

    // 观测（i6efv5h2 复盘：44k token 单轮请求里没人知道谁贡献了多少）：
    // 分段尺寸写进会话存档，供直方图校准 context 预算
    record.prompt_profile = {
      system_chars: systemMsg.length,
      session_msgs: compacted.length,
      session_chars: compacted.reduce((s, m) => s + m.content.length, 0),
      user_chars: userMsg.length,
      skills_indexed: picks.length,
      knowledge_hits: knowledgeHits.length,
      max_output_tokens: baseBudget,
      est_base_tokens:
        estimateTokens(systemMsg) + estimateTokens(userMsg) + estimateTokens(compacted.map((m) => m.content).join('')),
    };
    this.logger.info('Prompt profile', {
      taskId,
      nodeId: node.id,
      agent: plugin.name,
      model: entry.name,
      ...record.prompt_profile,
    });

    // war-room journal: master briefing
    await appendJournal(taskId, plugin.name, {
      role: 'master', kind: 'brief', text: userMsg, ts: new Date().toISOString(), node_id: node.id, node_name: node.name, model: entry.name,
    });
    // war-room journal: trace which interventions were injected into this node
    // 送达回执只陈述事实（送达/轮次），不替 agent 表态——真实性纪律
    const consumedForAttempt: { message: string }[] = [...interventions];
    let attemptSucceeded = false;
    if (interventions.length) {
      await appendJournal(taskId, plugin.name, {
        role: 'master',
        kind: 'intervene',
        text: `已送达节点 ${node.name}（第 1 轮注入，${interventions.length} 条）`,
        ts: new Date().toISOString(),
        node_id: node.id,
        node_name: node.name,
        meta: { delivered: { node_id: node.id, round: 1 }, interventions: interventions.map((m) => m.message) },
      });
      await emitProgress('intervention_injected', { task_id: taskId, node_id: node.id, agent: plugin.name, count: interventions.length, round: 1 });
      this.logger.info('User interventions injected into agent round', { taskId, nodeId: node.id, agent: plugin.name, count: interventions.length });
    }
    await emitProgress('agent_activity', { task_id: taskId, node_id: node.id, agent: plugin.name, text: '接收任务简报', model: entry.name });

    try {
      let parsed: Record<string, any> | null = null;
      let content = '';
      let parseErrorLogged = false;
      // 2.1 生成直播（2026-09-15）：token 级 delta 节流广播——此前一轮 LLM 生成期间
      // （几分钟级）作战室完全静默，是"扔下去只能等"的最大来源。onDelta 是旁路读取，
      // 不进消息数组、不影响前缀缓存。1s 节流 ≈ 每分钟 ≤60 条护栏。
      let deltaBuf = '';
      let lastDeltaAt = 0;
      let firstDeltaSent = false;
      const onDelta = (delta: string) => {
        if (!firstDeltaSent) {
          firstDeltaSent = true;
          void emitProgress('agent_first_token', { task_id: taskId, node_id: node.id, agent: plugin.name, model: entry.name });
        }
        deltaBuf += delta;
        const now = Date.now();
        if (now - lastDeltaAt >= 1000) {
          lastDeltaAt = now;
          const text = deltaBuf.slice(-200);
          void emitProgress('agent_delta', { task_id: taskId, node_id: node.id, agent: plugin.name, model: entry.name, text });
        }
      };
      // improvement #4: SSOT docs this agent updated via write_doc during this dispatch
      const docUpdates: { type: string; version: number }[] = [];
      // 渐进落盘（o3xmkraj 复盘）：轮内 write_file/edit_file 落盘的文件，合并进最终
      // changes 申报——交付一致性检查以"申报 vs 实际"对账，漏了就被标 unreported
      const midRunWritten: string[] = [];
      // 缓存优先裁剪：断崖压缩每尝试至多一次（触发后重新 append-only，不逐轮重写历史）
      let foldedOnce = false;
      // 空正文快速失败计数（o3xmkraj 节点4 实测：连续 4 轮秒回 completion=0，
      // 修正循环全白烧）——连续 2 轮非 length 的空正文判模型确定性故障，直接换模
      let emptyRounds = 0;
      // 重复调用指针化：同工具+同参数不再读盘回显
      const seenToolCalls = new Map<string, number>();
      // 幻觉阻塞证据门（2026-09-17）：本尝试实际执行过工具的轮数——"缺工具/权限"申诉
      // 只有在零工具轮时才可能是真阻塞；有工具轮说明工具链可用，申诉是幻觉
      let toolRounds = 0;
      // PH.3 确定性进展熔断：进展只认 mutation/证据哈希变化/新读取签名，绝不读模型说了什么
      const progressGuard = new TurnProgressGuard();
      const evidence = new EvidenceLedger();
      let lastObs: ProgressObservation | null = null;
      for (let round = 0; round < maxRounds; round++) {
        // Check for cancellation before each LLM call
        if (await isCancelled(taskId)) {
          return { status: 'failed', error: 'task cancelled', tokens: record.tokens };
        }
        // PH.3：先观察上一轮的确定性进展，再决定是否发下一次 LLM 请求——
        // 连续 6 轮零进展（无写盘、无新结果、无新读取）即熔断，不再陪跑空转
        if (round > 0) {
          progressGuard.observe(lastObs ?? emptyObservation());
          if (progressGuard.shouldAbort()) {
            const err = `无进展熔断：连续 ${progressGuard.stalled} 轮没有任何真实进展（无文件写入、无新工具结果、无新读取）——判定为确定性空转，停止本节点避免继续烧预算`;
            record.error = err;
            await appendJournal(taskId, plugin.name, { role: 'agent', kind: 'error', text: err, ts: new Date().toISOString(), node_id: node.id, node_name: node.name, model: entry.name });
            await emitProgress('agent_final', { task_id: taskId, node_id: node.id, agent: plugin.name, model: entry.name, ok: false, summary: err });
            return { status: 'failed', error: err, tokens: record.tokens, tool_rounds: toolRounds };
          }
        }
        // 节点级总时长预算（轮间检查；超线转人工，不记模型失败、不换模型——时间问题换谁都一样）
        if (nodeBudgetMs > 0 && Date.now() - startedAt > nodeBudgetMs) {
          const spent = Math.round((Date.now() - startedAt) / 1000);
          record.error = `${NODE_BUDGET_PREFIX} 本节点已执行 ${spent}s，超出总预算 ${Math.round(nodeBudgetMs / 1000)}s（进行到第 ${round + 1}/${maxRounds} 轮）`;
          await appendJournal(taskId, plugin.name, { role: 'agent', kind: 'error', text: record.error, ts: new Date().toISOString(), node_id: node.id, node_name: node.name, model: entry.name });
          await emitProgress('agent_final', { task_id: taskId, node_id: node.id, agent: plugin.name, model: entry.name, ok: false, summary: record.error });
          return { status: 'failed', error: record.error, tokens: record.tokens };
        }
        // 动态输出预算：本轮可用输出 = 档位基座 × 2^轮次（封顶模型上限/128k）
        const roundBudget = roundBudgetFor(round);
        // 流内节点预算墙钟（2026-09-16）：把节点剩余预算作为本轮 LLM 调用的墙钟上限
        // 传入 chat——此前预算只在轮间检查，慢滴流（每字节都算活动）单轮可挂 30-50 分钟
        const nodeCapMs = nodeBudgetMs > 0 ? Math.max(2000, nodeBudgetMs - (Date.now() - startedAt)) : undefined;
        await emitProgress('agent_activity', {
          task_id: taskId, node_id: node.id, agent: plugin.name,
          text: `第 ${round + 1} 轮对话中…`, model: entry.name,
        });
        const resp = await chat(entry, messages, roundBudget, escalate ? 0.3 : 0, this.taskSignals.get(taskId)?.signal, nodeCapMs, onDelta, orchTools ? { tools: orchTools } : undefined);
        this.pool!.recordUsage(entry.id, resp.promptTokens, resp.completionTokens);
        this.taskTokens.set(taskId, (this.taskTokens.get(taskId) || 0) + resp.promptTokens + resp.completionTokens);
        record.tokens += resp.promptTokens + resp.completionTokens;
        // 缓存命中观测：服务端回传 cached_tokens 时记录（vLLM APC / LM Studio prompt cache）
        this.logger.info('LLM round telemetry', {
          taskId,
          nodeId: node.id,
          model: entry.name,
          round: round + 1,
          max_tokens: roundBudget,
          prompt_tokens: resp.promptTokens,
          cached_tokens: resp.cachedTokens ?? null,
          completion_tokens: resp.completionTokens,
          first_token_ms: resp.firstTokenMs ?? null,
          elapsed_ms: resp.elapsedMs,
        });
        content = stripCodeFence(resp.content);
        // 空正文快速失败：非 length 的空正文（秒回 completion=0 类）连发 2 轮 → 模型
        // 确定性故障直接换模，不烧修正循环。FC 工具轮正文为空是正常形态（工具调用
        // 在供应商 tool_calls 字段），不算空正文。
        if (!content.trim() && resp.finishReason !== 'length' && !resp.toolCalls?.length) {
          emptyRounds += 1;
          if (emptyRounds >= 2) {
            record.error = `空正文连续 ${emptyRounds} 轮返回（finish_reason=${resp.finishReason ?? 'none'}）——模型确定性故障，换模`;
            await appendJournal(taskId, plugin.name, { role: 'agent', kind: 'error', text: record.error, ts: new Date().toISOString(), node_id: node.id, node_name: node.name, model: entry.name, tokens: resp.completionTokens });
            await emitProgress('agent_final', { task_id: taskId, node_id: node.id, agent: plugin.name, model: entry.name, ok: false, summary: record.error });
            return { status: 'failed', error: record.error, tokens: record.tokens, tool_rounds: toolRounds };
          }
        } else {
          emptyRounds = 0;
        }
        // E5（o3xmkraj 复盘）：思考烧穿整轮输出预算且正文为空。聚合网关对推理通道常
        // 不受 max_tokens 约束（实测 32000 档返回 38369 token），重发同请求不会变大——
        // 但可以软重试：同模型降思考强度（reasoning_effort low，非关闭）+ 续写指令。
        // 防浪费：本任务内同模型只软重试一次，仍烧穿记入记忆直接换模。
        if (!content.trim() && resp.finishReason === 'length') {
          const burnedSet = this.thinkingBurned.get(taskId);
          if (burnedSet?.has(entry.name)) {
            record.error = `输出预算耗尽（finish_reason=length）：${entry.name} 本任务软重试仍烧穿过，直接换模`;
            await appendJournal(taskId, plugin.name, { role: 'agent', kind: 'error', text: record.error, ts: new Date().toISOString(), node_id: node.id, node_name: node.name, model: entry.name, tokens: resp.completionTokens });
            await emitProgress('agent_final', { task_id: taskId, node_id: node.id, agent: plugin.name, model: entry.name, ok: false, summary: record.error });
            return { status: 'failed', error: record.error, tokens: record.tokens, tool_rounds: toolRounds };
          }
          await appendJournal(taskId, plugin.name, { role: 'agent', kind: 'error', text: `输出预算耗尽：思考烧穿 ${resp.completionTokens} token（请求上限 ${roundBudget}）正文为空——同模型降思考强度软重试一次`, ts: new Date().toISOString(), node_id: node.id, node_name: node.name, model: entry.name, tokens: resp.completionTokens });
          await emitProgress('agent_activity', { task_id: taskId, node_id: node.id, agent: plugin.name, text: '思考烧穿输出预算，降强度软重试…', model: entry.name });
          messages.push({ role: 'user', content: `你上一轮的思考耗尽了全部输出预算（${roundBudget} token）且没有输出任何正文。不要重新展开长思考：基于已有信息直接输出最终 JSON 结果；文件内容用 write_file 工具分批落盘，最终 JSON 的 files 留空数组。` });
          const retryResp = await chat(entry, messages, roundBudget, escalate ? 0.3 : 0, this.taskSignals.get(taskId)?.signal, nodeCapMs, onDelta, { extraBody: { reasoning_effort: 'low' } });
          this.pool!.recordUsage(entry.id, retryResp.promptTokens, retryResp.completionTokens);
          this.taskTokens.set(taskId, (this.taskTokens.get(taskId) || 0) + retryResp.promptTokens + retryResp.completionTokens);
          record.tokens += retryResp.promptTokens + retryResp.completionTokens;
          this.logger.info('LLM round telemetry', { taskId, nodeId: node.id, model: entry.name, round: round + 1, max_tokens: roundBudget, prompt_tokens: retryResp.promptTokens, cached_tokens: retryResp.cachedTokens ?? null, completion_tokens: retryResp.completionTokens, first_token_ms: retryResp.firstTokenMs ?? null, elapsed_ms: retryResp.elapsedMs, soft_retry: true });
          content = stripCodeFence(retryResp.content);
          if (!content.trim()) {
            if (!burnedSet) this.thinkingBurned.set(taskId, new Set());
            this.thinkingBurned.get(taskId)!.add(entry.name);
            record.error = `输出预算耗尽（finish_reason=length）：软重试（降思考强度）仍烧穿，两轮共 ${resp.completionTokens + retryResp.completionTokens} token 正文为空`;
            await appendJournal(taskId, plugin.name, { role: 'agent', kind: 'error', text: record.error, ts: new Date().toISOString(), node_id: node.id, node_name: node.name, model: entry.name, tokens: retryResp.completionTokens });
            await emitProgress('agent_final', { task_id: taskId, node_id: node.id, agent: plugin.name, model: entry.name, ok: false, summary: record.error });
            return { status: 'failed', error: record.error, tokens: record.tokens, tool_rounds: toolRounds };
          }
          await appendJournal(taskId, plugin.name, { role: 'agent', kind: 'round', text: `✅ E5 软重试成功（降思考强度后输出 ${retryResp.completionTokens} token）`, ts: new Date().toISOString(), node_id: node.id, node_name: node.name, model: entry.name });
        }
        // 原生 function calling：工具轮来自供应商 tool_calls（正文可能为空/散文），
        // 与强制终稿分支（line 3709）同款——FC 工具轮先取 resp.toolCalls，正文 JSON 兜底
        parsed = resp.toolCalls?.length ? { tool_calls: resp.toolCalls } : extractJson(content);
        // malformed tool-call JSON (nested/unclosed tool_calls) is recoverable:
        // pull out the individual {"tool":...} fragments and run them as a normal tool round
        if (!parsed) {
          const salvaged = salvageToolCalls(content);
          if (salvaged.length > 0) {
            parsed = { tool_calls: salvaged };
            this.logger.info('Salvaged tool calls from malformed output', { taskId, nodeId: node.id, agent: plugin.name, model: entry.name, count: salvaged.length });
          }
        }
        const roundEntry: Record<string, any> = {
          assistant: content,
          tool_results: null,
          parse_error: null,
          // 缓存命中观测：本轮 prompt 实际规模与服务端回报的命中前缀量
          telemetry: {
            prompt_tokens: resp.promptTokens,
            cached_tokens: resp.cachedTokens ?? null,
            first_token_ms: resp.firstTokenMs ?? null,
            elapsed_ms: resp.elapsedMs,
          },
        };
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
              return { status: 'failed', error: record.error, raw_output: content.slice(0, 2000), tokens: record.tokens, tool_rounds: toolRounds };
            }
            // Otherwise, inject correction message and retry
            messages.push({ role: 'assistant', content });
            // E5⑤: keep this example identical to the harness L6 contract (verification included),
            // otherwise the repaired JSON passes parse but fails the schema gate next round.
            messages.push({ role: 'user', content: nativeTools
              ? '你的输出既不是供应商 tool_calls 工具调用，也不是可解析的最终 JSON。请二选一：需要动手就通过供应商工具通道发起 tool_calls（不要写进正文）；工作已完成就直接输出最终 JSON（不要包含任何 markdown 或额外文字）：\n{"status":"success|failed","changes":[],"summary":"你的分析或结果","verification":"验证方式与结果","errors":[],"files":[],"commands":[]}'
              : '你返回的内容无法解析为 JSON。请严格按照以下格式输出（不要包含任何 markdown 或额外文字）：\n{"status":"success|failed","changes":[],"summary":"你的分析或结果","verification":"验证方式与结果","errors":[],"files":[],"commands":[]}' });
            continue;
          }
        }
        const toolCalls = parsed.tool_calls || [];
        if (toolCalls.length === 0) {
          // harness schema gate: the final JSON must satisfy the output contract;
          // violations feed a surgical repair round instead of vague retries
          const check = validateAgentResult(parsed);
          // 插话回应义务门（g6704zpm 实证：review 节点用 send_message 回答却没走 reply_to_user，
          // 用户等十分钟觉得"没人理我"）——本轮消费过用户插话，最终输出必须直接回应；
          // prompt 里的义务没有闸门就只是建议。
          if (consumedForAttempt.length && !String(parsed.reply_to_user || '').trim()) {
            check.violations.push(`缺少 reply_to_user：本轮你消费了 ${consumedForAttempt.length} 条用户插话（${consumedForAttempt.map((m) => m.message.slice(0, 50)).join(' / ')}），必须在 reply_to_user 字段逐条直接回应（结论/进度/做不做），summary 不能替代`);
            check.ok = false;
          }
          // 假完成拦截·产物核查门（2026-09-17）：仅成功申报执行——模型已承认失败不反向要求补文件；
          // orchestrator 合并节点无文件产出语义，跳过
          let specViolations: string[] = [];
          let specMissing: string[] = [];
          if (parsed.status === 'success' && this.gitEnabled && plugin.name !== 'orchestrator') {
            const av = await this.collectDeliveryViolations(node, workspace, parsed, midRunWritten);
            specViolations = av.violations;
            specMissing = av.specMissing;
            if (specViolations.length) {
              check.violations.push(...specViolations);
              check.ok = false;
            }
          }
          if (!check.ok) {
            roundEntry.parse_error = 'schema violations: ' + check.violations.join('; ');
            record.rounds.push(roundEntry);
            if (!parseErrorLogged) {
              parseErrorLogged = true;
              await appendJournal(taskId, plugin.name, { role: 'agent', kind: 'error', text: `第 ${round + 1} 轮输出违反契约：${check.violations.slice(0, 3).join('；')}，已要求修正`, ts: new Date().toISOString(), node_id: node.id, node_name: node.name, model: entry.name });
            }
            await emitProgress('agent_round', { task_id: taskId, node_id: node.id, agent: plugin.name, model: entry.name, round: round + 1, tokens: resp.completionTokens, parse_error: true });
            if (round >= maxRounds - 1) {
              record.error = specViolations.length
                ? `产物核查未通过：${specViolations.join('；')}`
                : 'result schema violations: ' + check.violations.join('; ');
              return { status: 'failed', error: record.error, raw_output: content.slice(0, 2000), tokens: record.tokens, tool_rounds: toolRounds, ...(specMissing.length ? { spec_missing: specMissing } : {}) };
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
          messages.push({ role: 'user', content: nativeTools
            ? '工具调用已达上限。请立即通过供应商工具通道不要再请求工具，直接输出最终 JSON 结果。格式：\n{"status":"success|failed","changes":[],"summary":"分析结果","verification":"验证方式与结果","errors":[],"files":[],"commands":[]}'
            : '工具调用已达上限。请立即基于已有信息输出最终 JSON 结果，不要再请求工具。格式：\n{"status":"success|failed","changes":[],"summary":"分析结果","verification":"验证方式与结果","errors":[],"files":[],"commands":[]}' });
          // Do one more round to get final output
          const finalResp = await chat(entry, messages, roundBudget, escalate ? 0.3 : 0, this.taskSignals.get(taskId)?.signal, nodeCapMs, onDelta);
          this.pool!.recordUsage(entry.id, finalResp.promptTokens, finalResp.completionTokens);
          this.taskTokens.set(taskId, (this.taskTokens.get(taskId) || 0) + finalResp.promptTokens + finalResp.completionTokens);
          record.tokens += finalResp.promptTokens + finalResp.completionTokens;
          roundEntry.telemetry = {
            prompt_tokens: finalResp.promptTokens,
            cached_tokens: finalResp.cachedTokens ?? null,
            first_token_ms: finalResp.firstTokenMs ?? null,
            elapsed_ms: finalResp.elapsedMs,
            forced_final: true,
          };
          content = stripCodeFence(finalResp.content);
        // 原生 function calling：工具轮来自供应商 tool_calls；正文为最终 JSON（extractJson）
        parsed = resp.toolCalls?.length ? { tool_calls: resp.toolCalls } : extractJson(content);
          if (parsed && !parsed.tool_calls) {
            // last-resort output still goes through the schema gate; with no repair
            // rounds left, violations become a precise failure instead of a fake success
            const check = validateAgentResult(parsed);
            if (!check.ok) {
              record.error = 'result schema violations: ' + check.violations.join('; ');
              return { status: 'failed', error: record.error, raw_output: content.slice(0, 2000), tokens: record.tokens, tool_rounds: toolRounds };
            }
            roundEntry.assistant = content;
            record.rounds.push(roundEntry);
            await emitProgress('agent_round', { task_id: taskId, node_id: node.id, agent: plugin.name, model: entry.name, round: round + 1, tokens: finalResp.completionTokens });
            break;
          }
          // If still tool_calls or no JSON, return failure
          record.error = 'agent failed to produce final output after tool calls';
          return { status: 'failed', error: record.error, raw_output: content.slice(0, 2000), tokens: record.tokens, tool_rounds: toolRounds };
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
          availableSkills: picks.map((p) => p.skill.name),
          node_id: node.id,
          node_name: node.name,
          askBridge: {
            askUser: (q: string) => this.bridgeAskUser(taskId, node, plugin.name, q),
            askAgent: (to: string, q: string) => this.bridgeAskAgent(taskId, node, plugin, to, q),
            answer: (askId: string, c: string) => this.bridgeAnswer(taskId, plugin.name, askId, c),
          } satisfies AskBridge,
          ...(this.pool ? { vision: { analyze: (prompt: string, images: { base64: string; mediaType: string }[]) => analyzeImages(this.pool!, prompt, images) } satisfies VisionBridge } : {}),
          ...(this.mcp ? { mcp: this.mcp } : {}),
        };
        // 重复调用指针化（缓存优先裁剪）：同工具+同参数再次出现不再读盘回显全文——
        // 既省上下文增量，也让模型看到"结果同上轮"而不是被第二份大体积 JSON 挤爆窗口
        const fresh: typeof toolCalls = [];
        const freshIdx: number[] = [];
        const positioned: unknown[] = new Array(toolCalls.length);
        const dedupKeyByIdx = new Map<number, string>(); // PH.3：证据表落账索引
        for (let ti = 0; ti < toolCalls.length; ti++) {
          const t = toolCalls[ti] as Record<string, any>;
          const tName = String(t.tool || '').toLowerCase();
          // screenshot/look_image 虽只读，但每次都是独立的视觉分析（页面随节点推进在变，
          // 且消耗 vision 配额）——"同参结果从略"的契约对它们不成立，豁免去重。
          // mcp__ 外部工具同理豁免：参数在独立 arguments 字段，现有 dedupKey 覆盖不到，
          // 且外部工具可能带副作用（写远程/改外部数据），重放语义必须由工具自己决定。
          // git_diff 也豁免（P0.6）：轮内 write_file/edit_file 后 diff 已变——把"写完再看 diff"
          // 的第二次调用指针化会喂给模型过期结果。
          const sideEffect = tName === 'write_doc' || tName === 'write_knowledge' || tName === 'send_message' || tName === 'ask_user' || tName === 'ask_agent' || tName === 'answer' || tName === 'screenshot' || tName === 'look_image' || tName === 'write_file' || tName === 'edit_file' || tName.startsWith('mcp__') || tName === 'git_diff';
          // P0.6 修复：dedupKey 补 line_start/line_end——同文件不同行段的续读（grep 定位后
          // 分段读正是系统教给模型的标准工作流）此前被误判"重复调用"喂回空指针。
          const dedupKey = `${tName}|${t.path || ''}|${t.pattern || t.query || ''}|${t.name || ''}|${t.line_start ?? ''}|${t.line_end ?? ''}|${t.line_start2 ?? ''}|${t.line_end2 ?? ''}`;
          if (!sideEffect && seenToolCalls.has(dedupKey)) {
            positioned[ti] = { tool: t.tool, ok: true, dedup: `与第 ${seenToolCalls.get(dedupKey)} 轮完全相同的调用，结果从略（可信任上轮结果）` };
            continue;
          }
          seenToolCalls.set(dedupKey, round + 1);
          dedupKeyByIdx.set(ti, dedupKey);
          fresh.push(toolCalls[ti]);
          freshIdx.push(ti);
        }
        const mutBefore = midRunWritten.length; // PH.3：本轮写盘增量基线
        const freshResults = await applyToolCalls(workspace, fresh, knowledgeCtx, policy);
        freshIdx.forEach((orig, i) => {
          positioned[orig] = freshResults[i];
          // PH.3：fresh 结果按调用签名落进累计证据表（重复调用保留旧值，哈希只反映真实新增量）
          const k = dedupKeyByIdx.get(orig);
          if (k) evidence.record(k, freshResults[i]);
          // P2.4：确定性提取「文件/命令 + 关键发现」入任务 scratchpad——折叠/elide 后仍可检索找回
          const t = fresh[i] as Record<string, any>;
          const r = freshResults[i] as Record<string, any>;
          if (t && typeof t === 'object' && r && typeof r === 'object') {
            const se = scratchFromToolCall(String(t.tool || ''), t, r, round + 1);
            if (se) void scratchPut(taskId, se).catch(() => undefined);
          }
        });
        const results = positioned;
        // PH.3：本轮确定性观察——mutation + 证据哈希 + 有界读取签名
        {
          let mutationCommitted = midRunWritten.length > mutBefore;
          for (const r of results as Record<string, any>[]) {
            if (r && r.ok && ['write_doc', 'send_message', 'ask_user', 'ask_agent', 'answer', 'exec', 'exec_background'].includes(String(r.tool || ''))) { mutationCommitted = true; break; }
          }
          const readSigs: string[] = [];
          for (let ti = 0; ti < toolCalls.length; ti++) {
            const t = toolCalls[ti] as Record<string, any>;
            const tName = String(t.tool || '').toLowerCase();
            if (!READ_ONLY_PROGRESS_TOOLS.has(tName)) continue;
            const r = positioned[ti] as Record<string, any> | undefined;
            if (r && r.ok === false) continue;
            readSigs.push(readSignature(tName, t));
          }
          lastObs = { mutationCommitted, evidenceSha256: evidence.hash(), readSignatures: readSigs };
        }
        // 证据门计数：只计实际执行过工具的轮（末轮"强制终稿"的工具请求不执行，不计）
        toolRounds += 1;
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
          if ((r?.tool === 'write_file' || r?.tool === 'edit_file') && r.ok && r.path) {
            midRunWritten.push(String(r.path));
          }
        }
        roundEntry.tool_results = results;
        record.rounds.push(roundEntry);
        await emitProgress('agent_round', { task_id: taskId, node_id: node.id, agent: plugin.name, model: entry.name, round: round + 1, tokens: resp.completionTokens, tool_calls: toolCalls });
        await appendJournal(taskId, plugin.name, { role: 'agent', kind: 'round', text: `请求读取工具: ${toolCalls.map((t: any) => t.tool + (t.path ? ':' + t.path : '')).join(', ')}`, ts: new Date().toISOString(), node_id: node.id, node_name: node.name, model: entry.name, tokens: resp.completionTokens });
        messages.push({ role: 'assistant', content });
        // 工具结果总预算（g6704zpm 节点5 实证修复）：旧值 8000 与单文件读取预算 16000 矛盾——
        // 一轮合并读 3 个大文件必然被总预算掐断，模型被迫反复重读直到轮次耗尽。
        // 24000 ≈ 6k token，对 128k 上下文模型合理；截断时明示丢了哪条、如何精确续读。
        const resultsJson = JSON.stringify(results);
        const resultsNote = resultsJson.length > 24000
          ? `（注意：本批 ${results.length} 项结果共 ${resultsJson.length} 字符被截断到 24000，尾部条目可能不完整——缺失部分用 read_file 行范围或 grep 精确重取，别整文件重读）`
          : '';
        messages.push({ role: 'user', content: `工具执行结果：\n${resultsJson.slice(0, 24000)}\n${resultsNote}\n请基于以上信息给出最终 JSON 结果。（第 ${round + 1}/${maxRounds} 轮完成，剩余 ${maxRounds - 1 - round} 轮——还需要的侦查请合并：同一轮 tool_calls 数组里放多个 read_file/grep 调用一次拿全，大文件分段读尤其如此，别把轮次耗在单发读取上）` });
        record.rounds.push({ user: '（工具执行结果已提供，见上一轮 tool_results）', tool_results: results });
        await appendJournal(taskId, plugin.name, { role: 'master', kind: 'tool_results', text: '', ts: new Date().toISOString(), node_id: node.id, node_name: node.name, meta: { results } });

        // M2 实时问答：消费投递给本 agent 的提问（ask_agent 实时转交），注入并要求用 answer 工具回答
        const incomingAsks = await consumeAskQueue(taskId, plugin.name);
        if (incomingAsks.length) {
          const lines = incomingAsks.map((q) => `- ask_id=${q.ask_id}（来自 ${q.from}）：${q.question}`).join('\n');
          messages.push({ role: 'user', content: `## 其他 Agent 的实时提问（下一步必须在 tool_calls 里用 answer 工具回答，ask_id 原样带回）\n${lines}` });
          await appendJournal(taskId, plugin.name, {
            role: 'master', kind: 'round',
            text: `收到 ${incomingAsks.length} 条实时提问（${incomingAsks.map((q) => q.from).join('、')}）`,
            ts: new Date().toISOString(), node_id: node.id, node_name: node.name,
            meta: { incoming_asks: incomingAsks },
          });
          await emitProgress('ask_delivered', { task_id: taskId, node_id: node.id, agent: plugin.name, count: incomingAsks.length });
        }

        // 群聊化 A1：工具轮之间检查用户新插话——执行中可被对话（三分支模板，强制回应）。
        // 插话是低频人为事件，当次尝试前缀缓存作废可接受；其余时刻严格 append-only。
        const midInterventions = await consumeInterventions(taskId);
        if (midInterventions.length) {
          messages.push({ role: 'user', content: `${INTERVENE_TEMPLATE}\n${midInterventions.map((m, i) => `${i + 1}. ${m.message}`).join('\n')}` });
          consumedForAttempt.push(...midInterventions);
          await appendJournal(taskId, plugin.name, {
            role: 'master', kind: 'intervene',
            text: `已送达节点 ${node.name}（第 ${round + 2} 轮注入，${midInterventions.length} 条）`,
            ts: new Date().toISOString(), node_id: node.id, node_name: node.name,
            meta: { delivered: { node_id: node.id, round: round + 2 }, interventions: midInterventions.map((m) => m.message) },
          });
          await emitProgress('intervention_injected', { task_id: taskId, node_id: node.id, agent: plugin.name, count: midInterventions.length, round: round + 2 });
          this.logger.info('mid-round intervention injected', { taskId, nodeId: node.id, round: round + 2, count: midInterventions.length });
        }

        // P2.2 四级水位线（缓存优先：循环内其余时刻严格 append-only）：
        //   0.50w snip → 0.62w elide → 0.72w 断崖折叠 → 0.90w 物理上限（413 分型兜底）。
        // 全部确定性改写、按条冻结（幂等）——同参数重复调用不产生新字节，前缀缓存可复用。
        if (!foldedOnce) {
          let est = estimateTokens(JSON.stringify(messages));
          if (est > snipLimit) {
            const n = snipOldToolResults(messages, { snipChars: 1500, protectTail: 2 });
            if (n) {
              est = estimateTokens(JSON.stringify(messages));
              this.logger.info('Waterline snip', { taskId, nodeId: node.id, round: round + 1, mutated: n, est_after: est });
            }
          }
          if (est > elideLimit) {
            const n = elideLongToolResults(messages, { elideChars: 3000, protectTail: 2 });
            if (n) {
              est = estimateTokens(JSON.stringify(messages));
              this.logger.info('Waterline elide', { taskId, nodeId: node.id, round: round + 1, elided: n, est_after: est });
            }
          }
          if (est > foldLimit && foldMessagesInto(messages)) {
            foldedOnce = true;
            // 折叠与去重指针的一致性：旧 tool_result 正文已被折叠摘要取代，指向它们的
            // "结果从略"指针成为死链——模型会永远拿不到文件内容（2y3tuote 节点 10 实测：
            // qwen3.8-flash 报"read_file 被 harness 去重未返回正文"三连败）。折叠即失效。
            seenToolCalls.clear();
            record.folded_at_round = round + 1;
            this.logger.warn('Prompt folded (cliff compaction)', {
              taskId, nodeId: node.id, model: entry.name, round: round + 1,
              est_before: est, est_after: estimateTokens(JSON.stringify(messages)),
            });
          }
        }
      }

      if (parsed!.status !== 'success') {
        record.error = (parsed!.errors || []).join('; ') || parsed!.summary || 'agent reported failure';
        // 失败申报里的插话回应同样上屏——用户有权在坏消息时也知道"我的话被听见了"
        const failReply = String((parsed as Record<string, any>).reply_to_user || '').trim();
        if (failReply) {
          await appendJournal(taskId, plugin.name, {
            role: 'agent', kind: 'message',
            text: failReply.slice(0, 2000),
            ts: new Date().toISOString(), node_id: node.id, node_name: node.name, model: entry.name,
            meta: { to: 'user', direct: true, round: record.rounds.length, text: failReply.slice(0, 2000) },
          });
          await emitProgress('agent_message', { task_id: taskId, node_id: node.id, agent: plugin.name, kind: 'message', to: 'user', direct: true });
        }
        await appendJournal(taskId, plugin.name, { role: 'agent', kind: 'error', text: record.error, ts: new Date().toISOString(), node_id: node.id, node_name: node.name, model: entry.name, tokens: record.tokens });
        await emitProgress('agent_final', { task_id: taskId, node_id: node.id, agent: plugin.name, model: entry.name, ok: false, summary: record.error });
        return { status: 'failed', error: record.error, raw_output: content.slice(0, 2000), tokens: record.tokens, tool_rounds: toolRounds };
      }

      let result: AgentResult = parsed as AgentResult;
      result = applyFinalOutput(workspace, result as Record<string, any>, policy) as AgentResult;
      // 人工已批准的命令直接放行执行（不再二次 park）——目录监狱仍生效
      const approvedCmds = (await busGet<string[]>(`task:approved_commands:${taskId}`)) || [];
      const cmdResults = (result as Record<string, any>).command_results as { command: string; needs_approval: boolean; returncode: number; stdout: string; stderr: string }[] | undefined;
      if (cmdResults?.length && approvedCmds.length) {
        for (const cr of cmdResults) {
          if (!cr.needs_approval || !approvedCmds.includes(cr.command)) continue;
          const r2 = await executeCommandAsync(cr.command, workspace, { level: 'full', whitelistCommands: null, maxTimeSec: policy.maxTimeSec });
          cr.needs_approval = false;
          cr.returncode = r2.returncode;
          cr.stdout = r2.stdout;
          cr.stderr = r2.stderr;
          const pc = (result as Record<string, any>).pending_commands as string[] | undefined;
          if (pc) (result as Record<string, any>).pending_commands = pc.filter((c) => c !== cr.command);
          await appendJournal(taskId, plugin.name, { role: 'agent', kind: 'tool_results', text: `已批准命令自动放行执行：${cr.command}\n退出码 ${r2.returncode}`, ts: new Date().toISOString(), node_id: node.id, node_name: node.name, meta: { command: cr.command, returncode: r2.returncode } });
        }
      }
      // 渐进落盘：轮内 write_file/edit_file 的产物计入申报，交付一致性检查不再误报 unreported
      if (midRunWritten.length) {
        (result as Record<string, any>).changes = [...new Set([...((result as Record<string, any>).changes || []), ...midRunWritten])];
      }
      result = plugin.handler.postRun ? plugin.handler.postRun(result) : result;
      delete (result as Record<string, any>).tool_calls;
      result.tokens = record.tokens;
      result.model = entry.name;
      if (docUpdates.length) result.doc_updates = docUpdates;

      // 群聊化 A2：reply_to_user 是模型真实输出 → direct 回复气泡（前端带"回复你"角标）；
      // intervene_defer 声明的条目回队接力给后续节点——消息不黑洞
      const replyToUser = String((result as Record<string, any>).reply_to_user || '').trim();
      const deferItems = Array.isArray((result as Record<string, any>).intervene_defer)
        ? ((result as Record<string, any>).intervene_defer as unknown[]).map(String).filter((x) => x.trim())
        : [];
      if (replyToUser) {
        await appendJournal(taskId, plugin.name, {
          role: 'agent', kind: 'message',
          text: replyToUser.slice(0, 2000),
          ts: new Date().toISOString(), node_id: node.id, node_name: node.name, model: entry.name,
          meta: { to: 'user', direct: true, round: record.rounds.length, text: replyToUser.slice(0, 2000) },
        });
        await emitProgress('agent_message', { task_id: taskId, node_id: node.id, agent: plugin.name, kind: 'message', to: 'user', direct: true });
      }
      if (deferItems.length) {
        for (const d of deferItems) await pushIntervention(taskId, `（接力：${node.name} 判定超出其范围）${d}`);
        await appendJournal(taskId, plugin.name, {
          role: 'master', kind: 'intervene',
          text: `↻ ${deferItems.length} 条插话已接力到后续节点（${node.name} 申报超出范围）`,
          ts: new Date().toISOString(), node_id: node.id, node_name: node.name,
          meta: { deferred: deferItems },
        });
        await emitProgress('intervention_deferred', { task_id: taskId, node_id: node.id, agent: plugin.name, count: deferItems.length });
      }
      attemptSucceeded = true;

      // session continuity: remember this exchange for the agent's next node in this task
      await busSet(sessionKey, [...priorSession, { role: 'user', content: userMsg }, { role: 'assistant', content }].slice(-30));

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
      // OBS-1 节点执行档案：轮次/工具/技能/知识命中/上下文用量一屏可查的数据源
      const toolStats: Record<string, { count: number; fail: number }> = {};
      let skillsLoaded: string[] = [];
      for (const r of record.rounds) {
        for (const tr of (r as Record<string, any>).tool_results || []) {
          const t = String(tr?.tool || '?');
          toolStats[t] = toolStats[t] || { count: 0, fail: 0 };
          toolStats[t].count += 1;
          if (tr?.ok === false) toolStats[t].fail += 1;
          if (t === 'load_skill' && tr?.ok && tr?.name) skillsLoaded.push(String(tr.name));
        }
      }
      (result as Record<string, any>).execution = {
        rounds: record.rounds.length,
        model: entry.name,
        tokens: result.tokens || 0,
        duration_sec: record.duration_sec ?? undefined,
        tools: toolStats,
        skills_indexed: picks.map((p2) => p2.skill.name),
        skills_loaded: [...new Set(skillsLoaded)],
        knowledge_hits: knowledgeHits.map((k) => k.id),
        folded: foldedOnce,
        context: record.prompt_profile ? { system_chars: (record.prompt_profile as any).system_chars, session_chars: (record.prompt_profile as any).session_chars, user_chars: (record.prompt_profile as any).user_chars, est_base_tokens: (record.prompt_profile as any).est_base_tokens } : undefined,
      };
      return result;
    } finally {
      record.duration_sec = Math.round((Date.now() - startedAt) / 100) / 10;
      await saveConversation(taskId, node.id, record);
      // M2 实时问答收场：投递给本 agent 且未回答的 ask 收场——但只在本 agent 的
      // 最后一个 dispatch 结束时（同名 agent 并发时兄弟还在跑，它还能回答）
      const remaining = (this.activeAgents.get(activeKey) || 1) - 1;
      if (remaining <= 0) {
        this.activeAgents.delete(activeKey);
        await flushAgentAsks(taskId, plugin.name).catch(() => {});
      } else {
        this.activeAgents.set(activeKey, remaining);
      }
      // 群聊化 A4：本次尝试未成功（失败/异常/取消）→ 已消费的插话回队——
      // 换模型、重试都不吞用户的话；成功时不回队（模型已真实回应）
      if (!attemptSucceeded && consumedForAttempt.length) {
        for (const m of consumedForAttempt) {
          await pushIntervention(taskId, `（重放：上一轮尝试未完成）${m.message}`).catch(() => undefined);
        }
        this.logger.warn('interventions re-queued after unsuccessful attempt', { taskId, nodeId: node.id, count: consumedForAttempt.length });
      }
    }
  }

  /** Shrink a stored assistant turn so old sessions fit the context budget. */
  private compactAssistant(content: string): string {
    const parsed = extractJson(content);
    if (!parsed) return content.slice(0, 1500);
    return JSON.stringify({ status: parsed.status, summary: parsed.summary, changes: parsed.changes, files: parsed.files });
  }

  // ---------- M2 全员实时问答：阻塞式 ask 桥 ----------

  private askReasonText(reason?: string): string {
    if (reason === 'timeout') return '超时未回答（基于合理假设继续，并在 result.assumptions 写明假设）';
    if (reason === 'cancelled') return '任务已停止，未获得回答';
    if (reason === 'unanswered') return '对方未回答';
    return '未获得回答';
  }

  private async bridgeAskUser(taskId: string, node: TaskNode, agent: string, question: string): Promise<{ answer?: string; noAnswer: boolean; reason?: string }> {
    const ask = await createAsk({ task_id: taskId, from: agent, to: 'user', question, node_id: node.id, node_name: node.name });
    // 先注册等待者再广播，杜绝"用户秒答早于 resolver 注册"的竞态
    const waitP = waitForAnswer(ask.id, taskId, this.askTimeoutMs);
    await appendJournal(taskId, agent, {
      role: 'agent', kind: 'ask', text: question,
      ts: new Date().toISOString(), node_id: node.id, node_name: node.name,
      meta: { ask_id: ask.id, to: 'user' },
    });
    notify('ask_user', { task_id: taskId, node_id: node.id, ask_id: ask.id }, `[Co-Team] ${agent} 提问：${question.slice(0, 100)}`);
    this.logger.info('ask_user waiting', { taskId, nodeId: node.id, agent, askId: ask.id });
    const r = await waitP;
    await appendJournal(taskId, agent, {
      role: 'master', kind: 'answer',
      text: r.noAnswer ? `（${this.askReasonText(r.reason)}）` : `回答：${r.answer || ''}`,
      ts: new Date().toISOString(), node_id: node.id, node_name: node.name,
      meta: { ask_id: ask.id, by: r.by || 'user', no_answer: r.noAnswer, question },
    });
    await emitProgress('ask_resolved', { task_id: taskId, ask_id: ask.id, from: agent, to: 'user', no_answer: r.noAnswer });
    return r;
  }

  private async bridgeAskAgent(taskId: string, node: TaskNode, askerPlugin: AgentPlugin, to: string, question: string): Promise<{ answer?: string; noAnswer: boolean; reason?: string }> {
    const available = [...this.router.getAvailable().keys()];
    if (!to || !available.includes(to)) {
      return { noAnswer: true, reason: `agent ${to || '(空)'} 不存在，可用：${available.join(', ')}` };
    }
    const ask = await createAsk({ task_id: taskId, from: askerPlugin.name, to, question, node_id: node.id, node_name: node.name });
    const waitP = waitForAnswer(ask.id, taskId, this.askTimeoutMs);
    await appendJournal(taskId, askerPlugin.name, {
      role: 'agent', kind: 'ask', text: `问 ${to}：${question}`,
      ts: new Date().toISOString(), node_id: node.id, node_name: node.name,
      meta: { ask_id: ask.id, to },
    });
    if ((this.activeAgents.get(`${taskId}:${to}`) || 0) > 0) {
      // 目标正在执行：投递到其轮间注入队列，它用 answer 工具实时回答
      await queueAskForAgent(taskId, to, { ask_id: ask.id, from: askerPlugin.name, question });
      await appendJournal(taskId, askerPlugin.name, {
        role: 'agent', kind: 'round', text: `提问已实时转交 ${to}（对方执行中）`,
        ts: new Date().toISOString(), node_id: node.id, node_name: node.name,
        meta: { ask_id: ask.id, delivered: 'live' },
      });
    } else {
      // 目标空闲：图外咨询 dispatch——单次 chat 直接拿专业判断，不动任务图、不占节点
      await appendJournal(taskId, askerPlugin.name, {
        role: 'agent', kind: 'round', text: `${to} 空闲，发起临时咨询`,
        ts: new Date().toISOString(), node_id: node.id, node_name: node.name,
        meta: { ask_id: ask.id, delivered: 'consult' },
      });
      const answer = await this.consultAgent(taskId, to, askerPlugin.name, question);
      if (answer === null) {
        await abandonAsk(ask.id, taskId, '咨询不可用（无可用模型或模型调用失败）');
      } else {
        await resolveAsk(ask.id, taskId, answer, to);
      }
    }
    const r = await waitP;
    await appendJournal(taskId, askerPlugin.name, {
      role: 'agent', kind: 'answer',
      text: r.noAnswer ? `（${this.askReasonText(r.reason)}）` : `${to} 回答：${r.answer || ''}`,
      ts: new Date().toISOString(), node_id: node.id, node_name: node.name,
      meta: { ask_id: ask.id, by: r.by || to, no_answer: r.noAnswer, question },
    });
    await emitProgress('ask_resolved', { task_id: taskId, ask_id: ask.id, from: askerPlugin.name, to, no_answer: r.noAnswer });
    return r;
  }

  /** 图外咨询：给某角色 agent 发一个问题、拿一个回答。不建节点、不写图、不占任务分支。 */
  private async consultAgent(taskId: string, to: string, from: string, question: string): Promise<string | null> {
    const plugin = this.router.getAvailable().get(to);
    if (!plugin || !this.pool) return null;
    const entry = this.pool.selectModel(plugin.tags, 'simple');
    if (!entry) return null;
    try {
      const resp = await chat(entry, [
        { role: 'system', content: `${plugin.prompt}\n\n## 临时咨询模式\n你正被任务中的同事 agent（${from}）实时咨询。直接回答问题本身：给出具体、可执行的专业判断。不要声称执行了任何操作（你没有任何工具），不要输出 JSON，回答控制在 500 字以内。` },
        { role: 'user', content: question },
      ], 4000, 0);
      const text = resp.content.trim().slice(0, 2000);
      return text || null;
    } catch (e) {
      this.logger.warn('consult dispatch failed', { taskId, to, from, error: String(e) });
      return null;
    }
  }

  private async bridgeAnswer(taskId: string, agent: string, askId: string, content: string): Promise<boolean> {
    const okDone = await resolveAsk(askId, taskId, content, agent);
    if (okDone) {
      await emitProgress('ask_answered_by_agent', { task_id: taskId, ask_id: askId, by: agent });
    }
    return okDone;
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
    const g = simpleGit({ baseDir: workspace });
    const branches = await g.branchLocal().catch(() => null);
    if (!branches) return null;
    // remember where the user's working copy was: checkoutLocalBranch switches HEAD, and
    // leaving it on the task branch silently absorbed later human/agent commits (2026-09-08)
    const original = branches.current || (await g.revparse(['--abbrev-ref', 'HEAD']).catch(() => '')) || '';
    if (!branches.all.includes(branch)) {
      try { await g.checkoutLocalBranch(branch); } catch { return null; }
    } else {
      try { await g.checkout(branch); } catch { return null; }
    }
    const commit = await gitTool.commitOnBranch(workspace, message || `coteam: task ${taskId} auto-commit`, changes);
    if (original && original !== branch) {
      await g.checkout(original).catch((e) => this.logger.warn('gitCommit: failed to restore HEAD', { workspace, original, error: String(e) }));
    }
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
