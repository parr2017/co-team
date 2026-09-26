/**
 * 决策卡片（Step 2）：ask_user 阻塞提问 / 监督者提案 / 每日报告裁决 /
 * 需求澄清 / 节点开工确认 / 讨论拍板。
 *
 * 渲染：订阅 coteam:notify——notify 载荷普遍偏瘦（只有 id），凭 id 进程内回查
 * KV 取详情（task:asks / task:proposals / task:clarify / task:node:clarify /
 * reports:daily）。
 *
 * 表单路由：表单提交回调确定携带 action.form_value 与 context.open_message_id，
 * 但按钮 name/表单名的回传形态不可靠——因此渲染发送成功后把路由参数注册进
 * bus（feishu:route:{message_id}），回调按卡片消息 id 查表路由。
 *
 * 回执：结果卡以 cardResponse() 随响应帧返回（v1 实测：裸卡片会被回滚）。
 * 白名单：所有写动作过 approvers 校验（复用 v1 机制）。
 */
import { busGet, busSet, getBus } from '../bus';
import { CHANNELS } from '../types';
import { getLogger } from '../logger';
import { appendJournal, emitProgress, getTaskGraph, listTaskGraphs, persistGraph } from '../store';
import { resolveAsk, listAsks } from '../askGate';
import { getDailyReport, resolveReportItem } from '../dailyReport';
import { writeKnowledge } from '../knowledge';
import type { FeishuConfig } from '../config';
import type { TaskGraph } from '../types';
import { sendCard, updateCard } from './messageService';
import {
  buildResultCard, btn, btnRow, card2, cardResponse, form, inputField, md, note, submitBtn,
  type CardElement,
} from './cards';
import type { CardActionInput } from './approvalCards';

export interface DecisionDeps {
  enqueue: (taskId: string, projectId: string | null, workspace: string) => Promise<unknown>;
  addNode: (taskId: string, input: { name: string; agent: string; afterNodeId: string }) => Promise<unknown>;
  createTask: (description: string, workspace: string, projectId?: string, opts?: { level?: string; autoRun?: boolean; planAsync?: boolean; skipClarification?: boolean }) => Promise<{ taskId: string }>;
  clarify: (taskId: string, input: { answers?: { question: string; answer: string }[]; confirm?: boolean; text?: string }) => Promise<{ status: string; questions?: string[]; summary?: string }>;
  clarifyNode: (taskId: string, nodeId: string, input: { approve?: boolean; answers?: { question: string; answer: string }[]; text?: string }) => Promise<{ status: string }>;
  postDiscussionMessage: (discussionId: string, text: string) => Promise<void>;
}

const SEEN_TTL_SEC = 3600;
const ROUTE_TTL_SEC = 7 * 24 * 3600;

// ---------- 卡片渲染 ----------

const PROPOSAL_LABELS: Record<string, string> = {
  retry_failed: '重试失败节点',
  cancel_subtree: '取消子树',
  insert_node: '插入节点',
  derive_task: '派生修复任务',
};

export function askCard(taskId: string, ask: { id: string; from: string; question: string; node_name?: string }): Record<string, unknown> {
  return card2('orange', `❓ ${ask.from} 有一个问题`, [
    md(`**任务** ${taskId}${ask.node_name ? ` · 节点 ${ask.node_name}` : ''}`),
    md(ask.question.slice(0, 800)),
    note('15 分钟内回答，超时任务将按无回答继续'),
    form(`askf_${taskId}`, [
      inputField('answer', '输入你的回答…'),
      submitBtn('发送', 'go'),
    ]),
    btn('跳过（按默认继续）', 'default', { act: 'ask_skip', task_id: taskId, ask_id: ask.id }),
    note(`Co-Team · 阻塞提问 · ${new Date().toLocaleString()}`),
  ]);
}

