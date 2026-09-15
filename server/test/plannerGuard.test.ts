import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * 2026-09-14/15 五任务连败复盘（mc4xxtyh/qwoj3msp/0m5ix51c/p63jzcbw/pysgqvx5）：
 * 知识库损坏时 getMemory/relevantKnowledge 抛 RangeError，裸奔在 llmPlan try 之外
 * （generateStagePlan 整段无守卫），滚动与静态规划双路崩、任务 0 节点直接失败。
 * 本文件把两条读取永久替换为"抛 RangeError"的损坏态，断言规划链路降级为
 * "空记忆、空知识"继续产出计划，而不是任务失败。
 */
vi.mock('../src/store', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/store')>();
  return {
    ...actual,
    getMemory: async (): Promise<string[]> => {
      throw new RangeError('Invalid array length');
    },
  };
});
vi.mock('../src/knowledge', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/knowledge')>();
  return {
    ...actual,
    relevantKnowledge: async (): Promise<never[]> => {
      throw new RangeError('Invalid array length');
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
        // 滚动 stage1 与静态 llmPlan 共用该 payload：带 nodes+checklist，两条路都能解析
        return {
          content: JSON.stringify({
            done: false,
            stage_goal: '可运行最小骨架',
            summary: '守卫下的计划',
            nodes: [
              { id: 'main', name: 'Main Task', agent: 'orchestrator', complexity: 'simple', reason: '任务基线' },
              { id: 'd1', name: '开发实现', agent: 'dev', complexity: 'normal', reason: '实现', required_skills: ['code'] },
            ],
            edges: [['main', 'd1']],
            checklist: [{ requirement: '端到端可用', evidence_type: 'command' }],
          }),
          promptTokens: 2, completionTokens: 3,
        };
      }
      return { content: JSON.stringify({ status: 'success', summary: 'done', verification: 'ok', changes: [], errors: [] }), promptTokens: 3, completionTokens: 4 };
    },
  };
});

import { initBus, closeBus } from '../src/bus';
import { Orchestrator } from '../src/orchestrator/orchestrator';
import { ModelPool } from '../src/scheduler';
import { getTaskGraph } from '../src/store';

let tmp: string;

beforeEach(async () => {
  process.env.COTEAM_FORCE_MEMORY = '1';
  closeBus();
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-pguard-'));
  const devDir = path.join(tmp, 'dev');
  fs.mkdirSync(devDir, { recursive: true });
  fs.writeFileSync(path.join(devDir, 'agent.yaml'), 'name: dev\ntags: [code]\nrole: 开发\n');
  await initBus({ host: '127.0.0.1', port: 6399, db: 0 });
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
  closeBus();
});

function makeOrchestrator(planningMode: 'rolling' | 'static'): Orchestrator {
  const pool = new ModelPool([{ name: 'fake-model', api_key: 'k', base_url: 'http://localhost:9', tags: ['code'] }]);
  return new Orchestrator({
    agentsDir: tmp, modelPool: pool, policy: { whitelistCommands: null, maxTimeSec: 10 },
    maxRetries: 1, sandboxEnabled: false, gitEnabled: false, branchWorkflow: false,
    planningMode,
  });
}

describe('规划链路辅助数据守卫（记忆/知识库损坏 → 降级而非崩）', () => {
  it('rolling：getMemory/relevantKnowledge 抛 RangeError 时 stage-1 计划照常产出', async () => {
    const orch = makeOrchestrator('rolling');
    await orch.loadAgents();
    await (orch as any).planAndSave('t-g1', '做一个记账应用', tmp, undefined, { level: 'standard' });
    const graph = await getTaskGraph('t-g1');
    expect(graph).toBeTruthy();
    expect(graph!.status).toBe('planned');
    expect(graph!.rolling).toBe(true);
    expect(graph!.nodes.length).toBeGreaterThan(0);
    expect(graph!.checklist!.length).toBe(1);
  });

  it('static：同样的损坏态下静态整图照常产出（llmPlan 降级路径）', async () => {
    const orch = makeOrchestrator('static');
    await orch.loadAgents();
    await (orch as any).planAndSave('t-g2', '静态规划任务', tmp, undefined, { level: 'standard' });
    const graph = await getTaskGraph('t-g2');
    expect(graph).toBeTruthy();
    expect(graph!.status).toBe('planned');
    expect(graph!.rolling).toBeFalsy();
    expect(graph!.nodes.length).toBeGreaterThan(0);
  });
});
