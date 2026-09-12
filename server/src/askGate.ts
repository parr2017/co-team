import { busGet, busSet } from './bus';
import { emitProgress } from './store';

/**
 * M2 全员实时问答：阻塞式 ask 门（ask_user / ask_agent / answer 三件套的底座）。
 *
 * 设计（v1 明示取舍）：
 * - 提问记录持久化在 Redis（`task:asks:{taskId}`，上限 100 条），
 *   但"阻塞等待"是进程内存中的 Promise resolver——服务重启时挂起中的 ask
 *   由 sweepStaleAsks 统一按"无回答"落盘，节点走既有失败路径接管。
 * - 等待期间不占任何模型槽位（没有在途 chat 调用）。
 * - 每个任务的在途 ask 上限与 send_message 同阶（100），单条提问截 2000 字符。
 */

export interface PendingAsk {
  id: string;
  task_id: string;
  /** 提问方（agent 名） */
  from: string;
  /** 'user' 或目标 agent 名 */
  to: string;
  question: string;
  node_id?: string;
  node_name?: string;
  ts: string;
  status: 'pending' | 'answered' | 'timeout' | 'cancelled' | 'unanswered';
  answer?: string;
  answered_by?: string;
  answered_at?: string;
}

export interface AskResolution {
  answer?: string;
  by?: string;
  /** true = 超时/取消/对方未回答，调用方应按假设继续并把假设写进 result */
  noAnswer: boolean;
  reason?: 'timeout' | 'cancelled' | 'unanswered';
}

const MAX_ASKS_PER_TASK = 100;
const MAX_QUESTION_CHARS = 2000;

type Resolver = (r: AskResolution) => void;

/** askId → resolver + task 归属（内存态，重启即失） */
const resolvers = new Map<string, { resolve: Resolver; taskId: string }>();

let defaultTimeoutMs = 15 * 60 * 1000;

export function configureAskGate(opts: { timeoutSec?: number }): void {
  if (opts.timeoutSec && opts.timeoutSec > 0) defaultTimeoutMs = opts.timeoutSec * 1000;
}

export function getAskTimeoutMs(): number {
  return defaultTimeoutMs;
}

async function loadAsks(taskId: string): Promise<PendingAsk[]> {
  return (await busGet<PendingAsk[]>(`task:asks:${taskId}`)) || [];
}

/** 登记一条提问（持久化 + 事件），返回带 id 的记录。 */
export async function createAsk(ask: Omit<PendingAsk, 'id' | 'ts' | 'status'>): Promise<PendingAsk> {
  const record: PendingAsk = {
    ...ask,
    question: String(ask.question || '').slice(0, MAX_QUESTION_CHARS),
    id: Math.random().toString(36).slice(2, 10),
    ts: new Date().toISOString(),
    status: 'pending',
  };
  const asks = await loadAsks(record.task_id);
  asks.push(record);
  if (asks.length > MAX_ASKS_PER_TASK) asks.splice(0, asks.length - MAX_ASKS_PER_TASK);
  await busSet(`task:asks:${record.task_id}`, asks);
  await emitProgress('ask_created', {
    task_id: record.task_id, ask_id: record.id, from: record.from, to: record.to,
    node_id: record.node_id, question: record.question,
  });
  return record;
}

/** 阻塞等待一条提问被回答。超时/取消/对方收线都会以 noAnswer 收场。 */
export function waitForAnswer(askId: string, taskId: string, timeoutMs = defaultTimeoutMs): Promise<AskResolution> {
  return new Promise<AskResolution>((resolve) => {
    let settled = false;
    const done = (r: AskResolution) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvers.delete(askId);
      resolve(r);
    };
    const timer = setTimeout(() => {
      void markTimeout(askId, taskId).catch(() => {});
      done({ noAnswer: true, reason: 'timeout' });
    }, Math.max(1000, timeoutMs));
    resolvers.set(askId, { resolve: done, taskId });
  });
}

async function markTimeout(askId: string, taskId: string): Promise<void> {
  const asks = await loadAsks(taskId);
  const rec = asks.find((a) => a.id === askId);
  if (!rec || rec.status !== 'pending') return;
  rec.status = 'timeout';
  rec.answer = '超时未回答';
  rec.answered_at = new Date().toISOString();
  await busSet(`task:asks:${taskId}`, asks);
}

