import OpenAI from 'openai';
import type { ModelEntry } from './scheduler';

export interface LlmResponse {
  content: string;
  promptTokens: number;
  completionTokens: number;
  /** finish_reason of the final chunk ('stop' | 'length' | ...) — E5: distinguishes
   *  "budget exhausted" (length + empty content) from a genuine format failure. */
  finishReason?: string | null;
  /** prefix-cache telemetry: usage.prompt_tokens_details.cached_tokens when the
   *  server reports it (vLLM APC / LM Studio prompt cache) — cache-hit observability */
  cachedTokens?: number;
  /** ms from request start to the first streamed chunk */
  firstTokenMs?: number;
  /** wall-clock duration of this LLM call */
  elapsedMs: number;
}

/**
 * 超时语义重做（2026-09-09，accountapp i6efv5h2 复盘）：
 * 时长本身永远不构成失败——只有三类确定性信号才中止：
 *  1. connection_died   连接/HTTP 错误、流无 finish_reason 提前结束（SDK 直接抛出或收尾检测）；
 *  2. stream_stalled    首 token 前 / token 间静默超线（任意 chunk 刷新计时，慢但活着永不杀）；
 *  3. wallclock_cap     可选保险丝，默认关闭。
 * 旧的 600s 总超时 AbortSignal 会把"正在正常生成的大上下文请求"整批绞杀
 * （本地 31B 模型 × 4 万 token prompt × 数万 token 思考 = 必超 600s），i6efv5h2 节点 6 即死于此。
 */
export interface LlmPolicy {
  /** 请求发出→首个 chunk 的静默上限（覆盖大 prompt prefill）；0=关闭 */
  firstTokenIdleMs: number;
  /** chunk 间静默上限；0=关闭 */
  streamIdleMs: number;
  /** 墙钟保险丝；0=关闭（默认） */
  wallclockCapMs: number;
  /** 非流式请求总上限（无进度信号，只能总时长兜底） */
  nonStreamTimeoutMs: number;
}

const secToMs = (v: unknown, dfltSec: number): number => {
  const n = Number(v);
  const sec = v === undefined || v === null || !Number.isFinite(n) || n < 0 ? dfltSec : n;
  return Math.round(sec * 1000);
};

let policy: LlmPolicy = {
  // env fallbacks keep the config-less test/CLI paths working
  firstTokenIdleMs: secToMs(process.env.COTEAM_LLM_FIRST_TOKEN_IDLE_SEC, 900),
  streamIdleMs: secToMs(process.env.COTEAM_LLM_STREAM_IDLE_SEC, 900),
  // 旧 COTEAM_LLM_TIMEOUT_MS 语义 = 总超时，向后兼容映射为墙钟保险丝
  wallclockCapMs: Number(process.env.COTEAM_LLM_WALLCLOCK_CAP_MS || process.env.COTEAM_LLM_TIMEOUT_MS || 0),
  nonStreamTimeoutMs: secToMs(process.env.COTEAM_LLM_NON_STREAM_TIMEOUT_SEC, 900),
};

/** Wire config.yaml `llm:` at server boot (and tiny values from tests). */
export function configureLlmTimeouts(t: {
  first_token_idle_sec?: number;
  stream_idle_sec?: number;
  wallclock_cap_sec?: number;
  non_stream_timeout_sec?: number;
}): void {
  if (t.first_token_idle_sec !== undefined) policy.firstTokenIdleMs = Math.max(0, t.first_token_idle_sec * 1000);
  if (t.stream_idle_sec !== undefined) policy.streamIdleMs = Math.max(0, t.stream_idle_sec * 1000);
  if (t.wallclock_cap_sec !== undefined) policy.wallclockCapMs = Math.max(0, t.wallclock_cap_sec * 1000);
  if (t.non_stream_timeout_sec !== undefined) policy.nonStreamTimeoutMs = Math.max(0, t.non_stream_timeout_sec * 1000);
}

export function getLlmPolicy(): LlmPolicy {
  return { ...policy };
}

const clientCache = new Map<string, OpenAI>();

/** 流洪水分型阈值：输出预算换算的字符上限（×40 为含 CJK 的极宽裕系数，下限 1M 字符） */
export function streamFloodChars(maxTokens: number): number {
  return Math.max(1_000_000, maxTokens * 40);
}

