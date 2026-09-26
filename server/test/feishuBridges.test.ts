import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const sendTextMock = vi.fn(async () => 'om_t');
const sendCardMock = vi.fn(async () => 'om_new1');
vi.mock('../src/feishu/messageService', () => ({
  sendText: (...a: unknown[]) => sendTextMock(...(a as [any, any, any])),
  sendCard: (...a: unknown[]) => sendCardMock(...(a as [any, any, any])),
  updateCard: vi.fn(async () => true),
  buildTaskCard: () => ({}),
}));

import { closeBus, busGet, busSet, initBus } from '../src/bus';
import { emitEvent, saveTaskGraph } from '../src/store';
import { CHANNELS } from '../src/types';
import { createConvoBridge } from '../src/feishu/convoBridge';
import { createOcBridge } from '../src/feishu/ocBridge';
import { createInboxBridge } from '../src/feishu/inboxBridge';
import { handleCardAction } from '../src/feishu/approvalCards';
import { handleCommand } from '../src/feishu/commands';
import { buildTaskListCard, handleListAction } from '../src/feishu/listCards';
import { setSession } from '../src/feishu/session';
import type { FeishuConfig } from '../src/config';
import type { FeishuSession } from '../src/feishu/session';

const cfg: FeishuConfig = { app_id: 'cli_x', app_secret: 'sec', approvers: ['ou_admin'] };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function makeConvoDeps() {
  return {
    list: vi.fn(async () => [
      { id: 'c1', title: '登录方案', status: 'idle', updated_at: '2026-09-26T10:00:00Z' },
      { id: 'c2', title: '数据库选型', status: 'running', updated_at: '2026-09-26T09:00:00Z' },
    ]),
    create: vi.fn(async (input: { title?: string }) => ({ id: 'c9', title: input.title || '未命名会话', status: 'idle', updated_at: '' })),
    send: vi.fn(async () => ({ queued: false })),
    stop: vi.fn(async () => {}),
    resolveApproval: vi.fn(async () => ({ id: 'ap1' })),
    answerAsk: vi.fn(async () => ({ id: 'ak1' })),
  };
}

function makeOcDeps() {
  return {
    listInstances: vi.fn(async () => [
      { id: 'main-exec', label: 'main-exec', kind: 'managed', state: 'running', mode: 'control' },
      { id: 'desktop', label: 'desktop', kind: 'attached-desktop', state: 'running', mode: 'control' },
    ]),
    activeSession: vi.fn(async () => ({ id: 's-1', title: '活跃会话' })),
    listSessions: vi.fn(async () => [{ id: 's-1', title: '活跃会话' }, { id: 's-2', title: '旧会话' }]),
    createSession: vi.fn(async (_instance: string, title?: string) => ({ id: 's-new', title: title || '新会话' })),
    sendPrompt: vi.fn(async () => ({ ok: true })),
    abort: vi.fn(async () => true),
    listModels: vi.fn(async () => [{ id: 'glm/glm-5.3', label: 'GLM-5.3', is_default: true }, { id: 'deepseek/deepseek-v4-pro', label: 'DS-4-Pro' }]),
    switchModel: vi.fn(async () => true),
    listAgents: vi.fn(async () => [{ id: 'dev', label: 'dev' }]),
    switchAgent: vi.fn(async () => true),
    readLastReply: vi.fn(async () => '已修复登录报错'),
    readRecent: vi.fn(async () => [{ role: 'user', text: '把登录页的报错修一下' }, { role: 'assistant', text: '已修复，改了 auth 模块' }]),
    pendingAll: vi.fn(() => ({ permissions: [], questions: [] })),
    answerPermission: vi.fn(async () => true),
    answerQuestion: vi.fn(async () => true),
    rejectQuestion: vi.fn(async () => true),
    eventSessionId: vi.fn((event: any) => event?.properties?.sessionID || ''),
    instanceKind: vi.fn(() => 'managed'),
  };
}

const freshSession = (): FeishuSession => ({ user_id: 'u1', last_active_time: new Date().toISOString() });

