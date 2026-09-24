/**
 * 原生 function calling 工具 schema 表（opencode/ZCode 同款工具通道）。
 *
 * 把三套引擎（convo / orchestrator / discussion）的散文工具指南提炼为
 * OpenAI tools 声明：工具调用走供应商 tool_calls 结构化通道，正文即回复——
 * 消灭"模型没按 JSON 契约输出 → 解析失败 → 烧一次纠正重试"的浪费。
 * JSON 文本契约路径保留为 fallback（llm.native_tools 关闭时）。
 */
import type { LlmToolSpec } from './llm';
import type { McpManager } from './mcp/manager';

type Params = Record<string, unknown>;

const obj = (props: Params, required: string[], extra: Params = {}): Params => ({
  type: 'object',
  properties: props,
  required,
  additionalProperties: false,
  ...extra,
});

const s = (description: string): Params => ({ type: 'string', description });
const n = (description: string): Params => ({ type: 'number', description });
const strArr = (description: string): Params => ({ type: 'array', items: { type: 'string' }, description });

// ---------- convo 工具集（协作会话，server/src/convo.ts 工具指南） ----------

function convoStaticTools(execTimeoutSec: number): LlmToolSpec[] {
  return [
    { type: 'function', function: { name: 'list_files', description: `列出工作区文件树（只读侦查）`, parameters: obj({}, []) } },
    {
      type: 'function',
      function: {
        name: 'read_file',
        description: `读取工作区内文件内容（大文件按行范围续读）`,
        parameters: obj({ path: s('相对路径'), line_start: n('起始行（可选）'), line_end: n('结束行（可选）') }, ['path']),
      },
    },
    { type: 'function', function: { name: 'read_dir', description: `读取目录列表`, parameters: obj({ path: s('相对目录路径') }, []) } },
    { type: 'function', function: { name: 'grep', description: `按正则搜索工作区文件内容`, parameters: obj({ pattern: s('正则表达式'), path: s('限定子路径（可选）') }, ['pattern']) } },
    { type: 'function', function: { name: 'git_log', description: `查看工作区提交历史`, parameters: obj({}, []) } },
    { type: 'function', function: { name: 'git_diff', description: `查看工作区未提交变更`, parameters: obj({}, []) } },
    { type: 'function', function: { name: 'load_skill', description: `拉取技能正文（正文按需加载）`, parameters: obj({ name: s('技能名') }, ['name']) } },
    { type: 'function', function: { name: 'exec', description: `同步执行命令（≤${execTimeoutSec}s：装依赖、构建、测试、查端口）`, parameters: obj({ command: s('要执行的命令') }, ['command']) } },
    { type: 'function', function: { name: 'exec_background', description: `后台启动长驻命令（返回 pid 与日志路径）`, parameters: obj({ command: s('长驻命令，如 npm run dev') }, ['command']) } },
    { type: 'function', function: { name: 'kill_process', description: `停止后台进程`, parameters: obj({ pid: n('要停止的进程 pid') }, ['pid']) } },
    { type: 'function', function: { name: 'write_file', description: `写入文件全文（改前先读；直接落工作区）`, parameters: obj({ path: s('相对路径'), content: s('文件全文') }, ['path', 'content']) } },
    { type: 'function', function: { name: 'edit_file', description: `对已有文件做精确替换小改动`, parameters: obj({ path: s('相对路径'), find: s('要替换的原文片段（精确唯一）'), replace: s('替换后的文本') }, ['path', 'find', 'replace']) } },
    { type: 'function', function: { name: 'screenshot', description: `Playwright 截图并交视觉模型分析（localhost 页面渲染验证）`, parameters: obj({ url: s('页面 URL（仅 localhost）'), question: s('要确认的视觉问题（可选）') }, ['url']) } },
    { type: 'function', function: { name: 'look_image', description: `分析工作区内图片`, parameters: obj({ path: s('相对路径'), question: s('要确认的问题（可选）') }, ['path']) } },
    { type: 'function', function: { name: 'check_page', description: `渲染页面并断言关键文本（expect 全部命中才 ok）`, parameters: obj({ url: s('页面 URL（仅 localhost）'), expect: strArr('页面渲染后应出现的文本列表') }, ['url', 'expect']) } },
    { type: 'function', function: { name: 'ask_user', description: `阻塞提问：需要用户拍板才能继续时使用`, parameters: obj({ question: s('问题') }, ['question']) } },
    { type: 'function', function: { name: 'write_knowledge', description: `沉淀经验/规范到知识库`, parameters: obj({ category: s('general-tech | project'), title: s('条目标题'), content: s('内容（Markdown）') }, ['category', 'title', 'content']) } },
    { type: 'function', function: { name: 'share_file', description: `把工作区文件作为卡片反馈给用户（可预览下载）`, parameters: obj({ path: s('相对路径') }, ['path']) } },
    { type: 'function', function: { name: 'spawn_agent', description: `调度子智能体并行执行子任务（≤3，各自独立工具循环）`, parameters: obj({ agent: s('子 agent 名（dev|review|docs|test…）'), task: s('明确的子任务描述') }, ['agent', 'task']) } },
    { type: 'function', function: { name: 'write_plan', description: `创建/覆盖会话步骤清单（多环节的活先规划）`, parameters: obj({ steps: strArr('步骤文本列表（3~8 步）') }, ['steps']) } },
    { type: 'function', function: { name: 'update_plan', description: `更新步骤清单状态（每完成一步立即打勾）`, parameters: obj({ index: n('步骤序号（0 起）'), status: s('done | in_progress | blocked') }, ['index', 'status']) } },
  ];
}

