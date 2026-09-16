// 事件描述映射层：把服务端事件（type + payload）翻译成人类可读的一句中文。
// 任务频道执行详情时间线、事件归档、工作台事件日志三处共用；新增事件类型只改这里。

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
      return { text: `${NODE_NAME(p)}等待实施前澄清${p.brief?.questions?.length ? ` · ${p.brief.questions.length} 个待确认问题` : ''}`, level: 'accent', category: 'node', noisy: false };
    case 'node_clarified':
      return { text: `${NODE_NAME(p)}澄清确认完成，继续执行`, level: 'success', category: 'node', noisy: false };
    case 'node_main_takeover':
      return { text: `主 Agent 兜底接管${NODE_NAME(p)} · 使用模型 ${p.model || '?'}`, level: 'warn', category: 'node', noisy: false };
    case 'command_pending_approval':
      return { text: `${Array.isArray(p.commands) && p.commands.length ? `${p.commands.length} 条命令` : '命令'}等待人工审批（执行策略 approve_required）`, level: 'accent', category: 'node', noisy: false };
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
    case 'llm_backoff':
      return { text: `⏳ ${p.model || '模型'} 限流（429），${p.backoff_sec}s 后自动重试（第 ${p.attempt}/2 次）`, level: 'info', category: 'agent', noisy: true };
    case 'model_slow':
      return { text: `🐌 ${p.model} 慢成功（${p.elapsed_sec}s），已降权`, level: 'info', category: 'agent', noisy: false };
    case 'model_failover':
      // B6（2026-09-17）：payload 补 from/to/reason——切换原因与对象可见
      return { text: `↯ 模型降级：${p.from || p.model || '?'} → ${p.to || '下一候选'}${p.reason ? `（${p.reason}）` : ''}`, level: 'warn', category: 'agent', noisy: false };
    case 'llm_overflow':
      return p.action === 'fold_retry'
        ? { text: `📦 ${p.model || '模型'} 上下文超限（413），折叠历史瘦身重试`, level: 'warn', category: 'agent', noisy: false }
        : { text: `📦 上下文超限仍装不下，剩余链改按更大窗口模型优先`, level: 'warn', category: 'agent', noisy: false };
    case 'agent_first_token':
      return { text: `${p.agent || ''} 首字返回 · ${p.model || '?'}`, level: 'info', category: 'agent', noisy: true };
    case 'agent_delta':
      return { text: `${p.agent || ''} 正在生成… ${CLIP(p.text, 60)}`, level: 'info', category: 'agent', noisy: true };
    case 'stage_started':
      return { text: `📋 第 ${p.stage} 阶段启动：${CLIP(p.stage_goal || '', 60)}`, level: 'accent', category: 'task', noisy: true };
    case 'stage_planning':
      return { text: `🧭 正在规划第 ${p.next_stage ?? '?'} 阶段（replanner 裁定中）…`, level: 'info', category: 'task', noisy: true };
    case 'task_finalizing': {
      const stageText: Record<string, string> = { merge: '合并沙箱产物到工作区', acceptance: '合并后全量验收', final_gate: '最终验收清单机审', git: 'git 提交' };
      return { text: `🧹 任务收尾：${stageText[String(p.stage || '')] || CLIP(p.stage, 20)}`, level: 'info', category: 'task', noisy: true };
    }
    case 'task_completed_with_warnings':
      // B1（2026-09-17）：tolerant 交付——主体完成、验收报告有失败项
      return { text: `⚠️ 任务完成（验收有警告：${p.acceptance?.command || '测试'} 退出码 ${p.acceptance?.exitCode ?? '?'}）——详见验收报告`, level: 'warn', category: 'task', noisy: false };
    case 'queue_auto_requeue':
      return { text: `⚡ 模型池不稳自动重排（第 ${p.attempt}/${p.max} 次，${p.delay_sec}s 后）——内容无问题，无需人工`, level: 'accent', category: 'task', noisy: false };
    case 'task_interrupted':
      return { text: p.auto_resume ? '服务重启中断，将自动续跑（已完成节点成果保留）' : '任务因服务重启中断', level: 'warn', category: 'task', noisy: false };
    case 'task_milestone': {
      return { text: `📣 节点完成 ${p.completed ?? '?'}/${p.total ?? '?'}：${p.agent || ''} 「${CLIP(p.node, 30)}」`, level: 'success', category: 'task', noisy: true };
    }
    case 'acceptance_report':
      return { text: `🏁 最终验收：红灯 ${p.failed}、待人工 ${p.open}`, level: p.failed > 0 ? 'warn' : 'accent', category: 'task', noisy: true };
    case 'supervisor_evaluated':
      return { text: `监督者评估（${p.reason || '心跳'}）：${CLIP(p.assessment || '', 50)}`, level: 'info', category: 'system', noisy: false };
    case 'supervisor_action':
      return { text: `监督者动作：${p.action}`, level: 'info', category: 'system', noisy: false };
    case 'supervisor_proposal':
      return { text: `🔔 监督者提案待批准（任务 ${p.task_id}）`, level: 'warn', category: 'task', noisy: true };
    case 'supervisor_proposal_executed':
      return { text: `提案已批准执行（${p.type}）`, level: 'accent', category: 'task', noisy: false };
    case 'ask_created':
      return { text: `❓ ${p.from} 提问：${CLIP(p.question || '', 60)}`, level: 'warn', category: 'task', noisy: true };
    case 'ask_delivered':
      return { text: `提问已转交 ${p.agent}`, level: 'info', category: 'task', noisy: false };
    case 'ask_answered_by_agent':
      return { text: `ask 已被 ${p.by} 回答`, level: 'info', category: 'task', noisy: false };
    case 'ask_resolved':
      return { text: p.no_answer ? '提问超时未答（按假设继续）' : '提问已回答', level: 'info', category: 'task', noisy: false };
    case 'intervention_injected':
      return { text: `插话已送达（${p.count} 条）`, level: 'info', category: 'task', noisy: false };
    case 'intervention_deferred':
      return { text: `插话已接力到后续节点（${p.count} 条）`, level: 'info', category: 'task', noisy: false };
    case 'gate_test':
      return { text: `自修改门禁：${p.passed ? '通过' : '未通过'}`, level: p.passed ? 'info' : 'warn', category: 'task', noisy: false };
    case 'defect_converted':
      return { text: '缺陷已转修复任务', level: 'accent', category: 'task', noisy: false };
    case 'task_plan_failed':
      return { text: `后台规划失败：${CLIP(p.error || '', 60)}`, level: 'error', category: 'task', noisy: true };
    case 'node_added':
      return { text: '计划插入新节点', level: 'info', category: 'task', noisy: false };

    // ---- 协作可视化（2026-09-16）：agent 间留言与上游接力 ----
    case 'agent_message':
      if (p.kind === 'received') return { text: `${p.agent || '成员'} 收到来自 ${p.from || '同伴'} 的留言`, level: 'info', category: 'agent', noisy: false };
      if (p.kind === 'doc') return { text: `${p.agent || '成员'} 更新协同文档 docs/${p.doc_type}.md → v${p.version ?? '?'}`, level: 'info', category: 'agent', noisy: false };
      return { text: `${p.agent || '成员'} 给 ${p.to === 'user' ? '用户' : p.to === 'orchestrator' ? '主 Agent' : (p.to || '同伴')} 留言`, level: 'info', category: 'agent', noisy: false };
    case 'node_handoff':
      return { text: `${p.agent || '成员'} 接力上游：${CLIP(p.handoff || '', 80)}`, level: 'info', category: 'agent', noisy: false };
    case 'branch_converge_conflict':
      return { text: `上游分支收敛冲突 ${p.conflicts?.length ?? '?'} 个，已以上游版本续合`, level: 'warn', category: 'task', noisy: false };
    case 'node_phantom_detected':
      return { text: p.mode === 'fail'
        ? `假完成拦截：${p.agent || '成员'} 申报的 ${p.phantom?.length ?? '?'} 个文件未落盘，已停止并转人工`
        : `${p.agent || '成员'} 申报中 ${p.phantom?.length ?? '?'} 个文件未落盘，已从交付清单剔除`,
        level: p.mode === 'fail' ? 'error' : 'warn', category: 'task', noisy: false };


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
    case 'daily_report_ready':
      return { text: `每日问题报告已生成（${p.date || ''}）· ${p.count ?? 0} 类问题待处理`, level: 'accent', category: 'system', noisy: false };

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

    // ---- 群组沟通（引擎 v2：路由 → 工具/发言 → 方案 → 转项目 → 经验沉淀）----
    case 'discussion_started':
      return { text: `群组讨论「${CLIP(p.title, 30)}」开始 · 成员：${(p.members || []).join('、')}`, level: 'accent', category: 'system', noisy: false };
    case 'discussion_message': {
      if (p.message?.tool) return { text: CLIP(p.message?.text, 80), level: 'info', category: 'system', noisy: true };
      const from = p.message?.from === 'user' ? '用户' : p.message?.from;
      return { text: `${from}：${CLIP(p.message?.text, 60)}`, level: 'info', category: 'system', noisy: true };
    }
    case 'discussion_message_delta':
      return { text: `${p.agent || ''} 正在输入…`, level: 'info', category: 'system', noisy: true };
    case 'discussion_tool': {
      const c = (p.calls || [])[0] || {};
      return { text: `🔧 ${p.agent || '成员'} ${c.tool || ''}${c.command ? ` ${CLIP(c.command, 40)}` : c.path ? ` ${c.path}` : ''}`, level: 'info', category: 'system', noisy: true };
    }
    case 'discussion_reacted':
      return { text: `回应了成员发言 ${p.emoji || ''}`, level: 'info', category: 'system', noisy: true };
    case 'discussion_round':
      if (p.phase === 'router') return { text: `决定由 ${(p.speakers || []).join('、') || '无人'} 回复`, level: 'info', category: 'system', noisy: true };
      if (p.phase !== 'end') return { text: `${p.agent || ''} 正在处理…`, level: 'info', category: 'system', noisy: true };
      return { text: `本轮完成${Array.isArray(p.speakers) && p.speakers.length ? ` · 发言：${p.speakers.join('、')}` : ' · 暂无新发言'}${p.interrupted_by_user ? ' · 已被你的新消息打断' : ''}`, level: 'info', category: 'system', noisy: true };
    case 'discussion_ask_user':
      return { text: `${p.agent || '成员'}需要你拍板：${CLIP(p.question, 60)}`, level: 'accent', category: 'system', noisy: false };
    case 'discussion_scheme_updated':
      return { text: `项目规划方案已更新（v${p.version ?? '?'}）`, level: 'success', category: 'system', noisy: false };
    case 'discussion_status':
      return { text: `讨论状态：${p.status || (p.waiting_user ? '等待你的回答' : '')}`, level: 'info', category: 'system', noisy: true };
    case 'discussion_converted':
      return { text: `方案已转为项目开发 · 项目 ${p.project_id || ''} / 任务 ${p.task_id || ''}`, level: 'success', category: 'system', noisy: false };
    case 'discussion_experience':
      return { text: `${p.agent || '成员'}沉淀经验到知识库：${CLIP(p.title, 40)}`, level: 'success', category: 'system', noisy: false };

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
  interrupted: '已中断·自动续跑',
  finalizing: '收尾验收中',
  waiting_approval: '待审批',
  waiting_clarify: '待澄清',
  completed: '已完成',
  // B1（2026-09-17）：tolerant 验收交付——主体完成但验收有失败项
  completed_with_warnings: '完成·有警告',
  failed: '失败',
  cancelled: '已取消',
  success: '已完成',
  idle: '空闲',
  done: '已完成',
  error: '出错',
  // 群组讨论三态（此前 web 列表显示英文原文，mobile 才有中文——统一收口到这里）
  discussing: '讨论中',
  converged: '方案已生成',
  converted: '已转项目',
};

