# Agent 技能系统（Skill）+ 执行骨架（Harness）实施计划

> 创建：2026-09-05。融合《Agent Skill 技能系统》与《Agent Harness 执行骨架》两份方案。
> 目标：让 Agent 具备可注入的 SKILL.md 技能体系，并用 Codex/DeepSeek 式的执行骨架约束所有 Agent 的行为与输出。

---

## 第一批：Harness 执行骨架（先打地基）

### 1.1 问题诊断（现状）

`callAgent` 的 system prompt 是 8 个文本块平面拼接，缺陷：
1. 无行为契约（Agent 不知道该按什么流程干活）
2. 输出契约只有一句话格式说明 → JSON 字段类型随缘
3. 无轮次/预算感知（工具轮常耗在盲试）
4. 无自检要求（声称 success 但未验证）
5. 无升级语义（何时该 failed 求助 vs 硬编）

### 1.2 方案：`server/src/harness.ts`

参考 Codex（分层指令体系/工具策略/输出纪律）与 DeepSeek（理解→规划→执行→验证→汇报）设计七层结构化 system prompt：

| 层 | 内容 |
|---|---|
| L1 身份与使命 | agent 角色定位 + prompt.md 专长（现有 plugin.prompt 成为 L1 专长层） |
| L2 行为准则（不可协商） | 证据先行（改前必读）· 最小改动 · 不越工作区 · 禁止编造文件内容/测试结果 · 不确定就 failed 说明，禁止假装成功 |
| L3 协同上下文 | 项目规范 / 全局目标 / SSOT 文档 / 知识库 / 个人经验 / 已装载技能（第二批接入）——现有注入全部保留并标注优先级 |
| L4 工作流契约 | 理解(只读侦查) → 规划(列出步骤) → 执行(最小变更) → 验证(运行/核对) → 汇报，映射到有限工具轮次 |
| L5 工具策略 | 只读侦查工具表 + 顺序建议（先 list/read 再 grep）；单轮合并多个 tool_calls；剩余轮次动态注入 |
| L6 输出契约 | 严格 JSON schema 字段表 + 高频错误清单（markdown 栅栏/截断 files/编造 changes/TODO 占位）+ 分析型任务豁免 |
| L7 升级语义 | 何时 status=failed（缺信息/缺权限/超预算/验证不过）；failed 必须带可行动的 error |

`buildAgentHarness(ctx)` 纯函数拼装；现有 project/goal/docs/knowledge/memories 块作为 L3 入参传入，不丢失任何现有注入。

### 1.3 结果 Schema 校验 + 修复回路（执法半边）

- `validateAgentResult(parsed)`：status 枚举 / summary 非空 / changes、errors 字符串数组 / files 为 {path,content} 数组 / commands 字符串数组 / verification 可选字符串
- 校验失败 → 复用 JSON 修复轮，把**具体违规项**写进纠正消息（比笼统的"无法解析"精准），计入现有 3 轮预算
- `AgentResult` 新增 `verification?: string`（我验证了什么、怎么验证的），journal final meta 带上，双端节点详情展示

### 1.4 改动点

- 新建 `server/src/harness.ts`（buildAgentHarness + validateAgentResult + 修复消息模板，纯函数）
- `orchestrator.callAgent`：systemMsg 替换为 harness 产出；userMsg/工具结果消息注入"第 X/3 轮（剩余 N 轮）"；extractJson 后接 schema 校验修复回路
- `types.ts`：AgentResult 加 `verification?`
- web TaskDetailDialog / mobile TaskDetailView 节点详情展示 verification

### 1.5 测试

`server/test/harness.test.ts`：七层齐全断言（mock chat 捕获 system prompt）、上下文注入完整、轮次预算动态、schema 校验各违规分支与纠正消息内容。

---

## 第二批：Skill 技能系统（往地基上装技能）

### 2.1 技能放在哪里

```
D:\pxx\co-team\skills\<技能名>\SKILL.md                    ← 全局技能库（主要放这里）
D:\pxx\co-team\agents\<agent名>\skills\<技能名>\SKILL.md   ← 可选：某 Agent 专属
```

SKILL.md 格式：
```markdown
---
name: feishu-integration
description: 飞书 Webhook 接入规范与踩坑清单
tags: [docs, deploy]        # 可选：适用 agent 标签；缺省 = 全体可用
---
（正文：操作步骤/规范/示例——装载后成为 Agent 的工作知识）
```

### 2.2 装载策略

