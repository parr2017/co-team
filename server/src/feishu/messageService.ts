/**
 * Feishu bot message service (feishu_architecture.md §3.4): text / post /
 * interactive cards over im/v1/messages, with 429 exponential backoff and
 * card dynamic-update (PATCH) so one task = one card that evolves.
 */
import { apiBase, getTenantToken } from './tokenManager';
import type { FeishuConfig } from '../config';

export class FeishuApiError extends Error {
  constructor(public code: number, message: string, public retryable: boolean) {
    super(message);
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Authenticated Feishu API call with exponential backoff on 429/5xx. */
async function callApi(cfg: FeishuConfig, path: string, init: RequestInit, retries = 3): Promise<Record<string, any>> {
  for (let attempt = 0; ; attempt++) {
    const token = await getTenantToken(cfg);
    const res = await fetch(`${apiBase(cfg)}${path}`, {
      ...init,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...(init.headers || {}) },
      signal: AbortSignal.timeout(10_000),
    });
    if ((res.status === 429 || res.status >= 500) && attempt < retries - 1) {
      await sleep(500 * 2 ** attempt);
      continue;
    }
    const data = (await res.json().catch(() => ({}))) as Record<string, any>;
    if (!res.ok || (data.code && data.code !== 0)) {
      throw new FeishuApiError(data.code ?? res.status, data.msg || res.statusText, res.status === 429 || res.status >= 500);
    }
    return data;
  }
}

export async function sendText(cfg: FeishuConfig, chatId: string, text: string): Promise<string | null> {
  return sendContent(cfg, chatId, 'text', JSON.stringify({ text }));
}

export async function sendCard(cfg: FeishuConfig, chatId: string, card: Record<string, unknown>): Promise<string | null> {
  return sendContent(cfg, chatId, 'interactive', JSON.stringify(card));
}

async function sendContent(cfg: FeishuConfig, chatId: string, msgType: string, content: string): Promise<string | null> {
  try {
    const data = await callApi(cfg, '/open-apis/im/v1/messages?receive_id_type=chat_id', {
      method: 'POST',
      body: JSON.stringify({ receive_id: chatId, msg_type: msgType, content }),
    });
    return data?.data?.message_id ?? null;
  } catch {
    // outbound notification is best-effort — never break the calling flow
    return null;
  }
}

/** Card dynamic update: keeps one message (same message_id) evolving in place. */
export async function updateCard(cfg: FeishuConfig, messageId: string, card: Record<string, unknown>): Promise<boolean> {
  try {
    await callApi(cfg, `/open-apis/im/v1/messages/${messageId}`, {
      method: 'PATCH',
      body: JSON.stringify({ content: JSON.stringify(card) }),
    });
    return true;
  } catch {
    return false;
  }
}

/** Progress card: one card per task, updated in place on lifecycle milestones. */
export function buildTaskCard(opts: { taskId: string; title: string; status: string; detail?: string }): Record<string, unknown> {
  return {
    config: { wide_screen_mode: true },
    header: {
      template: opts.status === 'success' ? 'green' : opts.status === 'failed' ? 'red' : 'blue',
      title: { tag: 'plain_text', content: `${opts.title} · ${opts.status}` },
    },
    elements: [
      { tag: 'div', text: { tag: 'lark_md', content: opts.detail || `任务 ${opts.taskId}` } },
      { tag: 'note', elements: [{ tag: 'plain_text', content: `Co-Team · ${opts.taskId} · ${new Date().toLocaleString()}` }] },
    ],
  };
}
