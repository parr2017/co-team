# Co-Team 接管 OpenCode 计划

> 分支：`devoc`（自 `dev` 切出） · 立项：2026-09-24 · 状态：**已实施完成（待合并 dev）**

## 1. 目标与背景

co-team 要获得**双向接管 OpenCode** 的能力：

| 场景 | 说明 | 模型归属 |
|---|---|---|
| A. 接管已在跑的会话 | 连接用户桌面版/TUI 正在运行的 opencode，看/批/停/介入 | opencode 自己（opencode.json/auth，co-team 不碰） |
| B. co-team 调用 opencode 干活 | co-team 拉起托管实例，把活儿派给它执行，回收结果 | co-team 模型池注入（provider 配置 + 逐 prompt model） |
| C. opencode 反向调 co-team | opencode 侧通过 MCP 调用 co-team 的任务/知识/会话能力 | — |

## 2. 事实基线（2026-09-24 实测）

- opencode 从设计上是 C/S 架构：TUI 只是客户端，执行者是常驻 server；官方 HTTP+SSE API（`/session`、`/message`、`prompt_async`、`abort`、`revert`、`diff`、`permissions/:id`、`/tui/*`、`/event`）即"被接管"接口。
- 桌面版 service：本机 `127.0.0.1:49374`，HTTP Basic 鉴权；**端口可从 `%APPDATA%/ai.opencode.desktop/logs/<最新日期>/main.log` 的 `port: '<n>'` 自动解析**；密码无自动来源 → 用户手填 `${ENV_VAR}`。
- 本地 CLI `opencode` 1.18.32：`opencode serve --port <n> --hostname 127.0.0.1` 实测可用（`--mdns` 可选发现）。
- API 世代：本地 CLI = v1 线（opencode.ai/docs）；桌面 2.0.11 = v2 线。差异兜底：连接时拉 `/doc` + `/global/health` 做能力探测（capabilities 表），最差 attached 实例自动降级 readonly。
- 会话存储 v2 已迁 SQLite（`opencode.db`）——接管只走 API，不读库。
- co-team 侧已有成功先例可整体复制：`server/src/mcp/`（types + manager + bridge + tools 分发 + config 节 + API 三件套）。

## 3. 架构

```
co-team server
├─ server/src/opencode/          （W0 契约层，本计划核心新增）
│   ├─ types.ts                  实例配置/状态/事件/capabilities 类型 + 校验
│   ├─ client.ts                 纯 fetch HTTP+SSE 客户端（不引 SDK，与 CLI 版本解耦）
│   ├─ manager.ts                实例注册表 + 生命周期（spawn/健康/重连/SSE 多路复用）
│   └─ modelInjection.ts         （W1）模型池 → opencode.json provider + 逐 prompt model
├─ L1 执行器（W1）：oc_* 工具 → tools.ts / convo.ts / discussion.ts 三处分发
├─ L2 面板（W2）：/api/opencode/* + SSE→WS 频道 + 审批汇入收件箱 + 双端 UI
├─ L3 反向（W3）：/mcp/coteam（co-team 作 MCP server）+ opencode 插件样例
└─ config.yaml 新增 opencode: 节（managed/attached 两类实例）
```

### 双轨模型策略

- **attached（场景 A）**：模型归 opencode。co-team 只读 message 的 model 字段做展示/记账。控制档位：`readonly`（GET + 审批响应）或 `control`（发消息/abort/revert/TUI 驱动，全操作审计）。
- **managed（场景 B）**：模型归 co-team。为实例生成专属 `opencode.json`（providers ← 模型池 OpenAI 兼容接入点，apiKey 走 env 不落盘）；每次 prompt 带 `model: {providerID, modelID}`（scheduler 降级链选型）；失败按降级链换 model 重试。

## 4. 配置schema（config/config.example.yaml）

```yaml
opencode:
  enabled: false
  instances:
    - id: main-exec
      kind: managed                # co-team 拉起 opencode serve 并托管生命周期
      command: opencode
      port: 4196                   # 缺省自动挑选空闲端口
      project_root: D:/pxx/projects/demo
      model_injection: true        # 模型由 co-team 池注入
      auto_start: true
    - id: desktop
      kind: attached-desktop       # 接管正在跑的会话，用 OC 自己的模型
      url: ""                      # 留空=自动发现（解析桌面日志），可手填兜底
      auth: { username: opencode, password: "${OPENCODE_DESKTOP_PASSWORD}" }
      mode: control                # readonly | control（control 全操作记审计）
```

## 5. 工作包分解（W0 先行，W1-W4 并行）

| 包 | 内容 | 落点 |
|---|---|---|
| W0 | types/client/manager + config 解析 + index.ts/api 挂载点 | server/src/opencode/、config.ts、index.ts、api/index.ts |
| W1 | `oc_*` 工具集（instances/create_session/send/read/abort/revert/diff/permission/run_task 复合）、模型注入、三引擎分发、教学块 | toolSchema.ts、tools.ts、convo.ts、discussion.ts、modelInjection.ts |
| W2 | `/api/opencode/*` 路由、SSE→`/ws/events`（`oc_event` 频道）、permission.asked→审批收件箱、审计查询 | api/opencode.ts、web/、mobile/ |
| W3 | `/mcp/coteam` MCP server（@modelcontextprotocol/sdk server 端）+ 白名单工具 + 插件样例 | server/src/mcpServer/、.opencode/plugins/ |
| W4 | web/mobile「外部运行时」面板（实例卡/会话列表/消息流 parts 类型化/diff/审批/发送） | web/src、mobile/src |

