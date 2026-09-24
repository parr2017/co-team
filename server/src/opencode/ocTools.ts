/**
 * oc_* 工具执行层——OpenCode 接管工具的统一分发（三引擎共用：任务管线/协作会话/群组讨论）。
 *
 * 与 mcp__ 分支同模式：tools.ts / convo.ts / discussion.ts 只认 `oc_` 前缀转到这里，
 * 门控（agent 白名单/档位/allow_shell）全在 OpencodeManager 内完成，任何异常软收口。
 *
 * 工具清单（schema 见 toolSchema.ts 的 opencodeTools()）：
 *   oc_instances    列可接管实例（状态/能力/模式）
 *   oc_create_session  开会话
 *   oc_send         同步派活（等 opencode 返回助手消息）
 *   oc_run_task     复合派活：开会话→异步发→等 session.idle→回收终局文本+diff（场景 B 主力）
 *   oc_read         读会话消息
 *   oc_abort        打断
 *   oc_revert       回退一条消息
 *   oc_diff          会话文件变更
 *   oc_permission   回应 opencode 的权限请求（once/always/reject）
 *   oc_shell        高危：会话内执行 shell（实例 allow_shell + control 档，默认禁用）
 */
import type { OpencodeBridge } from './types';

/** 全部 oc_ 工具名（三处分发器与 schema 门控共用同一份清单） */
export const OC_TOOL_NAMES = [
  'oc_instances',
  'oc_create_session',
  'oc_send',
  'oc_run_task',
  'oc_read',
  'oc_abort',
  'oc_revert',
  'oc_diff',
  'oc_permission',
  'oc_shell',
] as const;

export type OcToolName = (typeof OC_TOOL_NAMES)[number];

export function isOcTool(name: string): boolean {
  return (OC_TOOL_NAMES as readonly string[]).includes(name);
}

const MAX_PROMPT_CHARS = 8000;

function str(v: unknown, max = 500): string {
  return String(v ?? '').slice(0, max);
}

/** 从 opencode 消息列表提取最后一条助手文本（parts.type==='text' 拼接） */
export function extractLastAssistantText(messages: unknown[]): string {
  const msgs = Array.isArray(messages) ? messages : [];
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i] as { info?: { role?: string }; parts?: { type?: string; text?: string }[] };
    if (m?.info?.role && m.info.role !== 'assistant') continue;
    const texts = (m?.parts || []).filter((p) => p?.type === 'text' && typeof p.text === 'string').map((p) => p.text as string);
    if (texts.length) return texts.join('\n').trim();
  }
  return '';
}

/** 消息列表 → 轻量纪要（角色 + parts 类型分布 + 文本尾部），控制回喂体积 */
function summarizeMessages(messages: unknown[], maxChars = 3000): string {
  const msgs = Array.isArray(messages) ? messages : [];
  const lines: string[] = [];
  let used = 0;
  for (const raw of msgs.slice(-30)) {
    const m = raw as { info?: { role?: string }; parts?: { type?: string; text?: string; tool?: string }[] };
    const role = m?.info?.role || '?';
    const parts = (m?.parts || []).map((p) => {
      if (p?.type === 'text') return `text(${String(p.text || '').length}字)`;
      if (p?.type === 'reasoning') return 'reasoning';
      if (p?.type === 'tool') return `tool(${str(p.tool || p.type, 60)})`;
      return String(p?.type || '?');
    });
    const line = `${role}: ${parts.join(', ') || '(空)'}`;
    if (used + line.length > maxChars) {
      lines.push('…（更早消息略）');
      break;
    }
    lines.push(line);
    used += line.length;
  }
  return lines.join('\n');
}

export interface OcToolOutcome {
  result: Record<string, unknown>;
}

/**
 * 执行一个 oc_ 工具调用。agent=undefined 表示 API 层调用（不看白名单）。
 * 绝不 throw——全部语义错误转 {ok:false,error} 回喂模型/面板。
 */
