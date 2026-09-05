import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// stub the LLM so the real callAgent runs; captured messages let tests assert
// what the agent actually received (interventions ride inside the userMsg)
const seenMessages: { role: string; content: string }[][] = [];
vi.mock('../src/llm', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/llm')>();
  return {
    ...actual,
    chat: async (_entry: any, messages: { role: string; content: string }[]) => {
      seenMessages.push(messages.map((m) => ({ ...m })));
      return {
        content: JSON.stringify({ status: 'success', summary: 'done', verification: '已逐项核对产出与任务要求', changes: ['x.txt: ok'], errors: [] }),
        promptTokens: 3,
        completionTokens: 4,
      };
    },
  };
});

import { initBus, closeBus, getBus } from '../src/bus';
import { ModelPool } from '../src/scheduler';
import { Orchestrator } from '../src/orchestrator/orchestrator';
import { createApi } from '../src/api';
import { TaskQueueManager } from '../src/taskQueue';
import type { AppConfig } from '../src/config';
import {
  saveTaskGraph,
  getTaskGraph,
  pushIntervention,
  consumeInterventions,
  getTaskJournals,
  deleteTask,
} from '../src/store';
import type { TaskGraph, TaskNode } from '../src/types';

let tmp: string;
let orchestrator: Orchestrator;
let capturedEvents: { type: string; payload: Record<string, unknown> }[] = [];