// ---------- orchestrator 工具集（任务管线 agent 工具轮，harness L5） ----------

function orchStaticTools(execTimeoutSec: number): LlmToolSpec[] {
  return [
    { type: 'function', function: { name: 'list_files', description: `列出工作区文件树（只读侦查）`, parameters: obj({}, []) } },
    { type: 'function', function: { name: 'read_file', description: `读取文件内容（大文件按行范围续读，先 grep 定位行号）`, parameters: obj({ path: s('相对路径'), line_start: n('起始行（可选）'), line_end: n('结束行（可选）') }, ['path']) } },
    { type: 'function', function: { name: 'read_dir', description: `读取目录列表`, parameters: obj({ path: s('相对目录路径') }, []) } },
    { type: 'function', function: { name: 'grep', description: `按正则搜索文件内容`, parameters: obj({ pattern: s('正则表达式'), path: s('限定子路径（可选）') }, ['pattern']) } },
    { type: 'function', function: { name: 'git_log', description: `查看提交历史`, parameters: obj({}, []) } },
    { type: 'function', function: { name: 'git_diff', description: `查看未提交变更`, parameters: obj({}, []) } },
    { type: 'function', function: { name: 'load_skill', description: `拉取已装载技能的正文（与侦查合并同一轮）`, parameters: obj({ name: s('技能名') }, ['name']) } },
    { type: 'function', function: { name: 'exec', description: `同步执行命令（≤${execTimeoutSec}s：装依赖、构建、测试、查端口）——返回真实 stdout/stderr，验证节点必须用它跑构建/测试/分析并回读输出`, parameters: obj({ command: s('要执行的命令') }, ['command']) } },
    { type: 'function', function: { name: 'exec_background', description: `后台启动长驻命令（返回 pid 与日志路径；不代表已就绪，需再确认）`, parameters: obj({ command: s('长驻命令，如 npm run dev') }, ['command']) } },
    { type: 'function', function: { name: 'kill_process', description: `停止后台进程`, parameters: obj({ pid: n('要停止的进程 pid') }, ['pid']) } },
    { type: 'function', function: { name: 'write_file', description: `写入文件全文（渐进落盘：想清楚一个文件就立即写入）`, parameters: obj({ path: s('相对路径'), content: s('完整文件内容') }, ['path', 'content']) } },
    { type: 'function', function: { name: 'edit_file', description: `对已有文件做精确替换小改动`, parameters: obj({ path: s('相对路径'), find: s('要替换的原文（精确唯一）'), replace: s('替换后的文本') }, ['path', 'find', 'replace']) } },
    { type: 'function', function: { name: 'check_page', description: `渲染页面并断言关键文本（渲染级验证必用；仅 localhost）`, parameters: obj({ url: s('页面 URL'), expect: strArr('应出现的文本列表') }, ['url', 'expect']) } },
    { type: 'function', function: { name: 'screenshot', description: `截图并交视觉模型分析（断言覆盖不了的视觉问题）`, parameters: obj({ url: s('页面 URL'), question: s('要确认的视觉问题（可选）'), window_size: s('模拟视口宽,高（可选）') }, ['url']) } },
    { type: 'function', function: { name: 'look_image', description: `分析工作目录内任意图片`, parameters: obj({ path: s('相对路径'), question: s('要确认的问题（可选）') }, ['path']) } },
    { type: 'function', function: { name: 'write_knowledge', description: `沉淀经验到知识库`, parameters: obj({ category: s('general-tech | project'), title: s('条目标题'), tags: strArr('标签（可选）'), content: s('经验内容（Markdown）') }, ['category', 'title', 'content']) } },
    { type: 'function', function: { name: 'knowledge_search', description: `检索知识库取全文（语义+关键词混合；需要完整经验时用）`, parameters: obj({ query: s('检索问题/关键词') }, ['query']) } },
    { type: 'function', function: { name: 'scratchpad_search', description: `检索任务便签找回早前侦查结论（历史已折叠时用）`, parameters: obj({ query: s('文件路径/命令/主题词') }, ['query']) } },
    { type: 'function', function: { name: 'write_doc', description: `写协作文档（实现 API 后必须更新 API_CONTRACT；产出不计入 changes）`, parameters: obj({ type: s('TASK_SPEC | API_CONTRACT | STATUS_REPORT'), content: s('完整 Markdown 内容') }, ['type', 'content']) } },
    { type: 'function', function: { name: 'send_message', description: `给其他 Agent/主 Agent/用户发留言（收件方下次执行时收到）`, parameters: obj({ to: s('agent名 | orchestrator | user'), text: s('留言内容（≤2000字）') }, ['to', 'text']) } },
    { type: 'function', function: { name: 'ask_user', description: `阻塞提问：需要用户拍板`, parameters: obj({ question: s('问题') }, ['question']) } },
    { type: 'function', function: { name: 'ask_agent', description: `向其他 Agent 提问（实时转交）`, parameters: obj({ to: s('目标 agent 名'), question: s('问题') }, ['to', 'question']) } },
    { type: 'function', function: { name: 'answer', description: `回答其他 Agent 的实时提问（ask_id 原样带回）`, parameters: obj({ ask_id: s('提问的 ask_id'), content: s('回答内容') }, ['ask_id', 'content']) } },
    { type: 'function', function: { name: 'knowledge_search', description: `检索项目/通用知识库取全文（语义+关键词混合；注入条目只有片段，需要完整经验时用本工具）`, parameters: obj({ query: s('检索问题/关键词') }, ['query']) } },
    { type: 'function', function: { name: 'scratchpad_search', description: `检索任务便签找回早前侦查的关键发现（历史已折叠/省略时用）`, parameters: obj({ query: s('文件路径/命令/主题词') }, ['query']) } },
  ];
}

