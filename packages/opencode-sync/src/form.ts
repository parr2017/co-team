/**
 * OpenCode 2.x 提问表单的双端共享契约与纯逻辑（web/mobile 渲染共用，无框架依赖）：
 * - FormFieldView：服务端 form.created → question.asked 映射产出的字段视图模型；
 * - 表单状态机：初值 / when 条件可见性 / 必填校验 / 提交值收口 / 草稿持久化；
 * - 问题携带序列化器：复制为 Markdown（人读）或 JSON（喂脚本）。
 * 参考 OpenChamber FormCard/formCardState 的行为契约。
 */

export type FormFieldType = 'multiselect' | 'select' | 'input' | 'number' | 'boolean' | 'external';

export interface FormOptionView {
  /** 提交给 opencode 的选项值（缺省回落 label） */
  value: string;
  label: string;
  description?: string;
}

/** when 子句引用的其他字段答案条件（全部满足才显示） */
export interface FormWhenClause {
  key: string;
  op: 'eq' | 'neq';
  value: string | number | boolean;
}

export interface FormFieldView {
  /** opencode form 字段 key——提交答案按 key 收口 */
  key: string;
  type: FormFieldType;
  /** 主问题文本（title 优先，兼容 question 直传） */
  question: string;
  /** AskUserQuestion 风格短标签（分组标题） */
  header?: string;
  /** 补充说明（markdown 渲染） */
  description?: string;
  placeholder?: string;
  required?: boolean;
  /** 服务端隐藏字段：不渲染、不校验、不提交（default 由 opencode 侧自补） */
  hidden?: boolean;
  when?: FormWhenClause[];
  minimum?: number;
  maximum?: number;
  /** multiselect 且未限定只选 1 项 */
  multiple?: boolean;
  /** 可自由输入（"Other"），multiselect 下与勾选项共存 */
  custom?: boolean;
  /** external 字段的确认链接（打开即确认，回执须为 true） */
  externalUrl?: string;
  options?: FormOptionView[];
}

/** 单字段的本地作答槽位（各类型各取所需） */
export interface FormFieldValue {
  selected: string[];
  text: string;
  num: number | null;
  bool: boolean;
  /** external 链接已打开（确认） */
  ack: boolean;
  /** 走 "Other" 自由输入 */
  custom: boolean;
}

export type FormValues = Record<string, FormFieldValue>;

const RECOMMENDED_MARKER = /\s*\(recommended\)\s*/i;

/** 选项 label 是否带模型标的 "(recommended)" 标记 */
export const isRecommendedOption = (label: string): boolean => RECOMMENDED_MARKER.test(label);

/** 剥掉 recommended 标记的 label（卡片上以徽章呈现） */
export const stripRecommendedMarker = (label: string): string => label.replace(RECOMMENDED_MARKER, ' ').trim();

export function emptyFieldValue(): FormFieldValue {
  return { selected: [], text: '', num: null, bool: false, ack: false, custom: false };
}

export function fieldValueOf(values: FormValues, key: string): FormFieldValue {
  return values[key] ?? emptyFieldValue();
}

/** 单字段是否已作答（必填校验的判据；boolean 恒为已答——false 是合法值） */
export function isFieldAnswered(field: FormFieldView, v: FormFieldValue): boolean {
  switch (field.type) {
    case 'external':
      return v.ack;
    case 'boolean':
      return true;
    case 'number':
      return v.num !== null;
    case 'input':
      return v.text.trim() !== '';
    case 'multiselect':
      return v.selected.length > 0 || (v.custom === true && v.text.trim() !== '');
    case 'select':
      return v.custom === true ? v.text.trim() !== '' : v.selected.length > 0;
    default:
      return false;
  }
}

/** 字段的提交值（wire 值；也用于 when 求值）。未作答返回 undefined。 */
export function fieldAnswer(field: FormFieldView, v: FormFieldValue): string | number | boolean | string[] | undefined {
  switch (field.type) {
    case 'external':
      return v.ack ? true : undefined;
    case 'boolean':
      return v.bool;
    case 'number':
      return v.num === null ? undefined : v.num;
    case 'input':
      return v.text.trim() !== '' ? v.text : undefined;
    case 'multiselect': {
      const base = v.selected.length ? v.selected : [];
      return v.custom === true && v.text.trim() !== '' ? [...base, v.text.trim()] : base.length ? base : undefined;
    }
    case 'select':
      return v.custom === true
        ? (v.text.trim() !== '' ? v.text.trim() : undefined)
        : (v.selected.length ? v.selected[0] : undefined);
    default:
      return undefined;
  }
}

