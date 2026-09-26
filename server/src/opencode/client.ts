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

const MIN_VERSION = { major: 2, minor: 0, patch: 15 } as const;
const UNSUPPORTED_ERROR = 'OpenCode 2.0.15 官方客户端不提供该能力';

type OfficialClient = any;
type RequestOptions = { signal?: AbortSignal };
type OfficialEvent = { id: string; type: string; created?: number; location?: unknown; data: Record<string, unknown> };
type OpenCodeFactory = { make(options: { baseUrl: string; headers: Record<string, string> }): OfficialClient };

const loadOpenCode = require('./officialClientLoader.cjs') as () => Promise<{ OpenCode: OpenCodeFactory }>;

function versionParts(version: string): { major: number; minor: number; patch: number } | undefined {
  const match = /^[v=\s]*(\d+)\.(\d+)\.(\d+)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?\s*$/.exec(version);
  if (!match) return undefined;
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) };
}

function isSupportedVersion(version: string): boolean {
  const parts = versionParts(version);
  if (!parts || parts.major !== MIN_VERSION.major) return false;
  if (parts.minor !== MIN_VERSION.minor) return parts.minor > MIN_VERSION.minor;
  return parts.patch >= MIN_VERSION.patch;
}

export class OpencodeClient {
  readonly baseUrl: string;
  private readonly clientPromise: Promise<OfficialClient>;
  private readonly password?: string;
  private readonly timeoutMs: number;
  private readonly maxResultChars: number;

  constructor(opts: OpencodeClientOptions) {
    this.baseUrl = new URL(opts.baseUrl).origin;
    this.password = opts.auth?.password;
    this.timeoutMs = (opts.timeoutSec ?? DEFAULT_OC_TIMEOUT_SEC) * 1000;
    this.maxResultChars = opts.maxResultChars ?? DEFAULT_OC_MAX_RESULT_CHARS;
    const headers: Record<string, string> = {};
    if (opts.auth?.password) {
      const username = opts.auth.username || 'opencode';
      headers.authorization = `Basic ${Buffer.from(`${username}:${opts.auth.password}`).toString('base64')}`;
    }
    this.clientPromise = loadOpenCode().then(({ OpenCode }) => OpenCode.make({ baseUrl: this.baseUrl, headers }));
  }

  private requestOptions(): RequestOptions {
    return { signal: AbortSignal.timeout(this.timeoutMs) };
  }

  private errorText(error: unknown): string {
    const value = error as {
      message?: unknown;
      status?: unknown;
      cause?: { status?: unknown; message?: unknown };
    };
    const cause = value?.cause;
    const statusValue = value?.status ?? cause?.status;
    const status = Number.isInteger(statusValue) ? `HTTP ${statusValue}: ` : '';
    const raw = String(value?.message || cause?.message || error || 'OpenCode 请求失败');
    const withoutBasic = raw.replace(/Basic\s+[^\s,;]+/gi, 'Basic [redacted]');
    const withoutAuthorization = withoutBasic.replace(/(authorization\s*[:=]\s*)[^\s,;]+/gi, '$1[redacted]');
    const withoutPassword = this.password ? withoutAuthorization.split(this.password).join('[redacted]') : withoutAuthorization;
    return `${status}${withoutPassword}`.slice(0, 300);
  }

  private async call<T>(request: (client: OfficialClient, options: RequestOptions) => Promise<T>): Promise<OcCallResult<T>> {
    try {
      const client = await this.clientPromise;
      return { ok: true, data: await request(client, this.requestOptions()) };
    } catch (error) {
      return { ok: false, error: this.errorText(error) };
    }
  }

  private async callTrue(request: (client: OfficialClient, options: RequestOptions) => Promise<unknown>): Promise<OcCallResult<boolean>> {
    const result = await this.call(request);
    return result.ok ? { ok: true, data: true } : { ok: false, error: result.error };
  }

