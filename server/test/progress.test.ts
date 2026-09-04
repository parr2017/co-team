import { describe, expect, it } from 'vitest';
import { computeProgress, shouldBroadcast, clearProgressThrottle } from '../src/progress';
import type { TaskGraph, TaskNode } from '../src/types';

function node(id: string, status: TaskNode['status'], started?: string, finished?: string): TaskNode {
  return {
    id, task_id: 't', name: `节点${id}`, status, agent: id === 'merge' ? 'orchestrator' : 'dev', result: null, error: '',
    retry_count: 0, complexity: 'normal', requires_approval: false, needs_human: false,
    created_at: '', updated_at: '', started_at: started, finished_at: finished,
  };
}

function graph(nodes: TaskNode[], status = 'running'): TaskGraph {
  return { task_id: 't1', nodes, edges: [], description: 'd', workspace: 'w', status, created_at: '', updated_at: '' };
}

describe('progress (improvement 6)', () => {
  it('computes percent, running nodes and eta from node durations', () => {
    const g = graph([
      node('a', 'completed', '2026-01-01T00:00:00Z', '2026-01-01T00:01:00Z'),
      node('b', 'running'),
      node('c', 'pending'),
      node('merge', 'pending'),
    ]);
    const p = computeProgress(g);
    expect(p.percent).toBe(33); // merge node excluded
    expect(p.completed).toBe(1);
    expect(p.total).toBe(3);
    expect(p.current_nodes.map((n) => n.id)).toEqual(['b']);
    expect(p.eta_sec).toBeGreaterThan(0); // 60s avg × 2 remaining
  });

  it('reports 100% for finished tasks', () => {
    const p = computeProgress(graph([node('a', 'completed')], 'success'));
    expect(p.percent).toBe(100);
    expect(p.eta_sec).toBeUndefined();
  });

  it('throttles proactive broadcast but lets milestones pass immediately', () => {
    clearProgressThrottle('t9');
    const t0 = 1_000_000;
    expect(shouldBroadcast('t9', true, t0)).toBe(true);
    expect(shouldBroadcast('t9', false, t0 + 1000)).toBe(false); // within 30s window
    expect(shouldBroadcast('t9', false, t0 + 31_000)).toBe(true); // interval elapsed
    expect(shouldBroadcast('t9', true, t0 + 32_000)).toBe(true); // force always passes
  });
});
