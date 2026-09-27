import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { simpleGit } from 'simple-git';

/**
 * 假完成守卫缺口修补（2026-09-27 learn-english 复盘）：
 * 3c 漏申报进修复轮（unreported 此前只置 consistent=false 零代价）；
 * 豁免一致性（no_changes_reason 曾是逃逸空申报守卫的后门）；
 * light 档补内容级守卫（direct 写工作区曾是整层盲区，jgfhfaux 同款"改了现有文件"只在这里能拦）；
 * 部分幻影剔除语义回归（jgfhfaux 复盘决策，闸内修复轮设计经评估后撤回——见计划文档偏差记录）。
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
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-guard-'));
  const g = simpleGit({ baseDir: tmp });
  await g.init();
  await g.addConfig('user.name', 't');
  await g.addConfig('user.email', 't@t');
  fs.writeFileSync(path.join(tmp, 'base.txt'), 'v1\n');
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

function makeNode(id: string, extra: Partial<TaskNode> = {}): TaskNode {
  return {
    id, task_id: 't-dg', name: '实现节点', status: 'pending', agent: 'dev', result: null, error: '',
    retry_count: 0, complexity: 'normal', requires_approval: false, needs_human: false,
    created_at: '', updated_at: '', ...extra,
  };
}

describe('假完成守卫缺口修补（2026-09-27）', () => {
  it("部分幻影：收尾守卫剔除幻影条目、真实交付照常（jgfhfaux 既有语义回归）", async () => {
    agentBehaviors.push(
      () => ({ content: JSON.stringify({ tool_calls: [{ tool: 'write_file', path: 'lib/real.ts', content: 'r\n' }] }) }),
      () => ({ content: JSON.stringify({ status: 'success', summary: '完成', verification: '已核对', changes: ['lib/real.ts: ok', 'lib/ghost.ts: ok'], errors: [] }) }),
    );
    await saveTaskGraph('t-dg1', [makeNode('d1')], [], { description: 'x', workspace: tmp, status: 'planned' });
    const result = await (orchestrator as any).execute('t-dg1', tmp);
    expect(result.status).toBe('success');
    const node = (await getTaskGraph('t-dg1'))!.nodes.find((n) => n.id === 'd1')!;
    expect(node.status).toBe('completed');
    expect(node.result!.changes).not.toContain('lib/ghost.ts: ok');
    expect(node.result!.delivery_check!.phantom).toContain('lib/ghost.ts');
  }, 30_000);

  it('3c 漏申报（命令产物未申报）→ 修复轮要求补全 changes（此前零代价）', async () => {
    // gen.js 预置进工作区（随基线进沙箱）；run_command 产物 cmdfile.txt 不经 write_file，
    // 不进 midRunWritten——修复前 unreported 只置 consistent=false，漏申报零代价
    fs.writeFileSync(path.join(tmp, 'gen.js'), "require('fs').writeFileSync('cmdfile.txt','c')");
    agentBehaviors.push(
      () => ({ content: JSON.stringify({ tool_calls: [
        { tool: 'write_file', path: 'lib/a.ts', content: 'a\n' },
        { tool: 'run_command', command: 'node gen.js' },
      ] }) }),
      () => ({ content: JSON.stringify({ status: 'success', summary: '完成', verification: '已核对', changes: ['lib/a.ts: ok'], errors: [] }) }),
      () => ({ content: JSON.stringify({ status: 'success', summary: '完成', verification: '已核对', changes: ['lib/a.ts: ok', 'cmdfile.txt: ok'], errors: [] }) }),
    );
    await saveTaskGraph('t-dg2', [makeNode('d2')], [], { description: 'x', workspace: tmp, status: 'planned' });
    const result = await (orchestrator as any).execute('t-dg2', tmp);
    expect(result.status).toBe('success');
    const node = (await getTaskGraph('t-dg2'))!.nodes.find((n) => n.id === 'd2')!;
    expect(node.status).toBe('completed');
    expect(node.result!.changes).toContain('cmdfile.txt: ok');
  }, 30_000);

  it('虚假豁免（写了文件却 no_changes_reason）→ 修复轮拒绝，补申报后通过', async () => {
    agentBehaviors.push(
      () => ({ content: JSON.stringify({ tool_calls: [{ tool: 'write_file', path: 'lib/c.ts', content: 'c\n' }] }) }),
      () => ({ content: JSON.stringify({ status: 'success', summary: '完成', verification: '已核对', changes: [], errors: [], no_changes_reason: '纯分析，无文件改动' }) }),
      () => ({ content: JSON.stringify({ status: 'success', summary: '完成', verification: '已核对', changes: ['lib/c.ts: ok'], errors: [] }) }),
    );
    await saveTaskGraph('t-dg3', [makeNode('d3')], [], { description: 'x', workspace: tmp, status: 'planned' });
    const result = await (orchestrator as any).execute('t-dg3', tmp);
    expect(result.status).toBe('success');
    const node = (await getTaskGraph('t-dg3'))!.nodes.find((n) => n.id === 'd3')!;
    expect(node.status).toBe('completed');
  }, 30_000);

  it('真豁免（零改动 + no_changes_reason）→ 照常放行（一致性校验不误伤）', async () => {
    agentBehaviors.push(() => ({ content: JSON.stringify({ status: 'success', summary: '纯分析', verification: '已通读', changes: [], errors: [], no_changes_reason: '纯分析节点，无文件改动' }) }));
    await saveTaskGraph('t-dg4', [makeNode('d4')], [], { description: 'x', workspace: tmp, status: 'planned' });
    const result = await (orchestrator as any).execute('t-dg4', tmp);
    expect(result.status).toBe('success');
  }, 30_000);

  it('light 档内容级守卫：声称改现有文件但从未写盘 → 收尾 phantom 守卫判 failed（此前整层盲区）', async () => {
    // 闸内 3a' 拦不住（文件存在），只有内容级 unchanged 校验（指纹零变化）能抓——
    // jgfhfaux 同款假完成：申报"修改" ai_service.dart，文件一直在，实际从未写盘
    const fakeEdit = () => ({ content: JSON.stringify({ status: 'success', summary: '改好了', verification: '已核对', changes: ['base.txt: 更新'], errors: [] }) });
    agentBehaviors.push(fakeEdit, fakeEdit, fakeEdit, fakeEdit); // 尝试 + 主 Agent 接管
    await saveTaskGraph('t-dg5', [makeNode('d5', { complexity: 'simple' })], [], { description: 'x', workspace: tmp, status: 'planned', level: 'light' });
    const result = await (orchestrator as any).execute('t-dg5', tmp);
    expect(result.status).toBe('failed');
    const node = (await getTaskGraph('t-dg5'))!.nodes.find((n) => n.id === 'd5')!;
    expect(node.status).toBe('failed');
    expect(node.error).toContain('假完成拦截');
    expect(node.result!.delivery_check!.unchanged).toContain('base.txt');
  }, 30_000);
});
