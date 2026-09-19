/**
 * McpManager —— MCP 客户端生命周期与工具注册表。
 *
 * 职责：
 * - 按配置连接全部启用的外部 MCP server（stdio / Streamable HTTP），失败标 unavailable + 退避重试，
 *   绝不影响主链路启动（Redis bus 降级先例）；
 * - 维护工具注册表（原始名 + 小写归一映射，对齐 applyToolCalls 的 lowerCase 纪律）；
 * - 转发工具调用并做软错误收口：任何异常都转 {ok:false,error}，绝不 throw 穿透；
 * - applyConfig 支持保存即热生效（差异重连，不动未变更的 server）；
 * - 按 agent 白名单过滤可见工具（agent.yaml 的 mcp_servers，默认不可见）。
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { getLogger, type Logger } from '../logger';
import { createTransport } from './transports';
import {
  DEFAULT_MCP_MAX_RESULT_CHARS,
  DEFAULT_MCP_TIMEOUT_SEC,
  type McpBridge,
  type McpCallResult,
  type McpServerConfig,
  type McpServerStatus,
  type McpToolInfo,
} from './types';

const CONNECT_TIMEOUT_MS = 10_000;
const RETRY_DELAYS_MS = [5_000, 15_000, 30_000, 60_000, 120_000];
const MCP_BLOCK_MAX_CHARS = 2000;

interface Conn {
  cfg: McpServerConfig;
  client?: Client;
  connected: boolean;
  error?: string;
  /** 注册表快照（原始大小写） */
  tools: McpToolInfo[];
  /** 小写工具名 → 原始工具名（模型侧教学名统一小写） */
  toolIndex: Map<string, string>;
  retries: number;
  retryTimer?: NodeJS.Timeout;
  /** 配置指纹：applyConfig 差异比较用 */
  fingerprint: string;
}

export class McpManager implements McpBridge {
  private conns = new Map<string, Conn>();
  private logger: Logger;
  /** agent → 可用 server 名列表（agent.yaml 的 mcp_servers）；缺省/未注册 → 不可见（安全默认） */
  private agentServers?: (agent: string) => string[] | undefined;
  private stopped = false;

  constructor(servers: McpServerConfig[] = [], logger?: Logger) {
    this.logger = logger ?? getLogger();
    for (const cfg of servers) this.conns.set(cfg.name, this.newConn(cfg));
  }

  /** 由 orchestrator 装配：返回该 agent 的 mcp_servers 白名单（undefined=未配置=不可见） */
  setAgentServersProvider(fn: (agent: string) => string[] | undefined): void {
    this.agentServers = fn;
  }

  private newConn(cfg: McpServerConfig): Conn {
    return { cfg, connected: false, tools: [], toolIndex: new Map(), retries: 0, fingerprint: JSON.stringify(cfg) };
  }

