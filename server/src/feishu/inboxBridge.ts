/**
 * 待拍板收件箱（/inbox）：跨引擎聚合所有"等你拍板"的事——
 * 节点审批 / 命令审批 / ask_user / 监督提案 / 需求澄清 / 开工确认 /
 * convo 审批与提问 / oc 权限与提问 / 每日报告裁决。
 *
 * /inbox        → 编号列表（按类型打标，结果缓存 1h）
 * /inbox <序号> → 把对应决策卡推到当前聊天直接操作（表单卡自动注册路由）
 *
 * 每类只取最紧迫的若干条，总上限 12 条——收件箱是目录页，不是全文流。
 */
import { busGet, busSet } from '../bus';
import { getLogger } from '../logger';
import { getTaskGraph, listTaskGraphs } from '../store';
import { listAsks } from '../askGate';
import { listConvos } from '../convo';
import { getDailyReport } from '../dailyReport';
import type { FeishuConfig } from '../config';
import type { FeishuSession } from './session';
import { setSession } from './session';
import { sendCard } from './messageService';
import { buildNodeApprovalCard, buildCommandApprovalCard } from './approvalCards';
import { askCard, proposalCard, clarifyCard, nodeClarifyCard } from './decisionCards';
import { card2, md, note, btnRow } from './cards';

export interface InboxItem {
  kind: string;
  id: string;
  title: string;
  card: Record<string, unknown>;
  /** 表单类卡片的路由参数（推送后按消息 id 注册） */
  route?: Record<string, unknown>;
}

export interface InboxBridge {
  run(arg: string, session: FeishuSession, chatId: string): Promise<string>;
}

const KIND_LABEL: Record<string, string> = {
  node_approval: '节点审批',
  command_approval: '命令审批',
  ask_user: '阻塞提问',
  proposal: '监督提案',
  clarify: '需求澄清',
  node_clarify: '开工确认',
  convo_approval: '会话审批',
  convo_ask: '会话提问',
  oc_perm: 'OC 权限',
  oc_question: 'OC 提问',
  daily: '每日报告',
};

const MAX_ITEMS = 12;

