# Co-Team

[English](README.md) | [中文](README_CN.md)

> 🤖 面向个人开发者的多智能体协作开发助手

Co-Team 是一个开源的多智能体协作框架，通过 AI 驱动的专业化 Agent 团队，将开发任务自动拆解、分配、执行，让个人开发者也能拥有一个高效的 AI 开发团队。

## ✨ 核心特点

- **🎯 智能任务拆解**：用户提需求 → 自动拆解为 DAG → 分发给专业 Agent
- **👥 6 大专业 Agent**：开发、测试、审查、部署、文档、重构，各司其职
- **⚡ 并行执行**：LangGraph 驱动，无依赖节点自动并行处理
- **🔒 安全沙箱**：任务级隔离，文件操作受控，命令白名单执行
- **📊 实时可视化**：Web Dashboard 实时展示每个 Agent 的工作状态
- **🔌 插件化架构**：Agent、模型、通知渠道均可扩展

## 🚀 快速开始

### 环境要求

- Node.js >= 18
- npm >= 9
- Redis（可选，用于持久化）

### 安装

```bash
# 克隆仓库
git clone https://github.com/parr2017/co-team.git
cd co-team

# 安装依赖
npm install

# 构建项目
npm run build
```

### 配置

1. 复制环境变量文件并填入你的 API Key：

```bash
cp .env.example .env
# 编辑 .env 文件，填入 API Key
```

2. 配置模型池（可选）：

```bash
cp config/config.example.yaml config/config.yaml
# 编辑 config/config.yaml，配置可用的 LLM 模型
```

### 启动

```bash
# 启动服务（默认端口 8855）
npm start

# 或分别启动服务端和前端开发模式
npm run dev:server
npm run dev:web
```

访问 http://localhost:8855 即可使用 Dashboard。

> **开发模式**：`npm run dev:server` 启动后端（端口 8855），`npm run dev:web` 启动前端开发服务器（端口 **8856**，带热更新，自动代理 `/api`、`/ws` 到 8855）。开发时访问 http://localhost:8856。

## 🏗️ 项目结构

```
co-team/
├── agents/                    # 智能体定义
│   ├── dev/                   # 开发 Agent
│   ├── test/                  # 测试 Agent
│   ├── review/                # 代码审查 Agent
│   ├── deploy/                # 部署 Agent
│   ├── docs/                  # 文档 Agent
│   └── refactor/              # 重构 Agent
├── server/                    # 后端服务（Node.js + Hono）
│   └── src/
│       ├── orchestrator.ts    # 任务编排引擎
│       ├── router.ts          # 智能路由
│       ├── scheduler.ts       # 并行调度器
│       ├── model-pool.ts      # 模型池管理
│       ├── sandbox.ts         # 沙箱隔离
│       ├── git.ts             # Git 集成
│       ├── tools/             # 工具系统
│       └── notify/            # 通知模块
├── web/                       # 前端界面（Vue3 + Element Plus）
│   └── src/
├── config/                    # 配置文件
├── legacy-python/             # Python 遗留代码（存档）
└── package.json
```

## 🎯 使用场景

### 提交开发任务

在 Dashboard 中输入你的需求：

```
创建一个 Python 计算器，支持加减乘除，并编写单元测试
```

Co-Team 会自动：
1. 拆解任务为 DAG（dev → test）
2. 分配给专业 Agent 执行
3. 在沙箱中安全执行
4. 自动创建 Git 分支并提交
5. 在 Dashboard 中实时展示进度

### 使用 CLI

```bash
# 交互式配置
npx coteam setup

# 提交任务
npx coteam chat
```

## 🧩 技术架构

```
┌─────────────────────────────────────────────────────────────┐
│                      Web Dashboard                          │
│                   (Vue3 + Element Plus)                      │
└──────────────────────────┬──────────────────────────────────┘
                           │ WebSocket + REST API
┌──────────────────────────▼──────────────────────────────────┐
│                      Server (Hono)                           │
├─────────────────────────────────────────────────────────────┤
│  Orchestrator    │  LangGraph StateGraph 编排引擎            │
├─────────────────────────────────────────────────────────────┤
│  Router          │  规则 → LLM 语义 → 关键词 三级回退        │
├─────────────────────────────────────────────────────────────┤
│  Scheduler       │  无依赖节点并行执行 + 线程驱动兜底        │
├─────────────────────────────────────────────────────────────┤
│  Model Pool      │  多模型调度 + 降级 + 成本优化             │
├─────────────────────────────────────────────────────────────┤
│  Sandbox         │  任务级隔离 + 路径逃逸防护                │
├─────────────────────────────────────────────────────────────┤
│  Tool System     │  文件读写 + 命令执行 + 白名单控制         │
└─────────────────────────────────────────────────────────────┘
                           │
┌──────────────────────────▼──────────────────────────────────┐
│                    Agent Team                                │
│  ┌──────┐ ┌──────┐ ┌──────┐ ┌──────┐ ┌──────┐ ┌──────┐     │
│  │ dev  │ │ test │ │review│ │deploy│ │ docs │ │refact│     │
│  └──────┘ └──────┘ └──────┘ └──────┘ └──────┘ └──────┘     │
└─────────────────────────────────────────────────────────────┘
```

## ⚙️ 配置说明

### 模型池配置

在 `config/config.yaml` 中配置可用的 LLM 模型：

