# 实施计划：自进化 P0+度量 / 知识库 RAG / 飞书 bot

> 2026-09-06 制定。来源：自进化能力评估报告（P0/P1 建议）+ 三路代码调查。
> 执行顺序 A→C→B，每工作包独立提交，vitest 保持基线全绿并新增用例。

## 工作包 A：自进化 P0 双项 + 质量度量

### A1 自修改门禁
- `server/src/config.ts`：新增 `orchestrator.self_mod_gate = { enabled, test_command: 'npm test', meta_paths: [...] }`（默认 enabled）。
- 自指任务判定：`path.resolve(workspace) === PROJECT_ROOT`。
- `orchestrator.ts` `executeNodeInner` 完成判定前插入门禁：
  1. 节点变更命中 `meta_paths` → 置 `requires_approval`、`waiting_approval`，走现有审批 API。
  2. 自指任务节点完成前强制跑 `test_command`（`sandbox.executeCommandAsync` + `testloop.parseTestOutput`），失败进 fix 循环，超 `max_fix_rounds` 判失败。
- `harness.ts` L2 层注入自修改纪律文本。
- 测试：改元设施 → waiting_approval；测试失败 → fix 循环后 fail。

### A2 缺陷→修复任务转化
- `types.ts`：`AgentResult.defects?: { title, detail, severity? }[]`；`TaskGraph.fix_for?: { task_id, node_id }`。
- `harness.ts` schema/repair/fallback 示例同步；`deliverable.ts` 加「缺陷清单」节。
- `api/index.ts`：`POST /api/tasks` 接受 `fix_for`；新增 `POST /api/tasks/:id/defects/convert`。
- 前端：`TaskDetailDialog.vue`、`ChatStream.vue`（web）+ `TaskDetailView.vue`（mobile）加 defects 列表与「转修复任务」按钮。
- 测试：defects 校验通过、convert 写入回链。

### A3 质量度量
- `/api/metrics` 扩展：修复轮次（report.attempts）、测试通过率、缺陷闭环率（fix_for 回链）、交付一致率（报告文件 vs git diff）。
- `execute()` 收尾写每日采样 `metrics:samples:<date>`；新增 `GET /api/metrics/trend`。
- `MetricsPanel.vue` 加质量指标卡片与趋势图。
- 测试：聚合 + trend 单测。

## 工作包 C：知识库 RAG

- 选型：markdown 侧车向量文件（`{id}.json`）+ 内存余弦，零新依赖；`searchKnowledge` 改关键词+余弦混合打分，`SearchHit.score` 签名不变。
- 配置：模型池条目加 `roles: ['chat','embedding']`；`knowledge.embedding.enabled`；无 embedding 模型时降级关键词检索。
- 新建 `server/src/embeddings.ts`：批量嵌入、内容 hash 缓存、余弦相似度；写入路径挂钩 + backfill。
- 治理：余弦 ≥0.95 近似重复→更新原文；`GET /api/knowledge?stale=1` 过期候选。
- 修复存量 bug：知识条目 title 中文 GBK/UTF-8 乱码（写入链路编码）。
- 前端 `KnowledgeDialog.vue`：相似度分数 tag、"语义搜索" placeholder。
- 测试：mock embeddings 的混合打分/降级/去重单测。

## 工作包 B：飞书 bot

- 新建 `server/src/feishu/`：tokenManager（`feishu:tenant_token` TTL 7100s）、webhook（url_challenge、HMAC-SHA256 签名 403、事件去重 `feishu:event:<id>` TTL 300s、快速 200）、session（`feishu:session:<user_id>` TTL 24h、模糊匹配）、commands（/help /agent /project /status /reset /list）、messageService（text/post/interactive 卡片、429 退避）。
- 路由：`POST /api/feishu/webhook` 挂 `createApi`。
- 业务对接：/project → listProjects；发任务 → createTask+enqueue，澄清卡片化追问；进度 → notify/emitProgress 钩子，`feishu:card:<taskId>` 卡片动态更新。
- 配置：`feishu` 段 + `COTEAM_FEISHU_*` 环境变量（secret 不入 yaml）。
- 测试：mock 飞书 API 单测。真机联调待用户提供自建应用凭据与公网可达回调地址。

## 验收

- 每工作包：单测全绿 + 三端 tsc/build 通过 + 独立 commit；A 完成后跑一次带 defects 的任务验证闭环。
- 完成状态回填本文档。

## 状态

- [x] 工作包 A（2026-09-06 完成：门禁/缺陷转化/度量，161 测试全绿，三端 build 通过）
- [ ] 工作包 C
- [ ] 工作包 B
