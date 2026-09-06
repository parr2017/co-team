import OpenAI from 'openai';
import type { ModelEntry } from './scheduler';

export interface LlmResponse {
  content: string;
  promptTokens: number;
  completionTokens: number;
}

const clientCache = new Map<string, OpenAI>();

function getClient(entry: ModelEntry): OpenAI {
  const key = `${entry.base_url}|${entry.api_key}`;
  let client = clientCache.get(key);
  if (!client) {
    client = new OpenAI({ apiKey: entry.api_key, baseURL: entry.base_url.replace(/\/+$/, '') });
    clientCache.set(key, client);
  }
  return client;
}

export async function chat(entry: ModelEntry, messages: { role: string; content: string }[], maxTokens = 8192, temperature = 0, signal?: AbortSignal): Promise<LlmResponse> {
  const client = getClient(entry);
  const completion = await client.chat.completions.create(
    {
      model: entry.name,
      messages: messages as OpenAI.Chat.Completions.ChatCompletionMessageParam[],
      max_tokens: maxTokens,
      temperature,
    },
    { signal }
  );
  const content = completion.choices[0]?.message?.content || '';
  const usage = completion.usage;
  let promptTokens = usage?.prompt_tokens ?? 0;
  let completionTokens = usage?.completion_tokens ?? 0;
  if (!promptTokens && !completionTokens) {
    completionTokens = Math.max(1, Math.floor(content.length / 4));
  }
  return { content, promptTokens, completionTokens };
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