export async function runOpencodeTool(bridge: OpencodeBridge, agent: string | undefined, call: Record<string, any>): Promise<Record<string, unknown>> {
  const name = String(call?.tool || '').toLowerCase();
  const instance = str(call.instance, 100).trim();
  const sessionId = str(call.session_id ?? call.sessionId, 100).trim();
  try {
    switch (name) {
      case 'oc_instances': {
        const list = bridge.listInstances(agent);
        return {
          tool: name, ok: true,
          count: list.length,
          instances: list.map((i) => ({
            id: i.id, kind: i.kind, state: i.state, mode: i.mode, version: i.version,
            ...(i.project_root ? { project_root: i.project_root } : {}),
            model_injection: i.model_injection,
            ...(i.error ? { error: i.error } : {}),
          })),
          note: list.length ? '' : '没有可接管的 opencode 实例（config.yaml 的 opencode.instances 未配置或本 agent 未绑定）',
        };
      }

      case 'oc_create_session': {
        if (!instance) return { tool: name, ok: false, error: 'instance 不能为空（用 oc_instances 看可用实例）' };
        const r = await bridge.createSession(agent, instance, str(call.title, 200) || undefined);
        return { tool: name, ok: r.ok, instance, ...(r.ok ? { session: r.data } : { error: r.error }) };
      }

      case 'oc_send': {
        if (!instance || !sessionId) return { tool: name, ok: false, error: 'instance 与 session_id 均不能为空' };
        const prompt = str(call.prompt ?? call.text, MAX_PROMPT_CHARS).trim();
        if (!prompt) return { tool: name, ok: false, error: 'prompt 不能为空' };
        const model = resolveModelArg(bridge, instance, call.model);
        if (model.error) return { tool: name, ok: false, error: model.error };
        const ocAgent = str(call.agent, 60) || undefined;
        const r = await bridge.sendPrompt(agent, instance, sessionId, prompt, model.ref, ocAgent);
        return {
          tool: name, ok: r.ok, instance, session: sessionId,
          ...(r.ok ? { final_text: extractLastAssistantText(Array.isArray(r.data) ? [] : r.data && typeof r.data === 'object' && 'parts' in (r.data as object) ? [r.data] : []) } : { error: r.error }),
        };
      }

      case 'oc_run_task': {
        if (!instance) return { tool: name, ok: false, error: 'instance 不能为空（用 oc_instances 看可用实例）' };
        const prompt = str(call.prompt ?? call.text, MAX_PROMPT_CHARS).trim();
        if (!prompt) return { tool: name, ok: false, error: 'prompt 不能为空（要 opencode 干什么，写清楚验收标准）' };
        const timeoutSec = Math.min(3600, Math.max(30, Number(call.timeout_sec) || 1800));
        // 1) 建会话
        const created = await bridge.createSession(agent, instance, str(call.title, 200) || `co-team 派活 ${new Date().toISOString().slice(5, 16)}`);
        if (!created.ok || !created.data) return { tool: name, ok: false, instance, error: `建会话失败：${created.error || '未知'}` };
        const sid = String(created.data.id || '');
        // 2) 模型链：model（单值）或 models（降级链）；字符串=池名/原生 provider/model，对象直穿
        const chain: unknown[] = Array.isArray(call.models)
          ? call.models.slice(0, 3)
          : call.model !== undefined ? [call.model] : [];
        const ocAgent = str(call.agent, 60) || undefined;
        let lastErr = '';
        for (const modelArg of chain.length ? chain : [undefined]) {
          const resolved = resolveModelArg(bridge, instance, modelArg);
          if (resolved.error) { lastErr = resolved.error; continue; }
          // 3) 异步发 + 等 idle
          const sent = await bridge.sendPromptAsync(agent, instance, sid, prompt, resolved.ref, ocAgent);
          if (!sent.ok) { lastErr = sent.error || '发送失败'; continue; }
          const idle = await bridge.waitSessionIdle(agent, instance, sid, timeoutSec * 1000);
          if (!idle.ok) { lastErr = idle.error || '等待超时'; continue; }
          // 4) 回收终局文本 + diff
          const [msgs, diff] = await Promise.all([
            bridge.readMessages(agent, instance, sid),
            bridge.sessionDiff(agent, instance, sid),
          ]);
          return {
            tool: name, ok: true, instance, session: sid,
            final_text: msgs.ok ? extractLastAssistantText(msgs.data as unknown[]) : '',
            message_outline: msgs.ok ? summarizeMessages(msgs.data as unknown[]) : '',
            diff: diff.ok ? diff.data : [],
            ...(diff.ok && diff.truncated ? { diff_truncated: true } : {}),
            ...(idle.data === 'error' ? { warning: '会话以 session.error 收场，final_text 可能不完整' } : {}),
          };
        }
        return { tool: name, ok: false, instance, session: sid, error: lastErr || '派活失败' };
      }

      case 'oc_read': {
        if (!instance || !sessionId) return { tool: name, ok: false, error: 'instance 与 session_id 均不能为空' };
        const r = await bridge.readMessages(agent, instance, sessionId);
        return {
          tool: name, ok: r.ok, instance, session: sessionId,
          ...(r.ok ? { messages: r.data, final_text: extractLastAssistantText(r.data as unknown[]), outline: summarizeMessages(r.data as unknown[]) } : { error: r.error }),
          ...(r.ok && r.truncated ? { truncated: true } : {}),
        };
      }

      case 'oc_abort': {
        if (!instance || !sessionId) return { tool: name, ok: false, error: 'instance 与 session_id 均不能为空' };
        const r = await bridge.abortSession(agent, instance, sessionId);
        return { tool: name, ok: r.ok, instance, session: sessionId, ...(r.ok ? {} : { error: r.error }) };
      }

      case 'oc_revert': {
        if (!instance || !sessionId) return { tool: name, ok: false, error: 'instance 与 session_id 均不能为空' };
        const messageId = str(call.message_id ?? call.messageId, 100).trim();
        if (!messageId) return { tool: name, ok: false, error: 'message_id 不能为空（回退哪条消息）' };
        const r = await bridge.revertMessage(agent, instance, sessionId, messageId);
        return { tool: name, ok: r.ok, instance, session: sessionId, ...(r.ok ? {} : { error: r.error }) };
      }

      case 'oc_diff': {
        if (!instance || !sessionId) return { tool: name, ok: false, error: 'instance 与 session_id 均不能为空' };
        const r = await bridge.sessionDiff(agent, instance, sessionId);
        return { tool: name, ok: r.ok, instance, session: sessionId, ...(r.ok ? { diff: r.data, ...(r.truncated ? { truncated: true } : {}) } : { error: r.error }) };
      }

      case 'oc_permission': {
        if (!instance || !sessionId) return { tool: name, ok: false, error: 'instance 与 session_id 均不能为空' };
        const pid = str(call.permission_id ?? call.permissionId, 100).trim();
        if (!pid) return { tool: name, ok: false, error: 'permission_id 不能为空' };
        const response = str(call.response, 20).trim();
        if (response !== 'once' && response !== 'always' && response !== 'reject') {
          return { tool: name, ok: false, error: "response 必须是 once | always | reject" };
        }
        const r = await bridge.answerPermission(agent, instance, sessionId, pid, response);
        return { tool: name, ok: r.ok, instance, session: sessionId, ...(r.ok ? {} : { error: r.error }) };
      }

      case 'oc_shell': {
        if (!instance || !sessionId) return { tool: name, ok: false, error: 'instance 与 session_id 均不能为空' };
        const command = str(call.command, 2000).trim();
        if (!command) return { tool: name, ok: false, error: 'command 不能为空' };
        const r = await bridge.runShell(agent, instance, sessionId, command);
        return { tool: name, ok: r.ok, instance, session: sessionId, ...(r.ok ? { output: r.data } : { error: r.error }) };
      }

      default:
        return { tool: name, ok: false, error: `未知 oc 工具 ${name}（可用：${OC_TOOL_NAMES.join('/')}）` };
    }
  } catch (e: any) {
    return { tool: name, ok: false, error: String(e?.message || e).slice(0, 200) };
  }
}