/** 字节级流护栏阈值：响应体原始字节总量上限（128MB——任何合法生成的百倍以上） */
const RAW_BODY_CAP_BYTES = 128 * 1024 * 1024;

/**
 * 字节级流护栏（2026-09-15 四连 OOM 复盘）：stream_flooded 只数 delta.content，
 * 但洪水可以藏在解析层看不见的地方——reasoning_content 疯狂推理、畸形 SSE 帧让
 * SDK 行缓冲无限囤积（一个 chunk 都不吐，idle watchdog 和 content 守卫全瞎）。
 * 在 fetch 层数原始字节，超限即掐断并抛 raw_body_flooded，上层换模兜底。
 */
async function byteCappedFetch(input: any, init?: any): Promise<Response> {
  const upstream = new AbortController();
  const outer: AbortSignal | undefined = init?.signal;
  const onAbort = () => upstream.abort(outer?.reason ?? new Error('LLM 调用被中止'));
  if (outer) {
    if (outer.aborted) onAbort();
    else outer.addEventListener('abort', onAbort, { once: true });
  }
  const res = await fetch(input, { ...init, signal: upstream.signal });
  if (!res.body) return res;
  let bytes = 0;
  const TS = (globalThis as any).TransformStream;
  const body = res.body.pipeThrough(new TS({
    transform(chunk: any, ctrl: any) {
      bytes += chunk?.byteLength ?? chunk?.length ?? 0;
      if (bytes > RAW_BODY_CAP_BYTES) {
        upstream.abort(new Error('raw_body_flooded'));
        ctrl.error(new Error(`LLM 调用失败：raw_body_flooded(响应体超过 ${Math.round(RAW_BODY_CAP_BYTES / 1e6)}MB 仍在增长——上游流故障，不是慢生成)`));
        return;
      }
      ctrl.enqueue(chunk);
    },
  }));
  return new Response(body, { status: res.status, statusText: res.statusText, headers: res.headers });
}

/** Streaming keeps bytes flowing so relay gateways (e.g. tokenrhythm's ALB) don't cut
 *  idle non-streaming connections at ~60s while a reasoning model thinks. Disable with
 *  COTEAM_LLM_STREAM=0 for upstreams that don't support SSE. */
const STREAM_ENABLED = process.env.COTEAM_LLM_STREAM !== '0';

function getClient(entry: ModelEntry): OpenAI {
  const key = `${entry.base_url}|${entry.api_key}`;
  let client = clientCache.get(key);
  if (!client) {
    // maxRetries: 0 — the SDK's built-in retries (2×10min) stack with our own model
    // failover and turn one 504 into a ~30min stall; orchestration retries instead.
    // timeout = 24h 哨兵值：SDK 的请求级计时器正是"时长=死刑"的旧语义，全部杀伐
    // 改由我们的 watchdog（idle/cap/connection）接管。注意 SDK 对 timeout: 0 的
    // 处理是"立即超时"而非"禁用"（llmTimeout 实测），所以用超大值等效禁用。
    client = new OpenAI({ apiKey: entry.api_key, baseURL: entry.base_url.replace(/\/+$/, ''), timeout: 86_400_000, maxRetries: 0, fetch: byteCappedFetch as any });
    clientCache.set(key, client);
  }
  return client;
}

/**
 * 模型池 UI 的服务发现：向 OpenAI 兼容端点拉一次 `GET /models`，
 * 返回该 base_url + api_key 下可用的模型 id 列表（升序、去重）。
 * 不进 clientCache——发现请求是一次性的，且超时策略与生成调用完全不同。
 */
export async function listUpstreamModels(apiKey: string, baseUrl: string): Promise<string[]> {
  const client = new OpenAI({ apiKey, baseURL: baseUrl.replace(/\/+$/, ''), timeout: 20_000, maxRetries: 0 });
  const res = await client.models.list();
  const names = new Set<string>();
  for (const m of res.data) if (m && typeof m.id === 'string' && m.id) names.add(m.id);
  return [...names].sort();
}

/**
 * `wallclockCapMs` (6th arg) overrides the cap for this call only. Note the semantic
 * change: agent.yaml `timeout` no longer flows in here — it became a node-level budget
 * enforced by the orchestrator between rounds.
 * `onDelta` (7th arg) receives raw content deltas as they arrive (streaming mode only;
 * the non-streaming path cannot report progress). Consumers must treat it as best-effort.
 */
