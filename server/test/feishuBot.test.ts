import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createCipheriv, createHash, createDecipheriv, randomBytes } from 'node:crypto';

import { initBus, closeBus } from '../src/bus';
import { verifySignature } from '../src/feishu/tokenManager';
import { handleCommand, type CommandDeps } from '../src/feishu/commands';
import { getSession, setSession } from '../src/feishu/session';
import { createFeishuHandler } from '../src/feishu/webhook';
import { createApi } from '../src/api';
import { emitEvent } from '../src/store';
import { CHANNELS } from '../src/types';
import type { FeishuConfig } from '../src/config';

let fetchCalls: { url: string; init: RequestInit }[] = [];

function jsonResponse(obj: unknown, status = 200): Response {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });
}

beforeEach(async () => {
  process.env.COTEAM_FORCE_MEMORY = '1';
  closeBus();
  await initBus({ host: '127.0.0.1', port: 6399, db: 0 });
  fetchCalls = [];
  vi.stubGlobal('fetch', async (url: string | URL, init: RequestInit = {}) => {
    fetchCalls.push({ url: String(url), init });
    if (String(url).includes('/auth/v3/tenant_access_token')) {
      return jsonResponse({ code: 0, tenant_access_token: 't-va', expire: 7200 });
    }
    return jsonResponse({ code: 0, data: { message_id: 'om_1' } });
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  closeBus();
});

const CFG: FeishuConfig = { app_id: 'cli_x', app_secret: 'sec', api_base: 'http://feishu-mock' };

function messageEvent(text: string, userId = 'ou_u1', chatId = 'oc_c1', eventId?: string): Record<string, any> {
  return {
    header: { event_type: 'im.message.receive_v1', ...(eventId ? { event_id: eventId } : {}) },
    event: {
      sender: { sender_id: { open_id: userId } },
      message: { chat_id: chatId, content: JSON.stringify({ text }) },
    },
  };
}

describe('feishu webhook security', () => {
  it('verifies the X-Lark-Signature (sha256 of ts+nonce+key+body)', () => {
    const sig = createHash('sha256').update('123n1ckey{"x":1}').digest('hex');
    expect(verifySignature({ timestamp: '123', nonce: 'n1c', encryptKey: 'key', body: '{"x":1}', signature: sig })).toBe(true);
    expect(verifySignature({ timestamp: '123', nonce: 'n1c', encryptKey: 'key', body: '{"x":2}', signature: sig })).toBe(false);
  });

  it('answers the url_verification challenge and rejects a wrong verification token', async () => {
    const app = createApi({
      config: { feishu: { ...CFG, verification_token: 'tok' } } as any,
      orchestrator: {} as any, modelPool: {} as any, taskQueue: {} as any,
    });
    const challenge = await app.request('/api/feishu/webhook', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'url_verification', challenge: 'ajskdl', token: 'tok' }),
    });
    expect(await challenge.json()).toEqual({ challenge: 'ajskdl' });

    const bad = await app.request('/api/feishu/webhook', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'message', token: 'wrong', event: {} }),
    });
    expect(bad.status).toBe(403);
  });

  it('decrypts AES-256-CBC encrypted payloads (encrypt_key mode)', async () => {
    const encryptKey = 'my-encrypt-key';
    const key = createHash('sha256').update(encryptKey).digest();
    const plain = JSON.stringify({ type: 'url_verification', challenge: 'enc-challenge' });
    const iv = randomBytes(16);
    const cipher = createCipheriv('aes-256-cbc', key, iv);
    const encrypted = Buffer.concat([iv, cipher.update(plain, 'utf-8'), cipher.final()]).toString('base64');

    const app = createApi({
      config: { feishu: { ...CFG, encrypt_key: encryptKey } } as any,
      orchestrator: {} as any, modelPool: {} as any, taskQueue: {} as any,
    });
    const res = await app.request('/api/feishu/webhook', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ encrypt: encrypted }),
    });
    expect(await res.json()).toEqual({ challenge: 'enc-challenge' });
  });

  it('dedups repeated event ids', async () => {
    const { seenEvent } = await import('../src/feishu/webhook');
    expect(await seenEvent('evt-1')).toBe(false);
    expect(await seenEvent('evt-1')).toBe(true);
    expect(await seenEvent(undefined)).toBe(false);
  });
});

