# 项目特点总结

## 项目概览

**co-team** 是一个多智能体协作框架项目，融合了现代 Node.js 智能体定义与遗留 Python 实现。项目以清晰的目录结构组织不同角色的智能体，并配套统一的配置、示例和工具说明，体现了工程化与模块化的设计理念。

## 核心特点

### 1. 多智能体协作框架
- 定义了 6 种角色智能体：开发（dev）、部署（deploy）、文档（docs）、重构（refactor）、审查（review）、测试（test）
- 每个智能体包含完整组件：配置（agent.yaml）、提示词（prompt.md）、处理逻辑（handler.js）、示例输出（examples/）、工具说明（tools/README.md）
- 职责分离、专业化分工，便于独立开发与维护

### 2. 双语言实现（Node.js + Python）
- 现代实现采用 Node.js（handler.js），用于新的执行环境
- 遗留实现采用 Python（legacy-python/），包含 CLI、服务器、编排、路由、调度等完整模块
- 体现技术栈迁移或兼容并存的策略

### 3. 配置驱动
- 使用 YAML 作为主要配置格式（agent.yaml、config.yaml）
- 提供 .env.example 和 config.example.yaml 作为配置模板
- 支持环境变量与配置文件两种配置方式，灵活适应不同环境

### 4. 标准化与可扩展性
- 智能体目录结构统一，新增角色只需复制模板
- 提供 examples/ 目录存放输出示例，便于验证和测试
- tools/README.md 明确每个智能体可用的工具，降低使用门槛

### 5. 部署与运维支持
- 专门的部署智能体，重视部署流程自动化
- 包含 .gitignore 和 .env.example，体现工程化规范
- 配置模板与实际配置分离，便于环境管理

### 6. 遗留代码结构
- Python 部分采用 src 布局，符合现代 Python 项目规范
- 包含 egg-info，说明曾使用 setuptools 打包
- 核心模块职责明确：agent_runner（运行）、orchestrator（编排）、router（路由）、scheduler（调度）

## 总结

co-team 是一个设计良好的多智能体协作系统，具备清晰的模块划分、配置驱动、双语言实现和完整的工程化配套。当前工作区包含智能体定义和遗留 Python 代码，适合在此基础上进行功能扩展或迁移重构。
