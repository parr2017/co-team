import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// 长连接 SDK 打桩：捕获 dispatcher 注册表与 WSClient 实例，直接驱动事件处理链
const sdk = vi.hoisted(() => ({
  registered: {} as Record<string, (data: any) => Promise<void>>,
  dispatcherRef: { current: null as any },
  wsInstances: [] as any[],
}));

vi.mock('@larksuiteoapi/node-sdk', () => ({
  EventDispatcher: class {
    handlers: Record<string, (data: any) => Promise<void>> = {};
    constructor(_params?: unknown) {
      sdk.dispatcherRef.current = this;
    }
    register(handles: Record<string, (data: any) => Promise<void>>) {
      Object.assign(this.handlers, handles);
      sdk.registered = this.handlers;
      return this;
    }
  },
  WSClient: class {
    cfg: any;
    started = false;
    closed = false;
    constructor(cfg: any) {
      this.cfg = cfg;
      sdk.wsInstances.push(this);
    }
    async start(_params: unknown) {
      this.started = true;
      this.cfg?.onReady?.();
    }
    close() {
      this.closed = true;
    }
    getConnectionStatus() {
      return { state: 'connected', reconnectAttempts: 0 };
    }
  },
}));

// 网络层打桩：卡片回调回复不触网
const updateCardMock = vi.fn(async () => true);
vi.mock('../src/feishu/messageService', () => ({
  sendCard: vi.fn(async () => 'om_x'),
  updateCard: (...a: unknown[]) => updateCardMock(...(a as [any, any, any])),
  buildTaskCard: () => ({}),
}));

import { closeBus, initBus } from '../src/bus';
import { startWsGateway } from '../src/feishu/wsGateway';
import { handleCommand } from '../src/feishu/commands';
import type { FeishuConfig } from '../src/config';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const cfg = (approvers?: string[]): FeishuConfig => ({ app_id: 'cli_x', app_secret: 'sec', ...(approvers ? { approvers } : {}) });

function makeApprovalDeps() {
  return {
    getTaskGraph: vi.fn(async () => null),
    enqueue: vi.fn(async () => ({})),
    abortTask: vi.fn(),
    removePending: vi.fn(async () => {}),
    resolvePendingCommand: vi.fn(async () => ({ ok: true })),
  };
}

beforeEach(async () => {
  process.env.COTEAM_FORCE_MEMORY = '1';
  closeBus();
  await initBus({ host: '127.0.0.1', port: 6399, db: 0 });
  sdk.registered = {};
  sdk.dispatcherRef.current = null;
  sdk.wsInstances.length = 0;
  updateCardMock.mockClear();
});

afterEach(() => {
  closeBus();
});

describe('feishu ws gateway', () => {
  it('im.message.receive_v1 拍平事件重包成信封交给 processEvent；同 event_id 去重', async () => {
    const processEvent = vi.fn(async () => {});
    const handle = startWsGateway(cfg(), async () => ({ handle: async () => new Response('ok'), processEvent }), makeApprovalDeps());

    expect(sdk.wsInstances).toHaveLength(1);
    expect(sdk.wsInstances[0].started).toBe(true);

    const messageEvent = {
      event_id: 'ev1',
      event_type: 'im.message.receive_v1',
      sender: { sender_id: { open_id: 'ou1' } },
      message: { chat_id: 'oc1', content: JSON.stringify({ text: '/status' }) },
    };
    await sdk.registered['im.message.receive_v1'](messageEvent);
    await vi.waitFor(() => expect(processEvent).toHaveBeenCalledTimes(1));
    const envelope = processEvent.mock.calls[0][0];
    expect(envelope.header).toMatchObject({ event_type: 'im.message.receive_v1', event_id: 'ev1' });
    expect(envelope.event.message.chat_id).toBe('oc1');

    // 飞书重推同一事件 → seenEvent 去重，不重复处理
    await sdk.registered['im.message.receive_v1'](messageEvent);
    await sleep(20);
    expect(processEvent).toHaveBeenCalledTimes(1);
    handle.close();
    expect(sdk.wsInstances[0].closed).toBe(true);
  });

  it('card.action.trigger 路由到审批回调；白名单外操作收到无权卡片', async () => {
    const handle = startWsGateway(cfg(['ou_admin']), async () => ({ handle: async () => new Response('ok'), processEvent: vi.fn(async () => {}) }), makeApprovalDeps());
    await sdk.registered['card.action.trigger']({
      event_id: 'c1',
      operator: { open_id: 'ou_stranger' },
      action: { value: { act: 'approve_node', task_id: 't1', node_id: 'n1' } },
      context: { open_message_id: 'om1', open_chat_id: 'oc1' },
    });
    await vi.waitFor(() => expect(updateCardMock).toHaveBeenCalled());
    const card = updateCardMock.mock.calls[0][2] as Record<string, any>;
    expect(card.header.title.content).toContain('无权操作');
    expect(handle.status().state).toBe('connected');
  });

  it('status() 暴露连接状态；close() 幂等', () => {
    const handle = startWsGateway(cfg(), async () => ({ handle: async () => new Response('ok'), processEvent: vi.fn(async () => {}) }), makeApprovalDeps());
    handle.close();
    expect(() => handle.close()).not.toThrow();
    expect(handle.status()).toMatchObject({ state: 'connected', reconnectAttempts: 0 });
  });
});

describe('feishu commands /tasks /queue /status', () => {
  const baseDeps = {
    listProjects: async () => [{ id: 'p1', name: '人事系统', workspace: '/w' }],
    listAgentNames: () => ['dev', 'review'],
  };

  it('/tasks 按会话当前项目过滤并截断描述', async () => {
    const reply = await handleCommand(
      '/tasks',
      { user_id: 'u1', current_project_id: 'p1' } as any,
      {
        ...baseDeps,
        listTasks: async () => [
          { id: 't1', description: '实现登录页', status: 'running', project_id: 'p1' },
          { id: 't2', description: '别的项目任务', status: 'success', project_id: 'p2' },
        ],
      },
    );
    expect(reply.reply).toContain('t1');
    expect(reply.reply).toContain('running');
    expect(reply.reply).not.toContain('t2');
  });

  it('/queue 输出车道快照（在跑/排队/阻塞）', async () => {
    const reply = await handleCommand('/queue', { user_id: 'u1' } as any, {
      ...baseDeps,
      listQueue: async () => [
        { key: 'lane-a', running_task_id: 't9', pending: [{}, {}], blocked: false, blocked_reason: '' },
        { key: 'lane-b', running_task_id: null, pending: [], blocked: true, blocked_reason: '内容类失败' },
      ],
    });
    expect(reply.reply).toContain('t9');
    expect(reply.reply).toContain('排队 2');
    expect(reply.reply).toContain('阻塞：内容类失败');
  });

  it('未挂载查询依赖时给出未启用提示；/status 附带网关状态', async () => {
    const noDeps = await handleCommand('/tasks', { user_id: 'u1' } as any, baseDeps);
    expect(noDeps.reply).toContain('未启用');
    const st = await handleCommand('/status', { user_id: 'u1' } as any, { ...baseDeps, gatewayStatus: () => 'connected' });
    expect(st.reply).toContain('飞书网关：connected');
  });
});