  private async truncate<T>(promise: Promise<OcCallResult<T>>): Promise<OcCallResult<T>> {
    const result = await promise;
    if (!result.ok || result.data === undefined) return result;
    if (Array.isArray(result.data)) {
      const output: unknown[] = [];
      let used = 2;
      for (const item of result.data) {
        const size = JSON.stringify(item).length + 1;
        if (used + size > this.maxResultChars) {
          return { ok: true, data: output as unknown as T, truncated: true };
        }
        output.push(item);
        used += size;
      }
      return result;
    }
    const serialized = JSON.stringify(result.data);
    if (serialized.length <= this.maxResultChars) return result;
    return { ok: true, data: serialized.slice(0, this.maxResultChars) as unknown as T, truncated: true };
  }

  async health(): Promise<OcCallResult<{ version: string }>> {
    const result = await this.call<{ version: string }>((client, options) => client.server.info(options));
    if (!result.ok) return result;
    const version = String(result.data?.version || '');
    if (!isSupportedVersion(version)) {
      return {
        ok: false,
        data: { version },
        error: `OpenCode 版本不兼容：需要 >=2.0.15 且主版本为 2，实际为 ${version || 'unknown'}`,
      };
    }
    return { ok: true, data: { version } };
  }

  async probe(): Promise<OcCapabilities> {
    const capabilities: OcCapabilities = { ...EMPTY_CAPABILITIES };
    const health = await this.health();
    capabilities.healthy = health.ok;
    capabilities.version = health.data?.version || '';
    if (!health.ok) return capabilities;
    capabilities.async_prompt = true;
    capabilities.abort = true;
    capabilities.revert = true;
    capabilities.diff = true;
    capabilities.permissions = true;
    capabilities.events = true;
    capabilities.shell = true;
    return capabilities;
  }

  listSessions(): Promise<OcCallResult<OcSession[]>> {
    return this.truncate(this.call(async (client, options) => {
      const response = await client.session.list(undefined, options);
      return response.data as OcSession[];
    }));
  }

  sessionStatus(): Promise<OcCallResult<Record<string, unknown>>> {
    return this.call((client, options) => client.session.active(options));
  }

  getSession(id: string): Promise<OcCallResult<OcSession>> {
    return this.call(async (client, options) => client.session.get({ sessionID: id }, options) as unknown as OcSession);
  }

  createSession(title?: string, directory?: string): Promise<OcCallResult<OcSession>> {
    return this.call(async (client, options) => {
      // 不带目录时 opencode 会把会话登记到全局项目（用户主目录）——agent 工作目录会跑错项目
      const input: Record<string, unknown> = {
        ...(title ? { title } : {}),
        ...(directory ? { location: { directory } } : {}),
      };
      return client.session.create(input, options) as unknown as OcSession;
    });
  }

  deleteSession(id: string): Promise<OcCallResult<boolean>> {
    return this.callTrue((client, options) => client.session.remove({ sessionID: id }, options));
  }

  forkSession(id: string, messageID?: string): Promise<OcCallResult<OcSession>> {
    return this.call(async (client, options) => client.session.fork({
      sessionID: id,
      ...(messageID ? { before: messageID } : {}),
    }, options) as unknown as OcSession);
  }

  abortSession(id: string): Promise<OcCallResult<boolean>> {
    return this.callTrue((client, options) => client.session.interrupt({ sessionID: id }, options));
  }

  private projectMessages(messages: unknown): { info: Record<string, unknown>; parts: Record<string, unknown>[] }[] {
    if (!Array.isArray(messages)) return [];
    return messages
      .filter((message): message is Record<string, unknown> => Boolean(message && typeof message === 'object'))
      .map((message) => this.projectMessage(message));
  }

