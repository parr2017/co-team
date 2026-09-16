/**
 * MCP transport 工厂：按 server 配置创建 stdio（本地进程）或 Streamable HTTP（远程）传输。
 * 密钥纪律：env/headers 的值支持 ${ENV_VAR} 占位，在这里展开——密钥只走环境变量，不落 config.yaml。
 */
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { McpServerConfig } from './types';

/** 展开 value 里的 ${VAR} 占位；未定义的变量原样保留（启动日志会看到，便于排查漏配） */
export function expandEnvPlaceholders(value: string): string {
  return String(value).replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (raw, name: string) => process.env[name] ?? raw);
}

export function createTransport(cfg: McpServerConfig): Transport {
  if (cfg.type === 'http') {
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(cfg.headers || {})) headers[k] = expandEnvPlaceholders(v);
    return new StreamableHTTPClientTransport(new URL(cfg.url!), {
      requestInit: Object.keys(headers).length ? { headers } : undefined,
    });
  }
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(cfg.env || {})) env[k] = expandEnvPlaceholders(v);
  return new StdioClientTransport({
    command: cfg.command!,
    args: cfg.args || [],
    ...(Object.keys(env).length ? { env } : {}),
    ...(cfg.cwd ? { cwd: cfg.cwd } : {}),
    stderr: 'pipe',
  });
}
