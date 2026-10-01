import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const sendTextMock = vi.fn(async () => 'om_t');
const sendCardMock = vi.fn(async () => 'om_new1');
const updateCardMock = vi.fn(async () => true);
vi.mock('../src/feishu/messageService', () => ({
  sendText: (...a: unknown[]) => sendTextMock(...(a as [any, any, any])),
  sendCard: (...a: unknown[]) => sendCardMock(...(a as [any, any, any])),
  updateCard: (...a: unknown[]) => updateCardMock(...(a as [any, any, any])),
  buildTaskCard: () => ({}),
}));

import { closeBus, busGet, busSet, busDel, initBus } from '../src/bus';
import { emitEvent, saveProject, saveTaskGraph } from '../src/store';
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
      { id: 'c1', title: '登录方案', status: 'idle', updated_at: '2026-09-26T10:00:00Z', workspace: 'D:/convo' },
      { id: 'c2', title: '数据库选型', status: 'running', updated_at: '2026-09-26T09:00:00Z', workspace: 'D:/convo' },
    ]),
    create: vi.fn(async (input: { title?: string }) => ({ id: 'c9', title: input.title || '未命名会话', status: 'idle', updated_at: '' })),
    send: vi.fn(async () => ({ queued: false })),
    stop: vi.fn(async () => {}),
    resolveApproval: vi.fn(async () => ({ id: 'ap1' })),
    answerAsk: vi.fn(async () => ({ id: 'ak1' })),
    listProjects: vi.fn(async () => [{ id: 'p1', name: 'co-team', workspace: 'D:/convo' }]),
  };
}

