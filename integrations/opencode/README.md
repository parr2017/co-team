# co-team × opencode 接入（W3 反向层）

co-team 不再只是被 opencode 接管的「后端」，它同时把自己暴露成一个 **MCP server**：opencode（或任何 MCP client）可以直接调用 co-team 的能力——列任务、看任务详情、建任务、检索知识库、看 agent 清单。

- 服务端：`server/src/mcpServer/`（Streamable HTTP，挂载点 `/mcp/coteam`）
- 客户端样例：`integrations/opencode/coteam-bridge.ts`（opencode 插件，任务事件 toast 回显）

---

## 1. 前置条件

1. co-team 服务已启动（`npm start` 或 `node server/dist/index.js`），dashboard 端口以实际配置为准（`config/config.yaml` 的 `dashboard.port`，缺省 **8855**）。
2. **`config/config.yaml` 的 `dashboard.token` 必须已配置**。co-team 的 MCP endpoint 复用该 token 做门禁；未配置时 endpoint 返回 503 并拒绝一切请求（写能力不外露）。

```yaml
dashboard:
  host: 127.0.0.1
  port: 8855
  token: <你的 token>
```

> 安全提示：MCP endpoint 与 dashboard 同端口同门禁，`coteam_create_task` 具备写能力。建议 `dashboard.host` 只绑 `127.0.0.1`；如需跨机访问，请把 token 当作口令管理。

---

## 2. 在 opencode 里配置 co-team 为 remote MCP server

编辑 `opencode.json`（项目根目录或 `~/.config/opencode/opencode.json`）：

```json
{
  "mcp": {
    "coteam": {
      "type": "remote",
      "url": "http://127.0.0.1:8855/mcp/coteam",
      "headers": {
        "Authorization": "Bearer <你的 dashboard.token>"
      }
    }
  }
}
```

- `url` 的端口按 co-team 实际 dashboard 端口修改（缺省 8855）；路径固定 `/mcp/coteam`。
- 配置后 opencode 会在会话里看到 5 个 `coteam_*` 工具，模型可直接调用。

### 5 个工具用法示例

对 opencode 的 agent 这样说即可（对应 JSON-RPC `tools/call` 参数）：

| 工具 | 参数 | 作用 | 示例问法 |
| --- | --- | --- | --- |
| `coteam_list_tasks` | `limit?`（1-50，缺省 20） | 列出最近任务（id/标题/状态/项目/创建时间） | 「列出 co-team 上最近的任务」 |
| `coteam_get_task` | `task_id`（必填） | 任务状态摘要（各节点 id/名称/状态/执行 agent） | 「看看 co-team 任务 abc12345 进展到哪了」 |
| `coteam_create_task` | `title`（必填），`description?`、`workspace?`、`agent?` | 创建任务草稿（**只落库，不自动执行**） | 「在 co-team 建个任务：给登录页补单元测试」 |
| `coteam_search_knowledge` | `query`（必填），`limit?`（1-10，缺省 5） | 混合检索知识库（关键词+语义，正文截断 1200 字） | 「查一下 co-team 知识库里关于 vitest 并行的经验」 |
| `coteam_list_agents` | 无 | agent 清单（名称/角色/描述） | 「co-team 有哪些 agent 可用」 |

`coteam_create_task` 创建的语义要点：

- 只落一个单节点 `pending` 任务，**不规划、不执行**——执行是人工动作：
  调 co-team 的 `POST /api/tasks/<task_id>/execute`（同样需要 Bearer token），或在 co-team 界面点「发车」。
- `workspace` 缺省为 `projects.root` 下的 slug 目录；传了就必须是绝对路径，且不得位于 co-team 自身仓库或其他 git 仓库工作树内（与界面建任务的治理规则一致）。
- `agent` 必须是 `coteam_list_agents` 里的名字（缺省 `dev`）。

### curl 自测

