import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// mock the LLM layer: clarify assessment, planner and agent calls are distinguished by prompt
vi.mock('../src/llm', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/llm')>();
  const calls: { entry: any; messages: { role: string; content: string }[] }[] = [];
  return {
    ...actual,
    __calls: calls,
    chat: async (entry: any, messages: { role: string; content: string }[]) => {
      calls.push({ entry, messages });
      const sys = messages.find((m) => m.role === 'system')?.content || '';
      const user = messages.find((m) => m.role === 'user')?.content || '';
      if (sys.includes('需求澄清评估器')) {
        const vague = user.includes('做点什么吧');
        if (vague) {
          return { content: JSON.stringify({ clear: false, missing: ['目标'], questions: ['具体要做什么？'], summary: '模糊需求' }), promptTokens: 2, completionTokens: 3 };
        }
        return { content: JSON.stringify({ clear: true, missing: [], questions: [], summary: '清楚了' }), promptTokens: 2, completionTokens: 3 };
      }
      if (sys.includes('task planner')) {
        return {
          content: JSON.stringify({ nodes: [{ id: '1', name: '实现 X', agent: 'dev', complexity: 'normal', goal_link: '服务于目标' }], edges: [], summary: 'plan' }),
          promptTokens: 2, completionTokens: 3,
        };
      }
      return { content: JSON.stringify({ status: 'success', summary: 'done', verification: 'ok', changes: [], errors: [] }), promptTokens: 3, completionTokens: 4 };
    },
  };
});

import { initBus, closeBus } from '../src/bus';
import { Orchestrator } from '../src/orchestrator/orchestrator';
import { ModelPool } from '../src/scheduler';
import { getTaskGraph, getTaskEvents } from '../src/store';

let tmp: string;

beforeEach(async () => {
  process.env.COTEAM_FORCE_MEMORY = '1';
  closeBus();
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-async-'));
  const devDir = path.join(tmp, 'dev');
  fs.mkdirSync(devDir, { recursive: true });
  fs.writeFileSync(path.join(devDir, 'agent.yaml'), 'name: dev\ntags: [code]\n');
  await initBus({ host: '127.0.0.1', port: 6399, db: 0 });
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
  closeBus();
});

function makeOrchestrator(): Orchestrator {
  const pool = new ModelPool([{ name: 'fake-model', api_key: 'k', base_url: 'http://localhost:9', tags: ['code'] }]);
  return new Orchestrator({
    agentsDir: tmp, modelPool: pool, policy: { whitelistCommands: null, maxTimeSec: 10 },
    maxRetries: 1, sandboxEnabled: false, gitEnabled: false, branchWorkflow: false,
  });
}

async function waitForGraphStatus(taskId: string, status: string, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const g = await getTaskGraph(taskId);
    if (g?.status === status) return;
    if (Date.now() > deadline) throw new Error(`task ${taskId} never reached ${status} (last: ${g?.status})`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe('plan_async (mobile: no LLM work on the HTTP request path)', () => {
  it('createTask returns immediately with a pending graph; vague requirements land in clarifying in the background', async () => {
    const orch = makeOrchestrator();
    await orch.loadAgents();

    const started = Date.now();
    const created = await orch.createTask('做点什么吧', tmp, undefined, { planAsync: true });
    expect(Date.now() - started).toBeLessThan(2000); // no LLM call awaited
    expect(created.needsClarification).toBeFalsy();

    const initial = await getTaskGraph(created.taskId);
    expect(initial!.status).toBe('pending');
    expect(initial!.description).toBe('做点什么吧');

    // background assessment moves the task into clarification
    await waitForGraphStatus(created.taskId, 'clarifying');
    const events = await getTaskEvents(created.taskId);
    const clarifyEvent = events.find((e) => e.type === 'task_needs_clarification');
    expect(clarifyEvent).toBeTruthy();
    expect((clarifyEvent!.payload as any).questions).toContain('具体要做什么？');

    // async clarify: explicit confirmation acknowledges with 'pending', then plans in the background
    const result = await orch.clarify(created.taskId, { confirm: true, answers: [], planAsync: true });
    expect(result.status).toBe('pending');
    await waitForGraphStatus(created.taskId, 'planned');
    const planned = await getTaskGraph(created.taskId);
    expect(planned!.nodes.length).toBeGreaterThan(0);
  }, 15000);

  it('clear requirements plan in the background and the next clarify round arrives via events', async () => {
    const orch = makeOrchestrator();
    await orch.loadAgents();

    // vague create → clarifying
    const created = await orch.createTask('做点什么吧', tmp, undefined, { planAsync: true });
    await waitForGraphStatus(created.taskId, 'clarifying');

    // human answers (not a confirmation) → async re-assessment: still vague → next round event
    const result = await orch.clarify(created.taskId, {
      answers: [{ question: '具体要做什么？', answer: '随便弄点东西' }],
      planAsync: true,
    });
    expect(result.status).toBe('assessing');

    await vi.waitFor(async () => {
      const events = await getTaskEvents(created.taskId);
      const rounds = events.filter((e) => e.type === 'task_needs_clarification');
      expect(rounds.length).toBeGreaterThanOrEqual(2);
      expect((rounds[rounds.length - 1].payload as any).round).toBe(2);
    }, { timeout: 3000 });
    // task stays in clarifying waiting for the human
    const g = await getTaskGraph(created.taskId);
    expect(g!.status).toBe('clarifying');
  }, 15000);

  it('clear requirements skip clarification and reach planned without holding the request', async () => {
    const orch = makeOrchestrator();
    await orch.loadAgents();

    const created = await orch.createTask('实现用户注册 API，包含输入验证和密码加密', tmp, undefined, { planAsync: true });
    expect(created.graph.nodes).toHaveLength(0); // nothing planned yet on the request path
    await waitForGraphStatus(created.taskId, 'planned');
    const planned = await getTaskGraph(created.taskId);
    expect(planned!.nodes.length).toBeGreaterThan(0);
  }, 15000);
});
