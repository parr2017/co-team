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
        // the vague requirement stays unclear until the human answers (stateless per text)
        const prior = user.includes('此前已进行的澄清问答');
        const vague = user.includes('做点什么吧');
        if (vague && !prior) {
          return { content: JSON.stringify({ clear: false, missing: ['目标'], questions: ['具体要做什么？'], summary: '模糊需求' }), promptTokens: 2, completionTokens: 3 };
        }
        return { content: JSON.stringify({ clear: true, missing: [], questions: [], summary: '清楚了' }), promptTokens: 2, completionTokens: 3 };
      }
      if (sys.includes('task planner')) {
        (globalThis as any).__lastPlanModel = entry.name;
        return {
          content: JSON.stringify({ nodes: [{ id: '1', name: '实现 X', agent: 'dev', complexity: 'normal', goal_link: '服务于目标' }], edges: [], summary: 'plan' }),
          promptTokens: 2, completionTokens: 3,
        };
      }
      (globalThis as any).__lastSystem = sys;
      return { content: JSON.stringify({ status: 'success', summary: 'done', changes: [], errors: [] }), promptTokens: 3, completionTokens: 4 };
    },
  };
});

import { initBus, closeBus } from '../src/bus';
import { Orchestrator } from '../src/orchestrator/orchestrator';
import { ModelPool } from '../src/scheduler';
import { getTaskGraph, saveProject, addProjectMemory } from '../src/store';
import { busGet, busSet, busDel } from '../src/bus';

let tmp: string;