beforeEach(async () => {
  process.env.COTEAM_FORCE_MEMORY = '1';
  closeBus();
  await initBus({ host: '127.0.0.1', port: 6399, db: 0 });
  sendTextMock.mockClear();
  sendCardMock.mockClear();
});

afterEach(() => {
  closeBus();
});

describe('convo 桥', () => {
  it('/convo 进入模式并列出对话（默认绑最近活跃）', async () => {
    const bridge = createConvoBridge(makeConvoDeps());
    const session = freshSession();
    const r = await handleCommand('/convo', session, { listProjects: async () => [], listAgentNames: () => [], convo: bridge }, 'oc1');
    const cardText = String(JSON.stringify(r.card));
    expect(cardText).toContain('登录方案');
    expect(cardText).toContain('convo_pick');
    expect(r.session?.mode).toBe('convo');
    expect(r.session?.convo_id).toBe('c1');
    const bound = await busGet<{ chat_id: string }>('feishu:chat:convo:c1');
    expect(bound?.chat_id).toBe('oc1');
  });

  it('/switch 序号切换会话；/exit 返回任务模式；切换后预览最近对话', async () => {
    const bridge = createConvoBridge(makeConvoDeps());
    let session = freshSession();
    let r = await handleCommand('/convo', session, { listProjects: async () => [], listAgentNames: () => [], convo: bridge }, 'oc1');
    session = r.session!;
    await busSet('convo:c2:messages', [
      { role: 'user', kind: 'text', text: '选哪个数据库' },
      { role: 'assistant', kind: 'text', text: '建议 PostgreSQL' },
    ] as any);
    r = await handleCommand('/switch 2', session, { listProjects: async () => [], listAgentNames: () => [], convo: bridge }, 'oc1');
    expect(r.reply).toContain('数据库选型');
    expect(r.reply).toContain('最近对话');
    expect(r.reply).toContain('建议 PostgreSQL');
    expect(r.session?.convo_id).toBe('c2');
    r = await handleCommand('/exit', session, { listProjects: async () => [], listAgentNames: () => [], convo: bridge }, 'oc1');
    expect(r.session?.mode).toBe('task');
  });

  it('会话模式自由文本经桥发送并绑定聊天', async () => {
    const deps = makeConvoDeps();
    const bridge = createConvoBridge(deps);
    const session: FeishuSession = { ...freshSession(), mode: 'convo', convo_id: 'c1' };
    const reply = await bridge.send('继续讨论', session, 'oc1');
    expect(reply).toContain('已发送');
    expect(deps.send).toHaveBeenCalledWith('c1', '继续讨论');
    const bound = await busGet<{ chat_id: string }>('feishu:chat:convo:c1');
    expect(bound?.chat_id).toBe('oc1');
  });

  it('agent 终稿（convo_message）推富文本卡到绑定聊天；卡上输入框可快速回复', async () => {
    await busSet('feishu:chat:convo:c1', { chat_id: 'oc1', title: '登录方案' }, 3600);
    const deps = makeConvoDeps();
    const bridge = createConvoBridge(deps);
    const stop = bridge.start(cfg);
    await emitEvent(CHANNELS.DASHBOARD, 'convo_message', { convo_id: 'c1', message: { role: 'assistant', kind: 'text', text: '这是 agent 的回复' } });
    await vi.waitFor(() => expect(sendCardMock).toHaveBeenCalledTimes(1));
    const card = sendCardMock.mock.calls[0][2] as Record<string, any>;
    expect(card.header.title.content).toContain('登录方案');
    expect(JSON.stringify(card)).toContain('这是 agent 的回复');
    expect(JSON.stringify(card)).toContain('回复此会话');
    // 表单路由 + 引用回复路由均已注册
    const route = await busGet<Record<string, string>>('feishu:route:om_new1');
    expect(route).toMatchObject({ act: 'convo_reply', convo_id: 'c1' });
    const replyRoute = await busGet<{ kind: string }>('feishu:reply:om_new1');
    expect(replyRoute?.kind).toBe('convo');
    // 表单提交 → 注入会话 + 用户回显
    sendTextMock.mockClear();
    await bridge.handleCardAction(cfg, {
      operatorOpenId: 'ou_admin', messageId: 'om_new1', chatId: 'oc1', formValue: { reply: '补充一个细节' },
    });
    expect(deps.send).toHaveBeenCalledWith('c1', '补充一个细节');
    expect(sendTextMock.mock.calls.some((c) => String(c[2]).includes('你：补充一个细节'))).toBe(true);
    // 用户消息不推
    await emitEvent(CHANNELS.DASHBOARD, 'convo_message', { convo_id: 'c1', message: { role: 'user', kind: 'text', text: '用户的话' } });
    await sleep(25);
    stop();
  });

  it('convo 审批事件推按钮卡；批准动作转发 resolveApproval', async () => {
    await busSet('feishu:chat:convo:c1', { chat_id: 'oc1', title: '登录方案' }, 3600);
    const deps = makeConvoDeps();
    const bridge = createConvoBridge(deps);
    const stop = bridge.start(cfg);
    await emitEvent(CHANNELS.DASHBOARD, 'convo_approval', { convo_id: 'c1', approval: { id: 'ap1', command: 'npm publish', status: 'pending' } });
    await vi.waitFor(() => expect(sendCardMock).toHaveBeenCalledTimes(1));
    expect(JSON.stringify(sendCardMock.mock.calls[0][2])).toContain('批准一次');

    await bridge.handleCardAction(cfg, {
      operatorOpenId: 'ou_admin', messageId: 'om_card', chatId: 'oc1',
      value: { act: 'convo_approve', convo_id: 'c1', approval_id: 'ap1', action: 'once' },
    });
    expect(deps.resolveApproval).toHaveBeenCalledWith('c1', 'ap1', 'once');
    stop();
  });
});

