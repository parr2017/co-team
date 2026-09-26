import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// 网络层打桩：审批卡片测试不触网
const sendCardMock = vi.fn(async () => 'om_card_new');
const updateCardMock = vi.fn(async () => true);
vi.mock('../src/feishu/messageService', () => ({
  sendCard: (...a: unknown[]) => sendCardMock(...(a as [any, any, any])),
  updateCard: (...a: unknown[]) => updateCardMock(...(a as [any, any, any])),
}));

import { closeBus, busGet, busSet, initBus } from '../src/bus';
import { emitEvent } from '../src/store';
import { CHANNELS } from '../src/types';
import { buildNodeApprovalCard, handleCardAction, startApprovalCards } from '../src/feishu/approvalCards';
import type { FeishuConfig } from '../src/config';

const cfg = (approvers?: string[]): FeishuConfig => ({ app_id: 'cli_x', app_secret: 'sec', ...(approvers ? { approvers } : {}) });

function makeDeps() {
  return {
    getTaskGraph: vi.fn(async () => ({
      task_id: 't1',
      workspace: '/w',
      project_id: 'p1',
      status: 'waiting_approval',
      nodes: [{ id: 'n1', name: '实现登录', status: 'waiting_approval' }],
      edges: [],
    })) as any,
    enqueue: vi.fn(async () => ({})),
    abortTask: vi.fn(),
    removePending: vi.fn(async () => {}),
    resolvePendingCommand: vi.fn(async () => ({ ok: true })),
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

beforeEach(async () => {
  process.env.COTEAM_FORCE_MEMORY = '1';
  closeBus();
  await initBus({ host: '127.0.0.1', port: 6399, db: 0 });
  sendCardMock.mockClear();
  updateCardMock.mockClear();
});

afterEach(() => {
  closeBus();
});

const lastCard = () => updateCardMock.mock.calls.at(-1)![2] as Record<string, any>;

describe('feishu approval card action', () => {
  it('批准节点：写审批名单 + 重新入队 + 审计 + 卡片原地更新为已批准', async () => {
    const d = makeDeps();
    await handleCardAction(cfg(['ou_admin']), d, {
      operatorOpenId: 'ou_admin',
      messageId: 'om1',
      chatId: 'oc1',
      value: { act: 'approve_node', task_id: 't1', node_id: 'n1' },
    });
    expect(d.enqueue).toHaveBeenCalledWith('t1', 'p1', '/w');
    expect(await busGet<string[]>('task:approvals:t1')).toContain('n1');
    const journal = await busGet<{ text: string }[]>('task:t1:agent:orchestrator:journal');
    expect(journal?.some((e) => e.text.includes('ou_admin') && e.text.includes('批准节点'))).toBe(true);
    const card = lastCard();
    expect(card.header.template).toBe('green');
    expect(card.header.title.content).toContain('已批准');
  });

  it('白名单外操作人被拒绝，不触碰任何审批副作用', async () => {
    const d = makeDeps();
    await handleCardAction(cfg(['ou_admin']), d, {
      operatorOpenId: 'ou_stranger',
      messageId: 'om1',
      chatId: 'oc1',
      value: { act: 'approve_node', task_id: 't1', node_id: 'n1' },
    });
    expect(d.enqueue).not.toHaveBeenCalled();
    expect(lastCard().header.title.content).toContain('无权操作');
  });

  it('未配置白名单时一律拒绝（防御深度：卡片本就不该有按钮）', async () => {
    const d = makeDeps();
    await handleCardAction(cfg(), d, {
      operatorOpenId: 'ou_admin',
      messageId: 'om1',
      chatId: 'oc1',
      value: { act: 'approve_node', task_id: 't1', node_id: 'n1' },
    });
    expect(d.enqueue).not.toHaveBeenCalled();
    expect(lastCard().header.title.content).toContain('无权操作');
  });

  it('取消任务：写 cancel 标志 + abort + 出队，与取消端点同副作用', async () => {
    const d = makeDeps();
    await handleCardAction(cfg(['ou_admin']), d, {
      operatorOpenId: 'ou_admin',
      messageId: 'om1',
      chatId: 'oc1',
      value: { act: 'cancel_task', task_id: 't1' },
    });
    expect(await busGet('task:cancel:t1')).toBe(true);
    expect(d.abortTask).toHaveBeenCalledWith('t1');
    expect(d.removePending).toHaveBeenCalledWith('t1');
    expect(lastCard().header.template).toBe('red');
  });

  it('命令批准/拒绝：转发 resolvePendingCommand；拒绝落红卡', async () => {
    const d = makeDeps();
    await handleCardAction(cfg(['ou_admin']), d, {
      operatorOpenId: 'ou_admin',
      messageId: 'om1',
      chatId: 'oc1',
      value: { act: 'approve_command', task_id: 't1', command_id: 'cmd1' },
    });
    expect(d.resolvePendingCommand).toHaveBeenCalledWith('t1', 'cmd1', true);
    await handleCardAction(cfg(['ou_admin']), d, {
      operatorOpenId: 'ou_admin',
      messageId: 'om1',
      chatId: 'oc1',
      value: { act: 'reject_command', task_id: 't1', command_id: 'cmd2' },
    });
    expect(d.resolvePendingCommand).toHaveBeenCalledWith('t1', 'cmd2', false);
    expect(lastCard().header.template).toBe('red');
  });

  it('命令已被处理（找不到待批项）→ 回"处理失败"卡而非崩', async () => {
    const d = makeDeps();
    d.resolvePendingCommand.mockRejectedValue(new Error('pending command not found'));
    await handleCardAction(cfg(['ou_admin']), d, {
      operatorOpenId: 'ou_admin',
      messageId: 'om1',
      chatId: 'oc1',
      value: { act: 'approve_command', task_id: 't1', command_id: 'gone' },
    });
    expect(lastCard().header.title.content).toContain('处理失败');
  });
});

describe('approval card rendering (TASK channel)', () => {
  it('节点停靠事件 → 推带按钮的 2.0 卡到任务绑定会话；同停靠位一小时内不重发', async () => {
    await busSet('feishu:card:t1', { chat_id: 'oc_bound', message_id: 'om0' }, 3600);
    const d = makeDeps();
    const stop = startApprovalCards(cfg(['ou_admin']), d as any);
    await emitEvent(CHANNELS.TASK, 'node_waiting_approval', { task_id: 't1', node_id: 'n1', name: '实现登录' });
    await vi.waitFor(() => expect(sendCardMock).toHaveBeenCalledTimes(1));
    expect(sendCardMock.mock.calls[0][1]).toBe('oc_bound');
    const card = sendCardMock.mock.calls[0][2] as Record<string, any>;
    expect(card.schema).toBe('2.0');
    expect(JSON.stringify(card)).toContain('approve_node');
    expect(JSON.stringify(card)).toContain('cancel_task');

    await emitEvent(CHANNELS.TASK, 'node_waiting_approval', { task_id: 't1', node_id: 'n1', name: '实现登录' });
    await sleep(30);
    expect(sendCardMock).toHaveBeenCalledTimes(1);
    stop();
  });

  it('面板创建的任务（无会话绑定）不推卡', async () => {
    const d = makeDeps();
    const stop = startApprovalCards(cfg(['ou_admin']), d as any);
    await emitEvent(CHANNELS.TASK, 'node_waiting_approval', { task_id: 't_orphan', node_id: 'n1', name: 'x' });
    await sleep(30);
    expect(sendCardMock).not.toHaveBeenCalled();
    stop();
  });

  it('命令停靠事件 → 每条待批命令一组批准/拒绝按钮（id 来自 pending 队列）', async () => {
    await busSet('feishu:card:t1', { chat_id: 'oc_bound', message_id: 'om0' }, 3600);
    await busSet('task:pending_commands:t1', [{ id: 'cmd9', node_id: 'n1', node_name: '实现登录', command: 'rm -rf /tmp/x', ts: new Date().toISOString() }]);
    const d = makeDeps();
    const stop = startApprovalCards(cfg(['ou_admin']), d as any);
    await emitEvent(CHANNELS.TASK, 'command_pending_approval', { task_id: 't1', node_id: 'n1', node_name: '实现登录', commands: ['rm -rf /tmp/x'] });
    await vi.waitFor(() => expect(sendCardMock).toHaveBeenCalledTimes(1));
    const body = JSON.stringify(sendCardMock.mock.calls[0][2]);
    expect(body).toContain('cmd9');
    expect(body).toContain('approve_command');
    expect(body).toContain('reject_command');
    stop();
  });

  it('未配置白名单 → 卡片只渲染信息不带按钮', () => {
    const card = buildNodeApprovalCard({ taskId: 't1', nodeId: 'n1', name: '实现登录', approvers: false });
    expect(JSON.stringify(card)).not.toContain('behaviors');
    const card2 = buildNodeApprovalCard({ taskId: 't1', nodeId: 'n1', name: '实现登录', approvers: true });
    expect(JSON.stringify(card2)).toContain('behaviors');
  });
});
