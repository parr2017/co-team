import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// P1 明细落盘（工作过程随消息持久化）测试：工具活动条带 meta.calls、发言消息带 meta.detail
// （evidence/工具调用/技能/提及/模型），刷新后 UI 仍能渲染完整过程。
const h = vi.hoisted(() => ({
  routerSpeakers: null as null | string[] | 'throw',
  lastSpeakerCalls: [] as { agent: string; model: string; sys: string; user: string }[],
  speaker: null as null | ((sys: string, user: string, model: string) => string | Promise<string>),
  divergenceConflict: false,
}));

vi.mock('../src/llm', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/llm')>();
  const ok = (content: string) => ({ content, promptTokens: 5, completionTokens: 8 });
  return {
    ...actual,
    chat: async (entry: any, messages: { role: string; content: string }[]) => {
      const sys = messages.find((m) => m.role === 'system')?.content || '';
      const userAll = messages.filter((m) => m.role === 'user').map((m) => m.content).join('\n\n');
      if (sys.includes('判断讨论是否还有必要')) return ok(JSON.stringify({ continue: false, reason: 'test' }));
      if (sys.includes('分歧检测员')) return ok(JSON.stringify({ conflict: h.divergenceConflict, summary: h.divergenceConflict ? '方案选择冲突' : '' }));
      if (sys.includes('群聊调度路由器')) {
        const m = sys.match(/可选成员：([^\n]+)/);
        const all = m ? m[1].split('、').map((s) => s.trim()).filter(Boolean) : [];
        return ok(JSON.stringify({ speakers: h.routerSpeakers ?? all, reason: 'test' }));
      }
      if (sys.includes('项目规划群组讨论')) {
        const m = userAll.match(/你是群组讨论中的「(.+?)」Agent/);
        const agent = m ? m[1] : '?';
        const model = String(entry?.name ?? '');
        h.lastSpeakerCalls.push({ agent, model, sys, user: userAll });
        if (!h.speaker) return ok(JSON.stringify({ speak: false }));
        return ok(await h.speaker(sys, userAll, model));
      }
      if (sys.includes('task planner')) {
        return ok(JSON.stringify({ nodes: [{ id: '1', name: '实现方案', agent: 'dev', complexity: 'normal', goal_link: '按方案实现' }], edges: [], summary: 'plan' }));
      }
      return ok(JSON.stringify({ status: 'success', summary: 'done', verification: 'ok', changes: [], errors: [] }));
    },
  };
});

import { initBus, closeBus } from '../src/bus';
import { ModelPool } from '../src/scheduler';
import { Orchestrator } from '../src/orchestrator/orchestrator';
import { saveProject } from '../src/store';
import { createDiscussion, getMessages, runDiscussionRound, SPEAKER_RETRY_POLICY, convertToProject, updateDiscussion } from '../src/discussion';
import type { DiscussionMessage } from '../src/discussion';

let tmp: string;
let deps: any;

const okContent = (reply: string, extra: Record<string, unknown> = {}) => JSON.stringify({ speak: true, reply, ...extra });

beforeEach(async () => {
  process.env.COTEAM_FORCE_MEMORY = '1';
  closeBus();
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-disc-detail-'));
  process.chdir(tmp);
  fs.mkdirSync(path.join(tmp, 'data'), { recursive: true });
  for (const name of ['dev', 'test', 'deploy']) {
    const d = path.join(tmp, name);
    fs.mkdirSync(d, { recursive: true });
    // dev 带绑定技能：验证技能注入身份与 detail.skills
    const skills = name === 'dev' ? '\nskills: [code-review-checklist]' : '';
    fs.writeFileSync(path.join(d, 'agent.yaml'), `name: ${name}\ntags: [code]\nrole: ${name === 'dev' ? '开发工程师' : name}${skills}\n`);
    fs.writeFileSync(path.join(d, 'prompt.md'), `${name} 的专业指令`);
  }
  await initBus({ host: '127.0.0.1', port: 6399, db: 0 });
  h.speaker = null;
  h.routerSpeakers = null;
  h.lastSpeakerCalls = [];
  SPEAKER_RETRY_POLICY.capacityWaitSec = [0, 0];
  SPEAKER_RETRY_POLICY.quickRetryDelayMs = 0;
  const pool = new ModelPool([{ name: 'fake-model', api_key: 'k', base_url: 'http://localhost:9', tags: ['code'] }]);
  const orchestrator = new Orchestrator({
    agentsDir: tmp, modelPool: pool, policy: { whitelistCommands: null, maxTimeSec: 10 },
    maxRetries: 1, sandboxEnabled: false, gitEnabled: false, branchWorkflow: false,
  });
  await orchestrator.loadAgents();
  deps = {
    orchestrator, pool, taskQueue: { enqueue: async () => ({}) },
    logger: { info() {}, warn() {}, error() {}, debug() {} },
  };
});