beforeEach(async () => {
  process.env.COTEAM_FORCE_MEMORY = '1';
  closeBus();
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-interv-'));
  const devDir = path.join(tmp, 'dev');
  fs.mkdirSync(devDir, { recursive: true });
  fs.writeFileSync(path.join(devDir, 'agent.yaml'), 'name: dev\ntags: [code]\nrole: 开发\n');
  await initBus({ host: '127.0.0.1', port: 6399, db: 0 });
  seenMessages.length = 0;
  capturedEvents = [];
  getBus().subscribe('coteam:dashboard', (msg: any) => capturedEvents.push(msg));
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

describe('intervention queue (store layer)', () => {
  it('push then consume returns messages and clears the queue', async () => {
    await pushIntervention('t-q', '请改用 Redis 缓存');
    await pushIntervention('t-q', '注意处理并发');
    const first = await consumeInterventions('t-q');
    expect(first.map((m) => m.message)).toEqual(['请改用 Redis 缓存', '注意处理并发']);
    expect(first[0].id).toBeTruthy();
    expect(first[0].ts).toBeTruthy();
    const second = await consumeInterventions('t-q');
    expect(second).toEqual([]);
  });

  it('consume on an empty queue is a no-op', async () => {
    expect(await consumeInterventions('t-none')).toEqual([]);
  });

  it('deleteTask clears the pending intervention queue', async () => {
    await pushIntervention('t-del', 'will be dropped');
    await deleteTask('t-del');
    expect(await consumeInterventions('t-del')).toEqual([]);
  });
});

describe('intervention injection (real callAgent via runGraph)', () => {
  it('injects pending interventions into the userMsg, consumes the queue and journals the trace', async () => {
    const nodes = [makeNode('n1', 'dev')];
    await saveTaskGraph('t-inj', nodes, [], { description: 'x', workspace: tmp, status: 'running' });
    await pushIntervention('t-inj', '请务必使用 TypeScript strict 模式');
    await pushIntervention('t-inj', '补充：必须覆盖边界情况');

    const graph = (await getTaskGraph('t-inj')) as TaskGraph;
    await (orchestrator as any).runGraph('t-inj', graph, tmp);

    // the agent received both interventions inside the userMsg
    const userContents = seenMessages.flat().filter((m) => m.role === 'user').map((m) => m.content);
    const allUser = userContents.join('\n');
    expect(allUser).toContain('用户介入指示');
    expect(allUser).toContain('请务必使用 TypeScript strict 模式');
    expect(allUser).toContain('补充：必须覆盖边界情况');

    // queue is emptied after consumption
    expect(await consumeInterventions('t-inj')).toEqual([]);

    // journal carries the injection trace
    const journals = await getTaskJournals('t-inj');
    const devJournal = journals['dev'] || [];
    const trace = devJournal.find((e) => e.kind === 'intervene');
    expect(trace).toBeTruthy();
    expect(trace!.text).toContain('n1');
    expect(trace!.meta?.interventions).toContain('请务必使用 TypeScript strict 模式');

    // the brief (master briefing) contains the intervention block too
    const brief = devJournal.find((e) => e.kind === 'brief');
    expect(brief!.text).toContain('用户介入指示');

    // node completed through the normal pipeline
    const after = (await getTaskGraph('t-inj')) as TaskGraph;
    expect(after.nodes[0].status).toBe('completed');
  });

  it('no pending interventions → userMsg has no intervention block', async () => {
    const nodes = [makeNode('n1', 'dev')];
    await saveTaskGraph('t-noinj', nodes, [], { description: 'x', workspace: tmp, status: 'running' });

    const graph = (await getTaskGraph('t-noinj')) as TaskGraph;
    await (orchestrator as any).runGraph('t-noinj', graph, tmp);

    const allUser = seenMessages.flat().filter((m) => m.role === 'user').map((m) => m.content).join('\n');
    expect(allUser).not.toContain('用户介入指示');

    const journals = await getTaskJournals('t-noinj');
    expect((journals['dev'] || []).some((e) => e.kind === 'intervene')).toBe(false);
  });

  it('interventions sent mid-run are delivered on the agent round, not lost (queue stays until consumed)', async () => {
    // push AFTER the task ran — nothing consumed it, the queue must still hold it
    await pushIntervention('t-late', '任务结束后的指示应保留在队列中');
    const q = await consumeInterventions('t-late');
    expect(q.map((m) => m.message)).toEqual(['任务结束后的指示应保留在队列中']);
  });
});

describe('intervention API (POST /api/tasks/:taskId/intervene)', () => {
  function makeApp() {
    const config: AppConfig = {
      agents_dir: tmp,
      dashboard: { host: '127.0.0.1', port: 0 },
      model_pool: [{ name: 'fake-model', api_key: 'k', base_url: 'http://localhost:9', tags: ['code'] }],
      orchestrator: { max_retries: 1, sandbox: false, git: false, branch_workflow: false } as any,
      permissions: {},
      redis: { host: '127.0.0.1', port: 6399, db: 0 },
      knowledge: { dir: path.join(tmp, 'kb') },
    };
    const pool = new ModelPool(config.model_pool);
    return createApi({ config, orchestrator, modelPool: pool, taskQueue: new TaskQueueManager(orchestrator, pool) });
  }

  it('queues the message, writes a journal intervene entry and broadcasts user_intervened', async () => {
    await saveTaskGraph('t-api', [makeNode('n1', 'dev')], [], { description: 'x', workspace: tmp, status: 'running' });
    const app = makeApp();
    const res = await app.request('/api/tasks/t-api/intervene', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: '请把日志改成 JSON 格式输出' }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('queued');
    expect(body.intervention_id).toBeTruthy();
    // queued for the next round
    const q = await consumeInterventions('t-api');
    expect(q.map((m) => m.message)).toEqual(['请把日志改成 JSON 格式输出']);
    // journal has the master-side intervene bubble
    const journals = await getTaskJournals('t-api');
    const entry = (journals['orchestrator'] || []).find((e) => e.kind === 'intervene');
    expect(entry).toBeTruthy();
    expect(entry!.text).toBe('请把日志改成 JSON 格式输出');
    // broadcast went out over the dashboard channel
    expect(capturedEvents.some((e) => e.type === 'user_intervened' && e.payload.task_id === 't-api')).toBe(true);
  });

  it('rejects intervention on a task that is not running', async () => {
    await saveTaskGraph('t-done', [makeNode('n1', 'dev')], [], { description: 'x', workspace: tmp, status: 'success' });
    const app = makeApp();
    const res = await app.request('/api/tasks/t-done/intervene', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'nope' }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.detail).toContain('not running');
    expect(await consumeInterventions('t-done')).toEqual([]);
  });

  it('rejects an empty message with 400', async () => {
    await saveTaskGraph('t-empty', [makeNode('n1', 'dev')], [], { description: 'x', workspace: tmp, status: 'running' });
    const app = makeApp();
    const res = await app.request('/api/tasks/t-empty/intervene', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: '   ' }),
    });
    expect(res.status).toBe(400);
  });

  it('404s for an unknown task', async () => {
    const app = makeApp();
    const res = await app.request('/api/tasks/no-such/intervene', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'hello' }),
    });
    expect(res.status).toBe(404);
  });
});
