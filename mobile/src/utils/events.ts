// 事件描述映射层：把服务端事件（type + payload）翻译成人类可读的一句中文。
// 作战室执行详情时间线、事件归档、工作台事件日志三处共用；新增事件类型只改这里。

export type EventLevel = 'info' | 'success' | 'warn' | 'error' | 'accent';

export type EventCategory = 'node' | 'agent' | 'task' | 'system';

export interface EventView {
  /** 一句中文描述，含关键数字/名称 */
  text: string;
  level: EventLevel;
  category: EventCategory;
  /** 高频心跳类（轮次完成、进度广播、聊天流水），归档默认折叠 */
  noisy: boolean;
}

const CLIP = (s: unknown, n = 80): string => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n) + '…' : t;
};

const NODE_NAME = (p: Record<string, any>): string => (p.name ? `「${p.name}」` : '');

export function describeEvent(type: string, p: Record<string, any> = {}): EventView {
  switch (type) {
    // ---- 节点生命周期 ----
    case 'node_start':
      return { text: `开始执行${NODE_NAME(p)} · ${p.agent || ''}`, level: 'warn', category: 'node', noisy: false };
    case 'node_complete': {
      const summary = p.summary ? ` — ${CLIP(p.summary, 60)}` : '';
      const changes = Array.isArray(p.changes) && p.changes.length ? `（${p.changes.length} 项变更）` : '';
      return { text: `${NODE_NAME(p)}完成${changes}${summary}`, level: 'success', category: 'node', noisy: false };
    }
    case 'node_error':
      return { text: `${NODE_NAME(p)}执行失败${p.error ? ` — ${CLIP(p.error, 100)}` : ''}`, level: 'error', category: 'node', noisy: false };
    case 'node_retry':
      return { text: `第 ${p.attempt ?? (p.retry_count ?? '?')} 次重试${NODE_NAME(p)}`, level: 'warn', category: 'node', noisy: false };
    case 'node_waiting_approval':
      return { text: `${NODE_NAME(p)}等待人工审批`, level: 'accent', category: 'node', noisy: false };
    case 'node_awaiting_clarify':
      return { text: `${NODE_NAME(p)}等待实施前澄清`, level: 'accent', category: 'node', noisy: false };
    case 'node_clarified':
      return { text: `${NODE_NAME(p)}澄清确认完成，继续执行`, level: 'success', category: 'node', noisy: false };
    case 'node_main_takeover':
      return { text: `主 Agent 兜底接管${NODE_NAME(p)} · 使用模型 ${p.model || '?'}`, level: 'warn', category: 'node', noisy: false };
    case 'command_pending_approval':
      return { text: '命令等待人工审批（执行策略 approve_required）', level: 'accent', category: 'node', noisy: false };
    case 'command_resolved':
      return p.approved
        ? { text: `命令已批准执行（退出码 ${p.returncode ?? '?'}）`, level: p.returncode === 0 ? 'success' : 'warn', category: 'node', noisy: false }
        : { text: '命令已被用户拒绝，未执行', level: 'warn', category: 'node', noisy: false };
    case 'node_cancelled':
      return { text: `${NODE_NAME(p)}已取消`, level: 'warn', category: 'node', noisy: false };
    case 'node_escalate':
      return { text: `${NODE_NAME(p)}升级主 Agent 接管${p.error ? ` — ${CLIP(p.error, 60)}` : ''}`, level: 'error', category: 'node', noisy: false };
    case 'node_branch_created':
      return { text: `创建分支 ${p.branch || ''}`, level: 'info', category: 'node', noisy: false };
    case 'test_fix_round':
      return { text: `测试修复第 ${p.round ?? '?'}/${p.max ?? '?'} 轮 · ${p.failures ?? 0} 个失败用例`, level: 'warn', category: 'node', noisy: false };

    // ---- Agent 动态 ----
    case 'agent_activity': {
      // payload.text 服务端已生成中文（接收任务简报 / 第 N 轮对话中… / 请求读取工具 / 写入文件）
      const text = CLIP(p.text, 90) || '执行中';
      return { text: `${p.agent ? `${p.agent} · ` : ''}${text}`, level: 'info', category: 'agent', noisy: /轮对话中/.test(text) };
    }
    case 'agent_round': {
      const tok = p.tokens ? ` · ${p.tokens} tok` : '';
      if (p.parse_error) return { text: `${p.agent || ''} 第 ${p.round ?? '?'} 轮输出异常，已要求按契约重试`, level: 'warn', category: 'agent', noisy: true };
      if (Array.isArray(p.tool_calls) && p.tool_calls.length) {
        return { text: `${p.agent || ''} 第 ${p.round ?? '?'} 轮 · 读取工具 ${p.tool_calls.length} 次${tok}`, level: 'info', category: 'agent', noisy: true };
      }
      return { text: `${p.agent || ''} 第 ${p.round ?? '?'} 轮对话完成${tok}`, level: 'info', category: 'agent', noisy: true };
    }
    case 'agent_final': {
      const summary = CLIP(p.summary, 90);
      return p.ok
        ? { text: `${p.agent || ''}汇报完成${summary ? ` — ${summary}` : ''}`, level: 'success', category: 'agent', noisy: false }
        : { text: `${p.agent || ''}汇报失败${summary ? ` — ${summary}` : ''}`, level: 'error', category: 'agent', noisy: false };
    }
    case 'knowledge_deposited':
      return { text: `${p.agent || ''}沉淀知识到知识库${p.updated ? '（更新已有条目）' : ''}`, level: 'success', category: 'agent', noisy: false };

    // ---- 任务级 ----
    case 'task_creating':
      return { text: p.stage === 'assessing' ? '正在评估需求清晰度…' : '正在生成任务计划…', level: 'info', category: 'task', noisy: true };
    case 'task_needs_clarification': {
      const qn = Array.isArray(p.questions) ? p.questions.length : undefined;
      return { text: `需求需要澄清${qn ? ` · ${qn} 个问题` : ''}`, level: 'warn', category: 'task', noisy: false };
    }
    case 'task_clarified':
      return { text: `澄清完成${p.answers ? ` · ${p.answers} 个回答` : ''}`, level: 'success', category: 'task', noisy: false };
    case 'task_replanned':
      return { text: `任务重新规划${p.summary ? ` — ${CLIP(p.summary, 70)}` : ''}`, level: 'accent', category: 'task', noisy: false };
    case 'task_model_changed':
      return { text: `主 Agent 模型切换 ${p.previous || '?'} → ${p.model || '?'}`, level: 'accent', category: 'task', noisy: false };
    case 'goal_updated':
      return { text: '全局目标已更新', level: 'accent', category: 'task', noisy: false };
    case 'user_intervened':
      return { text: `人工介入：${CLIP(p.message, 80)}`, level: 'accent', category: 'task', noisy: false };
    case 'clarify_timeout':
      return { text: '澄清等待超时', level: 'warn', category: 'task', noisy: false };

    // ---- 执行引擎 ----
    case 'execute_start':
      return { text: `任务开始执行 · ${p.total_nodes ?? '?'} 个节点`, level: 'accent', category: 'task', noisy: false };
    case 'execute_failed':
      return { text: `任务执行失败${p.error ? ` — ${CLIP(p.error, 100)}` : ''}`, level: 'error', category: 'task', noisy: false };
    case 'progress_update': {
      const pr = p.progress || {};
      return { text: `进度 ${pr.percent ?? '?'}% · ${pr.completed ?? '?'}/${pr.total ?? '?'} 节点`, level: 'info', category: 'task', noisy: true };
    }

    // ---- 系统/其他 ----
    case 'journal_append':
      return { text: CLIP(p.entry?.text || p.text || '会话消息', 60), level: 'info', category: 'system', noisy: true };
    case 'queue_update':
      return { text: '任务队列更新', level: 'info', category: 'system', noisy: true };
    case 'snapshot_created':
      return { text: `创建快照${p.snapshot?.tag ? `（${p.snapshot.tag}）` : ''}`, level: 'info', category: 'system', noisy: false };
    case 'snapshot_rolled_back':
      return { text: `回滚到快照${p.snapshot?.created_at ? `（${p.snapshot.created_at}）` : ''}`, level: 'accent', category: 'system', noisy: false };
    case 'doc_updated':
      return { text: `文档更新${p.path ? ` — ${CLIP(p.path, 60)}` : ''}`, level: 'info', category: 'system', noisy: false };
    default: {
      // 未登记类型：尽量从 payload 拼出可读内容，而不是裸 type
      const fallback = p.text || p.summary || p.message || p.name || p.error || '';
      return { text: CLIP(fallback) || type, level: 'info', category: 'system', noisy: false };
    }
  }
}

