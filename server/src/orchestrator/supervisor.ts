import { busGet, busSet, getBus } from '../bus';
import { CHANNELS, TaskGraph } from '../types';
import { getTaskGraph, getTaskEvents, appendJournal } from '../store';
import { listAsks } from '../askGate';
import { notify } from '../notify';
import { chat, extractJson } from '../llm';
import { getLogger } from '../logger';
import type { ModelPool } from '../scheduler';
import type { AgentPlugin } from '../agents';

/**
 * M3 主 agent 监督者：订阅任务事件流，维护每任务状态摘要，按触发条件做一次
 * 轻量 LLM 评估，执行"有边界的自动处置"：
 *  - 自动：催办（注入插话，回应义务门保证必答）、风险汇报、建议标注——全部落 journal 可审计
 *  - 提案：改图类动作（重试失败节点 / 取消子树 / 插入节点）只生成提案，人工批准后执行
 * 监督者不直接改图、不直接换模型、不给 agent 下达目标外指令。
 */

export interface SupervisorProposal {
  id: string;
  task_id: string;
  type: 'retry_failed' | 'cancel_subtree' | 'insert_node' | 'derive_task';
  node_id?: string;
  after_node_id?: string;
  new_node?: { name: string; agent: string };
  reason: string;
  /** derive_task：派生修复任务的缺陷描述（批准后作为新任务 description） */
  description?: string;
  /** derive_task 执行后回填 */
  derived_task_id?: string;
  status: 'pending' | 'approved' | 'rejected' | 'executed' | 'failed';
  created_at: string;
  decided_at?: string;
  exec_error?: string;
}

export interface SupervisorOptions {
  pool: ModelPool | null;
  /** 心跳评估周期秒数；0 = 关闭心跳（仅事件驱动） */
  heartbeatSec?: number;
  /** 同任务同原因的最小评估间隔秒数（防自激），缺省 120 */
  minIntervalSec?: number;
  /** 可用 agent 名（insert_node 提案校验用） */
  availableAgents?: () => string[];
}

const SYSTEM_PROMPT = `你是任务监督者（主 Agent 的监督角色）。你收到一份任务状态摘要，任务是「用多个 agent 协作开发软件」的多节点 DAG。
你的职责是监督任务进度、发现卡点，并从下列"有边界的动作"中选择（宁少勿滥，没有问题就空动作）：
- nudge：催办/提醒某个执行中的节点（message 会注入该节点的下一轮对话，agent 必须回应）
- report：向用户汇报风险或进度异常
- suggest：只在 journal 留下建议，不打扰任何人
- propose_retry：提案重试某个 failed 节点（需用户批准）
- propose_cancel：提案取消某个节点及其下游子树（需用户批准，适用于"继续做没有意义"的场景）
- propose_insert：提案在指定节点后插入一个新节点（需用户批准）
严格输出 JSON：{"assessment":"一句话现状", "actions":[{"action":"...","node_id":"节点id或空","message":"催办/汇报/建议文本","new_node":{"name":"节点名","agent":"agent名"},"after_node_id":"插入锚点节点id"}]}
没有要做的就输出 {"assessment":"...","actions":[]}。不要输出 JSON 以外的内容。`;

export class Supervisor {
  private logger = getLogger();
  private unsub: (() => void) | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  /** 同任务同原因上次评估时间（防自激） */
  private lastFired = new Map<string, number>();
  private evaluating = new Set<string>();
  private stopped = false;

  constructor(private opts: SupervisorOptions) {}

  start(): void {
    this.stopped = false;
    const bus = getBus();
    this.unsub = bus.subscribe(CHANNELS.TASK, (envelope: unknown) => {
      if (this.stopped) return;
      void this.onEvent(envelope).catch((e) => this.logger.warn('supervisor onEvent failed', { error: String(e) }));
    });
    const hb = (this.opts.heartbeatSec ?? 600) * 1000;
    if (hb > 0) {
      this.heartbeatTimer = setInterval(() => {
        if (this.stopped) return;
        void this.heartbeat().catch((e) => this.logger.warn('supervisor heartbeat failed', { error: String(e) }));
      }, Math.max(30_000, hb));
    }
    this.logger.info('Supervisor started', { heartbeatSec: this.opts.heartbeatSec ?? 600 });
  }

  stop(): void {
    this.stopped = true;
    this.unsub?.();
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
  }

  /** 供 M4/M5（阶段闸门/验收失败）主动触发的入口 */
  async trigger(taskId: string, reason: string): Promise<void> {
    await this.evaluate(taskId, reason);
  }