afterEach(() => {
  process.chdir(path.join(tmp, '..'));
  fs.rmSync(tmp, { recursive: true, force: true });
  closeBus();
  SPEAKER_RETRY_POLICY.capacityWaitSec = [20, 40];
  SPEAKER_RETRY_POLICY.quickRetryDelayMs = 3000;
});

async function mkDiscussion(members = ['dev', 'test'], extra: { project_id?: string } = {}) {
  return createDiscussion(deps, { title: '明细落盘 demo', members, ...extra });
}

async function mkProject(id = 'p1') {
  const ws = path.join(tmp, id);
  fs.mkdirSync(ws, { recursive: true });
  fs.writeFileSync(path.join(ws, 'package.json'), JSON.stringify({ name: id, scripts: { dev: 'echo serve' } }));
  await saveProject({ id, name: `项目${id}`, workspace: ws, description: '演示项目', created_at: new Date().toISOString() });
  return ws;
}

const agentMsg = (ms: DiscussionMessage[], agent: string) => ms.find((m) => m.from === agent && !m.tool)!;

describe('P1 明细落盘：工具调用与工作过程随消息持久化', () => {
  it('工具活动条带 meta.calls：每条调用有 tool/参数摘要/输出要点，刷新后仍可渲染', async () => {
    const ws = await mkProject();
    const d = await mkDiscussion(['dev'], { project_id: 'p1' });
    fs.writeFileSync(path.join(ws, 'a.txt'), 'hello world\nfoo bar\n');
    h.speaker = (_sys, user) => {
      if (user.includes('工具执行结果')) return okContent('已核实：读到了文件，grep 有命中');
      return JSON.stringify({ tool_calls: [
        { tool: 'exec', command: 'echo detail-test' },
        { tool: 'read_file', path: 'a.txt' },
        { tool: 'grep', pattern: 'foo' },
      ] });
    };
    await runDiscussionRound(deps, d.id);
    const toolMsg = (await getMessages(d.id)).find((m) => m.tool)!;
    expect(toolMsg).toBeTruthy();
    const calls = (toolMsg.meta as any)?.calls as any[];
    expect(Array.isArray(calls)).toBe(true);
    expect(calls).toHaveLength(3);
    expect(calls[0]).toMatchObject({ tool: 'exec', ok: true });
    expect(String(calls[0].args_summary)).toContain('echo detail-test');
    expect(String(calls[0].output_gist)).toContain('exit 0');
    expect(calls[1].tool).toBe('read_file');
    expect(calls[2].tool).toBe('grep');
    expect(String(calls[2].output_gist)).toContain('命中');
    void ws;
  });

  it('发言消息带 meta.detail：evidence/工具调用/技能/提及/模型全链落盘', async () => {
    const d = await mkDiscussion(['dev', 'test']);
    h.speaker = (_sys, user) => (user.includes('「dev」')
      ? okContent('建议用 TypeScript，@test 请评估迁移成本', { evidence: '基于 package.json 无 tsconfig，当前是纯 JS 项目' })
      : JSON.stringify({ speak: false }));
    await runDiscussionRound(deps, d.id);
    const devMsg = agentMsg(await getMessages(d.id), 'dev');
    const detail = (devMsg.meta as any)?.detail;
    expect(detail).toBeTruthy();
    expect(detail.agent).toBe('dev');
    expect(String(detail.evidence)).toContain('tsconfig');
    expect(detail.mentioned).toEqual(['test']);
    expect(detail.model).toBe('fake-model');
    expect(Array.isArray(detail.tool_calls)).toBe(true);
    expect(detail.skills).toContain('code-review-checklist');
  });

  it('evidence 只进详情不进正文（发言正文保持结论）', async () => {
    const d = await mkDiscussion(['dev']);
    h.speaker = () => okContent('结论一句话', { evidence: '依据：grep 命中 3 处' });
    await runDiscussionRound(deps, d.id);
    const devMsg = agentMsg(await getMessages(d.id), 'dev');
    expect(devMsg.text).toContain('结论一句话');
    expect(devMsg.text).not.toContain('grep 命中');
    expect(String((devMsg.meta as any)?.detail?.evidence)).toContain('grep 命中');
  });

  it('成员绑定技能注入身份提示（user 消息身份段）并落 detail.skills', async () => {
    const d = await mkDiscussion(['dev']);
    h.speaker = () => okContent('发言');
    await runDiscussionRound(deps, d.id);
    const call = h.lastSpeakerCalls.find((c) => c.agent === 'dev')!;
    expect(call.sys).toContain('项目规划群组讨论');
    expect(call.user).toContain('code-review-checklist');
    const devMsg = agentMsg(await getMessages(d.id), 'dev');
    expect((devMsg.meta as any)?.detail?.skills).toContain('code-review-checklist');
  });

  it('纯发言（无工具轮）：detail.tool_calls 为空数组，meta 仍落盘', async () => {
    const d = await mkDiscussion(['dev']);
    h.speaker = () => okContent('纯观点发言', { evidence: '基于讨论记录' });
    await runDiscussionRound(deps, d.id);
    const detail = (agentMsg(await getMessages(d.id), 'dev').meta as any)?.detail;
    expect(detail.tool_calls).toEqual([]);
    expect(detail.evidence).toBe('基于讨论记录');
  });

  it('多批工具迭代：detail.tool_calls 累积全部批次记录', async () => {
    const ws = await mkProject();
    const d = await mkDiscussion(['dev'], { project_id: 'p1' });
    h.speaker = (_sys, user) => {
      if (user.includes('工具执行结果（第 1 批）')) return JSON.stringify({ tool_calls: [{ tool: 'exec', command: 'echo batch-1' }] });
      if (user.includes('工具执行结果')) return okContent('两批都跑完了');
      return JSON.stringify({ tool_calls: [{ tool: 'exec', command: 'echo batch-0' }] });
    };
    await runDiscussionRound(deps, d.id);
    const devMsg = agentMsg(await getMessages(d.id), 'dev');
    const calls = (devMsg.meta as any)?.detail?.tool_calls as any[];
    expect(calls.map((c: any) => c.args_summary).join(',')).toContain('batch-0');
    expect(calls.map((c: any) => c.args_summary).join(',')).toContain('batch-1');
    void ws;
  });
});

