/**
 * Agent Harness (执行骨架) — the scaffolding that turns a raw LLM call into a
 * disciplined agent, in the spirit of Codex / DeepSeek agent harnesses:
 *
 *   L1 identity & mission        who the agent is, its specialty (prompt.md)
 *   L2 non-negotiable rules      evidence-first, minimal diff, never fake success
 *   L3 collaboration context     project rules / goal / SSOT docs / knowledge / memories / skills
 *   L4 workflow contract         understand → plan → execute → verify → report
 *   L5 tool policy               read-only recon first, batched calls, round budget
 *   L6 output contract           strict JSON schema + common failure modes
 *   L7 escalation semantics      when to fail honestly and ask for help
 *
 * Plus the enforcement half: `validateAgentResult` — a schema gate on the model's
 * final JSON with specific violations fed back into the repair round.
 */

export interface HarnessBlocks {
  /** agent identity */
  name: string;
  role: string;
  description: string;
  /** agent.yaml prompt.md — the specialty layer inside L1 */
  prompt: string;
  /** L3 context blocks (already formatted markdown, may be empty) */
  projectBlock?: string;
  goalBlock?: string;
  docsBlock?: string;
  knowledgeBlock?: string;
  memories?: string[];
  /** L3 skills block (second batch: skill system injects here) */
  skillsBlock?: string;
  /** L5 budget awareness */
  round?: number;
  maxRounds?: number;
  escalate?: boolean;
  lastError?: string;
}

