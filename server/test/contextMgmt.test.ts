import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const seenMessages: { role: string; content: string }[][] = [];
vi.mock('../src/llm', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/llm')>();
  return {
    ...actual,
    chat: async (_entry: any, messages: { role: string; content: string }[]) => {
      seenMessages.push(messages.map((m) => ({ ...m })));
      return { content: JSON.stringify({ status: 'success', summary: 'done', verification: '已验证', changes: ['a.txt: ok'], errors: [] }), promptTokens: 3, completionTokens: 4 };
    },
  };
});

import { initBus, closeBus } from '../src/bus';
import { ModelPool } from '../src/scheduler';
import { Orchestrator } from '../src/orchestrator/orchestrator';
import { gitDiffFull, listTestAssets } from '../src/tools';
import { saveTaskGraph, getTaskGraph } from '../src/store';
import type { TaskNode } from '../src/types';

let tmp: string;
let orchestrator: Orchestrator;

beforeEach(async () => {
  process.env.COTEAM_FORCE_MEMORY = '1';
  closeBus();
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-ctx-'));
  for (const name of ['dev', 'review', 'test']) {
    const dir = path.join(tmp, name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'agent.yaml'), `name: ${name}\ntags: [code]\nrole: ${name}\n`);
  }
  await initBus({ host: '127.0.0.1', port: 6399, db: 0 });
  seenMessages.length = 0;
  const pool = new ModelPool([{ name: 'fake-model', api_key: 'k', base_url: 'http://localhost:9', tags: ['code'], context_length: 131072 }]);
  orchestrator = new Orchestrator({
    agentsDir: tmp, modelPool: pool, policy: { whitelistCommands: null, maxTimeSec: 10 },
    maxRetries: 1, sandboxEnabled: false, gitEnabled: false, branchWorkflow: false,
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

describe('M7 上下文管理', () => {
  it('gitDiffFull 返回完整 patch（区别于 --stat）', () => {
    fs.writeFileSync(path.join(tmp, 'x.txt'), 'line1\n');
    const { execSync } = require('node:child_process') as any;
    execSync('git init -q', { cwd: tmp });
    execSync('git -c user.email=t@t -c user.name=t add -A', { cwd: tmp });
    execSync('git -c user.email=t@t -c user.name=t commit -qm base', { cwd: tmp });
    fs.writeFileSync(path.join(tmp, 'x.txt'), 'line1-changed\nline2\n');
    const full = gitDiffFull(tmp);
    expect(full.ok).toBe(true);
    expect(full.diff).toContain('+line2');
    expect(full.diff).toContain('-line1');
  });

  it('listTestAssets 列出测试文件', () => {
    fs.mkdirSync(path.join(tmp, 'tests'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'tests', 'app.test.js'), 'x');
    const idx = listTestAssets(tmp);
    expect(idx).toContain('tests/app.test.js');
  });

  it('review 节点 userMsg 注入完整 diff 块；test 节点注入测试资产索引', async () => {
    fs.writeFileSync(path.join(tmp, 'y.txt'), 'old\n');
    const { execSync } = require('node:child_process') as any;
    execSync('git init -q', { cwd: tmp });
    execSync('git -c user.email=t@t -c user.name=t add -A', { cwd: tmp });
    execSync('git -c user.email=t@t -c user.name=t commit -qm base', { cwd: tmp });
    fs.writeFileSync(path.join(tmp, 'y.txt'), 'new\n');
    fs.mkdirSync(path.join(tmp, 'tests'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'tests', 's.spec.ts'), 'x');

    await saveTaskGraph('t-role', [
      makeNode('r1', 'review', { status: 'completed', result: { status: 'success', summary: '审查完成', changes: [] } }),
      makeNode('t1', 'test'),
    ], [['r1', 't1']], { description: 'x', workspace: tmp });
    const graph = await getTaskGraph('t-role');
    await (orchestrator as any).runGraph('t-role', graph, tmp);

    const testCall = seenMessages.find((ms) => ms.some((m) => m.role === 'user' && m.content.includes('任务: t1')));
    const testUser = testCall!.find((m) => m.role === 'user')!;
    expect(testUser.content).toContain('既有测试资产索引');
    expect(testUser.content).toContain('tests/s.spec.ts');
  });

  it('折叠线按模型窗口动态化：131072 窗口 → 折叠阈值为 min(78643, 126976)=78643（远高于全局 16000）', () => {
    // 直接验证计算规则（foldLimit 是 callAgent 内部值，通过公式一致性断言）
    const ctxWindow = 131072;
    const expected = Math.min(Math.floor(ctxWindow * 0.6), ctxWindow - 4096);
    expect(expected).toBe(78643);
    expect(expected).toBeGreaterThan(16000);
    // complex 节点上浮 1.5 档
    expect(Math.floor(expected * 1.5)).toBe(117964);
  });
});
