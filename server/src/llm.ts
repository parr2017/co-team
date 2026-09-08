import OpenAI from 'openai';
import type { ModelEntry } from './scheduler';

export interface LlmResponse {
  content: string;
  promptTokens: number;
  completionTokens: number;
  /** finish_reason of the final chunk ('stop' | 'length' | ...) — E5: distinguishes
   *  "budget exhausted" (length + empty content) from a genuine format failure. */
  finishReason?: string | null;
}

const clientCache = new Map<string, OpenAI>();

/** Per-request LLM timeout. Override with COTEAM_LLM_TIMEOUT_MS; agent.yaml `timeout`
 *  (seconds) overrides it per agent — orchestrator call sites pass plugin.timeout. */
export const DEFAULT_LLM_TIMEOUT_MS = Number(process.env.COTEAM_LLM_TIMEOUT_MS || 0) || 600_000;

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
    client = new OpenAI({ apiKey: entry.api_key, baseURL: entry.base_url.replace(/\/+$/, ''), timeout: DEFAULT_LLM_TIMEOUT_MS, maxRetries: 0 });
    clientCache.set(key, client);
  }
  return client;
}

export async function chat(entry: ModelEntry, messages: { role: string; content: string }[], maxTokens?: number, temperature = 0, signal?: AbortSignal, timeoutMs?: number): Promise<LlmResponse> {
  const client = getClient(entry);
  // 输出上限是模型属性（model_pool 的 max_tokens），调用方不传即取模型配置
  const cap = maxTokens ?? entry.max_tokens ?? 128000;
  const timeout = timeoutMs && timeoutMs > 0 ? timeoutMs : DEFAULT_LLM_TIMEOUT_MS;
  // E10: SDK 的 timeout 只可靠覆盖到响应头——流已打开但上游静默时 body 消费会
  // 无限挂起（fdj1b4s0 实测挂 49min）。自己包一层 AbortSignal，保证挂死调用
  // 必然中止并把控制权交回模型 failover。
  const signals: AbortSignal[] = [AbortSignal.timeout(timeout)];
  if (signal) signals.push(signal);
  const effectiveSignal = signals.length > 1 ? AbortSignal.any(signals) : signals[0];
  if (STREAM_ENABLED) return chatStreamed(client, entry, messages, cap, temperature, effectiveSignal, timeout);
  return chatOnce(client, entry, messages, cap, temperature, effectiveSignal, timeout);
}

async function chatStreamed(client: OpenAI, entry: ModelEntry, messages: { role: string; content: string }[], maxTokens: number, temperature: number, signal?: AbortSignal, timeout?: number): Promise<LlmResponse> {
  const stream = await client.chat.completions.create(
    {
      model: entry.name,
      messages: messages as OpenAI.Chat.Completions.ChatCompletionMessageParam[],
      max_tokens: maxTokens,
      temperature,
      stream: true,
      stream_options: { include_usage: true },
    },
    { signal, timeout }
  );
  let content = '';
  let finishReason: string | null = null;
  let promptTokens = 0;
  let completionTokens = 0;
  for await (const chunk of stream) {
    const choice = chunk.choices?.[0];
    if (choice?.delta?.content) content += choice.delta.content;
    if (choice?.finish_reason) finishReason = choice.finish_reason;
    if (chunk.usage) {
      promptTokens = chunk.usage.prompt_tokens ?? 0;
      completionTokens = chunk.usage.completion_tokens ?? 0;
    }
  }
  if (!promptTokens && !completionTokens) {
    completionTokens = Math.max(1, Math.floor(content.length / 4));
  }
  // E10: the openai SDK ends iteration gracefully when the abort fires mid-body —
  // without this guard a timed-out stall would masquerade as a successful empty answer.
  if (signal?.aborted) throw new Error(`LLM 调用在 ${timeout}ms 超时后被中止（上游流停滞）`);
  return { content, promptTokens, completionTokens, finishReason };
}

async function chatOnce(client: OpenAI, entry: ModelEntry, messages: { role: string; content: string }[], maxTokens: number, temperature: number, signal?: AbortSignal, timeout?: number): Promise<LlmResponse> {
  const completion = await client.chat.completions.create(
    {
      model: entry.name,
      messages: messages as OpenAI.Chat.Completions.ChatCompletionMessageParam[],
      max_tokens: maxTokens,
      temperature,
    },
    { signal, timeout }
  );
  const content = completion.choices[0]?.message?.content || '';
  const usage = completion.usage;
  let promptTokens = usage?.prompt_tokens ?? 0;
  let completionTokens = usage?.completion_tokens ?? 0;
  if (!promptTokens && !completionTokens) {
    completionTokens = Math.max(1, Math.floor(content.length / 4));
  }
  if (signal?.aborted) throw new Error(`LLM 调用在 ${timeout}ms 超时后被中止`);
  return { content, promptTokens, completionTokens, finishReason: completion.choices[0]?.finish_reason ?? null };
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
