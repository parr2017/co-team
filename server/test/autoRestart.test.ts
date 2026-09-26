import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// 自动重开（jgfhfaux 复盘）：下游人工门失败确定性归因到上游 completed 节点交付缺失时，
// 主 agent 把下游失败报告反馈给肇事节点并自动级联重开——能自愈的不再停靠人工。
// 护栏：任务级 ≤3 次、每节点只自动重开一次、错误不像交付缺失一律保持人工门。

import { initBus, closeBus, busGet } from '../src/bus';
import { Orchestrator } from '../src/orchestrator/orchestrator';
import { ModelPool } from '../src/scheduler';
import { saveTaskGraph, getTaskGraph, persistGraph } from '../src/store';
import type { TaskNode } from '../src/types';

let tmp: string;
let orchestrator: Orchestrator;
let seq = 0;

function makeNode(id: string, extra: Partial<TaskNode> = {}): TaskNode {
  return {
    id, task_id: 't-ar', name: `节点${id}`, status: 'pending', agent: 'dev', result: null, error: '',
    retry_count: 0, complexity: 'normal', requires_approval: false, needs_human: false,
    created_at: '', updated_at: '', ...extra,
  };
}

async function saveGraph(taskId: string, nodes: TaskNode[], edges: [string, string][], status: string) {
  await saveTaskGraph(taskId, nodes, edges, { description: 'x', workspace: path.join(tmp, 'proj'), status } as any);
}

beforeEach(async () => {
  process.env.COTEAM_FORCE_MEMORY = '1';
  closeBus();
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-autorestart-'));
  fs.mkdirSync(path.join(tmp, 'proj'), { recursive: true });
  const agentsDir = path.join(tmp, 'agents');
  fs.mkdirSync(path.join(agentsDir, 'dev'), { recursive: true });
  fs.writeFileSync(path.join(agentsDir, 'dev', 'agent.yaml'), 'name: dev\ntags: [code]\nrole: 开发\n');
  await initBus({ host: '127.0.0.1', port: 6399, db: 0 });
  const pool = new ModelPool([{ id: 'fake-model', name: 'fake-model', api_key: 'k', base_url: 'http://localhost:9', tags: ['code'] }]);
  orchestrator = new Orchestrator({
    agentsDir, modelPool: pool, policy: { level: 'full', whitelistCommands: null, maxTimeSec: 10 },
    maxRetries: 1, sandboxEnabled: false, gitEnabled: false, branchWorkflow: false,
  });
  await orchestrator.loadAgents();
  seq = 0;
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
  closeBus();
});