/** 回答一条提问（API 答复入口 / answer 工具共用）。返回是否命中在飞等待。 */
export async function resolveAsk(askId: string, taskId: string, answer: string, by: string): Promise<boolean> {
  const asks = await loadAsks(taskId);
  const rec = asks.find((a) => a.id === askId);
  if (!rec || rec.status !== 'pending') return false;
  rec.status = 'answered';
  rec.answer = String(answer || '').slice(0, MAX_QUESTION_CHARS);
  rec.answered_by = by;
  rec.answered_at = new Date().toISOString();
  await busSet(`task:asks:${taskId}`, asks);
  const entry = resolvers.get(askId);
  if (entry) {
    entry.resolve({ answer: rec.answer, by, noAnswer: false });
    return true;
  }
  return false;
}

/** 内部收场：超时/取消/未回答时更新持久化状态（不影响已在飞的 resolver——它们自己会超时）。 */
async function settleAsk(askId: string, taskId: string, status: PendingAsk['status'], reason: string): Promise<void> {
  const asks = await loadAsks(taskId);
  const rec = asks.find((a) => a.id === askId);
  if (!rec || rec.status !== 'pending') return;
  rec.status = status;
  rec.answer = reason;
  rec.answered_at = new Date().toISOString();
  await busSet(`task:asks:${taskId}`, asks);
}

/** 任务取消/终止时：所有在飞等待立即按 cancelled 收场（节点侧据此按假设继续或失败）。 */
export async function cancelAsks(taskId: string, reason = '任务已取消'): Promise<number> {
  let n = 0;
  for (const [askId, entry] of [...resolvers.entries()]) {
    if (entry.taskId !== taskId) continue;
    resolvers.delete(askId);
    entry.resolve({ noAnswer: true, reason: 'cancelled' });
    await settleAsk(askId, taskId, 'cancelled', reason);
    n += 1;
  }
  return n;
}

/** 主动放弃一条提问（咨询不可用等）：立即释放等待者并落盘。 */
export async function abandonAsk(askId: string, taskId: string, reason: string): Promise<void> {
  const entry = resolvers.get(askId);
  if (entry) {
    resolvers.delete(askId);
    entry.resolve({ noAnswer: true, reason: 'unanswered' });
  }
  await settleAsk(askId, taskId, 'unanswered', reason);
}

/** 某 agent 的全部 dispatch 结束：投递给它（to===agent）且未回答的 ask 收场。
 *  注意只清"接收方"方向——提问方（from）自己的 ask 由其所属 dispatch 的等待/超时收场，
 *  否则同名 agent 并发执行时，兄弟 dispatch 的收尾会误杀在途提问。 */
export async function flushAgentAsks(taskId: string, agent: string): Promise<number> {
  const asks = await loadAsks(taskId);
  let n = 0;
  for (const rec of asks) {
    if (rec.status !== 'pending' || rec.to !== agent) continue;
    await abandonAsk(rec.id, taskId, '对方会话结束未回答');
    n += 1;
  }
  return n;
}

/** 服务重启恢复：进程内存 resolver 已全部丢失；在任务重新执行入口调用本函数，
 *  把该任务所有 pending ask 落为 timeout（节点重跑后会重新提问，旧等待作废）。 */
export async function settleTaskPendingAsks(taskId: string, reason = '服务重启，等待中断'): Promise<number> {
  const asks = await loadAsks(taskId);
  let n = 0;
  for (const rec of asks) {
    if (rec.status !== 'pending') continue;
    const entry = resolvers.get(rec.id);
    if (entry) {
      resolvers.delete(rec.id);
      entry.resolve({ noAnswer: true, reason: 'cancelled' });
    }
    rec.status = 'timeout';
    rec.answer = reason;
    rec.answered_at = new Date().toISOString();
    n += 1;
  }
  if (n) await busSet(`task:asks:${taskId}`, asks);
  return n;
}

/** 把提问投递给正在执行的某 agent（轮间注入队列）。 */
export async function queueAskForAgent(taskId: string, agent: string, item: { ask_id: string; from: string; question: string }): Promise<void> {
  const key = `task:askq:${taskId}:${agent}`;
  const queue = (await busGet<{ ask_id: string; from: string; question: string }[]>(key)) || [];
  queue.push(item);
  await busSet(key, queue);
}

/** 消费投递给某 agent 的全部在途提问（callAgent 轮间调用，consume 即清空）。 */
export async function consumeAskQueue(taskId: string, agent: string): Promise<{ ask_id: string; from: string; question: string }[]> {
  const key = `task:askq:${taskId}:${agent}`;
  const queue = (await busGet<{ ask_id: string; from: string; question: string }[]>(key)) || [];
  if (queue.length) await busSet(key, []);
  return queue;
}

export async function listAsks(taskId: string): Promise<PendingAsk[]> {
  return loadAsks(taskId);
}
