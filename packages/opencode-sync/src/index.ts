export * from './form';

export interface StreamPermission {
  id: string;
  title?: string;
  pattern?: string | string[];
  metadata?: Record<string, unknown>;
  messageID?: string;
  sessionID?: string;
}

export interface StreamQuestion {
  id: string;
  /** 表单级标题（opencode form.title；AskUserQuestion 场景为空） */
  title?: string;
  /** 全语义字段视图（FormFieldView 契约见 ./form；旧字段 question/header/options/custom/multiple 兼容在内） */
  questions: import('./form').FormFieldView[];
  sessionID?: string;
  tool?: { messageID?: string; callID?: string };
}

export interface StreamPty {
  id: string;
  title?: string;
  command?: string;
  status?: string;
  exitCode?: number;
}

export interface StreamSnapshot {
  messages: any[];
  busy: boolean;
  retry?: { attempt: number; message: string; next: number };
  status: string;
  todos: any[];
  revert?: Record<string, unknown> | null;
  ptys: StreamPty[];
  pendingPermissions: StreamPermission[];
  pendingQuestions: StreamQuestion[];
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
  private questions = new Map<string, StreamQuestion>();
  private error: string | null = null;
  private title: string | undefined;
  private lastEventAt = 0;
  private eventCount = 0;

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

  private adoptPart(messageID: string, part: Part): Part {
    const partID = String(part?.id || '');
    if (partID) this.partIndex.set(partID, { messageID, partID });
    return part;
  }

  private ensureMessage(messageID: string, role = 'assistant'): Msg {
    let message = this.msgs.get(messageID);
    if (!message) {
      message = { id: messageID, role, parts: [] };
      this.msgs.set(messageID, message);
      this.order.push(messageID);
    }
    return message;
  }

