# 任务执行流畅度详细分析：2y3tuote 重放实验全量复盘

> 数据来源：2y3tuote（accountapp UI 补全，15 节点）的 511 行任务日志、369 条 agent journal、
> Redis 任务图快照。重放背景：换模型池（新增 qwen3.8-flash / deepseek-v4-flash / sensenova-6.8-flash-lite，
> priority=1 置顶；删 gemma）后原样重跑 jr3gdkxq 任务。

## 一、总量画像

| 指标 | 数值 |
|---|---|
| 墙钟总耗时 | ≈ 4.5h（23:27 → 03:53 UTC），其中有效执行 ≈ 1.5h |
| 模型失败降级（Model returned failure） | **33 次** |
| 其中 429 限流 | 17 次 |
| 其中思考耗尽（finish=length 正文空） | 10 次 |
| 其中"合法问题上报被当失败烧链" | **≥12 次（见 P1）** |
| 节点 dispatch 失败（节点级） | 17 次 |
| lane 阻塞等人工 | 7 次（人工 resume/execute 5 次 + 手工清 branch 2 次） |
| 假 success（E21） | 1 次（14/15 完成、merge 被取消仍报 success） |
| 最终结果 | success（人工介入 5 次后），npm test 40 断言绿，四页面渲染实测 OK |

**失败按模型分布**：qwen3.8-flash 11 / sensenova 7 / glm-5.3-flash 6 / glm-5.2 6 / deepseek 2 / Qwen3.6 **1**。
——最稳的 Qwen3.6 在链尾几乎没被用上，最不稳的三个置顶模型贡献了 82% 的失败。

## 二、具体问题清单（按严重度排序）

### P1【严重·新发现】合法失败信号被当作模型无能惩罚（伪失败税）

**现象**：node2（review 审查契约）从 23:48 到 23:58 十分钟内烧掉 **6 个模型尝试**，每个模型都返回
`[blocker] docs/API_CONTRACT.md 实际仍为 v1 占位版，与前置节点[1]声明的 v2 不符`——完全相同、
完全正确的判断。引擎把每次都记为"该模型失败，换下一个"，直到第 7 次才把问题上报。
node7/9/10 的 qwen3.8-flash"缺少证据 1：entry.vue 正文未获得（read_file 被去重）"同理——
这是 L7"不确定就上报"纪律的**正确执行**，却被计入模型失败并烧链。

**量化**：33 次失败里 ≥12 次（36%）属于此类。换模型当然解决不了环境问题——问题在工件里，不在权重里。

**根因**：orchestrator 对 `status=failed` 不分类。模型申报"[blocker]/需要补充信息/上游工件不一致"
与"JSON 坏了/超时/429"走同一条 markFailure→failover 路径。

### P2【严重·新发现】SSOT 文档跨节点传播断裂（node2 六连 blocker 的物理根因）

**现象**：node1（docs）申报把 API_CONTRACT 升级到 v2（changes 里有它），但 node2 的分支上文件仍是 v1。
**根因链**：
1. 节点分支基点取 `depBranches[depBranches.length-1]`（parentBranchFor，多上游时只认最后一个）；
2. 更关键：harness 明文规定 "write_doc/send_message 的产出不计入 changes"——write_doc 通道写的文档
   **不随节点 commitOnBranch 进分支**，下游 checkout 后看到的是旧版；
3. 系统其实知道这个病：`checkDocs 恢复不一致文档` 机制在本次任务触发 2 次（日志
   `SSOT doc check restored inconsistent documents restored:["API_CONTRACT"]`）——但恢复方向是
   orchestrator 基线版，**把 docs 节点写的 v2 也冲掉过**（v4 空模板混入冲突就是它留下的痕迹）。

**影响**：直接制造了 P1 的 6 次伪失败 + 一次 stash 冲突；文档驱动协同（SSOT）在分支工作流下名存实亡。

### P3【已修·今日】断崖折叠 × 工具去重 = 死链

**现象**：node10 三连败期间 qwen3.8-flash 原话："read_file 被 harness 去重为『结果从略』且原始内容
未回传，导致我至今未见该文件任何一行"。折叠把旧 tool_result 换成摘要后，去重指针指向不存在的内容。
**修复**：折叠真正发生时 `seenToolCalls.clear()`（已提交 7e8c6e9）。

### P4【中】大文件节点的"侦查预算"结构性不足

**现象**：node10 报"工具轮次预算耗尽（第 5/5 轮）且 grep 输出被截断（8060 字符）"；qwen3.8 明说
"补齐 4 项现场信息后可一轮完成实现与验证"。settings.vue(337 行)+dataService.js(300+ 行) 的节点，
5 轮工具 × 16k 截断的读图预算不够拼出完整现场，模型只能盲写或上报。
**方向**：read_file 支持行范围（start/end）；节点级 maxRounds 按任务体量自适应；截断时回传
"如何获取剩余部分"的明确指引（而不是让模型猜）。

