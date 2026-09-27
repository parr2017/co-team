# learn-english 沙箱遗留成果梳理报告（2026-09-27，只读分析）

> 背景：us55tbhs（派生修复任务）与更早的 run 因沙箱静默降级（详见《沙箱静默降级与假完成修复-计划-2026-09-27.md》），节点产物滞留在 Temp 沙箱目录，工作区零提交。本报告对比两个遗留沙箱与任务基线（`coteam/task-us55tbhs` = `coteam/task-pk0udn4p` = `39f7104`，工作区当前干净检出即基线），给出处置建议。**未对 learn-english 仓库做任何改动。**

## 一、两个沙箱的基本盘

| | coteam-sbx-e3O22k（较老，~09-26 晚） | coteam-sbx-u0siiD（较新，~09-27） |
|---|---|---|
| 体量 | 44MB | 59MB |
| 产出重心 | **前端 + 统计** | **服务端缓存** |
| 新增文件 | `server/lib/ai_cache.dart`、`server/lib/ai_stats.dart`、`server/test/ai_stats_aggregation_test.dart`、`test/ai_stats_panel_test.dart`（292 行 Flutter 组件测试） | `server/lib/ai_cache.dart`（191 行）、`server/lib/ai_stats.dart`（387 行）、`server/test/ai_cache_test.dart` |
| 修改文件 | `lib/pages/profile_page.dart`（AiStatsPanel，5 处引用）、`lib/services/ai_client.dart`（fetchStats/stats，4 处）、`server/lib/ai_service.dart`、`server/lib/server.dart`、SSOT 文档 | `server/lib/ai_service.dart`（X-Ai-Cache 头）、`server/lib/server.dart`、`server/test/smoke_test.dart`、`lib/data/seed_cards.dart`、SSOT 文档 |

## 二、关键发现：两份成果互不兼容，不能拼接

1. **同一功能被两个 run 各自重做了一遍，且版本不同**：`ai_cache.dart` 与 `ai_service.dart` 在两个沙箱里内容**互不一致**（不同 run 从各自基线独立实现，无共享 git 历史）。
2. **各自都是半成品**：e3O22k 有前端面板但没有 u0siiD 的 cache 测试与 smoke 改动；u0siiD 有服务端缓存细节但没有前端面板。强行拼接 = 手工合并两份无共同祖先的改写，风险高、无测试背书。
3. **从未通过任何验收闸**：这些代码产生于守卫盲区（降级沙箱无 .git → 无提交、无 diff 存档、无验收），质量未知。
4. Temp 目录随时可能被系统清理——若决定留作参考，应先拷出到项目外安全位置。

## 三、处置建议：**重跑，不抢救**（推荐）

- **重跑**：co-team 的沙箱降级根因已修复（清扫路径归一化 + 降级大声报警 + 兜底 git init + 重启抢救）。重新创建派生修复任务，让全部改动走完整管线（节点分支 → 提交 → 合并 → 验收闸），产出的每一行代码都有提交与验收背书。
- 若想保留参考材料：把 e3O22k（较完整的那份）拷到 `D:\pxx\projects\learn-english` 之外的目录存档，供重跑时人工比对思路，不直接合入。
- 不建议把任一沙箱内容直接拷回工作区：无测试背书 + 两份互相矛盾 + 与重跑产物必然冲突。

## 四、复核清单（重跑后应能验证）

- [ ] `server/lib/ai_cache.dart` / `ai_stats.dart` 存在且已提交到任务分支（`git log` 可见）
- [ ] `lib/pages/profile_page.dart` 含 AiStatsPanel 且已提交
- [ ] X-Ai-Cache 缓存链路有测试覆盖（服务端 + Flutter 两侧）
- [ ] 任务验收报告全绿（strict 缺省下不再出现"带警告完成"）
