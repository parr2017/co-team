import { afterEach, describe, expect, it, vi } from 'vitest';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';

// 思考熔断回归（o3xmkraj 复盘）：聚合网关对推理通道不受 max_tokens 约束
// （32000 档实测返回 38369 token 且正文空）——纯思考超当轮预算 1.5× 仍无
// 正文时客户端主动 abort 提前止损；以及 E5 软重试的 extraBody 透传。

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

function sseLine(delta: Record<string, unknown>, finishReason: string | null = null): string {
  return `data: ${JSON.stringify({ choices: [{ delta, finish_reason: finishReason }] })}\n\n`;
}

/** reasoning-only SSE server：reasoningChars×count 产出后可选接正文/结束或永远沉默 */
async function startStreamServer(opts: {
  reasoningChars: number;
  reasoningCount: number;
  content?: string;
  finish?: string | null;
  /** 正文先于 reasoning 发送（测 sawContent 豁免） */
  contentFirst?: boolean;
  captureBody?: (body: any) => void;
}): Promise<number> {
  const server = track(http.createServer((req, res) => {
    const bodyChunks: Buffer[] = [];
    req.on('data', (c: Buffer) => bodyChunks.push(c));
    req.on('end', () => {
      if (opts.captureBody) {
        try { opts.captureBody(JSON.parse(Buffer.concat(bodyChunks).toString('utf-8'))); } catch { /* ignore */ }
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const reasoningLines = Array.from({ length: opts.reasoningCount }, () => sseLine({ reasoning_content: 'x'.repeat(opts.reasoningChars) }));
      if (opts.content !== undefined && opts.contentFirst) res.write(sseLine({ content: opts.content }));
      for (const line of reasoningLines) res.write(line);
      if (opts.content !== undefined && !opts.contentFirst) res.write(sseLine({ content: opts.content }));
      if (opts.finish) res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: opts.finish }] })}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
    });
  }));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return (server.address() as AddressInfo).port;
}

function entryAt(port: number) {
  return makeEntry({ name: 'm-burn', api_key: 'k', base_url: `http://127.0.0.1:${port}/v1` });
}

describe('chatStreamed 思考熔断与 extraBody 透传', () => {
  it('纯思考超预算 1.5× 且正文空 → reasoning_burnout 提前止损', async () => {
    // maxTokens=100 → 阈值 150 token = 600 字符；2×400=800 字符触发
    const port = await startStreamServer({ reasoningChars: 400, reasoningCount: 5 });
    await expect(chat(entryAt(port), [{ role: 'user', content: 'hi' }], 100)).rejects.toThrow(/reasoning_burnout/);
  });

  it('思考后正常产出正文 → 不触发熔断', async () => {
    // 400 字符 = 100 token < 150 阈值，随后正文到达
    const port = await startStreamServer({ reasoningChars: 400, reasoningCount: 1, content: 'final answer', finish: 'stop' });
    const r = await chat(entryAt(port), [{ role: 'user', content: 'hi' }], 100);
    expect(r.content).toBe('final answer');
    expect(r.finishReason).toBe('stop');
  });

  it('有正文后不再熔断（sawContent 豁免）', async () => {
    // 正文先到，随后海量 reasoning 远超阈值——不触发熔断
    const port = await startStreamServer({ reasoningChars: 400, reasoningCount: 3, content: 'ok', finish: 'stop', contentFirst: true });
    const r = await chat(entryAt(port), [{ role: 'user', content: 'hi' }], 10);
    expect(r.content).toBe('ok');
  });

  it('extraBody 合并进请求体（reasoning_effort low，E5 软重试用）', async () => {
    let captured: any = null;
    const port = await startStreamServer({ reasoningChars: 1, reasoningCount: 0, content: 'ok', finish: 'stop', captureBody: (b) => { captured = b; } });
    await chat(entryAt(port), [{ role: 'user', content: 'hi' }], 100, 0, undefined, undefined, undefined, { extraBody: { reasoning_effort: 'low' } });
    expect(captured.reasoning_effort).toBe('low');
    expect(captured.max_tokens).toBe(100);
  });

  it('getLlmPolicy 不受影响（熔断不改变超时语义）', () => {
    expect(getLlmPolicy().firstTokenIdleMs).toBe(900_000);
  });
});
