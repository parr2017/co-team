import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const evalResponses: { content: string }[] = [];
vi.mock('../src/llm', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/llm')>();
  return {
    ...actual,
    chat: async (_entry: any, messages: { role: string; content: string }[]) => {
      const sys = String(messages[0]?.content || '');
      if (sys.includes('task planner')) {
        const r = evalResponses.shift() || { content: '{"nodes":[],"edges":[],"summary":"none"}' };
        return { content: r.content, promptTokens: 3, completionTokens: 4 };
      }
      // agent 默认成功
      return { content: JSON.stringify({ status: 'success', summary: '完成', verification: 'npm test 通过', changes: ['a.txt: ok'], errors: [] }), promptTokens: 3, completionTokens: 4 };
    },
  };
});

import { initBus, closeBus, getBus } from '../src/bus';
import { ModelPool } from '../src/scheduler';
import { Orchestrator } from '../src/orchestrator/orchestrator';
import { detectProjectProfile, detectTestCommand, runChecklistAudit } from '../src/orchestrator/acceptance';
import { saveTaskGraph, getTaskGraph } from '../src/store';
import type { ChecklistItem, TaskNode } from '../src/types';

let tmp: string;
let orchestrator: Orchestrator;

beforeEach(async () => {
  process.env.COTEAM_FORCE_MEMORY = '1';
  closeBus();
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-acc-'));
  const devDir = path.join(tmp, 'dev');
  fs.mkdirSync(devDir, { recursive: true });
  fs.writeFileSync(path.join(devDir, 'agent.yaml'), 'name: dev\ntags: [code]\nrole: 开发\n');
  await initBus({ host: '127.0.0.1', port: 6399, db: 0 });
  evalResponses.length = 0;
  const pool = new ModelPool([{ name: 'fake-model', api_key: 'k', base_url: 'http://localhost:9', tags: ['code'] }]);
  orchestrator = new Orchestrator({
    agentsDir: tmp, modelPool: pool, policy: { whitelistCommands: null, maxTimeSec: 10 },
    maxRetries: 1, sandboxEnabled: false, gitEnabled: false, branchWorkflow: false,
    planningMode: 'rolling',
  });
  await orchestrator.loadAgents();
});

