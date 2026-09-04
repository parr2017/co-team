/** Document templates for project scaffolding. Placeholders: {{NAME}} {{DESCRIPTION}} {{DATE}} */

export function readmeTemplate(name: string, description: string): string {
  return `# ${name}

> ${description || '（项目简介待补充）'}

## 项目简介

${description || '（在此描述项目的目标、背景与核心价值。）'}

## 快速启动

\`\`\`bash
# 1. 安装依赖（根据项目技术栈选择）
npm install
# 2. 启动开发服务
npm run dev
\`\`\`

## 目录结构

| 目录 | 说明 |
|------|------|
| docs/ | 项目文档（需求、设计、会议纪要） |
| src/ | 源代码 |
| tests/ | 测试用例 |
| config/ | 配置文件 |

## 相关文档

- [架构设计](./ARCHITECTURE.md)
- [开发指南](./CONTRIBUTING.md)
`;
}

export function contributingTemplate(name: string): string {
  return `# ${name} 开发指南（CONTRIBUTING）

## 开发流程

1. 从最新主分支拉取开发分支：\`git checkout -b feat/your-feature\`
2. 开发并自测通过后提交
3. 提交 Pull Request / 合并回主分支

## 提交规范（Conventional Commits）

提交信息格式：\`<type>(<scope>): <subject>\`

| type | 说明 |
|------|------|
| feat | 新功能 |
| fix | 缺陷修复 |
| docs | 文档变更 |
| refactor | 重构（不改行为） |
| test | 测试相关 |
| chore | 构建/工具/杂项 |

示例：\`feat(auth): 实现用户注册接口\`

## 代码约定

- 保持函数短小、职责单一
- 公共接口必须有注释说明
- 修改行为时同步更新 docs/ 下的相关文档
`;
}

export function architectureTemplate(name: string, description: string): string {
  return `# ${name} 架构设计（ARCHITECTURE）

## 1. 系统概述

${description || '（概述系统的组成与边界。）'}

## 2. 技术栈

| 层 | 技术 | 说明 |
|----|------|------|
| 待定 | 待定 | （项目初始化时填写） |

## 3. 模块划分

\`\`\`
（在此绘制/描述核心模块与依赖关系）
\`\`\`

## 4. 关键设计决策

| 日期 | 决策 | 理由 |
|------|------|------|
| {{DATE}} | 项目初始化 | 建立 Co_team 标准脚手架 |

## 5. 目录约定

- docs/ — 需求、设计与协同文档（单一事实来源）
- src/ — 源代码
- tests/ — 测试用例
- config/ — 配置文件
`;
}
