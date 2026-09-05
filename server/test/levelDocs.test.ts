import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

vi.mock('../src/llm', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/llm')>();
  return {
    ...actual,
    chat: async () => ({
      content: JSON.stringify({ status: 'success', summary: 'done', changes: ['x.txt: ok'], errors: [] }),
      promptTokens: 3,
      completionTokens: 4,
    }),
  };
});

import { initBus, closeBus } from '../src/bus';
import { ModelPool } from '../src/scheduler';
import { Orchestrator } from '../src/orchestrator/orchestrator';
import { saveTaskGraph, getTaskGraph } from '../src/store';
import { getDocRegistry } from '../src/ssot';
import type { TaskGraph, TaskNode } from '../src/types';

let tmp: string;
let orchestrator: Orchestrator;

beforeEach(async () => {
  process.env.COTEAM_FORCE_MEMORY = '1';
  closeBus();
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-level-'));
  const devDir = path.join(tmp, 'dev');
  fs.mkdirSync(devDir, { recursive: true });
  fs.writeFileSync(path.join(devDir, 'agent.yaml'), 'name: dev\ntags: [code]\nrole: 开发\n');
  await initBus({ host: '127.0.0.1', port: 6399, db: 0 });
  const pool = new ModelPool([{ name: 'fake-model', api_key: 'k', base_url: 'http://localhost:9', tags: ['code'] }]);
  orchestrator = new Orchestrator({
    agentsDir: tmp, modelPool: pool, policy: { whitelistCommands: null, maxTimeSec: 10 },
    maxRetries: 1, sandboxEnabled: false, gitEnabled: false, branchWorkflow: false,
  });
  await orchestrator.loadAgents();
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
  closeBus();
});

function makeNode(id: string, agent: string): TaskNode {
  return {
    id, task_id: 't', name: id, status: 'pending', agent, result: null, error: '',
    retry_count: 0, complexity: 'normal', requires_approval: false, needs_human: false,
    created_at: '', updated_at: '',
  };
}

async function runTask(taskId: string, level: string | null): Promise<TaskGraph> {
  const nodes = [makeNode('n1', 'dev')];
  await saveTaskGraph(taskId, nodes, [], {
    description: 'x', workspace: tmp, status: 'running',
    ...(level ? { level: level as any } : {}),
  });
  const graph = (await getTaskGraph(taskId)) as TaskGraph;
  await (orchestrator as any).runGraph(taskId, graph, tmp);
  return (await getTaskGraph(taskId)) as TaskGraph;
}

describe('improvement 7: level profile actually gates the pipeline', () => {
  it('light-level task produces NO SSOT docs (docs:false is consumed, not just declared)', async () => {
    await runTask('t-light', 'light');
    const docs = await getDocRegistry('t-light');
    expect(docs).toHaveLength(0);
  });

  it('standard-level task still gets the SSOT doc pipeline', async () => {
    await runTask('t-std', 'standard');
    const docs = await getDocRegistry('t-std');
    expect(docs.length).toBeGreaterThan(0);
    expect(docs.some((d) => d.type === 'STATUS_REPORT')).toBe(true);
  });

  it('missing level defaults to standard (docs on)', async () => {
    await runTask('t-def', null);
    const docs = await getDocRegistry('t-def');
    expect(docs.some((d) => d.type === 'STATUS_REPORT')).toBe(true);
  });
});
