/**
 * Feishu command set（feishu_commands_spec.md）：按窗口主题（task/convo/oc）
 * 分域解析——裸命令先解析当前模式域，再回落全局命令；未知的模式内命令回
 * 模式可用清单，不猜意图。
 *
 * 全局：/help /status /exit /reset + 模式入口 /convo /oc
 * task：/project /agent /tasks /queue /metrics /task /list
 * convo：/list /new /switch /stop（自由文本=发言）
 * oc：/list /new /switch /model /agent /stop（自由文本=prompt）
 */
import type { FeishuSession } from './session';
import { fuzzyMatch, resetSession, setSession } from './session';
import type { ConvoBridge } from './convoBridge';
import type { OcBridge } from './ocBridge';

export interface ProjectOption {
  id: string;
  name: string;
  workspace: string;
}

export interface CommandDeps {
  listProjects: () => Promise<ProjectOption[]>;
  listAgentNames: () => string[];
  /** /tasks：最近任务（跨项目，按会话当前项目过滤）——未挂载时指令提示未启用 */
  listTasks?: () => Promise<{ id: string; description: string; status: string; project_id: string | null }[]>;
  /** /queue：任务队列车道快照 */
  listQueue?: () => Promise<{ key: string; running_task_id: string | null; pending: unknown[]; blocked: boolean; blocked_reason: string }[]>;
  /** /status 附加行：长连接网关连接状态（'connected' / 'reconnecting' / 'off' …） */
  gatewayStatus?: () => string;
  /** /metrics：任务/成本文字摘要 [v2] */
  metrics?: () => Promise<string>;
  /** /task <id>：单任务进度摘要 [v2] */
  taskSummary?: (taskId: string) => Promise<string>;
  /** convo 桥 [v2] */
  convo?: ConvoBridge;
  /** oc 桥 [v2] */
  oc?: OcBridge;
}

export interface CommandResult {
  reply: string;
  session?: FeishuSession;
  /** a non-command free-text message → caller routes it by session.mode */
  passthrough?: boolean;
}

const HELP_TASK = [
  '【任务模式】',
  '/project [名称或ID] — 切换当前项目（不带参数列出）',
  '/agent [名称] — 切换当前 Agent',
  '/tasks — 最近任务 · /queue — 队列快照',
  '/metrics — 成本/成功率摘要 · /task <id> — 单任务进度',
  '/list — 项目/Agent 列表 · /status — 会话状态',
  '/convo — 进入协作会话模式 · /oc — 进入 OpenCode 模式',
  '其它任意文本 = 以当前项目为工作区直接发起任务',
].join('\n');

const HELP_CONVO = [
  '【协作会话模式】',
  '直接发言 = 与当前会话的 agent 对话（回复完成后推送）',
  '/list — 会话列表 · /new [标题] — 新建 · /switch 序号 — 切换',
  '/stop — 停止当前回复 · /status — 会话状态 · /exit — 返回任务模式',
].join('\n');

const HELP_OC = [
  '【OpenCode 模式】',
  '直接输入需求 = 发 prompt（完成后推送结果，可关掉飞书等通知）',
  '/list — 会话列表 · /new [标题] — 新建 · /switch 序号 — 切换实例/会话',
  '/model · /agent — 裸命令看选项，带序号/名称切换',
  '/stop — 中止执行 · /exit — 返回任务模式',
].join('\n');

const helpFor = (mode: string): string => [HELP_TASK, mode === 'convo' ? HELP_CONVO : '', mode === 'oc' ? HELP_OC : ''].filter(Boolean).join('\n\n');