export async function chat(entry: ModelEntry, messages: { role: string; content: string | unknown[] }[], maxTokens?: number, temperature = 0, signal?: AbortSignal, wallclockCapMs?: number, onDelta?: (delta: string) => void, opts?: { extraBody?: Record<string, unknown>; onReason?: (delta: string) => void }): Promise<LlmResponse> {
  const client = getClient(entry);
  // 输出上限是模型属性（model_pool 的 max_tokens），调用方不传即取模型配置
  const cap = maxTokens ?? entry.max_tokens ?? 128000;
  if (STREAM_ENABLED) return chatStreamed(client, entry, messages, cap, temperature, signal, wallclockCapMs, onDelta, opts?.extraBody, opts?.onReason);
  return chatOnce(client, entry, messages, cap, temperature, signal, wallclockCapMs, opts?.extraBody);
}

/** Abort the controller after `reason` fires; poll faster than coarse limits. */
function startWatchdog(
  controller: AbortController,
  opts: { startedAt: number; capMs: number; firstTokenIdleMs: number; streamIdleMs: number; state: { gotFirstChunk: boolean; lastActivity: number } },
  onFire: (reason: string) => void,
): NodeJS.Timeout {
  const { startedAt, capMs, firstTokenIdleMs, streamIdleMs, state } = opts;
  const limits = [capMs, firstTokenIdleMs, streamIdleMs].filter((x) => x > 0);
  const every = limits.length ? Math.max(25, Math.min(500, Math.floor(Math.min(...limits) / 4))) : 500;
  return setInterval(() => {
    const now = Date.now();
    if (capMs > 0 && now - startedAt > capMs) {
      onFire(`wallclock_cap(${Math.round((now - startedAt) / 1000)}s 总时长保险丝)`);
      controller.abort();
      return;
    }
    const limit = state.gotFirstChunk ? streamIdleMs : firstTokenIdleMs;
    if (limit > 0 && now - state.lastActivity > limit) {
      onFire(`stream_stalled(${state.gotFirstChunk ? 'token间' : '首token前'}静默${Math.round((now - state.lastActivity) / 1000)}s，无任何数据块)`);
      controller.abort();
    }
  }, every);
}