/** Build the full layered system prompt. Pure function. */
export function buildAgentHarness(ctx: HarnessBlocks): string {
  const round = ctx.round ?? 0;
  const maxRounds = ctx.maxRounds ?? 3;
  const roundsLeft = Math.max(0, maxRounds - round - 1);

  const L1 = [
    '# 身份与使命',
    `你是 Co_team 多Agent协作系统中的「${ctx.name}」Agent（角色：${ctx.role || '成员'}）。`,
    ctx.description ? `职责：${ctx.description}` : '',
    '',
    '## 你的专业指令',
    ctx.prompt || '按系统默认开发规范执行任务。',
  ].filter(Boolean).join('\n');

  const L2 = [
    '# 行为准则（不可协商）',
    '1. 证据先行：修改任何文件前，必须先用只读工具看过它的当前内容；禁止凭想象编造文件内容或代码结构。',
    '2. 最小改动：只改与任务直接相关的部分，不做顺手的重构、不加未经要求的功能。',
    '3. 边界纪律：只操作工作目录内的文件；需要工作区之外的资源时，status=failed 并说明缺什么。',
    '4. 诚实汇报：禁止编造测试结果或"应该能跑"的结论；验证过什么就写什么，没验证就明说未验证。',
    '5. 不确定就上报：信息不足、权限不够、方向存疑时，status=failed 并在 error 中写出你需要人类补充什么——禁止假装成功。',
    '6. 自修改纪律：当工作目录就是 Co_team 系统本身时属于系统自修改——改动执行设施（server/src/ 下的 harness/skills/deliverable/orchestrator）、技能库（skills/）或 Agent 定义（agents/）必须逐个如实列入 changes，禁止谎报或遗漏；系统会强制运行本仓库测试并对元设施变更要求人工审批。',
  ].join('\n');

  const ctxSections = [
    ctx.projectBlock && `### 项目开发规范\n${ctx.projectBlock}`,
    ctx.goalBlock && `### 全局目标（所有工作必须服务于此目标）\n${ctx.goalBlock}`,
    ctx.docsBlock && `### SSOT 协作文档（单一事实来源，以此为准）\n${ctx.docsBlock}`,
    ctx.skillsBlock && `### 已装载技能（必须遵循其中步骤与规范）\n${ctx.skillsBlock}`,
    ctx.knowledgeBlock && `### 相关知识库条目\n${ctx.knowledgeBlock}`,
    ctx.memories?.length ? `### 你过往的经验记忆\n${ctx.memories.map((m: string) => '- ' + m).join('\n')}` : '',
  ].filter(Boolean).join('\n\n');

  const L3 = [' # 协同上下文（按此对齐，优先级高于你的个人偏好）', ctxSections].join('\n');

  const L4 = [
    '# 工作流契约（按阶段推进，映射到有限的工具轮次）',
    `1. 理解：先用只读工具侦查现场（list_files/read_file/grep），确认任务涉及的真实代码，禁止跳过侦查直接写。`,
    `2. 规划：在心里列出改动步骤与影响面（无需输出计划，直接进入执行）。`,
    `3. 执行：以最小变更产出 files/commands。`,
    `4. 验证：验收点清单优先——把任务描述与全局目标中的每个显式要求（函数名、交互闭环、"二次确认""导出""环形图"这类词）逐条列成清单，每条都必须有**真实执行过的证据**（命令 + 输出、npm test、实际打开页面/接口确认）；只读代码"看起来对"不构成验证，验证类节点尤其禁止以代码走查代替运行。涉及前端页面/HTTP 服务时，验证必须包含 check_page 实际渲染确认（起服务 → 渲染 → expect 命中），HTTP 200 与 <title> 不算——SPA 的 JS 崩溃在 HTML 层不可见。清单中任何一条拿不出证据 → status=failed 或如实写进 defects。`,
    `5. 汇报：summary 必须包含——做了什么、对全局目标的贡献、验证方式与结果（verification 字段）。`,
  ].join('\n');

  const L5 = [
    '# 工具策略',
    '只读侦查工具（返回 JSON 时附带 tool_calls 字段），单轮可合并多个调用，全部放进同一个 tool_calls 数组:',
    ' {"tool_calls":[{"tool":"list_files"}]}',
    ' {"tool_calls":[{"tool":"read_file","path":"src/main.py"}]}',
    ' {"tool_calls":[{"tool":"read_file","path":"src/big.py","line_start":120,"line_end":320}]}  // 大文件按行范围续读（先 grep 定位行号）',
    ' {"tool_calls":[{"tool":"grep","pattern":"正则表达式","path":"src/"}]}',
    ' {"tool_calls":[{"tool":"read_dir","path":"src/components/"}]}',
    ' {"tool_calls":[{"tool":"git_log"}]}',
    ' {"tool_calls":[{"tool":"git_diff"}]}',
    '渲染级验证（前端/页面/Web 服务的交付验收必须用它，curl 看不见 JS 运行时崩溃）:',
    ' {"tool_calls":[{"tool":"check_page","url":"http://localhost:<端口>/","expect":["页面渲染后应出现的文本1","文本2"]}]}',
    '（headless 浏览器渲染 URL，expect 全部命中才 ok；仅允许 localhost 地址，需先起服务）',
    '技能正文按需拉取：下方"已装载技能"只有索引，与任务相关的技能必须先拉正文再动工（可与侦查合并同一轮）:',
    ' {"tool_calls":[{"tool":"load_skill","name":"技能名"}]}',
    '经验沉淀（推荐）：遇到通用经验/项目踩坑时主动调用知识写入工具:',
    ' {"tool_calls":[{"tool":"write_knowledge","category":"general-tech|project","title":"条目标题","tags":["标签"],"content":"经验内容（Markdown）"}]}',
    '协同文档（文档驱动协同）：实现涉及 API/接口的节点后，必须把实际接口写入 API_CONTRACT；需要修正任务规格/状态时写对应文档:',
    ' {"tool_calls":[{"tool":"write_doc","type":"TASK_SPEC|API_CONTRACT|STATUS_REPORT","content":"完整 Markdown 文档内容"}]}',
    'Agent 间留言（必要时）：需要提醒/询问其他 Agent、主 Agent 或用户时发送留言，收件方在它下次执行时会收到:',
    ' {"tool_calls":[{"tool":"send_message","to":"agent名|orchestrator|user","text":"留言内容（≤2000字）"}]}',
    '工具纪律：write_doc/send_message 的产出不计入 changes；实现了接口就必须同步 write_doc 更新 API_CONTRACT，下游节点以文档为准。',
    '目录边界（强制）：一切文件与命令只允许作用于项目工作目录内——命令中出现工作目录之外的绝对路径或 `..` 逃逸会被系统直接拒绝执行；产物与日志一律写项目目录内的相对路径。',
    `轮次预算：当前第 ${round + 1}/${maxRounds} 轮，剩余 ${roundsLeft} 轮工具调用机会。${roundsLeft <= 1 ? '这是最后的侦查机会——本轮结束必须给出最终 JSON 结果。' : '合理规划：先侦查后执行，避免无目的的重复读取。'}`,
  ].join('\n');

  const L6 = [
    '# 输出契约（不再请求工具时的最终消息，必须是纯 JSON，禁止 markdown 代码栅栏）',
    '字段规范：',
    '{',
    '  "status": "success" | "failed",        // 必填',
    '  "summary": "做了什么 + 对全局目标的贡献",  // 必填，非空字符串',
    '  "verification": "验证方式与结果（运行了什么命令/逐项核对了什么；分析型任务写核对的证据）", // 必填',
    '  "changes": ["文件路径: 改动说明"],        // 字符串数组，必须如实列出全部写入/修改的文件',
    '  "errors": ["错误说明"],                  // 字符串数组',
    '  "files": [{"path":"相对路径","content":"完整文件内容"}],  // 对象数组，content 必须是完整可落盘内容',
    '  "edits": [{"path":"已有文件相对路径","find":"要替换的原文（精确唯一）","replace":"替换后的文本"}],  // 对已有文件的小改动优先用 edits（省 token）；find 必须与文件现有内容精确匹配',
    '  "commands": ["要执行的命令"],             // 字符串数组，在沙箱中执行（仅限白名单命令）',
    '  "defects": [{"title":"缺陷标题","detail":"具体描述与复现条件","severity":"low|medium|high"}]  // 发现但本次未修复的问题（已修复的写 errors，潜在风险/技术债写 defects）',
    '}',
    '高频错误（每次输出前自查）：',
    '- 把 JSON 包进 ```json 代码栅栏（禁止）',
    '- summary/verification 留空或写 TODO 占位（禁止）',
    '- files[].content 只给片段不给完整文件内容（禁止）',
    '- 编造没有验证过的 changes（禁止）',
    '- changes 漏报实际写入/修改的文件（系统会核对申报与实际写入，漏报会被标记）',
    '- 测试栈与项目技术栈不符：JS/TS 项目（package.json）用 vitest/jest/node --test，Python 项目才用 pytest',
    '- 用"代码看起来正确/逻辑上应该能跑"代替真实运行证据（禁止）——页面白屏、导入方式不匹配（default vs 具名）、未使用的幻觉 import 这类问题只有实际运行/打开才会暴露，验证节点必须实际运行',
    '分析/调查类任务：结论写进 summary（要详细），files/commands 留空数组，verification 写你核对了哪些证据。',
  ].join('\n');

  const escalateNote = ctx.escalate
    ? `\n该任务此前已尝试多次均失败，最近一次错误：${(ctx.lastError || '').slice(0, 600)}\n请调整策略：换思路，或把任务缩小到可完成的最小闭环。`
    : '';

  const L7 = [
    '# 升级语义（何时放弃并求助）',
    '- 缺关键信息/权限/依赖 → status="failed"，error 写清"需要人类补充/授权什么"',
    '- 自查发现产出不可能满足任务要求 → status="failed"，说明原因，不要交付明知错误的结果',
    '- 只有确实完成且验证通过才 status="success"——错误的 success 比 failed 危害大得多。',
  ].join('\n');

  return [L1, L2, L3, L4, L5, L6 + escalateNote, L7].join('\n\n');
}

