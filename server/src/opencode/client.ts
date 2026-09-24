/**
 * OpencodeClient —— opencode server 的 HTTP+SSE 客户端（纯 fetch，不引 SDK）。
 *
 * 设计取舍：官方 @opencode-ai/sdk 与 opencode CLI 版本强耦合，而本机 CLI（1.x）与
 * 桌面版（2.x）并存、API 世代可能有差异；自研客户端按 OpenAPI 端点直连，配合
 * capabilities 探测（/doc + /global/health）做兼容兜底，版本升级只影响探测表。
 *
 * 纪律（对齐 mcp/manager.ts）：任何异常都在方法内转 {ok:false,error}，绝不 throw 穿透；
 * 结果按 maxResultChars 截断。
 */
import {
  DEFAULT_OC_MAX_RESULT_CHARS,
  DEFAULT_OC_TIMEOUT_SEC,
  EMPTY_CAPABILITIES,
  type OcCallResult,
  type OcCapabilities,
  type OcEvent,
  type OcSession,
} from './types';

export interface OpencodeClientOptions {
  baseUrl: string;
  auth?: { username?: string; password?: string };
  timeoutSec?: number;
  maxResultChars?: number;
}

/** v2 /doc 端点探测不到时的保守兜底（按本地 v1 CLI 实测端点集） */
const V1_FALLBACK_PATHS = new Set([
  '/global/health',
  '/session',
  '/session/{id}',
  '/session/{id}/message',
  '/session/{id}/prompt_async',
  '/session/{id}/abort',
  '/session/{id}/revert',
  '/session/{id}/diff',
  '/session/{id}/permissions/{permissionID}',
  '/event',
  '/tui/append-prompt',
]);

export class OpencodeClient {
  readonly baseUrl: string;
  private auth?: { username?: string; password?: string };
  private timeoutMs: number;
  private maxResultChars: number;

  constructor(opts: OpencodeClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
    this.auth = opts.auth;
    this.timeoutMs = (opts.timeoutSec ?? DEFAULT_OC_TIMEOUT_SEC) * 1000;
    this.maxResultChars = opts.maxResultChars ?? DEFAULT_OC_MAX_RESULT_CHARS;
  }

