import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// 网络层与跨模块依赖打桩
const sendTextMock = vi.fn(async () => 'om_t');
const sendCardMock = vi.fn(async () => 'om_route1');
const updateCardMock = vi.fn(async () => true);
vi.mock('../src/feishu/messageService', () => ({
  sendText: (...a: unknown[]) => sendTextMock(...(a as [any, any, any])),
  sendCard: (...a: unknown[]) => sendCardMock(...(a as [any, any, any])),
  updateCard: (...a: unknown[]) => updateCardMock(...(a as [any, any, any])),
  buildTaskCard: () => ({}),
}));
const resolveAskMock = vi.fn(async () => true);
const listAsksMock = vi.fn(async () => []);
vi.mock('../src/askGate', () => ({
  resolveAsk: (...a: unknown[]) => resolveAskMock(...(a as [any, any, any, any])),
  listAsks: (...a: unknown[]) => listAsksMock(...(a as [any])),
}));
const getDailyReportMock = vi.fn(async () => null);
const resolveReportItemMock = vi.fn(async () => null);
vi.mock('../src/dailyReport', () => ({
  getDailyReport: (...a: unknown[]) => getDailyReportMock(...(a as [any])),
  resolveReportItem: (...a: unknown[]) => resolveReportItemMock(...(a as [any, any, any, any])),
}));
const writeKnowledgeMock = vi.fn();
vi.mock('../src/knowledge', () => ({ writeKnowledge: (...a: unknown[]) => writeKnowledgeMock(...(a as [any])) }));

import { closeBus, busGet, busSet, initBus } from '../src/bus';
import { emitEvent, saveTaskGraph } from '../src/store';
import { CHANNELS } from '../src/types';
import { startNotifyPush } from '../src/feishu/notifyBridge';
import { startDecisionCards, handleDecisionAction } from '../src/feishu/decisionCards';
import type { FeishuConfig } from '../src/config';

const cfg: FeishuConfig = { app_id: 'cli_x', app_secret: 'sec', approvers: ['ou_admin'] };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function makeDeps() {
  return {
    enqueue: vi.fn(async () => ({})),
    addNode: vi.fn(async () => ({})),
    createTask: vi.fn(async () => ({ taskId: 't-fix1' })),
    clarify: vi.fn(async () => ({ status: 'planned' })),
    clarifyNode: vi.fn(async () => ({ status: 'pending' })),
    postDiscussionMessage: vi.fn(async () => {}),
  };
}

beforeEach(async () => {
  process.env.COTEAM_FORCE_MEMORY = '1';
  closeBus();
  await initBus({ host: '127.0.0.1', port: 6399, db: 0 });
  sendTextMock.mockClear();
  sendCardMock.mockClear();
  updateCardMock.mockClear();
  resolveAskMock.mockClear();
  listAsksMock.mockClear();
  getDailyReportMock.mockClear();
  resolveReportItemMock.mockClear();
  writeKnowledgeMock.mockClear();
});

afterEach(() => {
  closeBus();
});

const lastResultCard = () => updateCardMock.mock.calls.at(-1)![2] as Record<string, any>;

describe('notifyBridge（通知统一化）', () => {
  it('白名单事件推文本到任务绑定聊天；同类 1 小时去重', async () => {
    await busSet('feishu:card:t1', { chat_id: 'oc1', message_id: 'om1' }, 3600);
    const stop = startNotifyPush(cfg);
    await emitEvent(CHANNELS.NOTIFY, 'task_success', { task_id: 't1', message: '[Co-Team] 任务 t1 成功' });
    await vi.waitFor(() => expect(sendTextMock).toHaveBeenCalledTimes(1));
    expect(sendTextMock.mock.calls[0][1]).toBe('oc1');
    expect(String(sendTextMock.mock.calls[0][2])).toContain('t1 成功');

    await emitEvent(CHANNELS.NOTIFY, 'task_success', { task_id: 't1', message: '[Co-Team] again' });
    await sleep(25);
    expect(sendTextMock).toHaveBeenCalledTimes(1);
    stop();
  });

  it('无绑定任务与非白名单事件不推送', async () => {
    const stop = startNotifyPush(cfg);
    await emitEvent(CHANNELS.NOTIFY, 'task_failed', { task_id: 't_orphan', message: 'x' });
    await emitEvent(CHANNELS.NOTIFY, 'queue_update', { task_id: 't1', message: 'x' });
    await sleep(30);
    expect(sendTextMock).not.toHaveBeenCalled();
    stop();
  });
});

