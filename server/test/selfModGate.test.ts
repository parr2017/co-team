import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// stub the LLM layer: clarify assessment returns "clear", planner never runs
// because dispatch is stubbed per-test
vi.mock('../src/llm', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/llm')>();
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

import { initBus, closeBus, busSet } from '../src/bus';
import { Orchestrator } from '../src/orchestrator/orchestrator';
import { saveTaskGraph, getTaskGraph, getTaskJournals } from '../src/store';
import { validateAgentResult } from '../src/harness';
import { summarizeQuality, sampleTaskRun, getTrend } from '../src/metrics';
import { createApi } from '../src/api';
import { PROJECT_ROOT } from '../src/config';
import type { TaskGraph, TaskNode, AgentResult } from '../src/types';

let tmp: string;
let orchestrator: Orchestrator;

beforeEach(async () => {
  process.env.COTEAM_FORCE_MEMORY = '1';
  closeBus();
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-gate-'));
  const devDir = path.join(tmp, 'dev');
  fs.mkdirSync(devDir, { recursive: true });
  fs.writeFileSync(path.join(devDir, 'agent.yaml'), 'name: dev\ntags: [code]\n');
  await initBus({ host: '127.0.0.1', port: 6399, db: 0 });
  orchestrator = new Orchestrator({
    agentsDir: tmp,
    modelPool: null,
    policy: { whitelistCommands: null, maxTimeSec: 10 },
    maxRetries: 1,
    sandboxEnabled: false,
    gitEnabled: false,
    maxFixRounds: 1,
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

const gateFailedParsed = {
  framework: 'js' as const,
  passed: false,
  failures: [{ name: 'harness L2 discipline', message: 'expected true to be false' }],
  summary: 'Tests: 1 failed, 9 passed',
};

describe('P0-1 self-modification gate (orchestrator integration)', () => {
  it('holds a node that touches meta facilities for human approval', async () => {
    (orchestrator as any).runGateTest = vi.fn(async () => null); // self-test passes
    (orchestrator as any).dispatch = async () => ({
      status: 'success', changes: ['server/src/harness.ts: 收紧输出契约'], summary: 'ok', errors: [], files: [],
    });
    await saveTaskGraph('t-gate', [makeNode('n1', 'dev')], [], { description: '修改 harness', workspace: PROJECT_ROOT });
    const graph = (await getTaskGraph('t-gate')) as TaskGraph;
    const result = await (orchestrator as any).runGraph('t-gate', graph, tmp);

    expect(result.status).toBe('waiting_approval');
    const g2 = (await getTaskGraph('t-gate'))!;
    expect(g2.nodes[0].status).toBe('waiting_approval');
    expect(g2.nodes[0].requires_approval).toBe(true);
    const journals = JSON.stringify(await getTaskJournals('t-gate'));
    expect(journals).toContain('自修改门禁');
    expect(journals).toContain('server/src/harness.ts');
  });

  it('resumes and completes after the node is approved', async () => {
    (orchestrator as any).runGateTest = vi.fn(async () => null);
    (orchestrator as any).dispatch = async () => ({
      status: 'success', changes: ['skills/new-skill/SKILL.md: 新增技能'], summary: 'ok', errors: [], files: [],
    });
    await saveTaskGraph('t-gate2', [makeNode('n1', 'dev')], [], { description: '沉淀技能', workspace: PROJECT_ROOT });
    await busSet('task:approvals:t-gate2', ['n1']);
    const graph = (await getTaskGraph('t-gate2')) as TaskGraph;
    const result = await (orchestrator as any).runGraph('t-gate2', graph, tmp);
    expect(result.status).toBe('success');
    const g2 = (await getTaskGraph('t-gate2'))!;
    expect(g2.nodes[0].status).toBe('completed');
  });

  it('fails the node when the self-test cannot be repaired within the round cap', async () => {
    (orchestrator as any).runGateTest = vi.fn(async () => ({ passed: false, returncode: 1, parsed: gateFailedParsed }));
    const dispatchResults: AgentResult[] = [
      { status: 'success', changes: ['server/src/orchestrator/orchestrator.ts: 改调度'], summary: 'ok', errors: [] },
      { status: 'success', changes: ['server/src/orchestrator/orchestrator.ts: 再修一轮'], summary: 'ok', errors: [] },
      { status: 'failed', error: '接管也修不好' },
    ];
    let calls = 0;
    (orchestrator as any).dispatch = async (_t: unknown, _n: unknown, _p: unknown, _w: unknown, escalate: boolean) => {
      return escalate ? dispatchResults[2] : dispatchResults[calls++];
    };
    await saveTaskGraph('t-gate3', [makeNode('n1', 'dev')], [], { description: '改 orchestrator', workspace: PROJECT_ROOT });
    const graph = (await getTaskGraph('t-gate3')) as TaskGraph;
    const result = await (orchestrator as any).runGraph('t-gate3', graph, tmp);

    expect(result.status).toBe('failed');
    const g2 = (await getTaskGraph('t-gate3'))!;
    expect(g2.nodes[0].status).toBe('failed');
    expect(g2.nodes[0].result?.gate_test?.passed).toBe(false);
    expect(g2.nodes[0].result?.report?.summary).toContain('自修改门禁');
    expect(g2.nodes[0].needs_human).toBe(true);
  });

  it('does not run the gate for normal (non self-referential) workspaces', async () => {
    const gateSpy = vi.fn(async () => null);
    (orchestrator as any).runGateTest = gateSpy;
    (orchestrator as any).dispatch = async () => ({
      status: 'success', changes: ['server/src/harness.ts: 随口提到'], summary: 'ok', errors: [], files: [],
    });
    await saveTaskGraph('t-norm', [makeNode('n1', 'dev')], [], { description: '普通任务', workspace: tmp });
    const graph = (await getTaskGraph('t-norm')) as TaskGraph;
    const result = await (orchestrator as any).runGraph('t-norm', graph, tmp);
    expect(result.status).toBe('success');
    expect(gateSpy).not.toHaveBeenCalled();
  });
});

describe('P0-2 defects: output contract & conversion', () => {
  it('accepts a well-formed defects array and rejects malformed entries', () => {
    const ok = validateAgentResult({
      status: 'success', summary: 's', verification: 'v',
      defects: [{ title: '并发窗口', detail: 'release 前未加锁', severity: 'high' }],
    });
    expect(ok.ok).toBe(true);

    const badTitle = validateAgentResult({ status: 'success', summary: 's', verification: 'v', defects: [{ title: '', detail: 'd' }] });
    expect(badTitle.ok).toBe(false);

    const badSeverity = validateAgentResult({ status: 'success', summary: 's', verification: 'v', defects: [{ title: 't', detail: 'd', severity: 'urgent' }] });
    expect(badSeverity.ok).toBe(false);
    expect(badSeverity.violations[0]).toContain('severity');
  });

  it('convert endpoint creates a fix task with a backlink and journals it', async () => {
    const node = makeNode('n1', 'dev', {
      status: 'completed',
      result: {
        status: 'success', summary: 's', errors: [],
        defects: [{ title: 'STATUS_REPORT 覆盖丢历史', detail: '重写时未 append', severity: 'medium' }],
      } as AgentResult,
    });
    await saveTaskGraph('t-def', [node], [], { description: '原始任务', workspace: tmp });

    const created = vi.fn(async () => {
      await saveTaskGraph('fix99', [], [], { description: '[缺陷修复] 桩任务', workspace: tmp });
      return { taskId: 'fix99', graph: { nodes: [], edges: [] }, level: 'standard' };
    });
    const enqueued = vi.fn(async () => ({}));
    const app = createApi({
      config: {} as any,
      orchestrator: { createTask: created } as any,
      modelPool: {} as any,
      taskQueue: { enqueue: enqueued } as any,
    });
    const res = await app.request('/api/tasks/t-def/defects/convert', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ node_id: 'n1', defect_index: 0, auto_run: true }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.fix_task_id).toBe('fix99');

    const desc = created.mock.calls[0][0] as string;
    expect(desc).toContain('[缺陷修复]');
    expect(desc).toContain('STATUS_REPORT 覆盖丢历史');

    const fixGraph = (await getTaskGraph('fix99'))!;
    expect(fixGraph.fix_for).toEqual({ task_id: 't-def', node_id: 'n1' });
    expect(enqueued).toHaveBeenCalled();

    const journals = JSON.stringify(await getTaskJournals('t-def'));
    expect(journals).toContain('fix99');
  });

  it('convert endpoint returns 400 when the defect does not exist', async () => {
    const node = makeNode('n1', 'dev', { status: 'completed', result: { status: 'success', summary: 's', errors: [] } as AgentResult });
    await saveTaskGraph('t-def404', [node], [], { description: 'x', workspace: tmp });
    const app = createApi({
      config: {} as any,
      orchestrator: { createTask: vi.fn() } as any,
      modelPool: {} as any,
      taskQueue: { enqueue: vi.fn() } as any,
    });
    const res = await app.request('/api/tasks/t-def404/defects/convert', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ node_id: 'n1', defect_index: 5 }),
    });
    expect(res.status).toBe(400);
  });
});

describe('A3 quality metrics', () => {
  it('summarizes fix rounds, defect closure and delivery consistency', () => {
    const g1 = {
      task_id: 'g1', nodes: [
        makeNode('n1', 'dev', { status: 'completed', result: { status: 'success', report: { attempts: 2, failures: [], summary: 'ok' }, defects: [{ title: 'd1', detail: 'x' }], delivery_check: { consistent: true, reported_count: 3, actual_count: 3, unreported: [], phantom: [] } } as AgentResult }),
        makeNode('n2', 'test', { status: 'completed', result: { status: 'success', report: { attempts: 0, failures: [], summary: 'ok' } } as AgentResult }),
      ],
      edges: [], description: '', workspace: 'w', status: 'success', created_at: '', updated_at: '',
    } as unknown as TaskGraph;
    // a fix task that closed one defect
    const g2 = {
      task_id: 'g2', nodes: [makeNode('n1', 'dev', { status: 'completed', result: { status: 'success' } as AgentResult })],
      edges: [], description: '', workspace: 'w', status: 'success', created_at: '', updated_at: '',
      fix_for: { task_id: 'g1', node_id: 'n1' },
    } as unknown as TaskGraph;
    const g3 = {
      task_id: 'g3', nodes: [makeNode('n1', 'dev', { status: 'failed', result: { status: 'failed', report: { attempts: 3, failures: [{ name: 'x', message: 'y' }], summary: 'cap' } } as AgentResult })],
      edges: [], description: '', workspace: 'w', status: 'failed', created_at: '', updated_at: '',
    } as unknown as TaskGraph;

    const q = summarizeQuality([g1, g2, g3]);
    expect(q.fix_loop_nodes).toBe(2); // attempts 2 and 3
    expect(q.fix_rounds_avg).toBe(2.5);
    expect(q.fix_rounds_max).toBe(3);
    expect(q.test_reported_nodes).toBe(3);
    expect(q.test_pass_rate).toBeCloseTo(2 / 3);
    expect(q.defects_total).toBe(1);
    expect(q.defects_converted).toBe(1);
    expect(q.defects_closed).toBe(1);
    expect(q.defect_close_rate).toBe(1);
    expect(q.delivery_checked_nodes).toBe(1);
    expect(q.delivery_consistent_rate).toBe(1);
  });

  it('samples task runs daily and aggregates a trend', async () => {
    const g = {
      task_id: 's1', nodes: [makeNode('n1', 'dev', { status: 'completed', result: { status: 'success', report: { attempts: 1, failures: [], summary: '' }, defects: [{ title: 'd', detail: 'x' }] } as AgentResult })],
      edges: [], description: '', workspace: 'w', status: 'success', created_at: '', updated_at: '', level: 'light',
    } as unknown as TaskGraph;
    await sampleTaskRun(g, 'success');
    const trend = await getTrend(7);
    const today = trend[trend.length - 1];
    expect(today.tasks).toBe(1);
    expect(today.fix_rounds_total).toBe(1);
    expect(today.defects_total).toBe(1);
  });
});
