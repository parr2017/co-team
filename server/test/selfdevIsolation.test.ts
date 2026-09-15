import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { simpleGit } from 'simple-git';

/**
 * Phase 0 回归（2026-09-16）：自指任务的 execute() 必须全程落在隔离克隆上。
 * 此前 createSandbox 已改用 execWorkspace，但 execute_start 事件、task-start/end 快照、
 * 部分恢复脏检查（simpleGit baseDir）、finalAcceptanceGate 机审仍传原始 workspace——
 * 自指任务的验收会在 co-team 主仓库上跑。本文件把这些"落点"全部钉在克隆路径上。
 */
const cloneCalls: { taskId: string; selfdevRoot: string; sourceRepo: string }[] = [];

vi.mock('../src/workspace', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/workspace')>();
  return {
    ...actual,
    // 替换真实克隆（避免测试里整仓 clone co-team）：改为克隆小型 fixture 仓库，
    // 但保留 taskId/selfdevRoot 语义并记录 sourceRepo 入参供断言
    prepareSelfdevClone: async (taskId: string, selfdevRoot: string, sourceRepo: string): Promise<string> => {
      cloneCalls.push({ taskId, selfdevRoot, sourceRepo });
      const target = path.join(path.resolve(selfdevRoot), taskId);
      if (fs.existsSync(path.join(target, '.git'))) return target;
      await simpleGit().clone(cloneFixtureRepo!, target, ['--no-hardlinks', '--quiet']);
      return target;
    },
  };
});

vi.mock('../src/llm', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/llm')>();
  return {
    ...actual,
    chat: async (_entry: any, messages: { role: string; content: string }[]) => {
      const sys = String(messages[0]?.content || '');
      if (sys.includes('task planner')) {
        return { content: JSON.stringify({ nodes: [], edges: [], summary: 'unused' }), promptTokens: 2, completionTokens: 3 };
      }
      return { content: JSON.stringify({ status: 'success', summary: '骨架完成', verification: 'ls 通过', changes: ['hello.txt: 新增'], errors: [] }), promptTokens: 3, completionTokens: 4 };
    },
  };
});

import { initBus, closeBus } from '../src/bus';
import { listSnapshots } from '../src/snapshot';
import { Orchestrator } from '../src/orchestrator/orchestrator';
import { ModelPool } from '../src/scheduler';
import { saveTaskGraph, getTaskGraph, getTaskEvents } from '../src/store';
import type { TaskNode } from '../src/types';

let tmp: string;
let cloneFixtureRepo: string | null = null;
let originalWorkspace: string;

beforeEach(async () => {
  process.env.COTEAM_FORCE_MEMORY = '1';
  closeBus();
  cloneCalls.length = 0;
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-selfdev-'));
  // fixture "co-team 主仓库"：一个小 git 仓库替代 PROJECT_ROOT 作为克隆源
  cloneFixtureRepo = path.join(tmp, 'fake-coteam');
  fs.mkdirSync(cloneFixtureRepo, { recursive: true });
  const g = simpleGit({ baseDir: cloneFixtureRepo });
  await g.init();
  await g.addConfig('user.name', 't');
  await g.addConfig('user.email', 't@t');
  fs.writeFileSync(path.join(cloneFixtureRepo, 'README.md'), '# fake co-team\n');
  // 自修改门禁会在目标仓库跑 npm test——给 fixture 一个可直接通过的测试脚本
  fs.writeFileSync(path.join(cloneFixtureRepo, 'package.json'), JSON.stringify({ name: 'fake-coteam', scripts: { test: 'node -e "process.exit(0)"' } }));
  await g.add('-A');
  await g.commit('chore: init');

  // "用户传入的原始工作区"（假想的自指目标——在本测试里它就是不该被触碰的仓库）
  originalWorkspace = path.join(tmp, 'user-workspace');
  fs.mkdirSync(originalWorkspace, { recursive: true });
  fs.writeFileSync(path.join(originalWorkspace, 'user-file.txt'), 'user data\n');

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
    id, task_id: 't-sd', name: id, status: 'pending', agent, result: null, error: '',
    retry_count: 0, complexity: 'normal', requires_approval: false, needs_human: false,
    created_at: '', updated_at: '',
  };
}

describe('自指任务隔离（execute 全程落在克隆上）', () => {
  it('self_ref 任务：克隆/事件/快照/验收全部指向 selfdev 克隆，原始工作区零触碰', async () => {
    const pool = new ModelPool([{ name: 'fake-model', api_key: 'k', base_url: 'http://localhost:9', tags: ['code'] }]);
    const orch = new Orchestrator({
      agentsDir: tmp, modelPool: pool, policy: { whitelistCommands: null, maxTimeSec: 10 },
      maxRetries: 1, sandboxEnabled: false, gitEnabled: false, branchWorkflow: false,
      projects: { root: tmp, selfdev_root: path.join(tmp, 'selfdev') },
    });
    await orch.loadAgents();

    await saveTaskGraph('t-sd', [makeNode('m', 'orchestrator'), makeNode('d1', 'dev')], [['m', 'd1']], {
      description: '用 co-team 开发 co-team（自指）',
      workspace: originalWorkspace,
      status: 'planned',
      self_ref: true,
    });

    const result = await (orch as any).execute('t-sd', originalWorkspace);
    expect(result.status).toBe('success');

    // 1) 克隆已创建且落在 selfdev_root/<taskId>
    expect(cloneCalls.length).toBe(1);
    expect(cloneCalls[0].taskId).toBe('t-sd');
    const clone = path.join(tmp, 'selfdev', 't-sd');
    expect(fs.existsSync(path.join(clone, '.git'))).toBe(true);

    // 2) 图上的工作区字段指向克隆
    const graph = await getTaskGraph('t-sd');
    expect(graph!.selfdev_path).toBe(clone);
    expect(graph!.workspace).toBe(clone);

    // 3) execute_start 事件与快照记录的都是克隆路径（此前传原始 workspace 的回归点）
    const events = await getTaskEvents('t-sd');
    const startEv = events.find((e) => e.type === 'execute_start');
    expect(startEv).toBeTruthy();
    expect(startEv!.payload.workspace).toBe(clone);
    const snaps = await listSnapshots({ task_id: 't-sd' });
    const taskSnaps = snaps.filter((s) => s.tag === 'task-start' || s.tag === 'task-end');
    expect(taskSnaps.length).toBeGreaterThanOrEqual(2);
    for (const s of taskSnaps) expect(s.workspace).toBe(clone);

    // 4) 原始工作区零触碰：文件集合不变
    expect(fs.readdirSync(originalWorkspace).sort()).toEqual(['user-file.txt']);
  });
});