describe('decisionCards 渲染', () => {
  it('ask_user → C4 卡（表单+跳过）并注册 message_id 路由', async () => {
    await busSet('feishu:card:t1', { chat_id: 'oc1', message_id: 'om0' }, 3600);
    listAsksMock.mockResolvedValue([{ id: 'a1', from: 'dev', to: 'user', question: '手机号还是用户名？', status: 'pending', ts: '', task_id: 't1' }]);
    const stop = startDecisionCards(cfg, makeDeps());
    await emitEvent(CHANNELS.NOTIFY, 'ask_user', { task_id: 't1', node_id: 'n1', ask_id: 'a1' });
    await vi.waitFor(() => expect(sendCardMock).toHaveBeenCalledTimes(1));
    const card = sendCardMock.mock.calls[0][2] as Record<string, any>;
    expect(card.header.title.content).toContain('dev 有一个问题');
    expect(JSON.stringify(card)).toContain('ask_skip');
    expect(JSON.stringify(card)).toContain('form');
    const route = await busGet<Record<string, string>>('feishu:route:om_route1');
    expect(route).toMatchObject({ act: 'ask_answer', task_id: 't1', ask_id: 'a1' });
    stop();
  });

  it('监督提案 → C5 卡；批准走 decideProposal（节点复位+重入队）', async () => {
    await saveTaskGraph('t1', [{ id: 'n1', name: '坏节点', status: 'failed' } as any], [], { workspace: '/w', project_id: 'p1', status: 'running' });
    await busSet('task:proposals:t1', [{ id: 'p1', type: 'retry_failed', node_id: 'n1', status: 'pending', reason: '验收失败' }]);
    await busSet('feishu:card:t1', { chat_id: 'oc1', message_id: 'om0' }, 3600);
    const deps = makeDeps();
    const stop = startDecisionCards(cfg, deps);
    await emitEvent(CHANNELS.NOTIFY, 'supervisor_proposal', { task_id: 't1', proposal_id: 'p1' });
    await vi.waitFor(() => expect(sendCardMock).toHaveBeenCalledTimes(1));
    const card = sendCardMock.mock.calls[0][2] as Record<string, any>;
    expect(card.header.title.content).toContain('重试失败节点');

    await handleDecisionAction(cfg, deps, {
      operatorOpenId: 'ou_admin', messageId: 'om_card', chatId: 'oc1',
      value: { act: 'proposal_approve', task_id: 't1', proposal_id: 'p1' },
    });
    expect(deps.enqueue).toHaveBeenCalledWith('t1', 'p1', '/w');
    const graph = await busGet<any>('task:graph:t1');
    expect(graph.nodes.find((n: any) => n.id === 'n1').status).toBe('pending');
    const proposals = await busGet<any[]>('task:proposals:t1');
    expect(proposals[0].status).toBe('executed');
    stop();
  });

  it('每日报告 → 裁决卡推审批人私聊；fix_now 建轻量修复任务并沉淀知识', async () => {
    await saveTaskGraph('t1', [], [], { workspace: '/w', project_id: 'p1', status: 'running' });
    getDailyReportMock.mockResolvedValue({
      date: '2026-09-26',
      items: [{ id: 'i1', category: 'code_defect', count: 2, sample: 'boom', sources: [{ task_id: 't1' }] }],
      resolved: {},
    });
    const deps = makeDeps();
    const stop = startDecisionCards(cfg, deps);
    await emitEvent(CHANNELS.NOTIFY, 'daily_report_ready', { date: '2026-09-26', count: 1 });
    await vi.waitFor(() => expect(sendCardMock).toHaveBeenCalledTimes(1));
    expect(sendCardMock.mock.calls[0][3]).toBe('open_id');

    await handleDecisionAction(cfg, deps, {
      operatorOpenId: 'ou_admin', messageId: 'om_card', chatId: 'oc1',
      value: { act: 'daily_fix', date: '2026-09-26', item_id: 'i1' },
    });
    expect(deps.createTask).toHaveBeenCalled();
    expect((deps.createTask.mock.calls[0][3] as any).level).toBe('light');
    expect(resolveReportItemMock).toHaveBeenCalled();
    expect(writeKnowledgeMock).toHaveBeenCalled();
    expect(lastResultCard().header.title.content).toContain('已转修复任务');
    stop();
  });

  it('重复裁决被幂等拦截', async () => {
    getDailyReportMock.mockResolvedValue({
      date: '2026-09-26', items: [{ id: 'i1', category: 'other', count: 1, sample: 'x', sources: [] }],
      resolved: { i1: { action: 'skip', ts: '' } },
    });
    const deps = makeDeps();
    await handleDecisionAction(cfg, deps, {
      operatorOpenId: 'ou_admin', messageId: 'om_card', chatId: 'oc1',
      value: { act: 'daily_fix', date: '2026-09-26', item_id: 'i1' },
    });
    expect(deps.createTask).not.toHaveBeenCalled();
    expect(lastResultCard().header.title.content).toContain('已裁决');
  });
});

