/**
 * OpenCode 接管层 —— 类型定义。
 *
 * co-team 作为 opencode server 的"上位控制器"：
 * - managed：co-team  spawn `opencode serve` 并托管生命周期，模型由 co-team 注入（场景 B）；
 * - attached-cli / attached-desktop：接管用户已在跑的 opencode 实例，模型归 opencode（场景 A）。
 *
 * 与 mcp/types.ts 的 McpBridge 同模式：上层引擎只依赖接口，缺桥即软错误门控。
 */

/** 实例类型：managed=co-team 拉起；attached-cli=用户 CLI serve/TUI；attached-desktop=桌面版常驻 service */
export type OpencodeInstanceKind = 'managed' | 'attached-cli' | 'attached-desktop';

/** 控制档位：readonly=只读+审批响应；control=发消息/abort/revert/TUI 驱动（全操作审计） */
export type OpencodeInstanceMode = 'readonly' | 'control';

/** 单个 opencode 实例配置（config.yaml 的 opencode.instances[] 条目） */
export interface OpencodeInstanceConfig {
  /** 实例标识（小写 kebab，agent.yaml 的 opencode_instances 用此名引用） */
  id: string;
  kind: OpencodeInstanceKind;
  label?: string;
  /** 缺省 true；false 保留配置不连接、不注入、不可调用 */
  enabled?: boolean;
  // ---------- managed ----------
  /** 启动命令，缺省 'opencode' */
  command?: string;
  /** 额外启动参数 */
  args?: string[];
  /** 监听端口；缺省/0 = 自动挑选空闲端口 */
  port?: number;
  /** 监听地址，缺省 127.0.0.1 */
  hostname?: string;
  /** serve 进程工作目录（= opencode 的项目根）；managed 必填 */
  project_root?: string;
  /** 附加环境变量（值支持 ${ENV_VAR} 占位——密钥只走环境变量） */
  env?: Record<string, string>;
  /** 模型注入：为实例生成 opencode.json providers（来自 co-team 模型池），prompt 逐条带 model */
  model_injection?: boolean;
  /** 实例随 co-team 启动自动拉起（缺省 true） */
  auto_start?: boolean;
  // ---------- attached ----------
  /** 实例地址；attached-desktop 留空 = 自动发现（解析桌面版日志里的端口） */
  url?: string;
  /** HTTP Basic 鉴权（桌面版 service 默认开启；${ENV_VAR} 占位） */
  auth?: { username?: string; password?: string };
  /** attached 实例控制档位，缺省 readonly */
  mode?: OpencodeInstanceMode;
  // ---------- 通用 ----------
  /** 单次 API 调用超时（秒），缺省 60 */
  timeout_sec?: number;
  /** 单次结果截断预算（字符），缺省 16000 */
  max_result_chars?: number;
  /** agent 可见性白名单来源（agent.yaml 的 opencode_instances）；undefined=由 manager provider 决定 */
  agents?: string[];
  /** 高危：允许通过 /session/:id/shell 执行任意命令（默认 false，且需 control 档） */
  allow_shell?: boolean;
  /** 浏览器直连 SSE 的 CORS 放行源；缺省 = 本地 web(8856)/mobile(8857) dev 源 */
  cors_origins?: string[];
}

export const DEFAULT_OC_TIMEOUT_SEC = 60;
export const DEFAULT_OC_MAX_RESULT_CHARS = 16000;
export const DEFAULT_OC_COMMAND = 'opencode';
export const DEFAULT_OC_HOSTNAME = '127.0.0.1';

/** opencode 会话最小形态（其余字段透传不建模） */
export interface OcSession {
  id: string;
  title?: string;
  parentID?: string;
  [k: string]: unknown;
}

/** 会话状态：busy（执行中）/ idle 等（GET /session/status 的值） */
export type OcSessionStatus = { type: string } & Record<string, unknown>;

/** 统一调用结果（与 McpCallResult 同构：绝不 throw，全部软收口） */
export interface OcCallResult<T = unknown> {
  ok: boolean;
  data?: T;
  error?: string;
  truncated?: boolean;
}

