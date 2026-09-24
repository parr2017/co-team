/**
 * opencode SSE 订阅器——TUI 同构会话页的实时事件通道（fetch + ReadableStream）。
 *
 * 两种帧型（服务端实测）：
 *   managed 直连 opencode `${url}/event`：data 即事件本体 `{type, properties}`（无 event 行）；
 *   attached 同源代理 `/api/opencode/instances/:id/events`：`event: oc` + data
 *   `{event}` 或 `{events:[...]}`（delta 微批），`event: oc_error` + `{error}`。
 * 解析统一按「events 数组 → event 对象 → 自带 type 的事件本体」降级识别。
 *
 * 选型说明：不用 EventSource——代理路由在 dashboard token 门禁后（SEC-P0），
 * EventSource 无法设 Authorization 头；fetch 可带头且对两种帧型一套代码。
 * 断线重连内置（1s→10s 退避），每次重连前重新 resolveUrl（managed 从
 * starting→connected 后自动从代理切回直连，无需刷新页面）。
 */

import { getApiToken } from './api';

/** 事件最简形状（SessionStream.applyEvent 的入参） */
export interface OcEventLike {
  type: string;
  properties?: Record<string, any>;
}

export interface OcSubHandle {
  /** 彻底退订（页面卸载） */
  close(): void;
  /** 立即重连（回前台/手动重连；重置退避） */
  reconnect(): void;
}

export interface OcSubOptions {
  /** 每次连接前解析端点（内部失败/断线重连都会重新调用） */
  resolveUrl: () => Promise<{ url: string; direct: boolean }>;
  /** 解析出的一批事件（已按帧型归一化；调用方负责 session 过滤与 applyEvent） */
  onEvents: (events: OcEventLike[]) => void;
  /** 代理显式报错帧（oc_error） */
  onError?: (message: string) => void;
  /** 连接状态（断线时 UI 出提示条） */
  onState?: (state: 'connecting' | 'open' | 'closed') => void;
}

export function subscribeOcEvents(opts: OcSubOptions): OcSubHandle {
  let closed = false;
  let controller: AbortController | null = null;
  let retryMs = 1000;
  let retryTimer: number | undefined;

  function scheduleRetry() {
    if (closed || retryTimer !== undefined) return;
    retryTimer = window.setTimeout(() => {
      retryTimer = undefined;
      void connect();
    }, retryMs);
    retryMs = Math.min(retryMs * 2, 10_000);
  }

  async function connect() {
    if (closed) return;
    let url = '';
    let direct = false;
    try {
      const r = await opts.resolveUrl();
      url = r.url;
      direct = r.direct;
    } catch {
      opts.onState?.('closed');
      scheduleRetry();
      return;
    }
    if (closed || !url) return;

    controller?.abort();
    const ac = new AbortController();
    controller = ac;
    opts.onState?.('connecting');

    try {
      const token = direct ? '' : getApiToken();
      const res = await fetch(url, {
        headers: { accept: 'text/event-stream', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        signal: ac.signal,
      });
      if (!res.ok || !res.body) throw new Error(`SSE HTTP ${res.status}`);
      opts.onState?.('open');
      retryMs = 1000;

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      let evName = '';
      let dataLines: string[] = [];

      // 单帧分发：空行到达时处理累积的 data 行
      const dispatch = () => {
        if (!dataLines.length) {
          evName = '';
          return;
        }
        const payload = dataLines.join('\n');
        const name = evName;
        dataLines = [];
        evName = '';
        handleFrame(name, payload);
      };

      const handleFrame = (name: string, payload: string) => {
        if (!payload || payload === '[DONE]') return;
        let parsed: any;
        try {
          parsed = JSON.parse(payload);
        } catch {
          return; // 单帧畸形不杀流
        }
        if (name === 'oc_error' || parsed?.error) {
          opts.onError?.(String(parsed?.error || '事件流错误').slice(0, 200));
          return;
        }
        const out: OcEventLike[] = [];
        if (Array.isArray(parsed?.events)) {
          for (const e of parsed.events) if (e && typeof e.type === 'string') out.push(e);
        } else if (parsed?.event && typeof parsed.event.type === 'string') {
          out.push(parsed.event);
        } else if (parsed && typeof parsed.type === 'string') {
          out.push(parsed); // managed 直连：data 即事件本体
        }
        if (out.length) opts.onEvents(out);
      };

      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let nl: number;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl).replace(/\r$/, '');
          buf = buf.slice(nl + 1);
          if (line === '') {
            dispatch();
          } else if (line.startsWith('event:')) {
            evName = line.slice(6).trim();
          } else if (line.startsWith('data:')) {
            dataLines.push(line.slice(5).replace(/^ /, ''));
          }
          // id:/retry:/注释行忽略
        }
      }
      throw new Error('stream ended'); // 服务端关闭流 → 走重连
    } catch {
      if (closed || ac.signal.aborted) return;
      opts.onState?.('closed');
      scheduleRetry();
    }
  }

  void connect();

  return {
    close() {
      closed = true;
      if (retryTimer !== undefined) {
        window.clearTimeout(retryTimer);
        retryTimer = undefined;
      }
      controller?.abort();
      controller = null;
    },
    reconnect() {
      if (closed) return;
      retryMs = 1000;
      if (retryTimer !== undefined) {
        window.clearTimeout(retryTimer);
        retryTimer = undefined;
      }
      void connect();
    },
  };
}
