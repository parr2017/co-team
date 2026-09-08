import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// Mocked LLM behaviors, switched per test. Markers match discussion.ts system prompts:
// speaker=「项目规划群组讨论」, moderator=「判断讨论是否还有必要」, scheme=「收敛为一份结构化」。
const h = vi.hoisted(() => ({
  speaker: null as null | ((sys: string, user: string) => string | Promise<string>),
  moderatorContinue: false,
  schemeText: '',
  lastSchemeUser: '',
  lastSpeakerCalls: [] as { agent: string; user: string }[],
}));

vi.mock('../src/llm', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/llm')>();
  const ok = (content: string) => ({ content, promptTokens: 5, completionTokens: 8 });
  return {
    ...actual,
    chat: async (_entry: any, messages: { role: string; content: string }[]) => {
      const sys = messages.find((m) => m.role === 'system')?.content || '';
      const user = messages.find((m) => m.role === 'user')?.content || '';
      if (sys.includes('判断讨论是否还有必要')) return ok(JSON.stringify({ continue: h.moderatorContinue, reason: 'test' }));
      if (sys.includes('收敛为一份结构化')) {
        h.lastSchemeUser = user;
        return ok(h.schemeText || '# 项目规划方案：demo\n## 背景与目标\nx\n## 待定事项\n无');
      }
      if (sys.includes('项目规划群组讨论')) {
        const m = sys.match(/你是群组讨论中的「(.+?)」Agent/);
        const agent = m ? m[1] : '?';
        h.lastSpeakerCalls.push({ agent, user });
        if (!h.speaker) return ok(JSON.stringify({ speak: false }));
        return ok(await h.speaker(sys, user));
      }
      if (sys.includes('task planner')) {
        return ok(JSON.stringify({ nodes: [{ id: '1', name: '实现方案', agent: 'dev', complexity: 'normal', goal_link: '按方案实现' }], edges: [], summary: 'plan' }));
      }
      return ok(JSON.stringify({ status: 'success', summary: 'done', verification: 'ok', changes: [], errors: [] }));
    },
  };
});

import { initBus, closeBus, getBus, busSet } from '../src/bus';
import { ModelPool } from '../src/scheduler';
import { Orchestrator } from '../src/orchestrator/orchestrator';
import { getProject, getProjectMemory, getAgentMemory, saveProject } from '../src/store';
import { listKnowledge } from '../src/knowledge';
import {
  createDiscussion, DiscussionError, parseMentions, hasPendingUserQuestion, unansweredQuestions,
  getDiscussion, getMessages, runDiscussionRound, runAutoDiscussion, generateScheme, updateDiscussion,
  convertToProject, postUserMessage, isDiscussionBusy,
} from '../src/discussion';
import type { DiscussionMessage } from '../src/discussion';

let tmp: string;
let deps: any;
let capturedEvents: { type: string; payload: Record<string, unknown> }[] = [];

const okContent = (reply: string, extra: Record<string, unknown> = {}) => JSON.stringify({ speak: true, reply, ...extra });

beforeEach(async () => {
  process.env.COTEAM_FORCE_MEMORY = '1';
  closeBus();
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-disc-'));
  for (const name of ['dev', 'test', 'deploy']) {
    const d = path.join(tmp, name);
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, 'agent.yaml'), `name: ${name}\ntags: [code]\nrole: ${name}\n`);
    fs.writeFileSync(path.join(d, 'prompt.md'), `${name} 的专业指令`);
  }
  process.env.COTEAM_KNOWLEDGE_DIR = path.join(tmp, 'kb');
  await initBus({ host: '127.0.0.1', port: 6399, db: 0 });
  capturedEvents = [];
  getBus().subscribe('coteam:dashboard', (m: any) => capturedEvents.push(m));
  h.speaker = null;
  h.moderatorContinue = false;
  h.schemeText = '';
  h.lastSchemeUser = '';
  h.lastSpeakerCalls = [];
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
  fs.rmSync(tmp, { recursive: true, force: true });
  closeBus();
  delete process.env.COTEAM_KNOWLEDGE_DIR;
});

async function mkDiscussion(members = ['dev', 'test']) {
  return createDiscussion(deps, { title: 'demo 规划', members });
}

const nonSystem = (ms: DiscussionMessage[]) => ms.filter((m) => m.from !== 'system');

