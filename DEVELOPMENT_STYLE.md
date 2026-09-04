# 开发风格研究报告

## 1. 项目概述

本项目是一个多 Agent 协作平台，采用 **TypeScript 服务端 + Vue 3 前端 + 遗留 Python 模块** 的混合架构。项目包含 6 个 Agent 定义（deploy、dev、docs、refactor、review、test），核心服务端位于 `server/src`，前端为 Vue 3 + Vite 应用，遗留 Python 代码位于 `legacy-python`。

## 2. 架构风格

- **服务端**：模块化 TypeScript，按职责划分模块（orchestrator、router、scheduler、sandbox、llm、git、store 等），采用事件总线（bus）与消息传递机制。
- **前端**：Vue 3 组合式 API + Vite，组件化开发，使用 composables 管理共享逻辑。
- **遗留 Python**：包结构清晰，包含 CLI、server、shared 工具库，与主服务端通过 API 或进程方式集成。
- **Agent 系统**：每个 Agent 有独立的 `agent.yaml`、`handler.js`、`prompt.md` 和 `tools/README.md`，职责单一，便于扩展。

## 3. 代码组织与目录结构

- **server/src**：按功能模块划分，每个模块一个文件或目录，如 `orchestrator/`、`api/`。
- **web/src**：`components/` 存放 UI 组件，`composables/` 存放组合式函数，`api/` 存放接口调用。
- **agents/**：每个 Agent 一个目录，包含配置、处理逻辑、提示词和工具说明。
- **legacy-python/src**：按 `main`、`server`、`shared`、`cli` 分层。
- **测试**：服务端测试位于 `server/test`，Python 测试位于 `legacy-python/tests`。

## 4. 命名规范

- **TypeScript**：使用 camelCase 命名变量和函数，PascalCase 命名类和组件，文件名使用 kebab-case 或 camelCase（如 `configStore.ts`、`agentLife.test.ts`）。
- **Vue 组件**：使用 PascalCase 文件名（如 `AgentCards.vue`），组件名与文件名一致。
- **Python**：使用 snake_case 命名函数和变量，模块名小写。
- **配置**：使用 `.env.example` 和 `config.example.yaml` 提供示例，实际配置为 `config.yaml`。

## 5. 模块划分与职责

- **orchestrator**：负责任务编排与规划。
- **router**：负责请求路由与分发。
- **scheduler**：负责任务调度。
- **sandbox**：提供安全执行环境。
- **llm**：封装大模型调用。
- **git**：封装 Git 操作。
- **store**：状态存储。
- **bus**：事件总线，模块间通信。
- **api**：HTTP API 层。
- **tools**：通用工具函数。

## 6. 测试策略

- **服务端**：使用 Jest 或类似框架，测试文件命名 `*.test.ts`，覆盖核心流程（orchestrator、scheduler、agent 生命周期、分支工作流等）。
- **Python**：使用 pytest，测试文件命名 `test_*.py`，覆盖 orchestrator、router、scheduler、sandbox、transport。
- **测试风格**：单元测试为主，辅以集成测试，测试用例命名清晰描述行为。

## 7. 配置管理

- 使用 `.env.example` 提供环境变量模板，`.gitignore` 忽略敏感文件。
- 使用 `config.example.yaml` 提供配置示例，`config.yaml` 为实际配置。
- 服务端有 `config.ts` 和 `configStore.ts` 管理配置。

## 8. 文档规范

- 项目根目录有 `README.md`、`README_CN.md`、`CONTRIBUTING.md`、`analysis.md`、`project-summary.md`、`开发路线.md`。
- 每个 Agent 目录下有 `prompt.md` 和 `tools/README.md`。
- 使用 GitHub 模板（ISSUE_TEMPLATE、PULL_REQUEST_TEMPLATE）规范协作。

## 9. 工具链与工作流

- **构建**：TypeScript 编译到 `server/dist`，Vite 构建前端到 `web/dist`。
- **包管理**：根目录有 `package.json` 和 `package-lock.json`，`server/` 和 `web/` 各有独立 `package.json`。
- **日志**：日志文件存放在 `logs/` 目录，便于排查问题。
- **版本控制**：使用 Git，`.gitignore` 已配置忽略构建产物和敏感文件。

## 10. 遗留代码处理

- 遗留 Python 模块保留在 `legacy-python/`，与主服务端共存，通过 API 或独立进程运行。
- 建议逐步将核心逻辑迁移到 TypeScript，或通过清晰的接口封装保持兼容。

## 11. 改进建议

- 统一代码格式化工具（如 Prettier、ESLint）并加入 CI。
- 增加更多端到端测试，覆盖前后端集成。
- 为 Python 模块补充类型注解和文档字符串。
- 统一配置管理，减少硬编码。
- 增加代码覆盖率报告。

## 12. 结论

项目整体开发风格清晰、模块化程度高，混合架构虽有历史包袱，但通过清晰的目录划分和文档规范保持了可维护性。建议持续完善自动化工具链和测试覆盖，进一步提升开发效率。