describe('oc 桥', () => {
  it('/oc 自动绑定 running 实例与活动会话', async () => {
    const bridge = createOcBridge(makeOcDeps());
    const session = freshSession();
    const r = await handleCommand('/oc', session, { listProjects: async () => [], listAgentNames: () => [], oc: bridge }, 'oc1');
    const cardText = String(JSON.stringify(r.card));
    expect(cardText).toContain('main-exec');
    expect(cardText).toContain('oc_pick_session');
    expect(r.session?.oc_instance).toBe('main-exec');
    expect(r.session?.oc_session).toBe('s-1');
    expect(r.session?.mode).toBe('oc');
    const notify = await busGet<{ chat_id: string }>('feishu:oc:notify_chat');
    expect(notify?.chat_id).toBe('oc1');
  });

  it('/model 裸命令列选项；/model 2 切换（序号→provider/model）', async () => {
    const deps = makeOcDeps();
    const bridge = createOcBridge(deps);
    const session: FeishuSession = { ...freshSession(), mode: 'oc', oc_instance: 'main-exec', oc_session: 's-1' };
    let r = await handleCommand('/model', session, { listProjects: async () => [], listAgentNames: () => [], oc: bridge }, 'oc1');
    expect(String(JSON.stringify(r.card))).toContain('GLM-5.3');
    expect(String(JSON.stringify(r.card))).toContain('（默认）');
    r = await handleCommand('/model 2', session, { listProjects: async () => [], listAgentNames: () => [], oc: bridge }, 'oc1');
    expect(deps.switchModel).toHaveBeenCalledWith('main-exec', 's-1', 'deepseek/deepseek-v4-pro');
    expect(r.reply).toContain('已切换模型');
  });

  it('/switch 序号切会话并预览最近对话', async () => {
    const deps = makeOcDeps();
    const bridge = createOcBridge(deps);
    const session: FeishuSession = { ...freshSession(), mode: 'oc', oc_instance: 'main-exec' };
    let r = await handleCommand('/list', session, { listProjects: async () => [], listAgentNames: () => [], oc: bridge }, 'oc1');
    expect(String(JSON.stringify(r.card))).toContain('活跃会话');
    r = await handleCommand('/switch 2', session, { listProjects: async () => [], listAgentNames: () => [], oc: bridge }, 'oc1');
    expect(r.reply).toContain('已切换到会话');
    expect(r.reply).toContain('最近对话');
    expect(r.reply).toContain('已修复');
    expect(deps.readRecent).toHaveBeenCalledWith('main-exec', 's-2', 4);
    expect(r.session?.oc_session).toBe('s-2');
  });

  it('oc 自由文本发 prompt 并回执受理', async () => {
    const deps = makeOcDeps();
    const bridge = createOcBridge(deps);
    const session: FeishuSession = { ...freshSession(), mode: 'oc', oc_instance: 'main-exec', oc_session: 's-1' };
    const reply = await bridge.send('把登录页的报错修一下', session, 'oc1');
    expect(reply).toContain('已发送到 main-exec');
    expect(deps.sendPrompt).toHaveBeenCalledWith('main-exec', 's-1', '把登录页的报错修一下');
    const notify = await busGet<{ chat_id: string }>('feishu:oc:notify_chat');
    expect(notify?.chat_id).toBe('oc1');
  });

  it('全局监控：session.idle → 读回复推完成卡（去重）+ 卡上快速回复', async () => {
    const deps = makeOcDeps();
    const bridge = createOcBridge(deps);
    const stop = bridge.start(cfg);
    await busSet('feishu:oc:notify_chat', { chat_id: 'oc1' }, 3600);
    await emitEvent(CHANNELS.DASHBOARD, 'oc_event', { instance: 'main-exec', event: { type: 'session.idle', properties: { sessionID: 's-1' }, id: 'e1' } });
    await vi.waitFor(() => expect(sendCardMock).toHaveBeenCalledTimes(1));
    const card = sendCardMock.mock.calls[0][2] as Record<string, any>;
    expect(card.header.title.content).toContain('已完成');
    expect(JSON.stringify(card)).toContain('已修复登录报错');
    expect(JSON.stringify(card)).toContain('继续此会话');
    // 路由注册：表单 + 引用回复
    const route = await busGet<Record<string, string>>('feishu:route:om_new1');
    expect(route).toMatchObject({ act: 'oc_reply', instance: 'main-exec', session_id: 's-1' });
    const replyRoute = await busGet<{ kind: string }>('feishu:reply:om_new1');
    expect(replyRoute?.kind).toBe('oc');
    // 同一轮重推（同 event id）→ 去重
    await emitEvent(CHANNELS.DASHBOARD, 'oc_event', { instance: 'main-exec', event: { type: 'session.idle', properties: { sessionID: 's-1' }, id: 'e1' } });
    await sleep(25);
    expect(sendCardMock).toHaveBeenCalledTimes(1);
    // 完成卡表单提交 → 继续向该会话发 prompt
    sendTextMock.mockClear();
    await bridge.handleCardAction(cfg, {
      operatorOpenId: 'ou_admin', messageId: 'om_new1', chatId: 'oc1', formValue: { reply: '再跑一轮回归' },
    });
    expect(deps.sendPrompt).toHaveBeenCalledWith('main-exec', 's-1', '再跑一轮回归');
    expect(sendTextMock.mock.calls.some((c) => String(c[2]).includes('完成后推送结果'))).toBe(true);
    stop();
  });

  it('oc_watch=managed 时 attached 实例的完成事件不推送', async () => {
    const deps = makeOcDeps();
    deps.instanceKind = vi.fn((id: string) => (id === 'main-exec' ? 'managed' : 'attached-desktop'));
    const bridge = createOcBridge(deps);
    const stop = bridge.start({ ...cfg, oc_watch: 'managed' } as FeishuConfig);
    await busSet('feishu:oc:notify_chat', { chat_id: 'oc1' }, 3600);
    await emitEvent(CHANNELS.DASHBOARD, 'oc_event', { instance: 'desktop', event: { type: 'session.idle', properties: { sessionID: 's-9' }, id: 'e9' } });
    await sleep(30);
    expect(sendCardMock).not.toHaveBeenCalled();
    stop();
  });

  it('pending 权限扫描推三按钮卡；批准动作转发 answerPermission', async () => {
    const deps = makeOcDeps();
    deps.pendingAll = vi.fn(() => ({ permissions: [{ instance: 'main-exec', id: 'perm1', sessionID: 's-1', title: 'rm -rf dist' }], questions: [] }));
    const bridge = createOcBridge(deps);
    await busSet('feishu:oc:notify_chat', { chat_id: 'oc1' }, 3600);
    await bridge.scanPendingOnce(cfg);
    expect(sendCardMock).toHaveBeenCalledTimes(1);
    const card = sendCardMock.mock.calls[0][2] as Record<string, any>;
    expect(card.header.title.content).toContain('权限待确认');
    expect(JSON.stringify(card)).toContain('perm1');

    // 再次扫描 → 去重不重推
    await bridge.scanPendingOnce(cfg);
    expect(sendCardMock).toHaveBeenCalledTimes(1);

    await bridge.handleCardAction(cfg, {
      operatorOpenId: 'ou_admin', messageId: 'om_card', chatId: 'oc1',
      value: { act: 'oc_perm', instance: 'main-exec', session_id: 's-1', permission_id: 'perm1', response: 'once' },
    });
    expect(deps.answerPermission).toHaveBeenCalledWith('main-exec', 's-1', 'perm1', 'once');
  });

  it('pending 提问扫描推表单卡并注册路由；回答转发 answerQuestion', async () => {
    const deps = makeOcDeps();
    deps.pendingAll = vi.fn(() => ({ permissions: [], questions: [{ instance: 'main-exec', id: 'q1', question: '要继续吗？' }] }));
    const bridge = createOcBridge(deps);
    await busSet('feishu:oc:notify_chat', { chat_id: 'oc1' }, 3600);
    await bridge.scanPendingOnce(cfg);
    expect(sendCardMock).toHaveBeenCalledTimes(1);
    const route = await busGet<Record<string, string>>('feishu:route:om_new1');
    expect(route).toMatchObject({ act: 'oc_question', instance: 'main-exec', request_id: 'q1' });

    await bridge.handleCardAction(cfg, {
      operatorOpenId: 'ou_admin', messageId: 'om_new1', chatId: 'oc1', formValue: { answer: '继续' },
    });
    expect(deps.answerQuestion).toHaveBeenCalledWith('main-exec', 'q1', [['继续']]);
  });
});