```bash
# initialize（应返回 serverInfo.name = "co-team"）
curl -X POST http://127.0.0.1:8855/mcp/coteam \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"curl","version":"0"}}}'

# tools/list / tools/call 同理换 method 与 params
```

---

## 3. 安装 coteam-bridge 插件（任务事件 toast 回显）

插件能力：启动时探测 co-team 连通性；随后轮询 `/api/tasks`，把**新任务与状态变化**以 toast 形式回显到 opencode TUI。探测失败静默降级（不报错、不挂 hook）。

```bash
# 项目级（随项目走）
mkdir -p .opencode/plugins
cp integrations/opencode/coteam-bridge.ts .opencode/plugins/

# 或全局
mkdir -p ~/.config/opencode/plugins
cp integrations/opencode/coteam-bridge.ts ~/.config/opencode/plugins/
```

环境变量（opencode 启动前设置，或写进 shell 配置 / `.env` 由 opencode 注入）：

| 变量 | 缺省 | 说明 |
| --- | --- | --- |
| `COTEAM_URL` | `http://127.0.0.1:8855` | co-team dashboard 根地址（不带结尾斜杠） |
| `COTEAM_TOKEN` | 空 | dashboard.token；dashboard 若未配 token，`/api` 不门禁但 MCP endpoint 会 503 关门 |
| `COTEAM_POLL_MS` | `8000` | 轮询间隔（下限 2000ms） |
| `COTEAM_PROBE_TIMEOUT_MS` | `5000` | 探测/轮询超时 |

重启 opencode 后，连接成功会弹一条 `co-team 已连接` 的 toast；之后任务状态每次变化弹一条（如「co-team 任务 abc12345「给登录页补测试」：执行中」）。

> 插件是纯 HTTP 管道示例，不依赖 co-team 源码；想改成推送（WS `/ws/events`）或回写事件，在同目录改 `fetchTasks`/`poll` 即可。

---

## 4. 故障排查

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| 所有请求返回 503，body 提示 `dashboard.token 未配置` | co-team 未配 token（有意为之：无门禁不外露写能力） | 在 `config/config.yaml` 的 `dashboard` 节配 token 并重启 |
| 401 `unauthorized` | 请求头 token 与 `dashboard.token` 不一致（大小写/前后空格/Bearer 拼写） | 核对 `Authorization: Bearer <token>` 完整一致 |
| 连接被拒 / `fetch failed` | 端口不对或 co-team 未启动 | 确认 `dashboard.port`；`curl http://127.0.0.1:<port>/api/status` 自检服务活着 |
| opencode 看不到 `coteam_*` 工具 | opencode.json 的 `mcp.coteam` 未生效（格式/路径） | 确认 `url` 以 `/mcp/coteam` 结尾；重启 opencode；看其 MCP 日志 |
| 插件一直没弹 toast | 探测失败已静默降级（co-team 没起/token 不对/`COTEAM_URL` 错） | 先用第 2 节 curl 自测 MCP endpoint；再检查插件环境变量 |
| `tools/call` 返回 `isError: true` | 工具内软错误：参数缺失/类型错、任务不存在、agent 不存在、workspace 不合规 | 消息是可读中文，按提示修正参数重试 |

---

## 5. 实现备注（给维护者）

- 挂载点由 co-team 启动装配一行引入：`registerCoteamMcpRoutes(app, ctx)`（`server/src/api/index.ts` 内，与 `registerConvoRoutes` 并列）。
- 传输为 **stateless** Streamable HTTP + JSON 响应：每次请求一个全新 server 实例，无会话内存增长；GET（独立 SSE 流）返回 405。
- 鉴权中间件只作用于 `/mcp/coteam` 子树（独立 Hono 子 app），不影响 `/api` 既有门禁。
- 工具白名单最小化（4 只读 + 1 创建）；handler 内全软错误收口，单次结果截断 16000 字符，测试见 `server/test/mcpServer.test.ts`。