/** 能力探测结果：连接时拉 /doc + /global/health，按端点存在性打标 */
export interface OcCapabilities {
  healthy: boolean;
  version: string;
  /** POST /session/:id/message（同步 prompt） */
  sync_prompt: boolean;
  /** POST /session/:id/prompt_async */
  async_prompt: boolean;
  /** POST /session/:id/abort */
  abort: boolean;
  /** POST /session/:id/revert + unrevert */
  revert: boolean;
  /** GET /session/:id/diff */
  diff: boolean;
  /** POST /session/:id/permissions/:permissionID */
  permissions: boolean;
  /** GET /event（SSE） */
  events: boolean;
  /** POST /session/:id/shell（高危，默认禁用） */
  shell: boolean;
  /** POST /tui/append-prompt 等 */
  tui: boolean;
}

export const EMPTY_CAPABILITIES: OcCapabilities = {
  healthy: false,
  version: '',
  sync_prompt: false,
  async_prompt: false,
  abort: false,
  revert: false,
  diff: false,
  permissions: false,
  events: false,
  shell: false,
  tui: false,
};

/** 运行时实例状态（/api/opencode/instances、/api/status、双端面板用） */
export interface OpencodeInstanceStatus {
  id: string;
  kind: OpencodeInstanceKind;
  label?: string;
  enabled: boolean;
  /** stopped=未启动 starting=拉起中 running=进程在 connected=API 通 error=异常 */
  state: 'stopped' | 'starting' | 'running' | 'connected' | 'error';
  /** 实际连接的 base url（managed 解析端口后回填） */
  url: string;
  mode: OpencodeInstanceMode;
  version: string;
  capabilities?: OcCapabilities;
  /** managed：serve 进程 pid */
  pid?: number;
  /** 项目根（managed 的 cwd；attached 从 /project/current 探测） */
  project_root?: string;
  model_injection: boolean;
  error?: string;
  last_checked_at?: string;
}

/** SSE 事件（GET /event 的单条；type 如 session.idle / message.part.updated / permission.asked） */
export interface OcEvent {
  type: string;
  properties?: Record<string, unknown>;
}

/**
 * 桥接口：上层引擎（tools.ts / convo.ts / discussion.ts）只依赖本接口保持无状态
 * （同 McpBridge 模式），manager 注入实现；缺桥即软错误门控。
 */
