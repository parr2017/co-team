import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { simpleGit } from 'simple-git';

/**
 * B1 验收软门（2026-09-17）：合并后验收测试失败时——
 * tolerant（缺省）→ 任务 completed_with_warnings（不把主体完成的任务一刀切判死）；
 * strict → 保持旧硬失败语义。
 */
const agentBehaviors: (() => { content: string })[] = [];

vi.mock('../src/llm', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/llm')>();
  return {
    ...actual,
    chat: async (_entry: any, _messages: { role: string; content: string }[]) => {
      const b = agentBehaviors.shift();
      return b ? { ...b(), promptTokens: 3, completionTokens: 4 } : { content: JSON.stringify({ status: 'success', summary: 'done', verification: 'ok', changes: [], errors: [] }), promptTokens: 3, completionTokens: 4 };
    },
  };
});

import { initBus, closeBus } from '../src/bus';
import { Orchestrator } from '../src/orchestrator/orchestrator';
import { ModelPool } from '../src/scheduler';
import { saveTaskGraph, getTaskGraph, persistGraph } from '../src/store';
import type { TaskGraph, TaskNode } from '../src/types';

let tmp: string;
let orchestrator: Orchestrator;

beforeEach(async () => {
  process.env.COTEAM_FORCE_MEMORY = '1';
  closeBus();
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-acc-'));
  const g = simpleGit({ baseDir: tmp });
  await g.init();
  await g.addConfig('user.name', 't');
  await g.addConfig('user.email', 't@t');
  // 验收必然失败的测试命令（npm test → exit 1）
  fs.writeFileSync(path.join(tmp, 'package.json'), JSON.stringify({ name: 't', scripts: { test: 'node -e "process.exit(1)"' } }), 'utf-8');
  const devDir = path.join(tmp, 'dev');
  fs.mkdirSync(devDir, { recursive: true });
  fs.writeFileSync(path.join(devDir, 'agent.yaml'), 'name: dev\ntags: [code]\nrole: 开发\n');
  fs.writeFileSync(path.join(tmp, 'base.txt'), 'v1\n');
  await g.add('-A');
  await g.commit('init');
  await initBus({ host: '127.0.0.1', port: 6399, db: 0 });
  agentBehaviors.length = 0;
  const pool = new ModelPool([{ name: 'fake-model', api_key: 'k', base_url: 'http://localhost:9', tags: ['code'] }]);
  orchestrator = new Orchestrator({
    agentsDir: tmp, modelPool: pool, policy: { whitelistCommands: null, maxTimeSec: 10 },
    maxRetries: 1, sandboxEnabled: true, gitEnabled: true, branchWorkflow: true,
  });
  await orchestrator.loadAgents();
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
  closeBus();
});

function makeNode(id: string, extra: Partial<TaskNode> = {}): TaskNode {
  return {
    id, task_id: 't-acc', name: '实现节点', status: 'pending', agent: 'dev', result: null, error: '',
    retry_count: 0, complexity: 'normal', requires_approval: false, needs_human: false,
    created_at: '', updated_at: '', ...extra,
  };
}

async function saveWithPolicy(taskId: string, policy: 'strict' | 'tolerant' | undefined): Promise<void> {
  await saveTaskGraph(taskId, [makeNode('d1')], [], { description: 'x', workspace: tmp, status: 'planned' });
  if (policy) {
    const g = (await getTaskGraph(taskId)) as TaskGraph;
    g.acceptance_policy = policy;
    await persistGraph(g);
  }
}

describe('B1 验收软门', () => {
  it('policy 缺省（tolerant）→ 验收失败不判死，completed_with_warnings + 验收报告留证', async () => {
    // 内容级假完成守卫（jgfhfaux 复盘）后：真实交付走结构化 files 落盘，
    // 只申报不写盘的 changes 会被判假完成——本用例验证的是验收软门，不是交付守卫
    agentBehaviors.push(() => ({ content: JSON.stringify({ status: 'success', summary: '完成', verification: 'feat.txt 已写', files: [{ path: 'feat.txt', content: 'x' }], changes: ['feat.txt: ok'], errors: [] }) }));
    await saveWithPolicy('t-acc1', undefined);
    const result = await (orchestrator as any).execute('t-acc1', tmp);
    expect(result.status).toBe('completed_with_warnings');
    const g = (await getTaskGraph('t-acc1')) as TaskGraph;
    expect(g.status).toBe('completed_with_warnings');
    expect((result.acceptance as any).status).toBe('failed');
  });

  it('policy=strict → 保持硬失败语义', async () => {
    // 内容级假完成守卫（jgfhfaux 复盘）后：真实交付走结构化 files 落盘，
    // 只申报不写盘的 changes 会被判假完成——本用例验证的是验收软门，不是交付守卫
    agentBehaviors.push(() => ({ content: JSON.stringify({ status: 'success', summary: '完成', verification: 'feat.txt 已写', files: [{ path: 'feat.txt', content: 'x' }], changes: ['feat.txt: ok'], errors: [] }) }));
    await saveWithPolicy('t-acc2', 'strict');
    const result = await (orchestrator as any).execute('t-acc2', tmp);
    expect(result.status).toBe('failed');
    const g = (await getTaskGraph('t-acc2')) as TaskGraph;
    expect(g.status).toBe('failed');
  });
});
