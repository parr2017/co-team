import { afterEach, describe, expect, it, vi } from 'vitest';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';

// force the streaming path so the idle watchdog is exercised
vi.hoisted(() => {
  process.env.COTEAM_LLM_STREAM = '1';
});

import { chat, configureLlmTimeouts, getLlmPolicy } from '../src/llm';
import { makeEntry } from '../src/scheduler';

const DEFAULTS = { first_token_idle_sec: 900, stream_idle_sec: 900, wallclock_cap_sec: 0, non_stream_timeout_sec: 900 };

const servers: http.Server[] = [];
function track(server: http.Server): http.Server {
  servers.push(server);
  return server;
}

afterEach(() => {
  for (const s of servers.splice(0)) s.close();
  configureLlmTimeouts(DEFAULTS);
});

/** SSE server: `chunks` written one by one with `gapMs` spacing (0 gap = instant).
 *  `endAfterChunks=false` leaves the stream open forever after writing them. */
async function startStreamServer(chunks: string[], gapMs: number, endAfterChunks: boolean, usageExtra = ''): Promise<number> {
  const server = track(http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    let i = 0;
    const tick = () => {
      if (i < chunks.length) {
        res.write(`data: {"choices":[{"delta":{"content":"${chunks[i]}"}}]}\n\n`);
        i += 1;
        setTimeout(tick, gapMs);
        return;
      }
      if (endAfterChunks) {
        res.write('data: {"choices":[{"finish_reason":"stop"}]}\n\n');
        if (usageExtra) res.write(`data: {"choices":[],"usage":${usageExtra}}\n\n`);
        res.write('data: [DONE]\n\n');
        res.end();
      }
      // else: headers + chunks written, then silence forever
    };
    tick();
  }));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return (server.address() as AddressInfo).port;
}

/** Server that sends HTTP headers but no SSE data at all (prefill-forever). */
async function startSilentServer(): Promise<number> {
  const server = track(http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(': keep-alive-nothing\n\n'); // comments don't produce chunks — but to be strict we write nothing
  }));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return (server.address() as AddressInfo).port;
}

/** Server that opens the stream, sends one empty-delta chunk, then hangs (fdj1b4s0 形态). */
async function startStalledServer(): Promise<number> {
  return startStreamServer([''], 0, false);
}

const entryFor = (port: number, name = 'test-model') =>
  makeEntry({ name, api_key: 'k', base_url: `http://127.0.0.1:${port}/v1` });

describe('llm 超时语义重做（时长不判死，2026-09-09）', () => {
  it('慢但持续吐块的流绝不被杀：总时长超旧 600s 绞杀线也在活着时完成', async () => {
    configureLlmTimeouts({ first_token_idle_sec: 0.3, stream_idle_sec: 0.5, wallclock_cap_sec: 0 });
    // 20 chunks × 120ms ≈ 2.4s 总时长——远超各 idle 阈值，但每 120ms 有进度
    const port = await startStreamServer(Array(20).fill('x'), 120, true);
    const resp = await chat(entryFor(port), [{ role: 'user', content: 'ping' }]);
    expect(resp.content).toBe('x'.repeat(20));
    expect(resp.finishReason).toBe('stop');
    expect(resp.elapsedMs).toBeGreaterThanOrEqual(1500); // 证明"活着跑完了"而不是秒回
  });

  it('首 token 前静默超线 → stream_stalled（prefill 挂死形态）', async () => {
    configureLlmTimeouts({ first_token_idle_sec: 0.3, stream_idle_sec: 5 });
    const port = await startSilentServer();
    const started = Date.now();
    await expect(chat(entryFor(port), [{ role: 'user', content: 'ping' }])).rejects.toThrow(/stream_stalled.*首token前/);
    expect(Date.now() - started).toBeLessThan(4000);
  });

  it('流中途静默超线 → stream_stalled（E10 原始事故的正确判定：静默而非时长）', async () => {
    configureLlmTimeouts({ first_token_idle_sec: 5, stream_idle_sec: 0.4 });
    const port = await startStalledServer();
    await expect(chat(entryFor(port), [{ role: 'user', content: 'ping' }])).rejects.toThrow(/stream_stalled.*token间/);
  });

  it('任意 chunk 刷新空闲计时：停滞前的进度不作废', async () => {
    configureLlmTimeouts({ first_token_idle_sec: 5, stream_idle_sec: 0.5 });
    // 先活 5×100ms，再静默——静默超时从最后一个 chunk 起算
    const port = await startStreamServer(Array(5).fill('y'), 100, false);
    const started = Date.now();
    await expect(chat(entryFor(port), [{ role: 'user', content: 'ping' }])).rejects.toThrow(/stream_stalled/);
    const elapsed = Date.now() - started;
    expect(elapsed).toBeGreaterThanOrEqual(500); // 至少从末 chunk(~500ms)之后再等一个 idle 周期
    expect(elapsed).toBeLessThan(3000);
  });

  it('墙钟保险丝（可选，默认关闭）命中时报 wallclock_cap 而非停滞', async () => {
    configureLlmTimeouts({ first_token_idle_sec: 0, stream_idle_sec: 0 });
    const port = await startStreamServer(['a', 'b', 'c', 'd'], 150, false); // 永不结束
    await expect(chat(entryFor(port), [{ role: 'user', content: 'ping' }], undefined, 0, undefined, 400)).rejects.toThrow(/wallclock_cap/);
  });

  it('idle 全 0 = 永不主动杀（纯靠确定性信号），配合 per-call cap 仍可兜底', async () => {
    configureLlmTimeouts({ first_token_idle_sec: 0, stream_idle_sec: 0, wallclock_cap_sec: 0 });
    const port = await startStalledServer();
    // 不传 cap → 会一直挂着：用 per-call 600ms 保险丝验证"0=关"没有意外中止
    await expect(chat(entryFor(port), [{ role: 'user', content: 'ping' }], undefined, 0, undefined, 600)).rejects.toThrow(/wallclock_cap/);
  });

  it('流无 finish_reason 且无内容即结束 → connection_died（伪成功防线）', async () => {
    const server = track(http.createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('data: [DONE]\n\n');
      res.end(); // 立刻正常收尾，但没有 finish_reason 也没有内容
    }));
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as AddressInfo).port;
    await expect(chat(entryFor(port), [{ role: 'user', content: 'ping' }])).rejects.toThrow(/connection_died/);
  });

  it('服务端回传 cached_tokens 时透出（前缀缓存命中观测）', async () => {
    const port = await startStreamServer(['hello'], 0, true, '{"prompt_tokens":100,"completion_tokens":2,"prompt_tokens_details":{"cached_tokens":88}}');
    const resp = await chat(entryFor(port), [{ role: 'user', content: 'ping' }]);
    expect(resp.cachedTokens).toBe(88);
    expect(resp.promptTokens).toBe(100);
    expect(resp.firstTokenMs).toBeTypeOf('number');
  });

  it('policy 默认值：idle 900s、墙钟关闭——时长本身不判死', () => {
    configureLlmTimeouts(DEFAULTS);
    const p = getLlmPolicy();
    expect(p.firstTokenIdleMs).toBe(900_000);
    expect(p.streamIdleMs).toBe(900_000);
    expect(p.wallclockCapMs).toBe(0);
  });
});