/** model 参数兼容三种写法：{providerID,modelID} 直穿 / 池内模型名（managed）/ opencode 原生 'provider/model'（attached）。
 *  返回 error 时调用方应软拒绝并提示可用模型。 */
function resolveModelArg(bridge: OpencodeBridge, instance: string, v: unknown): { ref?: { providerID: string; modelID: string }; error?: string } {
  if (!v) return {};
  if (typeof v === 'string') {
    const name = v.trim();
    if (!name) return {};
    const ref = bridge.resolveModel(instance, name);
    if (!ref) {
      const avail = bridge.listModelsForAgent().find((m) => m.instance === instance);
      const hint = avail?.models.length ? `managed 实例可注入模型：${avail.models.slice(0, 12).join(', ')}` : 'attached 实例请用 opencode 原生格式 provider/model（如 deepseek/deepseek-v4-flash）';
      return { error: `模型 ${name} 无法解析：${hint}` };
    }
    return { ref };
  }
  if (typeof v === 'object') {
    const o = v as Record<string, unknown>;
    const providerID = String(o.providerID ?? o.provider ?? '');
    const modelID = String(o.modelID ?? o.model ?? '');
    if (providerID && modelID) return { ref: { providerID, modelID } };
  }
  return { error: 'model 参数必须是模型名字符串或 {providerID, modelID}' };
}

/** model 参数兼容三种写法：字符串池内模型名 / {providerID,modelID} / {provider,model} */
function parseModelRef(v: unknown): { providerID: string; modelID: string } | undefined {
  if (!v) return undefined;
  if (typeof v === 'string') return undefined; // 字符串名由调用方经 bridge.resolveModel 解析
  if (typeof v === 'object') {
    const o = v as Record<string, unknown>;
    const providerID = String(o.providerID ?? o.provider ?? '');
    const modelID = String(o.modelID ?? o.model ?? '');
    if (providerID && modelID) return { providerID, modelID };
  }
  return undefined;
}
