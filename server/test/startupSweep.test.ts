import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

vi.mock('../src/llm', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/llm')>();
  void actual;
  return {
    chat: async () => ({
      content: JSON.stringify({ clear: true, missing: [], questions: [] }),
      promptTokens: 2,
      completionTokens: 3,
    }),
    extractJson: actual.extractJson,
    stripCodeFence: actual.stripCodeFence,
  };
});

import { initBus, closeBus } from '../src/bus';
import { Orchestrator } from '../src/orchestrator/orchestrator';
import { saveTaskGraph, getTaskGraph, getTaskJournals } from '../src/store';
import type { TaskNode } from '../src/types';

let tmp: string;
let orchestrator: Orchestrator;

beforeEach(async () => {
  process.env.COTEAM_FORCE_MEMORY = '1';
  closeBus();
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-sweep-'));
  const devDir = path.join(tmp, 'dev');
  fs.mkdirSync(devDir, { recursive: true });
  fs.writeFileSync(path.join(devDir, 'agent.yaml'), 'name: dev\ntags: [code]\n');
  await initBus({ host: '127.0.0.1', port: 6399, db: 0 });
  orchestrator = new Orchestrator({
    agentsDir: tmp,
    modelPool: null,
    policy: { whitelistCommands: null, maxTimeSec: 10 },
    maxRetries: 2,
    sandboxEnabled: false,
    gitEnabled: false,
  });
  await orchestrator.loadAgents();
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
  closeBus();
});

function makeNode(id: string, status: TaskNode['status']): TaskNode {
  return {
    id, task_id: 't', name: id, status, agent: 'dev', result: null, error: '',
    retry_count: 0, complexity: 'normal', requires_approval: false, needs_human: false,
    created_at: '', updated_at: '',
  };
}

describe('startup sweep 重做（2026-09-15 永续开发语义）', () => {
  it('running 任务：在途节点标 interrupted、任务标 interrupted 并进入自动续跑清单', async () => {
    await saveTaskGraph(
      't-zombie',
      [makeNode('n1', 'completed'), makeNode('n2', 'running'), makeNode('n3', 'retrying'), makeNode('n4', 'pending')],
      [],
      { description: 'x', workspace: tmp, status: 'running' }
    );
    await saveTaskGraph('t-ok', [makeNode('n1', 'completed')], [], { description: 'y', workspace: tmp, status: 'success' });
    await saveTaskGraph('t-approve', [makeNode('n1', 'waiting_approval')], [], { description: 'z', workspace: tmp, status: 'running' });

    const swept = await orchestrator.sweepInterruptedTasks();

    expect(swept.resume.sort()).toEqual(['t-approve', 't-zombie']);
    expect(swept.queued).toEqual([]);
    expect(swept.planning).toEqual([]);

    const zombie = await getTaskGraph('t-zombie');
    expect(zombie!.status).toBe('interrupted');
    expect(zombie!.infra_retries).toBe(1);
    expect(zombie!.nodes.find((n) => n.id === 'n1')!.status).toBe('completed');
    expect(zombie!.nodes.find((n) => n.id === 'n2')!.status).toBe('interrupted');
    expect(zombie!.nodes.find((n) => n.id === 'n3')!.status).toBe('interrupted');
    expect(zombie!.nodes.find((n) => n.id === 'n4')!.status).toBe('pending');

    const approved = await getTaskGraph('t-approve');
    expect(approved!.status).toBe('interrupted');
    expect(approved!.nodes[0].status).toBe('interrupted');

    const healthy = await getTaskGraph('t-ok');
    expect(healthy!.status).toBe('success');

    const journals = JSON.stringify(await getTaskJournals('t-zombie'));
    expect(journals).toContain('服务重启');
    expect(journals).toContain('自动续跑');
  });

  it('terminal 状态任务不被清扫', async () => {
    await saveTaskGraph('t-done', [makeNode('n1', 'completed')], [], { description: 'x', workspace: tmp, status: 'success' });
    await saveTaskGraph('t-fail', [makeNode('n1', 'failed')], [], { description: 'y', workspace: tmp, status: 'failed' });
    const swept = await orchestrator.sweepInterruptedTasks();
    expect(swept).toEqual({ resume: [], queued: [], planning: [] });
  });

  it('queued 孤儿（重启丢车道）进入重新排队清单', async () => {
    await saveTaskGraph('t-orphan', [makeNode('n1', 'pending')], [], { description: 'q', workspace: tmp, status: 'queued' });
    const swept = await orchestrator.sweepInterruptedTasks();
    expect(swept.queued).toEqual(['t-orphan']);
    expect((await getTaskGraph('t-orphan'))!.status).toBe('queued'); // 状态不动，由 index.ts 重新 enqueue
  });

  it('planAsync 规划孤儿（pending 且无节点）进入重新规划清单', async () => {
    await saveTaskGraph('t-planless', [], [], { description: 'p', workspace: tmp, status: 'pending' });
    const swept = await orchestrator.sweepInterruptedTasks();
    expect(swept.planning).toEqual(['t-planless']);
  });

  it('finalizing 任务同样按中断处理（收尾阶段被重启打断）', async () => {
    await saveTaskGraph('t-fin', [makeNode('n1', 'completed'), makeNode('n2', 'running')], [], { description: 'f', workspace: tmp, status: 'finalizing' });
    const swept = await orchestrator.sweepInterruptedTasks();
    expect(swept.resume).toEqual(['t-fin']);
    expect((await getTaskGraph('t-fin'))!.status).toBe('interrupted');
  });

  it('反复中断达上限（infra_retries>3）：停靠人工 failed，不再自动续跑', async () => {
    await saveTaskGraph('t-looper', [makeNode('n1', 'running')], [], { description: 'l', workspace: tmp, status: 'running', });
    const g = await getTaskGraph('t-looper');
    g!.infra_retries = 3;
    await saveTaskGraph('t-looper', g!.nodes, g!.edges, { description: 'l', workspace: tmp, status: 'running' });
    // saveTaskGraph 的 meta 不含 infra_retries——直接改存量图
    const fresh = await getTaskGraph('t-looper');
    fresh!.infra_retries = 3;
    await persistForTest(fresh!);

    const swept = await orchestrator.sweepInterruptedTasks();
    expect(swept.resume).toEqual([]);
    const parked = await getTaskGraph('t-looper');
    expect(parked!.status).toBe('failed');
    expect(parked!.infra_retries).toBe(4);
    const journals = JSON.stringify(await getTaskJournals('t-looper'));
    expect(journals).toContain('停止自动续跑');
  });

  async function persistForTest(graph: NonNullable<Awaited<ReturnType<typeof getTaskGraph>>>) {
    const { persistGraph } = await import('../src/store');
    await persistGraph(graph);
  }
});