  private projectMessage(message: Record<string, unknown>): { info: Record<string, unknown>; parts: Record<string, unknown>[] } {
    const id = String(message.id || '');
    const type = String(message.type || 'assistant');
    const model = message.model && typeof message.model === 'object' ? message.model as Record<string, unknown> : undefined;
    const info: Record<string, unknown> = {
      ...message,
      id,
      role: type,
      ...(model?.providerID ? { providerID: model.providerID } : {}),
      ...(model?.id ? { modelID: model.id } : {}),
    };
    if (type === 'user') {
      return {
        info,
        parts: id ? [{ id: `${id}:text`, messageID: id, type: 'text', text: String(message.text || '') }] : [],
      };
    }
    if (type !== 'assistant' || !Array.isArray(message.content)) return { info, parts: [] };
    const parts: Record<string, unknown>[] = [];
    message.content.forEach((value, index) => {
      if (!value || typeof value !== 'object') return;
      const content = value as Record<string, unknown>;
      const contentType = String(content.type || 'text');
      if (contentType === 'text' || contentType === 'reasoning') {
        parts.push({
          id: `${id}:${contentType}:${index}`,
          messageID: id,
          type: contentType,
          text: String(content.text || ''),
          ...(content.time && typeof content.time === 'object' ? { time: content.time } : {}),
        });
        return;
      }
      if (contentType !== 'tool') return;
      const state = content.state && typeof content.state === 'object' ? content.state as Record<string, unknown> : {};
      const output = Array.isArray(state.content) ? state.content : state.output;
      parts.push({
        id: String(content.id || `${id}:tool:${index}`),
        messageID: id,
        callID: String(content.id || `${id}:tool:${index}`),
        type: 'tool',
        tool: String(content.name || 'tool'),
        time: content.time || {},
        state: {
          status: String(state.status || contentType),
          ...(state.input && typeof state.input === 'object' ? { input: state.input } : {}),
          ...(output !== undefined ? { output } : {}),
          ...(state.error !== undefined ? { error: state.error } : {}),
          ...(state.metadata && typeof state.metadata === 'object' ? { metadata: state.metadata } : {}),
        },
      });
    });
    return { info, parts };
  }

  listMessages(id: string, limit?: number): Promise<OcCallResult<unknown[]>> {
    return this.call(async (client, options) => {
      const response = await client.message.list({
        sessionID: id,
        ...(limit && limit > 0 ? { limit: Math.floor(limit) } : {}),
      }, options);
      // message.list 返回最新在前——归一化为时间正序：聊天流从上到下 = 从旧到新（TUI 同款）
      const messages = this.projectMessages(response.data);
      const createdOf = (m: { info: unknown }): number => {
        const info = (m.info || {}) as Record<string, any>;
        return Number(info.time?.created || 0);
      };
      messages.sort((a, b) => createdOf(a) - createdOf(b));
      return messages;
    });
  }

  getMessage(id: string, messageID: string): Promise<OcCallResult<{ info: unknown; parts: unknown[] }>> {
    return this.call(async (client, options) => {
      const message = await client.session.message.get({ sessionID: id, messageID }, options);
      return this.projectMessage(message as unknown as Record<string, unknown>);
    });
  }

  prompt(id: string, prompt: string, model?: { providerID: string; modelID: string }, agent?: string): Promise<OcCallResult<unknown>> {
    return this.truncate(this.call(async (client, options) => {
      if (model) {
        await client.session.switchModel({
          sessionID: id,
          model: { id: model.modelID, providerID: model.providerID },
        }, options);
      }
      if (agent) await client.session.switchAgent({ sessionID: id, agent }, options);
      return client.session.prompt({ sessionID: id, text: prompt }, options);
    }));
  }

  promptAsync(id: string, prompt: string, model?: { providerID: string; modelID: string }, agent?: string): Promise<OcCallResult<{ messageID?: string }>> {
    return this.call(async (client, options) => {
      if (model) {
        await client.session.switchModel({
          sessionID: id,
          model: { id: model.modelID, providerID: model.providerID },
        }, options);
      }
      if (agent) await client.session.switchAgent({ sessionID: id, agent }, options);
      const message = await client.session.prompt({ sessionID: id, text: prompt }, options);
      return { messageID: message.id };
    });
  }

  /** 即时切换会话执行模式（TUI 同款：选中即生效，不等下一次发送） */
  switchAgent(id: string, agent: string): Promise<OcCallResult<boolean>> {
    return this.callTrue((client, options) => client.session.switchAgent({ sessionID: id, agent }, options));
  }

  /** 即时切换会话模型 */
  switchModel(id: string, model: { providerID: string; modelID: string }): Promise<OcCallResult<boolean>> {
    return this.callTrue((client, options) => client.session.switchModel({
      sessionID: id,
      model: { id: model.modelID, providerID: model.providerID },
    }, options));
  }

  shell(id: string, command: string, _agent?: string): Promise<OcCallResult<unknown>> {
    return this.callTrue((client, options) => client.session.shell({ sessionID: id, command }, options));
  }

