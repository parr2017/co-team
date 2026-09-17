import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// P2-4 并行发言测试：同一批发言者并发执行（信号量限流）、transcript 写锁消息完整、
// 排队中状态可见（'queued' 事件）、插话让位（排队成员重读现场后 yield）。
const h = vi.hoisted(() => ({
  routerSpeakers: null as null | string[] | 'throw',
  inFlight: 0,
  maxInFlight: 0,
  speakerDelayMs: 0,
  lastSpeakerCalls: [] as { agent: string; model: string; sys: string; user: string }[],
  speaker: null as null | ((sys: string, user: string, model: string) => string | Promise<string>),
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
        h.inFlight++;
        h.maxInFlight = Math.max(h.maxInFlight, h.inFlight);
        try {
          const res = await h.speaker(sys, userAll, model);
          if (h.speakerDelayMs > 0) await new Promise((r) => setTimeout(r, h.speakerDelayMs));
          return ok(res);
        } finally {
          h.inFlight--;
        }
      }
      if (sys.includes('task planner')) {
        return ok(JSON.stringify({ nodes: [{ id: '1', name: '实现方案', agent: 'dev', complexity: 'normal', goal_link: '按方案实现' }], edges: [], summary: 'plan' }));
      }
      return ok(JSON.stringify({ status: 'success', summary: 'done', verification: 'ok', changes: [], errors: [] }));
    },
  };
});

import { initBus, closeBus, getBus } from '../src/bus';
import { ModelPool } from '../src/scheduler';
import { Orchestrator } from '../src/orchestrator/orchestrator';
import { createDiscussion, getMessages, runDiscussionRound, postUserMessage, configureDiscussion, SPEAKER_RETRY_POLICY } from '../src/discussion';
import type { DiscussionMessage } from '../src/discussion';

let tmp: string;
let deps: any;
let capturedEvents: { type: string; payload: Record<string, unknown> }[] = [];

const okContent = (reply: string, extra: Record<string, unknown> = {}) => JSON.stringify({ speak: true, reply, ...extra });

beforeEach(async () => {
  process.env.COTEAM_FORCE_MEMORY = '1';
  closeBus();
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-disc-par-'));
  process.chdir(tmp);
  fs.mkdirSync(path.join(tmp, 'data'), { recursive: true });
  for (const name of ['dev', 'test', 'deploy']) {
    const d = path.join(tmp, name);
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, 'agent.yaml'), `name: ${name}\ntags: [code]\nrole: ${name}\n`);
    fs.writeFileSync(path.join(d, 'prompt.md'), `${name} 的专业指令`);
  }
  await initBus({ host: '127.0.0.1', port: 6399, db: 0 });
  capturedEvents = [];
  getBus().subscribe('coteam:dashboard', (m: any) => capturedEvents.push(m));
  h.speaker = null;
  h.routerSpeakers = null;
  h.inFlight = 0;
  h.maxInFlight = 0;
  h.speakerDelayMs = 0;
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
  // 默认并行 2；单发并发的用例自行调 1
  configureDiscussion({ parallel_speakers: 2 });
});

afterEach(() => {
  process.chdir(path.join(tmp, '..'));
  fs.rmSync(tmp, { recursive: true, force: true });
  closeBus();
  SPEAKER_RETRY_POLICY.capacityWaitSec = [20, 40];
  SPEAKER_RETRY_POLICY.quickRetryDelayMs = 3000;
});

async function mkDiscussion(members = ['dev', 'test', 'deploy']) {
  return createDiscussion(deps, { title: '并行发言 demo', members });
}

describe('P2-4 并行发言', () => {
  it('同一批发言者并发执行（信号量宽度内重叠）+ 写锁下消息完整', async () => {
    const d = await mkDiscussion(['dev', 'test']);
    h.routerSpeakers = ['dev', 'test'];
    h.speakerDelayMs = 120;
    h.speaker = (_sys, user) => (user.includes('「dev」') ? okContent('dev 的见解') : okContent('test 的见解'));
    const res = await runDiscussionRound(deps, d.id);
    expect(res.speakers).toEqual(['dev', 'test']);
    // 并行重叠：两个发言者同时在飞（串行时 maxInFlight 恒为 1）
    expect(h.maxInFlight).toBe(2);
    // 写锁：并发落消息不丢
    const msgs = await getMessages(d.id);
    expect(msgs.some((m) => m.from === 'dev' && m.text.includes('dev 的见解'))).toBe(true);
    expect(msgs.some((m) => m.from === 'test' && m.text.includes('test 的见解'))).toBe(true);
  });

  it('parallel_speakers=1 退化为串行（并发上限可配置）', async () => {
    const d = await mkDiscussion(['dev', 'test']);
    configureDiscussion({ parallel_speakers: 1 });
    h.routerSpeakers = ['dev', 'test'];
    h.speakerDelayMs = 100;
    h.speaker = () => okContent('发言');
    await runDiscussionRound(deps, d.id);
    expect(h.maxInFlight).toBe(1);
    configureDiscussion({ parallel_speakers: 2 });
  });

  it('并发槽满时排队中状态以 queued 事件可见', async () => {
    const d = await mkDiscussion(['dev', 'test', 'deploy']);
    h.routerSpeakers = ['dev', 'test', 'deploy'];
    h.speakerDelayMs = 100;
    h.speaker = () => okContent('发言');
    await runDiscussionRound(deps, d.id);
    const queued = capturedEvents.filter((e) => e.type === 'discussion_round' && (e.payload as any).phase === 'queued');
    expect(queued.length).toBeGreaterThanOrEqual(3);
  });

  it('插话让位：在飞的完成当前步，排队的重读现场后 yield（插话语义不变）', async () => {
    const d = await mkDiscussion(['dev', 'test']);
    configureDiscussion({ parallel_speakers: 1 });
    h.routerSpeakers = ['dev', 'test'];
    h.speakerDelayMs = 0;
    h.speaker = () => new Promise<string>((r) => setTimeout(() => r(okContent('慢发言')), 250));
    const p = runDiscussionRound(deps, d.id);
    await vi.waitFor(() => expect(h.lastSpeakerCalls.length).toBe(1));
    await postUserMessage(deps, d.id, '插话：先别动');
    const res = await p;
    expect(res.speakers).toEqual(['dev']);
    expect(res.interrupted_by_user).toBe(true);
    configureDiscussion({ parallel_speakers: 2 });
  });
});