1. **显式绑定**（最高优先）：`agent.yaml` 新增 `skills: [name, ...]`，列出的技能无条件全量注入（正文上限 6000 字符）
2. **自动匹配**：未绑定的全局技能按「技能 tags ∩ agent tags」或「技能 name/description 与节点名关键词重合」自动挑选，最多 2 个（正文截断 2000 字符），防 prompt 膨胀
3. 注入位置：harness L3 的「已装载技能（必须遵循）」区块

### 2.3 后端改动

- 新建 `server/src/skills.ts`：`discoverSkills()`（全局库 + Agent 专属目录，js-yaml 解析 frontmatter）、`pickSkillsForNode()`、内存缓存 + `reloadSkills()`
- `agents.ts`：AgentPlugin 解析 `agent.yaml` 的 `skills` 字段；`configStore` 读写支持
- `callAgent` / harness 接入技能区块；`loadAgents()` 同步刷新技能缓存
- API：`GET/POST /api/skills`、`PUT/DELETE /api/skills/:name`、`POST /api/skills/reload`
- 种子示例：`skills/code-review-checklist/SKILL.md`

### 2.4 前端改动

- SettingsDialog 新增「技能库」tab：列表（名称/描述/标签/来源/绑定）+ 新建/编辑/删除 + 重载
- Agent 编辑表单加 skills 多选绑定；表格加绑定数列
- 移动端暂不加管理界面

### 2.5 测试

`server/test/skills.test.ts`：frontmatter 解析、双目录发现、匹配策略（绑定必中/tags 交集/关键词/上限）、API CRUD 落盘、callAgent 注入捕获（system prompt 含技能正文）。

---

## 第三批：节点交付成果 + 项目进度成本表（追加需求）

### 3.1 节点交付成果（每个步骤必须有统一模板的 Markdown 交付文档）

- **统一模板**（`buildDeliverableReport`）：节点名/Agent/模型/耗时、做了什么（summary）、变更清单、验证方式与结果（verification，与 harness 契约联动）、对全局目标的贡献、遇到的问题——每个节点（成功/失败都生成）必有一份
- **存储**：任务 KV（`task:{id}:deliverable:{nodeId}`）+ 作战室 journal（kind 扩展 `'deliverable'`）
- **聊天流体现**：ChatStream（Web+移动端）渲染交付成果卡片「📄 交付成果 · 节点名 · 点击阅读」，**点击弹出阅读器**（Web: el-dialog + markdown 渲染；移动端: van-popup），统一模板固定样式
- **API**：`GET /api/tasks/:id/deliverables`（列表）、`GET /api/tasks/:id/deliverables/:nodeId`（单份）

### 3.2 项目进度成本表

- **API**：`GET /api/projects/:id/report` → 每任务（状态/级别/token/成本）× 每节点（状态/agent/tokens/成本/时长/起止时间）+ 项目合计；成本 = 节点 tokens × 所用模型 cost_per_1k
- **Web**：OfficeView 项目工作台加「进度成本表」入口 → 对话框内 el-table（任务行可展开节点明细 + 合计行）
- **移动端**：ProjectDetailView 加「进度成本」入口 → 独立页面（统计头 + 每任务卡片可展开节点清单）
- 数据源真实可查：tokens 来自节点 result.tokens，模型来自 result.model，与模型池成本率关联

---

## 执行顺序

```
第一批 Harness
  ① harness.ts（七层拼装 + validateAgentResult，纯函数）
  ② callAgent 接入（systemMsg 替换 + 轮次预算行 + 校验修复回路）+ types.verification
  ③ harness.test.ts + 全量回归
第二批 Skill
  ④ skills.ts（发现/解析/匹配/缓存）+ agents.ts/configStore skills 字段
  ⑤ harness/callAgent 接入技能区块 + loadAgents 刷新
  ⑥ API 五端点 + 种子示例技能
  ⑦ skills.test.ts + 全量回归
第三批 交付成果 + 成本表
  ⑧ 统一模板 buildDeliverableReport + 节点完成/失败钩子 + KV/journal + API
  ⑨ 项目成本报表 API
  ⑩ Web：ChatStream 交付卡片+阅读器、OfficeView 成本表对话框、节点 verification 展示
  ⑪ 移动端：ChatStream 交付卡片+阅读器、ProjectDetail 成本页
第四批
  ⑫ SettingsDialog 技能库 tab + Agent 绑定
  ⑬ 全量回归 + 双端构建 + 文档记录（README/开发路线.md）
```

每步完成即测；不主动 commit。
