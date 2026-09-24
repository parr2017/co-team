/**
 * SessionStream —— opencode 会话的流式状态机（TUI 同构镜像的前端内核）。
 *
 * 本文件是**规范副本**：web/mobile 的 opencode-stream.ts 必须与之字节级一致
 * （cp 同步，改一处必须三处同改 + 跑 server/test/stream.test.ts）。
 * 纯 TS 零依赖，禁止引入任何框架/DOM API。
 *
 * 输入两类：reset(GET /session/:id/message 的全量快照) + applyEvent(SSE 逐帧)。
 * 输出 snapshot()：消息数组（parts 已合并 delta）、busy/retry、todos、revert、ptys、
 * 待批权限、错误与最近事件时间。
 *
 * 事件载荷均为 2026-09-24 对 opencode 1.18.32 实测抓包所得：
 *   message.updated {info}；message.part.updated {part, delta?}；
 *   message.part.delta {messageID, partID, field, delta}（token 级增量）；
 *   session.updated {info}（含 revert 状态）；session.status {status:{type}}；
 *   session.idle / session.error {error?} / session.compacted；
 *   todo.updated {todos}；permission.asked|updated {Permission}；permission.replied {permissionID, response}；
 *   pty.created|updated {info}；pty.exited {id, exitCode}；session.diff {diff}
 */

export interface StreamPermission {
  id: string;
  title?: string;
  pattern?: string | string[];
  metadata?: Record<string, unknown>;
  messageID?: string;
  sessionID?: string;
}

export interface StreamPty {
  id: string;
  title?: string;
  command?: string;
  status?: string;
  exitCode?: number;
}

export interface StreamSnapshot {
  /** {id, role, time?, ...info, parts: Part[]}，按消息 id 稳定排序（创建序）。
   *  松散类型（any[]）：parts 的 12 种形态与 info 的演进字段都直出给 UI 渲染，不做窄化 */
  messages: any[];
  busy: boolean;
  retry?: { attempt: number; message: string; next: number };
  status: string;
  todos: any[];
  /** 会话 revert 提示（session.updated.info.revert，回退预览 UI 用） */
  revert?: Record<string, unknown> | null;
  ptys: StreamPty[];
  pendingPermissions: StreamPermission[];
  error: string | null;
  title?: string;
  lastEventAt: number;
  eventCount: number;
}

type Part = Record<string, any>;
type Msg = Record<string, any>;

export class SessionStream {
  private msgs = new Map<string, Msg>();
  private partIndex = new Map<string, { messageID: string; partID: string }>();
  private order: string[] = [];
  private busy = false;
  private status = 'unknown';
  private retry?: { attempt: number; message: string; next: number };
  private todos: Record<string, unknown>[] = [];
  private revert: Record<string, unknown> | null = null;
  private ptys = new Map<string, StreamPty>();
  private perms = new Map<string, StreamPermission>();
  private error: string | null = null;
  private title: string | undefined;
  private lastEventAt = 0;
  private eventCount = 0;

  /** 全量快照重置（打开会话/重连后的权威对齐） */
  reset(messages: { info: Msg; parts: Part[] }[]): void {
    this.msgs.clear();
    this.partIndex.clear();
    this.order = [];
    this.revert = null;
    this.error = null;
    for (const m of messages || []) {
      const info = m?.info || {};
      const id = String(info.id || '');
      if (!id) continue;
      const parts = Array.isArray(m.parts) ? m.parts.map((p) => this.adoptPart(id, p)) : [];
      this.msgs.set(id, { ...info, parts });
      this.order.push(id);
    }
  }

  /** 历史翻页：更早的消息整批插到头部（幂等——已存在的 id 跳过），批次内顺序保持 */
  prepend(messages: { info: Msg; parts: Part[] }[]): void {
    const fresh: string[] = [];
    for (const m of messages || []) {
      const info = m?.info || {};
      const id = String(info.id || '');
      if (!id || this.msgs.has(id)) continue;
      const parts = Array.isArray(m.parts) ? m.parts.map((p) => this.adoptPart(id, p)) : [];
      this.msgs.set(id, { ...info, parts });
      fresh.push(id);
    }
    if (fresh.length) this.order.unshift(...fresh);
  }

  /** 采纳一个 part：建立 partID → (messageID, partID) 索引，返回对象引用 */
  private adoptPart(messageID: string, part: Part): Part {
    const pid = String(part?.id || '');
    if (pid) this.partIndex.set(pid, { messageID, partID: pid });
    return part;
  }

  private ensureMessage(messageID: string, role = 'assistant'): Msg {
    let m = this.msgs.get(messageID);
    if (!m) {
      m = { id: messageID, role, parts: [] };
      this.msgs.set(messageID, m);
      this.order.push(messageID);
    }
    return m;
  }