  revert(id: string, messageID: string): Promise<OcCallResult<boolean>> {
    return this.callTrue(async (client, options) => {
      await client.session.revert.stage({ sessionID: id, messageID }, options);
      await client.session.revert.commit({ sessionID: id }, options);
    });
  }

  unrevert(id: string): Promise<OcCallResult<boolean>> {
    return this.callTrue((client, options) => client.session.revert.clear({ sessionID: id }, options));
  }

  diff(id: string): Promise<OcCallResult<unknown[]>> {
    return this.truncate(this.call(async (client, options) => client.session.diff({ sessionID: id }, options) as unknown as unknown[]));
  }

  answerPermission(id: string, permissionID: string, response: 'once' | 'always' | 'reject'): Promise<OcCallResult<boolean>> {
    return this.callTrue((client, options) => client.permission.reply({
      sessionID: id,
      requestID: permissionID,
      decision: response,
    }, options));
  }

  replyForm(sessionID: string, formID: string, answer: Record<string, string | number | boolean | string[]>): Promise<OcCallResult<boolean>> {
    return this.callTrue((client, options) => client.session.form.reply({ sessionID, formID, answer }, options));
  }

  cancelForm(sessionID: string, formID: string): Promise<OcCallResult<boolean>> {
    return this.callTrue((client, options) => client.session.form.cancel({ sessionID, formID }, options));
  }

  /**
   * 回答 opencode 的提问。两种作答形态：
   * - `answer`（key-based，新）：Record<field.key, 值>——本端按 form schema 逐字段收口类型；
   * - `answers`（位置矩阵，旧）：按题序的 label 数组——兼容旧客户端。
   * 均先读 form 权威 schema（key/type/options），label 自动映射回 option value。
   */
  async answerQuestion(requestID: string, answers: string[][] | Record<string, unknown>): Promise<OcCallResult<boolean>> {
    try {
      const listed = await this.call((client, options) => client.form.list(undefined, options));
      if (!listed.ok || !listed.data) return { ok: false, error: listed.error || '读取 form 失败' };
      const form = (listed.data as { data: Array<{ id: string; sessionID: string }> }).data.find((item) => item.id === requestID);
      if (!form) return { ok: false, error: `未找到 form：${requestID}` };
      const detail = await this.call((client, options) => client.session.form.get({
        sessionID: form.sessionID,
        formID: form.id,
      }, options));
      if (!detail.ok || !detail.data) return { ok: false, error: detail.error || '读取 form 失败' };
      const fields = ((detail.data as { fields?: Array<{ key: string; type: string; options?: Array<{ value?: string; label?: string }> }> }).fields) || [];
      const answer: Record<string, unknown> = {};
      if (answers && !Array.isArray(answers)) {
        for (const field of fields) {
          if (!(field.key in answers)) continue;
          answer[field.key] = this.coerceFormAnswer(field, (answers as Record<string, unknown>)[field.key]);
        }
      } else {
        const flat = (answers as string[][]).flat();
        fields.forEach((field, index) => {
          const selected = answers[index]?.length ? answers[index] : flat[index] !== undefined ? [flat[index]] : [];
          answer[field.key] = this.coerceFormAnswer(field, selected);
        });
      }
      // coerceFormAnswer 已按字段类型收口，这里断言回 SDK 的 reply 值域
      return this.replyForm(form.sessionID, form.id, answer as Record<string, string | number | boolean | string[]>);
    } catch (error) {
      return { ok: false, error: this.errorText(error) };
    }
  }

  /** 按字段类型把 UI 值收口成 opencode form reply 的目标类型（label → option value 自动映射） */
  private coerceFormAnswer(
    field: { key: string; type: string; options?: Array<{ value?: string; label?: string }> },
    v: unknown,
  ): unknown {
    const opts = field.options || [];
    const toValue = (x: unknown): string => {
      const s = String(x ?? '');
      const hit = opts.find((o) => o.value === s || o.label === s);
      return hit ? String(hit.value ?? hit.label ?? s) : s;
    };
    switch (field.type) {
      case 'multiselect': {
        const arr = Array.isArray(v) ? v : v === undefined || v === null || v === '' ? [] : [v];
        return arr.map(toValue);
      }
      case 'boolean':
        return v === true || v === 'true' || v === 1 || v === '1';
      case 'number':
      case 'integer': {
        if (v === undefined || v === null || v === '') return '';
        const n = Number(v);
        return Number.isFinite(n) ? n : '';
      }
      case 'external':
        return v === true || v === 'true';
      default:
        return Array.isArray(v) ? toValue(v[0]) : toValue(v);
    }
  }

