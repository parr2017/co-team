import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { closeBus, initBus } from '../src/bus';
import { Orchestrator } from '../src/orchestrator/orchestrator';
import { saveTaskGraph, getTaskGraph } from '../src/store';
import type { AgentResult, TaskNode } from '../src/types';

let tmp: string;
let orchestrator: Orchestrator;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

beforeEach(async () => {
  process.env.COTEAM_FORCE_MEMORY = '1';
  closeBus();
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-sched-'));
  const devDir = path.join(tmp, 'dev');
  fs.mkdirSync(devDir, { recursive: true });
  fs.writeFileSync(path.join(devDir, 'agent.yaml'), 'name: dev\ntags: [code]\nrole: 开发\n');
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

function makeNode(id: string, agent: string, extra: Partial<TaskNode> = {}): TaskNode {
  return {
    id, task_id: 't', name: id, status: 'pending', agent, result: null, error: '',
    retry_count: 0, complexity: 'normal', requires_approval: false, needs_human: false,
    created_at: '', updated_at: '',
    ...extra,
  };
}

function ok(): AgentResult {
  return { status: 'success', changes: [], summary: 'done', errors: [] };
}

describe('M1 连续调度器', () => {
  it('下游节点就绪即发射，不等同波慢节点（去波次屏障）', async () => {
    const startAt = new Map<string, number>();
    const endAt = new Map<string, number>();
    (orchestrator as any).dispatch = async (_taskId: string, node: TaskNode): Promise<AgentResult> => {
      startAt.set(node.id, Date.now());
      await sleep(node.id === 'slow' ? 200 : 20);
      endAt.set(node.id, Date.now());
      return ok();
    };
    // fast 完成后即刻解锁 downstream；slow 与 fast 同批发射但耗时 10 倍
    const nodes = [makeNode('fast', 'dev'), makeNode('slow', 'dev'), makeNode('downstream', 'dev')];
    const edges: [string, string][] = [['fast', 'downstream']];
    await saveTaskGraph('t-cts', nodes, edges, { description: 'x', workspace: tmp });
    const result = await (orchestrator as any).runGraph('t-cts', (await getTaskGraph('t-cts'))!, tmp);
    expect(result.status).toBe('success');
    expect(result.completed).toBe(3);
    // downstream 必须在 slow 结束前就已启动（波次制下会等 slow 落地才进下一波）
    expect(startAt.get('downstream')!).toBeLessThan(endAt.get('slow')!);
  });

  it('maxWorkers 成为真信号量（单槽位下节点串行）', async () => {
    let active = 0;
    let maxActive = 0;
    const o = new Orchestrator({
      agentsDir: tmp,
      modelPool: { totalAvailable: () => 1 } as any, // 单槽位
      policy: { whitelistCommands: null, maxTimeSec: 10 },
      maxRetries: 2,
      sandboxEnabled: false,
      gitEnabled: false,
    });
    await o.loadAgents();
    (o as any).dispatch = async (_taskId: string, _node: TaskNode): Promise<AgentResult> => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await sleep(15);
      active -= 1;
      return ok();
    };
    const nodes = [makeNode('a', 'dev'), makeNode('b', 'dev'), makeNode('c', 'dev'), makeNode('d', 'dev')];
    await saveTaskGraph('t-sem', nodes, [], { description: 'x', workspace: tmp });
    const result = await (o as any).runGraph('t-sem', (await getTaskGraph('t-sem'))!, tmp);
    expect(result.status).toBe('success');
    expect(maxActive).toBe(1);
  });

  it('节点失败即时 cancelDownstream，其余在飞节点照常落地', async () => {
    (orchestrator as any).dispatch = async (_taskId: string, node: TaskNode): Promise<AgentResult> => {
      if (node.id === 'boom') return { status: 'failed', error: 'simulated failure' } as AgentResult;
      await sleep(30); // 兄弟节点慢一点，旧波次制下 boom 的下游要等它落地才被 cancel
      return ok();
    };
    const nodes = [makeNode('boom', 'dev'), makeNode('sibling', 'dev'), makeNode('victim', 'dev')];
    const edges: [string, string][] = [['boom', 'victim']];
    await saveTaskGraph('t-fail', nodes, edges, { description: 'x', workspace: tmp });
    const result = await (orchestrator as any).runGraph('t-fail', (await getTaskGraph('t-fail'))!, tmp);
    expect(result.status).toBe('failed');
    expect(result.node).toBe('boom');
    const graph = await getTaskGraph('t-fail');
    const byId = Object.fromEntries(graph!.nodes.map((n) => [n.id, n.status]));
    expect(byId.boom).toBe('failed');
    expect(byId.victim).toBe('cancelled'); // 上游失败连带取消
    expect(byId.sibling).toBe('completed'); // 无关节点不受影响、照常落地
  });

  it('审批门不再阻塞其他分支：等待审批时其余节点继续跑完', async () => {
    (orchestrator as any).dispatch = async (): Promise<AgentResult> => {
      await sleep(20);
      return ok();
    };
    const nodes = [makeNode('gated', 'dev', { requires_approval: true }), makeNode('free', 'dev')];
    await saveTaskGraph('t-gate', nodes, [], { description: 'x', workspace: tmp });
    const result = await (orchestrator as any).runGraph('t-gate', (await getTaskGraph('t-gate'))!, tmp);
    // 旧波次制：runnable 为空立即 return waiting_approval，free 根本不会执行。
    // 连续调度：free 照常完成，任务整体仍停在 waiting_approval 等人工。
    expect(result.status).toBe('waiting_approval');
    const graph = await getTaskGraph('t-gate');
    const byId = Object.fromEntries(graph!.nodes.map((n) => [n.id, n.status]));
    expect(byId.free).toBe('completed');
    expect(byId.gated).toBe('waiting_approval');
  });
});