describe('parseMentions', () => {
  it('collects valid mentions in order, dedupes, flags invalid ones', () => {
    const r = parseMentions('@dev 先看，@test 也看，再 @dev', ['dev', 'test', 'deploy']);
    expect(r.mentioned).toEqual(['dev', 'test']);
    expect(r.invalid).toEqual([]);
    expect(parseMentions('@ghost 在吗', ['dev']).invalid).toEqual(['ghost']);
    expect(parseMentions('无提及', ['dev']).mentioned).toEqual([]);
  });
});

describe('pending user question derivation', () => {
  it('a question is pending until a later user message', () => {
    expect(hasPendingUserQuestion([])).toBe(false);
    const ask: DiscussionMessage = { id: '1', from: 'dev', text: '选 A 还是 B', ts: '2026-09-08 01:00:00', needs_user: true };
    const usr: DiscussionMessage = { id: '2', from: 'user', text: '选 A', ts: '2026-09-08 02:00:00' };
    expect(hasPendingUserQuestion([ask])).toBe(true);
    expect(hasPendingUserQuestion([ask, usr])).toBe(false);
    expect(unansweredQuestions([usr, ask]).map((m) => m.id)).toEqual(['1']);
  });
});

describe('discussion lifecycle', () => {
  it('rejects unknown members and empty rosters', async () => {
    await expect(createDiscussion(deps, { title: 'x', members: ['ghost'] })).rejects.toBeInstanceOf(DiscussionError);
    await expect(createDiscussion(deps, { title: 'x', members: [] })).rejects.toThrow(/成员/);
    await expect(createDiscussion(deps, { title: '', members: ['dev'] })).rejects.toThrow(/title/);
  });

  it('creates with deduped roster, opens with a system message and broadcasts discussion_started', async () => {
    const d = await createDiscussion(deps, { title: 't', members: ['dev', 'dev', 'test'] });
    const stored = await getDiscussion(d.id);
    expect(stored!.members).toEqual(['dev', 'test']);
    expect(stored!.status).toBe('discussing');
    expect((await getMessages(d.id))[0].from).toBe('system');
    expect(capturedEvents.some((e) => e.type === 'discussion_started' && e.payload.discussion_id === d.id)).toBe(true);
  });

  it('user message: invalid @ is a 400 listing valid members; valid @ appends a mention note', async () => {
    const d = await mkDiscussion();
    await expect(postUserMessage(deps, d.id, '@nobody 看')).rejects.toThrow(/有效成员：dev、test/);
    const { mentioned } = await postUserMessage(deps, d.id, '@dev 先看方案');
    expect(mentioned).toEqual(['dev']);
    const msgs = await getMessages(d.id);
    expect(msgs.some((m) => m.from === 'system' && m.text.includes('用户点名 dev'))).toBe(true);
  });
});

