import { describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

vi.mock('../src/llm', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/llm')>();
  let calls = 0;
  return {
    ...actual,
    chat: async (_entry: any, messages: { role: string; content: string }[]) => {
      calls += 1;
      // last system message should carry project memory injected by callAgent
      const sys = [...messages].reverse().find((m) => m.role === 'system')?.content || '';
      (globalThis as any).__lastSystem = sys;
      (globalThis as any).__planUser = calls === 1 ? messages.find((m) => m.role === 'user')?.content : (globalThis as any).__planUser;
      return {
        content: JSON.stringify({ status: 'success', summary: 'done', verification: '已逐项核对产出与任务要求', changes: ['out.txt: ok'], errors: [] }),
        promptTokens: 3,
        completionTokens: 4,
      };
    },
  };
});

import { initBus, closeBus } from '../src/bus';
import { Orchestrator } from '../src/orchestrator/orchestrator';
import { ModelPool } from '../src/scheduler';
import { saveProject, getProjectMemory, addProjectMemory, getTaskGraph } from '../src/store';

describe('project mode', () => {
  it('binds tasks to projects, injects project memory for agents, and accumulates lessons', async () => {
    process.env.COTEAM_FORCE_MEMORY = '1';
    closeBus();
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-proj-'));
    const devDir = path.join(tmp, 'dev');
    fs.mkdirSync(devDir, { recursive: true });
    fs.writeFileSync(path.join(devDir, 'agent.yaml'), 'name: dev\ntags: [code]\n');
    await initBus({ host: '127.0.0.1', port: 6399, db: 0 });

    await saveProject({ id: 'p1', name: '演示项目', workspace: tmp, created_at: new Date().toISOString() });
    await addProjectMemory('p1', '本项目导出 Excel 应使用 exceljs 框架', 'manual');

    const pool = new ModelPool([{ name: 'fake-model', api_key: 'k', base_url: 'http://localhost:9', tags: ['code'] }]);
    const orchestrator = new Orchestrator({
      agentsDir: tmp, modelPool: pool, policy: { whitelistCommands: null, maxTimeSec: 10 },
      maxRetries: 1, sandboxEnabled: false, gitEnabled: false, branchWorkflow: false,
    });
    await orchestrator.loadAgents();

    const { taskId } = await orchestrator.createTask('创建 hello.txt', tmp, 'p1');
    await orchestrator.execute(taskId, tmp);

    const graph = await getTaskGraph(taskId);
    expect(graph!.project_id).toBe('p1');
    expect(graph!.status).toBe('success');

    // callAgent injected the project rule into the system prompt
    const sys = (globalThis as any).__lastSystem as string;
    expect(sys).toContain('本项目开发规范与经验');
    expect(sys).toContain('exceljs');

    const memory = await getProjectMemory('p1', 50);
    // planner context + agent lesson both accumulate
    expect(memory.some((m) => m.text.includes('exceljs'))).toBe(true);
    fs.rmSync(tmp, { recursive: true, force: true });
  });
});
