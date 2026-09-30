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
/** 工具调用上下文的跟踪上限（LRU 淘汰；单实例长跑数周也不涨内存） */
const TOOL_CALL_TRACK_MAX = 1024;
/** oc 对已定局表单（他端已答/已取消）的报错形态——实测 "Form already settled: <formID>" */
const FORM_SETTLED_RE = /already settled|form not found|not found.*form|表单已/i;

type OfficialClient = any;
type RequestOptions = { signal?: AbortSignal };
type OfficialEvent = { id: string; type: string; created?: number; location?: unknown; data: Record<string, unknown> };
type OpenCodeFactory = { make(options: { baseUrl: string; headers: Record<string, string> }): OfficialClient };

const loadOpenCode = require('./officialClientLoader.cjs') as () => Promise<{ OpenCode: OpenCodeFactory }>;

/**
 * Form.Info / form.created 事件的 form 载荷 → question.asked 归一结构（提问卡渲染契约）。
 * 事件流（convertEvents）与权威对账回填（manager.reconcilePending 的 form.list 结果）
 * 共用同一份归一化——两处形状必须一致，否则补漏回来的卡渲染走样。
 */
export function formInfoToQuestionPayload(formInput: unknown): Record<string, unknown> {
  const form = formInput && typeof formInput === 'object' ? formInput as Record<string, unknown> : {};
  const fields = Array.isArray(form.fields) ? form.fields : [];
  return {
    id: String(form.id || ''),
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
  };
}

function versionParts(version: string): { major: number; minor: number; patch: number } | undefined {
  const match = /^[v=\s]*(\d+)\.(\d+)\.(\d+)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?\s*$/.exec(version);
  if (!match) return undefined;
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) };
}

function isSupportedVersion(version: string): boolean {
  // 放宽为“主版本 2 即支持”（desktop 2.0.11 实测全功能正常——提问/审批/事件/完成推送全通）；
  // MIN_VERSION 仍保留作为 SDK 依赖锚点，但不再逐位比较 minor/patch
  const parts = versionParts(version);
  return !!parts && parts.major === MIN_VERSION.major;
}

export class OpencodeClient {
  readonly baseUrl: string;
  private readonly clientPromise: Promise<OfficialClient>;
  private readonly authUsername: string;
  private readonly password?: string;
  private readonly timeoutMs: number;
  private readonly maxResultChars: number;
  /** session.tool.* 事件只有 input.started 带 name（2.x schema），后续事件一律不带——
   *  按 callID 记住工具名与最近一次 input，后续事件合成 part 时补齐；
   *  否则补出来的是 tool:"tool" 贫信息分片，message.part.updated 会把它顶进消息缓存，
   *  盖掉上游富信息分片（前端工具卡只剩 "tool" 标题、没有输入框内容）。 */
  private toolCalls = new Map<string, { name: string; input?: unknown }>();