  /** 启动连接：不 await 全部完成——单个 server 连不上只记日志 + 重试，绝不阻塞启动 */
  start(): void {
    for (const conn of this.conns.values()) {
      if (conn.cfg.enabled !== false) void this.connect(conn);
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    for (const conn of this.conns.values()) {
      if (conn.retryTimer) clearTimeout(conn.retryTimer);
      await this.closeClient(conn);
    }
  }

  /** 保存即热生效：diff 配置——新增/变更的重连，删除/禁用的断开，未变更的不动 */
  async applyConfig(servers: McpServerConfig[]): Promise<void> {
    this.stopped = false;
    const next = new Map<string, McpServerConfig>();
    for (const cfg of servers) next.set(cfg.name, cfg);

    for (const [name, conn] of this.conns) {
      const cfg = next.get(name);
      if (!cfg || JSON.stringify(cfg) !== conn.fingerprint) {
        if (conn.retryTimer) clearTimeout(conn.retryTimer);
        await this.closeClient(conn);
        this.conns.delete(name);
      }
    }
    for (const cfg of next.values()) {
      const existing = this.conns.get(cfg.name);
      if (existing && JSON.stringify(cfg) === existing.fingerprint) continue;
      const conn = existing ? Object.assign(existing, { cfg, fingerprint: JSON.stringify(cfg) }) : this.newConn(cfg);
      if (!existing) this.conns.set(cfg.name, conn);
      await this.closeClient(conn);
      conn.connected = false;
      conn.error = undefined;
      conn.tools = [];
      conn.toolIndex = new Map();
      if (cfg.enabled !== false) void this.connect(conn);
    }
  }

  /** transport 工厂（测试缝：子类覆盖可注入 InMemoryTransport） */
  protected createTransport(cfg: McpServerConfig): Transport {
    return createTransport(cfg);
  }

  private async closeClient(conn: Conn): Promise<void> {
    if (!conn.client) return;
    const client = conn.client;
    conn.client = undefined;
    try {
      await client.close();
    } catch {
      // 关闭失败不影响重建
    }
  }

  private async connect(conn: Conn): Promise<void> {
    if (this.stopped || conn.cfg.enabled === false) return;
    const cfg = conn.cfg;
    try {
      const client = new Client({ name: 'co-team', version: '0.2.0' });
      const transport = this.createTransport(cfg);
      await withTimeout(client.connect(transport), CONNECT_TIMEOUT_MS, `连接超时（${CONNECT_TIMEOUT_MS / 1000}s）`);
      const listed = await withTimeout(client.listTools(), CONNECT_TIMEOUT_MS, 'listTools 超时');
      conn.client = client;
      conn.connected = true;
      conn.error = undefined;
      conn.retries = 0;
      conn.tools = (listed.tools || []).map((t) => ({
        server: cfg.name,
        tool: t.name,
        ...(t.description ? { description: t.description } : {}),
        ...(t.inputSchema ? { inputSchema: t.inputSchema } : {}),
      }));
      conn.toolIndex = new Map(conn.tools.map((t) => [t.tool.toLowerCase(), t.tool]));
      this.logger.info('MCP server connected', { server: cfg.name, type: cfg.type, tools: conn.tools.length });
      client.onerror = (e) => this.onDisconnect(conn, e instanceof Error ? e.message : String(e));
      client.onclose = () => this.onDisconnect(conn, '连接已关闭');
    } catch (e: any) {
      this.onDisconnect(conn, String(e?.message || e));
    }
  }

  private onDisconnect(conn: Conn, message: string): void {
    const wasConnected = conn.connected;
    conn.connected = false;
    conn.error = message;
    conn.tools = [];
    conn.toolIndex = new Map();
    void this.closeClient(conn);
    if (this.stopped || conn.cfg.enabled === false) return;
    if (wasConnected) this.logger.warn('MCP server disconnected', { server: conn.cfg.name, error: message });
    const delay = RETRY_DELAYS_MS[Math.min(conn.retries, RETRY_DELAYS_MS.length - 1)];
    conn.retries += 1;
    if (conn.retryTimer) clearTimeout(conn.retryTimer);
    conn.retryTimer = setTimeout(() => void this.connect(conn), delay);
    if (wasConnected) this.logger.info('MCP reconnect scheduled', { server: conn.cfg.name, delayMs: delay });
  }

  // ---------- McpBridge ----------

  private agentAllowed(agent: string, serverName: string): boolean {
    const allowed = this.agentServers?.(agent);
    if (!Array.isArray(allowed)) return false;
    // '*' 通配：协作会话主 agent（partner）等"面向用户的通用 agent"可见全部已配置服务
    if (allowed.includes('*')) return true;
    return allowed.includes(serverName);
  }

  /** agent 可见且已连接的工具（server 白名单 ∩ allow_tools） */
  listToolsForAgent(agent: string): McpToolInfo[] {
    const out: McpToolInfo[] = [];
    for (const conn of this.conns.values()) {
      if (!conn.connected || !this.agentAllowed(agent, conn.cfg.name)) continue;
      for (const t of conn.tools) {
        if (toolAllowed(conn.cfg, t.tool)) out.push(t);
      }
    }
    return out;
  }

  /** 教学块（确定性渲染：同 agent 同配置字节稳定；无可用工具返回空串） */
  toolsIndex(agent: string): string {
    const byServer = new Map<string, McpToolInfo[]>();
    for (const t of this.listToolsForAgent(agent)) {
      const list = byServer.get(t.server) || [];
      list.push(t);
      byServer.set(t.server, list);
    }
    if (!byServer.size) return '';
    const lines: string[] = [];
    for (const [server, tools] of byServer) {
      lines.push(`服务器 ${server}：`);
      for (const t of tools) lines.push(`- mcp__${server}__${t.tool.toLowerCase()}：${(t.description || '（无描述）').replace(/\s+/g, ' ').slice(0, 160)}`);
    }
    const first = [...byServer.values()][0]?.[0];
    if (first) {
      lines.push(`外部 MCP 工具调用示例（参数放独立 arguments 字段，返回 JSON 时附带 tool_calls）：`);
      lines.push(` {"tool_calls":[{"tool":"mcp__${first.server}__${first.tool.toLowerCase()}","arguments":{...}}]}`);
    }
    const body = lines.join('\n');
    return body.length > MCP_BLOCK_MAX_CHARS ? `${body.slice(0, MCP_BLOCK_MAX_CHARS)}\n…（MCP 工具清单超长已截断）` : body;
  }

  /** 转发一次调用：门控（桥/白名单/allow_tools/在线）→ SDK callTool → 结果软收口+截断 */
  async callTool(agent: string, server: string, tool: string, args: Record<string, unknown>): Promise<McpCallResult> {
    const conn = this.conns.get(server);
    if (!conn) return { ok: false, error: `未配置的 MCP 服务: ${server}` };
    if (conn.cfg.enabled === false) return { ok: false, error: `MCP 服务 ${server} 已禁用` };
    if (!this.agentAllowed(agent, server)) return { ok: false, error: `当前 agent 未绑定 MCP 服务 ${server}（agent.yaml 的 mcp_servers）` };
    if (!conn.connected || !conn.client) return { ok: false, error: `MCP 服务 ${server} 未连接：${conn.error || '连接中或不可达'}` };
    const original = conn.toolIndex.get(tool.toLowerCase());
    if (!original) return { ok: false, error: `MCP 服务 ${server} 没有工具 ${tool}` };
    if (!toolAllowed(conn.cfg, original)) return { ok: false, error: `工具 ${tool} 不在服务 ${server} 的 allow_tools 白名单内` };
    try {
      const timeoutMs = (conn.cfg.timeout_sec ?? DEFAULT_MCP_TIMEOUT_SEC) * 1000;
      const res = await withTimeout(
        conn.client.callTool({ name: original, arguments: args || {} }, undefined, { timeout: timeoutMs }),
        timeoutMs + 2000,
        '调用超时',
      );
      if (res.isError) {
        return { ok: false, error: summarizeContent(res.content) || 'MCP 工具返回错误' };
      }
      const maxChars = conn.cfg.max_result_chars ?? DEFAULT_MCP_MAX_RESULT_CHARS;
      let text = summarizeContent(res.content, maxChars);
      if (res.structuredContent) {
        const structured = JSON.stringify(res.structuredContent);
        text = text ? `${text}\nstructured: ${structured}` : `structured: ${structured}`;
      }
      const truncated = text.length > maxChars;
      return { ok: true, text: truncated ? `${text.slice(0, maxChars)}\n…（结果超长已截断到 ${maxChars} 字符，可用更精确参数重取）` : text, ...(truncated ? { truncated: true } : {}) };
    } catch (e: any) {
      return { ok: false, error: String(e?.message || e).slice(0, 300) };
    }
  }

  // ---------- 运行时状态（/api/config/mcp、/api/status 用） ----------

  status(): McpServerStatus[] {
    return [...this.conns.values()].map((conn) => ({
      name: conn.cfg.name,
      type: conn.cfg.type,
      enabled: conn.cfg.enabled !== false,
      connected: conn.connected,
      ...(conn.error ? { error: conn.error } : {}),
      toolCount: conn.tools.length,
    }));
  }

  hasServers(): boolean {
    return this.conns.size > 0;
  }
}

function toolAllowed(cfg: McpServerConfig, toolName: string): boolean {
  if (!cfg.allow_tools?.length) return true;
  return cfg.allow_tools.includes(toolName.toLowerCase());
}

/** 结构校验（PUT /api/config/mcp 与「测试连接」共用）：失败 throw，消息可直接给 UI */
export function validateMcpServerConfigs(list: unknown): McpServerConfig[] {
  if (!Array.isArray(list)) throw new Error('servers 必须是数组');
  const names = new Set<string>();
  const out: McpServerConfig[] = [];
  for (const s of list as Record<string, any>[]) {
    if (!s || typeof s !== 'object') throw new Error('servers 中存在非对象条目');
    const name = String(s.name || '').trim().toLowerCase();
    if (!/^[a-z0-9][a-z0-9_-]*$/.test(name)) throw new Error(`无效服务名 "${String(s.name || '')}"（需小写字母/数字开头，仅含 a-z0-9_-）`);
    if (names.has(name)) throw new Error(`重复的服务名: ${name}`);
    names.add(name);
    const type = s.type === 'http' ? 'http' : 'stdio';
    const cfg: McpServerConfig = { name, type, enabled: s.enabled !== false };
    if (type === 'stdio') {
      if (typeof s.command !== 'string' || !s.command.trim()) throw new Error(`${name}: stdio 服务必须提供 command`);
      cfg.command = s.command.trim();
      if (s.args !== undefined) {
        if (!Array.isArray(s.args) || s.args.some((a: unknown) => typeof a !== 'string')) throw new Error(`${name}: args 必须是字符串数组`);
        cfg.args = s.args.map(String);
      }
      if (s.env !== undefined) {
        if (!s.env || typeof s.env !== 'object' || Array.isArray(s.env)) throw new Error(`${name}: env 必须是对象`);
        cfg.env = Object.fromEntries(Object.entries(s.env).map(([k, v]) => [k, String(v)]));
      }
      if (s.cwd !== undefined) {
        if (typeof s.cwd !== 'string') throw new Error(`${name}: cwd 必须是字符串`);
        cfg.cwd = s.cwd;
      }
    } else {
      if (typeof s.url !== 'string' || !s.url.trim()) throw new Error(`${name}: http 服务必须提供 url`);
      try {
        const u = new URL(s.url.trim());
        if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('bad protocol');
      } catch {
        throw new Error(`${name}: url 必须是合法的 http(s) 地址`);
      }
      cfg.url = s.url.trim();
      if (s.headers !== undefined) {
        if (!s.headers || typeof s.headers !== 'object' || Array.isArray(s.headers)) throw new Error(`${name}: headers 必须是对象`);
        cfg.headers = Object.fromEntries(Object.entries(s.headers).map(([k, v]) => [k, String(v)]));
      }
    }
    if (s.max_result_chars !== undefined) {
      const n = Number(s.max_result_chars);
      if (!Number.isFinite(n) || n <= 0) throw new Error(`${name}: max_result_chars 必须是正数`);
      cfg.max_result_chars = Math.floor(n);
    }
    if (s.timeout_sec !== undefined) {
      const n = Number(s.timeout_sec);
      if (!Number.isFinite(n) || n <= 0) throw new Error(`${name}: timeout_sec 必须是正数`);
      cfg.timeout_sec = Math.floor(n);
    }
    if (s.allow_tools !== undefined) {
      if (!Array.isArray(s.allow_tools)) throw new Error(`${name}: allow_tools 必须是字符串数组`);
      cfg.allow_tools = s.allow_tools.map((t: unknown) => String(t).trim().toLowerCase()).filter(Boolean);
    }
    out.push(cfg);
  }
  return out;
}

/** 一次性连通性探测（UI「测试连接」）：连上 → listTools → 立即关闭，不落盘不进注册表 */
export async function probeMcpServer(cfg: McpServerConfig): Promise<{ ok: boolean; tools?: { name: string; description?: string }[]; error?: string }> {
  if (cfg.enabled === false) return { ok: false, error: '该服务已禁用（enabled: false）' };
  const client = new Client({ name: 'co-team', version: '0.2.0' });
  try {
    await withTimeout(client.connect(createTransport(cfg)), CONNECT_TIMEOUT_MS, `连接超时（${CONNECT_TIMEOUT_MS / 1000}s）——stdio 请确认命令可执行，http 请确认地址可达`);
    const listed = await withTimeout(client.listTools(), CONNECT_TIMEOUT_MS, 'listTools 超时');
    const tools = (listed.tools || []).map((t) => ({ name: t.name, ...(t.description ? { description: t.description } : {}) }));
    return { ok: true, tools };
  } catch (e: any) {
    return { ok: false, error: String(e?.message || e).slice(0, 300) };
  } finally {
    try { await client.close(); } catch { /* 探测收尾，关闭失败忽略 */ }
  }
}

function withTimeout<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    p.then((v) => { clearTimeout(timer); resolve(v); }, (e) => { clearTimeout(timer); reject(e); });
  });
}