describe('round engine: self-decided speaking', () => {
  it('irrelevant agents stay silent; speakers, silent list and system tally are recorded', async () => {
    const d = await mkDiscussion();
    h.speaker = (sys) => (sys.includes('「dev」') ? okContent('建议用 TypeScript 重写', { experience: 'TS 项目禁用 pytest，错栈会空转修复循环' }) : JSON.stringify({ speak: false }));
    const res = await runDiscussionRound(deps, d.id);
    expect(res.speakers).toEqual(['dev']);
    expect(res.silent).toEqual(['test']);
    const msgs = await getMessages(d.id);
    expect(msgs.find((m) => m.from === 'dev')!.text).toContain('TypeScript');
    expect(msgs[msgs.length - 1]).toMatchObject({ from: 'system', text: '第 1 轮 · 发言：dev · 未发言：test' });
  });

  it('deposits experiences to the project knowledge base with discussion source attribution', async () => {
    const d = await mkDiscussion(['dev']);
    h.speaker = () => okContent('发言', { experience: '沙箱重启后不含旧产出，续跑需恢复工作区' });
    await runDiscussionRound(deps, d.id);
    const entries = listKnowledge({});
    expect(entries.length).toBeGreaterThan(0);
    expect(entries[0].source).toBe(`discussion:${d.id}`);
    expect(entries[0].tags).toContain('群组讨论');
    expect((await getAgentMemory('dev', 5)).some((m) => m.includes('沙箱重启'))).toBe(true);
    expect(capturedEvents.some((e) => e.type === 'discussion_experience')).toBe(true);
  });

  it('ask_user marks the message, raises discussion_ask_user and stays pending until the user replies', async () => {
    const d = await mkDiscussion(['dev']);
    h.speaker = () => okContent('两个方向各有利弊', { ask_user: '性能优先还是交付速度优先？' });
    await runDiscussionRound(deps, d.id);
    const msgs = await getMessages(d.id);
    const devMsg = msgs.find((m) => m.from === 'dev')!;
    expect(devMsg.needs_user).toBe(true);
    expect(devMsg.text).toContain('【需要你拍板】性能优先还是交付速度优先？');
    expect(hasPendingUserQuestion(msgs)).toBe(true);
    expect(capturedEvents.some((e) => e.type === 'discussion_ask_user')).toBe(true);
    await postUserMessage(deps, d.id, '性能优先');
    expect(hasPendingUserQuestion(await getMessages(d.id))).toBe(false);
  });

  it('@-forced agent must speak even when it first chose silence (one nudge retry)', async () => {
    const d = await mkDiscussion();
    h.speaker = (sys, user) => {
      if (!sys.includes('「dev」')) return JSON.stringify({ speak: false });
      if (user.includes('必须给出实质性发言')) return okContent('被点名后给出的实质观点');
      return JSON.stringify({ speak: false });
    };
    const { mentioned } = await postUserMessage(deps, d.id, '@dev 你怎么看');
    const res = await runDiscussionRound(deps, d.id, { forced: mentioned });
    expect(res.speakers).toContain('dev');
    expect((await getMessages(d.id)).find((m) => m.from === 'dev')!.text).toContain('被点名后');
    expect(h.lastSpeakerCalls.filter((c) => c.agent === 'dev').length).toBe(2);
  });

  it('a failed LLM call degrades to honest silence, never a fabricated reply', async () => {
    const d = await mkDiscussion();
    h.speaker = (sys) => {
      if (sys.includes('「test」')) throw new Error('upstream 504');
      return okContent('正常发言');
    };
    const res = await runDiscussionRound(deps, d.id);
    expect(res.speakers).toEqual(['dev']);
    expect(res.silent).toEqual(['test']);
    expect(nonSystem(await getMessages(d.id)).some((m) => m.from === 'test')).toBe(false);
  });

  it('busy lock rejects a concurrent round with 409 (held lock + in-flight round)', async () => {
    const d = await mkDiscussion(['dev']);
    // deterministic: an externally held lock is rejected immediately
    await busSet(`discussion:${d.id}:busy`, Date.now());
    expect(await isDiscussionBusy(d.id)).toBe(true);
    await expect(runDiscussionRound(deps, d.id)).rejects.toMatchObject({ status: 409 });
    await busSet(`discussion:${d.id}:busy`, 1);
    expect(await isDiscussionBusy(d.id)).toBe(false);

    // live round: lock visible while in flight, released after
    h.speaker = () => new Promise<string>((r) => setTimeout(() => r(okContent('慢发言')), 200));
    const p = runDiscussionRound(deps, d.id);
    await vi.waitFor(() => expect(h.lastSpeakerCalls.length).toBeGreaterThan(0));
    expect(await isDiscussionBusy(d.id)).toBe(true);
    await expect(runDiscussionRound(deps, d.id)).rejects.toMatchObject({ status: 409 });
    await p;
    expect(await isDiscussionBusy(d.id)).toBe(false);
  });

  it('unparseable forced output gets an honest notice, not a made-up answer', async () => {
    const d = await mkDiscussion(['dev']);
    h.speaker = () => '这里不是 JSON';
    const res = await runDiscussionRound(deps, d.id, { forced: ['dev'] });
    expect(res.speakers).not.toContain('dev');
    expect((await getMessages(d.id)).some((m) => m.from === 'dev' && m.text.includes('无法解析'))).toBe(true);
  });
});