  constructor(opts: OpencodeClientOptions) {
    this.baseUrl = new URL(opts.baseUrl).origin;
    this.authUsername = opts.auth?.username || 'opencode';
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

  /**
   * 直连 GET（绕过官方生成客户端）。location 定界查询必须用 `?location[directory]=…` 的 bracket
   * 形式（2.0.16 实测：JSON 串/点号形式服务端都按 "Expected object" 拒收）——生成客户端对 query
   * 对象的编码方式不可控，定界查询一律走这条实测过的直连封装。
   */
  private async rawGetJson(pathQuery: string): Promise<OcCallResult<unknown>> {
    try {
      const headers: Record<string, string> = {};
      if (this.password) headers.authorization = `Basic ${Buffer.from(`${this.authUsername}:${this.password}`).toString('base64')}`;
      const r = await fetch(`${this.baseUrl}${pathQuery}`, { headers, signal: AbortSignal.timeout(this.timeoutMs) });
      if (!r.ok) return { ok: false, error: `HTTP ${r.status}: ${pathQuery.split('?')[0]}` };
      return { ok: true, data: await r.json() };
    } catch (error) {
      return { ok: false, error: this.errorText(error) };
    }
  }

  /**
   * 权威 pending 列表跨目录合并（对账用）：form.list / permission.request.list 都按 location 定界，
   * 不带 location 只查 serve 默认目录（桌面版实测是 HOME——跨项目表单/权限全部不可见）。
   * 所以把候选目录逐个 scope 查一遍合并；只要有任一 scope 没查成功就整体 ok:false——
   * 漏扫的 scope 里可能还有活条目，调用方（对账）绝不能据不完整扫描清理本地表。
   */
  private async listScopedMerged(path: string, directories?: string[]): Promise<OcCallResult<Record<string, any>[]>> {
    const scopes: Array<string | undefined> = [...new Set((directories || []).filter(Boolean)), undefined];
    const results = await Promise.all(scopes.map((d) => this.rawGetJson(path + (d ? `?location%5Bdirectory%5D=${encodeURIComponent(d)}` : ''))));
    const failed = results.find((r) => !r.ok);
    if (failed) return { ok: false, error: failed.error };
    const merged: Record<string, any>[] = [];
    const seen = new Set<string>();
    for (const r of results) {
      for (const item of ((r.data as { data?: Record<string, any>[] })?.data || [])) {
        const id = String(item?.id || '');
        if (!id || seen.has(id)) continue;
        seen.add(id);
        merged.push(item);
      }
    }
    return { ok: true, data: merged };
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
        error: `OpenCode 版本不兼容：需要主版本为 2，实际为 ${version || 'unknown'}`,
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
  /**
   * 回答 opencode 的提问。两种作答形态：
   * - `answer`（key-based，新）：Record<field.key, 值>——本端按 form schema 逐字段收口类型；
   * - `answers`（位置矩阵，旧）：按题序的 label 数组——兼容旧客户端。
   * 均先读 form 权威 schema（key/type/options），label 自动映射回 option value。
   *
   * form.list 按 location 定界（2.0.16 实测：无 location 只查 serve 默认目录，桌面版是 HOME——
   * 跨项目会话的表单永远查不到，"回答了没反应"的根因）。所以按候选目录逐个 scope 找表单
   * （opts.directories=该实例会话目录全集，hint 会话目录排最前），全部 scope 都查成功且没有，
   * 才视为已定局（settled——他端已答/已取消，调用端撤卡）；探针失败 ≠ 已定局，返回 ok:false。
   */
  async answerQuestion(requestID: string, answers: string[][] | Record<string, unknown>, opts?: { directories?: string[] }): Promise<OcCallResult<boolean>> {
    try {
      const form = await this.locateForm(requestID, opts?.directories);
      if (!form.ok) return { ok: false, error: form.error || '读取 form 失败' };
      if (!form.form) return { ok: true, data: false, settled: true };
      const detail = await this.call((client, options) => client.session.form.get({
        sessionID: form.form!.sessionID,
        formID: form.form!.id,
      }, options));
      if (!detail.ok || !detail.data) return { ok: false, error: detail.error || '读取 form 失败' };
      // 实测 2.0.16：form.get 响应体带 {data:{...}} 信封（form.list 同款）——不拆包 fields 永远
      // 读不到，coerce 变空转，提交给 oc 的是空答案（"回答了没反应"的第二个根因）
      const detailBody = ((detail.data as { data?: unknown })?.data ?? detail.data) as { fields?: Array<{ key: string; type: string; options?: Array<{ value?: string; label?: string }> }> };
      const fields = detailBody.fields || [];
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
      const replied = await this.replyForm(form.form!.sessionID, form.form!.id, answer as Record<string, string | number | boolean | string[]>);
      // 已被处理过的表单（他端已答/已取消）不该让作答人吃 400：归一为 settled，让调用端撤卡
      if (!replied.ok && FORM_SETTLED_RE.test(replied.error || '')) return { ok: true, data: false, settled: true };
      return replied;
    } catch (error) {
      return { ok: false, error: this.errorText(error) };
    }
  }

  /**
   * 跨目录定位表单：候选 scope 顺序 = hint 目录（opts 排他优先由调用方排好）→ 其余目录 → 默认 scope。
   * 返回三态：found（form.form 存在）/ 全 scope 都查成功且无此表（form.form=undefined → 已定局）/
   * 任一 scope 探针失败（ok:false → 状态未知，调用方不得当 settled——漏扫的 scope 里可能有活表单）。
   */
  private async locateForm(requestID: string, directories?: string[]): Promise<{ ok: boolean; error?: string; form?: { id: string; sessionID: string } }> {
    const scopes: Array<string | undefined> = [...new Set((directories || []).filter(Boolean)), undefined];
    let probeError = '';
    let probesOk = 0;
    for (const dir of scopes) {
      const listed = await this.rawGetJson('/api/form' + (dir ? `?location%5Bdirectory%5D=${encodeURIComponent(dir)}` : ''));
      if (!listed.ok) { probeError = probeError || listed.error || ''; continue; }
      probesOk += 1;
      const hit = (((listed.data as { data?: Array<{ id: string; sessionID: string }> })?.data) || []).find((item) => item.id === requestID);
      if (hit) return { ok: true, form: hit };
    }
    if (probesOk < scopes.length) return { ok: false, error: probeError || '读取 form 失败（部分目录探针失败）' };
    return { ok: true };
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

  async rejectQuestion(requestID: string, opts?: { directories?: string[] }): Promise<OcCallResult<boolean>> {
    try {
      const form = await this.locateForm(requestID, opts?.directories);
      if (!form.ok) return { ok: false, error: form.error || '读取 form 失败' };
      if (!form.form) return { ok: true, data: false, settled: true };
      const cancelled = await this.cancelForm(form.form!.sessionID, form.form!.id);
      if (!cancelled.ok && FORM_SETTLED_RE.test(cancelled.error || '')) return { ok: true, data: false, settled: true };
      return cancelled;
    } catch (error) {
      return { ok: false, error: this.errorText(error) };
    }
  }

  /**
   * oc 侧权威 pending 提问列表（form.list）：还在等人作答的表单。
   * 服务端 pending 聚合态只由 SSE 事件驱动（asked 入队/replied 出队），断流死窗丢一次
   * replied 事件条目就永久滞留——对账以这里为准收敛（已回答/已取消的不再出现在飞书）。
   * form.list 按 location 定界（不带 location 只查 serve 默认目录），所以必须传全量候选目录。
   */
  listPendingForms(directories?: string[]): Promise<OcCallResult<Record<string, any>[]>> {
    return this.listScopedMerged('/api/form', directories);
  }

  /** oc 侧权威 pending 权限申请列表（permission.request.list，同样按 location 定界）。 */
  listPendingPermissions(directories?: string[]): Promise<OcCallResult<Record<string, any>[]>> {
    return this.listScopedMerged('/api/permission/request', directories);
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

  listAgents(location?: string): Promise<OcCallResult<{ name: string; display?: string; description?: string; mode?: string }[]>> {
    return this.call(async (client, options) => {
      const response = await client.agent.list(location ? { location } : undefined, options);
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

  /** 记录（或补齐）一次工具调用的上下文；后续事件靠它补 name/input */
  private rememberToolCall(callID: string, name?: string): { name: string; input?: unknown } {
    let record = this.toolCalls.get(callID);
    if (!record) {
      record = { name: name || 'tool' };
      this.toolCalls.set(callID, record);
      while (this.toolCalls.size > TOOL_CALL_TRACK_MAX) {
        const oldest = this.toolCalls.keys().next().value;
        if (oldest === undefined) break;
        this.toolCalls.delete(oldest);
      }
    } else if (name && record.name !== name) {
      record.name = name;
    }
    return record;
  }

  /** session.tool.* 事件 → message.part.updated 的 tool part：工具名/输入/时间全链路携带 */
  private toolPart(
    partID: string,
    messageID: string,
    record: { name: string; input?: unknown },
    event: OfficialEvent,
    state: Record<string, unknown>,
    completed = false,
  ): Record<string, unknown> {
    const created = Number(event.created || 0) || undefined;
    return {
      id: partID,
      messageID,
      callID: partID,
      type: 'tool',
      tool: record.name,
      ...(created ? { time: { created, ...(completed ? { completed: created } : {}) } } : {}),
      state,
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
      case 'session.tool.input.started': {
        const record = this.rememberToolCall(toolPartId, String(data.name || 'tool'));
        return this.eventEnvelope(event, 'message.part.updated', {
          part: this.toolPart(toolPartId, messageID, record, event, { status: 'pending', input: {} }),
        });
      }
      case 'session.tool.input.ended': {
        const record = this.rememberToolCall(toolPartId);
        let input: unknown = data.text;
        try { input = JSON.parse(String(data.text || '{}')); } catch { input = { text: String(data.text || '') }; }
        if (input && typeof input === 'object') record.input = input;
        return this.eventEnvelope(event, 'message.part.updated', {
          part: this.toolPart(toolPartId, messageID, record, event, { status: 'pending', input }),
        });
      }
      case 'session.tool.called': {
        const record = this.rememberToolCall(toolPartId);
        if (data.input && typeof data.input === 'object') record.input = data.input;
        return this.eventEnvelope(event, 'message.part.updated', {
          part: this.toolPart(toolPartId, messageID, record, event, { status: 'running', input: record.input ?? {} }),
        });
      }
      case 'session.tool.progress': {
        const record = this.rememberToolCall(toolPartId);
        const state: Record<string, unknown> = { status: 'running', input: record.input ?? {} };
        if (data.metadata && typeof data.metadata === 'object') state.metadata = data.metadata;
        return this.eventEnvelope(event, 'message.part.updated', {
          part: this.toolPart(toolPartId, messageID, record, event, state),
        });
      }
      case 'session.tool.success': {
        const record = this.rememberToolCall(toolPartId);
        const state: Record<string, unknown> = { status: 'completed', input: record.input ?? {}, output: data.content || '' };
        if (data.metadata && typeof data.metadata === 'object') state.metadata = data.metadata;
        return this.eventEnvelope(event, 'message.part.updated', {
          part: this.toolPart(toolPartId, messageID, record, event, state, true),
        });
      }
      case 'session.tool.failed': {
        const record = this.rememberToolCall(toolPartId);
        const rawError = data.error;
        const error = typeof rawError === 'string'
          ? rawError
          : String((rawError as { message?: unknown; name?: unknown } | undefined)?.message || (rawError as { name?: unknown } | undefined)?.name || '工具执行失败');
        return this.eventEnvelope(event, 'message.part.updated', {
          part: this.toolPart(toolPartId, messageID, record, event, { status: 'error', input: record.input ?? {}, error }, true),
        });
      }
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
        const payload = formInfoToQuestionPayload(form);
        if (!payload.id) payload.id = String(event.id || '');
        return this.eventEnvelope(event, 'question.asked', payload);
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
