import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { initBus, closeBus } from '../src/bus';
import { pushAgentMessage, consumeAgentMessages, drainSystemMessages, flushUndelivered, MAX_PENDING_MESSAGES, type AgentMessage } from '../src/agentMessages';
import { applyToolCalls } from '../src/tools';
import { writeDoc, docsSection, getDocRegistry } from '../src/ssot';
import { formatDocAttribution } from '../src/orchestrator/orchestrator';
import { buildDeliverableReport } from '../src/deliverable';

// improvement #4 behavioral contract: agent-to-agent deferred messaging + SSOT doc
// updates via write_doc + docsSection inline injection. Pure function/queue tests —
// no model involved.

function msg(partial: Partial<AgentMessage>): AgentMessage {
  return { id: Math.random().toString(36).slice(2, 10), from: 'dev', to: 'test', text: 'hi', ts: new Date().toISOString(), ...partial };
}

beforeEach(async () => {
  process.env.COTEAM_FORCE_MEMORY = '1';
  closeBus();
  await initBus({ host: '127.0.0.1', port: 1, db: 0 });
});

afterEach(() => {
  closeBus();
});

describe('agent message queue (C1)', () => {
  it('delivers only to the addressed agent and preserves messages for others', async () => {
    const taskId = 'mqtest1';
    await pushAgentMessage(taskId, msg({ id: 'a', from: 'dev', to: 'test', text: '接口已实现，按 API_CONTRACT v2 对接' }));
    await pushAgentMessage(taskId, msg({ id: 'b', from: 'dev', to: 'review', text: '请关注异常分支' }));

    const got = await consumeAgentMessages(taskId, 'test');
    expect(got.map((m) => m.id)).toEqual(['a']);

    // review's message must still be queued; test's queue is empty
    const gotReview = await consumeAgentMessages(taskId, 'review');
    expect(gotReview.map((m) => m.id)).toEqual(['b']);
    expect(await consumeAgentMessages(taskId, 'test')).toEqual([]);
  });

  it('caps the injection per dispatch at MAX_MESSAGES_PER_DISPATCH', async () => {
    const taskId = 'mqtest2';
    for (let i = 0; i < 15; i++) await pushAgentMessage(taskId, msg({ id: `m${i}`, to: 'test', text: `n${i}` }));
    const got = await consumeAgentMessages(taskId, 'test');
    expect(got.length).toBe(10);
    const rest = await consumeAgentMessages(taskId, 'test');
    expect(rest.length).toBe(5);
  });

  it('caps the queue length at MAX_PENDING_MESSAGES (oldest dropped)', async () => {
    const taskId = 'mqtest3';
    for (let i = 0; i < MAX_PENDING_MESSAGES + 10; i++) {
      await pushAgentMessage(taskId, msg({ id: `q${i}`, to: 'test', text: `n${i}` }));
    }
    // per-dispatch cap is 10: drain repeatedly until empty
    const all: string[] = [];
    for (let round = 0; round < 15; round++) {
      const got = await consumeAgentMessages(taskId, 'test');
      all.push(...got.map((m) => m.id));
      if (!got.length) break;
    }
    expect(all.length).toBe(MAX_PENDING_MESSAGES);
    expect(all[0]).toBe('q10');
    expect(all[all.length - 1]).toBe(`q${MAX_PENDING_MESSAGES + 9}`);
  });

  it('drainSystemMessages takes orchestrator/user messages, leaves agent ones', async () => {
    const taskId = 'mqtest4';
    await pushAgentMessage(taskId, msg({ id: 'u', to: 'user', text: '需要确认登录方式' }));
    await pushAgentMessage(taskId, msg({ id: 'o', to: 'orchestrator', text: '上游模型不稳定，建议拆分' }));
    await pushAgentMessage(taskId, msg({ id: 't', to: 'test', text: 'hello' }));

    const drained = await drainSystemMessages(taskId);
    expect(drained.user.map((m) => m.id)).toEqual(['u']);
    expect(drained.orchestrator.map((m) => m.id)).toEqual(['o']);
    // agent-targeted message survives
    expect((await consumeAgentMessages(taskId, 'test')).map((m) => m.id)).toEqual(['t']);
  });

  it('flushUndelivered clears the queue and reports the count', async () => {
    const taskId = 'mqtest5';
    await pushAgentMessage(taskId, msg({ id: 'x', to: 'review', text: '永远不会被消费' }));
    expect(await flushUndelivered(taskId)).toBe(1);
    expect(await flushUndelivered(taskId)).toBe(0);
    expect(await consumeAgentMessages(taskId, 'review')).toEqual([]);
  });
});

