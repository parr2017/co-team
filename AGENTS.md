# AGENTS.md — 编码代理工作守则

本仓库采用**单一 `main` 分支开发**（2026-09-08 起，原公有/私有双分支模型已废除并合并，全部功能统一在 main 上开发与发布）。

## 分支与推送

- 唯一长期分支：`main`，直接推 `origin`。
- 禁止 `git push --all`、`git push --mirror`（历史遗留的 `coteam/task-*`、`private` 等分支只作存档，不得推送）。
- 本地可能存在 `coteam/task-*` 历史任务分支与 `private`/`private-backup` 旧分支——它们是历史存档，**不删除、不推送、不在其上继续开发**。

## 日常工作流

- 直接在 `main` 上开发、提交、推送：`git add → commit → git push`。
- 提交信息沿用中文 conventional commit 风格（`feat:` / `fix:` / `docs:`）。
- 改动涉及 orchestrator/harness/deliverable/api 等核心文件时，提交前跑全量测试与三端构建。

## 其他约定

- 开发/测试/构建遵循 `DEVELOPMENT_STYLE.md` 与 CONTRIBUTING.md。
- `config/config.yaml`（含密钥）与 `data/`（运行时状态）已被 .gitignore 覆盖，不要把它们加入版本库。
- **UI 改动必须考虑移动端**：任何涉及界面（`web/`）的修改，必须同步评估 `mobile/`（Vant）端是否需要对应调整并一并落地；新增事件、卡片、状态展示、对话框等 UI 元素时 web 与 mobile 双端保持一致，验收必须包含移动端实拍（8857）。只改 web 不看 mobile 视为未完成。
