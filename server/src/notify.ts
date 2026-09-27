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

/** 通知文案统一带发生时间——用户收到审批/中断/完成卡时不知道事件何时发生（2026-09-28） */
function withTime(text: string): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${text}（${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}）`;
}

/** Task-lifecycle notification: log + event bus + webhook/Feishu (fire-and-forget). */
export function notify(eventType: string, payload: Record<string, unknown>, message?: string): void {
  const text = withTime(message || `[Co-Team] ${eventType}: ${payload.task_id ?? ''}`);
  console.log(`[notify] ${text}`);
  emitEvent(CHANNELS.NOTIFY, eventType, { message: text, ...payload }).catch(() => {});

  const feishu = process.env.COTEAM_FEISHU_WEBHOOK;
  if (feishu) void post(feishu, { msg_type: 'text', content: { text } });

  const webhook = process.env.COTEAM_WEBHOOK;
  if (webhook) void post(webhook, { event: eventType, message: text, payload, ts: new Date().toISOString() });
}
