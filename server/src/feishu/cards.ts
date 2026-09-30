/**
 * 飞书卡片 2.0 构建构件（全部桥共享）。
 * 实测红线：
 * - 2.0 不支持 1.0 的 `note` 标签（230099）——落款用 markdown；
 * - 按钮回调必须 `behaviors:[{type:'callback',value}]`（旧版回传长连接收不到）；
 * - 回调结果卡必须 `{card:{type:'raw',data}}` 随响应帧返回，裸卡片会被回滚。
 */

export type CardElement = Record<string, unknown>;

export function card2(template: string, title: string, elements: CardElement[]): Record<string, unknown> {
  return {
    schema: '2.0',
    config: { update_multi: true },
    header: { title: { tag: 'plain_text', content: title }, template },
    body: { elements },
  };
}

export function md(content: string): CardElement {
  return { tag: 'markdown', content };
}

/** 落款/提示行（2.0 无 note 标签，用 markdown 替代）。 */
export function note(content: string): CardElement {
  return md(content);
}

/**
 * 工作区路径 → 项目名。通知卡上的「这是哪个项目的事」——路径太长，项目名才是人的索引。
 * 未登记为项目的目录退回最后一段目录名；空路径返回空串（调用方自行决定回落文案）。
 */
export function projectLabelOf(workspace: string | null | undefined, projects?: { name: string; workspace: string }[]): string {
  const norm = (d: string | null | undefined) => String(d || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  const w = norm(workspace);
  if (!w) return '';
  const hit = (projects || []).find((p) => norm(p.workspace) === w);
  if (hit?.name) return hit.name;
  return w.split('/').filter(Boolean).at(-1) || '';
}

/**
 * 「来源」行：引擎 + 可选上下文。审批/提问卡在同一个群里混排时，一眼分清
 * 这张是 OpenCode（外部编码引擎）提的还是 Co-Team 内置 agent 提的，属于哪个项目。
 */
export function sourceLine(engine: string, ctx?: { instance?: string; project?: string; session?: string }): CardElement {
  const bits = [engine];
  if (ctx?.instance) bits.push(`实例 ${ctx.instance}`);
  if (ctx?.project) bits.push(`项目 ${ctx.project}`);
  if (ctx?.session) bits.push(`会话 ${ctx.session}`);
  return md(`**来源** ${bits.join(' · ')}`);
}

/**
 * 折叠面板（2.0 `collapsible_panel`）：长命令/多资源时收纳，避免主卡被撑爆。
 * 实测红线（探针 scripts/probe-collapse-panel.cjs 逐字段试出来的，踩错整卡被拒 230099/200621）：
 * - 没有 `expand` 属性（塞顶层或 header 都报 unknown property），默认就是折叠态；
 * - header 只吃 title / background_color / vertical_align，`padding` 会报 "invalid panel header padding"；
 * - border 吃 color / corner_radius。
 */
export function collapse(title: string, elements: CardElement[]): CardElement {
  return {
    tag: 'collapsible_panel',
    header: { title: { tag: 'plain_text', content: title }, background_color: 'grey', vertical_align: 'center' },
    border: { color: 'grey', corner_radius: '6px' },
    elements,
  };
}

export function btn(text: string, type: 'primary' | 'default' | 'danger', value: Record<string, unknown>): CardElement {
  return {
    tag: 'button',
    text: { tag: 'plain_text', content: text },
    type,
    size: 'medium',
    behaviors: [{ type: 'callback', value }],
  };
}

export function btnRow(left: CardElement, right: CardElement): CardElement {
  return {
    tag: 'column_set',
    flex_mode: 'bisect',
    columns: [
      { tag: 'column', width: 'weighted', weight: 1, elements: [left] },
      { tag: 'column', width: 'weighted', weight: 1, elements: [right] },
    ],
  };
}

/** 表单单行输入框（form_action_type:submit 的按钮提交后，回调 action.form_value 携带 {name: 值}）。
 *  注意：max_length 上限 1000——实测超限整卡被拒（230099 ErrCode 11310）。 */
export function inputField(name: string, placeholder: string, maxLength = 1000): CardElement {
  return {
    tag: 'input',
    name,
    max_length: Math.min(maxLength, 1000),
    placeholder: { tag: 'plain_text', content: placeholder },
  };
}

/** 表单容器：submit 按钮的 name 用作路由令牌（fa|act|id1|id2…），见 wsGateway 解析。 */
export function form(name: string, elements: CardElement[]): CardElement {
  return { tag: 'form', name, elements };
}

export function submitBtn(text: string, routeName: string): CardElement {
  return {
    tag: 'button',
    text: { tag: 'plain_text', content: text },
    type: 'primary',
    size: 'medium',
    form_action_type: 'submit',
    name: routeName,
  };
}

/** 决策结果卡（所有按钮操作的统一回执，随响应帧返回）。 */
export function buildResultCard(title: string, lines: string[]): Record<string, unknown> {
  const negative = title.includes('拒绝') || title.includes('取消') || title.includes('失败') || title.includes('超时') || title.includes('已处理');
  return card2(
    negative ? 'red' : 'green',
    title,
    [...lines.map((l) => md(l)), note(`Co-Team · ${new Date().toLocaleString()}`)],
  );
}

/** 响应帧包装：裸卡片 JSON 会被飞书当空响应回滚。 */
export function cardResponse(card: Record<string, unknown>): Record<string, unknown> {
  return { card: { type: 'raw', data: card } };
}
