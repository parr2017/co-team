/**
 * Feishu command set (feishu_commands_spec.md): /help /agent /project /status
 * /reset /list — pure functions over the session store so they are trivially
 * testable without the Feishu API.
 */
import type { FeishuSession } from './session';
import { fuzzyMatch, resetSession, setSession } from './session';

export interface ProjectOption {
  id: string;
  name: string;
  workspace: string;
}

export interface CommandDeps {
  listProjects: () => Promise<ProjectOption[]>;
  listAgentNames: () => string[];
}

export interface CommandResult {
  reply: string;
  session?: FeishuSession;
  /** a non-command free-text message → caller routes it to task creation */
  passthrough?: boolean;
}

const HELP_TEXT = [
  'Co-Team 机器人指令：',
  '/help — 显示本帮助',
  '/project [名称或ID] — 切换当前项目（不带参数列出可选项目）',
  '/agent [名称] — 切换当前 Agent（不带参数列出可用 Agent）',
  '/status — 查看当前会话状态',
  '/list project|agent — 列出项目 / Agent',
  '/reset — 重置会话上下文',
  '其它任意文本 = 以当前项目为工作区直接发起任务',
].join('\n');

export async function handleCommand(text: string, session: FeishuSession, deps: CommandDeps): Promise<CommandResult> {
  const trimmed = text.trim();
  if (!trimmed.startsWith('/')) {
    return { reply: '', passthrough: true, session };
  }
  const [rawCmd, ...rest] = trimmed.split(/\s+/);
  const cmd = rawCmd.toLowerCase();
  const arg = rest.join(' ');

  switch (cmd) {
    case '/help':
    case '/?':
      return { reply: HELP_TEXT, session };

    case '/project': {
      const projects = await deps.listProjects();
      if (!arg) {
        const current = projects.find((p) => p.id === session.current_project_id);
        return {
          reply: current
            ? `当前项目：${current.name}（${current.id}）\n切换：/project <名称或ID>`
            : `请先选择项目，可选：\n${projects.map((p) => `- ${p.name}（${p.id}）`).join('\n') || '（暂无项目）'}`,
          session,
        };
      }
      const { match, suggestions } = fuzzyMatch(arg, projects, (p) => `${p.name} ${p.id}`);
      if (match) {
        const next = { ...session, current_project_id: match.id, current_project_name: match.name };
        await setSession(next);
        return { reply: `✅ 已切换当前项目为「${match.name}」（${match.id}）`, session: next };
      }
      return {
        reply: suggestions.length
          ? `匹配到多个项目：\n${suggestions.slice(0, 5).map((p) => `- ${p.name}（${p.id}）`).join('\n')}`
          : `未找到项目「${arg}」，用 /list project 查看全部`,
        session,
      };
    }

    case '/agent': {
      const agents = deps.listAgentNames();
      if (!arg) {
        const current = session.current_agent_id || '（自动路由）';
        return { reply: `当前 Agent：${current}\n可用：${agents.join(', ')}\n切换：/agent <名称>`, session };
      }
      const { match, suggestions } = fuzzyMatch(arg, agents, (a) => a);
      if (match) {
        const next = { ...session, current_agent_id: match };
        await setSession(next);
        return { reply: `✅ 已将当前 Agent 切换为 ${match}`, session: next };
      }
      return {
        reply: suggestions.length ? `匹配到多个：${suggestions.join(', ')}` : `未找到 Agent「${arg}」，可用：${agents.join(', ')}`,
        session,
      };
    }

    case '/status': {
      const lines = [`会话用户：${session.user_id}`];
      lines.push(session.current_project_id ? `当前项目：${session.current_project_name || ''}（${session.current_project_id}）` : '当前项目：未选择（/project <名称>）');
      lines.push(`当前 Agent：${session.current_agent_id || '自动路由'}`);
      lines.push(`最近活跃：${session.last_active_time}`);
      return { reply: lines.join('\n'), session };
    }

    case '/list': {
      const what = arg.toLowerCase();
      if (what.startsWith('agent')) {
        return { reply: `可用 Agent：\n${deps.listAgentNames().map((a) => `- ${a}`).join('\n')}`, session };
      }
      const projects = await deps.listProjects();
      return { reply: `项目列表：\n${projects.map((p) => `- ${p.name}（${p.id}）· ${p.workspace}`).join('\n') || '（暂无项目）'}`, session };
    }

    case '/reset': {
      const fresh = await resetSession(session.user_id);
      return { reply: '✅ 会话已重置（项目/Agent 选择已清除）', session: fresh };
    }

    default:
      return { reply: `未知指令 ${cmd}。\n${HELP_TEXT}`, session };
  }
}
