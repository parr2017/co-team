/**
 * notify 事件文本推送（Step 1 通知统一化）：
 * 任务运行中的重要时刻（完成/失败/中断/自愈/预检/监督汇报/agent 留言…）
 * 以纯文本推到任务绑定的飞书聊天——卡片规则"短知会=纯文本"，生命周期演进
 * 仍由 webhook.ts 的绑定卡原地更新负责，这里只补"聊天流里的新鲜感"。
 *
 * 订阅 coteam:notify 频道（notify() 的总线出口），白名单事件 + 同类同任务
 * 1 小时去重，避免重推风暴。
 */
import { busGet, busSet, getBus } from '../bus';
import { CHANNELS } from '../types';
import { getLogger } from '../logger';
import type { FeishuConfig } from '../config';
import { sendText } from './messageService';

const NOTABLE_EVENTS = new Set([
  'task_success',
  'task_failed',
  'task_interrupted',
  'task_auto_restart',
  'task_preflight',
  'light_escalated',
  'supervisor_report',
  'agent_user_message',
  'task_model_changed',
  'clarify_timeout',
]);

const SEEN_TTL_SEC = 3600;

export function startNotifyPush(cfg: FeishuConfig): () => void {
  const logger = getLogger();
  return getBus().subscribe(CHANNELS.NOTIFY, (envelope: unknown) => {
    const env = envelope as { type?: string; payload?: Record<string, unknown> } | null;
    const type = env?.type || '';
    if (!NOTABLE_EVENTS.has(type)) return;
    const taskId = String(env?.payload?.task_id || '');
    void (async () => {
      let chatId: string | null = null;
      if (taskId) {
        const bound = await busGet<{ chat_id: string }>(`feishu:card:${taskId}`);
        chatId = bound?.chat_id || null;
      }
      if (!chatId) return; // 面板创建的任务没有飞书绑定，不推
      const seenKey = `feishu:notify_seen:${type}:${taskId}`;
      if (await busGet(seenKey)) return;
      await busSet(seenKey, 1, SEEN_TTL_SEC);
      const text = String(env?.payload?.message || `[Co-Team] ${type} ${taskId}`);
      await sendText(cfg, chatId, text);
    })().catch((e) => logger.warn('Feishu notify push failed', { error: String(e).slice(0, 200), type }));
  });
}
