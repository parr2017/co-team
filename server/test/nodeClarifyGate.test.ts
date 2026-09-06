import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { initBus, closeBus, busGet } from '../src/bus';
import { Orchestrator } from '../src/orchestrator/orchestrator';
import { saveTaskGraph, getTaskGraph } from '../src/store';
import type { TaskNode } from '../src/types';

// feature: 每步骤实施前澄清 —— 节点简报门：waiting_clarify → 用户确认 → 继续执行

function makeNode(id: string, agent = 'dev'): TaskNode {
  return {
    id, task_id: 't', name: `节点-${id}`, status: 'pending', agent, result: null, error: '',
    retry_count: 0, complexity: 'normal', requires_approval: false, needs_human: false,
    created_at: '', updated_at: '',
  };
}

describe('node clarify gate', () => {
  let tmp: string;
  let orchestrator: Orchestrator;

  beforeEach(async () => {
    process.env.COTEAM_FORCE_MEMORY = '1';
    closeBus();
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-clr-'));
    const devDir = path.join(tmp, 'dev');
    fs.mkdirSync(devDir, { recursive: true });
    fs.writeFileSync(path.join(devDir, 'agent.yaml'), 'name: dev\ntags: [code]\nrole: 开发\n');
    await initBus({ host: '127.0.0.1', port: 6399, db: 0 });
    orchestrator = new Orchestrator({
      agentsDir: tmp,
      modelPool: null, // 无模型池 → 简报走 fallback，不调 LLM
      policy: { level: 'approve_required', whitelistCommands: null, maxTimeSec: 10 },
      maxRetries: 1,
      sandboxEnabled: false,
      gitEnabled: false,
      nodeClarify: 'brief',
    });
    await orchestrator.loadAgents();
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
    closeBus();
  });

  it('gates the first run behind a brief, then proceeds after user confirmation', async () => {
    // dev 节点需要真实 dispatch —— mock 成功，专注测门本身
    (orchestrator as any).dispatch = async () => ({ status: 'success', changes: [], summary: 'ok' });
    await saveTaskGraph('t-clr', [makeNode('n1', 'dev')], [], { description: 'clr', workspace: tmp, status: 'running' });

    // 第一轮：节点被简报门拦下
    const first = await (orchestrator as any).runGraph('t-clr', (await getTaskGraph('t-clr'))!, tmp);
    expect(first.status).toBe('waiting_clarify');
    let graph = (await getTaskGraph('t-clr'))!;
    expect(graph.nodes[0].status).toBe('waiting_clarify');

    // 简报已生成（无模型池 → fallback 简报）
    const state = await busGet<any>(`task:node:clarify:t-clr:n1`);
    expect(state.mode).toBe('brief');
    expect(state.brief.approach).toBeTruthy();

    // 用户答复 + 确认 → 节点回 pending
    const r = await orchestrator.clarifyNode('t-clr', 'n1', { approve: true, text: '按最小闭环实现' });
    expect(r.status).toBe('pending');
    graph = (await getTaskGraph('t-clr'))!;
    expect(graph.nodes[0].status).toBe('pending');

    // 已澄清标记存在，第二轮 runGraph 不再被拦
    expect(await busGet(`task:node:clarified:t-clr:n1`)).toBeTruthy();
    const second = await (orchestrator as any).runGraph('t-clr', graph, tmp);
    expect(second.status).toBe('success');
    expect(graph.nodes[0].status === 'completed' || (await getTaskGraph('t-clr'))!.nodes[0].status === 'completed').toBe(true);
  });

  it('off mode skips the gate entirely', async () => {
    const off = new Orchestrator({
      agentsDir: tmp,
      modelPool: null,
      policy: { level: 'approve_required', whitelistCommands: null, maxTimeSec: 10 },
      maxRetries: 1,
      sandboxEnabled: false,
      gitEnabled: false,
      nodeClarify: 'off',
    });
    await off.loadAgents();
    (off as any).dispatch = async () => ({ status: 'success', changes: [], summary: 'ok' });
    await saveTaskGraph('t-off', [makeNode('n1', 'dev')], [], { description: 'off', workspace: tmp, status: 'running' });
    const result = await (off as any).runGraph('t-off', (await getTaskGraph('t-off'))!, tmp);
    expect(result.status).toBe('success');
    expect(await busGet(`task:node:clarify:t-off:n1`)).toBeNull();
  });

  it('task-level node_clarify overrides the global default', async () => {
    const off = new Orchestrator({
      agentsDir: tmp,
      modelPool: null,
      policy: { level: 'approve_required', whitelistCommands: null, maxTimeSec: 10 },
      maxRetries: 1,
      sandboxEnabled: false,
      gitEnabled: false,
      nodeClarify: 'off', // 全局关
    });
    await off.loadAgents();
    await saveTaskGraph('t-task', [makeNode('n1')], [], { description: 'task-level', workspace: tmp, status: 'running', node_clarify: 'confirm' });
    const result = await (off as any).runGraph('t-task', (await getTaskGraph('t-task'))!, tmp);
    expect(result.status).toBe('waiting_clarify');
    const state = await busGet<any>(`task:node:clarify:t-task:n1`);
    expect(state.mode).toBe('confirm');
  });
});
