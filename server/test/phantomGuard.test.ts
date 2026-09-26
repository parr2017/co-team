import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { simpleGit } from 'simple-git';

/**
 * 假完成守卫（2026-09-16，o3xmkraj 实证）：429 限流下 agent 抢不到写窗口却"幻觉完成"
 * ——changes 申报的文件沙箱里不存在。recordDeliveryCheck 只记分；本文件验证分级裁决：
 * 全 phantom → 节点 failed 转人工（接管后仍假完成即停靠）；部分 phantom → 剔除幻影条目照常交付。
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
import { saveTaskGraph, getTaskGraph } from '../src/store';
import type { TaskNode } from '../src/types';

let tmp: string;
let orchestrator: Orchestrator;

beforeEach(async () => {
  process.env.COTEAM_FORCE_MEMORY = '1';
  closeBus();
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-phantom-'));
  // git 仓库工作区（worktree 沙箱 + 交付一致性检查的前置）
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
    id, task_id: 't-ph', name: '实现节点', status: 'pending', agent: 'dev', result: null, error: '',
    retry_count: 0, complexity: 'normal', requires_approval: false, needs_human: false,
    created_at: '', updated_at: '', ...extra,
  };
}

describe('phantom 完成守卫（假完成分级裁决）', () => {
  it('全 phantom：申报文件均未落盘 → 接管后仍假完成 → 节点 failed 转人工', async () => {
    const phantom = () => ({ content: JSON.stringify({ status: 'success', summary: '已实现 AiClient', verification: 'npm test 通过', changes: ['lib/services/ai_client.dart: 实现'], errors: [] }) });
    agentBehaviors.push(phantom, phantom); // 正常尝试 + 主 Agent 接管各一次
    await saveTaskGraph('t-ph1', [makeNode('d1')], [], { description: 'x', workspace: tmp, status: 'planned' });
    const result = await (orchestrator as any).execute('t-ph1', tmp);
    expect(result.status).toBe('failed');
    const node = (await getTaskGraph('t-ph1'))!.nodes.find((n) => n.id === 'd1')!;
    expect(node.status).toBe('failed');
    expect(node.error).toContain('假完成');
    expect(node.needs_human).toBe(true);
  });

  it('部分 phantom：幻影条目被剔除，真实文件照常交付', async () => {
    // exists.txt 预先提交进基线（沙箱文件系统存在 → 不算 phantom）
    fs.writeFileSync(path.join(tmp, 'exists.txt'), 'real\n');
    const g = simpleGit({ baseDir: tmp });
    await g.add('-A');
    await g.commit('add exists');
    // jgfhfaux 复盘后语义收紧：申报"修改"exists.txt 但零写盘 → 内容级幻影；
    // 真实交付改走结构化 files（applyFinalOutput 落盘 → 实际变更）
    agentBehaviors.push(() => ({
      content: JSON.stringify({
        status: 'success', summary: '完成', verification: 'ok',
        files: [{ path: 'new.txt', content: 'x\n' }],
        changes: ['new.txt: ok', 'exists.txt: ok', 'lib/missing.dart: ok'],
        errors: [],
      }),
    }));
    await saveTaskGraph('t-ph2', [makeNode('d1')], [], { description: 'x', workspace: tmp, status: 'planned' });
    const result = await (orchestrator as any).execute('t-ph2', tmp);
    expect(result.status).toBe('success');
    const node = (await getTaskGraph('t-ph2'))!.nodes.find((n) => n.id === 'd1')!;
    expect(node.status).toBe('completed');
    // writeFiles 落盘的裸路径 + 申报条目（applyFinalOutput 既有行为）
    expect(node.result!.changes).toEqual(['new.txt', 'new.txt: ok']);
    expect((node.result as any).delivery_check.phantom).toContain('lib/missing.dart');
    expect((node.result as any).delivery_check.unchanged).toContain('exists.txt');
  });

  it('内容级假完成：申报修改已存在文件但零变更 → 全幻影拦截转人工（jgfhfaux 复盘）', async () => {
    // base.txt 在基线提交中存在；agent 声称"修改"它但没有任何写盘——存在性检查放行
    // （文件在），内容级检查（节点生命周期内 mtime+size 零变化）必须拦下
    const claim = () => ({ content: JSON.stringify({ status: 'success', summary: '已修改 base.txt', verification: '已核对', changes: ['base.txt: 修改配置'], errors: [] }) });
    agentBehaviors.push(claim, claim); // 正常尝试 + 主 Agent 接管各一次
    await saveTaskGraph('t-ph3', [makeNode('d1')], [], { description: 'x', workspace: tmp, status: 'planned' });
    const result = await (orchestrator as any).execute('t-ph3', tmp);
    expect(result.status).toBe('failed');
    const node = (await getTaskGraph('t-ph3'))!.nodes.find((n) => n.id === 'd1')!;
    expect(node.status).toBe('failed');
    expect(node.needs_human).toBe(true);
    expect(node.error).toContain('零变更');
    expect((node.result as any).delivery_check.unchanged).toContain('base.txt');
    expect((node.result as any).delivery_check.phantom).toEqual([]);
  });
});
