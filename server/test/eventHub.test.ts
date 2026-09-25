import { describe, expect, it } from 'vitest';
import type { OcEvent } from '../src/opencode/types';
import { OpencodeEventHub } from '../src/opencode/eventHub';

const event = (type: string, id?: string, payload = ''): OcEvent => ({ type, id, properties: { payload } });

describe('OpencodeEventHub', () => {
  it('保留上游事件 id，并按游标重放后续事件', () => {
    const hub = new OpencodeEventHub({ instanceId: 'instance-a', processId: 42 });
    const first = hub.commit(event('first', 'upstream-1'));
    const second = hub.commit(event('second', 'upstream-2'));

    expect(first).toEqual({ instanceId: 'instance-a', eventId: 'upstream-1', event: event('first', 'upstream-1') });
    expect(hub.replayAfter(first.eventId)).toEqual([second]);
    expect(hub.latestEventId).toBe(second.eventId);
  });

  it('无上游 id 时使用同一前缀和 12 位序号', () => {
    const hub = new OpencodeEventHub({ instanceId: 'instance-a', processId: 42 });
    const first = hub.commit(event('first'));
    const second = hub.commit(event('second'));

    expect(first.eventId).toMatch(/-\d{12}$/);
    expect(second.eventId).toMatch(/-\d{12}$/);
    expect(first.eventId.slice(0, -13)).toBe(second.eventId.slice(0, -13));
    expect(first.eventId.endsWith('000000000001')).toBe(true);
    expect(second.eventId.endsWith('000000000002')).toBe(true);
  });

  it('无游标、未知游标和 latest 游标分别返回 null、null 和空数组', () => {
    const hub = new OpencodeEventHub({ instanceId: 'instance-a' });
    const committed = hub.commit(event('first', 'upstream-1'));

    expect(hub.replayAfter()).toBeNull();
    expect(hub.replayAfter('unknown')).toBeNull();
    expect(hub.replayAfter(committed.eventId)).toEqual([]);
  });

  it('按条数截断 replay 窗口', () => {
    const hub = new OpencodeEventHub({ instanceId: 'instance-a', replayLimit: 2 });
    const first = hub.commit(event('first', 'e1'));
    hub.commit(event('second', 'e2'));
    const third = hub.commit(event('third', 'e3'));

    expect(hub.replayAfter(first.eventId)).toBeNull();
    expect(hub.replayAfter('e2')).toEqual([third]);
    expect(hub.replayAfter(third.eventId)).toEqual([]);
  });

  it('按序列化字节截断 replay 窗口', () => {
    const hub = new OpencodeEventHub({ instanceId: 'instance-a', replayBytes: 600 });
    const first = hub.commit(event('first', 'e1', 'x'.repeat(180)));
    hub.commit(event('second', 'e2', 'x'.repeat(180)));
    const third = hub.commit(event('third', 'e3', 'x'.repeat(180)));

    expect(hub.replayAfter(first.eventId)).toBeNull();
    expect(hub.replayAfter('e2')).toEqual([third]);
    expect(hub.replayAfter(third.eventId)).toEqual([]);
  });

  it('单条超限时清空旧窗口，避免跨洞重放', () => {
    const hub = new OpencodeEventHub({ instanceId: 'instance-a', replayBytes: 200 });
    const first = hub.commit(event('first', 'e1'));
    const oversized = hub.commit(event('oversized', 'e2', 'x'.repeat(1000)));
    hub.commit(event('third', 'e3'));

    expect(hub.replayAfter(first.eventId)).toBeNull();
    expect(hub.replayAfter(oversized.eventId)).toBeNull();
    expect(hub.replayAfter('e3')).toEqual([]);
  });

  it('reset 清空窗口并轮换前缀', () => {
    const hub = new OpencodeEventHub({ instanceId: 'instance-a', processId: 42 });
    const first = hub.commit(event('first'));
    hub.reset();
    const second = hub.commit(event('second'));

    expect(hub.replayAfter(first.eventId)).toBeNull();
    expect(hub.latestEventId).toBe(second.eventId);
    expect(second.eventId).not.toBe(first.eventId);
    expect(second.eventId.endsWith('000000000001')).toBe(true);
  });

  it('并发提交时序号保持连续且稳定', async () => {
    const hub = new OpencodeEventHub({ instanceId: 'instance-a', processId: 42 });
    const committed = await Promise.all(
      Array.from({ length: 50 }, (_, index) => Promise.resolve().then(() => hub.commit(event(`event-${index}`)))),
    );
    const prefixes = new Set(committed.map(({ eventId }) => eventId.slice(0, -13)));

    expect(prefixes.size).toBe(1);
    expect(new Set(committed.map(({ eventId }) => eventId)).size).toBe(50);
    expect(committed.map(({ eventId }) => eventId.slice(-12))).toEqual(
      Array.from({ length: 50 }, (_, index) => String(index + 1).padStart(12, '0')),
    );
  });
});
