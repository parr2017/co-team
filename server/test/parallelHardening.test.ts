import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { closeBus, initBus } from '../src/bus';
import { Orchestrator } from '../src/orchestrator/orchestrator';
import { TaskQueueManager } from '../src/taskQueue';
import { executeCommandAsync } from '../src/sandbox';
import { writeKnowledge, listKnowledge } from '../src/knowledge';
import { saveTaskGraph, getTaskGraph } from '../src/store';
import type { AgentResult, TaskNode } from '../src/types';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let tmp: string;

beforeEach(async () => {
  process.env.COTEAM_FORCE_MEMORY = '1';
  closeBus();
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-par-'));
  const devDir = path.join(tmp, 'dev');
  fs.mkdirSync(devDir, { recursive: true });
  fs.writeFileSync(path.join(devDir, 'agent.yaml'), 'name: dev\ntags: [code]\nrole: 开发\n');
  await initBus({ host: '127.0.0.1', port: 6399, db: 0 });
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
  closeBus();
});

function makeNode(id: string, agent: string): TaskNode {
  return {
    id, task_id: 't', name: id, status: 'pending', agent, result: null, error: '',
    retry_count: 0, complexity: 'normal', requires_approval: false, needs_human: false,
    created_at: '', updated_at: '',
  };
}

function ok(): AgentResult {
  return { status: 'success', changes: [], summary: 'done', errors: [] };
}

describe('并行加固 Phase 2', () => {
  it('模型池公平分配：activeTaskCount=2 时 4 槽位任务的节点并发 ≤2（单任务 4 槽不变）', async () => {
    const runWith = (activeTasks: number, injected: boolean) => new Promise<number>(async (resolve) => {
      let active = 0;
      let maxActive = 0;
      const o = new Orchestrator({
        agentsDir: tmp,
        modelPool: { totalAvailable: () => 4 } as any,
        policy: { whitelistCommands: null, maxTimeSec: 10 },
        maxRetries: 2, sandboxEnabled: false, gitEnabled: false,
      });
      await o.loadAgents();
      if (injected) o.setActiveTaskCount(() => activeTasks);
      (o as any).dispatch = async (_taskId: string, _node: TaskNode): Promise<AgentResult> => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await sleep(15);
        active -= 1;
        return ok();
      };
      const nodes = [makeNode('a', 'dev'), makeNode('b', 'dev'), makeNode('c', 'dev'), makeNode('d', 'dev')];
      await saveTaskGraph(`t-fair-${activeTasks}-${injected}`, nodes, [], { description: 'x', workspace: tmp });
      await (o as any).runGraph(`t-fair-${activeTasks}-${injected}`, (await getTaskGraph(`t-fair-${activeTasks}-${injected}`))!, tmp);
      resolve(maxActive);
    });

    // 注入 activeTaskCount=2：floor(4/2)=2 个槽位
    expect(await runWith(2, true)).toBeLessThanOrEqual(2);
    // 单任务（activeTaskCount=1）：floor(4/1)=4，行为与改造前一致
    expect(await runWith(1, true)).toBe(4);
    // 未注入探针（老装配）：行为不变
    expect(await runWith(1, false)).toBe(4);
  }, 20_000);

  it('taskQueue.activeTaskCount 统计执行中任务（含人工门持槽）', async () => {
    const resolvers = new Map<string, (r: { status: string }) => void>();
    const executor = {
      execute: (taskId: string) => new Promise<{ status: string }>((r) => resolvers.set(taskId, r)),
    };
    const probe = { usableCapacity: () => 10 };
    const mgr = new TaskQueueManager(executor, probe, 3);
    await saveTaskGraph('qa', [makeNode('n1', 'dev')], [], { description: 'x', workspace: tmp, status: 'planned' });
    await saveTaskGraph('qb', [makeNode('n1', 'dev')], [], { description: 'x', workspace: path.join(tmp, 'b'), status: 'planned' });

    expect(mgr.activeTaskCount()).toBe(0);
    await mgr.enqueue('qa', null, tmp);
    expect(mgr.activeTaskCount()).toBe(1); // qa 在跑
    await mgr.enqueue('qb', null, path.join(tmp, 'b'));
    expect(mgr.activeTaskCount()).toBe(2); // 不同工作区并行，双双活跃
    resolvers.get('qa')!({ status: 'success' });
    await sleep(20);
    expect(mgr.activeTaskCount()).toBe(1); // qa 收场后只剩 qb
    resolvers.get('qb')!({ status: 'success' });
    await sleep(20);
    expect(mgr.activeTaskCount()).toBe(0);
  });

  it('异步命令输出滚动截尾：2MB stdout 收敛到尾部 1MB 内', async () => {
    const res = await executeCommandAsync(
      'node -e "console.log(\'x\'.repeat(2000000))"',
      tmp,
      { level: 'full', whitelistCommands: null, maxTimeSec: 30 }
    );
    expect(res.allowed).toBe(true);
    expect(res.returncode).toBe(0);
    expect(res.stdout.length).toBeLessThanOrEqual(1_000_000 + 100);
    expect(res.stdout.trim().endsWith('x')).toBe(true); // 保留的是尾部
  }, 30_000);

  it('知识库 mtime 缓存：读取走缓存，写入显式失效（更新立即可见）', async () => {
    const root = path.join(tmp, 'kb');
    writeKnowledge({ title: '缓存条目', content: '第一版内容', category: 'general-tech' }, root);
    expect(listKnowledge({}, root)[0].content).toBe('第一版内容');

    // 同标题再写 = 更新路径：必须立刻可读（写点显式失效）
    writeKnowledge({ title: '缓存条目', content: '第二版内容', category: 'general-tech' }, root);
    expect(listKnowledge({}, root)[0].content).toBe('第二版内容');

    // 外部直接改文件（mtime 变化）：下次读取看到新内容
    const file = path.join(root, 'general-tech', listKnowledge({}, root)[0].id + '.md');
    const orig = fs.readFileSync(file, 'utf-8');
    fs.writeFileSync(file, orig.replace('第二版内容', '外部篡改内容'), 'utf-8');
    expect(listKnowledge({}, root)[0].content).toBe('外部篡改内容');
  });
});
