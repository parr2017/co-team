/**
 * Feishu bot (feishu_architecture.md §3.1): tenant_access_token lifecycle.
 * Cached in memory AND on the bus (TTL 7100s — the token is valid for 2h, we
 * refresh ~100s early) so multiple processes share one token stream.
 */
import { createHash } from 'node:crypto';
import { busGet, busSet } from '../bus';
import type { FeishuConfig } from '../config';

const TOKEN_KEY = 'feishu:tenant_token';
const TOKEN_TTL_SEC = 7100;

let memCache: { token: string; expiresAt: number } | null = null;

export function apiBase(cfg: FeishuConfig): string {
  return (cfg.api_base || 'https://open.feishu.cn').replace(/\/+$/, '');
}

export interface TokenResponse {
  code: number;
  msg?: string;
  tenant_access_token?: string;
  expire?: number;
}

export async function fetchTenantToken(cfg: FeishuConfig): Promise<string> {
  if (!cfg.app_id || !cfg.app_secret) throw new Error('feishu app_id/app_secret not configured');
  const res = await fetch(`${apiBase(cfg)}/open-apis/auth/v3/tenant_access_token/internal`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ app_id: cfg.app_id, app_secret: cfg.app_secret }),
    signal: AbortSignal.timeout(10_000),
  });
  const data = (await res.json()) as TokenResponse;
  if (data.code !== 0 || !data.tenant_access_token) {
    throw new Error(`feishu token fetch failed (${data.code}): ${data.msg || 'unknown'}`);
  }
  return data.tenant_access_token;
}

export async function getTenantToken(cfg: FeishuConfig): Promise<string> {
  if (memCache && memCache.expiresAt > Date.now()) return memCache.token;

  // bus-level cache (shared across restarts / processes)
  const cached = await busGet<{ token: string; expiresAt: number }>(TOKEN_KEY);
  if (cached && cached.expiresAt > Date.now()) {
    memCache = cached;
    return cached.token;
  }

  const token = await fetchTenantToken(cfg);
  // hash before logging in one place; the token itself must never be logged
  const expiresAt = Date.now() + TOKEN_TTL_SEC * 1000;
  memCache = { token, expiresAt };
  await busSet(TOKEN_KEY, { token, expiresAt }, TOKEN_TTL_SEC);
  return token;
}

/** Reset in-memory cache (tests / forced refresh). */
export function resetTokenCache(): void {
  memCache = null;
}

/** Verify the X-Lark-Signature header: sha256(timestamp + nonce + encrypt_key + body). */
export function verifySignature(opts: { timestamp: string; nonce: string; encryptKey: string; body: string; signature: string }): boolean {
  const expected = createHash('sha256').update(`${opts.timestamp}${opts.nonce}${opts.encryptKey}${opts.body}`).digest('hex');
  return expected === opts.signature;
}
