import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// capture every system prompt so tests can assert what the DOWNSTREAM agent
// actually received — the SSOT docsSection rides inside the system prompt
const seenSystems: string[] = [];
vi.mock('../src/llm', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/llm')>();
  return {
    ...actual,
    chat: async (_entry: any, messages: { role: string; content: string }[]) => {
      const sys = [...messages].reverse().find((m) => m.role === 'system')?.content || '';
      seenSystems.push(sys);
      return {
        content: JSON.stringify({ status: 'success', summary: 'done', verification: '已逐项核对产出与任务要求', changes: ['a.txt: ok'], errors: [] }),
        promptTokens: 3,
        completionTokens: 4,
      };
    },
  };
});

import { initBus, closeBus } from '../src/bus';
import { ModelPool } from '../src/scheduler';
import { Orchestrator } from '../src/orchestrator/orchestrator';
import { saveTaskGraph, getTaskGraph } from '../src/store';
import { writeDoc, getDocRegistry, checkDocs } from '../src/ssot';
import type { TaskGraph, TaskNode } from '../src/types';

let tmp: string;
let orchestrator: Orchestrator;

beforeEach(async () => {
  process.env.COTEAM_FORCE_MEMORY = '1';
  closeBus();
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-ssotint-'));
  const devDir = path.join(tmp, 'dev');
  fs.mkdirSync(devDir, { recursive: true });
  fs.writeFileSync(path.join(devDir, 'agent.yaml'), 'name: dev\ntags: [code]\nrole: 开发\n');
  await initBus({ host: '127.0.0.1', port: 6399, db: 0 });
  seenSystems.length = 0;
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

function makeNode(id: string, agent: string, extra: Partial<TaskNode> = {}): TaskNode {
  return {
    id, task_id: 't', name: id, status: 'pending', agent, result: null, error: '',
    retry_count: 0, complexity: 'normal', requires_approval: false, needs_human: false,
    created_at: '', updated_at: '',
    ...extra,
  };
}

describe('SSOT multi-agent integration (R7)', () => {
  it('downstream agent receives the LATEST STATUS_REPORT version after upstream completes', async () => {
    const nodes = [makeNode('n1', 'dev'), makeNode('n2', 'dev')];
    const edges: [string, string][] = [['n1', 'n2']];
    await saveTaskGraph('t-ssot-int', nodes, edges, { description: '两节点顺序任务', workspace: tmp, status: 'running' });

    // initial STATUS_REPORT written by the orchestrator (as in execute())
    await writeDoc('t-ssot-int', 'STATUS_REPORT', '初始状态：全部待启动', 'orchestrator');
    const v1 = (await getDocRegistry('t-ssot-int')).find((d) => d.type === 'STATUS_REPORT');
    expect(v1).toBeTruthy();

    const graph = (await getTaskGraph('t-ssot-int')) as TaskGraph;
    const result = await (orchestrator as any).runGraph('t-ssot-int', graph, tmp);
    expect(result.status).toBe('success');
    expect(graph.nodes.every((n) => n.status === 'completed')).toBe(true);

    // the registry version advanced when the first wave completed (runGraph rewrites STATUS_REPORT)
    const v2 = (await getDocRegistry('t-ssot-int')).find((d) => d.type === 'STATUS_REPORT');
    expect(v2!.version).toBeGreaterThan(v1!.version);

    // the downstream agent (second callAgent) saw the updated doc content in its prompt
    expect(seenSystems.length).toBeGreaterThanOrEqual(2);
    expect(seenSystems[1]).toContain('STATUS_REPORT');
  });

  it('checkDocs restores tampered sandbox docs before the downstream agent runs', async () => {
    const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-ssottamp-'));
    try {
      await writeDoc('t-tamper', 'TASK_SPEC', '权威任务规格内容', 'orchestrator', sandbox);
      const docFile = path.join(sandbox, 'docs', 'TASK_SPEC.md');
      expect(fs.existsSync(docFile)).toBe(true);

      // a rogue agent (or crash) corrupts the sandbox copy
      fs.writeFileSync(docFile, '被篡改的假规格', 'utf-8');

      const check = await checkDocs('t-tamper', sandbox);
      expect(check.ok).toBe(false);
      expect(check.restored).toContain('TASK_SPEC');
      // the authoritative content is back on disk — downstream agents read the truth
      expect(fs.readFileSync(docFile, 'utf-8')).toContain('权威任务规格内容');
    } finally {
      fs.rmSync(sandbox, { recursive: true, force: true });
    }
  });
});
