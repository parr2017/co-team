import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// Mocked LLM behaviors, switched per test. Markers match discussion.ts system prompts:
// speaker=「项目规划群组讨论」, moderator=「判断讨论是否还有必要」, router=「群聊调度路由器」,
// scheme=「收敛为一份结构化」。发言者身份现在在 user 消息里（共享 system 前缀换缓存）。
const h = vi.hoisted(() => ({
  speaker: null as null | ((sys: string, user: string) => string | Promise<string>),
  moderatorContinue: false,
  /** null → router returns all members (legacy behavior); 'throw' → router failure fallback test */
  routerSpeakers: null as null | string[] | 'throw',
  schemeText: '',
  lastSchemeUser: '',
  lastSpeakerCalls: [] as { agent: string; sys: string; user: string }[],
  lastRouterCalls: [] as { user: string }[],
}));

vi.mock('../src/llm', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/llm')>();
  const ok = (content: string) => ({ content, promptTokens: 5, completionTokens: 8 });
  return {
    ...actual,
    chat: async (_entry: any, messages: { role: string; content: string }[]) => {
      const sys = messages.find((m) => m.role === 'system')?.content || '';
      const userAll = messages.filter((m) => m.role === 'user').map((m) => m.content).join('\n\n');
      if (sys.includes('判断讨论是否还有必要')) return ok(JSON.stringify({ continue: h.moderatorContinue, reason: 'test' }));
      if (sys.includes('群聊调度路由器')) {
        h.lastRouterCalls.push({ user: userAll });
        if (h.routerSpeakers === 'throw') throw new Error('router down');
        const m = sys.match(/可选成员：([^\n]+)/);
        const all = m ? m[1].split('、').map((s) => s.trim()).filter(Boolean) : [];
        return ok(JSON.stringify({ speakers: h.routerSpeakers ?? all, reason: 'test' }));
      }
      if (sys.includes('收敛为一份结构化')) {
        h.lastSchemeUser = userAll;
        return ok(h.schemeText || '# 项目规划方案：demo\n## 背景与目标\nx\n## 待定事项\n无');
      }
      if (sys.includes('项目规划群组讨论')) {
        const m = userAll.match(/你是群组讨论中的「(.+?)」Agent/);
        const agent = m ? m[1] : '?';
        h.lastSpeakerCalls.push({ agent, sys, user: userAll });
        if (!h.speaker) return ok(JSON.stringify({ speak: false }));
        return ok(await h.speaker(sys, userAll));
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
import { getProject, getProjectMemory, getAgentMemory, saveProject, addProjectMemory } from '../src/store';
import { listKnowledge, writeKnowledge } from '../src/knowledge';
import {
  createDiscussion, DiscussionError, parseMentions, hasPendingUserQuestion, unansweredQuestions,
  getDiscussion, getMessages, runDiscussionRound, runAutoDiscussion, runResponseLoop, generateScheme, updateDiscussion,
  convertToProject, postUserMessage, isDiscussionBusy, extractReplyStreaming,
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
    fs.writeFileSync(path.join(d, 'agent.yaml'), `name: ${name}\ntags: [code]\nrole: ${name === 'dev' ? '开发工程师' : name === 'deploy' ? '发布工程师' : name}\n`);
    fs.writeFileSync(path.join(d, 'prompt.md'), `${name} 的专业指令`);
  }
  process.env.COTEAM_KNOWLEDGE_DIR = path.join(tmp, 'kb');
  await initBus({ host: '127.0.0.1', port: 6399, db: 0 });
  capturedEvents = [];
  getBus().subscribe('coteam:dashboard', (m: any) => capturedEvents.push(m));
  h.speaker = null;
  h.moderatorContinue = false;
  h.routerSpeakers = null;
  h.schemeText = '';
  h.lastSchemeUser = '';
  h.lastSpeakerCalls = [];
  h.lastRouterCalls = [];
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

async function mkDiscussion(members = ['dev', 'test'], extra: { project_id?: string } = {}) {
  return createDiscussion(deps, { title: 'demo 规划', members, ...extra });
}

/** a saved project whose workspace is a real temp dir (for tool/exec tests) */
async function mkProject(id = 'p1') {
  const ws = path.join(tmp, id);
  fs.mkdirSync(ws, { recursive: true });
  fs.writeFileSync(path.join(ws, 'package.json'), JSON.stringify({ name: id, scripts: { dev: 'echo serve' } }));
  await saveProject({ id, name: `项目${id}`, workspace: ws, description: '演示项目', created_at: new Date().toISOString() });
  return ws;
}

const nonSystem = (ms: DiscussionMessage[]) => ms.filter((m) => m.from !== 'system');
const plainAgentMsgs = (ms: DiscussionMessage[], agent: string) => ms.filter((m) => m.from === agent && !m.tool);

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

describe('extractReplyStreaming', () => {
  it('extracts the reply field incrementally, decoding escapes; null before the key appears', () => {
    expect(extractReplyStreaming('{"speak": tr')).toBeNull();
    expect(extractReplyStreaming('{"speak": true, "rep')).toBeNull();
    let r = extractReplyStreaming('{"speak": true, "reply": "你好');
    expect(r).toEqual({ value: '你好', done: false });
    r = extractReplyStreaming('{"speak": true, "reply": "你好\\n世界"}');
    expect(r).toEqual({ value: '你好\n世界', done: true });
    r = extractReplyStreaming('{"speak": true, "reply": "带\\"引号\\"和\\\\反斜杠"}');
    expect(r!.value).toBe('带"引号"和\\反斜杠');
    r = extractReplyStreaming('{"speak": true, "reply": "\\u4e2d');
    expect(r).toEqual({ value: '中', done: false });
    // tool-call shape has no reply key at all
    expect(extractReplyStreaming('{"tool_calls":[{"tool":"exec","command":"ls"}]}')).toBeNull();
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

  it('user message: invalid @ is a 400 listing valid members; mention no longer spams a system note', async () => {
    const d = await mkDiscussion();
    await expect(postUserMessage(deps, d.id, '@nobody 看')).rejects.toThrow(/有效成员：dev、test/);
    const { mentioned } = await postUserMessage(deps, d.id, '@dev 先看方案');
    expect(mentioned).toEqual(['dev']);
    const msgs = await getMessages(d.id);
    expect(msgs.some((m) => m.from === 'system' && m.text.includes('点名'))).toBe(false);
    expect(msgs.find((m) => m.from === 'user')!.mentioned).toEqual(['dev']);
  });

  it('reply_to attaches a quote; unknown reply_to is a 400', async () => {
    const d = await mkDiscussion(['dev']);
    const { message } = await postUserMessage(deps, d.id, '第一条');
    const { message: second } = await postUserMessage(deps, d.id, '回复它', { reply_to: message!.id });
    expect(second!.reply_to).toBe(message!.id);
    await expect(postUserMessage(deps, d.id, 'x', { reply_to: 'ghost' })).rejects.toThrow(/不存在/);
  });

  it('emoji reaction mutates the target message without appending one', async () => {
    const d = await mkDiscussion(['dev']);
    h.speaker = () => okContent('dev 的观点');
    await runDiscussionRound(deps, d.id);
    const before = await getMessages(d.id);
    const target = before.find((m) => m.from === 'dev')!;
    const { message } = await postUserMessage(deps, d.id, '', { react_to: target.id, emoji: '👍' });
    expect(message).toBeNull();
    const after = await getMessages(d.id);
    expect(after.find((m) => m.id === target.id)!.reactions).toEqual({ '👍': ['user'] });
    expect(after.length).toBe(before.length); // reaction mutates in place, no new message
    expect(capturedEvents.some((e) => e.type === 'discussion_reacted' && e.payload.message_id === target.id)).toBe(true);
    await expect(postUserMessage(deps, d.id, '')).rejects.toThrow(/required/);
  });
});

describe('router: dynamic speakers replace full rotation', () => {
  it('only router-picked members are invoked; unpicked ones never get a call', async () => {
    const d = await mkDiscussion();
    h.routerSpeakers = ['test'];
    h.speaker = () => okContent('我有新想法');
    const res = await runDiscussionRound(deps, d.id);
    expect(res.speakers).toEqual(['test']);
    expect(h.lastSpeakerCalls.map((c) => c.agent)).toEqual(['test']);
    expect(h.lastRouterCalls).toHaveLength(1);
  });

  it('@-mention is a mention-only round (others cannot chime in; router not even consulted)', async () => {
    const d = await mkDiscussion();
    h.speaker = () => okContent('都会说');
    const { mentioned } = await postUserMessage(deps, d.id, '@dev 你来，其他人不要发言');
    const res = await runDiscussionRound(deps, d.id, { forced: mentioned });
    expect(res.speakers).toEqual(['dev']);
    expect(h.lastSpeakerCalls.map((c) => c.agent)).toEqual(['dev']);
    expect(h.lastRouterCalls).toHaveLength(0);
  });

  it('empty router selection converges the round as all_silent (no wasted LLM trips)', async () => {
    const d = await mkDiscussion();
    h.routerSpeakers = [];
    const res = await runDiscussionRound(deps, d.id);
    expect(res.all_silent).toBe(true);
    expect(h.lastSpeakerCalls).toHaveLength(0);
  });

  it('router failure falls back to the legacy full rotation', async () => {
    const d = await mkDiscussion();
    h.routerSpeakers = 'throw';
    h.speaker = () => okContent('回退轮也照说');
    const res = await runDiscussionRound(deps, d.id);
    expect(res.speakers.sort()).toEqual(['dev', 'test']);
    expect((await getMessages(d.id)).at(-1)!.from).toBe('test');
  });
});

describe('round engine: speak-or-silent with real tools', () => {
  it('irrelevant agents stay silent; NO per-round tally stamp is written anymore', async () => {
    const d = await mkDiscussion();
    h.speaker = (sys, user) => (user.includes('「dev」') ? okContent('建议用 TypeScript 重写', { experience: 'TS 项目禁用 pytest，错栈会空转修复循环' }) : JSON.stringify({ speak: false }));
    const res = await runDiscussionRound(deps, d.id);
    expect(res.speakers).toEqual(['dev']);
    expect(res.silent).toEqual(['test']);
    const msgs = await getMessages(d.id);
    expect(msgs.find((m) => m.from === 'dev')!.text).toContain('TypeScript');
    expect(msgs.some((m) => m.from === 'system' && /^第 \d+ 轮/.test(m.text))).toBe(false);
  });

  it('exec + write_file tool round: results execute for real, activity line lands in the transcript', async () => {
    const ws = await mkProject();
    const d = await mkDiscussion(['dev'], { project_id: 'p1' });
    h.speaker = (_sys, user) => {
      if (user.includes('工具执行结果')) return okContent('已核实：echo 输出 hello；a.txt 已写入 3 行');
      return JSON.stringify({ tool_calls: [
        { tool: 'exec', command: 'echo hello' },
        { tool: 'write_file', path: 'a.txt', content: 'x\ny\nz' },
      ] });
    };
    const res = await runDiscussionRound(deps, d.id);
    expect(res.speakers).toEqual(['dev']);
    expect(fs.existsSync(path.join(ws, 'a.txt'))).toBe(true);
    const msgs = await getMessages(d.id);
    const toolLine = msgs.find((m) => m.tool);
    expect(toolLine).toBeTruthy();
    expect(toolLine!.text).toContain('🔧');
    expect(toolLine!.text).toContain('exit 0');
    expect(toolLine!.text).toContain('写入 a.txt');
    const evt = capturedEvents.find((e) => e.type === 'discussion_tool');
    expect((evt!.payload.results as any[])[0]).toMatchObject({ tool: 'exec', returncode: 0 });
    expect((evt!.payload.results as any[])[1]).toMatchObject({ tool: 'write_file', ok: true });
    expect(plainAgentMsgs(msgs, 'dev').at(-1)!.text).toContain('已核实');
  });

  it('small-change budget: 4th file in one turn is refused with a convert-to-task hint', async () => {
    const ws = await mkProject();
    const d = await mkDiscussion(['dev'], { project_id: 'p1' });
    h.speaker = (_sys, user) => {
      if (user.includes('工具执行结果')) return okContent('预算内改了 3 个文件，第 4 个转任务');
      return JSON.stringify({ tool_calls: [
        { tool: 'write_file', path: 'f1.txt', content: 'a' },
        { tool: 'write_file', path: 'f2.txt', content: 'b' },
        { tool: 'write_file', path: 'f3.txt', content: 'c' },
        { tool: 'write_file', path: 'f4.txt', content: 'd' },
      ] });
    };
    await runDiscussionRound(deps, d.id);
    expect(fs.existsSync(path.join(ws, 'f3.txt'))).toBe(true);
    expect(fs.existsSync(path.join(ws, 'f4.txt'))).toBe(false);
    const evt = capturedEvents.find((e) => e.type === 'discussion_tool');
    expect(String((evt!.payload.results as any[])[3].error)).toContain('转项目');
  });

  it('jail: outside paths and traversal are refused outright', async () => {
    const ws = await mkProject();
    const d = await mkDiscussion(['dev'], { project_id: 'p1' });
    h.speaker = (_sys, user) => {
      if (user.includes('工具执行结果')) return okContent('越界操作被拒绝，如实汇报');
      return JSON.stringify({ tool_calls: [
        { tool: 'write_file', path: '../evil.txt', content: 'x' },
        { tool: 'exec', command: `type ${path.join(os.tmpdir(), 'secret.txt')}` },
      ] });
    };
    await runDiscussionRound(deps, d.id);
    expect(fs.existsSync(path.join(tmp, 'evil.txt'))).toBe(false);
    const evt = capturedEvents.find((e) => e.type === 'discussion_tool');
    expect(String((evt!.payload.results as any[])[0].error)).toContain('相对路径');
    expect(String((evt!.payload.results as any[])[1].error)).toContain('路径越界');
    void ws;
  });

  it('unbound discussion: tools return guidance, no filesystem access', async () => {
    const d = await mkDiscussion(['dev']);
    h.speaker = (_sys, user) => {
      if (user.includes('工具执行结果')) return okContent('未绑定项目，动不了手，建议挂接项目');
      return JSON.stringify({ tool_calls: [{ tool: 'exec', command: 'echo hi' }] });
    };
    await runDiscussionRound(deps, d.id);
    const evt = capturedEvents.find((e) => e.type === 'discussion_tool');
    expect(String((evt!.payload.results as any[])[0].error)).toContain('未绑定项目');
  });

  it('deposits experiences to the knowledge base with discussion source attribution', async () => {
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

  it('same experience stated twice in one discussion is not re-deposited (dedup)', async () => {
    const d = await mkDiscussion(['dev']);
    h.speaker = () => okContent('发言', { experience: 'UniApp H5 首次冷启动需要编译预热，健康检查阈值应放宽' });
    await runDiscussionRound(deps, d.id);
    await runDiscussionRound(deps, d.id);
    await runDiscussionRound(deps, d.id);
    const entries = listKnowledge({}).filter((e) => e.source === `discussion:${d.id}`);
    expect(entries).toHaveLength(1);
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
    h.speaker = (_sys, user) => {
      if (!user.includes('「dev」')) return JSON.stringify({ speak: false });
      if (user.includes('必须给出实质性发言')) return okContent('被点名后给出的实质观点');
      return JSON.stringify({ speak: false });
    };
    const { mentioned } = await postUserMessage(deps, d.id, '@dev 你怎么看');
    const res = await runDiscussionRound(deps, d.id, { forced: mentioned });
    expect(res.speakers).toContain('dev');
    expect(plainAgentMsgs(await getMessages(d.id), 'dev').at(-1)!.text).toContain('被点名后');
    expect(h.lastSpeakerCalls.filter((c) => c.agent === 'dev').length).toBe(2);
  });

  it('a failed LLM call is surfaced as a visible notice (honest silence, never a fabricated reply)', async () => {
    const d = await mkDiscussion();
    h.speaker = (_sys, user) => {
      if (user.includes('「test」')) throw new Error('upstream 504');
      return okContent('正常发言');
    };
    const res = await runDiscussionRound(deps, d.id);
    expect(res.speakers).toEqual(['dev']);
    expect(res.silent).toEqual(['test']);
    expect(nonSystem(await getMessages(d.id)).some((m) => m.from === 'test')).toBe(false);
    const msgs = await getMessages(d.id);
    expect(msgs.some((m) => m.from === 'system' && m.kind === 'notice' && m.text.includes('「test」本轮发言未完成') && m.text.includes('upstream 504'))).toBe(true);
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

  it('unparseable forced output gets an honest in-chat notice, not a made-up answer', async () => {
    const d = await mkDiscussion(['dev']);
    h.speaker = () => '这里不是 JSON';
    const res = await runDiscussionRound(deps, d.id, { forced: ['dev'] });
    expect((await getMessages(d.id)).some((m) => m.from === 'dev' && m.text.includes('无法解析'))).toBe(true);
    expect(res.asked_user).toEqual([]);
  });
});

describe('mid-round interruption (真打断)', () => {
  it('a user message posted while a speaker is busy cuts the remaining speakers and re-routes', async () => {
    const d = await mkDiscussion(['dev', 'test']);
    h.routerSpeakers = ['dev', 'test'];
    let devSaid = false;
    h.speaker = async (_sys, user) => {
      if (user.includes('「dev」')) {
        if (!devSaid) {
          devSaid = true;
          // 用户中途插话（API 层不再 409，直接入库）
          await postUserMessage(deps, d.id, '@test 直接回答端口问题');
          return okContent('dev 的开场');
        }
        return okContent('dev 第二轮');
      }
      return okContent('test 的补充');
    };
    // manual mode trigger loop: round 1 interrupted before test speaks → round 2 mentions test only
    await runResponseLoop(deps, d.id, { forced: undefined, auto: false });
    const msgs = await getMessages(d.id);
    const testMsgs = plainAgentMsgs(msgs, 'test');
    // test 没在被打断的那一轮开口，且新指示点名它后开口
    expect(testMsgs.length).toBeGreaterThan(0);
    expect(testMsgs.every((m) => (m.round || 0) >= 2)).toBe(true);
    // mention-only routing on the follow-up round
    expect(h.lastSpeakerCalls.filter((c) => c.agent === 'dev').length).toBeLessThanOrEqual(2);
  });
});

describe('project context injection (全量背景+经验静态前缀)', () => {
  it('binds real workspace path + ALL memories/knowledge into a shared static prefix', async () => {
    const ws = await mkProject();
    for (let i = 1; i <= 12; i++) await addProjectMemory('p1', `项目约定第${i}条：编号规范 v${i}`);
    writeKnowledge({ title: '部署端口纪律', content: 'accountapp 必须跑在 5123', category: 'project', project_id: 'p1', source: 'test' });
    writeKnowledge({ title: '包管理器选择', content: '禁用 yarn，只用 npm', category: 'project', project_id: 'p1', source: 'test' });
    const d = await mkDiscussion(['dev', 'test'], { project_id: 'p1' });
    h.speaker = () => okContent('收到背景');
    await runDiscussionRound(deps, d.id);
    const sys = h.lastSpeakerCalls[0].sys;
    expect(sys).toContain(ws);                        // 真实绝对路径（禁编造的锚点）
    expect(sys).toContain('部署端口纪律');             // 知识库全量而非 top-3
    expect(sys).toContain('包管理器选择');
    for (let i = 1; i <= 12; i++) expect(sys).toContain(`编号规范 v${i}`); // 记忆全量而非 10 条
    expect(sys).toContain('npm run dev');             // package.json scripts
    // 静态前缀：同轮不同成员的 system 消息逐字一致（前缀缓存的前提）
    expect(h.lastSpeakerCalls[1].sys).toBe(sys);
    // 身份在 user 消息里（成员间唯一分叉点，位于共享前缀之后）
    expect(h.lastSpeakerCalls[0].user).toContain('「dev」');
    expect(h.lastSpeakerCalls[1].user).toContain('「test」');
  });
});

describe('auto mode loop', () => {
  it('moderator stop ends after one round; moderator continue runs up to 3 rounds', async () => {
    const d1 = await mkDiscussion(['dev']);
    h.speaker = () => okContent('观点');
    h.moderatorContinue = false;
    await runAutoDiscussion(deps, d1.id);
    expect(plainAgentMsgs(await getMessages(d1.id), 'dev').length).toBe(1);

    const d2 = await mkDiscussion(['dev']);
    h.moderatorContinue = true;
    await runAutoDiscussion(deps, d2.id);
    expect(plainAgentMsgs(await getMessages(d2.id), 'dev').length).toBe(3);
  });

  it('all-silent round terminates the loop with a hint', async () => {
    const d = await mkDiscussion(['dev', 'test']);
    h.speaker = () => JSON.stringify({ speak: false });
    await runAutoDiscussion(deps, d.id);
    const msgs = await getMessages(d.id);
    expect(msgs.some((m) => m.from === 'system' && m.text.includes('暂无新进展'))).toBe(true);
    expect(nonSystem(msgs).filter((m) => m.from !== 'user')).toHaveLength(0);
  });

  it('an ask_user pauses the loop until the user answers', async () => {
    const d = await mkDiscussion(['dev']);
    h.speaker = () => okContent('需要拍板', { ask_user: '选 A 还是 B？' });
    h.moderatorContinue = true;
    await runAutoDiscussion(deps, d.id);
    const msgs = await getMessages(d.id);
    expect(plainAgentMsgs(msgs, 'dev').length).toBe(1);
    expect(msgs.some((m) => m.from === 'system' && m.text.includes('等待你的回答'))).toBe(true);
    // user answers → the next manual/auto trigger can continue
    await postUserMessage(deps, d.id, '选 A');
    expect(hasPendingUserQuestion(await getMessages(d.id))).toBe(false);
  });

  it('stop flag breaks the loop between rounds', async () => {
    const d = await mkDiscussion(['dev']);
    h.speaker = () => {
      // request stop during round 1 → loop must not start round 2
      void busSet(`discussion:${d.id}:stop`, 1);
      return okContent('继续');
    };
    h.moderatorContinue = true;
    await runAutoDiscussion(deps, d.id);
    expect(plainAgentMsgs(await getMessages(d.id), 'dev').length).toBe(1);
  });
});

describe('convert_to_project tool (agent 自己转任务)', () => {
  it('bound discussion: scheme auto-generated, task created, discussion sealed', async () => {
    await mkProject();
    const createCalls: any[] = [];
    (deps.orchestrator as any).createTask = async (description: string, workspace: string, projectId?: string, opts?: any) => {
      createCalls.push({ description, workspace, projectId, opts });
      const { saveTaskGraph } = await import('../src/store');
      await saveTaskGraph('tk-cv', [], [], { description, workspace, status: 'pending', project_id: projectId });
      return { taskId: 'tk-cv', graph: { nodes: [], edges: [], summary: '' }, level: 'standard' };
    };
    const d = await mkDiscussion(['dev'], { project_id: 'p1' });
    await postUserMessage(deps, d.id, 'UI 是占位符，补全四页面并对接 dataService');
    // 第一轮垫一条实质发言（generateScheme 要求 ≥2 条实质消息）
    h.speaker = () => okContent('UI 层缺失，建议转任务补全');
    await runDiscussionRound(deps, d.id);
    h.speaker = async (_sys, user) => {
      if (user.includes('工具执行结果')) return okContent('已转开发任务 tk-cv，UI 补全由执行团队接手');
      return JSON.stringify({ tool_calls: [{ tool: 'convert_to_project', auto_run: true }] });
    };
    await runDiscussionRound(deps, d.id);
    expect(createCalls).toHaveLength(1);
    expect(createCalls[0].opts.skipClarification).toBe(true);
    const disc = await getDiscussion(d.id);
    expect(disc!.status).toBe('converted');
    expect(disc!.task_id).toBe('tk-cv');
    const msgs = await getMessages(d.id);
    expect(msgs.some((m) => m.tool && m.text.includes('转项目开发任务 tk-cv'))).toBe(true);
    expect(plainAgentMsgs(msgs, 'dev').at(-1)!.text).toContain('tk-cv');
    // 封存后不能再发言
    await expect(runDiscussionRound(deps, d.id)).rejects.toThrow(/转为项目/);
  });
});

describe('commitment follow-up (承诺式收尾自动追问)', () => {
  it('speaker that promises action without tools gets a forced follow-up round', async () => {
    const d = await mkDiscussion(['dev']);
    let calls = 0;
    h.speaker = (_sys, user) => {
      calls += 1;
      if (calls === 1) return okContent('收到，我正式启动 UI 开发任务，分四步补全页面。');
      expect(user).toContain('追问');
      return okContent('如实说明：补全四页面超出群内小改预算，请在界面点「转为项目开发」入队执行。');
    };
    await runResponseLoop(deps, d.id, { forced: undefined, auto: false });
    expect(calls).toBe(2);
    const msgs = await getMessages(d.id);
    expect(plainAgentMsgs(msgs, 'dev').length).toBe(2);
    // 第二轮只点名承诺者（mention-only 路由，不再问路由器）
    expect(h.lastRouterCalls).toHaveLength(1);
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
