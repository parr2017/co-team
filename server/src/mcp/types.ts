/**
 * MCP（Model Context Protocol）客户端层 —— 类型定义。
 * co-team 作为 MCP client 接入外部 server（stdio 本地进程 / Streamable HTTP 远程），
 * 把对方工具以 `mcp__<server>__<tool>` 暴露给 Agent。
 */

/** 单个外部 MCP server 的连接配置（config.yaml 的 mcp.servers[] 条目） */
export interface McpServerConfig {
  /** 全小写 kebab 标识，agent.yaml 的 mcp_servers 用此名引用 */
  name: string;
  /** stdio = 本地命令行进程；http = Streamable HTTP 远程端点 */
  type: 'stdio' | 'http';
  /** 缺省 true；false 仅保留配置不连接、不注入、不可调用 */
  enabled?: boolean;
  /** stdio：启动命令（如 npx） */
  command?: string;
  /** stdio：命令参数 */
  args?: string[];
  /** stdio：附加环境变量（值支持 ${ENV_VAR} 占位——密钥只走环境变量） */
  env?: Record<string, string>;
  /** stdio：工作目录（缺省项目根） */
  cwd?: string;
  /** http：Streamable HTTP 端点 */
  url?: string;
  /** http：请求头（值支持 ${ENV_VAR} 占位，如 ${COTEAM_MCP_GITHUB_TOKEN}） */
  headers?: Record<string, string>;
  /** 单次调用结果截断预算（字符），缺省 16000（对齐单文件读取预算） */
  max_result_chars?: number;
  /** 单次工具调用超时（秒），缺省 60 */
  timeout_sec?: number;
  /** 工具级白名单（小写比较），缺省=该 server 全部工具 */
  allow_tools?: string[];
}

export const DEFAULT_MCP_MAX_RESULT_CHARS = 16000;
export const DEFAULT_MCP_TIMEOUT_SEC = 60;

/** 暴露给模型侧的工具条目（注册表快照） */
export interface McpToolInfo {
  server: string;
  /** MCP 原始工具名（保留大小写） */
  tool: string;
  description?: string;
  inputSchema?: unknown;
}

/** 一次 mcp__ 调用的统一结果（tools.ts 转成 {tool, ok, ...} 回喂） */
export interface McpCallResult {
  ok: boolean;
  /** text content 合并后的文本（已按 max_result_chars 截断） */
  text?: string;
  error?: string;
  truncated?: boolean;
}

/** 运行时连接状态（/api/config/mcp 与 /api/status 用） */
export interface McpServerStatus {
  name: string;
  type: 'stdio' | 'http';
  enabled: boolean;
  connected: boolean;
  error?: string;
  toolCount: number;
}

/**
 * 桥接口：tools.ts 只依赖本接口保持无状态（同 AskBridge/VisionBridge 模式），
 * orchestrator/discussion 注入 McpManager 实现；缺桥即软错误门控。
 */
export interface McpBridge {
  /** agent 可用的工具清单（server 白名单 ∩ allow_tools ∩ 已连接）；用于教学注入 */
  listToolsForAgent(agent: string): McpToolInfo[];
  /** 渲染教学块（确定性、同 agent 同配置字节稳定；无可用工具返回空串） */
  toolsIndex(agent: string): string;
  /** 转发一次工具调用；任何异常都在实现内转 {ok:false,error}，绝不 throw */
  callTool(agent: string, server: string, tool: string, args: Record<string, unknown>): Promise<McpCallResult>;
}
