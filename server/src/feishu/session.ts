/**
 * Feishu bot session context (feishu_commands_spec.md §3.1): one isolated
 * context per user — current project + agent, 24h sliding expiry.
 */
import { busGet, busSet } from '../bus';

const SESSION_TTL_SEC = 24 * 3600;

export interface FeishuSession {
  user_id: string;
  current_project_id?: string;
  current_project_name?: string;
  current_agent_id?: string;
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
