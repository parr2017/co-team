import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// planner 与 agent 共用 chat 打桩：按 system 提示词路由到不同行为队列
const plannerBehaviors: (() => { content: string })[] = [];
const agentBehaviors: (() => { content: string })[] = [];
const okAgent = () => ({
  content: JSON.stringify({ status: 'success', summary: '骨架已完成', verification: 'npm test 通过', changes: ['a.txt: ok'], errors: [] }),
});

vi.mock('../src/llm', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/llm')>();
  return {
    ...actual,
    chat: async (_entry: any, messages: { role: string; content: string }[]) => {
      const sys = String(messages[0]?.content || '');
      if (sys.includes('task planner')) {
        const b = plannerBehaviors.shift();
        const r = b ? b() : { content: '{"nodes":[],"edges":[],"summary":"none"}' };
        return { content: r.content, promptTokens: 3, completionTokens: 4 };
      }
      const b = agentBehaviors.shift();
      const r = b ? b() : okAgent();
      return { content: r.content, promptTokens: 3, completionTokens: 4 };
    },
  };
});

import { initBus, closeBus } from '../src/bus';
import { ModelPool } from '../src/scheduler';
import { Orchestrator } from '../src/orchestrator/orchestrator';
import { saveTaskGraph, getTaskGraph } from '../src/store';
import type { TaskNode } from '../src/types';

let tmp: string;
let orchestrator: Orchestrator;

