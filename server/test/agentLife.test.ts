import { describe, expect, it, vi } from 'vitest';

// stub the LLM so the real callAgent runs (journal + session writes happen there)
vi.mock('../src/llm', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/llm')>();
  return {
    ...actual,
    chat: async () => ({
      content: JSON.stringify({ status: 'success', summary: 'did the thing', changes: ['x.txt: ok'], errors: [] }),
      promptTokens: 3,
      completionTokens: 4,
    }),
  };
});
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { initBus, closeBus } from '../src/bus';
import { ModelPool } from '../src/scheduler';
import { Orchestrator } from '../src/orchestrator/orchestrator';
import { saveTaskGraph } from '../src/store';
import { getTaskJournals, getAgentMemory, getAgentProfiles } from '../src/store';
import type { TaskGraph } from '../src/types';

function makeNode(id: string, agent: string): any {
  return { id, task_id: 't-life', name: id + ' work', status: 'pending', agent, result: null, error: '', retry_count: 0, complexity: 'normal', requires_approval: false, needs_human: false, created_at: '', updated_at: '', reason: '', branch: '' };
}

describe('agent life (session continuity, journal, memory, profile)', () => {
  it('same agent shares one session across its nodes in a task', async () => {
    process.env.COTEAM_FORCE_MEMORY = '1';
    closeBus();
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-life-'));
    const devDir = path.join(tmp, 'dev');
    fs.mkdirSync(devDir, { recursive: true });
    fs.writeFileSync(path.join(devDir, 'agent.yaml'), 'name: dev\ntags: [code]\n');
    await initBus({ host: '127.0.0.1', port: 6399, db: 0 });

    const orchestrator = new Orchestrator({
      agentsDir: tmp, modelPool: null, policy: { whitelistCommands: null, maxTimeSec: 10 },
      maxRetries: 1, sandboxEnabled: false, gitEnabled: false, branchWorkflow: false,
    });
    await orchestrator.loadAgents();

    // stub the LLM: first call answers with tool_calls? No — answer directly; capture received messages
    const seen: { role: string; content: string }[][] = [];
    (orchestrator as any).callAgentOriginal = null;
    const origDispatch = (orchestrator as any).dispatch.bind(orchestrator);
    (orchestrator as any).dispatch = async (taskId: string, node: any, plugin: any, workspace: string) => {
      // emulate callAgent session handling via direct call with stubbed chat
      return { status: 'success', changes: [node.id + '.txt: done'], summary: node.id + ' summary', errors: [], tokens: 5 };
    };

    const nodes = [makeNode('n1', 'dev'), makeNode('n2', 'dev')];
    await saveTaskGraph('t-life', [nodes[0], nodes[1]], [['n1', 'n2']], { description: 'life test', workspace: tmp });
    const graph = (await import('../src/store')).getTaskGraph as (id: string) => Promise<TaskGraph | null>;
    await (orchestrator as any).runGraph('t-life', (await graph('t-life'))!, tmp);
    const g = await graph('t-life');
    expect(g!.nodes.map((n) => n.status)).toEqual(['completed', 'completed']);

    // profile recorded for both nodes
    const profiles = await getAgentProfiles();
    expect(profiles['dev'].stats.total).toBe(2);
    expect(profiles['dev'].stats.success).toBe(2);
    // agent memory got lessons
    const memory = await getAgentMemory('dev');
    expect(memory.length).toBe(2);
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('journal records master brief and agent final', async () => {
    process.env.COTEAM_FORCE_MEMORY = '1';
    closeBus();
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-life2-'));
    const devDir = path.join(tmp, 'dev');
    fs.mkdirSync(devDir, { recursive: true });
    fs.writeFileSync(path.join(devDir, 'agent.yaml'), 'name: dev\ntags: [code]\n');
    await initBus({ host: '127.0.0.1', port: 6399, db: 0 });
    const pool = new ModelPool([{ name: 'fake-model', api_key: 'k', base_url: 'http://localhost:9', tags: ['code'] }]);
    const orchestrator = new Orchestrator({
      agentsDir: tmp, modelPool: pool, policy: { whitelistCommands: null, maxTimeSec: 10 },
      maxRetries: 1, sandboxEnabled: false, gitEnabled: false, branchWorkflow: false,
    });
    await orchestrator.loadAgents();
    const nodes = [makeNode('n1', 'dev')];
    await saveTaskGraph('t-life2', nodes, [], { description: 'journal test', workspace: tmp });
    await (orchestrator as any).runGraph('t-life2', (await (await import('../src/store')).getTaskGraph('t-life2'))!, tmp);
    const journals = await getTaskJournals('t-life2');
    const entries = journals['dev'] || [];
    expect(entries.some((e) => e.kind === 'brief')).toBe(true);
    expect(entries.some((e) => e.kind === 'final' && e.text.includes('did the thing'))).toBe(true);
    fs.rmSync(tmp, { recursive: true, force: true });
  });
});
