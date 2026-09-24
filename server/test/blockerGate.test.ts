import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { simpleGit } from 'simple-git';

/**
 * 幻觉阻塞证据门（2026-09-17，in6pe4qf 两次失败实证）：弱模型零工具轮即输出
 * "缺少只读侦查工具/写入权限"→ 旧逻辑命中 LEGIT_BLOCKER_RE 停摆整条降级链停靠人工。
 * 证据门：零工具轮 + 工具/权限类文案 → 判幻觉，同模型重试一次 → 再犯沉底换下一模型；
 * 有工具轮的真阻塞维持原语义（停阶梯转人工）。
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
import { Orchestrator, extractSpecPaths, TOOLCLAIM_RE } from '../src/orchestrator/orchestrator';
import { ModelPool } from '../src/scheduler';
import { saveTaskGraph, getTaskGraph } from '../src/store';
import type { TaskNode } from '../src/types';

let tmp: string;
let orchestrator: Orchestrator;

// in6pe4qf 实测申诉原文（LEGIT_BLOCKER_RE 的"未获得"与 TOOLCLAIM_RE 双命中）
const HALLUCINATED_CLAIM = JSON.stringify({
  status: 'failed',
  errors: ['本轮未获得任何文件系统读取、写入或命令执行工具'],
  summary: '缺少工具无法继续',
  verification: '无法验证：没有可用工具',
  changes: [], files: [], commands: [],
});
// 有工具轮的"真阻塞"申诉（同一文案——证据门只看 tool_rounds）
const TOOLCALL_ROUND = () => ({ content: JSON.stringify({ tool_calls: [{ tool: 'read_file', path: 'base.txt' }] }) });

beforeEach(async () => {
  process.env.COTEAM_FORCE_MEMORY = '1';
  closeBus();
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-blocker-'));
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
  const pool = new ModelPool([
    // 权重差固定 primary 抽签（selectModel 对同权同级模型加权随机）——否则阶梯起点随机，断言漂移
    { id: 'fake-a', name: 'fake-a', api_key: 'k', base_url: 'http://localhost:9', tags: ['code'], professional_weight: 100 },
    { id: 'fake-b', name: 'fake-b', api_key: 'k', base_url: 'http://localhost:9', tags: ['code'], professional_weight: 0 },
  ]);
  orchestrator = new Orchestrator({
    agentsDir: tmp, modelPool: pool, policy: { level: 'full', whitelistCommands: null, maxTimeSec: 10 },
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
    id, task_id: 't-bg', name: '实现节点', status: 'pending', agent: 'dev', result: null, error: '',
    retry_count: 0, complexity: 'normal', requires_approval: false, needs_human: false,
    created_at: '', updated_at: '', ...extra,
  };
}

describe('幻觉阻塞证据门', () => {
  it('零工具轮权限申诉 → 不停阶梯：同模型重试一次 → 再犯沉底 → 第二模型补写落盘成功', async () => {
    const success = () => ({ content: JSON.stringify({ status: 'success', summary: '完成', verification: 'base.txt 已存在', changes: ['base.txt: ok'], errors: [] }) });
    // fake-a 第一次申诉（零工具轮）→ 重试再犯（沉底）→ fake-b 工具轮写文件 → 成功申报
    agentBehaviors.push(
      () => ({ content: HALLUCINATED_CLAIM }),
      () => ({ content: HALLUCINATED_CLAIM }),
      () => ({ content: JSON.stringify({ tool_calls: [{ tool: 'write_file', path: 'notes/a.ts', content: 'ok\n' }] }) }),
      () => ({ content: JSON.stringify({ status: 'success', summary: '完成', verification: '已写入', changes: ['notes/a.ts: ok'], errors: [] }) }),
    );
    await saveTaskGraph('t-bg1', [makeNode('d1')], [], { description: 'x', workspace: tmp, status: 'planned' });
    const result = await (orchestrator as any).execute('t-bg1', tmp);
    expect(result.status).toBe('success');
    const node = (await getTaskGraph('t-bg1'))!.nodes.find((n) => n.id === 'd1')!;
    expect(node.status).toBe('completed');
    expect(node.needs_human).toBe(false);
    // 成功落在了第二个模型上（fake-a 被沉底）
    expect(node.result!.model).toBe('fake-b');
  });

  it('有工具轮的同文案申诉 → 真阻塞原语义：停阶梯转人工', async () => {
    // 三次派发（正常 + 重试 + 主 Agent 接管）各消耗 tool 轮 + 申诉轮，每次都停靠
    agentBehaviors.push(TOOLCALL_ROUND, () => ({ content: HALLUCINATED_CLAIM }),
      TOOLCALL_ROUND, () => ({ content: HALLUCINATED_CLAIM }),
      TOOLCALL_ROUND, () => ({ content: HALLUCINATED_CLAIM }));
    await saveTaskGraph('t-bg2', [makeNode('d1')], [], { description: 'x', workspace: tmp, status: 'planned' });
    const result = await (orchestrator as any).execute('t-bg2', tmp);
    expect(result.status).toBe('failed');
    const node = (await getTaskGraph('t-bg2'))!.nodes.find((n) => n.id === 'd1')!;
    expect(node.status).toBe('failed');
    expect(node.needs_human).toBe(true);
    expect(node.error).toContain('未获得');
  });
});

describe('TOOLCLAIM_RE / extractSpecPaths 纯函数', () => {
  it('TOOLCLAIM_RE 窄匹配：工具/权限类申诉命中，信息/证据类不命中', () => {
    expect(TOOLCLAIM_RE.test('本轮未获得任何文件系统读取、写入或命令执行工具')).toBe(true);
    expect(TOOLCLAIM_RE.test('缺少只读侦查工具')).toBe(true);
    expect(TOOLCLAIM_RE.test('I cannot call tools in this environment')).toBe(true);
    expect(TOOLCLAIM_RE.test('缺少上游接口契约信息，无法对齐字段')).toBe(false);
    expect(TOOLCLAIM_RE.test('规格与实际不符，需要补充证据')).toBe(false);
  });

  it('extractSpecPaths：提取带 / 的路径 token，URL 不误抓，裸文件名不提取', () => {
    expect(extractSpecPaths('实现 lib/services/ai_client.dart 接入层')).toEqual(['lib/services/ai_client.dart']);
    expect(extractSpecPaths('参考 https://example.com/a/b 文档，修改 src/x.ts')).toEqual(['src/x.ts']);
    expect(extractSpecPaths('写 README.md 和 docs')).toEqual([]);
    expect(extractSpecPaths('处理 d:/lib/x.dart 的盘符路径')).toEqual(['lib/x.dart']);
  });

  it('extractSpecPaths：HTTP 路由 token 不当文件路径（pk0udn4p s2-3 实证）', () => {
    // 节点名"启动 server 8787 与 Web 预览并冒烟 /ai/quiz、/ai/explain 降级接口"——ai/quiz 是路由
    expect(extractSpecPaths('启动 server 8787 与 Web 预览并冒烟 /ai/quiz、/ai/explain 降级接口')).toEqual([]);
    expect(extractSpecPaths('核验 build/web/ 产物完整性')).toEqual(['build/web']);
  });
});
