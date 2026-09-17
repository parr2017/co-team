import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { simpleGit } from 'simple-git';

/**
 * 假完成拦截·产物核查门（2026-09-17，ai_client.dart / 空申报两案例）：
 * 3a 规格点名的文件未落盘 → 修复轮让模型真补齐 → 仍缺则 failed（error_type=content）；
 * 3b 零申报零改动无豁免说明 → 拦截；no_changes_reason 豁免。
 * 另回归盘符申报条目（d:/x.dart: desc）参与 phantom 判定（normalizeReportedPath 盘符修复）。
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

const successWith = (changes: string[], extra: Record<string, unknown> = {}) => ({
  content: JSON.stringify({ status: 'success', summary: '完成', verification: '已核对', changes, errors: [], ...extra }),
});

beforeEach(async () => {
  process.env.COTEAM_FORCE_MEMORY = '1';
  closeBus();
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-artifact-'));
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
  // agentsDir 也在仓库内——一并提交保持基线干净（否则未跟踪 dev/ 会让空申报守卫的
  // git actual!=0，3b 永不触发）
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
    id, task_id: 't-ag', name, status: 'pending', agent: 'dev', result: null, error: '',
    retry_count: 0, complexity: 'normal', requires_approval: false, needs_human: false,
    created_at: '', updated_at: '', ...extra,
  };
}

describe('产物核查门（最终 JSON 闸内）', () => {
  it('规格点名缺失 → 修复轮真补盘 → 复核通过节点 completed', async () => {
    agentBehaviors.push(
      () => ({ content: JSON.stringify({ status: 'success', summary: '完成', verification: '已核对', changes: ['lib/svc/greeting.ts: ok'], errors: [] }) }),
      () => ({ content: JSON.stringify({ tool_calls: [{ tool: 'write_file', path: 'lib/svc/greeting.ts', content: 'export const hi = 1;\n' }] }) }),
      () => ({ content: JSON.stringify({ status: 'success', summary: '完成', verification: '已核对', changes: ['lib/svc/greeting.ts: ok'], errors: [] }) }),
    );
    await saveTaskGraph('t-ag1', [makeNode('d1', '实现 lib/svc/greeting.ts 模块')], [], { description: 'x', workspace: tmp, status: 'planned' });
    const result = await (orchestrator as any).execute('t-ag1', tmp);
    expect(result.status).toBe('success');
    const node = (await getTaskGraph('t-ag1'))!.nodes.find((n) => n.id === 'd1')!;
    expect(node.status).toBe('completed');
    expect(node.result!.changes).toContain('lib/svc/greeting.ts: ok');
  });

  it('规格点名始终缺失 → failed（产物核查未通过），error_type=content', async () => {
    // simple 复杂度 maxRounds=4：尝试 1 耗 4 轮判失败，主 Agent 接管再耗 4 轮
    const missing = () => ({ content: JSON.stringify({ status: 'success', summary: '完成', verification: '已核对', changes: ['lib/never/written.ts: ok'], errors: [] }) });
    agentBehaviors.push(missing, missing, missing, missing, missing, missing, missing, missing);
    await saveTaskGraph('t-ag2', [makeNode('d1', '实现 lib/never/written.ts 模块', { complexity: 'simple' })], [], { description: 'x', workspace: tmp, status: 'planned' });
    const result = await (orchestrator as any).execute('t-ag2', tmp);
    expect(result.status).toBe('failed');
    const node = (await getTaskGraph('t-ag2'))!.nodes.find((n) => n.id === 'd1')!;
    expect(node.status).toBe('failed');
    expect(node.error).toContain('产物核查未通过');
    expect((node as any).error_type).toBe('content');
  });

  it('零申报零改动无豁免 → failed；no_changes_reason 豁免 → completed', async () => {
    // A：零申报空转——simple 复杂度，尝试 + 接管共 8 轮全部空申报
    // 30s 超时：8 轮 mock 轮次 + 两次 execute 踩默认 5s 边界，机器负载高时偶发超时（预存在，2026-09-17 补声明）
    const empty = () => ({ content: JSON.stringify({ status: 'success', summary: '完成', verification: '已核对', changes: [], errors: [] }) });
    agentBehaviors.push(empty, empty, empty, empty, empty, empty, empty, empty);
    await saveTaskGraph('t-ag3', [makeNode('d1', '整理项目文档', { complexity: 'simple' })], [], { description: 'x', workspace: tmp, status: 'planned' });
    const r3 = await (orchestrator as any).execute('t-ag3', tmp);
    expect(r3.status).toBe('failed');
    const n3 = (await getTaskGraph('t-ag3'))!.nodes.find((n) => n.id === 'd1')!;
    expect(n3.error).toContain('零申报零改动');

    // B：同样零申报但带 no_changes_reason → 豁免放行
    agentBehaviors.push(() => ({ content: JSON.stringify({ status: 'success', summary: '纯分析', verification: '已通读', changes: [], errors: [], no_changes_reason: '纯分析节点，无文件改动' }) }));
    await saveTaskGraph('t-ag4', [makeNode('d2', '分析项目架构')], [], { description: 'x', workspace: tmp, status: 'planned' });
    const r4 = await (orchestrator as any).execute('t-ag4', tmp);
    expect(r4.status).toBe('success');
    const n4 = (await getTaskGraph('t-ag4'))!.nodes.find((n) => n.id === 'd2')!;
    expect(n4.status).toBe('completed');
  }, 30_000);

  it('盘符申报条目（d:/x.dart: desc）参与 phantom 判定——修复后不再被豁免', async () => {
    // 修复前：split(':')[0] 切出 'd'，looksLikePath 不过 → 幻影条目漏判，节点假完成
    const phantom = () => ({ content: JSON.stringify({ status: 'success', summary: '已实现', verification: 'npm test 通过', changes: ['d:/x/missing.dart: 实现'], errors: [] }) });
    agentBehaviors.push(phantom, phantom); // 正常尝试 + 主 Agent 接管各一次
    await saveTaskGraph('t-ag5', [makeNode('d1', '实现节点')], [], { description: 'x', workspace: tmp, status: 'planned' });
    const result = await (orchestrator as any).execute('t-ag5', tmp);
    expect(result.status).toBe('failed');
    const node = (await getTaskGraph('t-ag5'))!.nodes.find((n) => n.id === 'd1')!;
    expect(node.status).toBe('failed');
    expect(node.error).toContain('假完成拦截');
    expect(node.result!.delivery_check!.phantom).toContain('x/missing.dart');
  });
});
