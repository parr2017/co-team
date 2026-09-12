import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

vi.mock('../src/llm', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/llm')>();
  return {
    ...actual,
    chat: async () => ({ content: '{"speak":true,"reply":"ok"}', promptTokens: 3, completionTokens: 4 }),
  };
});

import { initBus, closeBus } from '../src/bus';
import { ModelPool } from '../src/scheduler';
import { Orchestrator } from '../src/orchestrator/orchestrator';
import { TaskQueueManager } from '../src/taskQueue';
import { discussionTaskDigest } from '../src/discussionBridge';
import { createDiscussion, getMessages, postTaskNotice } from '../src/discussion';
import { saveTaskGraph, getProject, saveProject } from '../src/store';
import type { TaskNode } from '../src/types';

let tmp: string;
let orchestrator: Orchestrator;

beforeEach(async () => {
  process.env.COTEAM_FORCE_MEMORY = '1';
  closeBus();
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-dbridge-'));
  const devDir = path.join(tmp, 'dev');
  fs.mkdirSync(devDir, { recursive: true });
  fs.writeFileSync(path.join(devDir, 'agent.yaml'), 'name: dev\ntags: [code]\nrole: 开发\n');
  await initBus({ host: '127.0.0.1', port: 6399, db: 0 });
  const pool = new ModelPool([{ name: 'fake-model', api_key: 'k', base_url: 'http://localhost:9', tags: ['code'] }]);
  orchestrator = new Orchestrator({
    agentsDir: tmp, modelPool: pool, policy: { whitelistCommands: null, maxTimeSec: 10 },
    maxRetries: 1, sandboxEnabled: false, gitEnabled: false, branchWorkflow: false,
  });
  await orchestrator.loadAgents();
  await saveProject({ id: 'p-bridge', name: 'bridge-project', workspace: tmp, description: '', created_at: '', updated_at: '' } as any);
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
  closeBus();
});

function makeNode(id: string, agent: string, extra: Partial<TaskNode> = {}): TaskNode {
  return {
    id, task_id: 't', name: id, status: 'pending', agent, result: null, error: '',
    retry_count: 0, complexity: 'normal', requires_approval: false, needs_human: false,
    created_at: '', updated_at: '',
    ...extra,
  };
}

const deps = () => ({ orchestrator, pool: new ModelPool([{ name: 'm', api_key: 'k', base_url: 'http://x' }]), taskQueue: new TaskQueueManager(orchestrator, new ModelPool([])), logger: console as any });

describe('M5.2 任务↔群聊互通', () => {
  it('①运行中任务摘要：digest 含任务 id/状态/阶段/节点进度', async () => {
    await saveTaskGraph('t-dig', [
      makeNode('1', 'dev', { status: 'completed' }),
      makeNode('2', 'dev', { status: 'running' }),
      makeNode('3', 'test'),
    ], [], { description: '做一个记账应用', workspace: tmp, status: 'running', project_id: 'p-bridge', rolling: true, stage_count: 2 } as any);
    const digest = await discussionTaskDigest('p-bridge');
    expect(digest).toContain('t-dig');
    expect(digest).toContain('running');
    expect(digest).toContain('第2阶段');
    expect(digest).toContain('节点 1/3');
    expect(digest).toContain('正在跑');
  });

  it('①无运行中任务 → digest 为空串（不注入空块）', async () => {
    expect(await discussionTaskDigest('p-none')).toBe('');
  });

  it('②③postTaskNotice：系统卡片落讨论流，meta 携带 bridge_ask', async () => {
    const disc = await createDiscussion(deps() as any, { title: '桥接测试', members: ['dev'], project_id: 'p-bridge' });
    await postTaskNotice(disc.id, '❓ 任务 t-x 的 dev 提问：用哪个端口？', {
      bridge_ask: { task_id: 't-x', ask_id: 'abc123', question: '用哪个端口？' },
    });
    const msgs = await getMessages(disc.id);
    const last = msgs[msgs.length - 1];
    expect(last.from).toBe('system');
    expect(last.kind).toBe('card');
    expect(last.meta?.bridge_ask).toMatchObject({ task_id: 't-x', ask_id: 'abc123' });
    expect(last.text).toContain('用哪个端口');
  });
});