/** 状态 → 中文 + el-tag type，节点/任务状态统一用这套 */
export const STATUS_TEXT: Record<string, string> = {
  pending: '排队中',
  queued: '排队中',
  planned: '待审核',
  clarifying: '澄清中',
  running: '执行中',
  retrying: '重试中',
  waiting_approval: '待审批',
  waiting_clarify: '待澄清',
  completed: '已完成',
  failed: '失败',
  cancelled: '已取消',
  success: '已完成',
  idle: '空闲',
  done: '已完成',
  error: '出错',
};

export function statusText(s: string): string {
  return STATUS_TEXT[s] || s;
}

/** 任务状态 → 当前所处阶段（回答"现在到哪一步了"） */
export function taskStage(status: string): { label: string; step: number } {
  if (['pending', 'queued'].includes(status)) return { label: '排队等待', step: 0 };
  if (['clarifying'].includes(status)) return { label: '需求澄清', step: 0 };
  if (['planned'].includes(status)) return { label: '计划待审核', step: 1 };
  if (['running', 'retrying'].includes(status)) return { label: '节点执行', step: 2 };
  if (['waiting_approval'].includes(status)) return { label: '等待审批', step: 2 };
  if (['waiting_clarify'].includes(status)) return { label: '实施前澄清', step: 2 };
  if (['completed', 'success'].includes(status)) return { label: '已完成', step: 3 };
  if (['failed'].includes(status)) return { label: '执行失败', step: 3 };
  if (['cancelled'].includes(status)) return { label: '已取消', step: 3 };
  return { label: status, step: 0 };
}
