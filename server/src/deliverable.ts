/**
 * Node deliverables (交付成果): every execution step must produce a standardized
 * markdown report — what was done, changes, verification, goal contribution,
 * problems. Stored in task KV and surfaced in the war-room journal as a
 * clickable card rendered by both desktop and mobile chat streams.
 */
import { busSet, busGet, busKeys } from './bus';
import { appendJournal } from './store';
import type { TaskNode } from './types';

export function buildDeliverableReport(taskId: string, node: TaskNode): string {
  const result = node.result || ({} as Record<string, any>);
  const status = node.status === 'completed' ? '✅ 完成' : `❌ ${node.status}`;
  const duration = node.started_at
    ? Math.max(0, Math.round(((node.finished_at ? new Date(node.finished_at).getTime() : Date.now()) - new Date(node.started_at).getTime()) / 100) / 10) + 's'
    : '—';

  const changes: string[] = result.changes || [];
  const errors: string[] = result.errors || (node.error ? [node.error] : []);
  const model = result.model || '—';
  const tokens = result.tokens || 0;

  return [
    `# 节点交付报告：${node.name}`,
    '',
    '| 项 | 值 |',
    '|---|---|',
    `| 节点 | ${node.id} |`,
    `| Agent | ${node.agent} |`,
    `| 模型 | ${model} |`,
    `| 状态 | ${status} |`,
    `| 耗时 | ${duration} |`,
    `| Token | ${tokens} |`,
    `| 任务 | ${taskId} |`,
    '',
    '## 做了什么',
    result.summary || node.error || '（无摘要）',
    '',
    '## 对全局目标的贡献',
    node.goal_link || '（本节点未声明 goal_link）',
    '',
    '## 变更清单',
    changes.length ? changes.map((c) => '- ' + c).join('\n') : '（无文件变更——分析/调查类任务）',
    '',
    '## 验证方式与结果',
    result.verification || '⚠ 未提供验证信息',
    '',
    '## 遇到的问题',
    errors.length ? errors.map((e) => '- ' + e).join('\n') : '无',
    '',
    '## 缺陷清单（发现但未修复，可转修复任务）',
    (result.defects || []).length
      ? (result.defects || []).map((d: any, i: number) => {
          const sev = d.severity ? `（severity: ${d.severity}）` : '';
          return `${i + 1}. **${d.title}**${sev}\n   ${d.detail}`;
        }).join('\n')
      : '无',
    '',
    '---',
    '*由 Co_team 交付成果系统按统一模板自动生成 · 模板 v1*',
  ].join('\n');
}

/** Persist the deliverable + drop a clickable card into the war-room journal. */
export async function saveDeliverable(taskId: string, node: TaskNode): Promise<void> {
  const markdown = buildDeliverableReport(taskId, node);
  const defects = (node.result as Record<string, any>)?.defects || [];
  await busSet(`task:${taskId}:deliverable:${node.id}`, {
    node_id: node.id,
    node_name: node.name,
    agent: node.agent,
    status: node.status,
    markdown,
    defects,
    ts: new Date().toISOString(),
  });
  await appendJournal(taskId, node.agent, {
    role: 'agent',
    kind: 'deliverable',
    text: `交付成果：${node.name}（点击阅读完整报告）`,
    ts: new Date().toISOString(),
    node_id: node.id,
    node_name: node.name,
    meta: { markdown, deliverable: true, defects },
  });
}

export async function getDeliverable(taskId: string, nodeId: string): Promise<{ markdown: string; node_name: string; agent: string; status: string; defects: Record<string, unknown>[]; ts: string } | null> {
  return busGet(`task:${taskId}:deliverable:${nodeId}`);
}

export async function listDeliverables(taskId: string): Promise<{ node_id: string; node_name: string; agent: string; status: string; markdown: string; defects: Record<string, unknown>[]; ts: string }[]> {
  const keys = await busKeys(`task:${taskId}:deliverable:*`);
  const out: { node_id: string; node_name: string; agent: string; status: string; markdown: string; defects: Record<string, unknown>[]; ts: string }[] = [];
  for (const key of keys.sort()) {
    const d = await busGet<{ node_id: string; node_name: string; agent: string; status: string; markdown: string; defects: Record<string, unknown>[]; ts: string }>(key);
    if (d) out.push(d);
  }
  return out;
}
