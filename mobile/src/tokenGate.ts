/**
 * SEC-P0 Token 门禁（移动端）：
 * - 任一 API 请求收到 401 → 打开全局输入层（Promise 共享，并发 401 归一到同一次输入）
 * - 用户提交后 resolve(true)，所有等待方以新 token 重试原请求；关闭则 resolve(false)
 * - 不用 window.prompt：iOS PWA standalone 下 prompt 常被抑制，且样式突兀
 */
import { ref } from 'vue';

export const tokenGateVisible = ref(false);

let waiter: ((ok: boolean) => void) | null = null;

export function openTokenGate(): Promise<boolean> {
  if (waiter) {
    // 已有等待方：后续 401 挂到同一次 resolve 上，避免叠弹层
    const prev = waiter;
    return new Promise((resolve) => {
      waiter = (ok) => { prev(ok); resolve(ok); };
    });
  }
  tokenGateVisible.value = true;
  return new Promise((resolve) => { waiter = resolve; });
}

export function resolveTokenGate(ok: boolean) {
  tokenGateVisible.value = false;
  waiter?.(ok);
  waiter = null;
}
