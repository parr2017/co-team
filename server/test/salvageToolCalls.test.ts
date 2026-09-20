import { describe, it, expect } from 'vitest';
import { extractJson, salvageToolCalls, normalizeToolCalls } from '../src/llm';

describe('salvageToolCalls', () => {
  it('recovers tool fragments from nested/unclosed tool_calls JSON', () => {
    const bad =
      '{"tool_calls":[{"tool":"read_file","path":"agents/dev/agent.yaml"},{"tool_calls":[{"tool":"read_file","path":"agents/deploy/handler.js"},{"tool_calls":';
    const calls = salvageToolCalls(bad);
    expect(calls).toHaveLength(2);
    expect(calls[0]).toEqual({ tool: 'read_file', path: 'agents/dev/agent.yaml' });
    expect(calls[1]).toEqual({ tool: 'read_file', path: 'agents/deploy/handler.js' });
  });

  it('extractJson cannot parse the malformed sample (salvage is the recovery path)', () => {
    const bad = '{"tool_calls":[{"tool":"read_file","path":"a"},{"tool_calls":';
    expect(extractJson(bad)).toBeNull();
  });

  it('returns empty array for final-result JSON without tool calls', () => {
    expect(salvageToolCalls('{"status":"success","summary":"done","files":[]}')).toEqual([]);
  });

  it('returns empty array for plain prose', () => {
    expect(salvageToolCalls('我完成了分析，结论如下……')).toEqual([]);
  });
});

describe('normalizeToolCalls（「光回复不干活」根因修复）', () => {
  it('OpenAI 函数调用风格 {"function":{"name","arguments"}} 归一为 {tool,...args}', () => {
    const raw = [
      { id: 'call_1', type: 'function', function: { name: 'read_file', arguments: '{"path":"a.ts"}' } },
    ];
    const calls = normalizeToolCalls(raw);
    expect(calls).toEqual([{ tool: 'read_file', path: 'a.ts' }]);
  });

  it('{"name":...} 平铺风格归一（arguments 为字符串合并并删键；对象合并且保留原键兼容 mcp 参数袋）', () => {
    expect(normalizeToolCalls([{ name: 'exec', arguments: '{"command":"ls"}' }]))
      .toEqual([{ tool: 'exec', command: 'ls' }]);
    // 对象形态：mcp__ 工具的参数袋就是 call.arguments，必须保留原键
    const mcp = normalizeToolCalls([{ tool: 'mcp__fs__read', arguments: { path: 'a' } }])[0];
    expect(mcp.tool).toBe('mcp__fs__read');
    expect(mcp.arguments).toEqual({ path: 'a' }); // 原键保留
    expect(mcp.path).toBe('a'); // 同时合并到顶层
  });

  it('标准 {"tool":...} 原样保留（多余 id/type 清掉）', () => {
    expect(normalizeToolCalls([{ tool: 'grep', pattern: 'x', id: 'c1', type: 'function' }]))
      .toEqual([{ tool: 'grep', pattern: 'x' }]);
  });

  it('无名称项（缺 tool/name/function.name）跳过，不炸整批', () => {
    expect(normalizeToolCalls([{ path: 'x' }, null, 'str', { tool: 'ls' }]))
      .toEqual([{ tool: 'ls' }]);
    expect(normalizeToolCalls(undefined)).toEqual([]);
    expect(normalizeToolCalls('not-array')).toEqual([]);
  });
});
