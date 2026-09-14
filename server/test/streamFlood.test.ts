import { afterEach, describe, expect, it } from 'vitest';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { chat } from '../src/llm';
import { makeEntry } from '../src/scheduler';
import { streamFloodChars } from '../src/llm';

const servers: http.Server[] = [];
function track(server: http.Server): http.Server {
  servers.push(server);
  return server;
}

afterEach(() => {
  for (const s of servers.splice(0)) s.close();
});

describe('stream_flooded 流洪水分型（2026-09-15 双 OOM 复盘）', () => {
  it('阈值：max(1M, maxTokens×40) 字符', () => {
    expect(streamFloodChars(128000)).toBe(5_120_000);
    expect(streamFloodChars(32000)).toBe(1_280_000);
    expect(streamFloodChars(1000)).toBe(1_000_000);
  });

  it('上游无限灌垃圾 chunk：超阈值即抛 stream_flooded（不等到 idle 超时/堆爆炸）', async () => {
    // 流式服务器：持续发送 content delta，永不给 finish_reason
    const server = track(http.createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const chunk = 'data: {"choices":[{"delta":{"content":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"}}]}\n\n';
      const timer = setInterval(() => {
        res.write(chunk.repeat(64)); // 2KB×64 = 128KB per tick
      }, 5);
      res.on('close', () => clearInterval(timer));
    }));
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as AddressInfo).port;

    const entry = makeEntry({ name: 'flood-model', base_url: `http://127.0.0.1:${port}`, api_key: 'k', max_tokens: 1000 } as any);
    const t0 = Date.now();
    await expect(chat(entry, [{ role: 'user', content: 'hi' }])).rejects.toThrow(/stream_flooded/);
    const elapsed = Date.now() - t0;
    // 1M 字符阈值在 128KB/5ms 的灌速下应秒级触发（而非 900s idle 超时）
    expect(elapsed).toBeLessThan(15_000);
  }, 20_000);
});