export function proposalCard(taskId: string, p: { id: string; type: string; reason?: string; description?: string }): Record<string, unknown> {
  const label = PROPOSAL_LABELS[p.type] || p.type;
  return card2('orange', `🛎 提案：${label}`, [
    md(`**任务** ${taskId}`),
    md((p.description || p.reason || '').slice(0, 600)),
    btnRow(
      btn('✅ 批准', 'primary', { act: 'proposal_approve', task_id: taskId, proposal_id: p.id }),
      btn('✖ 拒绝', 'danger', { act: 'proposal_reject', task_id: taskId, proposal_id: p.id }),
    ),
    note(`Co-Team · 监督者提案 · ${new Date().toLocaleString()}`),
  ]);
}

function threeBtnRow(date: string, itemId: string): CardElement {
  const mk = (text: string, type: 'primary' | 'default' | 'danger', act: string) => ({
    tag: 'button', text: { tag: 'plain_text', content: text }, type, size: 'medium',
    behaviors: [{ type: 'callback', value: { act, date, item_id: itemId } }],
  });
  return {
    tag: 'column_set', flex_mode: 'trisect',
    columns: [
      { tag: 'column', width: 'weighted', weight: 1, elements: [mk('跳过', 'default', 'daily_skip')] },
      { tag: 'column', width: 'weighted', weight: 1, elements: [mk('立即修', 'primary', 'daily_fix')] },
      { tag: 'column', width: 'weighted', weight: 1, elements: [mk('建任务', 'default', 'daily_task')] },
    ],
  };
}

export function dailyCard(report: { date: string; items: { id: string; category: string; count: number; sample: string }[] }, stats?: { done?: number; parked?: number }): Record<string, unknown> {
  const shown = report.items.slice(0, 3);
  const elements: CardElement[] = [];
  if (stats) elements.push(md(`**今日完成** ${stats.done ?? 0} · **停靠等待** ${stats.parked ?? 0} · **待你裁决** ${report.items.length}`));
  else elements.push(md(`共 ${report.items.length} 类问题（按签名聚合）`));
  for (const item of shown) {
    elements.push(md(`**${item.category}** ×${item.count} · ${item.sample.slice(0, 80)}`));
    elements.push(threeBtnRow(report.date, item.id));
  }
  if (report.items.length > shown.length) elements.push(note(`其余 ${report.items.length - shown.length} 类请在面板处理`));
  elements.push(note(`Co-Team · 每日报告 · ${new Date().toLocaleString()}`));
  return card2('blue', `📋 每日问题报告 · ${report.date}`, elements);
}

export function clarifyCard(taskId: string, state: { rounds?: number; questions?: string[] }): Record<string, unknown> {
  const round = state.rounds ?? 1;
  const questions = (state.questions || []).slice(0, 3);
  const elements: CardElement[] = [];
  questions.forEach((q, i) => {
    elements.push(md(`**${i + 1}. ${q.slice(0, 160)}**`));
    elements.push(inputField(`a${i + 1}`, `回答问题 ${i + 1}…`));
  });
  elements.push(form(`cl_${taskId}_${round}`, [submitBtn('提交回答', 'go')]));
  elements.push(btn('直接确认（需求已清楚）', 'default', { act: 'clarify_confirm', task_id: taskId }));
  elements.push(note(`Co-Team · 需求澄清 · 第 ${round}/3 轮 · ${new Date().toLocaleString()}`));
  return card2('blue', `❔ 需求澄清（第 ${round}/3 轮）· ${taskId}`, elements);
}

export function nodeClarifyCard(taskId: string, nodeId: string, nodeName: string, brief: { approach?: string; files?: string[]; risks?: string[] }): Record<string, unknown> {
  const elements: CardElement[] = [];
  if (brief.approach) elements.push(md(`**思路** ${brief.approach.slice(0, 400)}`));
  if (brief.files?.length) elements.push(md(`**涉及文件** ${brief.files.slice(0, 6).join('、')}`));
  if (brief.risks?.length) elements.push(md(`**风险** ${brief.risks.join('；').slice(0, 300)}`));
  elements.push(form(`nc_${taskId}_${nodeId}`, [inputField('note', '补充说明（可空）…'), submitBtn('✅ 确认开工', 'go')]));
  elements.push(note(`Co-Team · 开工确认 · ${nodeName} · ${new Date().toLocaleString()}`));
  return card2('blue', `❔ 开工确认 · ${nodeName}`, elements);
}

