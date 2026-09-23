/**
 * 结构化输出助手（原生 function calling 捕获）。
 *
 * 把「单次 LLM 调用要一个 JSON 结构」的调用点从 JSON 文本契约迁到原生工具通道：
 * 声明一个语义化捕获工具（如 plan_task / assess_requirement），强制 tool_choice 指向它，
 * 从供应商 tool_calls[0].arguments 拿回结构化结果——arguments 由供应商保证是合法 JSON，
 * 消灭「模型没按 JSON 输出 → extractJson 失败 → 静默回退」的脆弱路径。
 *
 * 宽容兜底（与 convo/discussion 同款纪律）：
 * - 模型忽略强制 tool_choice（仍写正文）→ extractJson(content) 兜底；
 * - 供应商不支持强制 tool_choice（报错）→ 降级 tool_choice:'auto' 重试一次；
 * - native_tools=false（旧配置）→ 整体回退纯 JSON 文本契约。
 *
 * 不吞异常：chat() 抛错（确定性故障/容量）原样上抛，由调用方既有 try/catch 处理
 * （换模、退避、回退都留在调用侧，这里只管解析形态）。
 */
import { chat, extractJson, stripCodeFence } from './llm';
import type { LlmResponse, LlmToolChoice, LlmToolSpec } from './llm';
import { nativeToolsOn } from './toolSchema';
import type { ModelEntry } from './scheduler';

/** JSON Schema 精简描述（兼容 OpenAI parameters 字段）。 */
export interface StructuredSchema {
  type: 'object';
  properties: Record<string, unknown>;
  required?: string[];
  additionalProperties?: boolean;
  [k: string]: unknown;
}

export interface ChatStructuredOpts {
  /** 捕获工具名（语义化，如 plan_task）；arguments 即结构化结果 */
  toolName: string;
  /** 工具描述（一段话说明要输出什么） */
  description?: string;
  /** 输出 JSON schema（parameters） */
  schema: StructuredSchema;
  maxTokens?: number;
  temperature?: number;
  /** 供应商不支持强制 tool_choice 时，传 true 直接走 auto（不重试） */
  allowAutoFallback?: boolean;
}

export interface ChatStructuredResult {
  parsed: Record<string, any> | null;
  resp: LlmResponse;
}

/** 把模型响应解析为结构化对象：优先 tool_calls[0].arguments，正文 JSON 兜底。 */
function parseStructured(resp: LlmResponse): Record<string, any> | null {
  if (resp.toolCalls?.length) {
    const args = resp.toolCalls[0];
    if (args && typeof args === 'object') {
      const { tool: _t, ...rest } = args as Record<string, any>;
      if (rest && Object.keys(rest).length) return rest;
    }
  }
  return extractJson(stripCodeFence(resp.content));
}

/** 结构化输出调用。返回 { parsed, resp }；解析失败 parsed=null（调用方走既有回退）。 */
export async function chatStructured(
  entry: ModelEntry,
  messages: { role: string; content: string | unknown[] }[],
  opts: ChatStructuredOpts,
): Promise<ChatStructuredResult> {
  if (!nativeToolsOn()) {
    // 旧配置：纯 JSON 文本契约（历史上各调用点皆如此，兼容不破坏）
    const resp = await chat(entry, messages, opts.maxTokens, opts.temperature ?? 0);
    return { parsed: extractJson(stripCodeFence(resp.content)), resp };
  }

  const tool: LlmToolSpec = {
    type: 'function',
    function: { name: opts.toolName, description: opts.description ?? '输出结构化结果', parameters: opts.schema },
  };
  const forced: LlmToolChoice = { type: 'function', function: { name: opts.toolName } };

  try {
    const resp = await chat(entry, messages, opts.maxTokens, opts.temperature ?? 0, undefined, undefined, undefined, { tools: [tool], toolChoice: forced });
    return { parsed: parseStructured(resp), resp };
  } catch (forcedErr) {
    // 供应商不支持强制 tool_choice：降级 auto 重试一次（宽容，不吞异常——仍失败就上抛）
    if (opts.allowAutoFallback === false) throw forcedErr;
    const resp = await chat(entry, messages, opts.maxTokens, opts.temperature ?? 0, undefined, undefined, undefined, { tools: [tool], toolChoice: 'auto' });
    return { parsed: parseStructured(resp), resp };
  }
}