export interface OpencodeBridge {
  /** 实例状态清单（可按 agent 可见性过滤；provider 未配置时全部不可见） */
  listInstances(agent?: string): OpencodeInstanceStatus[];
  /** 实例的 capabilities 摘要（教学块/UI 展示"这个实例能干什么"） */
  instanceCapabilities(id: string): OcCapabilities | undefined;
  /** 列会话（title/最近活跃倒序由 opencode 保证） */
  listSessions(agent: string | undefined, instance: string): Promise<OcCallResult<OcSession[]>>;
  /** 建会话（managed 可在 prompt 时指定 model） */
  createSession(agent: string | undefined, instance: string, title?: string): Promise<OcCallResult<OcSession>>;
  /** 读会话消息（{info, parts}[]） */
  readMessages(agent: string | undefined, instance: string, sessionId: string): Promise<OcCallResult<unknown[]>>;
  /** 同步发送：等待 opencode 返回助手消息（run_task 复合工具用） */
  sendPrompt(agent: string | undefined, instance: string, sessionId: string, prompt: string, model?: { providerID: string; modelID: string }, ocAgent?: string): Promise<OcCallResult<unknown>>;
  /** 异步发送：不等结果，靠 SSE 跟踪 */
  sendPromptAsync(agent: string | undefined, instance: string, sessionId: string, prompt: string, model?: { providerID: string; modelID: string }, ocAgent?: string): Promise<OcCallResult<{ messageID?: string }>>;
  /** 打断运行中的会话 */
  abortSession(agent: string | undefined, instance: string, sessionId: string): Promise<OcCallResult<boolean>>;
  /** 回退一条消息（含其后） */
  revertMessage(agent: string | undefined, instance: string, sessionId: string, messageID: string): Promise<OcCallResult<boolean>>;
  /** 会话文件 diff（FileDiff[]） */
  sessionDiff(agent: string | undefined, instance: string, sessionId: string): Promise<OcCallResult<unknown[]>>;
  /** 响应 opencode 的权限请求（response: once|always|reject） */
  answerPermission(agent: string | undefined, instance: string, sessionId: string, permissionID: string, response: 'once' | 'always' | 'reject'): Promise<OcCallResult<boolean>>;
  /** 高危：在 opencode 会话内执行 shell 命令（需实例 allow_shell + control 档，默认禁用） */
  runShell(agent: string | undefined, instance: string, sessionId: string, command: string): Promise<OcCallResult<unknown>>;
  /** 等待会话进入 idle（SSE 事件驱动）：run_task 复合工具的核心等待原语 */
  waitSessionIdle(agent: string | undefined, instance: string, sessionId: string, timeoutMs: number): Promise<OcCallResult<'idle' | 'error'>>;
  /** 教学块（确定性渲染：同 agent 同配置字节稳定；无可用实例返回空串） */
  toolsIndex(agent: string): string;
  /** 可注入模型的 managed 实例及其池内模型名（oc_send/oc_run_task 的 model 参数候选） */
  listModelsForAgent(agent?: string): { instance: string; models: string[] }[];
  /** 模型名 → opencode model ref（仅 model_injection 实例；attached 实例模型归 opencode 返回 undefined） */
  resolveModel(instance: string, modelName: string): { providerID: string; modelID: string } | undefined;
  /** 是否存在 allow_shell 实例（决定 oc_shell 是否进工具声明） */
  hasShellEnabled(agent?: string): boolean;
  /** 会话状态表（busy/idle；TUI 同构的忙碌指示与接管发现） */
  sessionStatus(agent: string | undefined, instance: string): Promise<OcCallResult<Record<string, { type: string }>>>;
  /** 接管当前对话：busy 会话优先，否则最近更新；reason 说明命中原因 */
  activeSession(agent: string | undefined, instance: string): Promise<OcCallResult<{ session: OcSession; reason: 'busy' | 'recent' }>>;
  /** opencode agent 清单（composer 的 agent 下拉） */
  listAgents(agent: string | undefined, instance: string): Promise<OcCallResult<{ name: string; description?: string; mode?: string }[]>>;
  /** providers + 默认模型（attached 实例的模型下拉） */
  listProviders(agent: string | undefined, instance: string): Promise<OcCallResult<{ providers?: unknown[]; default?: Record<string, string> }>>;
  /** 斜杠命令（TUI 的 /命令） */
  runCommand(agent: string | undefined, instance: string, sessionId: string, command: string, args?: string, ocAgent?: string): Promise<OcCallResult<unknown>>;
  /** 会话 todos */
  sessionTodos(agent: string | undefined, instance: string, sessionId: string): Promise<OcCallResult<{ content: string; status: string; priority: string }[]>>;
  /** TUI 驱动：往 TUI 输入框追加文本（control 档） */
  tuiAppend(agent: string | undefined, instance: string, text: string): Promise<OcCallResult<boolean>>;
  /** TUI 驱动：提交 TUI 输入框当前内容（control 档） */
  tuiSubmit(agent: string | undefined, instance: string): Promise<OcCallResult<boolean>>;
  /** TUI 驱动：在 TUI 弹 toast（如"co-team 已接管此对话"） */
  tuiToast(agent: string | undefined, instance: string, message: string, variant?: 'info' | 'success' | 'warning' | 'error'): Promise<OcCallResult<boolean>>;
  /** TUI 驱动：在 TUI 端打开会话选择器 */
  tuiOpenSessions(agent: string | undefined, instance: string): Promise<OcCallResult<boolean>>;
  /** TUI 驱动：把 TUI 导航到指定会话（"让位式接管"：co-team 独占前 TUI 切走） */
  tuiSelectSession(agent: string | undefined, instance: string, sessionId: string): Promise<OcCallResult<boolean>>;
}