function discussAskCard(question: string): Record<string, unknown> {
  return card2('orange', `💬 讨论需要你拍板`, [
    md(question.slice(0, 800)),
    form(`da_${Date.now()}`, [inputField('answer', '输入你的表态…'), submitBtn('发送', 'go')]),
    note(`Co-Team · 讨论拍板 · ${new Date().toLocaleString()}`),
  ]);
}

// ---------- 渲染触发（NOTIFY 频道） ----------

async function taskChat(taskId: string): Promise<string | null> {
  const bound = await busGet<{ chat_id: string }>(`feishu:card:${taskId}`);
  return bound?.chat_id || null;
}

/** 无任务绑定的决策卡（每日报告/讨论）落点：首个审批人的飞书私聊。 */
function defaultTarget(cfg: FeishuConfig): { id: string; type: 'open_id' } | null {
  return cfg.approvers?.length ? { id: cfg.approvers[0], type: 'open_id' } : null;
}

/** 发送并把路由参数注册到卡片消息 id 上（表单回调按 message_id 查表）。 */
async function sendRouted(cfg: FeishuConfig, target: { id: string; type: 'chat_id' | 'open_id' }, card: Record<string, unknown>, params: Record<string, unknown>): Promise<void> {
  const messageId = await sendCard(cfg, target.id, card, target.type);
  if (messageId) await busSet(`feishu:route:${messageId}`, params, ROUTE_TTL_SEC);
}