  /** 应用一帧 SSE 事件（调用方已按 sessionID 过滤；本方法零抛异常） */
  applyEvent(ev: { type: string; properties?: Record<string, any> }): void {
    if (!ev || typeof ev.type !== 'string') return;
    this.eventCount += 1;
    this.lastEventAt = Date.now();
    const p = ev.properties || {};
    try {
      switch (ev.type) {
        case 'message.updated': {
          const info = p.info || {};
          const id = String(info.id || '');
          if (!id) break;
          const prev = this.msgs.get(id);
          this.msgs.set(id, prev ? { ...prev, ...info, parts: prev.parts } : { ...info, parts: [] });
          if (!this.order.includes(id)) this.order.push(id);
          break;
        }
        case 'message.part.updated': {
          const part = p.part || {};
          const mid = String(part.messageID || '');
          const pid = String(part.id || '');
          if (!mid || !pid) break;
          const m = this.ensureMessage(mid);
          const idx = m.parts.findIndex((x: Part) => String(x.id) === pid);
          const next = this.adoptPart(mid, part);
          if (idx >= 0) m.parts[idx] = next; else m.parts.push(next);
          break;
        }
        case 'message.part.delta': {
          // token 级增量：{messageID, partID, field, delta}。part 未见过时按 field 猜类型建骨架
          const mid = String(p.messageID || '');
          const pid = String(p.partID || '');
          const field = String(p.field || 'text');
          const delta = String(p.delta ?? '');
          if (!mid || !pid) break;
          const m = this.ensureMessage(mid);
          let part = m.parts.find((x: Part) => String(x.id) === pid);
          if (!part) {
            part = { id: pid, messageID: mid, type: field === 'text' ? 'text' : 'text' };
            m.parts.push(part);
            this.adoptPart(mid, part);
          }
          if (field.includes('.')) {
            // 嵌套字段（如 state.input）：set-by-path
            const keys = field.split('.');
            let cur = part;
            for (let i = 0; i < keys.length - 1; i++) {
              const k = keys[i];
              if (typeof cur[k] !== 'object' || cur[k] === null) cur[k] = {};
              cur = cur[k];
            }
            const last = keys[keys.length - 1];
            cur[last] = typeof cur[last] === 'string' ? cur[last] + delta : delta;
          } else {
            part[field] = typeof part[field] === 'string' ? part[field] + delta : delta;
          }
          break;
        }
        case 'message.part.removed': {
          const mid = String(p.messageID || '');
          const pid = String(p.partID || '');
          const m = this.msgs.get(mid);
          if (m) m.parts = m.parts.filter((x: Part) => String(x.id) !== pid);
          this.partIndex.delete(pid);
          break;
        }
        case 'message.removed': {
          const mid = String(p.messageID || '');
          this.msgs.delete(mid);
          this.order = this.order.filter((x) => x !== mid);
          break;
        }
        case 'session.updated': {
          const info = p.info || {};
          if (info.title) this.title = String(info.title);
          this.revert = info.revert || null;
          break;
        }
        case 'session.status': {
          const st = p.status || {};
          this.status = String(st.type || 'unknown');
          this.busy = this.status === 'busy';
          if (this.status === 'retry') {
            this.retry = { attempt: Number(st.attempt || 0), message: String(st.message || ''), next: Number(st.next || 0) };
          } else {
            this.retry = undefined;
          }
          break;
        }
        case 'session.idle':
          this.busy = false;
          this.status = 'idle';
          this.retry = undefined;
          break;
        case 'session.error': {
          const err = p.error || {};
          this.error = String(err?.message || err?.name || '会话出错');
          this.busy = false;
          break;
        }
        case 'session.compacted':
          this.error = null; // 上下文压缩完成——清掉旧错误展示
          break;
        case 'todo.updated':
          this.todos = Array.isArray(p.todos) ? p.todos : [];
          break;
        case 'permission.asked':
        case 'permission.updated': {
          const perm = p as StreamPermission;
          if (perm?.id) this.perms.set(String(perm.id), { ...perm, id: String(perm.id) });
          break;
        }
        case 'permission.replied': {
          const pid = String(p.permissionID || p.id || '');
          if (pid) this.perms.delete(pid);
          break;
        }
        case 'pty.created':
        case 'pty.updated': {
          const info = p.info || {};
          if (info?.id) this.ptys.set(String(info.id), { ...info, id: String(info.id) });
          break;
        }
        case 'pty.exited': {
          const id = String(p.id || '');
          const cur = this.ptys.get(id);
          if (cur) this.ptys.set(id, { ...cur, status: 'exited', exitCode: Number(p.exitCode ?? -1) });
          break;
        }
        default:
          break; // 未知/噪音事件忽略（投影在 server events.ts 已先滤一轮）
      }
    } catch { /* 单帧畸形不杀状态机 */ }
  }

  /** 派生快照（UI 直接渲染；消息按 order 稳定输出） */
  snapshot(): StreamSnapshot {
    return {
      messages: this.order.map((id) => this.msgs.get(id)!).filter(Boolean),
      busy: this.busy,
      ...(this.retry ? { retry: this.retry } : {}),
      status: this.status,
      todos: this.todos,
      revert: this.revert,
      ptys: [...this.ptys.values()],
      pendingPermissions: [...this.perms.values()],
      error: this.error,
      ...(this.title ? { title: this.title } : {}),
      lastEventAt: this.lastEventAt,
      eventCount: this.eventCount,
    };
  }
}