async function chatStreamed(client: OpenAI, entry: ModelEntry, messages: { role: string; content: string | unknown[] }[], maxTokens: number, temperature: number, externalSignal?: AbortSignal, wallclockCapMsOverride?: number, onDelta?: (delta: string) => void, extraBody?: Record<string, unknown>, onReason?: (delta: string) => void): Promise<LlmResponse> {
  const startedAt = Date.now();
  const controller = new AbortController();
  const effectiveSignal = externalSignal ? AbortSignal.any([controller.signal, externalSignal]) : controller.signal;
  const capMs = wallclockCapMsOverride !== undefined && wallclockCapMsOverride > 0 ? wallclockCapMsOverride : policy.wallclockCapMs;
  const state = { gotFirstChunk: false, lastActivity: startedAt };
  let abortReason = '';
  const watchdog = startWatchdog(controller, { startedAt, capMs, firstTokenIdleMs: policy.firstTokenIdleMs, streamIdleMs: policy.streamIdleMs, state }, (r) => { abortReason = r; });

  let content = '';
  let finishReason: string | null = null;
  let promptTokens = 0;
  let completionTokens = 0;
  let reasoningChars = 0;
  let sawContent = false;
  let cachedTokens: number | undefined;
  let firstTokenMs: number | undefined;
  try {
    (globalThis as any).__coteamProbes = { ...(globalThis as any).__coteamProbes, chatStart: { model: entry.name, max_tokens: maxTokens, at: Date.now() } };
    const stream = await client.chat.completions.create(
      {
        model: entry.name,
        messages: messages as OpenAI.Chat.Completions.ChatCompletionMessageParam[],
        max_tokens: maxTokens,
        temperature,
        stream: true,
        stream_options: { include_usage: true },
        // vLLM 扩展透传（如 enable_thinking:false 关闭 Qwen3 思考，E17）
        ...(entry.chat_template_kwargs ? { chat_template_kwargs: entry.chat_template_kwargs } : {}),
        // per-call 覆盖（o3xmkraj 复盘：E5 软重试降思考强度 reasoning_effort:low 等），
        // 后合并——调用方显式传入的优先于模型静态配置
        ...(extraBody ?? {}),
      } as OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming,
      { signal: effectiveSignal },
    );
    for await (const chunk of stream) {
      state.lastActivity = Date.now();
      if (!state.gotFirstChunk) {
        state.gotFirstChunk = true;
        firstTokenMs = Date.now() - startedAt;
      }
      const choice = chunk.choices?.[0];
      // 思考熔断（o3xmkraj 复盘）：聚合网关对推理通道常不受 max_tokens 约束（实测
      // 32000 档返回 38369 token 且正文空）——纯思考超当轮预算 1.5× 仍无正文时
      // 客户端主动止损，不再陪跑溢出尾巴（每轮省数分钟）。
      const rc = (choice?.delta as { reasoning_content?: unknown; reasoning?: unknown } | undefined)?.reasoning_content
        ?? (choice?.delta as { reasoning?: unknown } | undefined)?.reasoning;
      if (typeof rc === 'string' && rc) {
        reasoningChars += rc.length;
        // 思考流回调（协作会话展示"思考过程"用）：与 onDelta 同纪律——消费者异常绝不打断流
        if (onReason) {
          try { onReason(rc); } catch { /* ignore */ }
        }
      }
      if (!sawContent && reasoningChars / 4 > maxTokens * 1.5) {
        controller.abort(new Error('reasoning_burnout'));
        throw new Error(`LLM 调用失败：reasoning_burnout(纯思考已超 ${Math.round(maxTokens * 1.5)} token 仍无正文——客户端提前止损)`);
      }
      if (choice?.delta?.content) {
        content += choice.delta.content;
        sawContent = true;
        if (onDelta) {
          try { onDelta(choice.delta.content); } catch { /* delta consumers never break the stream */ }
        }
        // 流洪水分型（2026-09-15，两次 4GB OOM 复盘）：上游故障时可能无限灌垃圾 chunk，
        // "慢但活着"的 idle watchdog 拦不住它（chunk 一直在来）——content 无上限累积直到
        // 堆爆炸。合法回复永远到不了 max_tokens×40 字符（含 CJK 的宽裕换算），超线即判
        // 确定性死亡（与 connection_died 同族），由上层换模兜底。
        if (content.length > streamFloodChars(maxTokens)) {
          throw new Error(`LLM 调用失败：stream_flooded(流式响应超过 ${Math.round(streamFloodChars(maxTokens) / 1e6)}M 字符仍在增长——上游流故障，不是慢生成)`);
        }
      }
      if (choice?.finish_reason) finishReason = choice.finish_reason;
      if (chunk.usage) {
        promptTokens = chunk.usage.prompt_tokens ?? 0;
        completionTokens = chunk.usage.completion_tokens ?? 0;
        const cached = (chunk.usage as any).prompt_tokens_details?.cached_tokens;
        if (typeof cached === 'number') cachedTokens = cached;
      }
    }
  } catch (e: any) {
    // SDK surfaces an aborted stream as APIUserAbortError — translate it to OUR semantics
    if (abortReason) throw new Error(`LLM 调用被中止：${abortReason}`);
    if (externalSignal?.aborted) throw new Error('LLM 调用被外部取消（任务取消）');
    throw e;
  } finally {
    clearInterval(watchdog);
  }
  // SDK 对 mid-body abort 的处理是"优雅结束迭代"而非抛错——必须在这里补判定，
  // 否则被杀的流会伪装成一次成功的空回答（E10 时代实测教训，勿删）
  if (abortReason) throw new Error(`LLM 调用被中止：${abortReason}`);
  if (externalSignal?.aborted) throw new Error('LLM 调用被外部取消（任务取消）');
  if (!promptTokens && !completionTokens) {
    completionTokens = Math.max(1, Math.floor(content.length / 4));
  }
  // 确定性死亡：流正常收尾却既无 finish_reason 也无内容（上游半途断流的常见形态）
  if (!finishReason && !content.trim()) {
    throw new Error(`LLM 调用失败：connection_died(流未产出 finish_reason 即结束，且无内容)`);
  }
  return { content, promptTokens, completionTokens, finishReason, cachedTokens, firstTokenMs, elapsedMs: Date.now() - startedAt };
}