// ---------- discussion 工具集（群组讨论，runSpeakerToolCalls） ----------

function discussionStaticTools(): LlmToolSpec[] {
  return [
    { type: 'function', function: { name: 'list_files', description: `列出项目工作区文件树（侦查）`, parameters: obj({}, []) } },
    { type: 'function', function: { name: 'read_file', description: `读取项目文件内容`, parameters: obj({ path: s('相对路径') }, ['path']) } },
    { type: 'function', function: { name: 'read_dir', description: `读取目录列表`, parameters: obj({ path: s('相对目录路径') }, []) } },
    { type: 'function', function: { name: 'grep', description: `按正则搜索文件内容`, parameters: obj({ pattern: s('正则表达式'), path: s('限定子路径（可选）') }, ['pattern']) } },
    { type: 'function', function: { name: 'git_log', description: `查看提交历史`, parameters: obj({}, []) } },
    { type: 'function', function: { name: 'git_diff', description: `查看未提交变更`, parameters: obj({}, []) } },
    { type: 'function', function: { name: 'exec', description: `同步执行命令（只读侦查/验证类）`, parameters: obj({ command: s('要执行的命令') }, ['command']) } },
    { type: 'function', function: { name: 'check_page', description: `渲染页面并断言关键文本（仅 localhost）`, parameters: obj({ url: s('页面 URL'), expect: strArr('应出现的文本列表') }, ['url', 'expect']) } },
    { type: 'function', function: { name: 'screenshot', description: `截图并交视觉模型分析`, parameters: obj({ url: s('页面 URL'), question: s('要确认的视觉问题（可选）') }, ['url']) } },
    { type: 'function', function: { name: 'look_image', description: `分析项目内图片`, parameters: obj({ path: s('相对路径'), question: s('要确认的问题（可选）') }, ['path']) } },
    { type: 'function', function: { name: 'exec_background', description: `后台启动长驻命令（返回 pid 与日志路径）`, parameters: obj({ command: s('长驻命令') }, ['command']) } },
    { type: 'function', function: { name: 'kill_process', description: `停止后台进程`, parameters: obj({ pid: n('要停止的进程 pid') }, ['pid']) } },
    { type: 'function', function: { name: 'write_file', description: `写入文件全文（小修直干：单轮发言 ≤3 文件且合计 ≤80 行）`, parameters: obj({ path: s('相对路径'), content: s('文件全文') }, ['path', 'content']) } },
    { type: 'function', function: { name: 'edit_file', description: `对已有文件精确替换小改动`, parameters: obj({ path: s('相对路径'), find: s('要替换的原文片段（精确唯一）'), replace: s('替换后的文本') }, ['path', 'find', 'replace']) } },
    { type: 'function', function: { name: 'write_knowledge', description: `沉淀经验到知识库`, parameters: obj({ category: s('general-tech | project'), title: s('条目标题'), content: s('内容（Markdown）') }, ['category', 'title', 'content']) } },
    { type: 'function', function: { name: 'convert_to_project', description: `转项目开发（超出小修预算的大改动；用户已拍板时使用）`, parameters: obj({ auto_run: { type: 'boolean', description: '是否自动入队执行' } }, []) } },
  ];
}

