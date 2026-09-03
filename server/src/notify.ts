import { emitEvent } from './store';
import { CHANNELS } from './types';

async function post(url: string, body: unknown): Promise<void> {
  try {
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(5000),
    });
  } catch {
    /* notification is best-effort */
  }
}

/** Task-lifecycle notification: log + event bus + webhook/Feishu (fire-and-forget). */
export function notify(eventType: string, payload: Record<string, unknown>, message?: string): void {
  const text = message || `[Co-Team] ${eventType}: ${payload.task_id ?? ''}`;
  console.log(`[notify] ${text}`);
  emitEvent(CHANNELS.NOTIFY, eventType, { message: text, ...payload }).catch(() => {});

  const feishu = process.env.COTEAM_FEISHU_WEBHOOK;
  if (feishu) void post(feishu, { msg_type: 'text', content: { text } });

  const webhook = process.env.COTEAM_WEBHOOK;
  if (webhook) void post(webhook, { event: eventType, message: text, payload, ts: new Date().toISOString() });
}
