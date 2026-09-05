import { describe, expect, it } from 'vitest';
import { normalizePlan, type AgentSkillInfo } from '../src/orchestrator/planner';

function skillMap(): Map<string, AgentSkillInfo> {
  return new Map([
    ['dev', { name: 'dev', tags: ['code'] }],
    ['test', { name: 'test', tags: ['test'] }],
    ['review', { name: 'review', tags: ['review'] }],
    ['deploy', { name: 'deploy', tags: ['deploy'] }],
  ]);
}

describe('normalizePlan skill hard-check (R2)', () => {
  it('reassigns a test-skilled node from dev to the agent whose tags match', () => {
    const planned = {
      nodes: [
        { id: '1', name: '写单元测试', agent: 'dev', required_skills: ['test'], complexity: 'normal' },
      ],
      edges: [],
      summary: '',
    };
    const result = normalizePlan(planned, ['dev', 'test', 'review', 'deploy'], skillMap())!;
    expect(result.nodes[0].agent).toBe('test');
    expect(result.nodes[0].required_skills).toEqual(['test']);
  });

  it('keeps the chosen agent when its tags cover required_skills', () => {
    const planned = {
      nodes: [
        { id: '1', name: '实现接口', agent: 'dev', required_skills: ['code'], complexity: 'normal' },
      ],
      edges: [],
      summary: '',
    };
    const result = normalizePlan(planned, ['dev', 'test', 'review', 'deploy'], skillMap())!;
    expect(result.nodes[0].agent).toBe('dev');
  });

  it('reassigns to the agent with the LARGEST tag intersection when several partially match', () => {
    const map = new Map([
      ['dev', { name: 'dev', tags: ['code'] }],
      ['qa', { name: 'qa', tags: ['test'] }],
      ['full', { name: 'full', tags: ['code', 'test', 'review'] }],
    ]);
    const planned = {
      nodes: [
        { id: '1', name: '实现并测试', agent: 'dev', required_skills: ['code', 'test'], complexity: 'normal' },
      ],
      edges: [],
      summary: '',
    };
    const result = normalizePlan(planned, ['dev', 'qa', 'full'], map)!;
    expect(result.nodes[0].agent).toBe('full');
  });

  it('keeps the original agent (with warn) when no agent matches the skill at all', () => {
    const planned = {
      nodes: [
        { id: '1', name: '画原型图', agent: 'dev', required_skills: ['design'], complexity: 'normal' },
      ],
      edges: [],
      summary: '',
    };
    const result = normalizePlan(planned, ['dev', 'test', 'review', 'deploy'], skillMap())!;
    expect(result.nodes[0].agent).toBe('dev');
  });

  it('preserves required_skills on the node even when reassigned', () => {
    const planned = {
      nodes: [
        { id: '1', name: '部署服务', agent: 'dev', required_skills: ['deploy'], complexity: 'normal' },
        { id: '2', name: '实现', agent: 'dev', required_skills: ['code'], complexity: 'normal' },
      ],
      edges: [['2', '1']],
      summary: '',
    };
    const result = normalizePlan(planned, ['dev', 'test', 'review', 'deploy'], skillMap())!;
    expect(result.nodes[0].agent).toBe('deploy');
    expect(result.nodes[0].required_skills).toEqual(['deploy']);
    expect(result.nodes[1].agent).toBe('dev');
  });

  it('nodes without required_skills behave exactly as before (no reassignment)', () => {
    const planned = {
      nodes: [{ id: '1', name: '实现', agent: 'test', complexity: 'normal' }],
      edges: [],
      summary: '',
    };
    const result = normalizePlan(planned, ['dev', 'test'], skillMap())!;
    expect(result.nodes[0].agent).toBe('test');
    expect(result.nodes[0].required_skills).toEqual([]);
  });

  it('unknown agent still falls back to dev (existing behavior preserved)', () => {
    const planned = {
      nodes: [{ id: '1', name: '实现', agent: 'nonexistent-agent', complexity: 'normal' }],
      edges: [],
      summary: '',
    };
    const result = normalizePlan(planned, ['dev', 'test'], skillMap())!;
    expect(result.nodes[0].agent).toBe('dev');
  });
});