  async rejectQuestion(requestID: string): Promise<OcCallResult<boolean>> {
    try {
      const listed = await this.call((client, options) => client.form.list(undefined, options));
      if (!listed.ok || !listed.data) return { ok: false, error: listed.error || '读取 form 失败' };
      const form = (listed.data as { data: Array<{ id: string; sessionID: string }> }).data.find((item) => item.id === requestID);
      if (!form) return { ok: false, error: `未找到 form：${requestID}` };
      return this.cancelForm(form.sessionID, form.id);
    } catch (error) {
      return { ok: false, error: this.errorText(error) };
    }
  }

  appendPrompt(_text: string): Promise<OcCallResult<boolean>> {
    return Promise.resolve({ ok: false, error: UNSUPPORTED_ERROR });
  }

  submitPrompt(): Promise<OcCallResult<boolean>> {
    return Promise.resolve({ ok: false, error: UNSUPPORTED_ERROR });
  }

  clearPrompt(): Promise<OcCallResult<boolean>> {
    return Promise.resolve({ ok: false, error: UNSUPPORTED_ERROR });
  }

  showToast(_message: string, _variant: 'info' | 'success' | 'warning' | 'error' = 'info'): Promise<OcCallResult<boolean>> {
    return Promise.resolve({ ok: false, error: UNSUPPORTED_ERROR });
  }

  openSessions(): Promise<OcCallResult<boolean>> {
    return Promise.resolve({ ok: false, error: UNSUPPORTED_ERROR });
  }

  selectSession(_sessionId: string): Promise<OcCallResult<boolean>> {
    return Promise.resolve({ ok: false, error: UNSUPPORTED_ERROR });
  }

  listAgents(): Promise<OcCallResult<{ name: string; display?: string; description?: string; mode?: string }[]>> {
    return this.call(async (client, options) => {
      const response = await client.agent.list(undefined, options);
      // v2：id 才是执行名（switchAgent 只认小写 id），name 是显示名；hidden（title/summary/compaction）
      // 与 subagent（general/explore）不能做会话执行模式，不进选择列表。
      // 教训：曾把大写 name 传给 switchAgent——入队成功、执行时 AgentNotFoundError 静默吞消息。
      return ((response.data || []) as Array<{ id?: string; name?: string; description?: string; mode?: string; hidden?: boolean }>)
        .filter((agent) => agent.hidden !== true && agent.mode !== 'subagent' && Boolean(agent.id))
        .map((agent) => ({
          name: String(agent.id),
          ...(agent.name && agent.name !== agent.id ? { display: agent.name } : {}),
          ...(agent.description ? { description: agent.description } : {}),
          ...(agent.mode ? { mode: agent.mode } : {}),
        }));
    });
  }

  listModels(): Promise<OcCallResult<{ providerID: string; modelID: string; name: string }[]>> {
    return this.call(async (client, options) => {
      const response = await client.model.list(undefined, options);
      return (response.data as Array<{ providerID: string; modelID: string; name: string }>).map((model) => ({
        providerID: model.providerID,
        modelID: model.modelID,
        name: model.name,
      }));
    });
  }

  listProviders(): Promise<OcCallResult<{ providers?: unknown[]; default?: Record<string, string> }>> {
    return this.call(async (client, options) => {
      // v2 的 provider.list 不再内嵌 models（1.x 结构）——模型挪到了独立的 model.list 平铺端点；
      // 这里按 providerID 分组重建 `models: {modelID: {...}}`，保持双端下拉的既有消费结构
      const [providers, defaultModel, models] = await Promise.all([
        client.provider.list(undefined, options),
        client.model.default(undefined, options),
        client.model.list(undefined, options).catch(() => ({ data: [] as Array<{ providerID: string; modelID: string; name?: string }> })),
      ]);
      const grouped = new Map<string, Record<string, unknown>>();
      for (const m of (models.data || []) as Array<{ providerID: string; modelID: string; name?: string }>) {
        if (!m?.providerID || !m?.modelID) continue;
        const bucket = grouped.get(m.providerID) || {};
        bucket[m.modelID] = { name: m.name || m.modelID };
        grouped.set(m.providerID, bucket);
      }
      return {
        providers: ((providers.data || []) as Array<Record<string, unknown>>).map((p) => ({
          ...p,
          models: grouped.get(String(p.id)) || {},
        })),
        default: defaultModel.data ? { [defaultModel.data.providerID]: defaultModel.data.modelID } : {},
      };
    });
  }

