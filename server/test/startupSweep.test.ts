import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

vi.mock('../src/llm', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/llm')>();
  void actual;
  return {
    chat: async () => ({
      content: JSON.stringify({ clear: true, missing: [], questions: [] }),
      promptTokens: 2,
      completionTokens: 3,
    }),
    extractJson: actual.extractJson,
    stripCodeFence: actual.stripCodeFence,
  };
});

import { initBus, closeBus } from '../src/bus';
import { Orchestrator } from '../src/orchestrator/orchestrator';
import { saveTaskGraph, getTaskGraph, getTaskJournals } from '../src/store';
import type { TaskNode } from '../src/types';

let tmp: string;
let orchestrator: Orchestrator;

beforeEach(async () => {
  process.env.COTEAM_FORCE_MEMORY = '1';
  closeBus();
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-sweep-'));
  const devDir = path.join(tmp, 'dev');
  fs.mkdirSync(devDir, { recursive: true });
  fs.writeFileSync(path.join(devDir, 'agent.yaml'), 'name: dev\ntags: [code]\n');
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

function makeNode(id: string, status: TaskNode['status']): TaskNode {
  return {
    id, task_id: 't', name: id, status, agent: 'dev', result: null, error: '',
    retry_count: 0, complexity: 'normal', requires_approval: false, needs_human: false,
    created_at: '', updated_at: '',
  };
}

describe('startup sweep 重做（2026-09-15 永续开发语义）', () => {
  it('running 任务：在途节点标 interrupted、任务标 interrupted 并进入自动续跑清单', async () => {
    await saveTaskGraph(
      't-zombie',
      [makeNode('n1', 'completed'), makeNode('n2', 'running'), makeNode('n3', 'retrying'), makeNode('n4', 'pending')],
      [],
      { description: 'x', workspace: tmp, status: 'running' }
    );
    await saveTaskGraph('t-ok', [makeNode('n1', 'completed')], [], { description: 'y', workspace: tmp, status: 'success' });
    await saveTaskGraph('t-approve', [makeNode('n1', 'waiting_approval')], [], { description: 'z', workspace: tmp, status: 'running' });

    const swept = await orchestrator.sweepInterruptedTasks();

    expect(swept.resume.sort()).toEqual(['t-approve', 't-zombie']);
    expect(swept.queued).toEqual([]);
    expect(swept.planning).toEqual([]);

    const zombie = await getTaskGraph('t-zombie');
    expect(zombie!.status).toBe('interrupted');
    expect(zombie!.infra_retries).toBe(1);
    expect(zombie!.nodes.find((n) => n.id === 'n1')!.status).toBe('completed');
    expect(zombie!.nodes.find((n) => n.id === 'n2')!.status).toBe('interrupted');
    expect(zombie!.nodes.find((n) => n.id === 'n3')!.status).toBe('interrupted');
    expect(zombie!.nodes.find((n) => n.id === 'n4')!.status).toBe('pending');

    const approved = await getTaskGraph('t-approve');
    expect(approved!.status).toBe('interrupted');
    expect(approved!.nodes[0].status).toBe('interrupted');

    const healthy = await getTaskGraph('t-ok');
    expect(healthy!.status).toBe('success');

    const journals = JSON.stringify(await getTaskJournals('t-zombie'));
    expect(journals).toContain('服务重启');
    expect(journals).toContain('自动续跑');
  });

  it('terminal 状态任务不被清扫', async () => {
    await saveTaskGraph('t-done', [makeNode('n1', 'completed')], [], { description: 'x', workspace: tmp, status: 'success' });
    await saveTaskGraph('t-fail', [makeNode('n1', 'failed')], [], { description: 'y', workspace: tmp, status: 'failed' });
    const swept = await orchestrator.sweepInterruptedTasks();
    expect(swept).toEqual({ resume: [], queued: [], planning: [] });
  });

  it('queued 孤儿（重启丢车道）进入重新排队清单', async () => {
    await saveTaskGraph('t-orphan', [makeNode('n1', 'pending')], [], { description: 'q', workspace: tmp, status: 'queued' });
    const swept = await orchestrator.sweepInterruptedTasks();
    expect(swept.queued).toEqual(['t-orphan']);
    expect((await getTaskGraph('t-orphan'))!.status).toBe('queued'); // 状态不动，由 index.ts 重新 enqueue
  });

  it('planAsync 规划孤儿（pending 且无节点）进入重新规划清单', async () => {
    await saveTaskGraph('t-planless', [], [], { description: 'p', workspace: tmp, status: 'pending' });
    const swept = await orchestrator.sweepInterruptedTasks();
    expect(swept.planning).toEqual(['t-planless']);
  });

  it('finalizing 任务同样按中断处理（收尾阶段被重启打断）', async () => {
    await saveTaskGraph('t-fin', [makeNode('n1', 'completed'), makeNode('n2', 'running')], [], { description: 'f', workspace: tmp, status: 'finalizing' });
    const swept = await orchestrator.sweepInterruptedTasks();
    expect(swept.resume).toEqual(['t-fin']);
    expect((await getTaskGraph('t-fin'))!.status).toBe('interrupted');
  });

  it('反复中断达上限（infra_retries>3）：停靠人工 failed，不再自动续跑', async () => {
    await saveTaskGraph('t-looper', [makeNode('n1', 'running')], [], { description: 'l', workspace: tmp, status: 'running', });
    const g = await getTaskGraph('t-looper');
    g!.infra_retries = 3;
    await saveTaskGraph('t-looper', g!.nodes, g!.edges, { description: 'l', workspace: tmp, status: 'running' });
    // saveTaskGraph 的 meta 不含 infra_retries——直接改存量图
    const fresh = await getTaskGraph('t-looper');
    fresh!.infra_retries = 3;
    await persistForTest(fresh!);

    const swept = await orchestrator.sweepInterruptedTasks();
    expect(swept.resume).toEqual([]);
    const parked = await getTaskGraph('t-looper');
    expect(parked!.status).toBe('failed');
    expect(parked!.infra_retries).toBe(4);
    const journals = JSON.stringify(await getTaskJournals('t-looper'));
    expect(journals).toContain('停止自动续跑');
  });

  it('优雅重启标记：不消耗 infra_retries，照常自动续跑（2026-09-27 开发期反复 Ctrl+C 不再误停）', async () => {
    const leaderDir = path.join(tmp, 'leader-data');
    process.env.COTEAM_LEADER_DIR = leaderDir;
    try {
      const { writeGracefulShutdownMarker } = await import('../src/leaderLock');
      writeGracefulShutdownMarker();
      await saveTaskGraph('t-graceful', [makeNode('n1', 'completed'), makeNode('n2', 'running')], [], { description: 'g', workspace: tmp, status: 'running' });

      const swept = await orchestrator.sweepInterruptedTasks();
      expect(swept.resume).toContain('t-graceful');
      const g = await getTaskGraph('t-graceful');
      expect(g!.status).toBe('interrupted');
      expect(g!.infra_retries).toBeUndefined(); // 优雅重启不计数
      const journals = JSON.stringify(await getTaskJournals('t-graceful'));
      expect(journals).toContain('优雅重启');
      expect(fs.existsSync(path.join(leaderDir, 'graceful-shutdown.json'))).toBe(false); // 读后即删
    } finally {
      delete process.env.COTEAM_LEADER_DIR;
    }
  });

  it('重启抢救：上一进程沙箱内已完成节点的成果拉回工作区（裸拷贝路径）', async () => {
    const ws = path.join(tmp, 'ws-salvage');
    fs.mkdirSync(ws, { recursive: true });
    const sandboxDir = path.join(tmp, 'sbx-dead');
    fs.mkdirSync(sandboxDir, { recursive: true });
    fs.writeFileSync(path.join(sandboxDir, 'artifacts.txt'), 'precious');
    await saveTaskGraph('t-salvage', [makeNode('n1', 'completed'), makeNode('n2', 'running')], [], { description: 's', workspace: ws, status: 'running' });
    const g = (await getTaskGraph('t-salvage'))!;
    g.sandbox_path = sandboxDir;
    await persistForTest(g);

    const swept = await orchestrator.sweepInterruptedTasks();
    expect(swept.resume).toContain('t-salvage');
    expect(fs.existsSync(path.join(ws, 'artifacts.txt'))).toBe(true); // 成果落工作区
    expect(fs.existsSync(sandboxDir)).toBe(false); // 抢救后沙箱清理
    const fresh = await getTaskGraph('t-salvage');
    expect(fresh!.sandbox_path).toBeFalsy(); // 路径清空
    const journals = JSON.stringify(await getTaskJournals('t-salvage'));
    expect(journals).toContain('服务重启抢救');
  }, 30_000);

  it('重启抢救（git 兜底沙箱）：合并节点分支 → 同步工作区（保留为脏改动并入下次基线）', async () => {
    const { simpleGit } = await import('simple-git');
    const { ensureBase, createNodeBranch, commitOnBranch } = await import('../src/git');
    const ws = path.join(tmp, 'ws-git-salvage');
    fs.mkdirSync(ws, { recursive: true });
    const gw = simpleGit({ baseDir: ws });
    await gw.init();
    await gw.addConfig('user.name', 't');
    await gw.addConfig('user.email', 't@t');
    fs.writeFileSync(path.join(ws, 'base.txt'), 'v1');
    await gw.add(['-A']);
    await gw.commit('init');

    // 独立 .git 的兜底沙箱：基线 + 节点分支 + 已提交产物
    const sbx = path.join(tmp, 'sbx-git');
    fs.mkdirSync(sbx, { recursive: true });
    await ensureBase(sbx);
    await createNodeBranch(sbx, 'coteam/n1-dev', 'coteam/base');
    fs.writeFileSync(path.join(sbx, 'g-artifact.txt'), 'git-salvaged');
    expect(await commitOnBranch(sbx, 'node work', ['g-artifact.txt'])).not.toBeNull();

    const node = makeNode('n1', 'completed');
    node.branch = 'coteam/n1-dev';
    node.branch_base = 'coteam/base';
    await saveTaskGraph('t-gsalv', [node, makeNode('n2', 'running')], [], { description: 's', workspace: ws, status: 'running' });
    const g = (await getTaskGraph('t-gsalv'))!;
    g.sandbox_path = sbx;
    await persistForTest(g);

    const orch2 = new Orchestrator({
      agentsDir: tmp, modelPool: null, policy: { whitelistCommands: null, maxTimeSec: 10 },
      maxRetries: 2, sandboxEnabled: true, gitEnabled: true, branchWorkflow: true,
    });
    await orch2.loadAgents();
    const swept = await orch2.sweepInterruptedTasks();
    expect(swept.resume).toContain('t-gsalv');
    // 成果保留为工作区未提交改动（commit=false：gitCommit 回切会抹掉工作树文件，
    // 而续跑基线舞步只认脏改动——提交反而会被 branch -D 清掉）
    expect(fs.existsSync(path.join(ws, 'g-artifact.txt'))).toBe(true);
    const statusAfter = await simpleGit({ baseDir: ws }).status();
    expect(statusAfter.files.map((f) => f.path)).toContain('g-artifact.txt');
    expect(fs.existsSync(sbx)).toBe(false); // 抢救后沙箱清理
    const journals = JSON.stringify(await getTaskJournals('t-gsalv'));
    expect(journals).toContain('服务重启抢救');
  }, 30_000);

  async function persistForTest(graph: NonNullable<Awaited<ReturnType<typeof getTaskGraph>>>) {
    const { persistGraph } = await import('../src/store');
    await persistGraph(graph);
  }
});