describe('decisionCards 动作', () => {
  it('ask_answer 表单提交：resolveAsk 成功→绿卡，失败→超时红卡', async () => {
    await busSet('feishu:route:om_route1', { act: 'ask_answer', task_id: 't1', ask_id: 'a1' }, 3600);
    const deps = makeDeps();
    await handleDecisionAction(cfg, deps, {
      operatorOpenId: 'ou_admin', messageId: 'om_route1', chatId: 'oc1', formValue: { answer: '手机号' },
    });
    expect(resolveAskMock).toHaveBeenCalledWith('a1', 't1', '手机号', 'ou_admin');
    expect(lastResultCard().header.title.content).toContain('已回答');

    resolveAskMock.mockResolvedValue(false);
    await handleDecisionAction(cfg, deps, {
      operatorOpenId: 'ou_admin', messageId: 'om_route1', chatId: 'oc1', formValue: { answer: '晚了' },
    });
    expect(lastResultCard().header.title.content).toContain('已超时');
  });

  it('白名单外操作人被拒绝', async () => {
    await busSet('feishu:route:om_route1', { act: 'ask_answer', task_id: 't1', ask_id: 'a1' }, 3600);
    const deps = makeDeps();
    await handleDecisionAction(cfg, deps, {
      operatorOpenId: 'ou_stranger', messageId: 'om_route1', chatId: 'oc1', formValue: { answer: 'x' },
    });
    expect(resolveAskMock).not.toHaveBeenCalled();
    expect(lastResultCard().header.title.content).toContain('无权操作');
  });

  it('澄清回答映射到问题数组并驱动 clarify；planned 后提示进入计划', async () => {
    await busSet('task:clarify:t1', { rounds: 1, questions: ['目标用户是谁', '要哪些登录方式'] }, 3600);
    await busSet('feishu:route:om_route1', { act: 'clarify_answer', task_id: 't1' }, 3600);
    const deps = makeDeps();
    await handleDecisionAction(cfg, deps, {
      operatorOpenId: 'ou_admin', messageId: 'om_route1', chatId: 'oc1', formValue: { a1: '独立开发者', a2: '' },
    });
    expect(deps.clarify).toHaveBeenCalledWith('t1', { answers: [{ question: '目标用户是谁', answer: '独立开发者' }] });
    expect(lastResultCard().header.title.content).toContain('需求已明确');
  });

  it('开工确认：clarifyNode 后重新入队', async () => {
    await busSet('feishu:route:om_route1', { act: 'node_confirm', task_id: 't1', node_id: 'n1' }, 3600);
    const deps = makeDeps();
    await handleDecisionAction(cfg, deps, {
      operatorOpenId: 'ou_admin', messageId: 'om_route1', chatId: 'oc1', formValue: { note: '' },
    });
    expect(deps.clarifyNode).toHaveBeenCalledWith('t1', 'n1', { approve: true, text: undefined });
    expect(deps.enqueue).toHaveBeenCalled();
    expect(lastResultCard().header.title.content).toContain('已确认开工');
  });

  it('讨论拍板：转发为讨论用户消息', async () => {
    await busSet('feishu:route:om_route1', { act: 'discuss_answer', discussion_id: 'd1' }, 3600);
    const deps = makeDeps();
    await handleDecisionAction(cfg, deps, {
      operatorOpenId: 'ou_admin', messageId: 'om_route1', chatId: 'oc1', formValue: { answer: '我选方案 A' },
    });
    expect(deps.postDiscussionMessage).toHaveBeenCalledWith('d1', '我选方案 A');
    expect(lastResultCard().header.title.content).toContain('已回应讨论');
  });
});