  runCommand(id: string, command: string, args = '', _agent?: string): Promise<OcCallResult<unknown>> {
    return this.callTrue((client, options) => client.session.command({
      sessionID: id,
      name: command,
      text: args,
    }, options));
  }

  sessionTodos(_id: string): Promise<OcCallResult<{ content: string; status: string; priority: string }[]>> {
    return Promise.resolve({ ok: false, error: UNSUPPORTED_ERROR });
  }

  listPtys(): Promise<OcCallResult<{ id: string; title?: string; command?: string; status?: string }[]>> {
    return this.call(async (client, options) => {
      const response = await client.pty.list(undefined, options);
      return response.data;
    });
  }

  ptyConnectToken(ptyId: string): Promise<OcCallResult<{ ticket: string; expires_in: number }>> {
    return this.call(async (client, options) => {
      const response = await client.pty.connect.token({ ptyID: ptyId }, options);
      return response.data;
    });
  }

  currentProject(): Promise<OcCallResult<{ id?: string; worktree?: string }>> {
    return this.call(async (client, options) => {
      const location = await client.location.get(undefined, options);
      return { id: location.project.id, worktree: location.directory };
    });
  }

  async *eventStream(signal?: AbortSignal): AsyncGenerator<OcEvent> {
    try {
      const client = await this.clientPromise;
      for await (const event of client.event.subscribe({ signal })) {
        for (const projected of this.convertEvents(event)) yield projected;
      }
    } catch (error) {
      if (signal?.aborted) return;
      throw error;
    }
  }

  private eventEnvelope(event: OfficialEvent, type: string, properties: Record<string, unknown>): OcEvent {
    return {
      type,
      properties,
      id: event.id,
      location: event.location,
      raw: event,
    };
  }

  /** 一条官方事件 → 0..n 条 OcEvent。v2 事件流没有全量 message.updated：用户消息只能从 inbox.enqueued 自建，
   *  interrupted（shutdown 以外）要等价于 idle 结算，否则 run_task 的空闲等待会干等到超时。 */
  private convertEvents(event: OfficialEvent): OcEvent[] {
    const data = event.data && typeof event.data === 'object' ? event.data as Record<string, unknown> : {};
    const sid = String(data.sessionID || '');
    switch (event.type) {
      case 'session.inbox.enqueued': {
        const item = (data.item && typeof data.item === 'object' ? data.item : {}) as Record<string, any>;
        const inboxID = String(data.inboxID || '');
        const role = item.type === 'user' ? 'user' : item.type === 'synthetic' ? 'synthetic' : '';
        if (!sid || !inboxID || !role) return [];
        const payload = (item.payload && typeof item.payload === 'object' ? item.payload : {}) as Record<string, any>;
        return [
          this.eventEnvelope(event, 'message.updated', {
            sessionID: sid,
            info: { id: inboxID, sessionID: sid, role, time: { created: event.created } },
          }),
          this.eventEnvelope(event, 'message.part.updated', {
            sessionID: sid,
            part: { id: `${inboxID}:text`, messageID: inboxID, sessionID: sid, type: 'text', text: String(payload.text ?? '') },
          }),
        ];
      }
      case 'session.execution.interrupted':
        // shutdown 是 opencode 自身重启续跑：会话并未结束，不结算，重连后的权威快照说了算
        if (data.reason === 'shutdown') return [];
        return [this.eventEnvelope(event, 'session.idle', { sessionID: sid })];
      default: {
        const single = this.convertEvent(event);
        if (sid) {
          const props = (single.properties || {}) as Record<string, unknown>;
          if (!props.sessionID) {
            (single.properties ||= {}).sessionID = sid;
          }
        }
        return [single];
      }
    }
  }