beforeEach(async () => {
  process.env.COTEAM_FORCE_MEMORY = '1';
  closeBus();
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-clar-'));
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
  const orch = new Orchestrator({
    agentsDir: tmp, modelPool: pool, policy: { whitelistCommands: null, maxTimeSec: 10 },
    maxRetries: 1, sandboxEnabled: false, gitEnabled: false, branchWorkflow: false,
  });
  return orch;
}

describe('clarification loop (improvement 5, orchestrator integration)', () => {
  it('holds an ambiguous requirement at clarifying until human confirmation, then plans', async () => {
    const orch = makeOrchestrator();
    await orch.loadAgents();

    const created = await orch.createTask('做点什么吧', tmp);
    expect(created.needsClarification).toBe(true);
    expect(created.questions).toContain('具体要做什么？');
    const graph = await getTaskGraph(created.taskId);
    expect(graph!.status).toBe('clarifying');
    expect(graph!.nodes).toHaveLength(0);

    // execution must be blocked while clarification is pending
    const blocked = await orch.execute(created.taskId, tmp);
    expect(blocked.status).toBe('error');

    // human answers → re-assessment clears the requirement → plan generated
    const result = await orch.clarify(created.taskId, { answers: [{ question: '具体要做什么？', answer: '做一个登录页面，用 Vue' }] });
    expect(result.status).toBe('planned');
    const planned = await getTaskGraph(created.taskId);
    expect(planned!.status).toBe('planned');
    expect(planned!.nodes.length).toBeGreaterThan(0);

    // clarify state records the Q/A transcript
    const state = await busGet<{ answers: { answer: string }[]; done?: boolean }>(`task:clarify:${created.taskId}`);
    expect(state!.answers[0].answer).toContain('登录页面');
    expect(state!.done).toBe(true);
  });

  it('proceeds immediately on explicit confirmation', async () => {
    const orch = makeOrchestrator();
    await orch.loadAgents();
    const created = await orch.createTask('做点什么吧', tmp);
    expect(created.needsClarification).toBe(true);
    const result = await orch.clarify(created.taskId, { confirm: true, answers: [] });
    expect(result.status).toBe('planned');
  });

  it('clear requirements skip the loop entirely (no over-communication)', async () => {
    const orch = makeOrchestrator();
    await orch.loadAgents();
    const created = await orch.createTask('实现用户注册 API，包含输入验证和密码加密，测试全部通过算验收', tmp);
    expect(created.needsClarification).toBeFalsy();
    expect(created.graph.nodes.length).toBeGreaterThan(0);
  });
});

describe('main-agent model pinning (improvement 11, orchestrator integration)', () => {
  it('pins the user-selected model at creation and reuses it on replan', async () => {
    const orch = makeOrchestrator();
    await orch.loadAgents();
    const created = await orch.createTask('实现一个功能模块，包含若干接口与页面', tmp, undefined, { mainModelId: 'fake-model' });
    const graph = await getTaskGraph(created.taskId);
    expect(graph!.main_model_id).toBe('fake-model');
    expect((globalThis as any).__lastPlanModel).toBe('fake-model');
    void created;
  });

  it('rejects models outside the pool', async () => {
    const orch = makeOrchestrator();
    await orch.loadAgents();
    await expect(orch.createTask('实现一个功能模块，包含若干接口与页面', tmp, undefined, { mainModelId: 'no-such-model' })).rejects.toThrow('not in pool');
  });

  it('supports mid-task model change with audit trail', async () => {
    const orch = makeOrchestrator();
    await orch.loadAgents();
    const pool = new ModelPool([
      { name: 'fake-model', api_key: 'k', base_url: 'http://localhost:9', tags: ['code'] },
      { name: 'second-model', api_key: 'k', base_url: 'http://localhost:9', tags: ['code'] },
    ]);
    const orch2 = new Orchestrator({
      agentsDir: tmp, modelPool: pool, policy: { whitelistCommands: null, maxTimeSec: 10 },
      maxRetries: 1, sandboxEnabled: false, gitEnabled: false, branchWorkflow: false,
    });
    await orch2.loadAgents();
    const created = await orch2.createTask('实现一个功能模块，包含若干接口与页面', tmp);
    await orch2.setMainModel(created.taskId, 'second-model');
    const graph = await getTaskGraph(created.taskId);
    expect(graph!.main_model_id).toBe('second-model');
    const journals = await import('../src/store').then((m) => m.getTaskJournals(created.taskId));
    expect(JSON.stringify(journals)).toContain('second-model');
  });
});

describe('goal & knowledge injection (improvements 3/9, orchestrator integration)', () => {
  it('injects the global goal, SSOT docs and knowledge into agent prompts', async () => {
    const { writeKnowledge } = await import('../src/knowledge');
    writeKnowledge({ title: '实现页面最佳实践', content: '实现页面时必须做表单校验', category: 'general-tech', tags: ['frontend'] });

    await saveProject({ id: 'p1', name: 'P', workspace: tmp, created_at: new Date().toISOString() });
    await addProjectMemory('p1', '本项目使用 element-plus', 'manual');

    const orch = makeOrchestrator();
    await orch.loadAgents();
    const created = await orch.createTask('实现用户登录页面，要求表单校验', tmp, 'p1');
    await orch.execute(created.taskId, tmp);

    const sys = (globalThis as any).__lastSystem as string;
    expect(sys).toContain('全局目标');
    expect(sys).toContain('实现用户登录页面');
    expect(sys).toContain('协同文档');
    expect(sys).toContain('write_knowledge');
    expect(sys).toContain('实现页面最佳实践');
    expect(sys).toContain('element-plus');

    const goal = await orch.getGoal(created.taskId);
    expect(goal.content).toContain('实现用户登录页面');
    await busDel(`task:goal:${created.taskId}`);
  });

  it('goal updates invalidate agent sessions and are journaled', async () => {
    const orch = makeOrchestrator();
    await orch.loadAgents();
    const created = await orch.createTask('实现一个功能模块，包含若干接口与页面', tmp);
    const taskId = created.taskId;
    await busSet(`task:${taskId}:agent:dev:session`, [{ role: 'user', content: 'stale' }]);
    await orch.updateGoal(taskId, '新目标：先做最小闭环');
    expect(await busGet(`task:${taskId}:agent:dev:session`)).toBeNull();
    const goal = await orch.getGoal(taskId);
    expect(goal.content).toContain('最小闭环');
    const { getTaskJournals } = await import('../src/store');
    expect(JSON.stringify(await getTaskJournals(taskId))).toContain('全局目标已更新');
  });
});
