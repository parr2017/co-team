import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// LLM 打桩：第一次调用（监督者评估）返回固定动作脚本，其余按需
const evalResponses: { content: string }[] = [];
vi.mock('../src/llm', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/llm')>();
  return {
    ...actual,
    chat: async () => {
      const r = evalResponses.shift() || { content: '{"assessment":"ok","actions":[]}' };
      return { content: r.content, promptTokens: 3, completionTokens: 4 };
    },
  };
});

import { initBus, closeBus, getBus } from '../src/bus';
import { ModelPool } from '../src/scheduler';
import { Orchestrator } from '../src/orchestrator/orchestrator';
import { Supervisor, type SupervisorProposal } from '../src/orchestrator/supervisor';
import { saveTaskGraph, getTaskGraph, getTaskJournals, getTaskEvents } from '../src/store';
import type { TaskNode } from '../src/types';

let tmp: string;
let orchestrator: Orchestrator;
let supervisor: Supervisor;

beforeEach(async () => {
  process.env.COTEAM_FORCE_MEMORY = '1';
  closeBus();
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-sup-'));
  for (const name of ['dev', 'review']) {
    const dir = path.join(tmp, name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'agent.yaml'), `name: ${name}\ntags: [code]\nrole: 开发\n`);
  }
  await initBus({ host: '127.0.0.1', port: 6399, db: 0 });
  evalResponses.length = 0;
  const pool = new ModelPool([{ name: 'fake-model', api_key: 'k', base_url: 'http://localhost:9', tags: ['code'] }]);
  orchestrator = new Orchestrator({
    agentsDir: tmp, modelPool: pool, policy: { whitelistCommands: null, maxTimeSec: 10 },
    maxRetries: 1, sandboxEnabled: false, gitEnabled: false, branchWorkflow: false,
  });
  await orchestrator.loadAgents();
  supervisor = new Supervisor({
    pool,
    heartbeatSec: 0,
    minIntervalSec: 0,
    availableAgents: () => [...orchestrator.plugins.keys()],
  });
});

