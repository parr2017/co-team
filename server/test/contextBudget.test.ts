import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// mock chat：可编程脚本 + 抓取每次调用的 messages/maxTokens（观测断崖压缩与分档）
interface ChatCall { messages: { role: string; content: string }[]; maxTokens?: number }
const chatCalls: ChatCall[] = [];
let chatScript: (() => Record<string, any>)[] = [];
let chatDelayMs = 0;
vi.mock('../src/llm', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/llm')>();
  return {
    ...actual,
    chat: async (entry: any, messages: { role: string; content: string }[], maxTokens?: number) => {
      chatCalls.push({ messages: messages.map((m) => ({ ...m })), maxTokens });
      if (chatDelayMs) await new Promise((r) => setTimeout(r, chatDelayMs));
      const next = chatScript.length > 1 ? chatScript.shift()! : chatScript[0];
      const content = typeof next === 'function' ? JSON.stringify(next()) : JSON.stringify(next);
      return { content, promptTokens: 10, completionTokens: 5, finishReason: 'stop', elapsedMs: chatDelayMs || 1 };
    },
  };
});

import { initBus, closeBus } from '../src/bus';
import { ModelPool } from '../src/scheduler';
import { Orchestrator } from '../src/orchestrator/orchestrator';
import { saveTaskGraph, getTaskGraph } from '../src/store';
import { estimateTokens, renderWorkspaceTree, grepFiles, readFile } from '../src/tools';
import { foldMessagesInto, PRECONDITION_FAIL_RE, SYSTEM_DEFECT_RE, ENV_DEFECT_PREFIX, NODE_BUDGET_PREFIX, PRECONDITION_PREFIX } from '../src/orchestrator/orchestrator';
import type { TaskGraph, TaskNode } from '../src/types';

let tmp: string;
beforeEach(() => {
  process.env.COTEAM_FORCE_MEMORY = '1';
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-ctx-'));
  chatCalls.length = 0;
  chatScript = [];
  chatDelayMs = 0;
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
  closeBus();
});

function okNode(): Record<string, any> {
  return { status: 'success', summary: '完成', changes: [], errors: [], verification: '核对完成' };
}
function toolRound(tool: Record<string, any>): Record<string, any> {
  return { status: 'success', summary: '侦查', changes: [], errors: [], verification: 'x', tool_calls: [tool] };
}

describe('estimateTokens（CJK 启发式）', () => {
  it('中文≈1 token/字，拉丁≈4 字符/token', () => {
    expect(estimateTokens('中文中文')).toBeGreaterThanOrEqual(4);
    const latin = estimateTokens('a'.repeat(400));
    expect(latin).toBeLessThanOrEqual(110);
    expect(estimateTokens('')).toBe(0);
  });
});

describe('renderWorkspaceTree（确定性目录树）', () => {
  beforeEach(() => {
    fs.mkdirSync(path.join(tmp, 'src', 'services'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'src', 'services', 'dataService.js'), 'x');
    fs.writeFileSync(path.join(tmp, 'src', 'app.js'), 'y');
    fs.mkdirSync(path.join(tmp, 'node_modules', 'junk'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'node_modules', 'junk', 'a.js'), 'z');
  });
  it('按预算截断且忽略 node_modules；同树输出字节一致', () => {
    const t1 = renderWorkspaceTree(tmp, 1500);
    const t2 = renderWorkspaceTree(tmp, 1500);
    expect(t1).toBe(t2); // 前缀缓存友好的确定性
    expect(t1).toContain('src/');
    expect(t1).toContain('dataService.js');
    expect(t1).not.toContain('node_modules');
  });
  it('极小预算下带截断注记', () => {
    const t = renderWorkspaceTree(tmp, 12);
    expect(t).toContain('截断');
  });
});

describe('grepFiles ENOTDIR 修复（i6efv5h2 根因）', () => {
  it('path 指向文件时单文件匹配，不再抛 ENOTDIR', () => {
    fs.writeFileSync(path.join(tmp, 'dataService.js'), 'const a = 1;\n// MARK hit\n');
    const res = grepFiles(tmp, 'MARK', 'dataService.js');
    expect(res.ok).toBe(true);
    expect(res.matches).toHaveLength(1);
    expect(res.matches![0].file.replace(/\\/g, '/')).toBe('dataService.js');
  });
  it('read_file 大文件截断注入而非报错', () => {
    fs.writeFileSync(path.join(tmp, 'big.js'), 'l\n'.repeat(20000));
    const res = readFile(tmp, 'big.js');
    expect(res.ok).toBe(true);
    expect(res.truncated).toBe(true);
    expect(res.content).toContain('已截断注入');
  });
});