依赖：W1/W2/W3 均只依赖 W0 冻结的 `OpencodeManager` 接口；`index.ts`/`api/index.ts` 挂载点由 W0 一次性建好，各包只写自己的新文件，零冲突。

## 6. 安全模型

- attached `control`：实例级显式开启；每次 send/abort/revert 记审计日志（面板可查）。
- `oc_shell`（`/session/:id/shell`，任意命令执行）默认禁用，开启走 co-team 审批。
- managed 实例 `project_root` 必须落在授权目录（目录监狱精神）。
- managed 实例的 `opencode.json` 只含 provider 接入点，密钥 env 注入。
- W3 `/mcp/coteam` 复用 dashboard Bearer 门禁；工具白名单最小化（默认只读 + create_task）。
- opencode `permission.asked` 默认转人工审批（汇入 co-team 审批收件箱），可配 always-allow 前缀。

## 7. 测试策略

- 单测（vitest）：client 方法级 mock fetch；manager 生命周期（start/stop/重连/discover）；校验器用例。
- 契约基线：P0 抓一份真实 `/doc` 存 `server/test/fixtures/opencode-doc-v1.json`，capabilities 探测单测对照。
- e2e：Hono 伪造 opencode server（SSE 流、permission 流、`session.idle`、v1/v2 字段差异两套 fixtures）。
- 合并 `dev` 前硬门槛：`npm test` 全量 + 三端构建（AGENTS.md 规定）。

## 8. 里程碑

- M1：co-team 任务节点经 `oc_run_task` 在托管实例真实跑通，diff 回传机审通过。
- M2：桌面会话接管面板双端可用（实时消息流 + 审批 + 打断 + 发送）。
- M3：opencode 内调 `coteam_create_task` 成功创建 co-team 任务。

## 10. 实施记录（2026-09-24）

| 层 | 落地 | 验证 |
|---|---|---|
| W0 契约层 | `server/src/opencode/{types,client,manager}.ts`；config `opencode:` 节解析；index.ts 装配（模型注入钩子/模型池/SSE 转发）；`config.example.yaml` 注释样例 | **真服务冒烟**：本地 opencode 1.18.32 `serve` 实测 health/capabilities（sync_prompt、async_prompt、abort、revert、diff、permissions、events、shell、tui 全 true）/listSessions/createSession/listMessages/diff/SSE 首帧 `server.connected` 全部符合 client 假设 |
| W1 执行器层 | `ocTools.ts`（oc_instances/create_session/send/run_task/read/abort/revert/diff/permission/shell）+ `modelInjection.ts`（模型池→opencode.json providers + 逐 prompt model ref + 降级链）+ `toolSchema.ts` 动态集 + 三引擎分发（tools.ts:843 区 / convo.ts / discussion.ts 只读子集）+ harness 教学块 + `waitSessionIdle`（SSE 驱动的 run_task 等待原语）+ agent.yaml `opencode_instances` 白名单（partner 已开 `*`） | 26 用例（假桥跑 run_task 全流程、降级链、参数校验、软错误、applyToolCalls 分发） |
| W2 面板层 | `api/opencode.ts`（11 路由，密钥掩码/PUT 热生效/managed 启停/会话面/审批）+ SSE→`/ws/events` 的 `oc_event` 频道 | 8 路由用例（含未配置时优雅降级） |
| W3 反向层 | `server/src/mcpServer/`（`/mcp/coteam`，5 工具白名单，Bearer 门禁）+ `integrations/opencode/`（插件样例 + 中文接入文档） | 20 用例（鉴权/tools/list/call/参数错/截断）；真实 SDK Client 端到端冒烟过 |
| W4 UI 层 | web `components/OpenCodePanel.vue` + mobile `OpenCodeView/OpenCodeSessionView.vue`（双端：实例卡/会话列表/parts 分型消息流/diff/审批/发送/abort/revert） | 双端 vue-tsc + vite build 全过 |

**测试总量**：94→96 文件、729→737 用例全绿（原 683 + 本计划 54）；三端构建（server tsc / web vite / mobile vue-tsc+vite）全绿。

**实测踩坑记录**：
- Windows 裸命令（`opencode`）直接 spawn 报 ENOENT——CreateProcess 不做 PATHEXT 解析；manager 对 win32 裸命令自动加 `shell: true`（真实参数无 cmd 元字符，安全）。
- 测试里 `node -e <JS>` 走 shell:true 会被 cmd 的 `>` 重定向语法吃掉——假 serve 落 .cjs 文件绕过。
- SSE `reader.cancel()` 在已出错流上返回 rejected promise——必须 `.catch()` 接住，否则 stop/重连时冒未处理拒绝。
