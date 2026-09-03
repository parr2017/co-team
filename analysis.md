# 项目结构分析与特点提取

## 1. 项目概览

这是一个名为 **co-team** 的多智能体协作框架项目，包含现代 Node.js 智能体定义与遗留 Python 实现两大部分。项目采用分层结构，将不同角色的智能体（开发、部署、文档、重构、审查、测试）以独立目录组织，并配有统一的配置、示例和工具说明。

## 2. 目录结构分析

```
.
├── .env.example                 # 环境变量模板
├── .gitignore                   # Git 忽略规则
├── .zcode/plans/                # 计划文件（会话级）
├── agents/                      # 智能体定义（核心）
│   ├── deploy/                  # 部署智能体
│   │   ├── agent.yaml           # 智能体配置
│   │   ├── examples/            # 输出示例
│   │   ├── handler.js           # 处理逻辑（Node.js）
│   │   ├── prompt.md            # 提示词
│   │   └── tools/README.md      # 工具说明
│   ├── dev/                     # 开发智能体
│   ├── docs/                    # 文档智能体
│   ├── refactor/                # 重构智能体
│   ├── review/                  # 审查智能体
│   └── test/                    # 测试智能体
├── config/                      # 配置文件
│   ├── config.example.yaml      # 配置模板
│   └── config.yaml              # 实际配置
└── legacy-python/               # 遗留 Python 实现
    ├── pyproject.toml           # Python 项目配置
    ├── run_server.py            # 服务器入口
    └── src/
        ├── cli/                 # 命令行接口
        ├── co_team.egg-info/    # 打包元数据
        └── main/                # 核心逻辑
            ├── agent_runner.py  # 智能体运行器
            ├── orchestrator.py  # 编排器
            ├── router.py        # 路由器
            └── scheduler.py     # 调度器
```

## 3. 核心特点提取

### 3.1 多智能体协作框架
- 定义了 6 种角色智能体：开发、部署、文档、重构、审查、测试
- 每个智能体包含：配置（agent.yaml）、提示词（prompt.md）、处理逻辑（handler.js）、示例输出、工具说明
- 体现了职责分离和专业化分工的设计思想

### 3.2 双语言实现（Node.js + Python）
- 现代实现采用 Node.js（handler.js），可能用于新的执行环境
- 遗留实现采用 Python（legacy-python/），包含完整的 CLI、服务器、编排、路由、调度模块
- 存在技术栈迁移或兼容并存的迹象

### 3.3 配置驱动
- 使用 YAML 作为配置格式（agent.yaml、config.yaml）
- 提供 .env.example 和 config.example.yaml 作为模板
- 支持环境变量和配置文件两种配置方式

### 3.4 标准化与可扩展性
- 每个智能体目录结构统一，便于新增角色
- 提供 examples/ 目录存放输出示例，便于验证和测试
- tools/README.md 说明每个智能体可用的工具

### 3.5 部署与运维支持
- 专门的 deploy 智能体，说明项目重视部署流程
- 包含 .gitignore 和 .env.example，体现工程化规范

### 3.6 遗留代码结构
- Python 部分采用 src 布局，符合现代 Python 项目规范
- 包含 egg-info，说明曾使用 setuptools 打包
- 核心模块：agent_runner（运行）、orchestrator（编排）、router（路由）、scheduler（调度）

## 4. 总结

该项目是一个设计良好的多智能体协作系统，具有清晰的模块划分、配置驱动、双语言实现和完整的工程化配套。当前工作区主要包含智能体定义和遗留 Python 代码，适合在此基础上进行功能扩展或迁移重构。