export function startDecisionCards(cfg: FeishuConfig, deps: DecisionDeps): () => void {
  const logger = getLogger();
  if (!cfg.approvers?.length) {
    logger.warn('Feishu decision cards disabled: no approvers whitelist (config.feishu.approvers)', {});
    return () => {};
  }
  const seen = async (key: string): Promise<boolean> => {
    const k = `feishu:decision_seen:${key}`;
    if (await busGet(k)) return true;
    await busSet(k, 1, SEEN_TTL_SEC);
    return false;
  };

  return getBus().subscribe(CHANNELS.NOTIFY, (envelope: unknown) => {
    const env = envelope as { type?: string; payload?: Record<string, unknown>; message?: string } | null;
    const type = env?.type || '';
    const payload = (env?.payload || {}) as Record<string, unknown>;
    void (async () => {
      switch (type) {
        case 'ask_user': {
          const taskId = String(payload.task_id || '');
          const askId = String(payload.ask_id || '');
          if (!taskId || !askId) return;
          if (await seen(`ask:${askId}`)) return;
          const chatId = await taskChat(taskId);
          if (!chatId) return;
          const ask = (await listAsks(taskId)).find((a) => a.id === askId);
          if (!ask) return;
          const card = askCard(taskId, { id: ask.id, from: ask.from, question: ask.question, node_name: ask.node_name });
          const messageId = await sendCard(cfg, chatId, card);
          if (messageId) await busSet(`feishu:route:${messageId}`, { act: 'ask_answer', task_id: taskId, ask_id: askId }, ROUTE_TTL_SEC);
          return;
        }
        case 'supervisor_proposal': {
          const taskId = String(payload.task_id || '');
          const proposalId = String(payload.proposal_id || '');
          if (!taskId || !proposalId) return;
          if (await seen(`prop:${proposalId}`)) return;
          const chatId = await taskChat(taskId);
          if (!chatId) return;
          const proposals = (await busGet<any[]>(`task:proposals:${taskId}`)) || [];
          const p = proposals.find((x) => x.id === proposalId);
          if (!p || p.status !== 'pending') return;
          await sendCard(cfg, chatId, proposalCard(taskId, p));
          return;
        }
        case 'daily_report_ready': {
          const date = String(payload.date || '');
          if (!date || (await seen(`daily:${date}`))) return;
          const target = defaultTarget(cfg);
          if (!target) return;
          const report = await getDailyReport(date);
          if (!report || !report.items.length) return;
          // 晨报三段式：完成 / 停靠 / 待裁决（今日口径）
          const today = new Date().toISOString().slice(0, 10);
          const graphs = await listTaskGraphs();
          const done = graphs.filter((g) => (g.updated_at || '').startsWith(today) && (g.status === 'success' || g.status === 'completed_with_warnings')).length;
          const parked = graphs.filter((g) => String(g.status).startsWith('waiting')).length;
          await sendCard(cfg, target.id, dailyCard(report, { done, parked }), target.type);
          return;
        }
        case 'task_needs_clarification': {
          const taskId = String(payload.task_id || '');
          if (!taskId || (await seen(`clarify:${taskId}`))) return;
          const chatId = await taskChat(taskId);
          if (!chatId) return;
          const state = await busGet<{ rounds?: number; questions?: string[] }>(`task:clarify:${taskId}`);
          if (!state?.questions?.length) return;
          await sendRouted(cfg, { id: chatId, type: 'chat_id' }, clarifyCard(taskId, state), { act: 'clarify_answer', task_id: taskId });
          return;
        }
        case 'node_awaiting_clarify': {
          const taskId = String(payload.task_id || '');
          const nodeId = String(payload.node_id || '');
          if (!taskId || !nodeId || (await seen(`nodeclar:${taskId}:${nodeId}`))) return;
          const chatId = await taskChat(taskId);
          if (!chatId) return;
          const brief = await busGet<{ mode?: string; brief?: { approach?: string; files?: string[]; risks?: string[] } }>(`task:node:clarify:${taskId}:${nodeId}`);
          if (!brief?.brief) return;
          const graph = await getTaskGraph(taskId);
          const nodeName = graph?.nodes.find((n) => n.id === nodeId)?.name || nodeId;
          const card = nodeClarifyCard(taskId, nodeId, nodeName, brief.brief);
          const messageId = await sendCard(cfg, chatId, card);
          if (messageId) await busSet(`feishu:route:${messageId}`, { act: 'node_confirm', task_id: taskId, node_id: nodeId }, ROUTE_TTL_SEC);
          return;
        }
        case 'discussion_ask_user': {
          const discussionId = String(payload.discussion_id || '');
          if (!discussionId || (await seen(`discask:${discussionId}:${String(env?.message || '').slice(0, 50)}`))) return;
          const target = defaultTarget(cfg);
          if (!target) return;
          const card = discussAskCard(String(env?.message || '讨论需要你拍板'));
          const messageId = await sendCard(cfg, target.id, card, target.type);
          if (messageId) await busSet(`feishu:route:${messageId}`, { act: 'discuss_answer', discussion_id: discussionId }, ROUTE_TTL_SEC);
          return;
        }
        default:
          return;
      }
    })().catch((e) => logger.warn('Feishu decision card render failed', { error: String(e).slice(0, 200), type }));
  });
}

// ---------- 动作执行（card.action.trigger） ----------

/** 表单提交按钮的 name 统一 'go'（表单 name 与按钮 name 不得重复——实测 230099）。 */
const FORM_SUBMIT_NAME = 'go';