async function chatOnce(client: OpenAI, entry: ModelEntry, messages: { role: string; content: string | unknown[] }[], maxTokens: number, temperature: number, externalSignal?: AbortSignal, wallclockCapMsOverride?: number, extraBody?: Record<string, unknown>): Promise<LlmResponse> {
  const startedAt = Date.now();
  // 非流式没有进度信号可用——只能以总时长兜底（COTEAM_LLM_STREAM=0 的部署自担此限）
  const capMs = wallclockCapMsOverride !== undefined && wallclockCapMsOverride > 0 ? wallclockCapMsOverride : Math.max(policy.wallclockCapMs, 0) || policy.nonStreamTimeoutMs;
  const signals: AbortSignal[] = [];
  if (capMs > 0) signals.push(AbortSignal.timeout(capMs));
  if (externalSignal) signals.push(externalSignal);
  const signal = signals.length ? AbortSignal.any(signals) : undefined;
  let completion;
  try {
    completion = await client.chat.completions.create(
      {
        model: entry.name,
        messages: messages as OpenAI.Chat.Completions.ChatCompletionMessageParam[],
        max_tokens: maxTokens,
        temperature,
        ...(entry.chat_template_kwargs ? { chat_template_kwargs: entry.chat_template_kwargs } : {}),
        ...(extraBody ?? {}),
      } as OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming,
      { signal },
    );
  } catch (e: any) {
    if (signal?.aborted && !externalSignal?.aborted) {
      throw new Error(`LLM 调用被中止：non_stream_timeout(${Math.round(capMs / 1000)}s，非流式无进度信号)`);
    }
    throw e;
  }
  const content = completion.choices[0]?.message?.content || '';
  const usage = completion.usage;
  let promptTokens = usage?.prompt_tokens ?? 0;
  let completionTokens = usage?.completion_tokens ?? 0;
  if (!promptTokens && !completionTokens) {
    completionTokens = Math.max(1, Math.floor(content.length / 4));
  }
  const cached = (usage as any)?.prompt_tokens_details?.cached_tokens;
  return {
    content,
    promptTokens,
    completionTokens,
    finishReason: completion.choices[0]?.finish_reason ?? null,
    cachedTokens: typeof cached === 'number' ? cached : undefined,
    elapsedMs: Date.now() - startedAt,
  };
}

/**
 * 多模态旁路（vision side-call）：图片经 OpenAI 兼容的 content 分片数组
 * （{type:'image_url', image_url:{url:'data:...'}}）送入视觉模型，一次问答拿文字结论。
 * 只走非流式（工具级短调用，无 onDelta 消费者）；主对话 chat() 的纯文本契约不受影响。
 */
export async function chatVision(entry: ModelEntry, prompt: string, images: { base64: string; mediaType: string }[], opts?: { maxTokens?: number; temperature?: number }): Promise<LlmResponse> {
  const client = getClient(entry);
  const content: unknown[] = [{ type: 'text', text: prompt }];
  for (const img of images) {
    content.push({ type: 'image_url', image_url: { url: `data:${img.mediaType};base64,${img.base64}` } });
  }
  const messages = [{ role: 'user', content }] as { role: string; content: string | unknown[] }[];
  const cap = opts?.maxTokens ?? entry.max_tokens ?? 128000;
  return chatOnce(client, entry, messages, cap, opts?.temperature ?? 0, undefined, undefined);
}

/** Embed texts via the OpenAI-compatible /v1/embeddings endpoint (knowledge RAG). */
export async function embed(entry: ModelEntry, input: string[]): Promise<number[][]> {
  const client = getClient(entry);
  const res = await client.embeddings.create({ model: entry.name, input });
  return res.data
    .slice()
    .sort((a, b) => a.index - b.index)
    .map((d) => d.embedding as number[]);
}

/** Extract a JSON object from an LLM reply, tolerating markdown code fences. */
export function stripCodeFence(content: string): string {
  const trimmed = content.trim();
  if (trimmed.startsWith('```')) {
    return trimmed
      .split('\n')
      .filter((l) => !l.trim().startsWith('```'))
      .join('\n')
      .trim();
  }
  return trimmed;
}

