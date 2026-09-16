/**
 * B2 错误可操作化（2026-09-17）：API 错误按关键词分类挂操作建议（hint），
 * showApiError 统一展示"错误 + 下一步怎么做"。服务端错误结构不动——
 * detail 中文文案关键词匹配，覆盖四类高频求助场景，未命中回退原样展示。
 */
import { ElMessage } from 'element-plus';

export interface HintRule {
  /** detail 中的关键词（不区分大小写） */
  match: RegExp;
  /** 操作建议（告诉用户下一步做什么） */
  hint: string;
}

const HINT_RULES: HintRule[] = [
  {
    // 验收失败类：指路验收报告 + 换策略重跑
    match: /验收|acceptance/i,
    hint: '打开任务详情 → 验收报告查看失败项；可在执行策略中切换验收模式（严格/宽松）后重启任务',
  },
  {
    // 模型池类：指路模型池面板 + 手动换模
    match: /模型|model|No available model|pool/i,
    hint: '打开设置 → 模型池查看各模型健康分与冷却状态；或对任务手动更换主模型后重试',
  },
  {
    // 资源不存在类：指路刷新确认
    match: /不存在|not found|404|已删除/i,
    hint: '目标可能已被删除，刷新列表确认；若来自分享链接，请向分享人确认任务是否仍存在',
  },
  {
    // 排队/车道类：指路队列面板
    match: /队列|车道|排队|queue|lane/i,
    hint: '打开队列面板查看车道状态；被阻塞的车道需处理后点「恢复队列」',
  },
];

/** 从错误 detail 推导操作建议；未命中返回空串（不编造建议） */
export function errorHint(detail: string): string {
  for (const r of HINT_RULES) {
    if (r.match.test(detail || '')) return r.hint;
  }
  return '';
}

/** request() 抛出的 Error 可能携带 hint 属性 */
export interface ApiError extends Error {
  hint?: string;
}

/** 组件统一用这个替代 ElMessage.error(e.message)：错误 + 操作建议两行展示 */
export function showApiError(e: unknown, fallback = '操作失败'): void {
  const err = e as ApiError;
  const msg = err?.message || fallback;
  if (err?.hint) {
    ElMessage({ message: `${msg}\n💡 ${err.hint}`, type: 'error', duration: 6000, showClose: true, customClass: 'api-error-with-hint' });
  } else {
    ElMessage.error(msg);
  }
}
