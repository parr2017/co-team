# AGENTS.md — 编码代理工作守则

本仓库采用**双分支模型**（公开/私有隔离），任何代理在此仓库工作前必须遵守以下纪律。

## 分支模型

| 分支 | 用途 | 推送目标 |
|---|---|---|
| `main` | 公开代码分支 | `origin`（公开 GitHub 仓库） |
| `private` | 私有开发分支（包含私有功能，细节见 private 侧的 `docs/公开仓库维护说明.md`） | 仅推私有备份仓库 |

## 推送红线（最高优先级）

1. **禁止 `git push --all`、`git push --mirror`、`git push origin <非main分支>`**。
   已配置 `remote.origin.push = refs/heads/main`，普通 `git push` 只会推 main——不要绕过或删除该配置。
2. 本地存在 `coteam/task-*` 历史任务分支，部分指向含私有内容的提交——**永不推送到 origin**。
3. **私有分支上的提交永不合并/cherry-pick 进 main**。方向只能是 main → private。
4. 提交到 main 前，若改动涉及 orchestrator/harness/deliverable/api 等核心文件，先自查：
   `git grep -lE "self_mod_gate|DefectReport|delivery_check|fix_for|summarizeQuality"` 应无结果。
   代码一旦推送到公开仓库即视为已泄漏，无法靠事后删除挽回——有疑问就先问用户。

## 日常工作流

- 私有功能开发：在 `private` 分支进行，定期推私有备份远端。
- 公共功能开发：在 `main` 提交 → 推送 origin → 切到 `private` 执行 `git merge main` 保持同步。
- 提交信息沿用中文 conventional commit 风格（`feat:` / `fix:` / `docs:`）。

## 其他约定

- 开发/测试/构建遵循 `DEVELOPMENT_STYLE.md` 与 CONTRIBUTING.md。
- `config/config.yaml`（含密钥）与 `data/`（运行时状态）已被 .gitignore 覆盖，不要把它们加入版本库。