// ---------- MCP 动态工具 ----------

/** MCP 外部工具 → OpenAI schema（无 JSON Schema 元数据时用松散 object 保守兜底）。 */
function mcpTools(mcp: McpManager | undefined, agent: string): LlmToolSpec[] {
  if (!mcp) return [];
  const specs: LlmToolSpec[] = [];
  for (const t of mcp.listToolsForAgent(agent)) {
    specs.push({
      type: 'function',
      function: {
        name: `mcp__${t.server}__${t.tool.toLowerCase()}`,
        description: (t.description || '外部 MCP 工具').replace(/\s+/g, ' ').slice(0, 160),
        parameters: { type: 'object', properties: {}, additionalProperties: true },
      },
    });
  }
  return specs;
}

/** convo 引擎工具声明（静态集 + MCP 动态集）。level 为 plan_only/readonly 时剔除会被
 *  权限直接拒绝的工具（C：不暴露不可用工具，避免模型反复尝试空转、白耗迭代预算）。 */
export function buildConvoTools(opts: { mcp?: McpManager; agentId: string; execTimeoutSec: number; level?: string }): LlmToolSpec[] {
  const all = [...convoStaticTools(opts.execTimeoutSec), ...mcpTools(opts.mcp, opts.agentId)];
  const blocked = opts.level === 'plan_only'
    ? new Set(['exec', 'exec_background', 'kill_process', 'write_file', 'edit_file'])
    : opts.level === 'readonly'
      ? new Set(['write_file', 'edit_file'])
      : null;
  if (!blocked) return all;
  return all.filter((t) => !blocked.has(String((t as { function?: { name?: string } }).function?.name || '')));
}

/** orchestrator 工具轮声明（静态集 + MCP 动态集）。level 为 plan_only/readonly 时剔除会被
 *  权限直接拒绝的工具（同 buildConvoTools：不暴露不可用工具，避免模型反复尝试空转）。 */
export function buildOrchTools(opts: { mcp?: McpManager; agent: string; level?: string; execTimeoutSec?: number }): LlmToolSpec[] {
  const all = [...orchStaticTools(opts.execTimeoutSec ?? 300), ...mcpTools(opts.mcp, opts.agent)];
  const blocked = opts.level === 'plan_only'
    ? new Set(['exec', 'exec_background', 'kill_process', 'write_file', 'edit_file'])
    : opts.level === 'readonly'
      ? new Set(['write_file', 'edit_file'])
      : null;
  if (!blocked) return all;
  return all.filter((t) => !blocked.has(String((t as { function?: { name?: string } }).function?.name || '')));
}

/** discussion 引擎声明（静态集 + MCP 动态集）。 */
export function buildDiscussionTools(opts: { mcp?: McpManager; agent: string }): LlmToolSpec[] {
  return [...discussionStaticTools(), ...mcpTools(opts.mcp, opts.agent)];
}

/** 全局开关（config.yaml llm.native_tools，缺省开；关闭即整体回退 JSON 契约）。 */
let nativeToolsEnabled = process.env.COTEAM_LLM_NATIVE_TOOLS !== '0';

export function configureNativeTools(enabled: boolean): void {
  nativeToolsEnabled = enabled;
}

export function nativeToolsOn(): boolean {
  return nativeToolsEnabled;
}
