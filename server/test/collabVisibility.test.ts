import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * 协作可视化（2026-09-16）：agent 间协作此前只有发送侧可见——接收方消化留言、
 * 上游→下游接力交接都发生在提示词里，界面无感知。本文件验证：
 * 1. send_message 发送→接收（message_received journal + agent_message received 事件）；
 * 2. 下游节点首次派发时上游成果交接（handoff journal + node_handoff 事件）。
 */
let plannerCalls = 0;
let d1Rounds = 0;

vi.mock('../src/llm', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/llm')>();
  return {
    ...actual,
    chat: async (_entry: any, messages: { role: string; content: string }[]) => {
      const sys = String(messages[0]?.content || '');
      const user = String(messages.find((m) => m.role === 'user')?.content || '');
      if (sys.includes('task planner')) {
        plannerCalls += 1;
        if (plannerCalls === 1) {
          return {
            content: JSON.stringify({
              done: false,
              stage_goal: '两步接力',
              summary: 'd1 完成后 d2 接力',
              nodes: [
                { id: 'm', name: 'Main Task', agent: 'orchestrator', complexity: 'simple', reason: '任务基线' },
                { id: 'd1', name: '接口实现', agent: 'dev', complexity: 'normal', reason: '实现' },
                { id: 'd2', name: '下游集成', agent: 'dev', complexity: 'normal', reason: '集成' },
              ],
              edges: [['m', 'd1'], ['d1', 'd2']],
              checklist: [{ requirement: '端到端可用', evidence_type: 'command' }],
            }),
            promptTokens: 2, completionTokens: 3,
          };
        }
        // 后续 replan：声明完成（清单全达成），终止滚动
        return {
          content: JSON.stringify({ done: true, assessment: '目标已达成', checklist_results: [{ id: '1-1', done: true, evidence: 'npm test 全绿' }] }),
          promptTokens: 2, completionTokens: 3,
        };
      }
      // agent 调用按节点名路由（session 延续携带历史 user 消息，扫全部取路由键；
      // 先判下游节点——d2 的会话里带着 d1 的历史消息）
      const allUser = messages.filter((m) => m.role === 'user').map((m) => String(m.content || ''));
      if (allUser.some((c) => c.includes('任务: 下游集成'))) {
        return { content: JSON.stringify({ status: 'success', summary: '下游集成完成', verification: 'build 通过', changes: ['integrate.ts'], errors: [] }), promptTokens: 3, completionTokens: 4 };
      }
      if (allUser.some((c) => c.includes('任务: 接口实现'))) {
        d1Rounds += 1;
        if (d1Rounds === 1) return { content: JSON.stringify({ tool_calls: [{ tool: 'send_message', to: 'dev', text: '请按接口约定集成，字段见 docs/TASK_SPEC' }] }), promptTokens: 3, completionTokens: 4 };
        return { content: JSON.stringify({ status: 'success', summary: '接口实现完成，已给下游留言', verification: 'npm test 通过', changes: ['api.ts'], errors: [] }), promptTokens: 3, completionTokens: 4 };
      }
      return { content: JSON.stringify({ status: 'success', summary: 'done', verification: 'ok', changes: [], errors: [] }), promptTokens: 3, completionTokens: 4 };
    },
  };
});

import { initBus, closeBus } from '../src/bus';
import { Orchestrator } from '../src/orchestrator/orchestrator';
import { ModelPool } from '../src/scheduler';
import { getTaskGraph, getTaskEvents, getTaskJournals } from '../src/store';
import type { TaskNode } from '../src/types';

let tmp: string;
let orchestrator: Orchestrator;

beforeEach(async () => {
  process.env.COTEAM_FORCE_MEMORY = '1';
  closeBus();
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-collab-'));
  const devDir = path.join(tmp, 'dev');
  fs.mkdirSync(devDir, { recursive: true });
  fs.writeFileSync(path.join(devDir, 'agent.yaml'), 'name: dev\ntags: [code]\nrole: 开发\n');
  await initBus({ host: '127.0.0.1', port: 6399, db: 0 });
  plannerCalls = 0;
  d1Rounds = 0;
  const pool = new ModelPool([{ name: 'fake-model', api_key: 'k', base_url: 'http://localhost:9', tags: ['code'] }]);
  orchestrator = new Orchestrator({
    agentsDir: tmp, modelPool: pool, policy: { whitelistCommands: null, maxTimeSec: 10 },
    maxRetries: 1, sandboxEnabled: false, gitEnabled: false, branchWorkflow: false,
    planningMode: 'rolling',
  });
  await orchestrator.loadAgents();
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
  closeBus();
});

function makeNode(id: string, agent: string): TaskNode {
  return {
    id, task_id: 't-cv', name: id, status: 'pending', agent, result: null, error: '',
    retry_count: 0, complexity: 'normal', requires_approval: false, needs_human: false,
    created_at: '', updated_at: '',
  };
}

describe('协作可视化：留言接收与上游交接全程可见', () => {
  it('d1 给 d2 留言 → d2 消费时落 message_received；d2 首派发落 handoff', async () => {
    await (orchestrator as any).planAndSave('t-cv', '做一个接力协作演示', tmp, undefined, { level: 'standard' });
    const result = await (orchestrator as any).execute('t-cv', tmp);
    expect(result.status).toBe('success');

    const graph = await getTaskGraph('t-cv');
    const d2 = graph!.nodes.find((n) => n.id === 'd2')!;
    expect(d2.status).toBe('completed');

    const events = await getTaskEvents('t-cv');

    // 发送侧事件（既有行为）
    expect(events.some((e) => e.type === 'agent_message' && e.payload.to === 'dev')).toBe(true);
    // 接收侧事件（新增）：d2 消费留言
    const recv = events.find((e) => e.type === 'agent_message' && e.payload.kind === 'received');
    expect(recv).toBeTruthy();
    expect(recv!.payload.from).toBe('dev');
    expect(recv!.payload.agent).toBe('dev');
    expect(recv!.payload.node_id).toBe('d2');

    // 交接事件（新增）：d2 首次派发携带上游成果摘要
    const handoff = events.find((e) => e.type === 'node_handoff' && e.payload.node_id === 'd2');
    expect(handoff).toBeTruthy();
    expect(String(handoff!.payload.handoff)).toContain('接口实现完成');

    // 作战室 journal：接收记录 + 交接记录可回放
    const journals = await getTaskJournals('t-cv');
    const all = Object.values(journals).flat();
    const recvEntry = all.find((e) => e.kind === 'message_received');
    expect(recvEntry).toBeTruthy();
    expect(String(recvEntry!.meta?.from)).toBe('dev');
    expect(all.some((e) => e.kind === 'handoff' && e.node_id === 'd2')).toBe(true);
    // 发送侧记录仍然存在（行为不回退）
    expect(all.some((e) => e.kind === 'message' && e.meta?.to === 'dev')).toBe(true);
  });
});
