/**
 * P2.1 token 基线：CJK 感知估算 + 真实用量校准环。
 *
 * - 纯启发式（零依赖，不引 tiktoken）：CJK 字符 ≈1 token/字（现代 BPE 对中日韩的实测区间
 *   0.9-1.2），其余字符按 4.2 字符/token（gpt 系英文代码均值）；bge-m3/中文模型的 CJK 压缩
 *   略高，但水位线分级本身有 5-10% 容差，估算误差目标 <15% 足够。
 * - 校准环：llm.ts 每次拿到真实 usage.prompt_tokens 后调 noteRealUsage(real, estimatedText)
 *   ——按「真实/估算」比值的 EMA（α=0.1，限幅 0.6-2.0 防异常遥测炸穿预算）修正后续估算。
 *   基线语义对齐星瑶 min(真实, 估算)：校准比天然落在真实值一侧。
 */
import { getLogger } from './logger';

const CJK_RE = /[\u2e80-\u9fff\uf900-\ufaff\uff00-\uffef\u3000-\u303f]/g;
const NON_CJK_PER_TOKEN = 4.2;

/** 原始估算（未校准）：CJK 1:1 + 其余 4.2:1 */
export function estimateTokensRaw(text: string): number {
  if (!text) return 0;
  const cjk = text.match(CJK_RE)?.length ?? 0;
  const rest = text.length - cjk;
  return Math.ceil(cjk + rest / NON_CJK_PER_TOKEN);
}

/** 全局校准比 EMA（跨模型共享——调用方通常不传模型名，水位线只需一个稳定基线） */
let ratio = 1.0;
let calibrated = false;

/** llm.ts 拿到真实 usage 后回调：real=usage.prompt_tokens，text=发给模型的完整请求文本 */
export function noteRealUsage(real: number, text: string): void {
  if (!real || real <= 0 || !text) return;
  const est = estimateTokensRaw(text);
  if (est <= 0) return;
  const sample = real / est;
  // 限幅：遥测异常（网关重复计数等）不能带偏基线
  const clamped = Math.min(2.0, Math.max(0.6, sample));
  ratio = calibrated ? ratio * 0.9 + clamped * 0.1 : clamped;
  calibrated = true;
}

/** 校准后的估算（主入口）。 */
export function estimateTokensCalibrated(text: string): number {
  return Math.ceil(estimateTokensRaw(text) * ratio);
}

/** 当前校准状态（观测用：日志/metrics）。 */
export function calibrationSnapshot(): { ratio: number; calibrated: boolean } {
  return { ratio: Math.round(ratio * 1000) / 1000, calibrated };
}

/** 周期性观测：校准比偏出 [0.7, 1.5] 时告警一次（提示估算器需要重新标定）。 */
let lastWarnRatio = 1;
export function warnIfDrift(): void {
  if (!calibrated) return;
  if ((ratio < 0.7 || ratio > 1.5) && Math.abs(ratio - lastWarnRatio) > 0.2) {
    lastWarnRatio = ratio;
    try { getLogger().warn('token estimator calibration drifted', { ratio }); } catch { /* test env */ }
  }
}
