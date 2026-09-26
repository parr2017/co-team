/**
 * 飞书长连接网关（无公网部署的入站通道）：WSClient 以出站 WebSocket 主动连飞书，
 * 事件与卡片回调经同一连接推回，服务器零公网暴露。config.feishu.ws_enabled 显式开启。
 *
 * - im.message.receive_v1 → 去重后重新包回 { header, event } 信封，复用 webhook.ts
 *   的 processEvent（建任务/指令/会话逻辑零重写）
 * - card.action.trigger → approvalCards.handleCardAction（审批按钮）
 * - 断线由 SDK 自动重连（onReady/onError/onReconnecting 落日志，供排查"为什么没反应"）
 */
import { EventDispatcher, WSClient } from '@larksuiteoapi/node-sdk';
import type { FeishuConfig } from '../config';
import { getLogger } from '../logger';
import { seenEvent, type FeishuHandler } from './webhook';
import type { CardActionInput } from './approvalCards';

export interface WsGatewayHandle {
  close: () => void;
  status: () => { state: string; reconnectAttempts: number };
}

export function startWsGateway(
  cfg: FeishuConfig,
  getHandler: () => Promise<FeishuHandler>,
  onCardAction: (input: CardActionInput) => Promise<Record<string, unknown> | void>,
): WsGatewayHandle {
  const logger = getLogger();
  const dispatcher = new EventDispatcher({});

  dispatcher.register({
    // SDK 把 v2 事件拍平后分发（header 与 event 字段平铺顶层）——重新包回
    // processEvent 期望的信封结构，事件 id 沿用 webhook 通道的 seenEvent 去重
    'im.message.receive_v1': async (data: Record<string, any>) => {
      const eventId = typeof data?.event_id === 'string' ? data.event_id : undefined;
      if (await seenEvent(eventId)) return;
      const body = {
        schema: '2.0',
        header: { event_type: 'im.message.receive_v1', event_id: eventId },
        event: { sender: data?.sender, message: data?.message },
      };
      const handler = await getHandler();
      await handler.processEvent(body);
    },
    'card.action.trigger': async (data: Record<string, any>) => {
      const dedupKey = `card:${data?.event_id || ''}:${data?.operator?.open_id || ''}`;
      if (await seenEvent(dedupKey)) return;
      // 观测点：表单提交/按钮回调的真实字段结构（value/form_value/name）以此为准
      logger.info('Feishu card action', {
        operator: data?.operator?.open_id,
        action_tag: data?.action?.tag,
        act: data?.action?.value?.act,
        name: data?.action?.name,
        form_value: data?.action?.form_value,
        message_id: data?.context?.open_message_id,
      });
      // 卡片动作统一交挂载处路由器分发（审批/决策/convo/oc）；返回值被 SDK
      // 编码进响应帧——飞书用它作为点击后的卡片内容（空响应会回滚卡片）
      return onCardAction({
        operatorOpenId: String(data?.operator?.open_id || ''),
        messageId: data?.context?.open_message_id,
        chatId: data?.context?.open_chat_id,
        value: data?.action?.value as Record<string, unknown> | undefined,
        formValue: data?.action?.form_value as Record<string, unknown> | undefined,
        actionName: typeof data?.action?.name === 'string' ? data.action.name : undefined,
      });
    },
  });

  const client = new WSClient({
    appId: cfg.app_id!,
    appSecret: cfg.app_secret!,
    source: 'coteam',
    onReady: () => logger.info('Feishu WS gateway connected — 长连接已建立（入站通道就绪，无需公网）', { app_id: cfg.app_id }),
    onError: (err: Error) => logger.error('Feishu WS gateway failed — 检查 app_id/app_secret 与开放平台「长连接」订阅模式', { error: String(err?.message || err).slice(0, 300) }),
    onReconnecting: () => logger.warn('Feishu WS gateway reconnecting…'),
    onReconnected: () => logger.info('Feishu WS gateway reconnected'),
  });

  void client.start({ eventDispatcher: dispatcher }).catch((e) => {
    logger.error('Feishu WS gateway start failed', { error: String((e as Error)?.message || e).slice(0, 300) });
  });

  return {
    close: () => {
      try {
        client.close();
      } catch {
        /* already closed */
      }
    },
    status: () => {
      const s = client.getConnectionStatus?.();
      return { state: s?.state ?? 'unknown', reconnectAttempts: s?.reconnectAttempts ?? 0 };
    },
  };
}