/** when 子句求值：全部满足才显示 */
function whenSatisfied(field: FormFieldView, fields: FormFieldView[], values: FormValues): boolean {
  if (!field.when?.length) return true;
  return field.when.every((clause) => {
    const refField = fields.find((f) => f.key === clause.key);
    const refVal = refField ? fieldAnswer(refField, fieldValueOf(values, clause.key)) : undefined;
    const eq = Array.isArray(refVal) ? refVal.some((entry) => entry === clause.value) : refVal === clause.value;
    return clause.op === 'neq' ? !eq : eq;
  });
}

/** 当前应显示的字段：排除 hidden、when 不满足的 */
export function visibleFields(fields: FormFieldView[], values: FormValues): FormFieldView[] {
  return fields.filter((f) => !f.hidden && whenSatisfied(f, fields, values));
}

/** 必填未答的字段 key（external 未打开也算） */
export function missingRequiredKeys(fields: FormFieldView[], values: FormValues): string[] {
  return visibleFields(fields, values)
    .filter((f) => f.required && !isFieldAnswered(f, fieldValueOf(values, f.key)))
    .map((f) => f.key);
}

/** 初值（key → 槽位；仅覆盖可见字段，hidden 字段不占 UI 状态） */
export function initialFormValues(fields: FormFieldView[]): FormValues {
  const out: FormValues = {};
  for (const f of visibleFields(fields, {})) out[f.key] = emptyFieldValue();
  return out;
}

/** 提交答案：按 key 收口，类型与 opencode form reply 对齐（multiselect→string[]、number→number、boolean→bool、external→true） */
export function buildFormAnswer(fields: FormFieldView[], values: FormValues): Record<string, string | number | boolean | string[]> {
  const out: Record<string, string | number | boolean | string[]> = {};
  for (const f of visibleFields(fields, values)) {
    const v = fieldAnswer(f, fieldValueOf(values, f.key));
    if (v === undefined) {
      if (f.type === 'multiselect') out[f.key] = [];
      else if (f.type === 'boolean') out[f.key] = false;
      else if (f.type === 'external') out[f.key] = false;
      else out[f.key] = '';
      continue;
    }
    out[f.key] = v;
  }
  return out;
}

/** 字段签名：内容真变了才允许重置草稿（pending 列表重建换对象引用不清答案） */
export function formFieldsSignature(fields: FormFieldView[]): string {
  return fields.map((f) => `${f.key}:${f.type}`).join('|');
}

// ---------- 草稿持久化（模块级内存：切换会话/组件重挂不丢，字段签名变了才作废） ----------

const formDrafts = new Map<string, { sig: string; values: FormValues }>();
const FORM_DRAFT_MAX = 50;

export function loadFormDraft(formId: string, sig: string): FormValues | undefined {
  const hit = formDrafts.get(formId);
  if (!hit || hit.sig !== sig) return undefined;
  return hit.values;
}

export function saveFormDraft(formId: string, sig: string, values: FormValues): void {
  formDrafts.set(formId, { sig, values });
  if (formDrafts.size > FORM_DRAFT_MAX) {
    const oldest = formDrafts.keys().next().value;
    if (oldest !== undefined) formDrafts.delete(oldest);
  }
}

export function dropFormDraft(formId: string): void {
  formDrafts.delete(formId);
}

// ---------- 问题携带序列化器 ----------

export interface FormCarryView {
  title?: string;
  fields: FormFieldView[];
}

/** 复制为 Markdown：每字段一节（题干/说明/选项含描述），供人读或喂给其他模型 */
export function serializeFormAsMarkdown(form: FormCarryView): string {
  const lines: string[] = [];
  const title = (form.title || '').trim();
  if (title) lines.push(`# ${title}`, '');
  for (const field of form.fields) {
    lines.push(`## ${field.header ? `【${field.header}】` : ''}${field.question || field.key}`, '');
    if (field.description?.trim()) lines.push(field.description.trim(), '');
    if (field.type === 'external') {
      if (field.externalUrl) lines.push(`<${field.externalUrl}>`, '');
      continue;
    }
    if (field.type === 'multiselect') lines.push('_可多选。_', '');
    const options = field.options ?? [];
    for (const option of options) {
      const label = isRecommendedOption(option.label) ? `${stripRecommendedMarker(option.label)}（推荐）` : option.label;
      lines.push(option.description?.trim() ? `- **${label}** — ${option.description.trim()}` : `- **${label}**`);
    }
    if (options.length) lines.push('');
  }
  return lines.join('\n').trimEnd();
}

/** 复制为 JSON：稳定信封（不含路由 id） */
export function serializeFormAsJson(form: FormCarryView): string {
  return JSON.stringify({ title: form.title || '', fields: form.fields }, null, 2);
}