afterEach(() => {
  supervisor.stop();
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

describe('M3 监督者', () => {
  it('node_error 触发评估，LLM 动作被分派（催办/汇报/建议落 journal）', async () => {
    await saveTaskGraph('t-sup', [makeNode('n1', 'dev', { status: 'failed', error: 'build 红了' })], [], { description: 'demo', workspace: tmp, status: 'running' });
    evalResponses.push({
      content: JSON.stringify({
        assessment: 'build 失败需要重试',
        actions: [
          { action: 'nudge', node_id: 'n1', message: '请检查 build 报错的根因' },
          { action: 'report', message: '节点 n1 失败，已安排催办' },
          { action: 'suggest', message: '建议下次先本地 build 再申报完成' },
        ],
      }),
    });
    await supervisor.trigger('t-sup', 'node_error:n1');
    const journals = Object.values(await getTaskJournals('t-sup')).flat();
    expect(journals.some((e) => String(e.text).includes('监督者评估'))).toBe(true);
    expect(journals.some((e) => String(e.text).includes('催办已注入'))).toBe(true);
    expect(journals.some((e) => String(e.text).includes('监督者汇报'))).toBe(true);
    expect(journals.some((e) => String(e.text).includes('监督者建议'))).toBe(true);
    // 催办经插话通道注入（store 层验证）
    const { consumeInterventions } = await import('../src/store');
    const q = await consumeInterventions('t-sup');
    expect(q.some((m) => m.message.includes('监督者催办'))).toBe(true);
  });

  it('提案去重与批准执行：retry_failed 批准后节点回 pending', async () => {
    await saveTaskGraph('t-prop', [makeNode('n1', 'dev', { status: 'failed', error: 'x' })], [], { description: 'demo', workspace: tmp, status: 'running' });
    evalResponses.push({
      content: JSON.stringify({ assessment: '需要重试', actions: [{ action: 'propose_retry', node_id: 'n1', message: '失败是瞬时的，建议重试' }] }),
    });
    await supervisor.trigger('t-prop', 'node_error:n1');
    let proposals = (await getBus().get('task:proposals:t-prop')) as SupervisorProposal[];
    expect(proposals.length).toBe(1);
    expect(proposals[0].type).toBe('retry_failed');
    expect(proposals[0].status).toBe('pending');

    // 重复触发不产生重复提案
    evalResponses.push({
      content: JSON.stringify({ assessment: '需要重试', actions: [{ action: 'propose_retry', node_id: 'n1', message: '再提一次' }] }),
    });
    await supervisor.trigger('t-prop', 'node_error:n1');
    proposals = (await getBus().get('task:proposals:t-prop')) as SupervisorProposal[];
    expect(proposals.length).toBe(1);

    // 批准（走 API 端点）
    const { createApi } = await import('../src/api');
    const { TaskQueueManager } = await import('../src/taskQueue');
    const { createTaskQueueStub } = await setupApiHelpers();
    const queue = createTaskQueueStub();
    const app = createApi({
      config: {
        agents_dir: tmp, dashboard: { host: '127.0.0.1', port: 0 },
        model_pool: [], orchestrator: { max_retries: 1, sandbox: false, git: false } as any,
        permissions: {}, redis: { host: '127.0.0.1', port: 6399, db: 0 },
        knowledge: { dir: path.join(tmp, 'kb') },
      } as any,
      orchestrator,
      modelPool: new ModelPool([]),
      taskQueue: queue as any,
    });
    const res = await app.request('/api/tasks/t-prop/proposals/' + proposals[0].id + '/decide', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ approved: true }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('executed');
    const graph = await getTaskGraph('t-prop');
    expect(graph!.nodes[0].status).toBe('pending');
    // 重试类提案执行后任务重新入队
    expect(queue.enqueued).toContain('t-prop');
  });

  it('拒绝提案留痕；非 pending 提案不可重复决定', async () => {
    await saveTaskGraph('t-rej', [makeNode('n1', 'dev')], [], { description: 'demo', workspace: tmp, status: 'planned' });
    evalResponses.push({
      content: JSON.stringify({ assessment: '范围过大', actions: [{ action: 'propose_cancel', node_id: 'n1', message: '该节点超出最小闭环' }] }),
    });
    await supervisor.trigger('t-rej', 'node_error:n1');
    const proposals = (await getBus().get('task:proposals:t-rej')) as SupervisorProposal[];
    const { createApi } = await import('../src/api');
    const { TaskQueueManager } = await import('../src/taskQueue');
    const app = createApi({
      config: {
        agents_dir: tmp, dashboard: { host: '127.0.0.1', port: 0 },
        model_pool: [], orchestrator: { max_retries: 1, sandbox: false, git: false } as any,
        permissions: {}, redis: { host: '127.0.0.1', port: 6399, db: 0 },
        knowledge: { dir: path.join(tmp, 'kb') },
      } as any,
      orchestrator,
      modelPool: new ModelPool([]),
      taskQueue: new TaskQueueManager(orchestrator, new ModelPool([])),
    });
    const res = await app.request('/api/tasks/t-rej/proposals/' + proposals[0].id + '/decide', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ approved: false }),
    });
    expect(res.status).toBe(200);
    const res2 = await app.request('/api/tasks/t-rej/proposals/' + proposals[0].id + '/decide', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ approved: true }),
    });
    expect(res2.status).toBe(400);
    const journals = Object.values(await getTaskJournals('t-rej')).flat();
    expect(journals.some((e) => String(e.text).includes('已拒绝'))).toBe(true);
  });

  it('minIntervalSec 限频：同原因冷却期内不重复评估（防自激）', async () => {
    await saveTaskGraph('t-rate', [makeNode('n1', 'dev', { status: 'failed' })], [], { description: 'demo', workspace: tmp, status: 'running' });
    const sup = new Supervisor({ pool: new ModelPool([{ name: 'm', api_key: 'k', base_url: 'http://x', tags: [] }]), heartbeatSec: 0, minIntervalSec: 600 });
    evalResponses.push({ content: '{"assessment":"1","actions":[]}' });
    await sup.trigger('t-rate', 'node_error:n1');
    evalResponses.push({ content: '{"assessment":"2","actions":[]}' });
    await sup.trigger('t-rate', 'node_error:n1'); // 冷却期内 → 不消费第二条
    expect(evalResponses.length).toBe(1); // 第二条脚本未被消费
    sup.stop();
  });

  it('insert_node 提案校验 agent 有效性，非法 agent 不生成提案', async () => {
    await saveTaskGraph('t-ins', [makeNode('n1', 'dev')], [], { description: 'demo', workspace: tmp, status: 'planned' });
    evalResponses.push({
      content: JSON.stringify({ assessment: '缺测试', actions: [{ action: 'propose_insert', after_node_id: 'n1', new_node: { name: '补一轮测试', agent: 'ghost' }, message: '需要补测试节点' }] }),
    });
    await supervisor.trigger('t-ins', 'node_error:n1');
    const proposals = (await getBus().get('task:proposals:t-ins')) as SupervisorProposal[];
    expect(proposals).toBeNull();
  });
});

async function setupApiHelpers() {
  return {
    createTaskQueueStub() {
      const enqueued: string[] = [];
      return {
        enqueued,
        enqueue: async (taskId: string) => { enqueued.push(taskId); return {}; },
      };
    },
  };
}
