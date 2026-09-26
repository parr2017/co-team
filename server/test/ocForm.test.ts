import { describe, expect, it } from 'vitest';
import {
  buildFormAnswer,
  formFieldsSignature,
  initialFormValues,
  isRecommendedOption,
  loadFormDraft,
  missingRequiredKeys,
  saveFormDraft,
  serializeFormAsMarkdown,
  stripRecommendedMarker,
  visibleFields,
  type FormFieldView,
} from '@co-team/opencode-sync';

const F = (over: Partial<FormFieldView> & { key: string }): FormFieldView => ({
  key: over.key,
  type: 'input',
  question: over.question ?? over.key,
  ...over,
});

describe('OpenCode 表单状态机（双端共享契约）', () => {
  const fields: FormFieldView[] = [
    F({ key: 'entrance', type: 'multiselect', question: '目标入口', required: true, custom: true, multiple: true, options: [{ value: 'desktop', label: '桌面客户端' }, { value: 'web', label: 'Web 端' }] }),
    F({ key: 'domain', type: 'select', question: '入口域名', when: [{ key: 'entrance', op: 'eq', value: 'web' }], options: [{ value: 'lan', label: '内网' }] }),
    F({ key: 'concurrency', type: 'number', question: '并发数', minimum: 1, maximum: 5 }),
    F({ key: 'allowWrite', type: 'boolean', question: '允许写文件' }),
    F({ key: 'eula', type: 'external', question: '授权协议', externalUrl: 'https://example.com/eula', required: true }),
    F({ key: 'note', type: 'input', question: '补充说明' }),
    F({ key: 'secret', type: 'input', question: '内部备注', hidden: true }),
  ];

  it('初值只覆盖可见字段（hidden 不占 UI 状态）', () => {
    const values = initialFormValues(fields);
    // 字段序（非字母序）：entrance / concurrency / allowWrite / eula / note，domain 被 when 隐藏、secret 被 hidden 隐藏
    expect(Object.keys(values)).toEqual(['entrance', 'concurrency', 'allowWrite', 'eula', 'note']);
  });

  it('when 条件：entrance 含 web 时 domain 才可见（multiselect 用 includes 语义）', () => {
    const empty = initialFormValues(fields);
    expect(visibleFields(fields, empty).map((f) => f.key)).not.toContain('domain');
    const withWeb = initialFormValues(fields);
    withWeb.entrance.selected = ['web'];
    expect(visibleFields(fields, withWeb).map((f) => f.key)).toContain('domain');
    const withDesktop = initialFormValues(fields);
    withDesktop.entrance.selected = ['desktop'];
    expect(visibleFields(fields, withDesktop).map((f) => f.key)).not.toContain('domain');
  });

  it('必填校验：external 未打开/entrance 未答算缺，boolean 恒已答，hidden 不参与', () => {
    const values = initialFormValues(fields);
    expect(missingRequiredKeys(fields, values)).toEqual(['entrance', 'eula']);
    values.eula.ack = true;
    values.entrance.selected = ['desktop'];
    expect(missingRequiredKeys(fields, values)).toEqual([]);
  });

  it('提交值收口：multiselect 数组（Other 文本并入尾部）/ number / boolean / external=true / 其他空槽占位', () => {
    const values = initialFormValues(fields);
    values.entrance.selected = ['desktop'];
    values.entrance.custom = true;
    values.entrance.text = 'CLI 直连';
    values.concurrency.num = 3;
    values.allowWrite.bool = false;
    values.eula.ack = true;
    const answer = buildFormAnswer(fields, values);
    expect(answer.entrance).toEqual(['desktop', 'CLI 直连']);
    expect(answer.concurrency).toBe(3);
    expect(answer.allowWrite).toBe(false);
    expect(answer.eula).toBe(true);
    expect(answer.note).toBe('');
    expect(answer).not.toHaveProperty('secret');
  });

  it('草稿按 form.id + 字段签名持久化：签名变了作废，未变恢复', () => {
    const sig = formFieldsSignature(fields);
    const values = initialFormValues(fields);
    values.note.text = '半截答案';
    saveFormDraft('form-9', sig, values);
    expect(loadFormDraft('form-9', sig)?.note.text).toBe('半截答案');
    expect(loadFormDraft('form-9', sig + 'x')).toBeUndefined();
  });

  it('recommended 标记识别与剥离；Markdown 序列化含选项描述与推荐徽章', () => {
    expect(isRecommendedOption('单点登录 (recommended)')).toBe(true);
    expect(stripRecommendedMarker('单点登录 (recommended)')).toBe('单点登录');
    const md = serializeFormAsMarkdown({
      title: '挖 token 前的确认',
      fields: [F({ key: 'q1', type: 'multiselect', question: 'token 用途', options: [{ value: 'sso', label: '单点登录 (recommended)', description: '免登' }] })],
    });
    expect(md).toContain('# 挖 token 前的确认');
    expect(md).toContain('## token 用途');
    expect(md).toContain('- **单点登录（推荐）** — 免登');
    expect(md).toContain('_可多选。_');
  });
});