  private async onEvent(envelope: unknown): Promise<void> {
    const env = envelope as Record<string, any> | null;
    const type = String(env?.type || '');
    const p = (env?.payload || {}) as Record<string, any>;
    const taskId = String(p.task_id || '');
    if (!taskId) return;
    let reason = '';
    if (type === 'node_error') reason = `node_error:${p.node_id}`;
    else if (type === 'node_retry' && Number(p.attempt || 0) >= 2) reason = `retry_streak:${p.node_id}`;
    else if (type === 'ask_resolved' && p.no_answer) reason = `ask_timeout:${p.node_id || p.from}`;
    else if (type === 'acceptance_failed') reason = `acceptance:${p.node_id || 'task'}`;
    else if (type === 'stage_gate_failed') reason = `stage_gate:${p.stage || ''}`;
    if (!reason) return;
    await this.evaluate(taskId, reason);
  }

  private async heartbeat(): Promise<void> {
    // 扫描运行中任务，做周期性进度评估
    const graphs = await this.listRunningTasks();
    for (const taskId of graphs) {
      await this.evaluate(taskId, 'heartbeat').catch(() => {});
    }
  }

  private async listRunningTasks(): Promise<string[]> {
    // 从 bus 键枚举任务图（task:*:graph 形态由 store 决定，这里走 store 的列表）
    const { listTaskGraphs } = await import('../store');
    const graphs = await listTaskGraphs();
    return graphs.filter((g) => g.status === 'running').map((g) => g.task_id);
  }

  private shouldFire(taskId: string, reason: string, baseReason: string): boolean {
    const min = (this.opts.minIntervalSec ?? 120) * 1000;
    // heartbeat 与具体事件原因分开限频；同类原因共享冷却
    const key = `${taskId}:${reason.split(':')[0] || baseReason}`;
    const now = Date.now();
    const last = this.lastFired.get(key) || 0;
    if (now - last < min) return false;
    this.lastFired.set(key, now);
    return true;
  }

  private async evaluate(taskId: string, reason: string): Promise<void> {
    const baseReason = reason.split(':')[0];
    if (!this.shouldFire(taskId, reason, baseReason)) return;
    if (this.evaluating.has(taskId)) return;
    this.evaluating.add(taskId);
    try {
      await this.evaluateInner(taskId, reason);
    } finally {
      this.evaluating.delete(taskId);
    }
  }

