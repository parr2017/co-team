/**
 * WebSocket connection with mobile-specific resilience:
 * - exponential backoff reconnect (1s → 2s → 4s → ... capped 30s)
 * - visibilitychange: reconnect immediately + fire a resync callback when
 *   returning to the foreground (phones kill sockets in the background)
 */

import { ref } from 'vue';
import type { EventEnvelope } from '../api';
import { openTokenGate } from '../tokenGate';

const connected = ref(false);

let ws: WebSocket | null = null;
let backoffMs = 1000;
let reconnectTimer: number | undefined;
let started = false;
let openedAt = 0;
const listeners = new Set<(msg: EventEnvelope) => void>();
const resyncFns = new Set<() => void>();

/** WS 快速被断（token 被拒）时的鉴权探活：确认 401 就弹 Token 门禁 */
async function probeUnauthorized() {
  try {
    const t = localStorage.getItem('coteam-api-token') || '';
    const res = await fetch(`${import.meta.env.VITE_API_BASE ?? ''}/api/status`, { headers: t ? { Authorization: `Bearer ${t}` } : {} });
    if (res.status === 401) void openTokenGate();
  } catch { /* 网络不可达不是鉴权问题 */ }
}

function wsUrl(): string {
  const base = import.meta.env.VITE_API_BASE ?? '';
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  // SEC-P0：API token 随 WS 升级携带
  const t = localStorage.getItem('coteam-api-token') || '';
  const qs = t ? `?token=${encodeURIComponent(t)}` : '';
  if (base) {
    // explicit base (app packaging): derive host from it
    try {
      const u = new URL(base);
      return `${proto}://${u.host}/ws/events${qs}`;
    } catch { /* fall through to same-origin */ }
  }
  return `${proto}://${location.host}/ws/events${qs}`;
}

function connect() {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
  try {
    ws = new WebSocket(wsUrl());
  } catch {
    scheduleReconnect();
    return;
  }
  ws.onopen = () => {
    connected.value = true;
    openedAt = Date.now();
    backoffMs = 1000;
  };
  ws.onmessage = (e) => {
    try {
      const msg = JSON.parse(e.data);
      if (msg && msg.type !== 'ping') {
        listeners.forEach((fn) => {
          try { fn(msg); } catch { /* listener error must not kill the loop */ }
        });
      }
    } catch { /* malformed frame */ }
  };
  ws.onclose = () => {
    connected.value = false;
    // 建连后 2s 内即被断开：多半是 token 被拒，探活确认后弹 Token 门禁
    if (openedAt && Date.now() - openedAt < 2000) void probeUnauthorized();
    openedAt = 0;
    scheduleReconnect();
  };
  ws.onerror = () => {
    connected.value = false;
    try { ws?.close(); } catch { /* noop */ }
  };
}

function scheduleReconnect() {
  window.clearTimeout(reconnectTimer);
  reconnectTimer = window.setTimeout(() => {
    connect();
    backoffMs = Math.min(backoffMs * 2, 30_000);
  }, backoffMs);
}

/** React to app regaining foreground: kill the wait, reconnect now, resync state. */
function onVisibility() {
  if (document.visibilityState !== 'visible') return;
  if (!connected.value) {
    window.clearTimeout(reconnectTimer);
    backoffMs = 1000;
    connect();
  }
  resyncFns.forEach((fn) => {
    try { fn(); } catch { /* best effort */ }
  });
}

/** token 更新后立即以新凭据重连（否则旧连接一直用失效 token 到下次自然重连） */
function forceReconnect() {
  window.clearTimeout(reconnectTimer);
  backoffMs = 1000;
  try { ws?.close(); } catch { /* noop */ }
  ws = null;
  connect();
}

export function useWs() {
  function ensureStarted() {
    if (started) return;
    started = true;
    connect();
    document.addEventListener('visibilitychange', onVisibility);
  }
  return {
    connected,
    ensureStarted,
    forceReconnect,
    onEvent(fn: (msg: EventEnvelope) => void): () => void {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    /** register a callback fired when the app returns to foreground */
    onResync(fn: () => void): () => void {
      resyncFns.add(fn);
      return () => resyncFns.delete(fn);
    },
  };
}
