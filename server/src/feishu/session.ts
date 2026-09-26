/**
 * Feishu bot session context (feishu_commands_spec.md §3.1): one isolated
 * context per user — current project + agent, 24h sliding expiry.
 */
import { busGet, busSet } from '../bus';

const SESSION_TTL_SEC = 24 * 3600;

export type FeishuMode = 'task' | 'convo' | 'oc';

export interface FeishuSession {
  user_id: string;
  /** 窗口主题（三态互斥）：task=任务模式（默认）/ convo=协作会话 / oc=OpenCode */
  mode?: FeishuMode;
  current_project_id?: string;
  current_project_name?: string;
  current_agent_id?: string;
  /** convo 模式：当前绑定的会话 id */
  convo_id?: string;
  /** oc 模式：当前绑定的实例与会话 */
  oc_instance?: string;
  oc_session?: string;
  /** 裸命令列表的序号缓存（/switch 2 之类按它解析），随新列表覆盖 */
  last_list?: { id: string; label: string }[];
  last_list_kind?: 'convo' | 'oc_instance' | 'oc_session' | 'model' | 'agent' | 'inbox';
  last_active_time: string;
}

function sessionKey(userId: string): string {
  return `feishu:session:${userId}`;
}

export async function getSession(userId: string): Promise<FeishuSession> {
  return (
    (await busGet<FeishuSession>(sessionKey(userId))) || {
      user_id: userId,
      last_active_time: new Date().toISOString(),
    }
  );
}

export async function setSession(session: FeishuSession): Promise<void> {
  session.last_active_time = new Date().toISOString();
  await busSet(sessionKey(session.user_id), session, SESSION_TTL_SEC);
}

export async function resetSession(userId: string): Promise<FeishuSession> {
  const fresh: FeishuSession = { user_id: userId, last_active_time: new Date().toISOString() };
  await setSession(fresh);
  return fresh;
}

/** Case-insensitive substring match; returns unique hit, suggestions, or null. */
export function fuzzyMatch<T>(query: string, items: T[], nameOf: (item: T) => string): { match?: T; suggestions: T[] } {
  const q = query.trim().toLowerCase();
  if (!q) return { suggestions: items };
  const hits = items.filter((it) => nameOf(it).toLowerCase().includes(q));
  if (hits.length === 1) return { match: hits[0], suggestions: [] };
  return { suggestions: hits };
}