describe('收件箱（/inbox）', () => {
  it('聚合四类待拍板项并编号列出；/inbox 序号重推对应卡片', async () => {
    await saveTaskGraph('t1', [{ id: 'n1', name: '坏节点', status: 'waiting_approval' } as any], [], { workspace: '/w', project_id: 'p1', status: 'running' });
    await busSet('task:pending_commands:t1', [{ id: 'pc1', node_id: 'n1', node_name: 'x', command: 'npm publish', ts: '' }]);
    await busSet('task:asks:t1', [{ id: 'a1', from: 'dev', to: 'user', question: '用哪个端口？', status: 'pending', ts: '', task_id: 't1' }]);
    const ocDeps = makeOcDeps();
    const bridge = createInboxBridge(cfg, { ocPending: () => ocDeps.pendingAll() });
    const session = freshSession();
    const r = await handleCommand('/inbox', session, { listProjects: async () => [], listAgentNames: () => [], inbox: bridge }, 'oc1');
    const cardText = String(JSON.stringify(r.card));
    expect(cardText).toContain('待拍板收件箱');
    expect(cardText).toContain('节点审批');
    expect(cardText).toContain('命令审批');
    expect(cardText).toContain('阻塞提问');
    expect(cardText).toContain('inbox_open'); // 每条一枚 [处理] 按钮

    // 点 [处理]（第 3 条 ask）→ 对应决策卡重推
    sendCardMock.mockClear();
    await bridge.handleCardAction(cfg, {
      operatorOpenId: session.user_id, messageId: 'om_card', chatId: 'oc1', value: { act: 'inbox_open', index: 2 },
    });
    expect(sendCardMock).toHaveBeenCalledTimes(1);
    const route = await busGet<Record<string, string>>('feishu:route:om_new1');
    expect(route).toMatchObject({ act: 'ask_answer', task_id: 't1', ask_id: 'a1' });
  });

  it('没有待拍板时回复为空态', async () => {
    const bridge = createInboxBridge(cfg);
    const r = await handleCommand('/inbox', freshSession(), { listProjects: async () => [], listAgentNames: () => [], inbox: bridge }, 'oc1');
    expect(String(JSON.stringify(r.card))).toContain('没有等你拍板');
  });
});