function makeOcDeps() {
  return {
    listInstances: vi.fn(async () => [
      { id: 'main-exec', label: 'main-exec', kind: 'managed', state: 'running', mode: 'control', project_root: 'D:/main' },
      { id: 'desktop', label: 'desktop', kind: 'attached-desktop', state: 'running', mode: 'control', project_root: 'D:/desk' },
    ]),
    activeSession: vi.fn(async () => ({ id: 's-1', title: '活跃会话' })),
    listSessions: vi.fn(async () => [{ id: 's-1', title: '活跃会话', directory: 'D:/main' }, { id: 's-2', title: '旧会话', directory: 'D:/main' }]),
    createSession: vi.fn(async (_instance: string, title?: string) => ({ id: 's-new', title: title || '新会话' })),
    sendPrompt: vi.fn(async () => ({ ok: true })),
    abort: vi.fn(async () => true),
    listModels: vi.fn(async () => [{ id: 'glm/glm-5.3', label: 'GLM-5.3', is_default: true }, { id: 'deepseek/deepseek-v4-pro', label: 'DS-4-Pro' }]),
    switchModel: vi.fn(async () => true),
    listAgents: vi.fn(async () => [{ id: 'dev', label: 'dev' }]),
    switchAgent: vi.fn(async () => true),
    readLastReply: vi.fn(async () => '已修复登录报错'),
    readRecent: vi.fn(async () => [{ role: 'user', text: '把登录页的报错修一下' }, { role: 'assistant', text: '已修复，改了 auth 模块' }]),
    listProjects: vi.fn(async () => [{ id: 'p1', name: 'co-team', workspace: 'D:/main' }]),
    pendingAll: vi.fn(() => ({ permissions: [], questions: [] })),
    sessionAlive: vi.fn(async () => true),
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
  updateCardMock.mockClear();
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

  it('convo 审批/提问卡带来源（Co-Team 协作会话）与项目名——别和 OpenCode 的卡混了', async () => {
    await busSet('feishu:chat:convo:c1', { chat_id: 'oc1', title: '登录方案' }, 3600);
    const deps = makeConvoDeps();
    const bridge = createConvoBridge(deps);
    const stop = bridge.start(cfg);
    await emitEvent(CHANNELS.DASHBOARD, 'convo_approval', { convo_id: 'c1', approval: { id: 'ap1', command: 'npm publish', status: 'pending' } });
    await vi.waitFor(() => expect(sendCardMock).toHaveBeenCalledTimes(1));
    const approveBody = JSON.stringify(sendCardMock.mock.calls[0][2]);
    expect(approveBody).toContain('Co-Team 协作会话');
    expect(approveBody).toContain('项目 co-team');

    sendCardMock.mockClear();
    await emitEvent(CHANNELS.DASHBOARD, 'convo_ask', { convo_id: 'c1', ask: { id: 'ak1', question: '用哪个端口？', status: 'pending' } });
    await vi.waitFor(() => expect(sendCardMock).toHaveBeenCalledTimes(1));
    const askBody = JSON.stringify(sendCardMock.mock.calls[0][2]);
    expect(askBody).toContain('Co-Team 协作会话');
    expect(askBody).toContain('项目 co-team · 会话 登录方案');
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

  it('pending 权限扫描推三按钮卡（动作/目标/总是批准规则可见）；批准动作转发 answerPermission', async () => {
    const deps = makeOcDeps();
    // 实盘载荷（GET /api/opencode/pending）：v2 是 {action, resources, save}，没有 title/pattern
    deps.pendingAll = vi.fn(() => ({
      permissions: [{ instance: 'main-exec', id: 'perm1', sessionID: 's-1', action: 'bash', resources: ['rm -rf dist'], save: ['rm -rf *'] }],
      questions: [],
    }));
    const bridge = createOcBridge(deps);
    await busSet('feishu:oc:notify_chat', { chat_id: 'oc1' }, 3600);
    await bridge.scanPendingOnce(cfg);
    expect(sendCardMock).toHaveBeenCalledTimes(1);
    const card = sendCardMock.mock.calls[0][2] as Record<string, any>;
    const body = JSON.stringify(card);
    expect(card.header.title.content).toContain('权限待确认');
    // 关键回归：申请内容必须出现在卡上（旧实现只读到「权限请求」四个字）
    expect(card.header.title.content).toContain('执行命令');
    expect(body).toContain('rm -rf dist');
    expect(body).toContain('总是批准将记住');
    expect(body).toContain('rm -rf *');
    expect(body).not.toContain('权限请求 · ·');
    // 会话上下文：标题 + 目录
    expect(body).toContain('活跃会话');
    expect(body).toContain('D:/main');
    // 来源与项目：OpenCode 外部引擎提的，卡上要能看出是哪个项目（实例退到来源行）
    expect(body).toContain('来源');
    expect(body).toContain('OpenCode · 实例 main-exec · 项目 co-team');
    expect(card.header.title.content).toContain('co-team');

    // 再次扫描 → 去重不重推
    await bridge.scanPendingOnce(cfg);
    expect(sendCardMock).toHaveBeenCalledTimes(1);

    const r = await bridge.handleCardAction(cfg, {
      operatorOpenId: 'ou_admin', messageId: 'om_card', chatId: 'oc1',
      value: { act: 'oc_perm', instance: 'main-exec', session_id: 's-1', permission_id: 'perm1', response: 'once', brief: '执行命令 rm -rf dist' },
    });
    expect(deps.answerPermission).toHaveBeenCalledWith('main-exec', 's-1', 'perm1', 'once');
    // 回执带申请内容，不再是一串 id
    expect(JSON.stringify(r)).toContain('rm -rf dist');
  });

  it('pending 权限卡：多条/超长资源进折叠面板，单条不展开', async () => {
    const deps = makeOcDeps();
    const many = Array.from({ length: 8 }, (_, i) => `src/file-${i}.ts`);
    deps.pendingAll = vi.fn(() => ({
      permissions: [
        { instance: 'main-exec', id: 'perm-many', sessionID: 's-1', action: 'write', resources: many },
        { instance: 'main-exec', id: 'perm-one', sessionID: 's-1', action: 'read', resources: ['a.ts'] },
      ],
      questions: [],
    }));
    const bridge = createOcBridge(deps);
    await busSet('feishu:oc:notify_chat', { chat_id: 'oc1' }, 3600);
    await bridge.scanPendingOnce(cfg);
    expect(sendCardMock).toHaveBeenCalledTimes(2);
    const manyBody = JSON.stringify(sendCardMock.mock.calls[0][2]);
    expect(manyBody).toContain('collapsible_panel');
    expect(manyBody).toContain('src/file-7.ts');
    const oneBody = JSON.stringify(sendCardMock.mock.calls[1][2]);
    expect(oneBody).toContain('读取文件');
    expect(oneBody).toContain('a.ts');
    expect(oneBody).not.toContain('collapsible_panel');
  });

  it('pending 提问扫描推表单卡（问题正文+输入框）并注册路由；表单提交转发 answerQuestion（带会话 hint）', async () => {
    const deps = makeOcDeps();
    deps.pendingAll = vi.fn(() => ({ permissions: [], questions: [{ instance: 'main-exec', id: 'q1', requestID: 'q1', sessionID: 's-1', title: 'Questions', questions: [{ key: 'note', type: 'input', question: '要继续吗？' }] }] }));
    const bridge = createOcBridge(deps);
    await busSet('feishu:oc:notify_chat', { chat_id: 'oc1' }, 3600);
    await bridge.scanPendingOnce(cfg);
    expect(sendCardMock).toHaveBeenCalledTimes(1);
    const route = await busGet<any>('feishu:route:om_new1');
    expect(route).toMatchObject({ act: 'oc_form', instance: 'main-exec', request_id: 'q1', session_id: 's-1' });
    // 问题正文来自 questions[].question（此前误取 title="Questions" 导致卡片空白）
    expect(String(JSON.stringify(sendCardMock.mock.calls[0][2]))).toContain('要继续吗？');

    await bridge.handleCardAction(cfg, {
      operatorOpenId: 'ou_admin', messageId: 'om_new1', chatId: 'oc1', formValue: { in_note: '继续' },
    });
    // 第 4 参 = 会话 hint：form.list 按 location 定界，跨目录表单靠它排扫描最前（"回答了没反应"根因）
    expect(deps.answerQuestion).toHaveBeenCalledWith('main-exec', 'q1', { note: '继续' }, 's-1');
  });

  it('提问卡「忽略此提问」：置忽略键，之后即使去重键过期也不再推送', async () => {
    const deps = makeOcDeps();
    deps.pendingAll = vi.fn(() => ({ permissions: [], questions: [{ instance: 'main-exec', id: 'q9', requestID: 'q9', sessionID: 's-1', title: 'T', questions: [{ key: 'a', type: 'input', question: '问题？' }] }] }));
    const bridge = createOcBridge(deps);
    await busSet('feishu:oc:notify_chat', { chat_id: 'oc1' }, 3600);
    await bridge.scanPendingOnce(cfg);
    expect(sendCardMock).toHaveBeenCalledTimes(1);

    await bridge.handleCardAction(cfg, { operatorOpenId: 'ou_admin', value: { act: 'oc_ignore', instance: 'main-exec', request_id: 'q9' } });
    expect(await busGet('feishu:oc:qignore:q9')).toBeTruthy();

    // 模拟去重键过期：qseen 撤掉后，若没有忽略键会 1h 重推一次（"已回答过的问题反复出现"的同款节奏）
    await busDel('feishu:oc:qseen:q9');
    sendCardMock.mockClear();
    await bridge.scanPendingOnce(cfg);
    expect(sendCardMock).not.toHaveBeenCalled();
  });

  it('权限卡「忽略此审批」：置忽略键，之后即使去重键过期也不再推送', async () => {
    const deps = makeOcDeps();
    deps.pendingAll = vi.fn(() => ({
      permissions: [{ id: 'p9', permissionID: 'p9', instance: 'main-exec', sessionID: 's-1', action: 'bash', resources: ['rm -rf dist'] }],
      questions: [],
    }));
    const bridge = createOcBridge(deps);
    await busSet('feishu:oc:notify_chat', { chat_id: 'oc1' }, 3600);
    await bridge.scanPendingOnce(cfg);
    expect(sendCardMock).toHaveBeenCalledTimes(1);

    await bridge.handleCardAction(cfg, { operatorOpenId: 'ou_admin', value: { act: 'oc_perm_ignore', instance: 'main-exec', session_id: 's-1', permission_id: 'p9' } });
    expect(await busGet('feishu:oc:permignore:p9')).toBeTruthy();

    await busDel('feishu:oc:permseen:p9');
    sendCardMock.mockClear();
    await bridge.scanPendingOnce(cfg);
    expect(sendCardMock).not.toHaveBeenCalled();
  });

  it('空内容提问不推卡（零字段没法作答，点了提交也永远过不了校验）；去重键照烧防 30s 连环刷', async () => {
    const deps = makeOcDeps();
    deps.pendingAll = vi.fn(() => ({ permissions: [], questions: [{ instance: 'main-exec', id: 'qe', requestID: 'qe', sessionID: 's-1', title: 'Questions', questions: [] }] }));
    const bridge = createOcBridge(deps);
    await busSet('feishu:oc:notify_chat', { chat_id: 'oc1' }, 3600);
    await bridge.scanPendingOnce(cfg);
    expect(sendCardMock).not.toHaveBeenCalled();
    expect(await busGet('feishu:oc:qseen:qe')).toBeTruthy();
    // 收件箱同款守卫：空提问也不进收件箱列表卡
    const inbox = createInboxBridge(cfg, { ocPending: () => deps.pendingAll() });
    const card = await inbox.listCard('u1');
    expect(String(JSON.stringify(card))).not.toContain('OC 提问');
  });

  it('pending 提问：会话已不存在时不推卡，且不烧去重键——会话回来仍会提醒', async () => {
    const deps = makeOcDeps();
    deps.pendingAll = vi.fn(() => ({ permissions: [], questions: [{ instance: 'desktop', id: 'q9', requestID: 'q9', sessionID: 's-gone', title: 'Questions', questions: [{ key: 'db', type: 'select', question: '选择数据库', options: [{ label: 'SQLite', value: 'sqlite' }] }] }] }));
    deps.sessionAlive = vi.fn(async () => false); // 幽灵会话：按 id 读消息 404（删库没杀内存会话）
    const bridge = createOcBridge(deps);
    await busSet('feishu:oc:notify_chat', { chat_id: 'oc1' }, 3600);
    await bridge.scanPendingOnce(cfg);
    expect(sendCardMock).not.toHaveBeenCalled();
    // 关键：跳过不等于已提醒——去重键不能烧，否则会话恢复后永远等不到这张卡
    expect(await busGet('feishu:oc:qseen:q9')).toBeNull();

    // 会话恢复（或探针改判活着）→ 下一轮照常推，且只推一次
    deps.sessionAlive = vi.fn(async () => true);
    await bridge.scanPendingOnce(cfg);
    expect(sendCardMock).toHaveBeenCalledTimes(1);
    await bridge.scanPendingOnce(cfg);
    expect(sendCardMock).toHaveBeenCalledTimes(1);
  });

  it('pending 权限：会话已不存在时不推卡；探针未知（null）不拦截，保持原行为', async () => {
    const deps = makeOcDeps();
    deps.pendingAll = vi.fn(() => ({
      permissions: [
        { instance: 'desktop', id: 'per-gone', permissionID: 'per-gone', sessionID: 's-gone', action: 'external_directory' },
        { instance: 'desktop', id: 'per-unknown', permissionID: 'per-unknown', sessionID: 's-unknown', action: 'external_directory' },
      ],
      questions: [],
    }));
    deps.sessionAlive = vi.fn(async (_i: string, sid: string) => (sid === 's-gone' ? false : null));
    const bridge = createOcBridge(deps);
    await busSet('feishu:oc:notify_chat', { chat_id: 'oc1' }, 3600);
    await bridge.scanPendingOnce(cfg);
    expect(sendCardMock).toHaveBeenCalledTimes(1); // 只剩「未知」那条
    expect(await busGet('feishu:oc:permseen:per-gone')).toBeNull();
    expect(await busGet('feishu:oc:permseen:per-unknown')).not.toBeNull();
  });

  it('选择题点选记录答案刷新卡（不再点选即自动提交——自定义录入没机会填）；完整问题信息上卡（描述正文+选项说明+自定义录入）', async () => {
    const deps = makeOcDeps();
    deps.pendingAll = vi.fn(() => ({ permissions: [], questions: [{
      instance: 'main-exec', id: 'q2', requestID: 'q2', title: '提交 3.4b',
      questions: [{
        key: 'how', type: 'select', question: '怎么处理？', required: true,
        description: '3.4b 的改动（14 改 + 6 新增，含文档同步）已全部验证通过。是否现在提交？',
        options: [
          { label: '提交，不推送（推荐）', value: 'fix', description: '按前几批的做法：本地 commit，仓库无远端不推送' },
          { label: '只记录', value: 'record', description: '保留工作区改动，等看过代码再决定' },
        ],
      }],
    }] }));
    const bridge = createOcBridge(deps);
    await busSet('feishu:oc:notify_chat', { chat_id: 'oc1' }, 3600);
    await bridge.scanPendingOnce(cfg);
    expect(sendCardMock).toHaveBeenCalledTimes(1);
    const cardJson = JSON.stringify(sendCardMock.mock.calls[0][2]);
    // 完整问题信息：题目描述正文 + 每个选项的说明都上卡（此前只有一行短标题"根本无法回答"）
    expect(cardJson).toContain('3.4b 的改动（14 改 + 6 新增，含文档同步）已全部验证通过');
    expect(cardJson).toContain('↳ 按前几批的做法：本地 commit，仓库无远端不推送');
    expect(cardJson).toContain('↳ 保留工作区改动，等看过代码再决定');
    // 每题带自定义录入框（填写后优先于选项）
    expect(cardJson).toContain('自定义答案');

    // 点选项 1 → 只记录答案返回刷新卡（✓ 标记），不再自动提交
    await bridge.handleCardAction(cfg, {
      operatorOpenId: 'ou_admin', messageId: 'om_new1', chatId: 'oc1',
      value: { act: 'oc_form_pick', key: 'how', value: 'fix' },
    });
    expect(deps.answerQuestion).not.toHaveBeenCalled();

    // 表单提交：自定义录入覆盖点选，一起发给 oc
    const r1 = await bridge.handleCardAction(cfg, {
      operatorOpenId: 'ou_admin', messageId: 'om_new1', chatId: 'oc1',
      formValue: { in_how: '先提交一半，剩下的等验收' },
    });
    expect(deps.answerQuestion).toHaveBeenCalledWith('main-exec', 'q2', { how: '先提交一半，剩下的等验收' }, undefined);
    expect(JSON.stringify(r1)).toContain('已提交回答');
  });

  it('多题表单：逐题点选全部答完仍返回刷新卡（统一走提交按钮）；只点选不填录入时按点选提交', async () => {
    const deps = makeOcDeps();
    deps.pendingAll = vi.fn(() => ({ permissions: [], questions: [{ instance: 'main-exec', id: 'q3', requestID: 'q3', title: 'T', questions: [{ key: 'a', type: 'select', question: '题一', options: [{ label: 'x', value: 'x' }] }, { key: 'b', type: 'select', question: '题二', options: [{ label: 'y', value: 'y' }] }] }] }));
    const bridge = createOcBridge(deps);
    await busSet('feishu:oc:notify_chat', { chat_id: 'oc1' }, 3600);
    await bridge.scanPendingOnce(cfg);
    // 点题一 → 返回刷新表单卡（不提交）
    const r1 = await bridge.handleCardAction(cfg, {
      operatorOpenId: 'ou_admin', messageId: 'om_new1', chatId: 'oc1',
      value: { act: 'oc_form_pick', key: 'a', value: 'x' },
    });
    expect(deps.answerQuestion).not.toHaveBeenCalled();
    expect(JSON.stringify((r1 as any).card)).toContain('✅');
    // 点题二 → 全答 → 仍刷新卡（不再自动提交）
    const r2 = await bridge.handleCardAction(cfg, {
      operatorOpenId: 'ou_admin', messageId: 'om_new1', chatId: 'oc1',
      value: { act: 'oc_form_pick', key: 'b', value: 'y' },
    });
    expect(deps.answerQuestion).not.toHaveBeenCalled();
    expect(JSON.stringify((r2 as any).card)).toContain('✅');
    // 用户点「提交回答」（表单，自定义录入留空）→ 按点选提交
    const r3 = await bridge.handleCardAction(cfg, {
      operatorOpenId: 'ou_admin', messageId: 'om_new1', chatId: 'oc1', formValue: {},
    });
    expect(deps.answerQuestion).toHaveBeenCalledWith('main-exec', 'q3', { a: 'x', b: 'y' }, undefined);
    expect(JSON.stringify(r3)).toContain('已提交回答');
  });

  it('提问卡带来源/项目（会话目录 → 项目名）；标题不再只挂实例 id', async () => {
    const deps = makeOcDeps();
    deps.pendingAll = vi.fn(() => ({ permissions: [], questions: [{ instance: 'main-exec', id: 'q4', requestID: 'q4', title: '数据库选型', sessionID: 's-1', questions: [{ key: 'db', type: 'input', question: '用哪个库？' }] }] }));
    const bridge = createOcBridge(deps);
    await busSet('feishu:oc:notify_chat', { chat_id: 'oc1' }, 3600);
    await bridge.scanPendingOnce(cfg);
    expect(sendCardMock).toHaveBeenCalledTimes(1);
    const card = sendCardMock.mock.calls[0][2] as Record<string, any>;
    const body = JSON.stringify(card);
    expect(card.header.title.content).toContain('co-team');
    expect(body).toContain('来源');
    expect(body).toContain('OpenCode · 实例 main-exec · 项目 co-team · 会话 活跃会话');
    // 上下文要跟路由状态一起存：点选刷新后项目名不丢
    const route = await busGet<any>('feishu:route:om_new1');
    expect(route).toMatchObject({ act: 'oc_form', project: 'co-team', sessionTitle: '活跃会话' });
  });

  it('纯选择题卡上的「提交回答」按钮已接线（回归：act=oc_form_submit 曾无人处理，点了没反应）', async () => {
    const deps = makeOcDeps();
    const bridge = createOcBridge(deps);
    await busSet('feishu:route:om_card', {
      act: 'oc_form', instance: 'main-exec', request_id: 'q9', title: 'T',
      fields: [{ key: 'db', type: 'select', question: '库?', options: [{ label: 'pg', value: 'pg' }] }],
      answers: { db: 'pg' },
    }, 3600);
    const r = await bridge.handleCardAction(cfg, {
      operatorOpenId: 'ou_admin', messageId: 'om_card', chatId: 'oc1', value: { act: 'oc_form_submit' },
    });
    expect(deps.answerQuestion).toHaveBeenCalledWith('main-exec', 'q9', { db: 'pg' }, undefined);
    expect(JSON.stringify(r)).toContain('已提交回答');
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

  it('收件箱 oc 提问卡与实时卡同源：来源/项目上卡，route 可作答（回归：act=oc_question 曾无人处理）', async () => {
    await saveProject({ id: 'p-oc', name: 'co-team', workspace: 'D:/main', created_at: new Date().toISOString() });
    const ocDeps = makeOcDeps();
    ocDeps.pendingAll = vi.fn(() => ({ permissions: [], questions: [{ instance: 'main-exec', id: 'q7', requestID: 'q7', sessionID: 's-1', title: 'T', questions: [{ key: 'db', type: 'select', question: '用哪个库？', options: [{ label: 'pg', value: 'pg' }] }] }] }));
    const bridge = createInboxBridge(cfg, {
      ocPending: () => ocDeps.pendingAll(),
      ocSession: async () => ({ title: '活跃会话', directory: 'D:/main' }),
    });
    const session = freshSession();
    await handleCommand('/inbox', session, { listProjects: async () => [], listAgentNames: () => [], inbox: bridge }, 'oc1');
    // 无任务/会话待办 → 第 0 条是 oc 提问；点 [处理] 重推表单卡
    sendCardMock.mockClear();
    await bridge.handleCardAction(cfg, { operatorOpenId: session.user_id, messageId: 'om_card', chatId: 'oc1', value: { act: 'inbox_open', index: 0 } });
    expect(sendCardMock).toHaveBeenCalledTimes(1);
    const body = JSON.stringify(sendCardMock.mock.calls[0][2]);
    expect(body).toContain('来源');
    expect(body).toContain('OpenCode · 实例 main-exec · 项目 co-team · 会话 活跃会话');
    // route 注册的是表单状态（act=oc_form）——选项点选与提交都能落进 ocBridge 状态机
    const route = await busGet<any>('feishu:route:om_new1');
    expect(route).toMatchObject({ act: 'oc_form', instance: 'main-exec', request_id: 'q7' });
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

  // 2026-09-28 排障：D:\pxx\opencode-mobile 下 12 个空会话（rpc-probe）连环误报
  it('生命周期事件不上电——session.created/updated 不是"在跑"的证据', async () => {
    const deps = makeOcDeps();
    const bridge = createOcBridge(deps);
    const stop = bridge.start(cfg);
    await busSet('feishu:oc:notify_chat', { chat_id: 'oc1' }, 3600);
    await emitEvent(CHANNELS.DASHBOARD, 'oc_event', { instance: 'desktop', event: { type: 'session.created', properties: { sessionID: 's-empty' }, id: 'e1' } });
    await emitEvent(CHANNELS.DASHBOARD, 'oc_event', { instance: 'desktop', event: { type: 'session.updated', properties: { sessionID: 's-empty' }, id: 'e2' } });
    await bridge.scanStalled(cfg, 0);
    await sleep(25);
    expect(sendCardMock).not.toHaveBeenCalled();
    stop();
  });

  it('复核 A：会话没有任何消息 → 不推卡（空会话兜底）', async () => {
    const deps = { ...makeOcDeps(), readRecent: vi.fn(async () => []) };
    const bridge = createOcBridge(deps);
    const stop = bridge.start(cfg);
    await busSet('feishu:oc:notify_chat', { chat_id: 'oc1' }, 3600);
    await emitEvent(CHANNELS.DASHBOARD, 'oc_event', { instance: 'main-exec', event: { type: 'message.part.delta', properties: { sessionID: 's-1' }, id: 'd1' } });
    await bridge.scanStalled(cfg, 0);
    await sleep(25);
    expect(sendCardMock).not.toHaveBeenCalled();
    stop();
  });

  it('复核 B：状态表已不 busy → 不推卡（idle 事件丢了也不误报）', async () => {
    const deps = { ...makeOcDeps(), sessionStatus: vi.fn(async () => ({ 's-1': { type: 'idle' } })) };
    const bridge = createOcBridge(deps);
    const stop = bridge.start(cfg);
    await busSet('feishu:oc:notify_chat', { chat_id: 'oc1' }, 3600);
    await emitEvent(CHANNELS.DASHBOARD, 'oc_event', { instance: 'main-exec', event: { type: 'message.part.delta', properties: { sessionID: 's-1' }, id: 'd1' } });
    await bridge.scanStalled(cfg, 0);
    await sleep(25);
    expect(sendCardMock).not.toHaveBeenCalled();
    stop();
  });

  it('复核 B：状态表里查无此会话（已收场）→ 不推卡', async () => {
    const deps = { ...makeOcDeps(), sessionStatus: vi.fn(async () => ({ 's-other': { type: 'running' } })) };
    const bridge = createOcBridge(deps);
    const stop = bridge.start(cfg);
    await busSet('feishu:oc:notify_chat', { chat_id: 'oc1' }, 3600);
    await emitEvent(CHANNELS.DASHBOARD, 'oc_event', { instance: 'main-exec', event: { type: 'message.part.delta', properties: { sessionID: 's-1' }, id: 'd1' } });
    await bridge.scanStalled(cfg, 0);
    await sleep(25);
    expect(sendCardMock).not.toHaveBeenCalled();
    stop();
  });

  // 2.0.16 实测 GET /api/session/active 的值是 'running'（不是 'busy'）——写死 'busy' 会静默废掉复核
  it('复核 B：真实形态 status={\'running\'} → 仍推卡（不因字面量差异误杀）', async () => {
    const deps = { ...makeOcDeps(), sessionStatus: vi.fn(async () => ({ 's-1': { type: 'running' } })) };
    const bridge = createOcBridge(deps);
    const stop = bridge.start(cfg);
    await busSet('feishu:oc:notify_chat', { chat_id: 'oc1' }, 3600);
    await emitEvent(CHANNELS.DASHBOARD, 'oc_event', { instance: 'main-exec', event: { type: 'message.part.delta', properties: { sessionID: 's-1' }, id: 'd1' } });
    await bridge.scanStalled(cfg, 0);
    await vi.waitFor(() => expect(sendCardMock).toHaveBeenCalledTimes(1));
    stop();
  });

  it('「忽略」只压这一轮静默：本次不再提醒，会话再有新活动照常提醒', async () => {
    const deps = makeOcDeps();
    const bridge = createOcBridge(deps);
    const stop = bridge.start(cfg);
    await busSet('feishu:oc:notify_chat', { chat_id: 'oc1' }, 3600);
    const arm = (id: string) => emitEvent(CHANNELS.DASHBOARD, 'oc_event', { instance: 'main-exec', event: { type: 'message.part.delta', properties: { sessionID: 's-1' }, id } });

    // 第一轮：活动后静默 → 推卡（同时写下会话级去重键）
    await arm('d1');
    await bridge.scanStalled(cfg, 0);
    await vi.waitFor(() => expect(sendCardMock).toHaveBeenCalledTimes(1));
    expect(await busGet('feishu:oc:stalled:s-1')).not.toBeNull();

    // 会话又闪了一下（新事件），用户此时点「忽略」
    await sleep(5);
    await arm('d2');
    const r = await bridge.handleCardAction(cfg, {
      operatorOpenId: 'ou_admin', messageId: 'om_new1', chatId: 'oc1',
      value: { act: 'oc_stall_ignore', instance: 'main-exec', session_id: 's-1' },
    });
    expect(JSON.stringify(r)).toContain('已忽略本次卡住提醒');
    // 去重键被撤掉——否则忽略之后的新一轮卡住会被旧键吃掉
    expect(await busGet('feishu:oc:stalled:s-1')).toBeNull();

    // 忽略时刻之前的静默：不再提醒
    await bridge.scanStalled(cfg, 0);
    await sleep(25);
    expect(sendCardMock).toHaveBeenCalledTimes(1);

    // 忽略之后又有新活动 → 重新静默 → 照常提醒
    await sleep(5);
    await arm('d3');
    await bridge.scanStalled(cfg, 0);
    await vi.waitFor(() => expect(sendCardMock).toHaveBeenCalledTimes(2));
    stop();
  });

  it('状态表查不到（实例不可达）→ 不误杀真卡住，仍推卡', async () => {
    const deps = { ...makeOcDeps(), sessionStatus: vi.fn(async () => null) };
    const bridge = createOcBridge(deps);
    const stop = bridge.start(cfg);
    await busSet('feishu:oc:notify_chat', { chat_id: 'oc1' }, 3600);
    await emitEvent(CHANNELS.DASHBOARD, 'oc_event', { instance: 'main-exec', event: { type: 'message.part.delta', properties: { sessionID: 's-1' }, id: 'd1' } });
    await bridge.scanStalled(cfg, 0);
    await vi.waitFor(() => expect(sendCardMock).toHaveBeenCalledTimes(1));
    stop();
  });

  it('提问/审批在等人工 → 收场不上电（人答完后事件会重新上电）', async () => {
    const deps = makeOcDeps();
    const bridge = createOcBridge(deps);
    const stop = bridge.start(cfg);
    await busSet('feishu:oc:notify_chat', { chat_id: 'oc1' }, 3600);
    await emitEvent(CHANNELS.DASHBOARD, 'oc_event', { instance: 'main-exec', event: { type: 'message.part.delta', properties: { sessionID: 's-1' }, id: 'd1' } });
    await emitEvent(CHANNELS.DASHBOARD, 'oc_event', { instance: 'main-exec', event: { type: 'question.asked', properties: { sessionID: 's-1' }, id: 'q1' } });
    await bridge.scanStalled(cfg, 0);
    await sleep(25);
    expect(sendCardMock).not.toHaveBeenCalled();
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

describe('一键新建会话（卡片按钮）', () => {
  it('oc_new 两段式：先项目选择卡，选项目后建会话并绑定目录', async () => {
    const deps = makeOcDeps();
    deps.listProjects = vi.fn(async () => [{ id: 'p1', name: '人事系统', workspace: 'D:/pxx/projects/hr' }]);
    const bridge = createOcBridge(deps);
    await setSession({ user_id: 'ou_admin', last_active_time: '', mode: 'oc', oc_instance: 'main-exec', oc_session: 's-1' });

    // 第一步：点 [🆕 新建会话] → 项目选择卡
    const r1 = await bridge.handleCardAction(cfg, {
      operatorOpenId: 'ou_admin', messageId: 'om_card', chatId: 'oc1', value: { act: 'oc_new_pick', instance: 'main-exec' },
    });
    expect(String(JSON.stringify(r1))).toContain('选择项目');
    expect(String(JSON.stringify(r1))).toContain('人事系统');

    // 第二步：点项目 → 建会话（目录=项目工作区）并绑定
    const r2 = await bridge.handleCardAction(cfg, {
      operatorOpenId: 'ou_admin', messageId: 'om_new1', chatId: 'oc1',
      value: { act: 'oc_new_proj', instance: 'main-exec', workspace: 'D:/pxx/projects/hr', project: '人事系统' },
    });
    expect(deps.createSession).toHaveBeenCalledWith('main-exec', undefined, 'D:/pxx/projects/hr');
    const session = await (await import('../src/feishu/session')).getSession('ou_admin');
    expect(session.oc_session).toBe('s-new');
    expect(String(JSON.stringify(r2))).toContain('人事系统');
  });

  it('convo_new 两段式：先项目选择卡，选项目后建会话（绑定项目）', async () => {
    const deps = makeConvoDeps();
    deps.listProjects = vi.fn(async () => [{ id: 'p1', name: '人事系统', workspace: 'D:/pxx/projects/hr' }]);
    const bridge = createConvoBridge(deps);

    const r1 = await bridge.handleCardAction(cfg, {
      operatorOpenId: 'ou_admin', messageId: 'om_card', chatId: 'oc1', value: { act: 'convo_new' },
    });
    expect(String(JSON.stringify(r1))).toContain('选择项目');

    await bridge.handleCardAction(cfg, {
      operatorOpenId: 'ou_admin', messageId: 'om_new1', chatId: 'oc1', value: { act: 'convo_new_proj', project_id: 'p1', project: '人事系统' },
    });
    expect(deps.create).toHaveBeenCalledWith({ title: '人事系统 协作', project_id: 'p1' });
    const session = await (await import('../src/feishu/session')).getSession('ou_admin');
    expect(session.convo_id).toBe('c9');
    expect(sendTextMock.mock.calls.some((c) => String(c[2]).includes('项目：人事系统'))).toBe(true);
  });
});

describe('实例切换（进入卡按钮）', () => {
  it('oc_pick_instance：切绑实例+自动绑活动会话+推预览', async () => {
    const deps = makeOcDeps();
    const bridge = createOcBridge(deps);
    await setSession({ user_id: 'ou_admin', last_active_time: '', mode: 'oc', oc_instance: 'main-exec', oc_session: 's-1' });
    await bridge.handleCardAction(cfg, {
      operatorOpenId: 'ou_admin', messageId: 'om_card', chatId: 'oc1', value: { act: 'oc_pick_instance', instance: 'desktop' },
    });
    const session = await (await import('../src/feishu/session')).getSession('ou_admin');
    expect(session.oc_instance).toBe('desktop');
    expect(session.oc_session).toBe('s-1');
    expect(sendTextMock.mock.calls.some((c) => String(c[2]).includes('desktop') && String(c[2]).includes('最近对话'))).toBe(true);
  });
});

describe('项目选择卡翻页', () => {
  it('超过 6 个项目分页：第 0 页 6 条+下一页，翻页后显示余下条目', async () => {
    const many = Array.from({ length: 8 }, (_, i) => ({ name: `项目 ${i + 1}`, workspace: `D:/proj/${i + 1}` }));
    const deps = makeOcDeps();
    deps.listProjects = vi.fn(async () => many);
    const bridge = createOcBridge(deps);
    await setSession({ user_id: 'ou_admin', last_active_time: '', mode: 'oc', oc_instance: 'main-exec', oc_session: 's-1' });

    const r1 = await bridge.handleCardAction(cfg, {
      operatorOpenId: 'ou_admin', messageId: 'om_card', chatId: 'oc1', value: { act: 'oc_new_pick', instance: 'main-exec' },
    });
    const c1 = (r1 as any).card.data;
    expect(JSON.stringify(c1)).toContain('第 1/2 页');
    expect(JSON.stringify(c1)).toContain('项目 6');
    expect(JSON.stringify(c1)).not.toContain('项目 7');

    const r2 = await bridge.handleCardAction(cfg, {
      operatorOpenId: 'ou_admin', messageId: 'om_card', chatId: 'oc1',
      value: { act: 'oc_new_page', page: 1, instance: 'main-exec' },
    });
    const c2 = (r2 as any).card.data;
    expect(JSON.stringify(c2)).toContain('第 2/2 页');
    expect(JSON.stringify(c2)).toContain('项目 8');
  });
});