export async function handleDecisionAction(cfg: FeishuConfig, deps: DecisionDeps, input: CardActionInput): Promise<Record<string, unknown> | void> {
  const logger = getLogger();
  const who = input.operatorOpenId || 'unknown';

  // 参数来源优先级：behaviors value（普通按钮）> feishu:route:{message_id}（表单提交）> name 内联协议
  let params: Record<string, unknown> | null = input.value && Object.keys(input.value).length ? input.value : null;
  if (!params && input.messageId) {
    params = (await busGet(`feishu:route:${input.messageId}`)) || null;
  }
  if (!params && input.actionName && input.actionName !== FORM_SUBMIT_NAME) {
    const [kind, ...rest] = input.actionName.split(':');
    if (kind === 'ask' && rest.length >= 2) params = { act: 'ask_answer', task_id: rest[0], ask_id: rest[1] };
    else if (kind === 'clarify' && rest.length >= 1) params = { act: 'clarify_answer', task_id: rest[0] };
    else if (kind === 'nodeconfirm' && rest.length >= 2) params = { act: 'node_confirm', task_id: rest[0], node_id: rest[1] };
    else if (kind === 'discuss' && rest.length >= 1) params = { act: 'discuss_answer', discussion_id: rest[0] };
  }
  if (!params) return;

  const act = String(params.act || '');
  const taskId = String(params.task_id || '');
  const reply = async (title: string, lines: string[]): Promise<Record<string, unknown>> => {
    const card = buildResultCard(title, lines);
    if (input.messageId) await updateCard(cfg, input.messageId, card).catch(() => false);
    return cardResponse(card);
  };

  try {
    // 白名单二次校验（与 v1 审批卡同机制）
    if (!cfg.approvers?.length || !cfg.approvers.includes(who)) {
      logger.warn('Feishu decision action rejected by approver whitelist', { who, act });
      return reply('无权操作', [`操作人 ${who} 不在审批白名单（config.feishu.approvers）内。`]);
    }

    switch (act) {
      case 'ask_answer': {
        const askId = String(params.ask_id || '');
        const answer = String(input.formValue?.answer || '').trim();
        if (!answer) return reply('回答为空', ['请输入回答后再提交。']);
        const ok = await resolveAsk(askId, taskId, answer, who);
        return ok
          ? reply('✅ 已回答', [`任务 ${taskId} · ${askId}`, 'agent 将立即继续执行。'])
          : reply('⏱ 已超时或已处理', [`任务 ${taskId} 的提问 ${askId} 不在等待中。`]);
      }
      case 'ask_skip': {
        const askId = String(params.ask_id || '');
        const ok = await resolveAsk(askId, taskId, '（用户选择跳过，请按默认方案继续）', `${who}(skip)`);
        return ok
          ? reply('↩️ 已跳过', ['agent 将按默认方案继续。'])
          : reply('⏱ 已超时或已处理', [`提问 ${askId} 不在等待中。`]);
      }
      case 'proposal_approve':
      case 'proposal_reject': {
        const proposalId = String(params.proposal_id || '');
        const approved = act === 'proposal_approve';
        const result = await decideProposal(deps, taskId, proposalId, approved, who);
        if (!result.ok) return reply('⚠ 提案处理失败', [result.error || '未知错误']);
        return approved
          ? reply('✅ 提案已批准并执行', [`任务 ${taskId} · ${proposalId}`])
          : reply('✖ 提案已拒绝', [`任务 ${taskId} · ${proposalId}`]);
      }
      case 'daily_skip':
      case 'daily_fix':
      case 'daily_task': {
        const date = String(params.date || '');
        const itemId = String(params.item_id || '');
        const action = act === 'daily_skip' ? 'skip' : act === 'daily_fix' ? 'fix_now' : 'create_task';
        const r = await resolveDaily(deps, date, itemId, action);
        if (!r.ok) return reply(r.error === 'already resolved' ? '☑ 该问题已裁决' : '⚠ 裁决失败', [r.error || '']);
        return action === 'skip'
          ? reply('☑ 已跳过', [`报告 ${date} · ${itemId}`])
          : reply('✅ 已转修复任务', [`任务 ${r.task_id || ''}`]);
      }
      case 'clarify_answer': {
        const answers: { question: string; answer: string }[] = [];
        const questions = (await busGet<{ rounds?: number; questions?: string[] }>(`task:clarify:${taskId}`))?.questions || [];
        questions.forEach((q, i) => {
          const a = String(input.formValue?.[`a${i + 1}`] || '').trim();
          if (a) answers.push({ question: q, answer: a });
        });
        if (!answers.length) return reply('回答为空', ['请至少回答一个问题，或点「直接确认」。']);
        const r = await deps.clarify(taskId, { answers });
        return r.status === 'planned'
          ? reply('✅ 需求已明确', ['进入计划阶段，计划就绪后会推送通知。'])
          : reply('✅ 已回答', ['若仍有疑问会推送下一轮澄清卡。']);
      }
      case 'clarify_confirm': {
        const r = await deps.clarify(taskId, { confirm: true });
        return r.status === 'planned'
          ? reply('✅ 已确认', ['进入计划阶段，计划就绪后会推送通知。'])
          : reply('✅ 已确认', [`当前状态：${r.status}`]);
      }
      case 'node_confirm': {
        const nodeId = String(params.node_id || '');
        const r = await deps.clarifyNode(taskId, nodeId, { approve: true, text: String(input.formValue?.note || '').trim() || undefined });
        if (r.status === 'pending') await deps.enqueue(taskId, null, '');
        return reply('✅ 已确认开工', [`节点 ${nodeId} 重新入队。`]);
      }
      case 'discuss_answer': {
        const discussionId = String(params.discussion_id || '');
        const answer = String(input.formValue?.answer || '').trim();
        if (!answer) return reply('回答为空', ['请输入内容后再提交。']);
        await deps.postDiscussionMessage(discussionId, answer);
        return reply('✅ 已回应讨论', [answer.slice(0, 100)]);
      }
      default:
        return;
    }
  } catch (e) {
    logger.warn('Feishu decision action failed', { error: String(e).slice(0, 300), act });
    return reply('⚠ 处理失败', [String((e as Error).message || e).slice(0, 200)]).catch(() => undefined);
  }
}