export function statusText(s: string): string {
  return STATUS_TEXT[s] || s;
}

/** 状态 → el-tag type（与 STATUS_TEXT 配套的唯一来源） */
export const STATUS_TAG_TYPE: Record<string, string> = {
  completed: 'success', success: 'success', done: 'success',
  failed: 'danger', error: 'danger',
  running: 'warning', retrying: 'warning', clarifying: 'warning', waiting_clarify: 'warning',
  interrupted: 'warning', finalizing: 'warning',
  // B1：验收有警告——warning 色区分于纯成功
  completed_with_warnings: 'warning',
  waiting_approval: 'primary', planned: 'primary',
  pending: 'info', queued: 'info', cancelled: 'info', idle: 'info',
};

export function statusTagType(s: string): string {
  return STATUS_TAG_TYPE[s] || 'info';
}

/** 任务状态 → 当前所处阶段（回答"现在到哪一步了"） */
export function taskStage(status: string): { label: string; step: number } {
  if (['pending', 'queued'].includes(status)) return { label: '排队等待', step: 0 };
  if (['clarifying'].includes(status)) return { label: '需求澄清', step: 0 };
  if (['planned'].includes(status)) return { label: '计划待审核', step: 1 };
  if (['running', 'retrying', 'interrupted', 'finalizing'].includes(status)) return { label: status === 'finalizing' ? '收尾验收' : '节点执行', step: 2 };
  if (['waiting_approval'].includes(status)) return { label: '等待审批', step: 2 };
  if (['waiting_clarify'].includes(status)) return { label: '实施前澄清', step: 2 };
  if (['completed', 'success'].includes(status)) return { label: '已完成', step: 3 };
  if (['failed'].includes(status)) return { label: '执行失败', step: 3 };
  if (['cancelled'].includes(status)) return { label: '已取消', step: 3 };
  return { label: status, step: 0 };
}
