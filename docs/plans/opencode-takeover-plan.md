# Co-Team 接管 OpenCode 计划

> 分支：`devoc`（自 `dev` 切出） · 立项：2026-09-24 · 状态：**OpenCode 2.x 控制面已实施并完成真实 2.0.16 冒烟（待提交/合并 dev）**

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
- OpenCode 2.0.15+ 官方客户端是本项目唯一运行时契约；`@opencode/client` / `@opencode/schema` 精确锁定 `2.0.15`。
- 1.18.32 与 2.x 的双版本端点猜测已淘汰；1.x attached/managed 会明确失败，不再静默降级。
- 会话存储 v2 已迁 SQLite（`opencode.db`）——接管只走 API，不读库。
- co-team 侧已有成功先例可整体复制：`server/src/mcp/`（types + manager + bridge + tools 分发 + config 节 + API 三件套）。

## 3. 架构

```
co-team server
├─ server/src/opencode/          （W0 契约层，本计划核心新增）
│   ├─ types.ts                  实例配置/状态/事件/capabilities 类型 + 校验
│   ├─ client.ts                 官方 @opencode/client 2.0.15 适配、v2 版本门禁、事件投影
│   ├─ manager.ts                实例注册表 + 生命周期（spawn/健康/重连）+ 单实例事件 Hub
│   ├─ eventHub.ts               事件 ID、2048 条/8 MiB replay、进程重启隔离
│   └─ modelInjection.ts         （W1）模型池 → opencode.json provider + 逐 prompt model
├─ L1 执行器（W1）：oc_* 工具 → tools.ts / convo.ts / discussion.ts 三处分发
├─ L2 面板（W2）：/api/opencode/* + 单一上游事件 Hub→/ws/events 频道 + replay/权威快照 + 双端 UI
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

## 10. 历史实施记录（2026-09-24，1.x 阶段）

> 本节记录改造前的 1.x 验证事实，不代表当前运行时契约；当前实现以第 12 节为准。

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

## 11. 历史追加实施：TUI 同构接管面（2026-09-24 下午）

> 本节的 1.x 事件字段、双直连和启发式接管属于历史实现；当前浏览器事件统一经 co-team WebSocket，接管入口已改为显式 session。

在四层基础上按“和 TUI 同构、实时双向同步”的要求升级：

- **流式内核** `server/src/opencode/stream.ts`（web/mobile 字节级同步副本）：`message.part.delta {messageID,partID,field,delta}` token 级追加 + `message.part.updated` 全量校正 + 乱序保护；busy/retry/todos/revert/ptys/permissions/question 全事件投影。9 单测（含 delta 先于 updated 到达的骨架消息自建）。
- **事件面** `events.ts`：delta 50ms 微批（防 WS 1600 burst 上限）+ 基础设施噪音丢弃（实测 plugin.added 单会话能刷 45 帧）。
- **数据面**：active-session（busy>recent 启发式）、session-status/todo、command（**实测 opencode 1.18.32 要求 arguments 字符串，缺字段 400**——已修）、agents/models（attach 实例用 opencode 自己的 provider/config.providers）、tui 驱动（append/submit/toast/**select-session**）、PTY 签票（pty.connect-token → 浏览器 WS 直连终端）、create-session。
- **双直连/代理**：managed 实例无鉴权 + CORS 放本地源 → 浏览器 EventSource 直连；attached 带 Basic → co-team 同源 SSE 代理（proxy 识别 JSON direct 提示改直连——修了“把 JSON 当 SSE 解析静默无事件”的坑）。
- **双端 UI**：web `OpenCodeChat.vue`（全 parts 渲染/流式/composer/行内审批/question/todo/PTY 终端弹层/diff/回退）、mobile 同构页。

### 事故与复盘（2026-09-24）
- **事故**：排障时「接管当前对话」选中用户 TUI 正在使用的 QMS 会话（1000+ 消息），测试指令（3 条只读 ls）发进真实会话。无文件副作用。
- **修复（产品层）**：busy 会话接管前三选一征询（共享接管 / 让 TUI 切走我独占 / 放弃）+ 对话页常驻接管横幅 + busy 会话首次发送二次确认 + 「新建并接管」安全路径 + 接管即 toast 通知 TUI（透明优先）。
- **结论：opencode “断不开”原会话**——162 端点无 kick/独占/lock API（session 是服务端共享、多客户端平权）。唯一可用的“让原客户端让位”手段是 `tui.select-session`（把 TUI 导航到别处），已实现为“让位式接管”。
- **测试纪律**：真机验证一律走「新建并接管」自建会话，严禁往 heuristic 选中的真实会话发消息。
- **顺手修复**：co-team 重启后孤儿 serve 残留（占端口耗内存）——pid+port 双登记，启动时按“端口当前归属=登记 pid”校验后查杀（双条件防误杀用户自己的实例）。

## 12. OpenCode 2.x 控制面重构（2026-09-24）

> 状态：代码实施完成，已通过真实 OpenCode 2.0.16 attached 冒烟 · 基线：`devoc@9e3e46b` · 决策：统一 OpenCode 2.x（最低 2.0.15），保留“每项目一个 managed OpenCode 进程”。

### 目标与成功标准

co-team 继续作为 OpenCode 的宿主和控制面，OpenCode 继续拥有模型循环、默认工具和会话数据库。改造完成后：

- managed / attached 只接受 OpenCode 2.x，不再通过端点猜测兼容 v1；
- 官方 OpenCode 客户端负责请求契约，co-team 只维护薄适配层；
- 每个实例只有一条上游事件流，浏览器只消费 co-team WebSocket；
- 断线可用短期 replay 恢复，无法 replay 时从 OpenCode 权威快照修复；
- Web 与 Mobile 使用同一套事件翻译和会话状态机，不再维护三份副本；
- 接管入口使用明确 session ID，不再把“最近会话”默认为当前对话。

### 方案与取舍

| 方案 | 优点 | 代价 | 结论 |
|---|---|---|---|
| 保留纯 fetch 双版本适配 | 兼容面最大 | 事件、字段、端点均由本仓库猜测，升级时静默漂移 | 淘汰 |
| 全面引入官方 2.x 客户端 | 请求契约由生成代码保证，可做明确版本门禁 | 放弃 OpenCode 1.x 运行兼容 | 采用 |
| 照搬 OpenChamber 单进程多项目 | 资源占用低 | 配置、权限和故障半径跨项目扩大 | 不采用；保留每项目一进程 |
| 复制 UI 状态机 | 初期改动少 | 三端继续漂移，事件重复和重连问题复发 | 淘汰；抽共享纯 TS 模块 |

### 影响面

- 服务端契约与生命周期：`server/package.json`、`server/src/opencode/{types,client,manager,events,stream}.ts`、`server/src/api/opencode.ts`、`server/src/index.ts`。
- 实时传输：`server/src/api/index.ts`、Web/Mobile OpenCode 会话页及事件订阅代码。
- 配置与进程：配置解析/保存、managed `opencode serve` 启动、external attached 显式连接。
- 测试与文档：`server/test/opencode*.test.ts`、`server/test/stream.test.ts`、本计划、配置样例与开发路线。

### 实施步骤与验证

| 状态 | 步骤 | 验证 |
|---|---|---|
| [x] | 接入 `@opencode/client` / `@opencode/schema` 2.0.15，建立 v2 版本门禁和官方客户端适配 | OpencodeClient 契约测试 9/9；1.18.32/3.x 拒绝 |
| [x] | 收紧 managed 进程解析、密码、就绪与 external 显式连接；保留每项目一进程 | OpencodeManager 生命周期 4/4；每项目一进程 |
| [x] | 建立每实例单一 SSE Hub：事件 ID、2048 条/8 MiB replay、delta 合并、WS 唯一入口 | EventHub 8/8；Manager replay/重放窗口测试 |
| [x] | 抽取共享纯 TS 事件翻译/状态机，Web/Mobile 共用；重连超出 replay 时权威快照对账 | `@co-team/opencode-sync`；Stream 11/11；Web/Mobile 构建通过 |
| [x] | 接管 UI 改为显式选择 session；受控 client 不再直连 OpenCode；PTY/审批继续经 co-team 权限门控 | Web/Mobile 构建通过；旧 `/direct`、`/events` 返回 410 |
| [x] | 完成迁移说明、真实服务验证和全量门禁 | server 全量 97 文件/769 用例通过；三端构建通过；真实 OpenCode 2.0.16 attached 冒烟通过 |

### 风险与回滚

- **会话迁移**：OpenCode 1.x 历史若不能由 2.x 自动导入，不直接删除或改写旧数据；真实验证前备份 OpenCode 数据目录，必要时保留 v1 归档读取能力。
- **字段变化**：以官方 schema 生成的类型为编译期契约；未知事件进入有界日志并通过权威快照修复，不直接污染状态。
- **重连重复**：同一实例禁止 SSE、代理 SSE、浏览器直连并存；事件 ID 与 part 快照屏障共同去重。
- **回滚**：改造按模块提交但暂不提交；任一阶段验证失败时恢复该阶段文件，managed 实例始终使用新 session 验证，不触碰用户现有 busy session。

### 决策记录

- 统一升级 OpenCode 2.x，不保留 v1 运行兼容。
- 每个 managed 项目一个 OpenCode 进程，不采用 OpenChamber 的单进程多项目拓扑。
- 浏览器统一走 co-team WebSocket，不向 OpenCode 暴露跨源直连能力。
- co-team 继续负责上层任务编排；不复制 OpenChamber 的 Session Goals，只补可靠队列、准入和结果回收。

## 13. 2.x 改造落地明细（2026-09-24）

- `server/src/opencode/client.ts` 通过 `officialClientLoader.cjs` 动态加载官方 ESM 客户端，兼容当前 CommonJS 服务端构建；普通请求全部走官方生成方法，版本低于 2.0.15 或高于 2.x 明确失败。
- v2 `SessionMessageInfo` 和 text/reasoning/tool 事件在服务端投影成既有 UI 需要的 `{info,parts}` 与 `message.*` 事件；`event.id` 和 `location` 保留给 Hub 与诊断。
- `OpencodeEventHub` 为每个实例维护事件游标与有界 replay；`/api/opencode/instances/:id/events/replay` 在游标过期时返回 `409 + resync:true`，客户端随后拉权威消息快照。
- `packages/opencode-sync` 成为唯一 `SessionStream` 实现；server/web/mobile 通过 CJS/ESM 双入口引用，不再维护三份字节副本。
- Web/Mobile 只监听 co-team 的全局 WebSocket；旧浏览器直连 `/direct` 和事件 SSE `/events` 返回 410；PTY 仍使用 co-team 签发的一次性 ticket。
- Web/Mobile 移除了“自动猜测当前会话”的接管按钮，用户从会话列表明确选择或创建新会话。
- 当前自动验证：server `97` 个测试文件、`769` 个用例通过；OpenCode 客户端/Manager/EventHub/Stream/API 聚焦测试通过；server、web、mobile 构建通过；本机 OpenCode `2.0.16` attached 真实冒烟通过（创建临时会话、发送最小提示、等待完成、读取匹配回复、验证 replay、确认无 pending、删除临时会话）。冒烟期间发现 2.0.16 实际使用 `session.execution.started/succeeded/failed` 事件，已在 `client.ts` 投影为 `session.status/idle/error`，并补回归测试。

## 14. 真实 2.x 服务接管已有会话验证（2026-09-25）

> 真机（`2.0.16` attached）验证"接管**已有**会话"全链路：模拟 TUI 直连建会话并产生历史 → co-team 显式选择接管 → 列表可见/读历史/介入发送/busy 实时可见/空闲唤醒/复读介入结果。第一轮暴露缓存缺陷，参照 OpenChamber 的事件翻译层修复后全链路通过（介入后复读 `6` 条消息含介入双方）。

### 修复的问题（均补回归测试，聚焦测试 66→68 全绿）

- **服务端消息缓存被冻结**：v2 事件流没有全量 `message.updated`，只有 part 级事件；`manager.patchCache` 对缓存外消息直接丢弃（1.x 依赖的"先全量后增量"前提在 v2 不成立）。已改为 part 事件自建骨架消息（`ensureCachedMessage`），并补 `message.part.delta` 增量（字段路径追加，与 `@co-team/opencode-sync` 同语义）。
- **投影事件缺 sessionID 归属**：`eventSessionId()` 取不到归属导致 patchCache 全部早退。已在 `convertEvents` 统一注入 `data.sessionID`。
- **用户消息无入场事件**：`session.inbox.enqueued`（user/synthetic）此前落 default 直通，缓存与双端实时流都看不到介入者自己发的消息。已投影为 `message.updated`（骨架，role=user/synthetic）+ `message.part.updated`（text part），与 UI 共享包既有词汇完全兼容。
- **interrupted 不结算**：`session.execution.interrupted` 落 default 直通会让 run_task 空闲等待干等到超时；已映射为 `session.idle`，`reason=shutdown`（opencode 自身重启续跑）除外——与 OpenChamber 同语义。

### 参考与启示

- OpenChamber `packages/ui/src/lib/opencode/events.ts` 是 v2 事件翻译的权威范本：`execution.interrupted` 的 shutdown 例外、`inbox.enqueued → message.updated + parts` 的用户消息重建、对"part 事件先于消息骨架"标记 `incomplete-session-snapshot` 做权威对账，三条均值得对齐。
- 接管路径必须真机验证：fixture 若按 1.x 词汇编写，单元测试全绿也挡不住 v2 字段漂移（`info.role` → 扁平 `type`、`parts` → `content` 等）。

## 15. 托管实例拉起修复：serve 强制鉴权（2026-09-25）

> 现象：web 面板 managed 实例报「等待 serve 就绪超时：UnsupportedContentType」，且 `%TEMP%/coteam-opencode-logs/` 积累数百份 serve 日志——就绪超时 → 重启 → 再超时的死循环，每轮还留一个孤儿 serve。

### 根因（真机实证）

- **opencode 2.x `serve` 启动即生成随机密码并强制 Basic 鉴权**（stdout 打印 `server password <pw>`）。co-team 托管流程带空凭据探测 `/api/info` → `401`（**空 content-type**）→ 官方客户端抛 `UnsupportedContentType` → 健康等待必然超时。fake serve 不鉴权，单测测不出。
- 次生缺陷：`startManaged` 就绪失败路径**不杀已拉起的 serve 进程** → 每轮重启泄漏一个孤儿。

### 修复（`manager.ts`，回归测试 ×1）

- 新增 `waitForServePassword`：从 serve 日志解析密码（官方 Basic 用户名固定 `opencode`），带凭据重建客户端后再进入健康等待；解析不到按无鉴权处理（向后兼容）。
- 就绪失败 catch 中 `killTree(st)` 清理进程树，杜绝孤儿泄漏。
- fake serve 增加 `FAKE_REQUIRE_AUTH` 模式（无凭据 `/api/info` 返回 401 空 content-type，等同真实行为）+ 常驻打印密码行，托管鉴权测试用其复现原始故障。
- 真机验证：托管 `main-exec` 首启即 connected（v2.0.16），聚焦测试 69/69 全绿。

### 附带发现（未修）

- managed spawn 的 `--cors` 以逗号串成单参传入，而 opencode 的 `--cors` 是可重复参数——多 origin 只注册了一个伪 origin；v2 已取消浏览器直连，CORS 无实际消费者，暂不处理。


