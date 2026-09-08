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

describe('startup sweep of interrupted tasks (E7)', () => {
  it('marks zombie running tasks and their in-flight nodes as failed, leaves others untouched', async () => {
    await saveTaskGraph(
      't-zombie',
      [makeNode('n1', 'completed'), makeNode('n2', 'running'), makeNode('n3', 'retrying'), makeNode('n4', 'pending')],
      [],
      { description: 'x', workspace: tmp, status: 'running' }
    );
    await saveTaskGraph('t-ok', [makeNode('n1', 'completed')], [], { description: 'y', workspace: tmp, status: 'success' });
    await saveTaskGraph('t-approve', [makeNode('n1', 'waiting_approval')], [], { description: 'z', workspace: tmp, status: 'running' });

    const swept = await orchestrator.sweepInterruptedTasks();

    expect(swept.sort()).toEqual(['t-approve', 't-zombie']);

    const zombie = await getTaskGraph('t-zombie');
    expect(zombie!.status).toBe('failed');
    expect(zombie!.nodes.find((n) => n.id === 'n1')!.status).toBe('completed');
    expect(zombie!.nodes.find((n) => n.id === 'n2')!.status).toBe('failed');
    expect(zombie!.nodes.find((n) => n.id === 'n3')!.status).toBe('failed');
    expect(zombie!.nodes.find((n) => n.id === 'n4')!.status).toBe('pending');

    const approved = await getTaskGraph('t-approve');
    expect(approved!.status).toBe('failed');
    expect(approved!.nodes[0].status).toBe('failed');

    const healthy = await getTaskGraph('t-ok');
    expect(healthy!.status).toBe('success');

    const journals = JSON.stringify(await getTaskJournals('t-zombie'));
    expect(journals).toContain('服务重启');
  });

  it('sweeps nothing when all tasks are in terminal states', async () => {
    await saveTaskGraph('t-done', [makeNode('n1', 'completed')], [], { description: 'x', workspace: tmp, status: 'success' });
    await saveTaskGraph('t-fail', [makeNode('n1', 'failed')], [], { description: 'y', workspace: tmp, status: 'failed' });
    const swept = await orchestrator.sweepInterruptedTasks();
    expect(swept).toEqual([]);
  });
});
