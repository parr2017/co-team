import { describe, it, expect } from 'vitest';
import { SessionStream } from '../src/opencode/stream';

/** 按实测抓包构造的最小事件集 */
const ev = (type: string, properties: Record<string, unknown> = {}) => ({ type, properties });

describe('SessionStream 流式状态机', () => {
  it('reset：全量快照建立消息与 parts', () => {
    const s = new SessionStream();
    s.reset([
      { info: { id: 'm1', role: 'user' }, parts: [{ id: 'p1', type: 'text', text: '问题' }] },
      { info: { id: 'm2', role: 'assistant' }, parts: [{ id: 'p2', type: 'text', text: '答' }] },
    ]);
    const snap = s.snapshot();
    expect(snap.messages.map((m) => m.id)).toEqual(['m1', 'm2']);
    expect(snap.messages[0].parts[0].text).toBe('问题');
  });

  it('prepend：历史翻页插头，幂等且顺序保持', () => {
    const s = new SessionStream();
    s.reset([{ info: { id: 'm3', role: 'assistant' }, parts: [] }]);
    s.prepend([
      { info: { id: 'm1', role: 'user' }, parts: [{ id: 'p1', type: 'text', text: '旧1' }] },
      { info: { id: 'm2', role: 'assistant' }, parts: [] },
      { info: { id: 'm3', role: 'assistant' }, parts: [] }, // 已存在：跳过
    ]);
    expect(s.snapshot().messages.map((m) => m.id)).toEqual(['m1', 'm2', 'm3']);
    // 幂等：反复 prepend 不重复
    s.prepend([{ info: { id: 'm1', role: 'user' }, parts: [] }]);
    expect(s.snapshot().messages.map((m) => m.id)).toEqual(['m1', 'm2', 'm3']);
    // prepend 后 delta 仍能命中旧消息的 part
    s.applyEvent({ type: 'message.part.delta', properties: { messageID: 'm1', partID: 'p1', field: 'text', delta: '!' } });
    expect(s.snapshot().messages[0].parts[0].text).toBe('旧1!');
  });

  it('message.part.delta：token 级追加到正确 part（真实载荷形状）', () => {
    const s = new SessionStream();
    s.applyEvent(ev('message.updated', { info: { id: 'm2', role: 'assistant' } }));
    s.applyEvent(ev('message.part.updated', { part: { id: 'prt_a', messageID: 'm2', type: 'text', text: '' } }));
    s.applyEvent(ev('message.part.delta', { messageID: 'm2', partID: 'prt_a', field: 'text', delta: 'The' }));
    s.applyEvent(ev('message.part.delta', { messageID: 'm2', partID: 'prt_a', field: 'text', delta: ' answer' }));
    const parts = s.snapshot().messages[0].parts;
    expect(parts[0].text).toBe('The answer');
  });

  it('delta 先于 part.updated 到达：自动建骨架消息与 part', () => {
    const s = new SessionStream();
    s.applyEvent(ev('message.part.delta', { messageID: 'mx', partID: 'px', field: 'text', delta: '流' }));
    s.applyEvent(ev('message.part.delta', { messageID: 'mx', partID: 'px', field: 'text', delta: '式' }));
    const snap = s.snapshot();
    expect(snap.messages[0].id).toBe('mx');
    expect(snap.messages[0].parts[0].text).toBe('流式');
  });

  it('part.updated 全量到达覆盖 delta 拼接结果（权威校正）', () => {
    const s = new SessionStream();
    s.applyEvent(ev('message.part.delta', { messageID: 'm', partID: 'p', field: 'text', delta: '半对' }));
    s.applyEvent(ev('message.part.updated', { part: { id: 'p', messageID: 'm', type: 'text', text: '完整文本' } }));
    expect(s.snapshot().messages[0].parts[0].text).toBe('完整文本');
  });

  it('嵌套字段 delta（state.input）按路径 set', () => {
    const s = new SessionStream();
    s.applyEvent(ev('message.part.updated', { part: { id: 't1', messageID: 'm', type: 'tool', tool: 'bash', state: { status: 'running', input: {} } } }));
    s.applyEvent(ev('message.part.delta', { messageID: 'm', partID: 't1', field: 'state.input.command', delta: 'ls' }));
    expect(s.snapshot().messages[0].parts[0].state.input.command).toBe('ls');
  });

  it('session.status/idle/error：busy 与重试态', () => {
    const s = new SessionStream();
    s.applyEvent(ev('session.status', { status: { type: 'busy' } }));
    expect(s.snapshot().busy).toBe(true);
    s.applyEvent(ev('session.status', { status: { type: 'retry', attempt: 2, message: '429', next: 3000 } }));
    expect(s.snapshot().retry).toEqual({ attempt: 2, message: '429', next: 3000 });
    s.applyEvent(ev('session.idle', {}));
    expect(s.snapshot().busy).toBe(false);
    s.applyEvent(ev('session.error', { error: { message: 'boom' } }));
    expect(s.snapshot().error).toBe('boom');
  });

  it('permission.asked/replied：待批队列进出', () => {
    const s = new SessionStream();
    s.applyEvent(ev('permission.asked', { id: 'per_1', sessionID: 's', title: '运行 ls', pattern: ['ls'], metadata: {} }));
    s.applyEvent(ev('permission.asked', { id: 'per_2', sessionID: 's', title: '写文件', metadata: {} }));
    expect(s.snapshot().pendingPermissions.map((p) => p.id)).toEqual(['per_1', 'per_2']);
    s.applyEvent(ev('permission.replied', { permissionID: 'per_1', response: 'once' }));
    expect(s.snapshot().pendingPermissions.map((p) => p.id)).toEqual(['per_2']);
  });

  it('todo.updated / session.updated.revert / pty 生命周期', () => {
    const s = new SessionStream();
    s.applyEvent(ev('todo.updated', { sessionID: 's', todos: [{ id: 't1', content: '修 bug', status: 'in_progress', priority: 'high' }] }));
    expect(s.snapshot().todos.length).toBe(1);
    s.applyEvent(ev('session.updated', { info: { id: 's', title: '新标题', revert: { messageID: 'm1', diff: '...' } } }));
    expect(s.snapshot().title).toBe('新标题');
    expect(s.snapshot().revert).toMatchObject({ messageID: 'm1' });
    s.applyEvent(ev('pty.created', { info: { id: 'pty1', title: 'bash', command: 'bash', status: 'running' } }));
    s.applyEvent(ev('pty.updated', { info: { id: 'pty1', title: 'bash', command: 'bash', status: 'running' } }));
    s.applyEvent(ev('pty.exited', { id: 'pty1', exitCode: 0 }));
    const pty = s.snapshot().ptys[0];
    expect(pty.status).toBe('exited');
    expect(pty.exitCode).toBe(0);
  });

  it('message.removed 清消息；畸形帧不炸', () => {
    const s = new SessionStream();
    s.reset([{ info: { id: 'm1', role: 'user' }, parts: [] }]);
    s.applyEvent(ev('message.removed', { sessionID: 's', messageID: 'm1' }));
    expect(s.snapshot().messages.length).toBe(0);
    s.applyEvent({ type: 'message.part.delta', properties: { field: 'text', delta: 'x' } } as any);
    s.applyEvent(null as any);
    expect(s.snapshot().messages.length).toBe(0);
    expect(s.snapshot().eventCount).toBeGreaterThanOrEqual(2);
  });
});
