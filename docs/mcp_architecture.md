# MCP 架构：接入外部 MCP 服务（2026-09-16）

co-team 作为 **MCP client** 接入外部 MCP server（stdio 本地进程 / Streamable HTTP 远程），把对方工具以 `mcp__<服务名>__<工具名>` 暴露给 Agent。任务管线与群聊讨论室两处均可调用；配置与状态有 web 管理 UI（设置 → MCP服务），mobile 只读展示连接状态。

## 分层

```
config.yaml mcp.servers ──► config.ts loadConfig（\${ENV_VAR} 密钥占位）
        │
        ▼
server/src/index.ts ──► McpManager（server/src/mcp/manager.ts）
        │                  ├─ 连接生命周期：失败标 unavailable + 退避重试（5s→2min），不阻塞启动
        │                  ├─ 工具注册表：原始名 + 小写归一映射（对齐 applyToolCalls 的 lowerCase 纪律）
        │                  ├─ callTool：门控（agent 白名单 ∩ allow_tools ∩ 在线）→ SDK callTool → 软错误收口 + 结果截断
        │                  ├─ applyConfig：保存即热生效（差异重连，未变更的不动）
        │                  └─ toolsIndex(agent)：教学块确定性渲染（同 agent 同配置字节稳定，前缀缓存友好）
        ├─► Orchestrator（任务管线）
        │     ├─ mcpBlock 注入 harness L3（### 外部 MCP 工具）
        │     ├─ knowledgeCtx 注入 mcp 桥
        │     └─ mcp__ 调用豁免去重（外部工具可能带副作用）
        └─► Discussion（群聊讨论室）
              ├─ speaker 工具面按发言者白名单注入
              └─ runSpeakerToolCalls mcp__ 分支（不依赖项目工作区）

applyToolCalls（server/src/tools.ts）── mcp__<server>__<tool> 分支 ──► McpBridge.callTool
```

## 关键设计决策

| 决策 | 做法 | 为什么 |
|---|---|---|
| 桥注入 | tools.ts 只依赖 `McpBridge` 接口（tools.ts `KnowledgeToolContext.mcp`），orchestrator/discussion 注入 `McpManager` 实现 | 与 AskBridge/VisionBridge 同构；tools.ts 保持无状态、易测试；缺桥/未绑定/未连接一律软错误（`{ok:false}` 回喂，绝不 throw） |
| 命名 | `mcp__<server>__<tool>`，注册表键小写归一 | `applyToolCalls` 对工具名 `toLowerCase()`；模型侧教学名统一小写，bridge 内建小写→原始名映射保住 MCP 大小写敏感工具名 |
| 参数 | 独立 `arguments` 字段（`ToolCall.arguments`） | `name`/`path`/`pattern` 等被既有工具占用；模型没写 arguments 时平铺字段兜底 salvage |
| 白名单 | agent.yaml `mcp_servers`（Agent 编辑框多选写回）+ server 级 `allow_tools` | 外部工具有真实副作用，安全默认不可见 |
| 传输 | stdio（spawn 本地命令，env 注入 `${ENV_VAR}` 展开）+ Streamable HTTP（fetch + headers） | 官方 SDK 原生支持；密钥只走环境变量不落 config.yaml |
| 教学注入 | mcpBlock 注入 harness L3 / discussion 工具面，按 agent 白名单确定性渲染，上限 2000 字符 | MCP 无自带 schema，模型只能靠提示学会调用；确定性生成保 systemMsg 前缀缓存 |
| 结果收口 | text content 合并、按 server `max_result_chars`（缺省 16000）截断并标注、image/audio/resource 记占位、单批回喂仍走 24000 总预算 | 防外部大结果挤爆模型上下文 |
| 去重豁免 | `mcp__` 全部豁免 orchestrator 去重指针 | dedupKey 只含 path/pattern/name，覆盖不到 arguments；同参不同参数会被"结果从略"错吞 |
| 测试桩 | manager 的 `createTransport` 为可覆盖工厂缝 | 测试用 SDK `InMemoryTransport` 起进程内 MCP server，不 spawn 真实进程 |

## API

| 端点 | 说明 |
|---|---|
| `GET /api/config/mcp` | 配置 + 运行时合并视图（per-server：connected/error/toolCount） |
| `PUT /api/config/mcp` | 校验（名称唯一小写、stdio 需 command、http 需合法 url）→ 写回 config.yaml → `applyConfig` 差异热生效 |
| `POST /api/config/mcp/test` | 服务配置快照连通性探测（连接→listTools→立即关闭），**不落盘**；成功带工具数，失败带具体报错 |
| `GET /api/status`（追加字段） | `mcp: McpServerStatus[]` 供 web 状态灯与 mobile 状态列表轮询 |

## UI

- **web**（SettingsDialog「MCP 服务」tab）：服务器表格（名称/类型/目标/状态灯/工具数/启用开关/操作），编辑框 = 基础表单（名称/启用/类型/启动命令+参数 或 地址）+ 可折叠「高级设置（JSON）」（格式化/校验，未过禁存；JSON 优先于表单字段）；底部「测试连接（不落盘）/取消/保存到列表」，保存即热生效；「Agent 管理」编辑框新增「绑定 MCP」多选。
- **mobile**（运行指标页「MCP 服务」区块）：只读状态列表（名称/类型/状态 tag/工具数），管理操作在 web。

## 降级语义

- 未配置 `mcp.servers`：跳过 McpManager，零影响（与旧行为完全一致）。
- server 连接失败：标 unavailable + 退避重试，仅 warn 日志；其工具不注入教学清单、调用返回软错误。
- agent 未绑定：桥内直接拒绝（`当前 agent 未绑定 MCP 服务 ...`）。
- 运行时热更失败：PUT 校验先拦（非法结构 400），不写脏配置。

## 冒烟证据（2026-09-16）

- `npx @modelcontextprotocol/server-filesystem`（stdio，D:/pxx/projects）真实连接：`MCP server connected {"server":"fs","type":"stdio","tools":14}`。
- 进程内 API 冒烟（`server/scripts/mcp-api-smoke.ts`）：GET 返回 connected+toolCount 14；POST test 真实 fs → 200/14 工具（read_file/read_text_file/read_media_file…）；不可达端口 → 400 "fetch failed"；非法服务名 → 400 明确报错。
- 全量 vitest 507 绿（含 mcpTool.test.ts 15 例）；三端构建全绿。