  // ---------- 传输原语 ----------

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    const h: Record<string, string> = { accept: 'application/json', ...extra };
    if (this.auth?.password) {
      const user = this.auth.username || 'opencode';
      h.authorization = `Basic ${Buffer.from(`${user}:${this.auth.password}`).toString('base64')}`;
    }
    return h;
  }

  private async req<T>(method: string, path: string, body?: unknown): Promise<OcCallResult<T>> {
    try {
      const res = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers: this.headers(body !== undefined ? { 'content-type': 'application/json' } : {}),
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (res.status === 204) return { ok: true, data: true as unknown as T };
      const text = await res.text();
      if (!res.ok) return { ok: false, error: `HTTP ${res.status}: ${text.slice(0, 300) || res.statusText}` };
      if (!text) return { ok: true, data: true as unknown as T };
      return { ok: true, data: (JSON.parse(text) as T) };
    } catch (e: any) {
      return { ok: false, error: String(e?.message || e).slice(0, 300) };
    }
  }

  /**
   * 结果按预算截断：数组按元素累积（保持数组类型，超预算截到最后一项并标 truncated）；
   * 非数组超预算才降级为截断字符串。调用方据 truncated 决定是否换更精确的参数重取。
   */
  private async truncate<T>(p: Promise<OcCallResult<T>>): Promise<OcCallResult<T>> {
    const r = await p;
    if (!r.ok || r.data === undefined) return r;
    if (Array.isArray(r.data)) {
      const out: unknown[] = [];
      let used = 2;
      for (const item of r.data) {
        const size = JSON.stringify(item).length + 1;
        if (used + size > this.maxResultChars) {
          return { ok: true, data: out as unknown as T, truncated: true };
        }
        out.push(item);
        used += size;
      }
      return r;
    }
    const s = JSON.stringify(r.data);
    if (s.length <= this.maxResultChars) return r;
    return { ok: true, data: s.slice(0, this.maxResultChars) as unknown as T, truncated: true };
  }

  // ---------- 探针 ----------

  async health(): Promise<OcCallResult<{ version: string }>> {
    const r = await this.req<{ healthy?: boolean; version?: string }>('GET', '/global/health');
    if (!r.ok) return { ok: false, error: r.error };
    return { ok: true, data: { version: String(r.data?.version || '') } };
  }

  /**
   * 能力探测：/global/health 定性存活；/doc 拉 OpenAPI spec 按端点存在性打标。
   * spec 拉不到/解析不了（v2 可能返回 HTML）→ 回退 V1_FALLBACK_PATHS 保守集。
   */
  async probe(): Promise<OcCapabilities> {
    const caps: OcCapabilities = { ...EMPTY_CAPABILITIES };
    const h = await this.health();
    caps.healthy = h.ok;
    caps.version = h.ok ? h.data!.version : '';
    const doc = await this.req<{ paths?: Record<string, unknown> }>('GET', '/doc');
    const paths = doc.ok && doc.data?.paths ? new Set(Object.keys(doc.data.paths)) : V1_FALLBACK_PATHS;
    const has = (p: string): boolean => {
      if (paths.has(p)) return true;
      if (p.includes('{')) {
        const re = new RegExp('^' + p.replace(/\//g, '\\/').replace(/\{[^}]+\}/g, '[^/]+') + '$');
        for (const k of paths) if (re.test(k)) return true;
      }
      return false;
    };
    caps.sync_prompt = has('/session/{id}/message');
    caps.async_prompt = has('/session/{id}/prompt_async');
    caps.abort = has('/session/{id}/abort');
    caps.revert = has('/session/{id}/revert');
    caps.diff = has('/session/{id}/diff');
    caps.permissions = has('/session/{id}/permissions/{permissionID}');
    caps.events = has('/event') || has('/global/event');
    caps.shell = has('/session/{id}/shell');
    caps.tui = has('/tui/append-prompt') || has('/tui/submit-prompt');
    return caps;
  }

  // ---------- sessions ----------

  listSessions(): Promise<OcCallResult<OcSession[]>> {
    return this.truncate(this.req<OcSession[]>('GET', '/session'));
  }

  sessionStatus(): Promise<OcCallResult<Record<string, unknown>>> {
    return this.req<Record<string, unknown>>('GET', '/session/status');
  }

  getSession(id: string): Promise<OcCallResult<OcSession>> {
    return this.req<OcSession>('GET', `/session/${encodeURIComponent(id)}`);
  }

  createSession(title?: string): Promise<OcCallResult<OcSession>> {
    return this.req<OcSession>('POST', '/session', { ...(title ? { title } : {}) });
  }

  deleteSession(id: string): Promise<OcCallResult<boolean>> {
    return this.req<boolean>('DELETE', `/session/${encodeURIComponent(id)}`);
  }

  forkSession(id: string, messageID?: string): Promise<OcCallResult<OcSession>> {
    return this.req<OcSession>('POST', `/session/${encodeURIComponent(id)}/fork`, { ...(messageID ? { messageID } : {}) });
  }

  abortSession(id: string): Promise<OcCallResult<boolean>> {
    return this.req<boolean>('POST', `/session/${encodeURIComponent(id)}/abort`);
  }

  /**
   * 会话消息列表。opencode 1.18.32 的 `limit` 是**尾优先**（返回最新 N 条，实测确认），
   * `before` 参数在此版本不论消息 id 还是时间戳均 BadRequest（v2 才有）——翻页由
   * manager 的内存缓存切片承担，client 只透传 limit。
   * **不做累积截断**：历史截断曾把最新消息整段丢掉（2026-09-24“看不全”事故），
   * 体积控制上移到 manager 的按需裁剪。
   */
  listMessages(id: string, limit?: number): Promise<OcCallResult<unknown[]>> {
    const q = limit && limit > 0 ? `?limit=${Math.floor(limit)}` : '';
    return this.req<unknown[]>('GET', `/session/${encodeURIComponent(id)}/message${q}`);
  }

  /** 单条消息全文（「查看完整原文」；绕过 manager 响应路径的裁剪） */
  getMessage(id: string, messageID: string): Promise<OcCallResult<{ info: unknown; parts: unknown[] }>> {
    return this.req<{ info: unknown; parts: unknown[] }>('GET', `/session/${encodeURIComponent(id)}/message/${encodeURIComponent(messageID)}`);
  }

  /** 同步 prompt：等 opencode 跑完返回 {info,parts}。model 为 {providerID,modelID} 或池内模型名（由 manager 解析） */
  prompt(id: string, prompt: string, model?: { providerID: string; modelID: string }, agent?: string): Promise<OcCallResult<unknown>> {
    return this.truncate(
      this.req<unknown>('POST', `/session/${encodeURIComponent(id)}/message`, {
        parts: [{ type: 'text', text: prompt }],
        ...(model ? { model } : {}),
        ...(agent ? { agent } : {}),
      }),
    );
  }

  /** 异步 prompt：立即返回，进展靠 SSE /event 跟踪 */
  promptAsync(id: string, prompt: string, model?: { providerID: string; modelID: string }, agent?: string): Promise<OcCallResult<{ messageID?: string }>> {
    return this.req<{ messageID?: string }>('POST', `/session/${encodeURIComponent(id)}/prompt_async`, {
      parts: [{ type: 'text', text: prompt }],
      ...(model ? { model } : {}),
      ...(agent ? { agent } : {}),
    });
  }

  /** 高危：在会话内执行任意 shell 命令（默认禁用，由 manager 门控） */
  shell(id: string, command: string, agent?: string): Promise<OcCallResult<unknown>> {
    return this.truncate(
      this.req<unknown>('POST', `/session/${encodeURIComponent(id)}/shell`, { agent: agent || 'general', command }),
    );
  }

  revert(id: string, messageID: string): Promise<OcCallResult<boolean>> {
    return this.req<boolean>('POST', `/session/${encodeURIComponent(id)}/revert`, { messageID });
  }

  unrevert(id: string): Promise<OcCallResult<boolean>> {
    return this.req<boolean>('POST', `/session/${encodeURIComponent(id)}/unrevert`);
  }

  diff(id: string): Promise<OcCallResult<unknown[]>> {
    return this.truncate(this.req<unknown[]>('GET', `/session/${encodeURIComponent(id)}/diff`));
  }

  answerPermission(id: string, permissionID: string, response: 'once' | 'always' | 'reject'): Promise<OcCallResult<boolean>> {
    return this.req<boolean>('POST', `/session/${encodeURIComponent(id)}/permissions/${encodeURIComponent(permissionID)}`, {
      response,
      remember: response === 'always',
    });
  }

  // ---------- 提问应答（opencode 的 AskUserQuestion） ----------

  /** 回答提问：answers 按问题顺序，每个答案是选中的 label 数组 */
  answerQuestion(requestID: string, answers: string[][]): Promise<OcCallResult<boolean>> {
    return this.req<boolean>('POST', `/question/${encodeURIComponent(requestID)}/reply`, { answers });
  }

  /** 拒绝/不回答提问（agent 会收到 QuestionRejected，自行继续） */
  rejectQuestion(requestID: string): Promise<OcCallResult<boolean>> {
    return this.req<boolean>('POST', `/question/${encodeURIComponent(requestID)}/reject`, {});
  }

  // ---------- TUI 驱动（attached control 档） ----------

  appendPrompt(text: string): Promise<OcCallResult<boolean>> {
    return this.req<boolean>('POST', '/tui/append-prompt', { text });
  }

  submitPrompt(): Promise<OcCallResult<boolean>> {
    return this.req<boolean>('POST', '/tui/submit-prompt');
  }

  clearPrompt(): Promise<OcCallResult<boolean>> {
    return this.req<boolean>('POST', '/tui/clear-prompt');
  }

  showToast(message: string, variant: 'info' | 'success' | 'warning' | 'error' = 'info'): Promise<OcCallResult<boolean>> {
    return this.req<boolean>('POST', '/tui/show-toast', { message, variant });
  }

  openSessions(): Promise<OcCallResult<boolean>> {
    return this.req<boolean>('POST', '/tui/open-sessions');
  }

  /** 指挥 TUI 导航到指定会话——"让位式接管"：co-team 独占前把 TUI 切到别处 */
  selectSession(sessionId: string): Promise<OcCallResult<boolean>> {
    return this.req<boolean>('POST', '/tui/select-session', { sessionID: sessionId });
  }

  // ---------- agents / models / 命令 / todos ----------

  /** opencode 内置 agent 清单（TUI 同构 composer 的 agent 下拉数据源） */
  listAgents(): Promise<OcCallResult<{ name: string; description?: string; mode?: string }[]>> {
    return this.req<{ name: string; description?: string; mode?: string }[]>('GET', '/agent');
  }

  /** providers + 各 provider 默认模型（attached 实例的模型下拉数据源） */
  listProviders(): Promise<OcCallResult<{ providers?: unknown[]; default?: Record<string, string> }>> {
    return this.req<{ providers?: unknown[]; default?: Record<string, string> }>('GET', '/config/providers');
  }

  /** 斜杠命令（TUI 的 /命令；command 形如 'summarize'。opencode 要求 arguments 为字符串——缺字段 400） */
  runCommand(id: string, command: string, args = '', agent?: string): Promise<OcCallResult<unknown>> {
    return this.truncate(
      this.req<unknown>('POST', `/session/${encodeURIComponent(id)}/command`, {
        command,
        arguments: args,
        ...(agent ? { agent } : {}),
      }),
    );
  }

  /** 会话 todos（TUI 顶部的任务清单；GET 直取，不依赖事件拼装） */
  sessionTodos(id: string): Promise<OcCallResult<{ content: string; status: string; priority: string }[]>> {
    return this.req<{ content: string; status: string; priority: string }[]>('GET', `/session/${encodeURIComponent(id)}/todo`);
  }

  // ---------- PTY（TUI 的实时终端：bash 工具跑在 PTY 里） ----------

  listPtys(): Promise<OcCallResult<{ id: string; title?: string; command?: string; status?: string }[]>> {
    return this.req<{ id: string; title?: string; command?: string; status?: string }[]>('GET', '/pty');
  }

  /** PTY 连接票：浏览器持 ticket 直连 /pty/{id}/connect（WebSocket）——managed 免鉴可直接签 */
  ptyConnectToken(ptyId: string): Promise<OcCallResult<{ ticket: string; expires_in: number }>> {
    return this.req<{ ticket: string; expires_in: number }>('POST', `/pty/${encodeURIComponent(ptyId)}/connect-token`, {});
  }

  // ---------- project ----------

  currentProject(): Promise<OcCallResult<{ id?: string; worktree?: string }>> {
    return this.req<{ id?: string; worktree?: string }>('GET', '/project/current');
  }

  // ---------- SSE 事件流 ----------

  /**
   * 订阅 /event（SSE）。按行解析 `data:` 帧，JSON.parse 失败跳过。
   * 返回的 abort 供 manager 控制退避重连；网络断流由本方法 reject 表达。
   */
  async *eventStream(signal?: AbortSignal): AsyncGenerator<OcEvent> {
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/event`, { headers: this.headers({ accept: 'text/event-stream' }), signal });
    } catch (e) {
      // 主动退订（manager stop/重连）静默结束；真实网络错误才向上抛给重连逻辑
      if (signal?.aborted) return;
      throw e;
    }
    if (!res.ok || !res.body) throw new Error(`SSE ${res.status}`);
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let nl: number;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line.startsWith('data:')) continue;
          const payload = line.slice(5).trim();
          if (!payload || payload === '[DONE]') continue;
          try {
            const ev = JSON.parse(payload) as OcEvent;
            if (ev && typeof ev.type === 'string') yield ev;
          } catch { /* 单帧畸形不影响流 */ }
        }
      }
    } finally {
      // cancel() 在已出错（如 abort）的流上返回 rejected promise——必须接住，
      // 否则 stop/重连时冒出一串未处理拒绝（vitest 记为 unhandled error）
      try {
        void Promise.resolve(reader.cancel()).catch(() => {});
      } catch { /* 已断 */ }
    }
  }
}

/** 一次性能力探测（UI「测试连接」/manager 装配前预检，不建注册表） */
export async function probeOpencodeInstance(opts: OpencodeClientOptions): Promise<OcCapabilities> {
  return new OpencodeClient(opts).probe();
}
