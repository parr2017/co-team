/**
 * 功能面板卡（/help 与 /panel 的渲染载体）：模式感知的按钮面板——
 * 点击按钮 = 向既有命令管道合成一条消息事件（cmd 文本），命令解析/模式路由/
 * 去重/回执全部复用；面板响应帧返回 undefined（回滚=面板保留，可连点）。
 */
import { card2, md, note, btnRow, type CardElement } from './cards';

export const PANEL_ACT = 'panel';

type Btn = [text: string, cmd: string, type?: 'primary' | 'default' | 'danger'];

export function buildPanelCard(mode: string): Record<string, unknown> {
  const rows: Btn[][] = [
    [['📥 收件箱', '/inbox', 'primary'], ['📊 指标', '/metrics'], ['📈 状态', '/status']],
    [['📋 最近任务', '/tasks'], ['🚦 队列', '/queue']],
    [['💬 会话模式', '/convo', 'primary'], ['🖥 OpenCode', '/oc']],
  ];
  if (mode === 'convo') rows.push([['📜 会话列表', '/list'], ['🆕 新建会话', '/new'], ['⏹ 停止', '/stop', 'danger']]);
  if (mode === 'oc') rows.push([['📜 会话列表', '/list'], ['🆕 新建', '/new'], ['⏹ 中止', '/stop']]);
  if (mode === 'oc') rows.push([['🧠 模型', '/model'], ['🤖 Agent', '/agent']]);
  if (mode !== 'task') rows.push([['↩ 返回任务模式', '/exit']]);

  const elements: CardElement[] = [];
  for (const row of rows) {
    const btns = row.map(([text, cmd, type]) => ({ text, cmd, type: type || 'default' as const }));
    if (btns.length === 1) elements.push(singleBtn(btns[0]));
    else if (btns.length === 2) elements.push(btnRow(singleBtn(btns[0]), singleBtn(btns[1])));
    else elements.push(threeCols(btns));
  }
  const modeName = mode === 'task' ? '任务' : mode === 'convo' ? '协作会话' : 'OpenCode';
  elements.push(note(`Co-Team · 功能面板 · ${modeName}模式 · 点击即执行，结果以消息推送`));
  return card2('blue', '🎛 Co-Team 功能面板', elements);
}

function singleBtn(b: { text: string; cmd: string; type: 'primary' | 'default' | 'danger' }): CardElement {
  return {
    tag: 'button', text: { tag: 'plain_text', content: b.text }, type: b.type, size: 'medium',
    behaviors: [{ type: 'callback', value: { act: PANEL_ACT, cmd: b.cmd } }],
  };
}

function threeCols(btns: { text: string; cmd: string; type: 'primary' | 'default' | 'danger' }[]): CardElement {
  return {
    tag: 'column_set', flex_mode: 'trisect',
    columns: btns.map((b) => ({ tag: 'column', width: 'weighted', weight: 1, elements: [singleBtn(b)] })),
  };
}

/** 供 /help 文本降级用的模式提示行（面板卡已是主入口）。 */
export function panelHint(mode: string): string {
  return `发送 /panel 打开按钮面板（当前：${mode === 'task' ? '任务' : mode === 'convo' ? '协作会话' : 'OpenCode'}模式）`;
}
