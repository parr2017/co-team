import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// P2-8 对话即工作台测试：预算内小改直干（write/edit 真实落盘 + diff + undo 凭证）、
// 超预算拒绝并引导转任务、一键回滚（恢复写前内容/删除新文件）、与任务管线工作区互斥。
const h = vi.hoisted(() => ({
  routerSpeakers: null as null | string[] | 'throw',
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
        return ok(await h.speaker(sys, userAll, model));
      }
      if (sys.includes('task planner')) {
        return ok(JSON.stringify({ nodes: [{ id: '1', name: '实现方案', agent: 'dev', complexity: 'normal', goal_link: '按方案实现' }], edges: [], summary: 'plan' }));
      }
      return ok(JSON.stringify({ status: 'success', summary: 'done', verification: 'ok', changes: [], errors: [] }));
    },
  };
});

import { initBus, closeBus, busGet } from '../src/bus';
import { ModelPool } from '../src/scheduler';
import { Orchestrator } from '../src/orchestrator/orchestrator';
import { saveProject, saveTaskGraph } from '../src/store';
import { createDiscussion, getMessages, runDiscussionRound, undoDiscussionWrites, SPEAKER_RETRY_POLICY } from '../src/discussion';

let tmp: string;
let deps: any;

const okContent = (reply: string, extra: Record<string, unknown> = {}) => JSON.stringify({ speak: true, reply, ...extra });

beforeEach(async () => {
  process.env.COTEAM_FORCE_MEMORY = '1';
  closeBus();
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-disc-wb-'));
  process.chdir(tmp);
  fs.mkdirSync(path.join(tmp, 'data'), { recursive: true });
  for (const name of ['dev', 'test', 'deploy']) {
    const d = path.join(tmp, name);
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, 'agent.yaml'), `name: ${name}\ntags: [code]\nrole: ${name}\n`);
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

async function mkProject(id = 'p1') {
  const ws = path.join(tmp, id);
  fs.mkdirSync(ws, { recursive: true });
  fs.writeFileSync(path.join(ws, 'package.json'), JSON.stringify({ name: id, scripts: { dev: 'echo serve' } }));
  await saveProject({ id, name: `项目${id}`, workspace: ws, description: '演示项目', created_at: new Date().toISOString() });
  return ws;
}

async function mkDiscussion(members = ['dev'], projectId?: string) {
  return createDiscussion(deps, { title: '工作台 demo', members, ...(projectId ? { project_id: projectId } : {}) });
}

const toolMsgs = (id: string) => getMessages(id).then((ms) => ms.filter((m) => m.tool));

describe('P2-8 对话即工作台', () => {
  it('预算内小改直干：write_file 真实落盘 + undo_id + diff 留痕', async () => {
    const ws = await mkProject();
    const d = await mkDiscussion(['dev'], 'p1');
    h.routerSpeakers = ['dev'];
    h.speaker = (_sys, user) => {
      if (user.includes('工具执行结果')) return okContent('已写入 fix.ts');
      return JSON.stringify({ tool_calls: [{ tool: 'write_file', path: 'src/fix.ts', content: 'export const fix = 1;\n' }] });
    };
    await runDiscussionRound(deps, d.id);
    expect(fs.readFileSync(path.join(ws, 'src', 'fix.ts'), 'utf-8')).toContain('export const fix = 1;');
    const tm = (await toolMsgs(d.id)).at(-1)!;
    const recs = (tm.meta as any)?.calls as any[];
    const writeRec = recs.find((r) => r.tool === 'write_file');
    expect(writeRec?.ok).toBe(true);
    expect(writeRec?.undo_id).toBeTruthy();
    // 写前提示词含小改直干说明（M11 禁改语义已被工作台替换）
    expect(h.lastSpeakerCalls[0].sys).toContain('小改直干');
    void ws;
  });

  it('超预算拒绝并引导转任务：第 4 个文件写不进', async () => {
    const ws = await mkProject();
    const d = await mkDiscussion(['dev'], 'p1');
    h.routerSpeakers = ['dev'];
    const files = ['a.ts', 'b.ts', 'c.ts', 'd.ts'];
    h.speaker = (_sys, user) => {
      // 一批 4 个写入调用：前 3 个预算内成功，第 4 个被拒
      if (!user.includes('工具执行结果')) {
        return JSON.stringify({ tool_calls: files.map((f) => ({ tool: 'write_file', path: `src/${f}`, content: 'x\n' })) });
      }
      return okContent('写完三个，第四个超预算被拒，建议转任务');
    };
    await runDiscussionRound(deps, d.id);
    expect(fs.existsSync(path.join(ws, 'src', 'a.ts'))).toBe(true);
    expect(fs.existsSync(path.join(ws, 'src', 'd.ts'))).toBe(false);
    const tm = (await toolMsgs(d.id)).at(-1)!;
    const recs = (tm.meta as any)?.calls as any[];
    const rejected = recs.find((r) => r.tool === 'write_file' && r.ok === false);
    expect(rejected?.output_gist).toContain('超出小改预算');
    void ws;
  });

  it('一键回滚：改已有文件恢复写前内容，新文件回滚即删除', async () => {
    const ws = await mkProject();
    fs.writeFileSync(path.join(ws, 'exist.txt'), 'original\n');
    const d = await mkDiscussion(['dev'], 'p1');
    h.routerSpeakers = ['dev'];
    h.speaker = (_sys, user) => {
      if (user.includes('工具执行结果')) return okContent('两处都改好了');
      return JSON.stringify({ tool_calls: [
        { tool: 'edit_file', path: 'exist.txt', find: 'original', replace: 'modified' },
        { tool: 'write_file', path: 'new.txt', content: 'brand new\n' },
      ] });
    };
    await runDiscussionRound(deps, d.id);
    expect(fs.readFileSync(path.join(ws, 'exist.txt'), 'utf-8')).toContain('modified');
    expect(fs.existsSync(path.join(ws, 'new.txt'))).toBe(true);
    // 从 undo KV 取全部 undo_id 回滚
    const undoList = (await busGet<any[]>(`discussion:${d.id}:undo`)) || [];
    expect(undoList.length).toBe(2);
    const r = await undoDiscussionWrites(deps, d.id, undoList.map((u) => u.undo_id));
    expect(r.reverted.length).toBe(2);
    expect(fs.readFileSync(path.join(ws, 'exist.txt'), 'utf-8')).toContain('original');
    expect(fs.existsSync(path.join(ws, 'new.txt'))).toBe(false);
  });

  it('工作区互斥：同工作区有运行中任务时写被拒', async () => {
    const ws = await mkProject();
    const d = await mkDiscussion(['dev'], 'p1');
    await saveTaskGraph('t-running', [], [], { description: 'x', workspace: ws, status: 'running' });
    h.routerSpeakers = ['dev'];
    h.speaker = (_sys, user) => {
      if (user.includes('工具执行结果')) return okContent('写入被互斥拒绝，如实汇报');
      return JSON.stringify({ tool_calls: [{ tool: 'write_file', path: 'x.ts', content: 'x\n' }] });
    };
    await runDiscussionRound(deps, d.id);
    const tm = (await toolMsgs(d.id)).at(-1)!;
    const recs = (tm.meta as any)?.calls as any[];
    expect(recs[0].ok).toBe(false);
    expect(String(recs[0].output_gist)).toContain('工作区互斥');
    expect(fs.existsSync(path.join(ws, 'x.ts'))).toBe(false);
  });
});