// ---------- 监督者提案决定（复刻 POST /api/tasks/:taskId/proposals/:proposalId/decide，api/index.ts:680-776） ----------

async function decideProposal(deps: DecisionDeps, taskId: string, proposalId: string, approved: boolean, who: string): Promise<{ ok: boolean; status?: string; error?: string }> {
  const graph: TaskGraph | null = await getTaskGraph(taskId);
  if (!graph) return { ok: false, error: 'task not found' };
  const key = `task:proposals:${taskId}`;
  const proposals = (await busGet<any[]>(key)) || [];
  const proposal = proposals.find((x) => x.id === proposalId);
  if (!proposal) return { ok: false, error: 'proposal not found' };
  if (proposal.status !== 'pending') return { ok: false, error: `proposal already ${proposal.status}` };
  proposal.decided_at = new Date().toISOString();
  if (!approved) {
    proposal.status = 'rejected';
    await busSet(key, proposals);
    await appendJournal(taskId, 'orchestrator', {
      role: 'master', kind: 'round',
      text: `监督者提案已拒绝（飞书审批 ${who}）：${proposal.reason || proposal.type}`,
      ts: new Date().toISOString(), node_id: '', node_name: '',
      meta: { supervisor: true, proposal_id: proposalId, decision: 'rejected' },
    });
    return { ok: true, status: 'rejected' };
  }
  proposal.status = 'approved';
  try {
    if (proposal.type === 'retry_failed') {
      const node = graph.nodes.find((n) => n.id === proposal.node_id);
      if (!node) throw new Error(`节点 ${proposal.node_id} 不存在`);
      if (node.status !== 'failed') throw new Error(`节点状态为 ${node.status}，仅 failed 节点可重试`);
      node.status = 'pending';
      node.error = '';
      node.needs_human = false;
      await persistGraph(graph);
      await deps.enqueue(taskId, graph.project_id ?? null, graph.workspace);
    } else if (proposal.type === 'cancel_subtree') {
      const node = graph.nodes.find((n) => n.id === proposal.node_id);
      if (!node) throw new Error(`节点 ${proposal.node_id} 不存在`);
      if (!['pending', 'failed', 'waiting_approval', 'waiting_clarify'].includes(node.status)) {
        throw new Error(`节点状态为 ${node.status}，不可取消`);
      }
      node.status = 'cancelled';
      node.error = '监督者提案批准：取消';
      const upstream = new Map<string, string[]>();
      for (const n of graph.nodes) upstream.set(n.id, []);
      for (const [src, dst] of graph.edges) upstream.get(dst)?.push(src);
      let changed = true;
      const cancelled = new Set([node.id]);
      while (changed) {
        changed = false;
        for (const n of graph.nodes) {
          if (n.status === 'pending' && (upstream.get(n.id) || []).some((d) => cancelled.has(d))) {
            n.status = 'cancelled';
            n.error = '上游被取消（监督者提案）';
            cancelled.add(n.id);
            changed = true;
          }
        }
      }
      await persistGraph(graph);
    } else if (proposal.type === 'insert_node') {
      await deps.addNode(taskId, {
        name: String(proposal.new_node?.name || '监督者插入节点'),
        agent: String(proposal.new_node?.agent || ''),
        afterNodeId: String(proposal.after_node_id || graph.nodes[0]?.id || ''),
      });
    } else if (proposal.type === 'derive_task') {
      const created = await deps.createTask(
        String(proposal.description || proposal.reason || '派生修复任务'),
        graph.workspace,
        graph.project_id,
        { autoRun: true, planAsync: true, skipClarification: true },
      );
      proposal.derived_task_id = created.taskId;
    } else {
      throw new Error(`未知提案类型 ${proposal.type}`);
    }
    proposal.status = 'executed';
    await busSet(key, proposals);
    await appendJournal(taskId, 'orchestrator', {
      role: 'master', kind: 'round',
      text: `监督者提案已批准并执行（飞书审批 ${who}）：${proposal.reason || proposal.type}`,
      ts: new Date().toISOString(), node_id: '', node_name: '',
      meta: { supervisor: true, proposal_id: proposalId, decision: 'executed' },
    });
    await emitProgress('supervisor_proposal_executed', { task_id: taskId, proposal_id: proposalId, type: proposal.type });
    return { ok: true, status: 'executed' };
  } catch (e: any) {
    proposal.status = 'failed';
    proposal.exec_error = String(e?.message || e).slice(0, 300);
    await busSet(key, proposals);
    return { ok: false, error: proposal.exec_error };
  }
}