beforeEach(async () => {
  process.env.COTEAM_FORCE_MEMORY = '1';
  closeBus();
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-roll-'));
  const devDir = path.join(tmp, 'dev');
  fs.mkdirSync(devDir, { recursive: true });
  fs.writeFileSync(path.join(devDir, 'agent.yaml'), 'name: dev\ntags: [code]\nrole: 开发\n');
  await initBus({ host: '127.0.0.1', port: 6399, db: 0 });
  plannerBehaviors.length = 0;
  agentBehaviors.length = 0;
  const pool = new ModelPool([{ name: 'fake-model', api_key: 'k', base_url: 'http://localhost:9', tags: ['code'] }]);
  orchestrator = new Orchestrator({
    agentsDir: tmp, modelPool: pool, policy: { whitelistCommands: null, maxTimeSec: 10 },
    maxRetries: 1, sandboxEnabled: false, gitEnabled: false, branchWorkflow: false,
    planningMode: 'rolling',
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

function stage1Planner() {
  return () => ({
    content: JSON.stringify({
      done: false,
      stage_goal: '可运行最小骨架',
      summary: '先出骨架',
      nodes: [
        { id: 'm', name: 'Main Task', agent: 'orchestrator', complexity: 'simple', reason: '任务基线' },
        { id: 'd1', name: '开发骨架', agent: 'dev', complexity: 'normal', reason: '实现', required_skills: ['code'] },
      ],
      edges: [['m', 'd1']],
      checklist: [{ requirement: '端到端可用且测试通过', evidence_type: 'command', target_platform: 'web' }],
    }),
  });
}

describe('M4 滚动规划', () => {
  it('阶段1 执行后 replanner 声明完成且清单全达成 → success', async () => {
    plannerBehaviors.push(stage1Planner());
    await (orchestrator as any).planAndSave('t-r1', '做一个记账应用', tmp, undefined, { level: 'standard' });
    let graph = await getTaskGraph('t-r1');
    expect(graph!.rolling).toBe(true);
    expect(graph!.stage_count).toBe(1);
    expect(graph!.checklist!.length).toBe(1);
    expect(graph!.checklist![0].status).toBe('open');

    // replanner：声明完成，清单全达成
    plannerBehaviors.push(() => ({
      content: JSON.stringify({
        done: true,
        assessment: '目标已达成',
        checklist_results: [{ id: '1-1', done: true, evidence: 'npm test 全绿且页面渲染验证通过' }],
      }),
    }));
    const result = await (orchestrator as any).execute('t-r1', tmp);
    expect(result.status).toBe('success');
    graph = await getTaskGraph('t-r1');
    expect(graph!.status).toBe('success');
    expect(graph!.checklist![0].status).toBe('done');
    expect(graph!.checklist![0].evidence).toContain('npm test');
    expect(graph!.stage_history!.length).toBe(1);
  });

  it('replanner 返回下一阶段子图：节点追加（s2- 前缀）、挂接上一阶段合并节点、继续执行', async () => {
    // 机审可过的测试命令（M5 最终闸会跑 unit 清单项）
    fs.writeFileSync(path.join(tmp, 'package.json'), JSON.stringify({ name: 'x', scripts: { test: 'node -e "process.exit(0)"' } }));
    plannerBehaviors.push(stage1Planner());
    await (orchestrator as any).planAndSave('t-r2', '做一个记账应用', tmp, undefined, { level: 'standard' });
    // 阶段2 计划：追加 2 个节点
    plannerBehaviors.push(() => ({
      content: JSON.stringify({
        done: false,
        stage_goal: '补齐统计功能',
        summary: '统计与导出',
        nodes: [
          { id: 'a', name: '统计接口', agent: 'dev', complexity: 'normal', reason: '实现统计' },
          { id: 'b', name: '统计页面', agent: 'dev', complexity: 'normal', reason: '前端展示' },
        ],
        edges: [['a', 'b']],
        checklist: [{ requirement: '统计口径正确', evidence_type: 'unit' }],
      }),
    }));
    // 阶段3 裁定：完成
    plannerBehaviors.push(() => ({
      content: JSON.stringify({
        done: true,
        checklist_results: [
          { id: '1-1', done: true, evidence: '测试通过' },
          { id: '2-1', done: true, evidence: '统计单测通过' },
        ],
      }),
    }));
    const result = await (orchestrator as any).execute('t-r2', tmp);
    expect(result.status).toBe('success');
    const graph = await getTaskGraph('t-r2');
    expect(graph!.stage_count).toBe(2);
    const ids = graph!.nodes.map((n) => n.id);
    expect(ids).toContain('s2-a');
    expect(ids).toContain('s2-b');
    expect(ids).toContain('merge-s2');
    // 阶段2 根节点挂到上一阶段合并节点 merge-auto 之后
    expect(graph!.edges).toContainEqual(['merge-auto', 's2-a']);
    // 清单含两阶段条目且全部达成
    expect(graph!.checklist!.length).toBe(2);
    expect(graph!.checklist!.every((c: any) => c.status === 'done')).toBe(true);
    // 完整滚动执行了两个阶段
    expect(graph!.stage_history!.length).toBe(2);
  });

  it('完成声明被未达成清单拦截 → waiting_approval', async () => {
    plannerBehaviors.push(stage1Planner());
    await (orchestrator as any).planAndSave('t-r3', '做一个记账应用', tmp, undefined, { level: 'standard' });
    // replanner 声明完成但只裁定了一部分清单
    plannerBehaviors.push(() => ({
      content: JSON.stringify({ done: true, checklist_results: [] }),
    }));
    const result = await (orchestrator as any).execute('t-r3', tmp);
    expect(result.status).toBe('waiting_approval');
    expect(result.unmet_checklist).toBe(1);
  });

  it('阶段数上限触发 → waiting_approval + stage_cap', async () => {
    plannerBehaviors.push(stage1Planner());
    await (orchestrator as any).planAndSave('t-r4', '做一个记账应用', tmp, undefined, { level: 'standard' });
    // 无限追加下一阶段（每次 replan 都返回新阶段）
    for (let i = 0; i < 6; i++) {
      plannerBehaviors.push(() => ({
        content: JSON.stringify({
          done: false, stage_goal: '再补一点', summary: '继续',
          nodes: [{ id: `x${i}`, name: `补充${i}`, agent: 'dev', complexity: 'simple', reason: '补齐' }],
          edges: [],
          checklist: [],
        }),
      }));
    }
    const result = await (orchestrator as any).execute('t-r4', tmp);
    expect(result.status).toBe('waiting_approval');
    expect(result.stage_cap).toBe(true);
  });

  it('静态模式：任务不带 rolling 字段，行为与旧流程一致', async () => {
    const pool = new ModelPool([{ name: 'fake-model', api_key: 'k', base_url: 'http://localhost:9', tags: ['code'] }]);
    const o = new Orchestrator({
      agentsDir: tmp, modelPool: pool, policy: { whitelistCommands: null, maxTimeSec: 10 },
      maxRetries: 1, sandboxEnabled: false, gitEnabled: false, branchWorkflow: false,
      planningMode: 'static',
    });
    await o.loadAgents();
    plannerBehaviors.push(() => ({
      content: JSON.stringify({
        nodes: [
          { id: 'main', name: 'Main Task', agent: 'orchestrator', complexity: 'simple', reason: '基线' },
          { id: 'dev', name: '开发', agent: 'dev', complexity: 'normal', reason: '实现' },
        ],
        edges: [['main', 'dev']],
        summary: '静态整图',
      }),
    }));
    await (o as any).planAndSave('t-s1', '静态任务', tmp, undefined, { level: 'standard' });
    const graph = await getTaskGraph('t-s1');
    expect(graph!.rolling).toBeFalsy();
    expect(graph!.stage_count).toBe(1);
    // 静态模式带合成清单（结构保底），但 rolling=false 不进阶段循环
    expect(graph!.checklist!.length).toBe(1);
  });
});