// ---------- P2-5：转任务带侦查报告 + 分歧上报 ----------
describe('P2-5 侦查报告与分歧上报', () => {
  it('转任务描述携带侦查报告（讨论中的实际排查动作）', async () => {
    await mkProject();
    const d = await mkDiscussion(['dev'], { project_id: 'p1' });
    h.routerSpeakers = ['dev'];
    h.speaker = (_sys, user) => {
      if (user.includes('工具执行结果')) return okContent('定位到了，auth.ts 有问题');
      return JSON.stringify({ tool_calls: [{ tool: 'grep', pattern: 'error', path: 'src' }, { tool: 'read_file', path: 'src/a.ts' }] });
    };
    await runDiscussionRound(deps, d.id);
    h.schemeText = '# 项目规划方案：修登录页\n## 背景与目标\n修好登录页\n## 待定事项\n无';
    await updateDiscussion(d.id, { scheme: h.schemeText });
    let created: string | undefined;
    const spy = vi.spyOn(deps.orchestrator, 'createTask').mockResolvedValue({ taskId: 't-x', graph: { nodes: [], edges: [], summary: '' }, level: 'standard' });
    try {
      await convertToProject(deps, d.id, { target: 'existing', project_id: 'p1' }, (x) => x);
      // restore 前读取（mockRestore 会清空 calls）
      created = spy.mock.calls.at(-1)?.[0] as string | undefined;
    } finally {
      spy.mockRestore();
    }
    expect(created).toContain('[侦查报告');
    expect(created).toContain('pattern=error');
    expect(created).toContain('read_file path=src/a.ts');
  });

  it('同批 ≥2 成员结论冲突 → 分歧上报系统卡 + ask_user 事件', async () => {
    const d = await mkDiscussion(['dev', 'test']);
    h.routerSpeakers = ['dev', 'test'];
    h.speaker = (_sys, user) => (user.includes('「dev」') ? okContent('建议用方案 A') : okContent('我反对，应该用方案 B'));
    h.divergenceConflict = true;
    await runDiscussionRound(deps, d.id);
    const msgs = await getMessages(d.id);
    expect(msgs.some((m) => m.kind === 'card' && m.text.includes('成员间存在分歧'))).toBe(true);
  });

  it('结论互补不报分歧', async () => {
    const d = await mkDiscussion(['dev', 'test']);
    h.routerSpeakers = ['dev', 'test'];
    h.speaker = (_sys, user) => (user.includes('「dev」') ? okContent('后端没问题') : okContent('前端也正常'));
    h.divergenceConflict = false;
    await runDiscussionRound(deps, d.id);
    const msgs = await getMessages(d.id);
    expect(msgs.some((m) => m.text.includes('成员间存在分歧'))).toBe(false);
  });
});
