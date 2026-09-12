import { getBus } from './bus';
import { CHANNELS } from './types';
import { listTaskGraphs, getTaskGraph } from './store';
import { listAsks } from './askGate';
import { getLogger } from './logger';

/**
 * M5.2 任务↔群聊互通：
 * - ① 运行中任务状态摘要注入讨论上下文（discussion.ts buildProjectContextBlock 调用）
 * - ② 任务关键事件回流绑定项目的讨论流（阶段启动/验收报告/提案/终态）
 * - ③ 任务 ask_user 提问同步进讨论，用户可在群里直接回答（meta 携带 task_id+ask_id）
 * 讨论不引入对任务的写路径——全部是只读摘要与通知，回答走既有 ask API。
 */

const ACTIVE_STATUSES = ['running', 'retrying', 'queued', 'pending', 'planned', 'waiting_approval', 'waiting_clarify'];

/** ① 项目运行中任务速览（注入讨论共享上下文，成员据此真实回答"进度怎么样"） */
export async function discussionTaskDigest(projectId: string): Promise<string> {
  try {
    const graphs = (await listTaskGraphs()).filter((g) => g.project_id === projectId);
    const active = graphs.filter((g) => ACTIVE_STATUSES.includes(g.status)).slice(0, 3);
    if (!active.length) return '';
    const lines: string[] = [];
    for (const g of active) {
      const total = g.nodes.length;
      const done = g.nodes.filter((n) => n.status === 'completed').length;
      const running = g.nodes.filter((n) => n.status === 'running' || n.status === 'retrying').map((n) => n.name);
      const blocked = g.nodes.filter((n) => ['failed', 'waiting_approval', 'waiting_clarify'].includes(n.status)).length;
      let askLine = '';
      try {
        const pending = (await listAsks(g.task_id)).filter((a) => a.status === 'pending');
        if (pending.length) askLine = `；未答提问 ${pending.length} 条`;
      } catch { /* best effort */ }
      lines.push(
        `- 任务 ${g.task_id}「${(g.description || '').slice(0, 40)}」${g.status}` +
        `${g.rolling ? ` 第${g.stage_count || 1}阶段` : ''}：节点 ${done}/${total}${running.length ? `，正在跑：${running.map((n) => n.slice(0, 24)).join('、')}` : ''}` +
        `${blocked ? `，卡点 ${blocked} 个` : ''}${askLine}`
      );
    }
    const digest = lines.join('\n');
    return digest.slice(0, 1200);
  } catch {
    return '';
  }
}

/** ②③ 把关键事件以系统通知发进绑定项目的活跃讨论（最新一个 discussing 状态的讨论） */
async function postToProjectDiscussions(projectId: string, text: string, meta?: Record<string, any>): Promise<void> {
  const { listDiscussions, postTaskNotice } = await import('./discussion');
  const discs = (await listDiscussions()).filter((d) => d.project_id === projectId && d.status === 'discussing');
  const target = discs[0];
  if (!target) return;
  await postTaskNotice(target.id, text, meta);
}

/** 服务启动时调用：订阅任务事件流，把关键事件回流进绑定项目的讨论 */
export function initDiscussionBridge(): void {
  const logger = getLogger();
  getBus().subscribe(CHANNELS.TASK, (envelope: unknown) => {
    void onEvent(envelope).catch((e) => logger.warn('discussion bridge onEvent failed', { error: String(e) }));
  });
  logger.info('Discussion bridge started');
}

async function onEvent(envelope: unknown): Promise<void> {
  const env = envelope as Record<string, any> | null;
  const type = String(env?.type || '');
  const p = (env?.payload || {}) as Record<string, any>;
  const taskId = String(p.task_id || '');
  if (!taskId) return;
  const graph = await getTaskGraph(taskId).catch(() => null);
  const projectId = graph?.project_id;
  if (!projectId) return;

  switch (type) {
    case 'stage_started':
      await postToProjectDiscussions(projectId, `📋 任务 ${taskId} 第 ${p.stage} 阶段启动：${String(p.stage_goal || '').slice(0, 120)}`);
      return;
    case 'acceptance_report':
      await postToProjectDiscussions(projectId, `🏁 任务 ${taskId} 最终验收：机审红灯 ${p.failed} 项、待人工 ${p.open} 项（平台：${(p.platforms || []).join('/')}）——详见任务详情`);
      return;
    case 'supervisor_proposal':
      await postToProjectDiscussions(projectId, `🔔 任务 ${taskId} 有监督者提案待批准——去任务频道处理`);
      return;
    case 'ask_created': {
      if (String(p.to || '') !== 'user') return;
      await postToProjectDiscussions(projectId, `❓ 任务 ${taskId} 的 ${p.from} 提问：${String(p.question || '').slice(0, 200)}`, {
        bridge_ask: { task_id: taskId, ask_id: String(p.ask_id || ''), question: String(p.question || '') },
      });
      return;
    }
    case 'ask_resolved': {
      if (!p.no_answer) await postToProjectDiscussions(projectId, `💬 任务 ${taskId} 的提问已被回答，agent 继续执行`);
      return;
    }
    case 'execute_complete':
      await postToProjectDiscussions(projectId, `✅ 任务 ${taskId} 已完成并通过最终验收`);
      return;
    case 'execute_failed':
      await postToProjectDiscussions(projectId, `❌ 任务 ${taskId} 失败：${String(p.error || '').slice(0, 150)}——详见任务详情与提案`);
      return;
    default:
      return;
  }
}
