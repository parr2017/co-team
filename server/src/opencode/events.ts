/**
 * opencode SSE 事件面——分类（delta/update/meta/drop）、投影与微批。
 *
 * TUI 同构镜像要求 token 级实时：delta 类事件频率高（几十~上百/s），
 * 直接逐条转 WS 会撞 /ws/events 的 burst 上限（1600/窗口，见 wsEnhance:1600）。
 * 策略：delta 进微批队列（50ms 窗口合并为一帧），其余事件即时单帧；
 * flush 前遇到非 delta 事件先清空队列——保证 delta→updated/commit 的相对顺序不乱。
 * 基础设施噪音（heartbeat/catalog/lsp/watcher 等）默认丢弃，不给前端添乱。
 */
import type { OcEvent } from './types';

/** 明确丢弃的基础设施事件（与对话镜像无关） */
const DROP_TYPES = new Set([
  'server.heartbeat',
  'catalog.updated',
  'reference.updated',
  'integration.updated',
  'integration.connection.updated',
  'plugin.added',
  'file.watcher.updated',
  'installation.updated',
  'installation.update-available',
  'mcp.tools.changed',
  'mcp.browser.open.failed',
  'command.executed',
  'vcs.branch.updated',
  'workspace.status',
  'global.disposed',
]);

/** 丢弃前缀匹配（lsp.*、vcs.* 等整族噪声） */
const DROP_PREFIXES = ['lsp.', 'vcs.', 'catalog.'];

/** delta 类：高频、可合并（消息/思考/工具输入/压缩的增量帧） */
export function isDeltaEvent(type: string): boolean {
  return type.endsWith('.delta') || type.includes('.delta.');
}

/** 基础设施噪声：转发前丢弃 */
export function isDroppedEvent(type: string): boolean {
  if (DROP_TYPES.has(type)) return true;
  return DROP_PREFIXES.some((p) => type.startsWith(p));
}

/** 事件归属的 session id（各事件族字段名不一：sessionID/session_id/sessionId；无归属返回空） */
export function eventSessionId(ev: OcEvent): string {
  const p = (ev.properties || {}) as Record<string, unknown>;
  const info = (p.info || {}) as Record<string, unknown>;
  return String(
    p.sessionID ?? p.session_id ?? p.sessionId ??
    info.sessionID ?? info.session_id ?? info.sessionId ??
    (typeof p.session === 'object' && p.session ? ((p.session as Record<string, unknown>).id ?? '') : '') ?? '',
  );
}

/**
 * 事件微批器：delta 入队 50ms 合并；非 delta 即时发（发前先清空积压 delta 保序）。
 * sink 收到的帧：单事件 {instance, event} 或批 {instance, events:[...]}——前端两种都认。
 */
export class EventBatcher {
  private queue: OcEvent[] = [];
  private timer: NodeJS.Timeout | undefined;

  constructor(
    private readonly sink: (instanceId: string, frame: { event?: OcEvent; events?: OcEvent[] }) => void,
    private readonly instanceId: string,
    private readonly windowMs = 50,
  ) {}

  push(ev: OcEvent): void {
    if (isDeltaEvent(ev.type)) {
      this.queue.push(ev);
      if (!this.timer) {
        this.timer = setTimeout(() => this.flushDeltas(), this.windowMs);
      }
      // 极端洪峰保护：队列超 256 帧强制 flush（流控见 llm 的 stream_flood 同款思想）
      if (this.queue.length >= 256) this.flushDeltas();
      return;
    }
    // 非 delta 即时：先清积压保序，再单帧发
    this.flushDeltas();
    this.sink(this.instanceId, { event: ev });
  }

  private flushDeltas(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    if (!this.queue.length) return;
    const events = this.queue;
    this.queue = [];
    this.sink(this.instanceId, { events });
  }

  dispose(): void {
    this.flushDeltas();
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }
}
