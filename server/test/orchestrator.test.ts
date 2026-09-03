import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { initBus, getBus, closeBus } from '../src/bus';
import { Orchestrator } from '../src/orchestrator/orchestrator';
import { saveTaskGraph, getTaskGraph } from '../src/store';
import type { AgentResult, TaskNode } from '../src/types';

let tmp: string;
let orchestrator: Orchestrator;

beforeEach(async () => {
  process.env.COTEAM_FORCE_MEMORY = '1';
  closeBus();
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-orch-'));
  const devDir = path.join(tmp, 'dev');
  fs.mkdirSync(devDir, { recursive: true });
  fs.writeFileSync(path.join(devDir, 'agent.yaml'), 'name: dev\ntags: [code]\nrole: 开发\n');
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

function makeNode(id: string, agent: string, extra: Partial<TaskNode> = {}): TaskNode {
  return {
    id, task_id: 't', name: id, status: 'pending', agent, result: null, error: '',
    retry_count: 0, complexity: 'normal', requires_approval: false, needs_human: false,
    created_at: '', updated_at: '',
    ...extra,
  };
}

function success(changes: string[] = []): AgentResult {
  return { status: 'success', changes, summary: 'done', errors: [] };
}

describe('Orchestrator', () => {
  it('executes parallel DAG via waves (fallback graph uses specialized agents)', async () => {
    const nodes = [makeNode('root', 'orchestrator'), makeNode('left', 'orchestrator'), makeNode('right', 'orchestrator'), makeNode('join', 'orchestrator')];
    const edges: [string, string][] = [['root', 'left'], ['root', 'right'], ['left', 'join'], ['right', 'join']];
    await saveTaskGraph('t-par', nodes, edges, { description: 'par', workspace: tmp });
    const result = await (orchestrator as any).runGraph('t-par', (await getTaskGraph('t-par'))!, tmp);
    expect(result.status).toBe('success');
    expect(result.completed).toBe(4);
  });

  it('retries then escalates then needs human', async () => {
    let calls = 0;
    (orchestrator as any).dispatch = async () => {
      calls += 1;
      return { status: 'failed', error: 'simulated failure' } as AgentResult;
    };
    const nodes = [makeNode('n1', 'dev')];
    await saveTaskGraph('t-retry', nodes, [], { description: 'x', workspace: tmp });
    const result = await (orchestrator as any).runGraph('t-retry', (await getTaskGraph('t-retry'))!, tmp);
    expect(calls).toBe(3); // maxRetries=2 + 1 escalation
    expect(result.status).toBe('failed');
    const graph = await getTaskGraph('t-retry');
    expect(graph!.nodes[0].needs_human).toBe(true);
  });

  it('succeeds on second attempt', async () => {
    let calls = 0;
    (orchestrator as any).dispatch = async (): Promise<AgentResult> => {
      calls += 1;
      return calls < 2 ? { status: 'failed', error: 'flaky' } : success(['a.txt: ok']);
    };
    const nodes = [makeNode('n1', 'dev')];
    await saveTaskGraph('t-flaky', nodes, [], { description: 'x', workspace: tmp });
    const result = await (orchestrator as any).runGraph('t-flaky', (await getTaskGraph('t-flaky'))!, tmp);
    expect(result.status).toBe('success');
    expect(calls).toBe(2);
    expect(result.changes).toEqual(['a.txt: ok']);
  });

  it('blocks on approval, resumes after approve', async () => {
    const nodes = [makeNode('n1', 'orchestrator', { requires_approval: true })];
    await saveTaskGraph('t-appr', nodes, [], { description: 'x', workspace: tmp });
    const result = await (orchestrator as any).runGraph('t-appr', (await getTaskGraph('t-appr'))!, tmp);
    expect(result.status).toBe('waiting_approval');
    expect((await getTaskGraph('t-appr'))!.nodes[0].status).toBe('waiting_approval');

    await getBus().set('task:approvals:t-appr', ['n1']);
    const graph = await getTaskGraph('t-appr');
    graph!.nodes[0].status = 'pending';
    const resumed = await (orchestrator as any).runGraph('t-appr', graph!, tmp);
    expect(resumed.status).toBe('success');
  });

  it('cancels pending nodes', async () => {
    const nodes = [makeNode('a', 'orchestrator'), makeNode('b', 'orchestrator')];
    const edges: [string, string][] = [['a', 'b']];
    await saveTaskGraph('t-cancel', nodes, edges, { description: 'x', workspace: tmp });
    await getBus().set('task:cancel:t-cancel', true);
    const result = await (orchestrator as any).runGraph('t-cancel', (await getTaskGraph('t-cancel'))!, tmp);
    expect(result.status).toBe('cancelled');
    const graph = await getTaskGraph('t-cancel');
    expect(graph!.nodes.map((n) => n.status)).toEqual(['cancelled', 'cancelled']);
  });

  it('shares upstream context with downstream nodes', async () => {
    let capturedContext = '';
    const origCallAgent = (orchestrator as any).callAgent.bind(orchestrator);
    (orchestrator as any).dispatch = async (taskId: string, node: TaskNode) => {
      capturedContext = await (orchestrator as any).upstreamContext(taskId, node);
      return success([]);
    };
    void origCallAgent;
    const nodes = [makeNode('n1', 'dev'), makeNode('n2', 'dev')];
    const edges: [string, string][] = [['n1', 'n2']];
    await saveTaskGraph('t-ctx', nodes, edges, { description: 'x', workspace: tmp });
    // first node completes with a summary; run node1 via one wave then n2
    (orchestrator as any).dispatch = async (taskId: string, node: TaskNode) => {
      if (node.id === 'n1') return success([]);
      capturedContext = await (orchestrator as any).upstreamContext(taskId, node);
      return success([]);
    };
    const result = await (orchestrator as any).runGraph('t-ctx', (await getTaskGraph('t-ctx'))!, tmp);
    expect(result.status).toBe('success');
    expect(capturedContext).toContain('n1');
  });

  it('persists node results during execution', async () => {
    const nodes = [makeNode('n1', 'orchestrator')];
    await saveTaskGraph('t-persist', nodes, [], { description: 'x', workspace: tmp });
    await (orchestrator as any).runGraph('t-persist', (await getTaskGraph('t-persist'))!, tmp);
    const graph = await getTaskGraph('t-persist');
    expect(graph!.nodes[0].status).toBe('completed');
    expect(graph!.nodes[0].result!.status).toBe('success');
  });
});
