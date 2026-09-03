import { busGet, busSet } from './bus';
import type { AgentConversation } from './types';

export async function saveConversation(taskId: string, nodeId: string, record: AgentConversation): Promise<void> {
  if (!taskId || !nodeId) return;
  try {
    const key = `task:log:${taskId}:${nodeId}`;
    const logs = (await busGet<AgentConversation[]>(key)) || [];
    logs.push(record);
    // cap transcript size: full file contents can be large
    await busSet(key, logs.slice(-10));
  } catch {
    /* best effort */
  }
}

export async function getTaskConversations(taskId: string): Promise<Record<string, AgentConversation[]>> {
  const keys = await (await import('./bus')).busKeys(`task:log:${taskId}:*`);
  const logs: Record<string, AgentConversation[]> = {};
  for (const key of keys) {
    const nodeId = key.split(':').pop() as string;
    logs[nodeId] = (await busGet<AgentConversation[]>(key)) || [];
  }
  return logs;
}