// ---------- 每日报告裁决（复刻 POST /api/reports/daily/:date/resolve，api/index.ts:1822-1859） ----------

async function resolveDaily(deps: DecisionDeps, date: string, itemId: string, action: 'fix_now' | 'create_task' | 'skip'): Promise<{ ok: boolean; task_id?: string; error?: string }> {
  const report = await getDailyReport(date);
  if (!report) return { ok: false, error: `report not found: ${date}` };
  const item = report.items.find((i) => i.id === itemId);
  if (!item) return { ok: false, error: 'report item not found' };
  if (report.resolved?.[itemId]) return { ok: false, error: 'already resolved' };
  let repairTaskId: string | undefined;
  if (action === 'fix_now' || action === 'create_task') {
    let workspace = '';
    if (item.sources[0]?.task_id) {
      const src = await getTaskGraph(item.sources[0].task_id);
      workspace = src?.workspace || '';
    }
    if (!workspace) return { ok: false, error: 'workspace is required (no source task workspace found)' };
    const description = `修复问题报告（${date}）：${item.sample.slice(0, 300)}${item.sources[0]?.task_id ? `\n\n来源任务: ${item.sources[0].task_id}` : ''}`;
    const created = await deps.createTask(description, workspace, undefined, { level: 'light' });
    repairTaskId = created.taskId;
  }
  await resolveReportItem(date, itemId, action, repairTaskId);
  try {
    writeKnowledge({
      title: `问题裁决：${item.category} · ${item.sample.slice(0, 50)}`,
      content: `问题模式：${item.sample.slice(0, 500)}\n\n用户裁决：${action === 'skip' ? '已确认忽略' : `已转修复任务 ${repairTaskId || ''}`}\n来源：每日问题报告 ${date}（${item.count} 次出现）`,
      category: 'feedback',
      project_id: undefined,
      tags: ['问题报告', action],
      source: `daily-report:${date}`,
    });
  } catch { /* 裁决回流失败不阻塞 */ }
  return { ok: true, task_id: repairTaskId };
}