describe('auto mode loop', () => {
  it('moderator stop ends after one round; moderator continue runs up to 3 rounds', async () => {
    const d1 = await mkDiscussion(['dev']);
    h.speaker = () => okContent('观点');
    h.moderatorContinue = false;
    await runAutoDiscussion(deps, d1.id);
    expect((await getMessages(d1.id)).filter((m) => m.from === 'dev').length).toBe(1);

    const d2 = await mkDiscussion(['dev']);
    h.moderatorContinue = true;
    await runAutoDiscussion(deps, d2.id);
    expect((await getMessages(d2.id)).filter((m) => m.from === 'dev').length).toBe(3);
  });

  it('all-silent round terminates the loop with a hint', async () => {
    const d = await mkDiscussion(['dev', 'test']);
    h.speaker = () => JSON.stringify({ speak: false });
    await runAutoDiscussion(deps, d.id);
    const msgs = await getMessages(d.id);
    expect(msgs.some((m) => m.from === 'system' && m.text.includes('全员沉默'))).toBe(true);
    expect(nonSystem(msgs).filter((m) => m.from !== 'user')).toHaveLength(0);
  });

  it('an ask_user pauses the loop until the user answers', async () => {
    const d = await mkDiscussion(['dev']);
    h.speaker = () => okContent('需要拍板', { ask_user: '选 A 还是 B？' });
    h.moderatorContinue = true;
    await runAutoDiscussion(deps, d.id);
    const msgs = await getMessages(d.id);
    expect(nonSystem(msgs).filter((m) => m.from === 'dev').length).toBe(1);
    expect(msgs.some((m) => m.from === 'system' && m.text.includes('等待你的回答'))).toBe(true);
    // user answers → the next manual/auto trigger can continue
    await postUserMessage(deps, d.id, '选 A');
    expect(hasPendingUserQuestion(await getMessages(d.id))).toBe(false);
  });

  it('stop flag breaks the loop between rounds', async () => {
    const d = await mkDiscussion(['dev']);
    let calls = 0;
    h.speaker = () => {
      calls += 1;
      // request stop during round 1 → loop must not start round 2
      void busSet(`discussion:${d.id}:stop`, 1);
      return okContent('继续');
    };
    h.moderatorContinue = true;
    await runAutoDiscussion(deps, d.id);
    expect(nonSystem(await getMessages(d.id)).filter((m) => m.from === 'dev').length).toBe(1);
  });
});

describe('scheme generation & editing', () => {
  it('refuses to converge on <2 substantive messages', async () => {
    const d = await mkDiscussion(['dev']);
    await expect(generateScheme(deps, d.id)).rejects.toThrow(/讨论内容太少/);
  });

  it('converges into a structured scheme, bumps version, lists pending questions in the prompt', async () => {
    const d = await mkDiscussion(['dev']);
    await postUserMessage(deps, d.id, '方向：先做会员系统');
    h.speaker = () => okContent('方向性建议', { ask_user: '预算上限多少？' });
    await runDiscussionRound(deps, d.id);
    const disc = await generateScheme(deps, d.id);
    expect(disc.scheme).toContain('# 项目规划方案');
    expect(disc.scheme_version).toBe(1);
    expect(disc.status).toBe('converged');
    expect(h.lastSchemeUser).toContain('预算上限多少');
    expect(capturedEvents.some((e) => e.type === 'discussion_scheme_updated')).toBe(true);

    const edited = await updateDiscussion(d.id, { scheme: '# 项目规划方案（人工修订）', mode: 'auto' });
    expect(edited.scheme_version).toBe(2);
    expect(edited.mode).toBe('auto');
  });
});