describe('autoRestartFromFailedNode（人工门自动归因重开）', () => {
  it('路径归因：下游错误提到的文件命中上游申报清单 → 反馈原因并级联重开', async () => {
    const taskId = `t-ar${++seq}`;
    const u = makeNode('u', {
      status: 'completed', branch: 'coteam/u-dev', branch_base: 'coteam/base',
      result: { status: 'success', changes: ['server/lib/ai_service.dart: 接入', 'server/lib/ai_cache.dart: 实现缓存'] },
    });
    const t = makeNode('t', {
      status: 'failed', needs_human: true, error_type: 'human_gate' as any,
      error: '需人工介入（执行前置缺失（缺源码/信息，需人工补齐后重试））：被测对象缺失（服务端缓存层）：server/lib/ai_cache.dart 不存在——前置节点标记完成但产出未落盘',
    });
    await saveGraph(taskId, [u, t], [['u', 't']], 'failed');

    const restarted = await orchestrator.autoRestartFromFailedNode(taskId);
    expect(restarted).toBe(true);

    const g = (await getTaskGraph(taskId))!;
    expect(g.status).toBe('queued');
    expect(g.auto_restarts).toBe(1);
    expect(g.nodes.find((n) => n.id === 'u')!.status).toBe('pending');
    expect(g.nodes.find((n) => n.id === 'u')!.branch).toBe('');
    expect(g.nodes.find((n) => n.id === 't')!.status).toBe('pending');

    const feedback = await busGet<{ from: string; error: string }>(`task:node:feedback:${taskId}:u`);
    expect(feedback?.from).toBe('节点t');
    expect(feedback?.error).toContain('ai_cache.dart 不存在');
    expect(await busGet(`task:node:autorestart:${taskId}:u`)).toBeTruthy();
  });

  it('防乒乓：同一肇事节点只自动重开一次，第二次失败停靠人工', async () => {
    const taskId = `t-ar${++seq}`;
    const u = makeNode('u', {
      status: 'completed',
      result: { status: 'success', changes: ['server/lib/ai_cache.dart: 实现缓存'] },
    });
    const t = makeNode('t', {
      status: 'failed', needs_human: true, error_type: 'human_gate' as any,
      error: '被测对象缺失：server/lib/ai_cache.dart 不存在——前置节点产出未落盘',
    });
    await saveGraph(taskId, [u, t], [['u', 't']], 'failed');
    expect(await orchestrator.autoRestartFromFailedNode(taskId)).toBe(true);

    // 模拟重跑后同样失败：任务回到 failed，T 再次 needs_human
    const g = (await getTaskGraph(taskId))!;
    g.status = 'failed';
    const tu = g.nodes.find((n) => n.id === 'u')!;
    tu.status = 'completed';
    const tt = g.nodes.find((n) => n.id === 't')!;
    tt.status = 'failed';
    tt.needs_human = true;
    tt.error = '被测对象缺失：server/lib/ai_cache.dart 不存在';
    await persistGraph(g);

    expect(await orchestrator.autoRestartFromFailedNode(taskId)).toBe(false);
    const g2 = (await getTaskGraph(taskId))!;
    expect(g2.nodes.find((n) => n.id === 't')!.status).toBe('failed'); // 保持人工门，未被重置
  });

  it('无路径命中时回退归因：交付校验不一致的 completed 上游（≤2 个）', async () => {
    const taskId = `t-ar${++seq}`;
    const u = makeNode('u', {
      status: 'completed',
      result: { status: 'success', changes: ['lib/x.dart: 实现'], delivery_check: { consistent: false, reported_count: 1, actual_count: 0, unreported: [], phantom: ['lib/x.dart'] } } as any,
    });
    const t = makeNode('t', {
      status: 'failed', needs_human: true, error_type: 'human_gate' as any,
      error: '需人工介入：前置节点声称完成但产出未合入工作区（git log 无任何相关提交）',
    });
    await saveGraph(taskId, [u, t], [['u', 't']], 'failed');

    expect(await orchestrator.autoRestartFromFailedNode(taskId)).toBe(true);
    const g = (await getTaskGraph(taskId))!;
    expect(g.nodes.find((n) => n.id === 'u')!.status).toBe('pending');
    expect(g.auto_restarts).toBe(1);
  });

  it('错误不像交付缺失（环境问题）不自动重开，保持人工门', async () => {
    const taskId = `t-ar${++seq}`;
    const u = makeNode('u', { status: 'completed', result: { status: 'success', changes: ['lib/x.dart: 实现'] } });
    const t = makeNode('t', {
      status: 'failed', needs_human: true, error_type: 'human_gate' as any,
      error: '需人工介入（系统/环境缺陷）：机器未安装 flutter SDK，无法执行构建验收',
    });
    await saveGraph(taskId, [u, t], [['u', 't']], 'failed');

    expect(await orchestrator.autoRestartFromFailedNode(taskId)).toBe(false);
    const g = (await getTaskGraph(taskId))!;
    expect(g.nodes.find((n) => n.id === 't')!.status).toBe('failed');
    expect(g.auto_restarts).toBeUndefined();
  });

  it('任务级自动重开达上限（3 次）后不再重开', async () => {
    const taskId = `t-ar${++seq}`;
    const u = makeNode('u', { status: 'completed', result: { status: 'success', changes: ['lib/a.dart: 实现'] } });
    const t = makeNode('t', {
      status: 'failed', needs_human: true, error_type: 'human_gate' as any,
      error: '被测对象缺失：lib/a.dart 不存在',
    });
    await saveGraph(taskId, [u, t], [['u', 't']], 'failed');
    const g = (await getTaskGraph(taskId))!;
    g.auto_restarts = 3;
    await persistGraph(g);

    expect(await orchestrator.autoRestartFromFailedNode(taskId)).toBe(false);
    expect((await getTaskGraph(taskId))!.nodes.find((n) => n.id === 't')!.status).toBe('failed');
  });
});
