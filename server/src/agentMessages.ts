/**
 * Agent-to-agent messaging (improvement #4 行为契约部分): agents leave messages for
 * other agents / the orchestrator / the user via the send_message tool. Delivery is
 * deferred — a message waits on a task-level queue until its recipient's next dispatch
 * consumes it. No mid-execution blocking Q&A here: that needs DAG suspend/wake and is
 * a separate project (see docs/不足分析与改进总进度表.md).
 */
import { busGet, busSet, busDel } from './bus';
import { appendJournal } from './store';

export interface AgentMessage {
  id: string;
  from: string;
  /** agent name | 'orchestrator' | 'user' */
  to: string;
  text: string;
  ts: string;
  node_id?: string;
  node_name?: string;
}

export const MAX_PENDING_MESSAGES = 100;
export const MAX_MESSAGES_PER_DISPATCH = 10;
export const MAX_MESSAGE_LENGTH = 2000;

function messagesKey(taskId: string): string {
  return `task:messages:${taskId}`;
}

/** Queue a message (send_message tool). Oldest entries are dropped past the cap. */
export async function pushAgentMessage(taskId: string, msg: AgentMessage): Promise<void> {
  const key = messagesKey(taskId);
  const queue = (await busGet<AgentMessage[]>(key)) || [];
  queue.push(msg);
  await busSet(key, queue.slice(-MAX_PENDING_MESSAGES));
}

/** Take (and clear) up to MAX_MESSAGES_PER_DISPATCH messages addressed to `forAgent`; everything else stays queued. */
export async function consumeAgentMessages(taskId: string, forAgent: string): Promise<AgentMessage[]> {
  const key = messagesKey(taskId);
  const queue = (await busGet<AgentMessage[]>(key)) || [];
  const taken = queue.filter((m) => m.to === forAgent).slice(0, MAX_MESSAGES_PER_DISPATCH);
  if (!taken.length) return [];
  const takenIds = new Set(taken.map((m) => m.id));
  const rest = queue.filter((m) => !takenIds.has(m.id));
  if (rest.length) await busSet(key, rest);
  else await busDel(key);
  return taken;
}

/** Take messages addressed to 'orchestrator' or 'user' so the caller can surface them in the war room. */
export async function drainSystemMessages(taskId: string): Promise<{ orchestrator: AgentMessage[]; user: AgentMessage[] }> {
  const key = messagesKey(taskId);
  const queue = (await busGet<AgentMessage[]>(key)) || [];
  const orchestrator = queue.filter((m) => m.to === 'orchestrator');
  const user = queue.filter((m) => m.to === 'user');
  if (!orchestrator.length && !user.length) return { orchestrator: [], user: [] };
  const drained = new Set([...orchestrator, ...user].map((m) => m.id));
  const rest = queue.filter((m) => !drained.has(m.id));
  if (rest.length) await busSet(key, rest);
  else await busDel(key);
  return { orchestrator, user };
}

/**
 * Task terminal state: report every message nobody consumed into the war-room journal
 * (marked 未送达) so leave-behinds are never silently dropped, then clear the queue.
 */
export async function flushUndelivered(taskId: string): Promise<number> {
  const key = messagesKey(taskId);
  const queue = (await busGet<AgentMessage[]>(key)) || [];
  await busDel(key);
  for (const m of queue) {
    await appendJournal(taskId, m.from, {
      role: 'agent',
      kind: 'message',
      text: `（未送达）给 ${m.to}：${m.text}`,
      ts: m.ts,
      node_id: m.node_id || '',
      node_name: m.node_name || '',
      meta: { to: m.to, text: m.text, undelivered: true },
    });
  }
  return queue.length;
}
