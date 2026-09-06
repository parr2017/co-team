# UI 重设计进度表 — 作战室与工作台（2026-09-06）

## 第一轮（已完成）：作战室可读化 + 工作台重构

背景：用户对作战室（左图看不懂阶段、时间线裸事件名、事件归档无重点、整体粗糙）与工作台（AGENTS 状态无意义、任务列表冗余、右栏应并入主页）提出重设计。档级：B。

| # | 文件 | 修改内容 | 状态 |
|---|------|---------|------|
| 1 | web/src/utils/events.ts | 新建事件描述映射层 describeEvent，29 种服务端事件中文化（text/level/category/noisy） | [x] |
| 2 | server/src/api/index.ts | profiles 端点 getAgentMemory 8→15，前端可显示真实经验条数 | [x] |
| 3 | web/src/components/TaskDetailDialog.vue | 作战室：阶段横幅 + 阶段轨道左栏（替换 CollabGraph）+ 成员 chips；时间线中文化；事件归档筛选工具栏；去 emoji/旋转印章 | [x] |
| 4 | web/src/components/PipelineTrack.vue | 状态点 + 状态词 + 运行中脉冲，去旋转印章 | [x] |
| 5 | web/src/components/EventLog.vue | 可读化（共用 describeEvent），过滤 ping 心跳 | [x] |
| 6 | web/src/components/AgentCards.vue | 重写为团队成员卡：skills tags + 经验记忆条数 + 统计 + 轻量状态 | [x] |
| 7 | web/src/components/ModelPoolPanel.vue | 横向模型卡 grid + 刷新按钮 + 健康点 | [x] |
| 8 | web/src/components/MetricsPanel.vue | 4 项数字横排 + 双图并排指标带 | [x] |
| 9 | web/src/App.vue | 工作台单列全宽，移除右栏与 TaskList，新增主页工具条 | [x] |
| 10 | web/src/components/TaskForm.vue | 选目录弹窗 emoji 清理 | [x] |
| 11 | web/src/components/CollabGraph.vue、TaskList.vue | 删除（无引用） | [x] |
| 12 | 验证 | vue-tsc、vite build、vitest agentLife、浏览器实拍（深/浅色） | [x] |

设计取舍：左栏回答"到哪个阶段"而非"谁连线"；事件可读性在描述层统一解决；agent_round/progress_update/journal_append 定位为高频噪音默认折叠；工作台任务入口收敛到任务中心页。

## 第四轮（已完成）：去重 + 深层技术问题（Web + Mobile + Server）

背景：用户指出作战室/执行详情内容重复、聊天未显示模型；并要求把专业视角评估的深层问题一并修。档级：C（含服务端接口新增与行为变更）。

| # | 项 | 文件 | 内容 | 状态 |
|---|----|------|------|------|
| A | 作战室去重 | web TaskDetailDialog.vue | 删「执行详情」tab，右栏「成员会话/节点详情」检视器 | [x] |
| B | 聊天模型展示 | web+mobile ChatStream.vue | brief/final/error 气泡补 `模型 · tokens`；final 补 verification | [x] |
| C | Diff 视图 | server git.ts/api、web/mobile | nodeDiff（merge-base..branch）+ GET nodes/:id/diff + node.branch_base 落盘；节点详情/展开查看 patch | [x] |
| D | 主动通知 | web composables/useNotifier.ts | 任务完成/失败/待审批/需澄清 → 浏览器通知；设置开关 | [x] |
| E | 历史扩容 | server store.ts | events 200→2000、journal 120→1000、memory 15→50；web 归档加载更多 | [x] |
| F | 成本可观测 | web/mobile 类型+UI | AgentResult 补 model/tokens 类型；节点显示模型/tokens/耗时；任务 tokens+估算成本 | [x] |
| G | 计划插入节点 | server orchestrator/api、web PlanReviewDialog | addNode（边继承）+ POST nodes + 计划审核「插入节点」 | [x] |
| H | Mobile 对齐 | mobile 各文件 | utils/events 复制；阶段条；节点时间线；事件中文化+过滤；双 action-sheet bug；AgentsView 技能/经验；api 补 listSkills | [x] |

延期（另行设计）：验证门禁配置化、记忆相关性检索、聊天内搜索、移动端计划编辑、移动端系统推送。

验证要求：server vitest 全绿（branchWorkflow 扩 diff 用例、orchestrator 增 addNode 用例）；web vue-tsc+build+实拍；mobile build+8857 实拍。git 提交待用户确认。