describe('convert scheme → project + dev task', () => {
  const validateWs = (ws: string) => {
    if (!path.isAbsolute(ws)) throw new DiscussionError(400, 'workspace must be absolute');
    return ws;
  };

  // capture what convert hands to the orchestrator instead of running the real
  // background planner (its async tail would outlive closeBus between tests).
  // The stub mirrors createTask(planAsync): a 'pending' graph lands immediately.
  let createCalls: { description: string; workspace: string; projectId?: string; opts?: any }[] = [];
  function stubCreateTask() {
    createCalls = [];
    (deps.orchestrator as any).createTask = async (description: string, workspace: string, projectId?: string, opts?: any) => {
      createCalls.push({ description, workspace, projectId, opts });
      const { saveTaskGraph } = await import('../src/store');
      await saveTaskGraph('tk-stub', [], [], { description, workspace, status: 'pending', project_id: projectId });
      return { taskId: 'tk-stub', graph: { nodes: [], edges: [], summary: '' }, level: 'standard' };
    };
  }

  async function convergedDiscussion(projectId?: string) {
    const d = await createDiscussion(deps, { title: '会员系统', members: ['dev'], project_id: projectId });
    await postUserMessage(deps, d.id, '做个会员系统');
    h.speaker = () => okContent('建议 PostgreSQL + JWT 鉴权');
    await runDiscussionRound(deps, d.id);
    await generateScheme(deps, d.id);
    return d;
  }

  it('refuses to convert without a scheme, or twice', async () => {
    stubCreateTask();
    const d = await mkDiscussion(['dev']);
    await expect(convertToProject(deps, d.id, { target: 'existing', project_id: 'nope' }, validateWs)).rejects.toThrow(/先生成项目规划方案/);
    const c = await convergedDiscussion();
    await convertToProject(deps, c.id, { target: 'new', name: 'p1', workspace: path.join(tmp, 'p1') }, validateWs);
    await expect(convertToProject(deps, c.id, { target: 'new', name: 'p2', workspace: path.join(tmp, 'p2') }, validateWs)).rejects.toThrow(/重复/);
  });

  it('creates a new project, deposits the scheme into project knowledge/memory and plans the task without re-clarifying', async () => {
    stubCreateTask();
    const c = await convergedDiscussion();
    const ws = path.join(tmp, 'newproj');
    fs.mkdirSync(ws, { recursive: true });
    const res = await convertToProject(deps, c.id, { target: 'new', name: '会员系统', workspace: ws, scaffold: false }, validateWs);
    const proj = await getProject(res.project_id);
    expect(proj!.name).toBe('会员系统');
    expect(proj!.workspace).toBe(ws);
    const disc = await getDiscussion(c.id);
    expect(disc!.status).toBe('converted');
    expect(disc!.task_id).toBe('tk-stub');
    // discussion IS the clarification: skip it, plan in background, land in project
    expect(createCalls).toHaveLength(1);
    expect(createCalls[0].opts.skipClarification).toBe(true);
    expect(createCalls[0].opts.planAsync).toBe(true);
    expect(createCalls[0].projectId).toBe(res.project_id);
    // task description carries the scheme + provenance note
    expect(createCalls[0].description).toContain('# 项目规划方案');
    expect(createCalls[0].description).toContain('[来源]');
    // scheme landed in the project knowledge category + project memory
    const kn = listKnowledge({ category: 'project', project_id: res.project_id });
    expect(kn.some((e) => e.title.includes('项目规划方案：会员系统'))).toBe(true);
    expect((await getProjectMemory(res.project_id)).some((m) => m.text.includes('定稿'))).toBe(true);
    expect(capturedEvents.some((e) => e.type === 'discussion_converted')).toBe(true);
  });

  it('auto_run enqueues the created task', async () => {
    stubCreateTask();
    const c = await convergedDiscussion();
    const enqueued: string[] = [];
    const deps2 = { ...deps, taskQueue: { enqueue: async (taskId: string) => { enqueued.push(taskId); return {}; } } };
    const res = await convertToProject(deps2, c.id, { target: 'new', name: 'p-auto', workspace: path.join(tmp, 'p-auto'), auto_run: true }, validateWs);
    // the stub never plans in background → the waiter keeps polling; enqueue for a
    // planAsync task happens once the graph reaches 'planned', so feed it manually
    const { saveTaskGraph } = await import('../src/store');
    await saveTaskGraph(res.task_id, [], [], { description: 'x', workspace: 'w', status: 'planned', project_id: res.project_id });
    await vi.waitFor(() => expect(enqueued).toEqual(['tk-stub']), { timeout: 5000 });
  });

  it('existing project target validates membership and keeps the discussion bound', async () => {
    stubCreateTask();
    const ws = path.join(tmp, 'exproj');
    fs.mkdirSync(ws, { recursive: true });
    await saveProject({ id: 'ex1', name: '已有项目', workspace: ws, created_at: new Date().toISOString() });
    // unknown existing project fails before any conversion happens
    const g = await convergedDiscussion();
    await expect(convertToProject(deps, g.id, { target: 'existing', project_id: 'ghost' }, validateWs)).rejects.toThrow(/ghost/);
    const c = await convergedDiscussion();
    const res = await convertToProject(deps, c.id, { target: 'existing', project_id: 'ex1' }, validateWs);
    expect(res.project_id).toBe('ex1');
    expect((await getDiscussion(c.id))!.project_id).toBe('ex1');
  });
});
