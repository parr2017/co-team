/**
 * WebSocket connection with mobile-specific resilience:
 * - exponential backoff reconnect (1s → 2s → 4s → ... capped 30s)
 * - visibilitychange: reconnect immediately + fire a resync callback when
 *   returning to the foreground (phones kill sockets in the background)
 */

import { ref } from 'vue';
import type { EventEnvelope } from '../api';

const connected = ref(false);

let ws: WebSocket | null = null;
let backoffMs = 1000;
let reconnectTimer: number | undefined;
let started = false;
const listeners = new Set<(msg: EventEnvelope) => void>();
const resyncFns = new Set<() => void>();

function wsUrl(): string {
  const base = import.meta.env.VITE_API_BASE ?? '';
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  if (base) {
    // explicit base (app packaging): derive host from it
    try {
      const u = new URL(base);
      return `${proto}://${u.host}/ws/events`;
    } catch { /* fall through to same-origin */ }
  }
  return `${proto}://${location.host}/ws/events`;
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
