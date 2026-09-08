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

## 任务 git 落点与目录边界（2026-09-08 治理）

- 项目必须拥有**独立目录 + 独立 git 仓库**：新建项目缺省落在 `projects.root`（配置，缺省 `D:\pxx\projects`）下的 `<项目名slug>` 目录并自动 git init；workspace 位于其他仓库（含 co-team 自身）工作树内会被 API 拒绝（400）。
- **自指任务**（用 co-team 开发 co-team）必须显式 `allow_self_ref`，执行被隔离到 `projects.selfdev_root/<taskId>` 的本地克隆，co-team 主副本的 HEAD/分支/工作树零触碰；成果留在克隆里由人审阅并回。
- **目录监狱**：任务命令中出现的越界绝对路径 / `..` 逃逸一律拒绝执行（所有权限级别生效，`full` 仅指目录内完全控制）；产物与日志一律写项目目录内。
- `gitCommit` 在任务分支提交后必须回切原 HEAD；服务启动时 `restoreStaleTaskHeads` 清扫遗留 HEAD（有独有提交则保留告警）。
- 存量清理脚本：`scripts/cleanup-workspace-legacy.mjs`（dry-run 默认，`--apply` 执行）。

## 其他约定

- 开发/测试/构建遵循 `DEVELOPMENT_STYLE.md` 与 CONTRIBUTING.md。
- `config/config.yaml`（含密钥）与 `data/`（运行时状态）已被 .gitignore 覆盖，不要把它们加入版本库。
- **超时不判死（2026-09-09 语义重做）**：agent.yaml timeout 是节点级总时长预算（超线停靠人工）；LLM 失败判定只认确定性信号（连接错误/流无 finish_reason/持续静默），慢但持续推进的生成永不中止。上下文注入保持静态前缀 + append-only 以保住推理服务前缀缓存，历史折叠每尝试至多一次。详见开发路线.md 同日章节。
- **UI 改动必须考虑移动端**：任何涉及界面（`web/`）的修改，必须同步评估 `mobile/`（Vant）端是否需要对应调整并一并落地；新增事件、卡片、状态展示、对话框等 UI 元素时 web 与 mobile 双端保持一致，验收必须包含移动端实拍（8857）。只改 web 不看 mobile 视为未完成。