```yaml
model_pool:
  - name: deepseek-v4-flash
    provider: openai
    api_key: sk_xxx
    base_url: https://api.openai.com/v1
    concurrency: 4
    priority: 6
    cost_per_1k: 0.005
    tags: [code, logic]
```

### 环境变量

| 变量 | 说明 |
|------|------|
| `DEEPSEEK_API_KEY` | DeepSeek API Key |
| `SENSENOVA_API_KEY` | SenseNova API Key |
| `LMSTUDIO_API_KEY` | LM Studio API Key |
| `COTEAM_WEBHOOK` | Webhook 通知地址 |
| `COTEAM_FEISHU_WEBHOOK` | 飞书 Webhook 地址 |
| `COTEAM_STATE_FILE` | 状态持久化文件路径 |

## 🛡️ 安全特性

- **沙箱隔离**：每个任务在独立目录中执行，防止污染主工作区
- **路径逃逸防护**：文件操作限制在工作目录内
- **命令白名单**：仅允许执行预定义的安全命令
- **审批机制**：敏感操作（如部署）需要人工审批

> ⚠️ **实验特性说明**：当前沙箱为进程级隔离（任务级目录副本 + 路径逃逸防护 + 命令白名单），尚未提供 CPU/内存/网络等系统资源级的强隔离（如 Docker/gVisor 容器沙箱）。请勿在宿主机敏感环境中运行不可信的生成代码，强隔离沙箱将在后续版本提供。

## 📊 API 接口

- `GET /api/status` - 服务状态
- `GET /api/agents` - Agent 列表
- `GET /api/tasks` - 任务列表
- `GET /api/metrics` - 性能指标
- `POST /api/tasks` - 创建任务（支持 `main_model_id` 主Agent模型锁定、`level` 任务分级）
- `POST /api/tasks/{id}/clarify` - 需求澄清循环（答复/确认）
- `GET /api/tasks/{id}/progress` - 实时进度查询（百分比/ETA）
- `PUT /api/tasks/{id}/model` - 中途更换主 Agent 模型（留痕）
- `GET/PUT /api/tasks/{id}/goal` - 全局目标查看/更新
- `POST /api/tasks/{id}/execute` - 执行任务
- `POST /api/tasks/{id}/cancel` - 取消任务
- `POST /api/tasks/{id}/approve/{node}` - 审批节点
- `POST /api/projects` - 创建项目（`scaffold: true` 生成标准脚手架 + git init）
- `GET/POST /api/knowledge`、`GET/PUT/DELETE /api/knowledge/{id}` - 知识库（增删改查/搜索，通用经验与项目经验双分类）
- `GET/POST /api/snapshots`、`POST /api/snapshots/{id}/rollback` - 快照与回滚（需确认）
- `WS /ws` - 实时事件推送

完整 API 文档：启动服务后访问 http://localhost:8855/docs

## 🧪 测试

```bash
# 运行所有测试
npm test

# 开发模式（监听文件变化）
cd server && npx vitest
```

## 🤝 贡献

欢迎贡献代码！请遵循以下步骤：

1. Fork 本仓库
2. 创建特性分支 (`git checkout -b feature/awesome-feature`)
3. 提交更改 (`git commit -m 'Add awesome feature'`)
4. 推送到分支 (`git push origin feature/awesome-feature`)
5. 创建 Pull Request

### 开发指南

```bash
# 开发模式（热重载）
npm run dev:server  # 后端
npm run dev:web     # 前端

# 构建
npm run build

# 测试
npm test
```

## 📝 创建自定义 Agent

1. 在 `agents/` 目录下创建新文件夹
2. 添加 `agent.yaml` 配置文件：

```yaml
name: my-agent
version: 1.0.0
description: 我的自定义 Agent
model_preference: deepseek-v4-flash
timeout: 120
```

3. 添加 `prompt.md` 提示词文件
4. 添加 `handler.js` 处理逻辑（可选）

## 🗺️ 路线图

- [x] 基础任务编排
- [x] 6 大专业 Agent
- [x] 沙箱隔离执行
- [x] Git 自动提交
- [x] Web Dashboard
- [x] WebSocket 实时推送
- [ ] 多人协作模式
- [ ] Agent 插件市场
- [ ] 更多通知渠道（钉钉、Slack）
- [ ] 任务模板库

## 🔍 竞品对比

| 项目 | 定位 | Co-Team 差异 |
|------|------|-------------|
| Devin | 全自主 AI 工程师 | 更轻量，个人开发者友好 |
| OpenHands | 单 Agent 开发 | 多 Agent 协作，专业分工 |
| AutoGen | 多 Agent 框架 | 开箱即用，非框架 |
| Cursor | AI 编辑器 | 独立运行，跨 IDE |

## 📄 许可证

MIT License - 详见 [LICENSE](LICENSE)

## 🙏 致谢

- [Hono](https://hono.dev/) - 轻量级 Web 框架
- [Vue3](https://vuejs.org/) - 渐进式前端框架
- [Element Plus](https://element-plus.org/) - Vue3 UI 组件库
- [LangGraph](https://langchain-ai.github.io/langgraph/) - 编排引擎
- [ECharts](https://echarts.apache.org/) - 可视化图表

---

<p align="center">
  如果觉得有用，请给个 ⭐ Star 支持一下！
</p>