afterEach(async () => {
  // 派生任务的后台规划（planAsync）是进程内浮动 promise，拆栈前给它一个完成窗口
  await new Promise((r) => setTimeout(r, 150));
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

function writePkg(scripts: Record<string, string>, deps: Record<string, string> = {}) {
  fs.writeFileSync(path.join(tmp, 'package.json'), JSON.stringify({ name: 'x', version: '1.0.0', scripts, dependencies: deps }));
}

function stage1With(checklist: ChecklistItem[]) {
  return () => ({
    content: JSON.stringify({
      done: false, stage_goal: '骨架', summary: '骨架',
      nodes: [
        { id: 'm', name: 'Main Task', agent: 'orchestrator', complexity: 'simple', reason: '基线' },
        { id: 'd', name: '开发', agent: 'dev', complexity: 'normal', reason: '实现' },
      ],
      edges: [['m', 'd']],
      checklist,
    }),
  });
}

describe('M5 平台探测', () => {
  it('探测 web/api/uniapp 多端与测试、构建命令', () => {
    writePkg({ test: 'vitest run', build: 'vite build' }, { vue: '^3', express: '^4', '@dcloudio/uni-app': '^3' });
    fs.mkdirSync(path.join(tmp, 'src'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'src', 'manifest.json'), JSON.stringify({ 'mp-weixin': { appid: 'x' }, h5: {} }));
    const p = detectProjectProfile(tmp);
    expect(p.platforms).toEqual(expect.arrayContaining(['web', 'api', 'h5', 'miniprogram']));
    expect(p.testCommand!.command).toBe('npm test');
    expect(p.buildCommand).toBe('npm run build');
  });

  it('无测试命令 → profile.testCommand 为 null（机审将降级留痕）', () => {
    const p = detectProjectProfile(tmp);
    expect(p.testCommand).toBeNull();
    expect(p.e2e.runnable).toBe(false);
  });
});

describe('M5 清单机审', () => {
  it('unit 项真实执行测试命令：绿→done 附证据，红→failed', async () => {
    writePkg({ test: 'node -e "process.exit(0)"' });
    fs.mkdirSync(path.join(tmp, 'tests'), { recursive: true });
    const items: ChecklistItem[] = [{ id: '1', requirement: '测试全绿', evidence_type: 'unit' }];
    const r1 = await runChecklistAudit(tmp, items);
    expect(r1.items[0].status).toBe('done');
    expect(r1.items[0].machine).toBe(true);
    expect(r1.items[0].evidence).toContain('exit 0');

    writePkg({ test: 'node -e "process.exit(2)"' });
    const r2 = await runChecklistAudit(tmp, items);
    expect(r2.items[0].status).toBe('failed');
    expect(r2.items[0].evidence).toContain('exit 2');
  });

  it('无测试命令的 unit 项：显式降级留痕，绝不静默放行', async () => {
    const items: ChecklistItem[] = [{ id: '1', requirement: '测试全绿', evidence_type: 'unit' }];
    const r = await runChecklistAudit(tmp, items);
    expect(r.items[0].status).toBe('open');
    expect(r.items[0].audit_note).toContain('降级留痕');
  });

  it('E2E 项在无 playwright/e2e 脚本时降级留痕', async () => {
    const items: ChecklistItem[] = [{ id: 'e', requirement: '页面导航可达', evidence_type: 'e2e' }];
    const r = await runChecklistAudit(tmp, items);
    expect(r.items[0].status).toBe('open');
    expect(r.items[0].audit_note).toContain('E2E 未就绪');
  });

  it('manual 项保持 open 交给人工（不静默放行）', async () => {
    const items: ChecklistItem[] = [{ id: 'm', requirement: '真机实拍', evidence_type: 'manual' }];
    const r = await runChecklistAudit(tmp, items);
    expect(r.items[0].status).toBe('open');
    expect(r.items[0].machine).toBe(false);
  });
});

describe('M5 最终验收闸（rolling 任务）', () => {
  it('机审红灯 → waiting_approval + 派生任务提案；批准后自动创建派生任务', async () => {
    // 项目有测试命令（会失败）→ unit 清单项红灯
    writePkg({ test: 'node -e "process.exit(3)"' });
    // stage1 计划（清单含 unit 项）
    evalResponses.push({
      content: JSON.stringify({
        done: false, stage_goal: '骨架', summary: '骨架',
        nodes: [
          { id: 'm', name: 'Main Task', agent: 'orchestrator', complexity: 'simple', reason: '基线' },
          { id: 'd', name: '开发', agent: 'dev', complexity: 'normal', reason: '实现' },
        ],
        edges: [['m', 'd']],
        checklist: [{ requirement: '测试全绿', evidence_type: 'unit' }],
      }),
    });
    await (orchestrator as any).planAndSave('t-gate', '做一个应用', tmp, undefined, { level: 'standard' });
    // replanner 声明完成（自评全绿）→ 走到最终闸；最终闸机审打回（真实测试 exit 3）
    evalResponses.push({
      content: JSON.stringify({ done: true, checklist_results: [{ id: '1-1', done: true, evidence: 'npm test 全绿' }] }),
    });
    // 最终闸：unit 红灯 → waiting_approval + derive_task 提案
    const result = await (orchestrator as any).execute('t-gate', tmp);
    expect(result.status).toBe('waiting_approval');
    expect(result.acceptance_failed).toBe(true);
    const graph = await getTaskGraph('t-gate');
    expect(graph!.checklist![0].status).toBe('failed');
    expect(graph!.checklist![0].evidence).toContain('exit 3');
    const proposals = (await getBus().get('task:proposals:t-gate')) as any[];
    const derive = proposals.find((p) => p.type === 'derive_task');
    expect(derive).toBeTruthy();
    expect(derive.status).toBe('pending');

    // 一键批准 → 自动创建派生任务（rolling 继承）
    const { createApi } = await import('../src/api');
    const { TaskQueueManager } = await import('../src/taskQueue');
    const app = createApi({
      config: {
        agents_dir: tmp, dashboard: { host: '127.0.0.1', port: 0 },
        model_pool: [], orchestrator: { max_retries: 1, sandbox: false, git: false } as any,
        permissions: {}, redis: { host: '127.0.0.1', port: 6399, db: 0 },
        knowledge: { dir: path.join(tmp, 'kb') },
      } as any,
      orchestrator,
      modelPool: new ModelPool([]),
      taskQueue: new TaskQueueManager(orchestrator, new ModelPool([])),
    });
    const res = await app.request(`/api/tasks/t-gate/proposals/${derive.id}/decide`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ approved: true }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('executed');
    const proposalsAfter = (await getBus().get('task:proposals:t-gate')) as any[];
    expect(proposalsAfter.find((p) => p.id === derive.id).derived_task_id).toBeTruthy();
  }, 30000);

  it('清单全绿 → success 不拦截', async () => {
    writePkg({ test: 'node -e "process.exit(0)"' });
    evalResponses.push({
      content: JSON.stringify({
        done: false, stage_goal: '骨架', summary: '骨架',
        nodes: [
          { id: 'm', name: 'Main Task', agent: 'orchestrator', complexity: 'simple', reason: '基线' },
          { id: 'd', name: '开发', agent: 'dev', complexity: 'normal', reason: '实现' },
        ],
        edges: [['m', 'd']],
        checklist: [{ requirement: '测试全绿', evidence_type: 'unit' }],
      }),
    });
    await (orchestrator as any).planAndSave('t-pass', '做一个应用', tmp, undefined, { level: 'standard' });
    // replanner 声明完成 + 证据
    evalResponses.push({
      content: JSON.stringify({ done: true, checklist_results: [{ id: '1-1', done: true, evidence: 'npm test 全绿' }] }),
    });
    const result = await (orchestrator as any).execute('t-pass', tmp);
    expect(result.status).toBe('success');
    const graph = await getTaskGraph('t-pass');
    expect(graph!.checklist![0].status).toBe('done');
  }, 30000);
});
