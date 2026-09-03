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

export async function chat(entry: ModelEntry, messages: { role: string; content: string }[], maxTokens = 8192, temperature = 0): Promise<LlmResponse> {
  const client = getClient(entry);
  const completion = await client.chat.completions.create({
    model: entry.name,
    messages: messages as OpenAI.Chat.Completions.ChatCompletionMessageParam[],
    max_tokens: maxTokens,
    temperature,
  });
  const content = completion.choices[0]?.message?.content || '';
  const usage = completion.usage;
  let promptTokens = usage?.prompt_tokens ?? 0;
  let completionTokens = usage?.completion_tokens ?? 0;
  if (!promptTokens && !completionTokens) {
    completionTokens = Math.max(1, Math.floor(content.length / 4));
  }
  return { content, promptTokens, completionTokens };
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
  const match = content.match(/\{[\s\S]*\}/);
  try {
    return JSON.parse(match ? match[0] : content);
  } catch {
    return null;
  }
}