describe('foldMessagesInto（断崖压缩：确定性、低频、head 保护）', () => {
  function history(rounds: number) {
    const msgs = [
      { role: 'system', content: 'SYS' },
      { role: 'user', content: '简报' },
    ];
    for (let i = 0; i < rounds; i++) {
      msgs.push({ role: 'assistant', content: JSON.stringify({ tool_calls: [{ tool: 'read_file', path: `f${i}.js` }] }) });
      msgs.push({ role: 'user', content: `工具执行结果：\n[{"tool":"read_file","ok":true,"content":"${'x'.repeat(5000)}"}]\n\n请基于以上信息给出最终 JSON 结果。` });
    }
    return msgs;
  }
  it('折叠更早轮次为一条确定性摘要，head 与最近 2 条保持原文', () => {
    const msgs = history(5);
    const changed = foldMessagesInto(msgs);
    expect(changed).toBe(true);
    expect(msgs[0].content).toBe('SYS');
    expect(msgs[1].content).toBe('简报');
    const summary = msgs.find((m) => m.content.includes('系统确定性折叠'));
    expect(summary).toBeTruthy();
    expect(summary!.content).toContain('read_file');
    // 最近一条 assistant + 工具结果保持原文
    expect(msgs[msgs.length - 1].content).toContain('请基于以上信息');
    // 规模骤降
    expect(JSON.stringify(msgs).length).toBeLessThan(5000 * 4);
  });
  it('同输入两次折叠字节一致（可重现性：重试前缀可复用）', () => {
    const a = history(5);
    const b = history(5);
    foldMessagesInto(a);
    foldMessagesInto(b);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
  it('不足一轮完整往返不折叠', () => {
    const msgs = history(1);
    expect(foldMessagesInto(msgs)).toBe(false);
  });
});

function makeOrchestrator(pool: ModelPool, opts: Partial<ConstructorParameters<typeof Orchestrator>[0]> = {}) {
  return new Orchestrator({
    agentsDir: path.join(tmp, 'agents'),
    modelPool: pool,
    policy: { whitelistCommands: null, maxTimeSec: 10 },
    maxRetries: 1,
    sandboxEnabled: false,
    gitEnabled: false,
    branchWorkflow: false,
    skillsGlobalDir: path.join(tmp, 'skills'),
    ...opts,
  } as any);
}
function writeAgent(yamlExtra = '') {
  fs.mkdirSync(path.join(tmp, 'agents', 'dev'), { recursive: true });
  fs.writeFileSync(path.join(tmp, 'agents', 'dev', 'agent.yaml'), `name: dev\ntags: [code]\nrole: 开发\n${yamlExtra}`);
}
function makeNode(over: Partial<TaskNode> = {}): TaskNode {
  return {
    id: 'n1', task_id: 't', name: '实现月度聚合', status: 'pending', agent: 'dev', result: null, error: '',
    retry_count: 0, complexity: 'complex', requires_approval: false, needs_human: false, created_at: '', updated_at: '', ...over,
  };
}
async function runOne(graph0: { description: string; workspace: string }, orchOpts = {}) {
  closeBus();
  await initBus({ host: '127.0.0.1', port: 6399, db: 0 });
  const pool = new ModelPool([{ name: 'm1', api_key: 'k', base_url: 'http://localhost:9' }]);
  const orch = makeOrchestrator(pool, orchOpts);
  await orch.loadAgents();
  await saveTaskGraph('t-ctx', [makeNode()], [], graph0 as any);
  const graph = (await getTaskGraph('t-ctx')) as TaskGraph;
  await (orch as any).runGraph('t-ctx', graph, tmp);
  return { pool, graph: await getTaskGraph('t-ctx')! };
}

describe('输出预算分档（不再无脑 128000）', () => {
  it('complex 节点 maxTokens=32000、simple=8000，模型 max_tokens 封顶', async () => {
    writeAgent('timeout: 3600\n');
    chatScript = [okNode()];
    fs.writeFileSync(path.join(tmp, 'package.json'), '{}');
    await runOne({ description: 'x', workspace: tmp }, { outputTiers: { simple: 8000, normal: 32000, complex: 64000 } });
    expect(chatCalls[0].maxTokens).toBe(64000); // complex（m1 未配 max_tokens → 缺省 128000 封顶不生效）

    chatCalls.length = 0;
    chatScript = [okNode()];
    const pool2 = new ModelPool([{ name: 'm2', api_key: 'k', base_url: 'http://localhost:9', max_tokens: 5000 }]);
    const orch2 = makeOrchestrator(pool2, { outputTiers: { simple: 8000, normal: 32000, complex: 64000 } });
    await orch2.loadAgents();
    await saveTaskGraph('t-ctx2', [makeNode({ complexity: 'simple' })], [], { description: 'x', workspace: tmp, status: 'running' } as any);
    await (orch2 as any).runGraph('t-ctx2', (await getTaskGraph('t-ctx2'))!, tmp);
    expect(chatCalls[0].maxTokens).toBe(5000); // min(8000, 模型封顶 5000)
  });
});

describe('分流与预算线（时长/环境/前置不烧阶梯）', () => {
  it('模型申报前置缺失 → [precondition] 终止，不计模型健康度', async () => {
    writeAgent('timeout: 3600\n');
    chatScript = [{ status: 'failed', summary: '无法实施，缺少项目源代码', changes: [], errors: ['缺少项目源代码：沙箱内无任何项目文件'], verification: '核对沙箱文件清单为空' }];
    const { pool, graph } = await runOne({ description: 'x', workspace: tmp });
    const node = graph.nodes.find((n) => n.id === 'n1')!;
    expect(node.error).toContain(PRECONDITION_PREFIX);
    expect(node.needs_human).toBe(true);
    // 需人工停靠，不进入接管/兜底，且模型未被记失败
    expect((pool.getStatus()['m1'] as any).fail_count).toBe(0);
  });

  it('系统缺陷错误（ENOTDIR 形态）→ [env-defect] 不记模型健康度、不烧阶梯', async () => {
    expect(SYSTEM_DEFECT_RE.test('Error: ENOTDIR: not a directory, scandir x')).toBe(true);
    writeAgent('timeout: 3600\n');
    // LLM 层抛出 fs 异常（旧代码里它=模型失败+冷却；新语义=环境缺陷直停）
    chatScript = [() => { throw new Error('ENOTDIR: not a directory, scandir src/a.js'); }];
    const { pool, graph } = await runOne({ description: 'x', workspace: tmp });
    const node = graph.nodes.find((n) => n.id === 'n1')!;
    expect(node.error).toContain(ENV_DEFECT_PREFIX);
    expect(node.needs_human).toBe(true);
    expect((pool.getStatus()['m1'] as any).fail_count).toBe(0);
    expect(chatCalls).toHaveLength(1); // 没有第二条模型的尝试
  });

  it('节点总预算超线 → [node-budget]，发生在轮间且不记模型失败', async () => {
    writeAgent('timeout: 0.1\n'); // 100ms 节点预算
    chatDelayMs = 150;
    chatScript = [toolRound({ tool: 'list_files' }), okNode()];
    const { pool, graph } = await runOne({ description: 'x', workspace: tmp });
    const node = graph.nodes.find((n) => n.id === 'n1')!;
    expect(node.error).toContain(NODE_BUDGET_PREFIX);
    expect(node.needs_human).toBe(true);
    expect((pool.getStatus()['m1'] as any).fail_count).toBe(0);
  });
});

describe('断崖压缩在真实循环内生效 + 重复调用去重', () => {
  it('prompt 超预算触发折叠（每尝试一次）；同参数工具二次调用指针化', async () => {
    closeBus();
    await initBus({ host: '127.0.0.1', port: 6399, db: 0 });
    writeAgent('timeout: 3600\n');
    fs.writeFileSync(path.join(tmp, 'big.js'), 'x'.repeat(30000));
    chatScript = [
      toolRound({ tool: 'read_file', path: 'big.js' }),
      toolRound({ tool: 'read_file', path: 'big.js' }), // 重复调用
      okNode(),
    ];
    // M7：折叠线由模型窗口推导（min(窗口×0.6, 窗口−4096)）——用小窗口模型（4096）表达"强制折叠"
    const pool = new ModelPool([{ name: 'm1', api_key: 'k', base_url: 'http://localhost:9', context_length: 4096 }]);
    const orch = makeOrchestrator(pool, { context: { max_prompt_tokens: 2000, workspace_tree_max_chars: 500, goal_max_chars: 500 } });
    await orch.loadAgents();
    await saveTaskGraph('t-ctx3', [makeNode()], [], { description: 'x', workspace: tmp, status: 'running' } as any);
    await (orch as any).runGraph('t-ctx3', (await getTaskGraph('t-ctx3'))!, tmp);
    // 折叠发生在第 2 轮 push 之后：第 3 次调用里应出现折叠摘要 + 重复调用被指针化
    const third = chatCalls[2].messages.find((m) => m.content.includes('系统确定性折叠'));
    expect(third).toBeTruthy();
    const lastOfThird = chatCalls[2].messages[chatCalls[2].messages.length - 1].content;
    expect(lastOfThird).toContain('完全相同的调用');
    // 折叠后 prompt 规模回落到预算附近（不再是 3 万字符的复读）
    expect(JSON.stringify(chatCalls[2].messages).length).toBeLessThan(30000);
  });
});

describe('正则分型', () => {
  it('PRECONDITION_FAIL_RE 命中 fdj1b4s0 实录错误', () => {
    expect(PRECONDITION_FAIL_RE.test('缺少项目源代码：沙箱内无任何 UniApp 项目文件（无 package.json/src/pages.json/manifest.json）')).toBe(true);
    expect(PRECONDITION_FAIL_RE.test('前序节点产出的代码不在本沙箱')).toBe(true);
    expect(PRECONDITION_FAIL_RE.test('普通实现错误')).toBe(false);
  });
});
