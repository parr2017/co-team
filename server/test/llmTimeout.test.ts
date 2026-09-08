import { describe, expect, it, vi, afterAll } from 'vitest';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';

// force the streaming path so the E10 body-phase abort is exercised
vi.hoisted(() => {
  process.env.COTEAM_LLM_STREAM = '1';
});

import { chat } from '../src/llm';
import { makeEntry } from '../src/scheduler';

const servers: http.Server[] = [];

afterAll(() => {
  for (const s of servers) s.close();
});

/** SSE server that never finishes the stream (simulates a stalled upstream). */
async function startStalledServer(): Promise<number> {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('data: {"choices":[{"delta":{"content":""}}]}\n\n');
    // no end() — the body hangs forever
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return (server.address() as AddressInfo).port;
}

/** SSE server that completes normally (control path). */
async function startGoodServer(): Promise<number> {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('data: {"choices":[{"delta":{"content":"hello"}}]}\n\n');
    res.write('data: {"choices":[{"finish_reason":"stop"}]}\n\n');
    res.write('data: [DONE]\n\n');
    res.end();
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return (server.address() as AddressInfo).port;
}

describe('llm chat timeout (E10)', () => {
  it('aborts a stalled SSE stream within the given timeout instead of hanging forever', async () => {
    const entry = makeEntry({ name: 'stall-model', api_key: 'k-stall', base_url: `http://127.0.0.1:${await startStalledServer()}/v1` });
    const started = Date.now();
    await expect(chat(entry, [{ role: 'user', content: 'ping' }], undefined, 0, undefined, 500)).rejects.toThrow();
    const elapsed = Date.now() - started;
    // the whole point of E10: bounded wait, not the 49-min hang seen on fdj1b4s0 —
    // and it must have actually waited for the abort, not resolved instantly
    expect(elapsed).toBeGreaterThanOrEqual(400);
    expect(elapsed).toBeLessThan(4500);
  });

  it('still completes a normal stream (control)', async () => {
    const entry = makeEntry({ name: 'good-model', api_key: 'k-good', base_url: `http://127.0.0.1:${await startGoodServer()}/v1` });
    const resp = await chat(entry, [{ role: 'user', content: 'ping' }], undefined, 0, undefined, 5000);
    expect(resp.content).toContain('hello');
    expect(resp.finishReason).toBe('stop');
  });
});