export function extractJson(content: string): Record<string, any> | null {
  let text = content.trim();

  // 1. Strip markdown code fences (```json ... ``` or ``` ... ```)
  text = text.replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?```\s*$/i, '').trim();

  // 2. Try to find the outermost JSON object using brace-depth tracking
  //    This handles models that output explanation text before/after the JSON
  const startIdx = text.indexOf('{');
  if (startIdx !== -1) {
    let depth = 0;
    let inString = false;
    let escape = false;
    let endIdx = -1;
    for (let i = startIdx; i < text.length; i++) {
      const ch = text[i];
      if (escape) { escape = false; continue; }
      if (ch === '\\' && inString) { escape = true; continue; }
      if (ch === '"') { inString = !inString; continue; }
      if (inString) continue;
      if (ch === '{') depth++;
      else if (ch === '}') { depth--; if (depth === 0) { endIdx = i; break; } }
    }
    if (endIdx !== -1) {
      const candidate = text.slice(startIdx, endIdx + 1);
      try { return JSON.parse(candidate); } catch { /* fall through */ }
    }
  }

  // 3. Fallback: original regex approach
  const match = text.match(/\{[\s\S]*\}/);
  try {
    return JSON.parse(match ? match[0] : text);
  } catch {
    return null;
  }
}

/**
 * Recover tool-call intents from malformed output. Weak models sometimes emit
 * nested/unclosed tool_calls JSON (a new `{"tool_calls":[` started inside the
 * array instead of a plain `{"tool":...}` item), which no JSON parser accepts.
 * This pulls out every flat `{"tool":"..."}` fragment so the orchestrator can
 * still execute the intended calls instead of failing the round.
 */
export function salvageToolCalls(content: string): Record<string, any>[] {
  const calls: Record<string, any>[] = [];
  for (const m of content.matchAll(/\{[^{}]*"tool"\s*:\s*"[^"]+"[^{}]*\}/g)) {
    try {
      const obj = JSON.parse(m[0]);
      if (typeof obj.tool === 'string' && obj.tool) calls.push(obj);
    } catch {
      // fragment malformed beyond repair, skip it
    }
  }
  return calls;
}

/**
 * 工具调用形状归一化（2026-09-20「光回复不干活」复盘）：模型在 tool_calls 数组里漂移出
 * 多种形状——{"tool":"exec",...}、{"name":"exec",...}、OpenAI 函数调用风格
 * {"function":{"name":"exec","arguments":"{...}"}}。旧解析只认 tool 字段，其余形状被
 * 静默过滤，模型以为已调用工具、用户只看到口头回复。这里统一归一成 {tool, ...args}。
 */
export function normalizeToolCall(raw: unknown): Record<string, any> | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, any>;
  let name = typeof r.tool === 'string' && r.tool.trim() ? r.tool.trim()
    : typeof r.name === 'string' && r.name.trim() ? r.name.trim() : '';
  const args: Record<string, any> = { ...r };
  delete args.tool;
  delete args.name;
  delete args.id;
  delete args.type;
  // OpenAI 函数调用风格：参数在 function.arguments（JSON 字符串/对象）
  const fn = r.function;
  if (fn && typeof fn === 'object' && !Array.isArray(fn)) {
    if (typeof fn.name === 'string' && fn.name.trim() && !name) name = fn.name.trim();
    if (typeof fn.arguments === 'string' && fn.arguments.trim()) {
      try { Object.assign(args, JSON.parse(fn.arguments)); } catch { /* arguments 非法时保留平铺字段 */ }
    } else if (fn.arguments && typeof fn.arguments === 'object') {
      Object.assign(args, fn.arguments);
    }
    delete args.function;
  }
  // 顶层 arguments：字符串 = 漂移形态（合并后删）；对象 = 可能是 mcp__ 工具的参数袋
  // （discussion/convo 的 MCP 桥读 call.arguments），保留原键同时合并到顶层两不误。
  if (typeof args.arguments === 'string' && args.arguments.trim()) {
    try { Object.assign(args, JSON.parse(args.arguments)); } catch { /* 保留原样 */ }
    delete args.arguments;
  } else if (args.arguments && typeof args.arguments === 'object' && !Array.isArray(args.arguments)) {
    Object.assign(args, args.arguments);
  }
  if (!name) return null;
  return { tool: name, ...args };
}

/** 归一化一批 tool_calls（非法项跳过）；非数组输入返回空。 */
export function normalizeToolCalls(raw: unknown): Record<string, any>[] {
  if (!Array.isArray(raw)) return [];
  return raw.map(normalizeToolCall).filter((c): c is Record<string, any> => c !== null);
}