describe('write_doc / send_message tools (C2)', () => {
  it('write_doc bumps the registry version and writes the file into the sandbox', async () => {
    const taskId = 'doctest1';
    const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-docsbx-'));
    try {
      await writeDoc(taskId, 'API_CONTRACT', '# v1', 'orchestrator');
      const results = await applyToolCalls('', [{ tool: 'write_doc', type: 'api_contract', content: '# 正式接口\nGET /users' }], {
        agent: 'dev', task_id: taskId, sandboxDir: sandbox,
      });
      expect(results[0]).toMatchObject({ tool: 'write_doc', ok: true, type: 'API_CONTRACT', version: 2 });
      const registry = await getDocRegistry(taskId);
      const doc = registry.find((d) => d.type === 'API_CONTRACT');
      expect(doc?.version).toBe(2);
      expect(doc?.updated_by).toBe('dev');
      expect(doc?.content).toContain('GET /users');
      const onDisk = fs.readFileSync(path.join(sandbox, 'docs', 'API_CONTRACT.md'), 'utf-8');
      expect(onDisk).toContain('GET /users');
      expect(onDisk).toContain('v2');
    } finally {
      fs.rmSync(sandbox, { recursive: true, force: true });
    }
  });

  it('write_doc rejects unknown doc types', async () => {
    const results = await applyToolCalls('', [{ tool: 'write_doc', type: 'DESIGN', content: 'x' }], { agent: 'dev', task_id: 'doctest2' });
    expect(results[0]).toMatchObject({ tool: 'write_doc', ok: false });
  });

  it('send_message queues for the target and validates the recipient', async () => {
    const taskId = 'msgtest1';
    const ctx = { agent: 'dev', task_id: taskId, availableAgents: ['dev', 'test', 'review'] };
    const ok = await applyToolCalls('', [{ tool: 'send_message', to: 'test', text: '  我改了 /users 返回结构，注意对接  ' }], ctx);
    expect(ok[0]).toMatchObject({ tool: 'send_message', ok: true, to: 'test' });

    const got = await consumeAgentMessages(taskId, 'test');
    expect(got.length).toBe(1);
    expect(got[0].from).toBe('dev');
    expect(got[0].text).toBe('我改了 /users 返回结构，注意对接');
  });

  it('send_message rejects invalid targets and empty text', async () => {
    const ctx = { agent: 'dev', task_id: 'msgtest2', availableAgents: ['test'] };
    const bad = await applyToolCalls('', [{ tool: 'send_message', to: 'nonexistent', text: 'x' }], ctx);
    expect(bad[0]).toMatchObject({ tool: 'send_message', ok: false });
    const empty = await applyToolCalls('', [{ tool: 'send_message', to: 'test', text: '   ' }], ctx);
    expect(empty[0]).toMatchObject({ tool: 'send_message', ok: false });
  });

  it('send_message truncates text beyond MAX_MESSAGE_LENGTH', async () => {
    const taskId = 'msgtest3';
    const ctx = { agent: 'dev', task_id: taskId, availableAgents: ['test'] };
    await applyToolCalls('', [{ tool: 'send_message', to: 'test', text: 'x'.repeat(3000) }], ctx);
    const got = await consumeAgentMessages(taskId, 'test');
    expect(got[0].text.length).toBeLessThanOrEqual(2000);
  });
});

describe('docsSection inline injection (C3)', () => {
  it('lists pointers for all docs and inlines short content', async () => {
    const taskId = 'docsec1';
    await writeDoc(taskId, 'TASK_SPEC', '# 短规格\n目标：登录', 'orchestrator');
    await writeDoc(taskId, 'API_CONTRACT', '# 契约\nGET /users', 'orchestrator');
    const section = await docsSection(taskId);
    expect(section).toContain('- docs/TASK_SPEC.md (v1)');
    expect(section).toContain('- docs/API_CONTRACT.md (v1)');
    expect(section).toContain('# 短规格');
    expect(section).toContain('GET /users');
  });

  it('truncates long docs and notes the file path', async () => {
    const taskId = 'docsec2';
    await writeDoc(taskId, 'TASK_SPEC', 'x'.repeat(5000), 'orchestrator');
    const section = await docsSection(taskId);
    expect(section).toContain('内容过长已截断');
    expect(section).toContain('read_file');
  });

  it('caps inline docs at 3', async () => {
    const taskId = 'docsec3';
    for (const t of ['TASK_SPEC', 'API_CONTRACT', 'STATUS_REPORT'] as const) {
      await writeDoc(taskId, t, `# ${t}\n内容`, 'orchestrator');
    }
    const section = await docsSection(taskId);
    const inlineCount = (section.match(/### docs\//g) || []).length;
    expect(inlineCount).toBe(3);
  });
});

describe('doc attribution & deliverable (B2 partial / C5)', () => {
  it('formatDocAttribution renders versions and skips empty input', () => {
    expect(formatDocAttribution(undefined)).toBe('');
    expect(formatDocAttribution([])).toBe('');
    expect(formatDocAttribution([{ type: 'API_CONTRACT', version: 3 }])).toContain('docs/API_CONTRACT.md (v3)');
  });

  it('deliverable report carries a doc-updates section', () => {
    const node = {
      id: 'n1', name: '实现用户接口', agent: 'dev', status: 'completed',
      result: { summary: 'done', verification: '已核对', changes: ['a.py'], doc_updates: [{ type: 'API_CONTRACT', version: 2 }] },
    } as any;
    const report = buildDeliverableReport('t1', node);
    expect(report).toContain('## 协同文档更新');
    expect(report).toContain('- docs/API_CONTRACT.md → v2');
  });

  it('deliverable report omits the section when no docs were updated', () => {
    const node = { id: 'n1', name: '分析', agent: 'dev', status: 'completed', result: { summary: 'ok', verification: '核对' } } as any;
    expect(buildDeliverableReport('t1', node)).not.toContain('协同文档更新');
  });
});
