import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// 任意节点重新开始（jgfhfaux 复盘）：retry API 从"仅 needs_human/中断/僵尸"泛化为
// completed 节点同样可重开，下游全量级联重置——账面完成但零产出的毒节点不再永久卡死任务。
// 纯状态机测试：不触发 LLM，直接落任务图后打 API。

import { initBus, closeBus, busSet, busGet } from '../src/bus';
import { Orchestrator } from '../src/orchestrator/orchestrator';
import { ModelPool } from '../src/scheduler';
import { saveTaskGraph, getTaskGraph } from '../src/store';
import { createApi } from '../src/api';
import type { AppConfig } from '../src/config';
import type { TaskNode } from '../src/types';

let tmp: string;
let app: ReturnType<typeof createApi>;
let orchestrator: Orchestrator;
const ws = () => path.join(tmp, 'proj');

const json = (r: Response) => r.json() as Promise<any>;
const post = (url: string) =>
  app.request(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });

function makeNode(id: string, extra: Partial<TaskNode> = {}): TaskNode {
  return {
    id, task_id: 't-rs', name: `节点${id}`, status: 'pending', agent: 'dev', result: null, error: '',
    retry_count: 0, complexity: 'normal', requires_approval: false, needs_human: false,
    created_at: '', updated_at: '', ...extra,
  };
}

async function saveGraph(nodes: TaskNode[], edges: [string, string][], status: string) {
  await saveTaskGraph('t-rs', nodes, edges, { description: 'x', workspace: ws(), status } as any);
}

beforeEach(async () => {
  process.env.COTEAM_FORCE_MEMORY = '1';
  closeBus();
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-restart-'));
  fs.mkdirSync(ws(), { recursive: true });
  const agentsDir = path.join(tmp, 'agents');
  fs.mkdirSync(path.join(agentsDir, 'dev'), { recursive: true });
  fs.writeFileSync(path.join(agentsDir, 'dev', 'agent.yaml'), 'name: dev\ntags: [code]\nrole: 开发\n');
  await initBus({ host: '127.0.0.1', port: 6399, db: 0 });
  const pool = new ModelPool([{ id: 'fake-model', name: 'fake-model', api_key: 'k', base_url: 'http://localhost:9', tags: ['code'] }]);
  orchestrator = new Orchestrator({
    agentsDir, modelPool: pool,
    policy: { level: 'full', whitelistCommands: null, maxTimeSec: 10 },
    maxRetries: 1, sandboxEnabled: false, gitEnabled: false, branchWorkflow: false,
  });
  await orchestrator.loadAgents();
  app = createApi({
    config: { agents_dir: agentsDir, dashboard: {}, model_pool: [], orchestrator: {}, permissions: {}, redis: {} } as unknown as AppConfig,
    orchestrator,
    modelPool: pool,
    taskQueue: { enqueue: async () => ({}), releaseStalled: () => {} } as any,
  } as any);
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
  closeBus();
});

describe('retry API 泛化：任意节点重新开始', () => {
  it('completed 节点可重开：下游 completed/cancelled 全量级联重置，任务复活', async () => {
    const n1 = makeNode('1', { status: 'completed', branch: 'coteam/1-dev', branch_base: 'coteam/base' });
    const n2 = makeNode('2', { status: 'completed', branch: 'coteam/2-test' });
    const n3 = makeNode('3', { status: 'cancelled' });
    await saveGraph([n1, n2, n3], [['1', '2'], ['2', '3']], 'failed');
    // 重置节点的遗留待审批命令应一并清掉
    await busSet('task:pending_commands:t-rs', [
      { id: 'pc1', node_id: '2', command: 'dart test' },
      { id: 'pc2', node_id: '9', command: 'keep me' },
    ]);

    const r = await json(await post('/api/tasks/t-rs/nodes/1/retry'));
    expect(r.status).toBe('requeued');
    expect(r.restarted_from_completed).toBe(true);
    expect([...r.reset_nodes].sort()).toEqual(['1', '2', '3']);

    const g = (await getTaskGraph('t-rs'))!;
    expect(g.status).toBe('queued');
    for (const n of g.nodes) {
      expect(n.status).toBe('pending');
      expect(n.branch).toBe('');
      expect(n.branch_base).toBe('');
      expect(n.retry_count).toBe(0);
    }
    const pc = (await busGet<any[]>('task:pending_commands:t-rs')) || [];
    expect(pc.map((c) => c.id)).toEqual(['pc2']);
  });

  it('running 任务拒绝 completed 节点重开；人工门失败节点沿用旧语义放行', async () => {
    const n1 = makeNode('1', { status: 'completed' });
    const n2 = makeNode('2', { status: 'failed', needs_human: true, error_type: 'human_gate' as any });
    await saveGraph([n1, n2], [['1', '2']], 'running');

    const blocked = await post('/api/tasks/t-rs/nodes/1/retry');
    expect(blocked.status).toBe(400);

    // 旧流程：任务在途时人工门节点仍可续跑（重置入队，车道空出后生效）
    const ok = await json(await post('/api/tasks/t-rs/nodes/2/retry'));
    expect(ok.status).toBe('requeued');
    expect(ok.restarted_from_completed).toBe(false);
  });

  it('执行中的节点拒绝重置（防双跑），僵尸 running 可解锁', async () => {
    const n1 = makeNode('1', { status: 'running' });
    const n2 = makeNode('2', { status: 'completed' });
    await saveGraph([n1, n2], [['1', '2']], 'running');
    const original = orchestrator.isNodeExecuting.bind(orchestrator);

    orchestrator.isNodeExecuting = () => true;
    const blocked = await post('/api/tasks/t-rs/nodes/1/retry');
    expect(blocked.status).toBe(400);

    orchestrator.isNodeExecuting = () => false;
    const ok = await json(await post('/api/tasks/t-rs/nodes/1/retry'));
    expect(ok.status).toBe('requeued');
    const g = (await getTaskGraph('t-rs'))!;
    expect(g.nodes.find((n) => n.id === '1')!.status).toBe('pending');
    expect(g.nodes.find((n) => n.id === '2')!.status).toBe('pending');
    orchestrator.isNodeExecuting = original;
  });

  it('completed 任务同样可从节点重开（重新开始语义）', async () => {
    const n1 = makeNode('1', { status: 'completed' });
    const n2 = makeNode('2', { status: 'completed' });
    await saveGraph([n1, n2], [['1', '2']], 'completed');
    const r = await json(await post('/api/tasks/t-rs/nodes/2/retry'));
    expect(r.status).toBe('requeued');
    expect(r.reset_nodes).toEqual(['2']);
    const g = (await getTaskGraph('t-rs'))!;
    expect(g.status).toBe('queued');
    expect(g.nodes.find((n) => n.id === '1')!.status).toBe('completed'); // 上游不动
  });
});