  private async evaluateInner(taskId: string, reason: string): Promise<void> {
    const graph = await getTaskGraph(taskId);
    if (!graph || !['running', 'retrying', 'planned', 'pending'].includes(graph.status)) return;
    const digest = await this.buildDigest(graph, reason);
    const entry = this.opts.pool?.selectModel(undefined, 'simple');
    if (!entry) {
      this.logger.warn('supervisor skipped: no model available', { taskId });
      return;
    }
    let actions: SupervisorAction[] = [];
    let assessment = '';
    try {
      const resp = await chat(entry, [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: digest },
      ], 2000, 0);
      const parsed = extractJson(resp.content);
      assessment = String(parsed?.assessment || '').slice(0, 300);
      actions = Array.isArray(parsed?.actions) ? (parsed.actions as SupervisorAction[]).slice(0, 5) : [];
    } catch (e) {
      this.logger.warn('supervisor LLM evaluate failed', { taskId, error: String(e) });
      return;
    }
    await appendJournal(taskId, 'supervisor', {
      role: 'master', kind: 'round',
      text: `监督者评估（${reason}）：${assessment || '无异常'}`,
      ts: new Date().toISOString(), node_id: '', node_name: '',
      meta: { supervisor: true, reason, actions: actions.map((a) => a.action) },
    });
    await emitSupervisorEvent('supervisor_evaluated', { task_id: taskId, reason, assessment });
    for (const action of actions) {
      await this.runAction(taskId, action).catch((e) => this.logger.warn('supervisor action failed', { taskId, error: String(e) }));
    }
  }

  private async runAction(taskId: string, action: SupervisorAction): Promise<void> {
    const message = String(action.message || '').slice(0, 500);
    switch (action.action) {
      case 'nudge': {
        if (!message) return;
        const { pushIntervention } = await import('../store');
        await pushIntervention(taskId, `（监督者催办）${message}`);
        await appendJournal(taskId, 'supervisor', {
          role: 'master', kind: 'round', text: `监督者催办已注入：${message}`,
          ts: new Date().toISOString(), node_id: String(action.node_id || ''), node_name: '',
          meta: { supervisor: true, action: 'nudge' },
        });
        await emitSupervisorEvent('supervisor_action', { task_id: taskId, action: 'nudge' });
        return;
      }
      case 'report': {
        if (!message) return;
        await appendJournal(taskId, 'supervisor', {
          role: 'master', kind: 'message', text: `监督者汇报：${message}`,
          ts: new Date().toISOString(), node_id: '', node_name: '',
          meta: { supervisor: true, action: 'report' },
        });
        notify('supervisor_report', { task_id: taskId }, `[Co-Team] 监督者汇报（任务 ${taskId}）：${message.slice(0, 120)}`);
        await emitSupervisorEvent('supervisor_action', { task_id: taskId, action: 'report' });
        return;
      }
      case 'suggest': {
        if (!message) return;
        await appendJournal(taskId, 'supervisor', {
          role: 'master', kind: 'round', text: `监督者建议：${message}`,
          ts: new Date().toISOString(), node_id: '', node_name: '',
          meta: { supervisor: true, action: 'suggest' },
        });
        return;
      }
      case 'propose_retry':
      case 'propose_cancel':
      case 'propose_insert': {
        await this.createProposal(taskId, action);
        return;
      }
      default:
        return;
    }
  }

  private async createProposal(taskId: string, action: SupervisorAction): Promise<void> {
    const available = this.opts.availableAgents?.() || [];
    const type: SupervisorProposal['type'] =
      action.action === 'propose_retry' ? 'retry_failed' :
      action.action === 'propose_cancel' ? 'cancel_subtree' : 'insert_node';
    if (type === 'insert_node') {
      const nn = action.new_node || ({} as any);
      if (!nn.name || !available.includes(String(nn.agent || ''))) {
        this.logger.warn('supervisor insert proposal rejected (bad agent)', { taskId, agent: nn.agent });
        return;
      }
    }
    if (type !== 'insert_node' && !action.node_id) return;
    const proposal: SupervisorProposal = {
      id: Math.random().toString(36).slice(2, 10),
      task_id: taskId,
      type,
      node_id: action.node_id || undefined,
      after_node_id: action.after_node_id || undefined,
      new_node: action.new_node,
      reason: String(action.message || '').slice(0, 500),
      status: 'pending',
      created_at: new Date().toISOString(),
    };
    const key = `task:proposals:${taskId}`;
    const list = (await busGet<SupervisorProposal[]>(key)) || [];
    // 同类型同节点的 pending 提案去重
    if (list.some((x) => x.status === 'pending' && x.type === type && x.node_id === proposal.node_id)) return;
    list.push(proposal);
    await busSet(key, list.slice(-50));
    await appendJournal(taskId, 'supervisor', {
      role: 'master', kind: 'message',
      text: `监督者提案（待批准）：${proposalLabel(proposal)}`,
      ts: new Date().toISOString(), node_id: '', node_name: '',
      meta: { supervisor: true, proposal_id: proposal.id, proposal_type: type },
    });
    notify('supervisor_proposal', { task_id: taskId, proposal_id: proposal.id }, `[Co-Team] 监督者提案待批准（任务 ${taskId}）：${proposalLabel(proposal)}`);
    await emitSupervisorEvent('supervisor_proposal', { task_id: taskId, proposal_id: proposal.id, type });
  }

  private async buildDigest(graph: TaskGraph, reason: string): Promise<string> {
    const nodes = graph.nodes.map((n) => `${n.id}(${n.name}/${n.agent}):${n.status}${n.error ? ` 错误:${n.error.slice(0, 120)}` : ''}`).join('\n');
    let events = '';
    try {
      const evs = await getTaskEvents(graph.task_id);
      events = evs.slice(-15).map((e) => `${e.type}${e.payload?.node_id ? `:${e.payload.node_id}` : ''}`).join(', ');
    } catch { /* best effort */ }
    let asks = '';
    try {
      const pending = (await listAsks(graph.task_id)).filter((a) => a.status === 'pending');
      asks = pending.length ? `未收场提问: ${pending.map((a) => `${a.from}->${a.to}:${a.question.slice(0, 60)}`).join('；')}` : '';
    } catch { /* best effort */ }
    return [
      `触发原因: ${reason}`,
      `任务状态: ${graph.status}，目标: ${(graph.description || '').slice(0, 150)}`,
      `节点（${graph.nodes.filter((n) => n.status === 'completed').length}/${graph.nodes.length} 完成）:\n${nodes}`,
      events ? `最近事件: ${events}` : '',
      asks,
    ].filter(Boolean).join('\n\n').slice(0, 4000);
  }
}

interface SupervisorAction {
  action: string;
  node_id?: string;
  message?: string;
  new_node?: { name: string; agent: string };
  after_node_id?: string;
}

function proposalLabel(p: SupervisorProposal): string {
  if (p.type === 'retry_failed') return `重试失败节点 ${p.node_id}`;
  if (p.type === 'cancel_subtree') return `取消节点 ${p.node_id} 及其下游`;
  return `在 ${p.after_node_id || '(末尾)'} 后插入节点「${p.new_node?.name}」(${p.new_node?.agent})`;
}

async function emitSupervisorEvent(type: string, payload: Record<string, unknown>): Promise<void> {
  const { emitProgress } = await import('../store');
  await emitProgress(type as any, payload);
}