  private convertEvent(event: OfficialEvent): OcEvent {
    if (!event) return { type: '' };
    const data = event.data && typeof event.data === 'object' ? event.data : {};
    const messageID = String(data.assistantMessageID || data.messageID || '');
    const ordinal = Number(data.ordinal || 0);
    const textPartId = `${messageID}:text:${ordinal}`;
    const reasoningPartId = `${messageID}:reasoning:${ordinal}`;
    const toolPartId = String(data.id || '');
    switch (event.type) {
      case 'session.text.started':
        return this.eventEnvelope(event, 'message.part.updated', {
          part: { id: textPartId, messageID, type: 'text', text: '' },
        });
      case 'session.text.delta':
        return this.eventEnvelope(event, 'message.part.delta', {
          messageID,
          partID: textPartId,
          field: 'text',
          delta: String(data.delta || ''),
        });
      case 'session.text.ended':
        return this.eventEnvelope(event, 'message.part.updated', {
          part: { id: textPartId, messageID, type: 'text', text: String(data.text || '') },
        });
      case 'session.reasoning.started':
        return this.eventEnvelope(event, 'message.part.updated', {
          part: { id: reasoningPartId, messageID, type: 'reasoning', text: '' },
        });
      case 'session.reasoning.delta':
        return this.eventEnvelope(event, 'message.part.delta', {
          messageID,
          partID: reasoningPartId,
          field: 'text',
          delta: String(data.delta || ''),
        });
      case 'session.reasoning.ended':
        return this.eventEnvelope(event, 'message.part.updated', {
          part: { id: reasoningPartId, messageID, type: 'reasoning', text: String(data.text || '') },
        });
      case 'session.tool.input.started':
        return this.eventEnvelope(event, 'message.part.updated', {
          part: { id: toolPartId, messageID, callID: toolPartId, type: 'tool', tool: String(data.name || 'tool'), state: { status: 'pending', input: {} } },
        });
      case 'session.tool.input.ended': {
        let input: unknown = data.text;
        try { input = JSON.parse(String(data.text || '{}')); } catch { input = { text: String(data.text || '') }; }
        return this.eventEnvelope(event, 'message.part.updated', {
          part: { id: toolPartId, messageID, callID: toolPartId, type: 'tool', tool: String(data.name || 'tool'), state: { status: 'pending', input } },
        });
      }
      case 'session.tool.called':
        return this.eventEnvelope(event, 'message.part.updated', {
          part: { id: toolPartId, messageID, callID: toolPartId, type: 'tool', tool: String(data.name || 'tool'), state: { status: 'running', input: data.input || {} } },
        });
      case 'session.tool.progress':
        return this.eventEnvelope(event, 'message.part.updated', {
          part: { id: toolPartId, messageID, callID: toolPartId, type: 'tool', tool: String(data.name || 'tool'), state: { status: 'running', metadata: data.metadata || {} } },
        });
      case 'session.tool.success':
        return this.eventEnvelope(event, 'message.part.updated', {
          part: { id: toolPartId, messageID, callID: toolPartId, type: 'tool', tool: String(data.name || 'tool'), state: { status: 'completed', output: data.content || '' } },
        });
      case 'session.tool.failed':
        return this.eventEnvelope(event, 'message.part.updated', {
          part: { id: toolPartId, messageID, callID: toolPartId, type: 'tool', tool: String(data.name || 'tool'), state: { status: 'error', error: data.error || '工具执行失败' } },
        });
      case 'session.execution.started':
        return this.eventEnvelope(event, 'session.status', {
          ...data,
          status: { type: 'busy' },
        });
      case 'session.execution.succeeded':
        return this.eventEnvelope(event, 'session.idle', data);
      case 'session.execution.failed':
        return this.eventEnvelope(event, 'session.error', {
          ...data,
          error: data.error || { message: 'OpenCode 会话执行失败' },
        });
      case 'session.step.started':
        return this.eventEnvelope(event, 'message.part.updated', {
          part: { id: `${messageID}:step-start`, messageID, type: 'step-start' },
        });
      case 'session.step.ended':
        return this.eventEnvelope(event, 'message.part.updated', {
          part: { id: `${messageID}:step-finish`, messageID, type: 'step-finish', finish: data.finish, cost: data.cost, tokens: data.tokens, files: data.files || [] },
        });
      case 'session.step.failed':
        return this.eventEnvelope(event, 'session.error', { ...data, error: data.error || {} });
      case 'session.synthetic': {
        const id = String(event.id || '');
        return this.eventEnvelope(event, 'message.updated', {
          info: { id, role: 'assistant', time: { created: event.created || Date.now() } },
          parts: [{ id: `${id}:text`, messageID: id, type: 'text', text: String(data.text || '') }],
        });
      }
      case 'session.message.content.updated': {
        const projected = this.projectMessage({ id: messageID, type: 'assistant', content: data.content || [] });
        return this.eventEnvelope(event, 'message.updated', projected);
      }
      case 'session.compaction.ended':
        return this.eventEnvelope(event, 'session.compacted', data);
      case 'form.created': {
        const form = data.form && typeof data.form === 'object' ? data.form as Record<string, unknown> : {};
        const fields = Array.isArray(form.fields) ? form.fields : [];
        return this.eventEnvelope(event, 'question.asked', {
          id: String(form.id || event.id),
          sessionID: String(form.sessionID || ''),
          title: form.title === undefined || form.title === null ? undefined : String(form.title),
          questions: fields.map((value) => {
            const field = value && typeof value === 'object' ? value as Record<string, unknown> : {};
            const rawOptions = Array.isArray(field.options) ? field.options : [];
            const rawType = String(field.type || 'string');
            const maxItems = Number(field.maxItems);
            // 归一化视图类型：string+options=单选，string=自由输入；其余类型直通
            const normType = rawType === 'multiselect' ? 'multiselect'
              : rawType === 'number' || rawType === 'integer' ? 'number'
              : rawType === 'boolean' ? 'boolean'
              : rawType === 'external' ? 'external'
              : rawOptions.length ? 'select' : 'input';
            const num = (v: unknown) => (Number.isFinite(Number(v)) ? Number(v) : undefined);
            const when = Array.isArray(field.when) ? field.when : [];
            return {
              key: String(field.key || ''),
              type: normType,
              question: String(field.question || field.title || field.description || field.key || ''),
              header: field.header === undefined ? undefined : String(field.header),
              description: field.description === undefined ? undefined : String(field.description),
              placeholder: field.placeholder === undefined ? undefined : String(field.placeholder),
              required: field.required === true,
              hidden: field.hidden === true,
              when: when.length ? (when as Record<string, unknown>[]).map((w) => ({
                key: String(w.key || ''),
                op: w.op === 'neq' ? 'neq' as const : 'eq' as const,
                value: w.value as string | number | boolean,
              })) : undefined,
              minimum: num(field.minimum),
              maximum: num(field.maximum),
              // multiselect 且未限定"只选 1 项"→ 视为多选；字段自带 custom（如"其他"自填）也算自定义入口
              multiple: normType === 'multiselect' && !(maxItems === 1),
              custom: field.custom === true,
              externalUrl: rawType === 'external' ? String(field.url || '') : undefined,
              options: rawOptions.map((option) => {
                const entry = option && typeof option === 'object' ? option as Record<string, unknown> : {};
                return {
                  value: String(entry.value ?? entry.label ?? ''),
                  label: String(entry.label || entry.value || ''),
                  description: entry.description === undefined ? undefined : String(entry.description),
                };
              }),
            };
          }),
        });
      }
      case 'form.replied':
      case 'form.cancelled':
        return this.eventEnvelope(event, event.type === 'form.replied' ? 'question.replied' : 'question.rejected', data);
      case 'session.idle':
      case 'session.status':
      case 'permission.asked':
      case 'permission.replied':
      case 'pty.created':
      case 'pty.updated':
      case 'pty.exited':
      case 'pty.deleted':
        return this.eventEnvelope(event, event.type, data);
      default:
        if (event.type.startsWith('session.')) return this.eventEnvelope(event, event.type, data);
        return this.eventEnvelope(event, event.type, data);
    }
  }
}

export async function probeOpencodeInstance(opts: OpencodeClientOptions): Promise<OcCapabilities> {
  return new OpencodeClient(opts).probe();
}