describe('feishu commands', () => {
  const deps: CommandDeps = {
    listProjects: async () => [
      { id: 'p1', name: '数据中台', workspace: 'D:/w1' },
      { id: 'p2', name: '移动端 App', workspace: 'D:/w2' },
    ],
    listAgentNames: () => ['dev', 'test', 'review'],
  };

  it('/help lists commands; unknown command returns help', async () => {
    const session = await getSession('ou_x');
    const help = await handleCommand('/help', session, deps);
    expect(help.reply).toContain('/project');
    const unknown = await handleCommand('/nope', session, deps);
    expect(unknown.reply).toContain('未知指令');
  });

  it('/project supports fuzzy matching and persists the selection', async () => {
    let session = await getSession('ou_p');
    const ambiguous = await handleCommand('/project 移', session, deps);
    expect(ambiguous.reply).toContain('移动端 App');
    const ok = await handleCommand('/project 中台', session, deps);
    expect(ok.reply).toContain('✅');
    session = await getSession('ou_p');
    expect(session.current_project_id).toBe('p1');
    const status = await handleCommand('/status', session, deps);
    expect(status.reply).toContain('数据中台');
    const reset = await handleCommand('/reset', session, deps);
    expect((await getSession('ou_p')).current_project_id).toBeUndefined();
    expect(reset.reply).toContain('重置');
  });

  it('/agent lists and switches; /list project enumerates', async () => {
    const session = await getSession('ou_a');
    const listed = await handleCommand('/agent', session, deps);
    expect(listed.reply).toContain('dev, test, review');
    const switched = await handleCommand('/agent rev', session, deps);
    expect(switched.reply).toContain('review');
    const projects = await handleCommand('/list project', session, deps);
    expect(projects.reply).toContain('p2');
  });
});

describe('feishu message flow (async processing)', () => {
  function makeDeps() {
    const createTask = vi.fn(async () => ({ taskId: 'tk99', needsClarification: false, questions: [] }));
    const enqueue = vi.fn(async () => ({}));
    const deps = {
      createTask,
      enqueue,
      listProjects: async () => [{ id: 'p1', name: '数据中台', workspace: 'D:/w1' }],
      listAgentNames: () => ['dev'],
    };
    return { createTask, enqueue, deps };
  }

  it('without a selected project, free text asks for /project instead of creating a task', async () => {
    const { deps, createTask } = makeDeps();
    const handler = createFeishuHandler(CFG, deps);
    await handler.processEvent(messageEvent('修一下登录超时'));
    const sent = fetchCalls.filter((c) => c.url.includes('/im/v1/messages'));
    expect(createTask).not.toHaveBeenCalled();
    expect(JSON.stringify(sent)).toContain('/project');
  });

  it('free text with a project creates + enqueues a task and binds a progress card', async () => {
    const { deps, createTask, enqueue } = makeDeps();
    await setSession({ user_id: 'ou_u1', current_project_id: 'p1', current_project_name: '数据中台', last_active_time: new Date().toISOString() });
    const handler = createFeishuHandler(CFG, deps);
    await handler.processEvent(messageEvent('修一下登录超时'));

    expect(createTask).toHaveBeenCalledTimes(1);
    expect((createTask.mock.calls[0][0] as string)).toContain('修一下登录超时');
    expect(createTask.mock.calls[0][2]).toBe('p1');
    expect(enqueue).toHaveBeenCalledWith('tk99', 'p1', 'D:/w1');
    const bound = await (await import('../src/bus')).busGet<{ message_id: string }>('feishu:card:tk99');
    expect(bound?.message_id).toBe('om_1');
  });

  it('lifecycle notifications on the notify channel update the bound card in place', async () => {
    const { deps } = makeDeps();
    const handler = createFeishuHandler(CFG, deps);
    await setSession({ user_id: 'ou_u1', current_project_id: 'p1', last_active_time: new Date().toISOString() });
    await handler.processEvent(messageEvent('再修一个'));
    fetchCalls.length = 0;

    await emitEvent(CHANNELS.NOTIFY, 'task_success', { task_id: 'tk99', message: '完成，3 个文件变更' });
    await new Promise((r) => setTimeout(r, 30));

    const patch = fetchCalls.find((c) => c.url.includes('/im/v1/messages/om_1'));
    expect(patch).toBeTruthy();
    expect((patch!.init.method as string).toUpperCase()).toBe('PATCH');
    expect(String(patch!.init.body)).toContain('task_success');
  });

  it('clarification-needed tasks reply with the questions and do not enqueue', async () => {
    const enqueue = vi.fn(async () => ({}));
    const handler = createFeishuHandler(CFG, {
      createTask: async () => ({ taskId: 'tk77', needsClarification: true, questions: ['目标平台是什么？'] }),
      enqueue,
      listProjects: async () => [{ id: 'p1', name: '数据中台', workspace: 'D:/w1' }],
      listAgentNames: () => ['dev'],
    });
    await setSession({ user_id: 'ou_u1', current_project_id: 'p1', last_active_time: new Date().toISOString() });
    await handler.processEvent(messageEvent('做个app'));
    const sent = fetchCalls.filter((c) => c.url.includes('/im/v1/messages') && !String(c.url).includes('om_1'));
    expect(enqueue).not.toHaveBeenCalled();
    expect(JSON.stringify(sent)).toContain('目标平台是什么？');
  });
});
