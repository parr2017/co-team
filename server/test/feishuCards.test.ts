/**
 * 飞书卡片构件的形状约束测试。
 * 这里的每条断言都对应一次真实踩坑：卡片 JSON 少一个字段只是样式不对，
 * 多一个飞书不认的属性则**整卡被拒**（230099 / 200621），用户那边表现为"什么都没收到"。
 */
import { describe, expect, it } from 'vitest';
import { card2, collapse, inputField, md, note, submitBtn, form } from '../src/feishu/cards';

describe('feishu cards 构件', () => {
  it('card2：2.0 骨架 + header 模板', () => {
    const card = card2('orange', '标题', [md('x')]);
    expect(card.schema).toBe('2.0');
    expect((card.header as any).title.content).toBe('标题');
    expect((card.header as any).template).toBe('orange');
  });

  it('collapse：只带飞书认可的字段（探针 scripts/probe-collapse-panel.cjs 实测）', () => {
    const panel = collapse('全部目标（8 项）', [md('1. a')]) as Record<string, any>;
    // 没有 expand：塞顶层或 header 都会被判 unknown property → 整卡被拒
    expect(panel.expand).toBeUndefined();
    expect(panel.header.expand).toBeUndefined();
    // header 只允许 title / background_color / vertical_align
    expect(Object.keys(panel.header).sort()).toEqual(['background_color', 'title', 'vertical_align']);
    // padding 会被判 "invalid panel header padding"
    expect(panel.header.padding).toBeUndefined();
    expect(Object.keys(panel.border).sort()).toEqual(['color', 'corner_radius']);
    expect(panel.tag).toBe('collapsible_panel');
    expect(panel.elements).toHaveLength(1);
  });

  it('note 是 markdown（2.0 不支持 1.0 的 note 标签，230099）', () => {
    expect(note('落款').tag).toBe('markdown');
  });

  it('inputField：max_length 封顶 1000（超限整卡被拒 11310）', () => {
    expect((inputField('a', 'x', 5000) as any).max_length).toBe(1000);
  });

  it('form/submitBtn：提交按钮带 form_action_type 才能回传 form_value', () => {
    const f = form('ib_x', [inputField('answer', '输入…'), submitBtn('发送', 'go')]) as Record<string, any>;
    const btn = f.elements.at(-1);
    expect(f.tag).toBe('form');
    expect(btn.form_action_type).toBe('submit');
    expect(btn.name).toBe('go');
  });
});
