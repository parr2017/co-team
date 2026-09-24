/**
 * coteam-bridge —— opencode 插件样例：把 co-team 的任务事件以 toast 回显到 opencode TUI。
 *
 * 定位（W3 反向层的客户端管道示例）：
 * - opencode 通过 remote MCP（opencode.json 的 mcp.coteam）调用 co-team 的工具，见同目录 README；
 * - 本插件只做「事件回显管道」：启动时探测 co-team 的 /mcp/coteam 连通性，随后轮询
 *   /api/tasks，把新任务与状态变化以 toast 形式推到 TUI；
 * - 纯 HTTP 客户端，不依赖 co-team 源码，不 import co-team 任何模块；
 * - 探测失败 / 接口抖动一律静默降级（去掉全部 hook），绝不向 opencode 抛错。
 *
 * 安装：拷贝到 .opencode/plugins/（项目级）或 ~/.config/opencode/plugins/（全局）。
 * 配置：环境变量 COTEAM_URL / COTEAM_TOKEN（见 README.md）。
 */

interface Ctx {
  client?: {
    tui?: {
      showToast?: (opts: {
        body: { message: string; variant?: 'info' | 'success' | 'warning' | 'error' };
      }) => Promise<unknown>;
    };
  };
  $?: unknown;
  directory?: string;
  worktree?: string;
  project?: unknown;
}

const COTEAM_URL = (process.env.COTEAM_URL || 'http://127.0.0.1:8855').replace(/\/+$/, '');
const COTEAM_TOKEN = process.env.COTEAM_TOKEN || '';
const PROBE_TIMEOUT_MS = Number(process.env.COTEAM_PROBE_TIMEOUT_MS || 5000);
const POLL_MS = Number(process.env.COTEAM_POLL_MS || 8000);

/** 任务状态 → toast 文案与级别（co-team 侧状态机语义） */
function statusLabel(status: string): { text: string; variant: 'info' | 'success' | 'warning' } {
  switch (status) {
    case 'success':
    case 'completed_with_warnings':
      return { text: '已完成', variant: 'success' };
    case 'failed':
    case 'interrupted':
      return { text: '失败/中断', variant: 'warning' };
    case 'running':
      return { text: '执行中', variant: 'info' };
    case 'planned':
      return { text: '已规划待审', variant: 'info' };
    case 'queued':
      return { text: '排队中', variant: 'info' };
    default:
      return { text: status, variant: 'info' };
  }
}

function authHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return {
    ...(COTEAM_TOKEN ? { Authorization: `Bearer ${COTEAM_TOKEN}` } : {}),
    ...extra,
  };
}

/**
 * 探测 co-team 的 MCP endpoint（JSON-RPC initialize）。
 * 返回 false = 降级（co-team 未启动 / token 不对 / 端口不对——都不报错，只是不挂 hook）。
 */
async function probeCoteam(): Promise<boolean> {
  try {
    const res = await fetch(`${COTEAM_URL}/mcp/coteam`, {
      method: 'POST',
      headers: authHeaders({
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
      }),
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 'coteam-bridge', version: '0.1.0' },
        },
      }),
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    if (!res.ok) return false;
    const text = await res.text();
    try {
      const body = JSON.parse(text);
      return body?.result?.serverInfo?.name === 'co-team';
    } catch {
      // 服务端若以 SSE 流响应，退化为文本包含判断
      return /"name"\s*:\s*"co-team"/.test(text);
    }
  } catch {
    return false;
  }
}

async function toast(
  client: Ctx['client'],
  message: string,
  variant: 'info' | 'success' | 'warning' = 'info',
): Promise<void> {
  try {
    await client?.tui?.showToast?.({ body: { message, variant } });
  } catch {
    // TUI 不可用（CLI/Web 模式）时静默丢弃——toast 只是锦上添花
  }
}

/** 拉取最近任务；任何失败都返回 null（调用方静默跳过本轮） */
async function fetchTasks(): Promise<{ task_id: string; description: string; status: string }[] | null> {
  try {
    const res = await fetch(`${COTEAM_URL}/api/tasks?pageSize=20`, {
      headers: authHeaders({ Accept: 'application/json' }),
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const body = await res.json();
    return Array.isArray(body?.tasks) ? body.tasks : [];
  } catch {
    return null;
  }
}

export const CoteamBridge = async (ctx: Ctx) => {
  // 启动探测：失败即静默降级（返回空 hooks，opencode 无感知）
  if (!(await probeCoteam())) return {};

  await toast(ctx.client, `co-team 已连接（${COTEAM_URL}）`, 'success');

  // task_id → 上一次见到的状态；首轮只播种不播报，避免启动时 20 连发
  const seen = new Map<string, string>();
  let seeded = false;

  const poll = async () => {
    const tasks = await fetchTasks();
    if (!tasks) return;
    for (const t of tasks) {
      const prev = seen.get(t.task_id);
      seen.set(t.task_id, t.status);
      if (!seeded || prev === t.status) continue;
      const label = statusLabel(t.status);
      const title = (t.description || '').split('\n')[0].trim().slice(0, 40) || t.task_id;
      await toast(ctx.client, `co-team 任务 ${t.task_id}「${title}」：${label.text}`, label.variant);
    }
    seeded = true;
  };

  const timer = setInterval(() => void poll(), Math.max(2000, POLL_MS));
  timer.unref?.(); // 不挂住 opencode 退出

  return {
    // 事件面留作扩展点（如把 opencode 会话事件回写 co-team）；当前只做轮询回显
    event: async () => {},
  };
};

// 注意：只用命名导出（opencode 插件规范：一个模块导出若干插件函数，逐个注册；
// 若再 export default 同一函数，部分加载器会重复注册导致 toast 双弹）
