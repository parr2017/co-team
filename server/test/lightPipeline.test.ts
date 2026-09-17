import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { simpleGit } from 'simple-git';

/**
 * P3 档级驱动执行管线：light 档真正轻——跳过 worktree 沙箱与分支舞步（git 任务分支提交兜底）、
 * 仅构建冒烟、不写知识库复盘、不写全局记忆、跳过澄清、强制静态规划。
 * standard/heavy 行为不变（LEVEL_PROFILES 执行字段断言）。
 */
const agentBehaviors: (() => { content: string })[] = [];
const chatSysCalls: string[] = [];

vi.mock('../src/llm', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/llm')>();
  return {
    ...actual,
    chat: async (_entry: any, messages: { role: string; content: string }[]) => {
      const sys = messages.find((m) => m.role === 'system')?.content || '';
      chatSysCalls.push(sys);
      // 规划器调用返回静态 1 节点整图；其余（节点 agent 调用）返回成功申报 base.txt
      if (sys.includes('task planner')) {
        return { content: JSON.stringify({ nodes: [{ id: 'n1', name: '改错别字', agent: 'dev', complexity: 'simple', goal_link: '完成' }], edges: [], summary: 'plan' }), promptTokens: 3, completionTokens: 4 };
      }
      return { content: JSON.stringify({ status: 'success', summary: '完成', verification: '已核对', changes: ['base.txt'], errors: [] }), promptTokens: 3, completionTokens: 4 };
    },
  };
});

import { initBus, closeBus } from '../src/bus';
import { Orchestrator } from '../src/orchestrator/orchestrator';
import { ModelPool } from '../src/scheduler';
import { saveTaskGraph, getTaskGraph } from '../src/store';
import { LEVEL_PROFILES } from '../src/grader';
import { runPostMergeAcceptance } from '../src/orchestrator/acceptance';
import { listKnowledge } from '../src/knowledge';
import type { TaskNode } from '../src/types';

let tmp: string;
let orchestrator: Orchestrator;

const successWith = (changes: string[], extra: Record<string, unknown> = {}) => ({
  content: JSON.stringify({ status: 'success', summary: '完成', verification: '已核对', changes, errors: [], ...extra }),
});

beforeEach(async () => {
  process.env.COTEAM_FORCE_MEMORY = '1';
  closeBus();
  chatSysCalls.length = 0;
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-light-'));
  const g = simpleGit({ baseDir: tmp });
  await g.init();
  await g.addConfig('user.name', 't');
  await g.addConfig('user.email', 't@t');
  fs.writeFileSync(path.join(tmp, 'base.txt'), 'v1\n');
  await g.add('-A');
  await g.commit('init');
  const devDir = path.join(tmp, 'dev');
  fs.mkdirSync(devDir, { recursive: true });
  fs.writeFileSync(path.join(devDir, 'agent.yaml'), 'name: dev\ntags: [code]\nrole: 开发\n');
  await g.add('-A');
  await g.commit('init + agents');
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

function makeNode(id: string, name: string, extra: Partial<TaskNode> = {}): TaskNode {
  return {
    id, task_id: 't', name, status: 'pending', agent: 'dev', result: null, error: '',
    retry_count: 0, complexity: 'normal', requires_approval: false, needs_human: false,
    created_at: '', updated_at: '',
    ...extra,
  } as TaskNode;
}

describe('P3-9 档级执行配置', () => {
  it('light 档裁剪仪式保留安全：无沙箱/冒烟/无最终闸/强制静态/简交付/无知识/无记忆', () => {
    const l = LEVEL_PROFILES.light;
    expect(l.sandbox).toBe(false);
    expect(l.acceptance).toBe('smoke');
    expect(l.finalGate).toBe(false);
    expect(l.rolling).toBe(false);
    expect(l.briefDeliverable).toBe(true);
    expect(l.knowledge).toBe(false);
    expect(l.memory).toBe(false);
    // standard/heavy 行为不变
    for (const lv of ['standard', 'heavy'] as const) {
      expect(LEVEL_PROFILES[lv].sandbox).toBe(true);
      expect(LEVEL_PROFILES[lv].acceptance).toBe('full');
      expect(LEVEL_PROFILES[lv].finalGate).toBe(true);
      expect(LEVEL_PROFILES[lv].knowledge).toBe(true);
      expect(LEVEL_PROFILES[lv].memory).toBe(true);
    }
  });
});

describe('P3-10 验收冒烟深度', () => {
  it('smoke 走 build 命令不走测试套件；无 build 命令放行', async () => {
    const ws1 = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-smoke-'));
    fs.writeFileSync(path.join(ws1, 'package.json'), JSON.stringify({ scripts: { build: 'echo build-ok', test: 'node -e "process.exit(1)"' } }));
    const r1 = await runPostMergeAcceptance(ws1, 30, 'smoke');
    expect(r1.status).toBe('passed');
    expect(r1.command).toBe('npm run build');
    const f1 = await runPostMergeAcceptance(ws1, 30, 'full');
    expect(f1.status).toBe('failed'); // full 深度仍跑测试套件（exit 1）
    const r2 = await runPostMergeAcceptance(ws1, 30);
    expect(r2.status).toBe('failed'); // 缺省深度 = full
    fs.rmSync(ws1, { recursive: true, force: true });

    const ws2 = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-smoke2-'));
    fs.writeFileSync(path.join(ws2, 'package.json'), JSON.stringify({ scripts: { test: 'node -e "process.exit(0)"' } }));
    const r3 = await runPostMergeAcceptance(ws2, 30, 'smoke');
    expect(r3.status).toBe('no-test-command'); // 无 build 命令 → 冒烟放行
    fs.rmSync(ws2, { recursive: true, force: true });
  });
});

describe('P3-11 light 档执行链', () => {
  it('light 任务：跳过澄清 + 不建沙箱 + 不跳分支舞步 + 不写知识库复盘', async () => {
    const { taskId } = await (orchestrator as any).createTask('改一下 base.txt 的错别字 typo', tmp, undefined, { level: 'light' });
    // 轻量描述不触发澄清（clarify 评估器从未被调用）
    expect(chatSysCalls.some((s) => s.includes('需求澄清评估器'))).toBe(false);
    const graph = (await getTaskGraph(taskId))!;
    expect(graph.level).toBe('light');
    expect(graph.rolling ?? false).toBe(false); // 强制静态
    // 沙箱开启（sandboxEnabled: true）但 light 档不建 worktree：sandbox_path === workspace
    await (orchestrator as any).execute(taskId, tmp);
    const after = (await getTaskGraph(taskId))!;
    expect(after.status).toBe('success');
    expect(after.sandbox_path).toBe(tmp);
    // 每节点分支舞步未发生：没有 coteam/<node>-<agent> 形态的节点分支；
    // coteam/task-* 交付分支保留（git 任务分支提交兜底，设计内）
    const branches = await simpleGit({ baseDir: tmp }).branchLocal();
    expect(branches.all.filter((b) => /^coteam\/.+-dev$/.test(b))).toEqual([]);
    // 轻量任务不写知识库复盘（共享测试 KB，按任务唯一 source 精确过滤）
    const kb = listKnowledge({}).filter((e) => e.source === `task:${taskId}`);
    expect(kb.length).toBe(0);
  }, 30_000);
});