export function createInboxBridge(cfg: FeishuConfig, opts?: { ocPending?: () => { permissions: Record<string, any>[]; questions: Record<string, any>[] } }): InboxBridge {
  const logger = getLogger();
  const canApprove = !!cfg.approvers?.length;

  async function collect(): Promise<InboxItem[]> {
    const items: InboxItem[] = [];
    const push = (kind: string, id: string, title: string, card: Record<string, unknown>, route?: Record<string, unknown>) => {
      if (items.length < MAX_ITEMS) items.push({ kind, id, title, card, route });
    };

    // ---- 任务域 ----
    for (const g of await listTaskGraphs()) {
      if (items.length >= MAX_ITEMS) break;
      for (const n of g.nodes) {
        if (n.status === 'waiting_approval') {
          push('node_approval', `${g.task_id}:${n.id}`, `节点「${n.name}」等待审批 · ${g.task_id}`, buildNodeApprovalCard({ taskId: g.task_id, nodeId: n.id, name: n.name, approvers: canApprove }));
        }
        if (n.status === 'waiting_clarify') {
          const brief = await busGet<{ brief?: { approach?: string; files?: string[]; risks?: string[] } }>(`task:node:clarify:${g.task_id}:${n.id}`).catch(() => null);
          if (brief?.brief) push('node_clarify', `${g.task_id}:${n.id}`, `开工确认「${n.name}」 · ${g.task_id}`, nodeClarifyCard(g.task_id, n.id, n.name, brief.brief), { act: 'node_confirm', task_id: g.task_id, node_id: n.id });
        }
      }
      const pendCmds = (await busGet<{ id: string }[]>(`task:pending_commands:${g.task_id}`).catch(() => null)) || [];
      if (pendCmds.length) {
        const card = await buildCommandApprovalCard(g.task_id, canApprove).catch(() => null);
        if (card) push('command_approval', `${g.task_id}:commands`, `「${g.task_id}」有 ${pendCmds.length} 条命令待审批`, card);
      }
      for (const a of await listAsks(g.task_id).catch(() => [])) {
        if (a.status !== 'pending') continue;
        push('ask_user', a.id, `${a.from} 提问：${a.question.slice(0, 50)} · ${g.task_id}`, askCard(g.task_id, { id: a.id, from: a.from, question: a.question, node_name: a.node_name }), { act: 'ask_answer', task_id: g.task_id, ask_id: a.id });
      }
      const proposals = (await busGet<any[]>(`task:proposals:${g.task_id}`).catch(() => null)) || [];
      for (const p of proposals) {
        if (p.status !== 'pending') continue;
        push('proposal', p.id, `监督提案 · ${String(p.type)} · ${g.task_id}`, proposalCard(g.task_id, p));
      }
      if (g.status === 'clarifying') {
        const st = await busGet<{ rounds?: number; questions?: string[] }>(`task:clarify:${g.task_id}`).catch(() => null);
        if (st?.questions?.length) push('clarify', g.task_id, `需求澄清第 ${st.rounds ?? 1}/3 轮 · ${g.task_id}`, clarifyCard(g.task_id, st), { act: 'clarify_answer', task_id: g.task_id });
      }
    }

    // ---- convo 域 ----
    for (const c of await listConvos().catch(() => [])) {
      if (items.length >= MAX_ITEMS) break;
      const approvals = (await busGet<any[]>(`convo:${c.id}:approvals`).catch(() => null)) || [];
      for (const a of approvals) {
        if (a.status !== 'pending') continue;
        const card = card2('orange', `⛔ 会话命令待审批 · ${c.title}`, [
          md(`**命令** \`${String(a.command).slice(0, 200)}\`${a.reason ? `\n**原因** ${a.reason}` : ''}`),
          btnRow(
            { tag: 'button', text: { tag: 'plain_text', content: '批准一次' }, type: 'primary', size: 'medium', behaviors: [{ type: 'callback', value: { act: 'convo_approve', convo_id: c.id, approval_id: a.id, action: 'once' } }] },
            { tag: 'button', text: { tag: 'plain_text', content: '✖ 拒绝' }, type: 'danger', size: 'medium', behaviors: [{ type: 'callback', value: { act: 'convo_approve', convo_id: c.id, approval_id: a.id, action: 'reject' } }] },
          ),
          note(`Co-Team · 收件箱 · ${new Date().toLocaleString()}`),
        ]);
        push('convo_approval', a.id, `会话「${c.title}」命令待审批`, card);
      }
      const asks = (await busGet<any[]>(`convo:${c.id}:asks`).catch(() => null)) || [];
      for (const a of asks) {
        if (a.status !== 'pending') continue;
        const { form, inputField, submitBtn } = await import('./cards');
        const card = card2('orange', `❓ 会话提问 · ${c.title}`, [
          md(String(a.question || '').slice(0, 600)),
          form(`ib_${c.id}_${a.id}`, [inputField('answer', '输入你的回答…'), submitBtn('发送', 'go')]),
          note(`Co-Team · 收件箱 · ${new Date().toLocaleString()}`),
        ]);
        push('convo_ask', a.id, `会话「${c.title}」提问待回答`, card, { act: 'convo_answer', convo_id: c.id, ask_id: a.id });
      }
    }

    // ---- oc 域 ----
    if (opts?.ocPending) {
      const pending = opts.ocPending();
      for (const p of pending.permissions || []) {
        const pid = String(p.permissionID || p.id || '');
        const instance = String(p.instance || '');
        const sid = String(p.sessionID || p.session_id || p.sessionId || '');
        if (!pid || !instance || !sid) continue;
        const title = String(p.title || p.type || '权限请求');
        push('oc_perm', pid, `OC 权限：${title.slice(0, 60)} · ${instance}`, card2('orange', `⛔ OpenCode 权限待确认 · ${instance}`, [
          md(`**会话** ${sid.slice(0, 12)}\n**请求** ${title.slice(0, 300)}`),
          note(`Co-Team · 收件箱 · 完整审批卡以实时推送为准`),
        ]));
      }
      for (const q of pending.questions || []) {
        const qid = String(q.requestID || q.id || '');
        const instance = String(q.instance || '');
        if (!qid || !instance) continue;
        const { form, inputField, submitBtn } = await import('./cards');
        push('oc_question', qid, `OC 提问 · ${instance}`, card2('orange', `❓ OpenCode 提问 · ${instance}`, [
          md(String(q.question || q.title || '').slice(0, 600) || '（详见面板）'),
          form(`ibi_${qid}`, [inputField('answer', '输入你的回答…'), submitBtn('发送', 'go')]),
          note(`Co-Team · 收件箱 · ${new Date().toLocaleString()}`),
        ]), { act: 'oc_question', instance, request_id: qid });
      }
    }

    // ---- 每日报告 ----
    const lastDate = await busGet<string>('reports:daily:last_generated_date').catch(() => null);
    if (lastDate) {
      const report = await getDailyReport(lastDate).catch(() => null);
      const unresolved = report?.items.filter((i) => !report.resolved?.[i.id]) || [];
      if (report && unresolved.length) {
        push('daily', report.date, `每日报告 ${report.date}：${unresolved.length} 类问题待裁决`, card2('blue', `📋 每日问题报告 · ${report.date}`, [
          md(`**待你裁决** ${unresolved.length} 类（跳过 / 立即修 / 建任务）`),
          note('Co-Team · 收件箱 · 推送后逐条操作'),
        ]));
      }
    }

    return items;
  }

  return {
    async run(arg, session, chatId) {
      if (!arg.trim()) {
        const items = await collect();
        if (!items.length) return '✅ 没有等你拍板的事。';
        session.last_list = items.map((it, i) => ({ id: String(i + 1), label: it.title }));
        session.last_list_kind = 'inbox';
        await setSession(session);
        await busSet(`feishu:inbox:${session.user_id}`, items, 3600);
        return `等你拍板（${items.length} 件）：\n${items.map((it, i) => `${i + 1}. [${KIND_LABEL[it.kind] || it.kind}] ${it.title}`).join('\n')}\n/inbox 序号 → 推送对应卡片直接处理。`;
      }
      const n = Number(arg);
      const saved = (await busGet<InboxItem[]>(`feishu:inbox:${session.user_id}`).catch(() => null)) || [];
      const item = Number.isInteger(n) ? saved[n - 1] : undefined;
      if (!item) return '序号无效：先 /inbox 刷新列表。';
      const messageId = await sendCard(cfg, chatId, item.card);
      if (messageId && item.route) await busSet(`feishu:route:${messageId}`, item.route, 7 * 24 * 3600);
      return '已推送，直接在卡片上操作。';
    },
  };
}