describe('白名单学习（command_always）', () => {
  it('批准 + 写全局白名单；重复放行回 already', async () => {
    await busSet('task:pending_commands:t1', [{ id: 'pc1', node_id: 'n1', node_name: 'x', command: 'npm publish', ts: '' }]);
    const always = vi.fn(async () => ({ ok: true }));
    const deps = {
      getTaskGraph: vi.fn(async () => null),
      enqueue: vi.fn(async () => ({})),
      abortTask: vi.fn(),
      removePending: vi.fn(async () => {}),
      resolvePendingCommand: vi.fn(async () => ({ ok: true })),
      alwaysAllowCommand: always,
    };
    await handleCardAction(cfg, deps as any, {
      operatorOpenId: 'ou_admin', messageId: 'om_card', chatId: 'oc1',
      value: { act: 'command_always', task_id: 't1', command_id: 'pc1' },
    });
    expect(deps.resolvePendingCommand).toHaveBeenCalledWith('t1', 'pc1', true);
    expect(always).toHaveBeenCalledWith('npm publish');

    always.mockClear();
    always.mockResolvedValue({ ok: true, already: true });
    await handleCardAction(cfg, deps as any, {
      operatorOpenId: 'ou_admin', messageId: 'om_card2', chatId: 'oc1',
      value: { act: 'command_always', task_id: 't1', command_id: 'pc1' },
    });
    expect(always).toHaveBeenCalled();
  });
});

