# 贡献指南

感谢你对 Co-Team 的关注！我们欢迎任何形式的贡献。

## 如何贡献

### 报告 Bug

1. 在 [Issues](https://github.com/your-username/co-team/issues) 中搜索是否已有相同问题
2. 如果没有，创建新 Issue，包含：
   - 清晰的标题和描述
   - 复现步骤
   - 期望行为和实际行为
   - 环境信息（Node.js 版本、操作系统等）

### 提交新功能

1. 先创建 Issue 讨论你的想法
2. 获得认可后开始开发
3. 提交 Pull Request

### 提交 Pull Request

1. Fork 本仓库
2. 创建特性分支：`git checkout -b feature/your-feature`
3. 提交更改：`git commit -m 'feat: add some feature'`
4. 推送分支：`git push origin feature/your-feature`
5. 创建 Pull Request

### Commit 规范

我们使用 [Conventional Commits](https://www.conventionalcommits.org/) 规范：

- `feat:` 新功能
- `fix:` Bug 修复
- `docs:` 文档更新
- `style:` 代码格式（不影响功能）
- `refactor:` 重构
- `perf:` 性能优化
- `test:` 测试相关
- `chore:` 构建/工具相关

示例：
```
feat: 添加钉钉通知支持
fix: 修复任务取消后状态未更新的问题
docs: 更新 API 文档
```

## 开发环境

### 环境要求

- Node.js >= 18
- npm >= 9
- Redis（可选）

### 启动开发

```bash
# 安装依赖
npm install

# 启动后端开发模式（热重载，端口 8855）
npm run dev:server

# 启动前端开发模式（热重载，端口 8856，自动代理 /api /ws 到 8855）
npm run dev:web
```

### 项目结构

```
co-team/
├── agents/          # 智能体定义
├── server/          # 后端服务
├── web/             # 前端界面
├── config/          # 配置文件
└── legacy-python/   # Python 遗留代码
```

### 代码规范

- 使用 TypeScript 严格模式
- 遵循 ESLint 规则
- 保持代码简洁，避免过度设计

### 测试

```bash
# 运行测试
npm test

# 监听模式
cd server && npx vitest
```

提交 PR 前请确保所有测试通过。

## 添加新的 Agent

1. 在 `agents/` 目录下创建新文件夹
2. 参考现有 Agent 结构：
   - `agent.yaml` - 配置文件
   - `prompt.md` - 系统提示词
   - `handler.js` - 处理逻辑（可选）
   - `tools/` - 工具说明（可选）
   - `examples/` - 示例（可选）

## 问题反馈

- GitHub Issues: [https://github.com/parr2017/co-team/issues](https://github.com/parr2017/co-team/issues)

## 许可证

贡献的代码将遵循 MIT 许可证。