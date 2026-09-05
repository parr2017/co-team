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
import type { AgentResult, TaskNode } from '../src/types';
import { MAX_FIX_ROUNDS } from '../src/testloop';

let tmp: string;
let orchestrator: Orchestrator;

beforeEach(async () => {
  process.env.COTEAM_FORCE_MEMORY = '1';
  closeBus();
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-fix-'));
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

function makeNode(id: string, agent: string): TaskNode {
  return {
    id, task_id: 't', name: id, status: 'pending', agent, result: null, error: '',
    retry_count: 0, complexity: 'normal', requires_approval: false, needs_human: false,
    created_at: '', updated_at: '',
  };
}

function failingTestResult(): AgentResult {
  return {
    status: 'success',
    changes: ['src/calc.ts: ok'],
    summary: 'done but tests fail',
    errors: [],
    command_results: [
      { command: 'node build.js', returncode: 0, stderr: '', stdout: 'ok' },
      { command: 'npm test', returncode: 1, stderr: 'FAIL', stdout: '✕ adds numbers\nAssertionError: expected 3 to be 4\nTests: 1 failed, 2 passed, 3 total' },
    ],
  };
}

describe('test-fix loop (improvement 8, orchestrator integration)', () => {
  it('blocks the commit on failing tests and repairs with a targeted prompt', async () => {
    const calls: { lastError: string; escalate: boolean }[] = [];
    (orchestrator as any).dispatch = async (_t: string, _n: TaskNode, _p: unknown, _w: string, escalate: boolean, lastError: string) => {
      calls.push({ lastError, escalate });
      return calls.length === 1 ? failingTestResult() : { status: 'success', changes: ['src/calc.ts: fixed'], summary: 'fixed', errors: [], command_results: [] };
    };
    await saveTaskGraph('t-fix', [makeNode('n1', 'dev')], [], { description: 'x', workspace: tmp });
    const result = await (orchestrator as any).runGraph('t-fix', (await getTaskGraph('t-fix'))!, tmp);

    expect(result.status).toBe('success');
    expect(calls).toHaveLength(2);
    // the repair attempt received the parsed failure context
    expect(calls[1].lastError).toContain('测试修复循环');
    expect(calls[1].lastError).toContain('adds numbers');
    expect(calls[1].lastError).toContain('expected 3 to be 4');

    const journals = JSON.stringify(await getTaskJournals('t-fix'));
    expect(journals).toContain('测试修复循环');
  });

  it('escalates to the main agent after reaching the fix-round cap', async () => {
    const calls: { escalate: boolean }[] = [];
    (orchestrator as any).dispatch = async (_t: string, _n: TaskNode, _p: unknown, _w: string, escalate: boolean) => {
      calls.push({ escalate });
      return escalate ? { status: 'failed', error: '' } : failingTestResult();
    };
    await saveTaskGraph('t-fixmax', [makeNode('n1', 'dev')], [], { description: 'x', workspace: tmp });
    const result = await (orchestrator as any).runGraph('t-fixmax', (await getTaskGraph('t-fixmax'))!, tmp);

    // maxRetries=2 regular attempts all fail on tests → fix rounds extend the budget:
    // attempts 0-2 trigger fix rounds 1-3, attempt 3 hits the cap → escalation
    expect(calls.filter((c) => !c.escalate)).toHaveLength(4);
    expect(calls[calls.length - 1].escalate).toBe(true);
    expect(result.status).toBe('failed');

    const graph = await getTaskGraph('t-fixmax');
    expect(graph!.nodes[0].needs_human).toBe(true);
    expect(JSON.stringify(await getTaskJournals('t-fixmax'))).toContain(`测试修复循环达上限`);
    expect(MAX_FIX_ROUNDS).toBeGreaterThanOrEqual(1);
    // R9: the terminal state carries a structured report with the failure detail
    const report = graph!.nodes[0].result?.report;
    expect(report).toBeTruthy();
    expect(report!.attempts).toBe(MAX_FIX_ROUNDS);
    expect(report!.failures.length).toBeGreaterThan(0);
    expect(report!.failures[0].name).toContain('adds numbers');
    expect(report!.summary).toContain('修复 3 轮后仍有');
  });
});
