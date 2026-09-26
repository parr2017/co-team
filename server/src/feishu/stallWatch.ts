/**
 * 卡住检测（任务侧）：running/retrying 任务超过 30 分钟无任何 journal 活动 →
 * 推提醒卡到任务绑定聊天（含取消按钮；每任务 2 小时最多提醒一次）。
 * OpenCode 会话的卡住检测在 ocBridge（事件驱动 + 30s 扫描）。
 */
import { busGet, busSet } from '../bus';
import { getTaskGraph, getTaskJournals, listTaskGraphs } from '../store';
import { getLogger } from '../logger';
import type { FeishuConfig } from '../config';
import { sendCard } from './messageService';
import { card2, md, note } from './cards';

const TASK_STALL_MS = 30 * 60 * 1000;
const DEDUP_TTL_SEC = 2 * 3600;
const SCAN_INTERVAL_MS = 5 * 60 * 1000;

export function startTaskStallWatch(cfg: FeishuConfig): () => void {
  const logger = getLogger();
  const timer = setInterval(() => {
    void (async () => {
      for (const g of await listTaskGraphs()) {
        if (!['running', 'retrying'].includes(g.status)) continue;
        const journals = await getTaskJournals(g.task_id).catch(() => ({}));
        const latest = Object.values(journals).flat().map((j) => j.ts || '').sort().at(-1);
        const last = latest || g.updated_at || '';
        if (!last || Number.isNaN(new Date(last).getTime())) continue;
        const silentFor = Date.now() - new Date(last).getTime();
        if (silentFor < TASK_STALL_MS) continue;
        const key = `feishu:stall:task:${g.task_id}`;
        if (await busGet(key)) continue;
        await busSet(key, 1, DEDUP_TTL_SEC);
        const bound = await busGet<{ chat_id: string }>(`feishu:card:${g.task_id}`).catch(() => null);
        if (!bound?.chat_id) continue;
        const mins = Math.max(1, Math.round(silentFor / 60000));
        await sendCard(cfg, bound.chat_id, card2('orange', `🐢 任务疑似卡住 · ${g.task_id}`, [
          md(`已 **${mins} 分钟**无新日志（状态 ${g.status}）。`),
          { tag: 'button', text: { tag: 'plain_text', content: '✖ 取消任务' }, type: 'danger', size: 'medium', behaviors: [{ type: 'callback', value: { act: 'cancel_task', task_id: g.task_id } }] },
          note(`Co-Team · 卡住检测 · ${new Date().toLocaleString()}`),
        ]));
        void getTaskGraph(g.task_id);
      }
    })().catch((e) => logger.warn('Feishu task stall scan failed', { error: String(e).slice(0, 200) }));
  }, SCAN_INTERVAL_MS);
  return () => clearInterval(timer);
}
