/**
 * chatStructured 结构化输出助手（2026-09-23 架构迁移）：
 * - 原生 FC：强制 tool_choice → 从供应商 tool_calls[0].arguments 拿结构化结果
 * - 模型忽略强制（仍写正文）→ extractJson(content) 兜底
 * - 供应商不支持强制 tool_choice（报错）→ 降级 auto 重试一次
 * - native_tools=false → 纯 JSON 文本契约
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';

const chatCalls: { messages: unknown[]; opts?: { tools?: unknown[]; toolChoice?: unknown } }[] = [];
let script: (() => any)[] = [];

vi.mock('../src/llm', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/llm')>();
  return {
    ...actual,
    chat: async (_entry: any, messages: unknown[], _mt?: number, _temp?: number, _signal?: any, _cap?: number, _onDelta?: any, opts?: { tools?: unknown[]; toolChoice?: unknown }) => {
      chatCalls.push({ messages, opts });
      const fn = script.shift()!;
      return fn();
    },
  };
});

import { chatStructured, type StructuredSchema } from '../src/structured';
import { configureNativeTools } from '../src/toolSchema';

const entry = { id: 'm1', name: 'm1' } as any;
const msgs = [{ role: 'user', content: 'hi' }];
const schema: StructuredSchema = { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'], additionalProperties: false };

describe('chatStructured', () => {
  beforeEach(() => {
    configureNativeTools(true);
    chatCalls.length = 0;
    script = [];
  });

  it('原生 FC：从 toolCalls[0] 取结构化参数（含 tool 名剔除）', async () => {
    script = [() => ({ content: '', toolCalls: [{ tool: 'assess_requirement', ok: true, questions: ['q1'] }], promptTokens: 5, completionTokens: 7, finishReason: 'tool_calls' })];
    const { parsed } = await chatStructured(entry, msgs, { toolName: 'assess_requirement', schema });
    expect(parsed).toEqual({ ok: true, questions: ['q1'] });
    // 强制 tool_choice 指向该工具
    expect((chatCalls[0].opts?.toolChoice as any)?.function?.name).toBe('assess_requirement');
  });

  it('模型忽略强制（正文 JSON）→ extractJson 兜底', async () => {
    script = [() => ({ content: JSON.stringify({ ok: true }), promptTokens: 5, completionTokens: 7, finishReason: 'stop' })];
    const { parsed } = await chatStructured(entry, msgs, { toolName: 'assess_requirement', schema });
    expect(parsed).toEqual({ ok: true });
  });

  it('强制 tool_choice 报错 → 降级 auto 重试一次并成功', async () => {
    script = [
      () => { throw new Error('invalid tool_choice'); },
      () => ({ content: '', toolCalls: [{ tool: 'assess_requirement', ok: true }], promptTokens: 5, completionTokens: 7, finishReason: 'tool_calls' }),
    ];
    const { parsed } = await chatStructured(entry, msgs, { toolName: 'assess_requirement', schema });
    expect(parsed).toEqual({ ok: true });
    expect(chatCalls).toHaveLength(2);
    expect((chatCalls[1].opts?.toolChoice as any)).toBe('auto');
  });

  it('强制报错 + auto 也失败 → 异常上抛（调用方自行回退）', async () => {
    script = [
      () => { throw new Error('invalid tool_choice'); },
      () => { throw new Error('upstream 500'); },
    ];
    await expect(chatStructured(entry, msgs, { toolName: 'assess_requirement', schema })).rejects.toThrow('upstream 500');
  });

  it('native_tools=false → 纯 JSON 文本契约，不传 tools', async () => {
    configureNativeTools(false);
    script = [() => ({ content: JSON.stringify({ ok: true }), promptTokens: 5, completionTokens: 7, finishReason: 'stop' })];
    const { parsed } = await chatStructured(entry, msgs, { toolName: 'assess_requirement', schema });
    expect(parsed).toEqual({ ok: true });
    expect(chatCalls[0].opts?.tools ?? []).toHaveLength(0);
  });
});
