import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as http from 'node:http';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { AddressInfo } from 'node:net';
import { chat } from '../src/llm';
import { makeEntry } from '../src/scheduler';

/**
 * 流内可控性（2026-09-16，o3xmkraj 实证）：此前单轮流可挂 30-50 分钟（wallclock_cap=0
 * 无兜底、取消只在轮边界生效）。本文件验证：① 节点剩余预算作为 per-call 墙钟传入
 * chat 后，流内到线即中止；② 任务取消经 abortTask 打断 in-flight 流。
 */
const servers: http.Server[] = [];
function track(server: http.Server): http.Server {
  servers.push(server);
  return server;
}
afterEach(() => {
  for (const s of servers.splice(0)) s.close();
});

describe('LLM 流内墙钟与外部取消', () => {
  it('wallclockCapMs 到线即中止慢流（墙钟保险丝 per-call 生效）', async () => {
    const server = track(http.createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const chunk = 'data: {"choices":[{"delta":{"content":"B"}}]}\n\n';
      const timer = setInterval(() => res.write(chunk), 30);
      res.on('close', () => clearInterval(timer));
    }));
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as AddressInfo).port;
    const entry = makeEntry({ name: 'slow-model', base_url: `http://127.0.0.1:${port}`, api_key: 'k', max_tokens: 1000 } as any);

    const controller = new AbortController();
    const t0 = Date.now();
    await expect(chat(entry, [{ role: 'user', content: 'hi' }], 1000, 0, controller.signal, 400)).rejects.toThrow(/wallclock_cap/);
    expect(Date.now() - t0).toBeLessThan(5_000);
  }, 15_000);

  it('externalSignal abort 即打断流并抛外部取消（dispatch 级取消的底层挂点）', async () => {
    const server = track(http.createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const chunk = 'data: {"choices":[{"delta":{"content":"C"}}]}\n\n';
      const timer = setInterval(() => res.write(chunk), 30);
      res.on('close', () => clearInterval(timer));
    }));
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as AddressInfo).port;
    const entry = makeEntry({ name: 'slow-model', base_url: `http://127.0.0.1:${port}`, api_key: 'k', max_tokens: 1000 } as any);

    const controller = new AbortController();
    setTimeout(() => controller.abort(), 250);
    const t0 = Date.now();
    await expect(chat(entry, [{ role: 'user', content: 'hi' }], 1000, 0, controller.signal)).rejects.toThrow(/外部取消/);
    expect(Date.now() - t0).toBeLessThan(5_000);
  }, 15_000);
});

// ---------- orchestrator 级：abortTask 打断 in-flight dispatch ----------

const hangUntilAborted: Record<string, boolean> = {};
vi.mock('../src/llm', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/llm')>();
  return {
    ...actual,
    chat: async (entry: any, messages: any, max?: number, temp?: number, signal?: AbortSignal, capMs?: number) => {
      // 真实 HTTP 入口（本文件上方两个 llm 层用例）走真实现——vi.mock 是文件级提升，
      // 必须按入口分发，否则墙钟/外部取消用例会被卡死桩吞掉
      if (String(entry?.base_url || '').includes('127.0.0.1')) {
        return actual.chat(entry, messages, max, temp, signal, capMs);
      }
      // 模拟卡死的流：挂到外部 signal 触发为止
      await new Promise<void>((_, reject) => {
        if (signal?.aborted) return reject(new Error('LLM 调用被外部取消（任务取消）'));
        signal?.addEventListener('abort', () => reject(new Error('LLM 调用被外部取消（任务取消）')), { once: true });
      });
      throw new Error('unreachable');
    },
  };
});

import { initBus, closeBus } from '../src/bus';
import { Orchestrator } from '../src/orchestrator/orchestrator';
import { ModelPool } from '../src/scheduler';
import { saveTaskGraph, getTaskGraph } from '../src/store';
import type { TaskNode } from '../src/types';

describe('abortTask 打断 in-flight dispatch（取消不再等轮边界）', () => {
  it('dispatch 挂起中 abortTask → execute 立即收场为 failed', async () => {
    process.env.COTEAM_FORCE_MEMORY = '1';
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-abort-'));
    const devDir = path.join(tmp, 'dev');
    fs.mkdirSync(devDir, { recursive: true });
    fs.writeFileSync(path.join(devDir, 'agent.yaml'), 'name: dev\ntags: [code]\nrole: 开发\n');
    await initBus({ host: '127.0.0.1', port: 6399, db: 0 });
    try {
      const pool = new ModelPool([{ name: 'fake-model', api_key: 'k', base_url: 'http://localhost:9', tags: ['code'] }]);
      const orch = new Orchestrator({
        agentsDir: tmp, modelPool: pool, policy: { whitelistCommands: null, maxTimeSec: 10 },
        maxRetries: 1, sandboxEnabled: false, gitEnabled: false, branchWorkflow: false,
      });
      await orch.loadAgents();
      const node: TaskNode = { id: 'd1', task_id: 't-ab', name: '卡死节点', status: 'pending', agent: 'dev', result: null, error: '', retry_count: 0, complexity: 'normal', requires_approval: false, needs_human: false, created_at: '', updated_at: '' };
      await saveTaskGraph('t-ab', [node], [], { description: 'x', workspace: tmp, status: 'planned' });

      const execPromise = (orch as any).execute('t-ab', tmp);
      await new Promise((r) => setTimeout(r, 600)); // dispatch 已挂进卡死的流
      orch.abortTask('t-ab'); // 被测行为：打断 in-flight 流
      const result = await Promise.race([
        execPromise,
        new Promise((_, rej) => setTimeout(() => rej(new Error('execute 未被 abort 打断——流内取消失效')), 8_000)),
      ]);
      expect(String(result.status)).toBe('failed');
      const graph = await getTaskGraph('t-ab');
      expect(['failed', 'cancelled']).toContain(graph!.nodes.find((n) => n.id === 'd1')!.status);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
      closeBus();
    }
  }, 15_000);
});