export async function handleCommand(text: string, session: FeishuSession, deps: CommandDeps, chatId?: string): Promise<CommandResult> {
  const trimmed = text.trim();
  if (!trimmed.startsWith('/')) {
    return { reply: '', passthrough: true, session };
  }
  const [rawCmd, ...rest] = trimmed.split(/\s+/);
  const cmd = rawCmd.toLowerCase();
  const arg = rest.join(' ');
  const mode = session.mode || 'task';

  // ---------- 全局命令 ----------
  switch (cmd) {
    case '/help':
    case '/?':
      return { reply: helpFor(mode), session };

    case '/status': {
      const lines = [`模式：${mode === 'task' ? '任务' : mode === 'convo' ? '协作会话' : 'OpenCode'}`, `会话用户：${session.user_id}`];
      lines.push(session.current_project_id ? `当前项目：${session.current_project_name || ''}（${session.current_project_id}）` : '当前项目：未选择（/project <名称>）');
      if (mode === 'convo') lines.push(`绑定会话：${session.convo_id || '无'}`);
      if (mode === 'oc') lines.push(`OpenCode：${session.oc_instance || '未绑定'} · 会话 ${session.oc_session?.slice(0, 12) || '无'}`);
      if (deps.gatewayStatus) lines.push(`飞书网关：${deps.gatewayStatus()}`);
      return { reply: lines.join('\n'), session };
    }

    case '/exit': {
      if (mode === 'task') return { reply: '当前已在任务模式。', session };
      const next: FeishuSession = { ...session, mode: 'task' };
      delete next.convo_id;
      delete next.oc_instance;
      delete next.oc_session;
      await setSession(next);
      return { reply: '✅ 已返回任务模式。', session: next };
    }

    case '/reset': {
      const fresh = await resetSession(session.user_id);
      return { reply: '✅ 会话已重置（已返回任务模式，项目/Agent 选择已清除）', session: fresh };
    }

    case '/convo': {
      if (!deps.convo) return { reply: '会话模式未启用（服务端未挂载 convo 桥）。', session };
      return { reply: await deps.convo.enter(arg, session, chatId || ''), session };
    }

    case '/oc': {
      if (!deps.oc) return { reply: 'OpenCode 模式未启用（服务端未挂载 oc 桥）。', session };
      return { reply: await deps.oc.enter(arg, session, chatId || ''), session };
    }
  }

  // ---------- convo 模式域 ----------
  if (mode === 'convo' && deps.convo) {
    switch (cmd) {
      case '/list':
        return { reply: await deps.convo.list(session), session };
      case '/new':
        return { reply: await deps.convo.create(arg, session, chatId || ''), session };
      case '/switch':
        return { reply: await deps.convo.switchTo(arg, session, chatId || ''), session };
      case '/stop':
        return { reply: await deps.convo.stop(session), session };
      default:
        return { reply: `当前是会话模式，可用：/list /new /switch /stop /exit\n直接发言即与 agent 对话。`, session };
    }
  }

  // ---------- oc 模式域 ----------
  if (mode === 'oc' && deps.oc) {
    switch (cmd) {
      case '/list':
        return { reply: await deps.oc.listSessions(session), session };
      case '/new':
        return { reply: await deps.oc.createSession(arg, session, chatId || ''), session };
      case '/switch':
        return { reply: await deps.oc.switchTo(arg, session, chatId || ''), session };
      case '/model':
        return { reply: await deps.oc.model(arg, session), session };
      case '/agent':
        return { reply: await deps.oc.agent(arg, session), session };
      case '/stop':
        return { reply: await deps.oc.stop(session), session };
      default:
        return { reply: `当前是 OpenCode 模式，可用：/list /new /switch /model /agent /stop /exit\n直接输入需求即开始执行。`, session };
    }
  }

  // ---------- task 模式域 ----------
  switch (cmd) {
    case '/project': {
      const projects = await deps.listProjects();
      if (!arg) {
        const current = projects.find((p) => p.id === session.current_project_id);
        return {
          reply: current
            ? `当前项目：${current.name}（${current.id}）\n切换：/project <名称或ID>，可选：\n${projects.map((p, i) => `${i + 1}. ${p.name}（${p.id}）`).join('\n')}`
            : `请先选择项目，可选：\n${projects.map((p, i) => `${i + 1}. ${p.name}（${p.id}）`).join('\n') || '（暂无项目）'}`,
          session,
        };
      }
      const n = Number(arg);
      const byIndex = Number.isInteger(n) ? projects[n - 1] : undefined;
      const { match, suggestions } = byIndex ? { match: byIndex, suggestions: [] } : fuzzyMatch(arg, projects, (p) => `${p.name} ${p.id}`);
      if (match) {
        const next = { ...session, current_project_id: match.id, current_project_name: match.name };
        await setSession(next);
        return { reply: `✅ 已切换当前项目为「${match.name}」（${match.id}）`, session: next };
      }
      return {
        reply: suggestions.length
          ? `匹配到多个项目：\n${suggestions.slice(0, 5).map((p, i) => `${i + 1}. ${p.name}（${p.id}）`).join('\n')}`
          : `未找到项目「${arg}」，用 /list project 查看全部`,
        session,
      };
    }

    case '/agent': {
      const agents = deps.listAgentNames();
      if (!arg) {
        const current = session.current_agent_id || '（自动路由）';
        return { reply: `当前 Agent：${current}\n可用：\n${agents.map((a, i) => `${i + 1}. ${a}`).join('\n')}\n切换：/agent <序号或名称>`, session };
      }
      const n = Number(arg);
      const byIndex = Number.isInteger(n) ? agents[n - 1] : undefined;
      const { match, suggestions } = byIndex ? { match: byIndex, suggestions: [] } : fuzzyMatch(arg, agents, (a) => a);
      if (match) {
        const next = { ...session, current_agent_id: match };
        await setSession(next);
        return { reply: `✅ 已将当前 Agent 切换为 ${match}`, session: next };
      }
      return {
        reply: suggestions.length ? `匹配到多个：\n${suggestions.map((a, i) => `${i + 1}. ${a}`).join('\n')}` : `未找到 Agent「${arg}」，可用：${agents.join(', ')}`,
        session,
      };
    }

    case '/tasks': {
      if (!deps.listTasks) return { reply: '任务查询未启用（服务端未挂载）', session };
      const all = await deps.listTasks();
      const tasks = (session.current_project_id ? all.filter((t) => t.project_id === session.current_project_id) : all).slice(0, 8);
      if (!tasks.length) return { reply: '当前项目暂无任务——直接发文本即可发起任务', session };
      const lines = tasks.map((t) => `- ${t.id} · ${t.status} · ${(t.description || '').slice(0, 40)}`);
      return { reply: `最近任务：\n${lines.join('\n')}`, session };
    }

    case '/queue': {
      if (!deps.listQueue) return { reply: '队列查询未启用（服务端未挂载）', session };
      const lanes = await deps.listQueue();
      if (!lanes.length) return { reply: '队列为空（没有活动车道）', session };
      const lines = lanes.map((l) => {
        const parts = [l.key];
        parts.push(l.running_task_id ? `在跑 ${l.running_task_id}` : '空闲');
        parts.push(l.pending.length ? `排队 ${l.pending.length}` : '无排队');
        if (l.blocked) parts.push(`阻塞：${l.blocked_reason || '需人工处理'}`);
        return `- ${parts.join(' · ')}`;
      });
      return { reply: `队列快照：\n${lines.join('\n')}`, session };
    }

    case '/metrics': {
      if (!deps.metrics) return { reply: '指标摘要未启用（服务端未挂载）', session };
      return { reply: await deps.metrics(), session };
    }

    case '/task': {
      if (!deps.taskSummary) return { reply: '任务详情未启用（服务端未挂载）', session };
      if (!arg) return { reply: '用法：/task <任务ID>', session };
      return { reply: await deps.taskSummary(arg), session };
    }

    case '/list': {
      const what = arg.toLowerCase();
      if (what.startsWith('agent')) {
        return { reply: `可用 Agent：\n${deps.listAgentNames().map((a) => `- ${a}`).join('\n')}`, session };
      }
      const projects = await deps.listProjects();
      return { reply: `项目列表：\n${projects.map((p) => `- ${p.name}（${p.id}）· ${p.workspace}`).join('\n') || '（暂无项目）'}`, session };
    }
  }

  return { reply: `未知指令 ${cmd}。\n${helpFor(mode)}`, session };
}
