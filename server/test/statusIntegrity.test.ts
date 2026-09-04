import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { initBus, closeBus } from '../src/bus';
import { Orchestrator } from '../src/orchestrator/orchestrator';
import { saveTaskGraph, getTaskGraph } from '../src/store';
import { createSandbox, cleanupSandbox, mergeChanges } from '../src/sandbox';
import type { AgentResult, TaskNode } from '../src/types';

vi.mock('../src/sandbox', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../src/sandbox')>();
  return { ...mod, createSandbox: vi.fn(mod.createSandbox), cleanupSandbox: vi.fn(mod.cleanupSandbox), mergeChanges: vi.fn(() => []) };
});

let tmp: string;

beforeEach(async () => {
  process.env.COTEAM_FORCE_MEMORY = '1';
  closeBus();
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-status-'));
  const devDir = path.join(tmp, 'dev');
  fs.mkdirSync(devDir, { recursive: true });
  fs.writeFileSync(path.join(devDir, 'agent.yaml'), 'name: dev\ntags: [code]\nrole: 开发\n');
  await initBus({ host: '127.0.0.1', port: 6399, db: 0 });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
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

function makeOrchestrator(extra: Record<string, unknown> = {}): Orchestrator {
  return new Orchestrator({
    agentsDir: tmp,
    modelPool: null,
    policy: { whitelistCommands: null, maxTimeSec: 10 },
    maxRetries: 1,
    sandboxEnabled: false,
    gitEnabled: false,
    ...extra,
  });
}

/** workspace and sandbox must be different paths for the sandbox code paths to engage */
function makeWorkspaces(): { workspace: string; sandbox: string } {
  const workspace = path.join(tmp, 'ws');
  fs.mkdirSync(workspace, { recursive: true });
  return { workspace, sandbox: tmp };
}

describe('task status integrity', () => {
  it('still persists success when sandbox cleanup throws (EBUSY guard)', async () => {
    const { workspace, sandbox } = makeWorkspaces();
    vi.mocked(createSandbox).mockReturnValue(sandbox);
    vi.mocked(cleanupSandbox).mockImplementation(() => {
      throw new Error('EBUSY: resource busy or locked');
    });
    const orch = makeOrchestrator({ sandboxEnabled: true });
    await orch.loadAgents();
    await saveTaskGraph('t-clean', [makeNode('a', 'orchestrator')], [], { description: 'x', workspace });
    const result = await orch.execute('t-clean', workspace);
    expect(result.status).toBe('success');
    const graph = await getTaskGraph('t-clean');
    expect(graph?.status).toBe('success');
  });

  it('downgrades to failed when the final merge into the workspace throws', async () => {
    const { workspace, sandbox } = makeWorkspaces();
    vi.mocked(createSandbox).mockReturnValue(sandbox);
    vi.mocked(mergeChanges).mockImplementation(() => {
      throw new Error('EACCES: cannot write');
    });
    const orch = makeOrchestrator({ sandboxEnabled: true });
    await orch.loadAgents();
    await saveTaskGraph('t-merge', [makeNode('a', 'orchestrator')], [], { description: 'x', workspace });
    const result = await orch.execute('t-merge', workspace);
    expect(result.status).toBe('failed');
    const graph = await getTaskGraph('t-merge');
    expect(graph?.status).toBe('failed');
  });

  it('persists failed status when sandbox creation fails', async () => {
    const { workspace } = makeWorkspaces();
    vi.mocked(createSandbox).mockImplementation(() => {
      throw new Error('no space left on device');
    });
    const orch = makeOrchestrator({ sandboxEnabled: true });
    await orch.loadAgents();
    await saveTaskGraph('t-sandbox', [makeNode('a', 'orchestrator')], [], { description: 'x', workspace });
    const result = await orch.execute('t-sandbox', workspace);
    expect(result.status).toBe('failed');
    const graph = await getTaskGraph('t-sandbox');
    expect(graph?.status).toBe('failed');
  });

  it('clears a stale cancel flag so a cancelled task can run again', async () => {
    const { busSet } = await import('../src/bus');
    await busSet('task:cancel:t-cancel', true);
    const orch = makeOrchestrator();
    await orch.loadAgents();
    await saveTaskGraph('t-cancel', [makeNode('a', 'orchestrator')], [], { description: 'x', workspace: tmp });
    const result = await orch.execute('t-cancel', tmp);
    expect(result.status).toBe('success');
    const graph = await getTaskGraph('t-cancel');
    expect(graph?.status).toBe('success');
  });

  it('lands a node on failed (not running) when the token budget explodes mid-dispatch', async () => {
    const orch = makeOrchestrator({ tokenBudget: -1 });
    await orch.loadAgents();
    await saveTaskGraph('t-budget', [makeNode('a', 'dev')], [], { description: 'x', workspace: tmp });
    const result = await orch.execute('t-budget', tmp);
    expect(result.status).toBe('failed');
    const graph = await getTaskGraph('t-budget');
    expect(graph?.nodes[0].status).toBe('failed');
    expect(graph?.status).toBe('failed');
  });

  it('never reports success while a node is still waiting for approval', async () => {
    const orch = makeOrchestrator();
    await orch.loadAgents();
    await saveTaskGraph(
      't-approval',
      [makeNode('blocked', 'dev', { requires_approval: true }), makeNode('free', 'orchestrator')],
      [['blocked', 'free']],
      { description: 'x', workspace: tmp }
    );
    const graph = (await getTaskGraph('t-approval'))!;
    const result = await (orch as any).runGraph('t-approval', graph, tmp);
    expect(result.status).toBe('waiting_approval');
  });
});