describe('oc 卡住检测', () => {
  it('有活动但超阈值无事件 → 推提醒卡并清除跟踪；忽略后不再推', async () => {
    const deps = makeOcDeps();
    const bridge = createOcBridge(deps);
    const stop = bridge.start(cfg);
    await busSet('feishu:oc:notify_chat', { chat_id: 'oc1' }, 3600);
    await emitEvent(CHANNELS.DASHBOARD, 'oc_event', { instance: 'main-exec', event: { type: 'message.part.delta', properties: { sessionID: 's-1' }, id: 'd1' } });
    await bridge.scanStalled(cfg, 0);
    await vi.waitFor(() => expect(sendCardMock).toHaveBeenCalledTimes(1));
    const card = sendCardMock.mock.calls[0][2] as Record<string, any>;
    expect(card.header.title.content).toContain('疑似卡住');
    expect(JSON.stringify(card)).toContain('oc_abort');
    // 跟踪已清除 → 再扫不再推
    await bridge.scanStalled(cfg, 0);
    await sleep(25);
    expect(sendCardMock).toHaveBeenCalledTimes(1);
    stop();
  });
});

describe('交互列表卡与翻页（listCards）', () => {
  const eightTasks = Array.from({ length: 8 }, (_, i) => ({ id: `t-${i + 1}`, description: `任务 ${i + 1}`, status: 'success', project_id: null }));

  it('任务列表卡分页：第 0 页 6 条+下一页，第 1 页 2 条+上一页', () => {
    const p0 = buildTaskListCard(eightTasks, 0);
    expect(JSON.stringify(p0)).toContain('下一页');
    expect(JSON.stringify(p0)).not.toContain('上一页');
    const p1 = buildTaskListCard(eightTasks, 1);
    expect(JSON.stringify(p1)).toContain('上一页');
    expect(JSON.stringify(p1)).toContain('t-8');
    expect(JSON.stringify(p1)).not.toContain('t-1');
  });

  it('tasks_page 点击 → 按会话项目重拉数据渲染该页', async () => {
    const listTasks = vi.fn(async () => eightTasks.map((t) => ({ ...t, project_id: null })));
    const deps = {
      listTasks,
      getSession: vi.fn(async () => ({})),
      convoList: vi.fn(async () => []),
      inboxLoad: vi.fn(async () => null),
    };
    const r = await handleListAction(cfg, deps, {
      operatorOpenId: 'ou_admin', messageId: 'om_list', chatId: 'oc1', value: { act: 'tasks_page', page: 1 },
    });
    const card = (r as any).card;
    expect(card.data.header.title.content).toBe('📋 最近任务');
    expect(JSON.stringify(card)).toContain('第 2/2 页');
  });

  it('task_detail → 进度卡（节点+最近动态+取消按钮）', async () => {
    await saveTaskGraph('t9', [{ id: 'n1', name: '实现登录', status: 'completed' } as any], [], { workspace: '/w', status: 'running' });
    await busSet('task:t9:agent:dev:journal', [{ ts: '2026-09-27T10:00:00Z', role: 'dev', kind: 'brief', text: '完成了登录模块', node_name: '实现登录', node_id: 'n1' }]);
    const r = await handleListAction(cfg, {
      listTasks: vi.fn(async () => []),
      getSession: vi.fn(async () => ({})),
      convoList: vi.fn(async () => []),
      inboxLoad: vi.fn(async () => null),
    }, {
      operatorOpenId: 'ou_admin', messageId: 'om_list', chatId: 'oc1', value: { act: 'task_detail', task_id: 't9' },
    });
    const card = (r as any).card;
    expect(card.data.header.title.content).toBe('📄 任务 t9');
    expect(JSON.stringify(card)).toContain('最近动态');
    expect(JSON.stringify(card)).toContain('取消任务');
  });

  it('convo_pick 点选切换：绑定会话并推送预览', async () => {
    const deps = makeConvoDeps();
    const bridge = createConvoBridge(deps);
    await busSet('convo:c2:messages', [
      { role: 'user', kind: 'text', text: '选哪个数据库' },
      { role: 'assistant', kind: 'text', text: '建议 PostgreSQL' },
    ] as any);
    await bridge.handleCardAction(cfg, {
      operatorOpenId: 'ou_admin', messageId: 'om_card', chatId: 'oc1', value: { act: 'convo_pick', convo_id: 'c2' },
    });
    expect(deps.list).toHaveBeenCalled();
    expect(sendTextMock.mock.calls.some((c) => String(c[2]).includes('已切换到「数据库选型」'))).toBe(true);
    expect(sendTextMock.mock.calls.some((c) => String(c[2]).includes('建议 PostgreSQL'))).toBe(true);
    const session = await (await import('../src/feishu/session')).getSession('ou_admin');
    expect(session.convo_id).toBe('c2');
  });

  it('oc_pick_model 点选切换', async () => {
    const deps = makeOcDeps();
    const bridge = createOcBridge(deps);
    await setSession({ user_id: 'ou_admin', last_active_time: '', mode: 'oc', oc_instance: 'main-exec', oc_session: 's-1' });
    await bridge.handleCardAction(cfg, {
      operatorOpenId: 'ou_admin', messageId: 'om_card', chatId: 'oc1',
      value: { act: 'oc_pick_model', model_id: 'deepseek/deepseek-v4-pro' },
    });
    const session = await (await import('../src/feishu/session')).getSession('ou_admin');
    expect(session.oc_instance).toBe('main-exec');
    expect(deps.switchModel).toHaveBeenCalledWith('main-exec', 's-1', 'deepseek/deepseek-v4-pro');
  });

  it('/tasks 命令返回交互卡（第 0 页）', async () => {
    const listTasks = vi.fn(async () => eightTasks.map((t) => ({ ...t, project_id: null })));
    const r = await handleCommand('/tasks', freshSession(), { listProjects: async () => [], listAgentNames: () => [], listTasks }, 'oc1');
    expect(r.card).toBeDefined();
    expect(String(JSON.stringify(r.card))).toContain('下一页');
    expect(String(JSON.stringify(r.card))).toContain('t-1 详情');
  });
});