### P5【中】429 限流按能力失败处理

**现象**：17 次 429（tokenrhythm/sensenova 的 tpm 窗口通常 1-2 分钟自愈）。每次 429：记 failCount、
烧到下一个模型、链烧完节点 failed、lane 阻塞等人工。
**方向**：识别 429/503/`rate limit` 类错误 → 同模型 30~120s 退避重试（最多 2 次），不记失败不阻塞。

### P6【中】E17 思考耗尽在新池三模型复发（10 次）

**现象**：sensenova/glm-5.2/glm-5.3-flash 把 8000（simple 档）/32000 预算全烧在思考上，正文空。
**方向**：① 这些端点若支持 `chat_template_kwargs.enable_thinking:false` 则配置之；② 引擎侧把
"finish_reason=length 且正文空"计入 slowCount 式自动降权（一次即沉底，不等多次失败）。

### P7【中】failover 链序无健康反馈：坏模型永远第一个撞

**现象**：本次 33 次失败后，链顺序纹丝不动——每个新节点依旧先撞 qwen3.8-flash（11 败）再撞
sensenova（7 败）。cooldown 只按时间窗恢复，不看"失败原因是否与环境相关"。
**方向**：effectivePriority 把 failCount 计入链序（软沉底，指数回血），而非仅 slowCount。

### P8【已修·今日】状态机三连：E20 auto_run 被吞 / E21 假 success / E22 cancelled 不重置

见开发路线 2026-09-10 章节（提交 7e8c6e9）。E21 是本次最危险的：半截交付报 success，
若无人盯守，你会以为任务完成了。

### P9【半修】重跑后 completed 节点 branch 指向已销毁沙箱

**现象**：本次 merge 两次假冲突（先 1-10 后 11-14 的陈旧 branch 引用），人工清字段才过。
E22 让重跑能续，但分支生命周期没跟上。
**方向**：execute 时校验 `node.branch` 在当前沙箱存在；不存在且产物已在工作区 → 视为已合并置空。

## 三、改进措施汇总（按投入产出排序）

| # | 措施 | 对应问题 | 改动点 | 预期效果 |
|---|---|---|---|---|
| M1 | **失败分类路由**：`[blocker]`/需补充信息类 failed 不烧模型链，直接升级 orchestrator（尝试自动修复→人工） | P1 | orchestrator dispatch 失败分支 + harness 申报格式约定 | 消灭 ~36% 伪失败 |
| M2 | **SSOT 传播修复**：write_doc 产物强制计入节点分支提交；checkDocs 恢复方向改为"取最新上游版本" | P2 | tools.writeDoc 通道 + commitOnBranch paths + checkDocs | 消灭 node2 型连环 blocker |
| M3 | **429 退避重试**：容量类错误同模型 backoff 重试，不记失败不阻塞 lane | P5 | llm 错误分型 + dispatch 重试环 | 消灭大部分人工 resume |
| M4 | **链序健康反馈**：failCount 计入 effectivePriority 排序；思考耗尽一次即降权 | P6/P7 | scheduler.selectModel/emergencyCandidates | 坏模型不再每节点首撞 |
| M5 | **侦查预算**：read_file 行范围参数 + 截断回传续读指引 + maxRounds 自适应 | P4 | tools.readFile + harness L5 | 大文件节点不再盲写/上报死锁 |
| M6 | **branch 自愈**：重跑时失效分支自动置空 | P9 | executeTask 重置段 | merge 不再假冲突 |
| M7 | 配置：Qwen3.6（关思考、本次唯一 1 败）提回 priority 1，新模型降到 20 观察 | P7 | config.yaml 一行 | 立即减 ~70% 首撞失败 |

**组合预期**：同类任务失败数 33 → <8，墙钟 4.5h → 1.5h 内，人工介入 5 次 → 0 次。

## 四、诚实的保留意见

- M1 的"blocker 识别"依赖模型申报格式，弱模型可能不守格式——需要兜底（同节点同错误签名重复 ≥3 次即判定环境问题，与模型无关）。
- 本次重放也证明了**改造有效的一面**：证据链全面真实化（node14 实跑 6 条命令）、qwen3.8 学会了"拿不到就上报不编造"、验收闸实战通过。问题从"假完成"转移到了"真慢"——这是正确的演进方向，接下来用 M1-M7 把"慢"也消掉。
- check_page 自发使用率仍是 0，不在本清单内（属 deliverable 审计专项）。
