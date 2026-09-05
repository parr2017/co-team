import { describe, it, expect } from 'vitest';
import { extractJson, salvageToolCalls } from '../src/llm';

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