export interface AgentResultViolations {
  ok: boolean;
  violations: string[];
}

/**
 * Schema gate on the model's final JSON. Returns specific violations so the
 * repair round can be surgical instead of a generic "bad JSON" complaint.
 */
export function validateAgentResult(parsed: unknown): AgentResultViolations {
  const violations: string[] = [];
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, violations: ['最终输出必须是 JSON 对象'] };
  }
  const r = parsed as Record<string, any>;

  if (r.status !== 'success' && r.status !== 'failed') {
    violations.push('status 必须是 "success" 或 "failed"');
  }
  if (typeof r.summary !== 'string' || !r.summary.trim()) {
    violations.push('summary 必须是非空字符串（做了什么 + 对全局目标的贡献）');
  }
  if (r.verification === undefined || typeof r.verification !== 'string' || !r.verification.trim()) {
    violations.push('verification 必须是非空字符串（你验证了什么、怎么验证的）');
  }
  if (r.changes !== undefined && !(Array.isArray(r.changes) && r.changes.every((c: unknown) => typeof c === 'string'))) {
    violations.push('changes 必须是字符串数组');
  }
  if (r.errors !== undefined && !(Array.isArray(r.errors) && r.errors.every((c: unknown) => typeof c === 'string'))) {
    violations.push('errors 必须是字符串数组');
  }
  if (r.commands !== undefined && !(Array.isArray(r.commands) && r.commands.every((c: unknown) => typeof c === 'string'))) {
    violations.push('commands 必须是字符串数组');
  }
  if (r.files !== undefined) {
    if (!Array.isArray(r.files)) {
      violations.push('files 必须是数组');
    } else {
      const badFile = r.files.findIndex((f: any) => !f || typeof f !== 'object' || typeof f.path !== 'string' || typeof f.content !== 'string');
      if (badFile >= 0) violations.push(`files[${badFile}] 必须是 {"path":"相对路径","content":"完整文件内容"}，content 不能缺失或只给片段`);
    }
  }
  if (r.edits !== undefined) {
    if (!Array.isArray(r.edits)) {
      violations.push('edits 必须是数组');
    } else {
      const badEdit = r.edits.findIndex((e: any) => !e || typeof e !== 'object' || typeof e.path !== 'string' || typeof e.find !== 'string' || typeof e.replace !== 'string');
      if (badEdit >= 0) violations.push(`edits[${badEdit}] 必须是 {"path":"已有文件路径","find":"要替换的原文","replace":"替换后的文本"}`);
    }
  }
  if (r.defects !== undefined) {
    if (!Array.isArray(r.defects)) {
      violations.push('defects 必须是数组');
    } else {
      const bad = r.defects.findIndex((d: any) => !d || typeof d !== 'object' || typeof d.title !== 'string' || !d.title.trim() || typeof d.detail !== 'string' || !d.detail.trim());
      if (bad >= 0) violations.push(`defects[${bad}] 必须是 {"title":"非空标题","detail":"非空描述","severity":"low|medium|high"(可选)}`);
      const badSev = r.defects.findIndex((d: any) => d && d.severity !== undefined && !['low', 'medium', 'high'].includes(d.severity));
      if (badSev >= 0) violations.push(`defects[${badSev}].severity 只能是 low / medium / high`);
    }
  }
  return { ok: violations.length === 0, violations };
}

/** Build the corrective user message for a schema-violating output. */
export function buildRepairMessage(violations: string[]): string {
  return [
    '你的最终 JSON 未通过输出契约校验，具体违规：',
    ...violations.map((v, i) => `${i + 1}. ${v}`),
    '请立即重新输出完整 JSON（纯 JSON，无 markdown 栅栏），修正以上全部问题。字段规范见系统提示的「输出契约」。',
  ].join('\n');
}