  applyEvent(event: { type: string; properties?: Record<string, any> }): void {
    if (!event || typeof event.type !== 'string') return;
    this.eventCount += 1;
    this.lastEventAt = Date.now();
    const properties = event.properties || {};
    try {
      switch (event.type) {
        case 'message.updated': {
          const info = properties.info || {};
          const id = String(info.id || '');
          if (!id) break;
          const previous = this.msgs.get(id);
          this.msgs.set(id, previous ? { ...previous, ...info, parts: previous.parts } : { ...info, parts: [] });
          if (!this.order.includes(id)) this.order.push(id);
          break;
        }
        case 'message.part.updated': {
          const part = properties.part || {};
          const messageID = String(part.messageID || '');
          const partID = String(part.id || '');
          if (!messageID || !partID) break;
          const message = this.ensureMessage(messageID);
          const index = message.parts.findIndex((item: Part) => String(item.id) === partID);
          const next = this.adoptPart(messageID, part);
          if (index >= 0) message.parts[index] = next;
          else message.parts.push(next);
          break;
        }
        case 'message.part.delta': {
          const messageID = String(properties.messageID || '');
          const partID = String(properties.partID || '');
          const field = String(properties.field || 'text');
          const delta = String(properties.delta ?? '');
          if (!messageID || !partID) break;
          const message = this.ensureMessage(messageID);
          let part = message.parts.find((item: Part) => String(item.id) === partID);
          if (!part) {
            part = { id: partID, messageID, type: 'text' };
            message.parts.push(part);
            this.adoptPart(messageID, part);
          }
          if (field.includes('.')) {
            const keys = field.split('.');
            let current = part;
            for (let index = 0; index < keys.length - 1; index += 1) {
              const key = keys[index];
              if (typeof current[key] !== 'object' || current[key] === null) current[key] = {};
              current = current[key];
            }
            const last = keys[keys.length - 1];
            current[last] = typeof current[last] === 'string' ? current[last] + delta : delta;
          } else {
            part[field] = typeof part[field] === 'string' ? part[field] + delta : delta;
          }
          break;
        }
        case 'message.part.removed': {
          const messageID = String(properties.messageID || '');
          const partID = String(properties.partID || '');
          const message = this.msgs.get(messageID);
          if (message) message.parts = message.parts.filter((item: Part) => String(item.id) !== partID);
          this.partIndex.delete(partID);
          break;
        }
        case 'message.removed': {
          const messageID = String(properties.messageID || '');
          this.msgs.delete(messageID);
          this.order = this.order.filter((id) => id !== messageID);
          break;
        }
        case 'session.updated': {
          const info = properties.info || {};
          if (info.title) this.title = String(info.title);
          this.revert = info.revert || null;
          break;
        }
        case 'session.status': {
          const status = properties.status || {};
          this.status = String(status.type || 'unknown');
          this.busy = this.status === 'busy';
          if (this.status === 'retry') {
            this.retry = { attempt: Number(status.attempt || 0), message: String(status.message || ''), next: Number(status.next || 0) };
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
          const error = properties.error || {};
          this.error = String(error?.message || error?.name || '会话出错');
          this.busy = false;
          break;
        }
        case 'session.compacted':
          this.error = null;
          break;
        case 'todo.updated':
          this.todos = Array.isArray(properties.todos) ? properties.todos : [];
          break;
        case 'permission.asked':
        case 'permission.updated': {
          const permission = properties as StreamPermission;
          if (permission?.id) this.perms.set(String(permission.id), { ...permission, id: String(permission.id) });
          break;
        }
        case 'permission.replied': {
          const permissionID = String(properties.permissionID || properties.id || '');
          if (permissionID) this.perms.delete(permissionID);
          break;
        }
        case 'question.asked': {
          const question = properties as unknown as StreamQuestion;
          if (question?.id) this.questions.set(String(question.id), { ...question, id: String(question.id) });
          break;
        }
        case 'question.replied':
        case 'question.rejected': {
          const requestID = String(properties.requestID || properties.id || '');
          if (requestID) this.questions.delete(requestID);
          break;
        }
        case 'pty.created':
        case 'pty.updated': {
          const info = properties.info || {};
          if (info?.id) this.ptys.set(String(info.id), { ...info, id: String(info.id) });
          break;
        }
        case 'pty.exited': {
          const id = String(properties.id || '');
          const current = this.ptys.get(id);
          if (current) this.ptys.set(id, { ...current, status: 'exited', exitCode: Number(properties.exitCode ?? -1) });
          break;
        }
        default:
          break;
      }
    } catch {
      return;
    }
  }

  snapshot(): StreamSnapshot {
    return {
      messages: this.order.map((id) => this.msgs.get(id)).filter(Boolean) as Msg[],
      busy: this.busy,
      ...(this.retry ? { retry: this.retry } : {}),
      status: this.status,
      todos: this.todos,
      revert: this.revert,
      ptys: [...this.ptys.values()],
      pendingPermissions: [...this.perms.values()],
      pendingQuestions: [...this.questions.values()],
      error: this.error,
      ...(this.title ? { title: this.title } : {}),
      lastEventAt: this.lastEventAt,
      eventCount: this.eventCount,
    };
  }
}

/** 工具输出的可用文本（v2）：state.output 是内容块数组（[{type:'text',text}]），直接渲染会是
 *  [object Object]；回退 metadata.output / metadata.preview / metadata.matches。TUI 同源取值。 */
export function toolOutputText(part: Record<string, any> | undefined | null, max = 0): string {
  const state = part?.state && typeof part.state === 'object' ? part.state : {};
  let text = '';
  const out = state.output;
  if (typeof out === 'string') text = out;
  else if (Array.isArray(out)) {
    text = out
      .map((b: any) => (b && typeof b === 'object' ? String(b.text ?? '') : String(b ?? '')))
      .filter(Boolean)
      .join('\n');
  } else if (out && typeof out === 'object') {
    text = String((out as any).text ?? '');
  }
  if (!text) {
    const meta = state.metadata && typeof state.metadata === 'object' ? state.metadata : {};
    for (const key of ['output', 'preview', 'matches', 'content']) {
      const v = (meta as Record<string, any>)[key];
      if (typeof v === 'string' && v) { text = v; break; }
      if (Array.isArray(v) && v.length) {
        text = v.map((b: any) => (b && typeof b === 'object' ? String(b.text ?? b.line ?? '') : String(b ?? ''))).filter(Boolean).join('\n');
        if (text) break;
      }
    }
  }
  if (max > 0 && text.length > max) return text.slice(0, max) + `\n…（共 ${text.length} 字符）`;
  return text;
}