/** SDK content blocks → 单段文本：text 合并；image/audio/resource 记占位说明 */
function summarizeContent(content: unknown, maxChars = 4000): string {
  const blocks = Array.isArray((content as any)?.content) ? (content as any).content : Array.isArray(content) ? content : [];
  const parts: string[] = [];
  let budget = maxChars;
  for (const b of blocks) {
    if (typeof b === 'string') { parts.push(b.slice(0, budget)); budget -= b.length; continue; }
    const type = b?.type;
    if (type === 'text' && typeof b.text === 'string') {
      const t = b.text.slice(0, Math.max(0, budget));
      parts.push(t);
      budget -= t.length;
    } else if (type === 'image') {
      parts.push(`[图片内容已省略：${b.mimeType || 'image'} ${String(b.data || '').length}B base64]`);
    } else if (type === 'audio') {
      parts.push(`[音频内容已省略：${b.mimeType || 'audio'}]`);
    } else if (type === 'resource' && b.resource) {
      const r = b.resource;
      parts.push(typeof r.text === 'string' ? `[resource ${r.uri || ''}] ${r.text.slice(0, Math.max(0, budget))}` : `[resource ${r.uri || r.blob ? '(二进制)' : ''}]`);
    } else if (b) {
      parts.push(`[未知内容块 type=${String(type)}]`);
    }
    if (budget <= 0) { parts.push('…（后续内容块因预算截断）'); break; }
  }
  return parts.join('\n').trim();
}
