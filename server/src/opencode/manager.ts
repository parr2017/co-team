/**
 * OpencodeManager —— opencode 实例注册表与生命周期（仿 mcp/manager.ts 模式）。
 *
 * 职责：
 * - managed：spawn `opencode serve`（端口可配/自动挑选、cwd=项目根、stdio 落日志），
 *   健康巡检、意外退出按退避重启（auto_start），进程树查杀；
 * - attached：免 spawn；桌面版实例 URL 留空时从桌面日志自动发现端口；Basic 鉴权按配置注入；
 * - 每个实例一条 SSE /event 订阅（断线指数退避重连），事件转发给 setEventForwarder 注册方；
 * - capabilities 探测（/doc + /global/health）兜底 v1/v2 API 世代差异；
 * - OpencodeBridge 门控：agent 可见性白名单（agent.yaml 的 opencode_instances，缺省不可见）、
 *   readonly/control 档位、allow_shell 高危开关；control 档写操作全部记审计日志。
 */
import { spawn, exec, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as path from 'node:path';
import * as os from 'node:os';
import { getLogger, type Logger } from '../logger';
import type { ModelConfig } from '../types';
import { resolveModelRef } from './modelInjection';
import { OpencodeClient } from './client';
import { EventBatcher, isDroppedEvent, eventSessionId } from './events';
import {
  DEFAULT_OC_COMMAND,
  DEFAULT_OC_HOSTNAME,
  type OcCallResult,
  type OcCapabilities,
  type OcEvent,
  type OcSession,
  type OpencodeBridge,
  type OpencodeInstanceConfig,
  type OpencodeInstanceMode,
  type OpencodeInstanceStatus,
} from './types';

const HEALTH_INTERVAL_MS = 15_000;
const HEALTH_WAIT_MS = 20_000;
const SSE_BACKOFF_MS = [1_000, 2_000, 5_000, 15_000, 30_000];
const RESTART_BACKOFF_MS = [2_000, 5_000, 15_000, 60_000];
const PROBE_TIMEOUT_MS = 8_000;

interface InstanceState {
  cfg: OpencodeInstanceConfig;
  client?: OpencodeClient;
  state: OpencodeInstanceStatus['state'];
  url: string;
  capabilities?: OcCapabilities;
  pid?: number;
  proc?: ChildProcess;
  error?: string;
  retries: number;
  healthTimer?: NodeJS.Timeout;
  restartTimer?: NodeJS.Timeout;
  eventAbort?: AbortController;
  logPath?: string;
  lastCheckedAt?: string;
  projectRoot?: string;
  /** sessionId → idle/error 等待器（run_task 复合工具；SSE session.idle/error 唤醒） */
  idleWaiters?: Map<string, { resolve: (v: 'idle' | 'error') => void; timer: NodeJS.Timeout }>;
  /** delta 微批器（TUI 同构镜像：token 级事件 50ms 合并，防 WS burst 上限） */
  batcher?: EventBatcher;
}

/** idle 等待的绝对值定义：run_task 的最坏等待预算（opencode 自主跑一个任务可能很久） */
const IDLE_WAIT_MAX_MS = 30 * 60_000;
/** 消息分页：默认尾部条数 / 上限；单条 JSON 超此值触发头尾裁剪（256KB） */
const MSG_PAGE_DEFAULT = 50;
const MSG_PAGE_MAX = 100;
const MSG_TRIM_THRESHOLD = 256 * 1024;
/** 会话消息缓存上限（LRU）：8MB 级会话 ×3 以内可接受 */
const MSG_CACHE_MAX = 3;
/** serve 进程登记表（孤儿清理用）：co-team 每次重启后按"端口当前归属=登记 pid"校验后查杀 */
function pidRegistryPath(): string {
  return path.join(os.tmpdir(), 'coteam-opencode-logs', 'pids.json');
}

/** 消息 id 提取：opencode 消息元素是 {info, parts} 包装，id 在 info.id（兼容平铺形态） */
function msgId(m: unknown): string {
  const o = m as Record<string, any>;
  return String(o?.info?.id || o?.id || '');
}

/** 缓存键：实例 + 会话 */
function cacheKey(instance: string, sessionId: string): string {
  return instance + '::' + sessionId;
}

/** 单条消息的 UI 裁剪：剥 info.system（UserMessage 的 system prompt，几百 KB，UI 不用）；
 *  超大 part 的 output/text 保留头 2KB + 尾 8KB（尾部通常是 exit code/错误摘要）；
 *  超大 input（>32KB，常见于图片 base64/长 diff）折叠为可读占位——否则裁剪形同虚设。
 *  返回被裁剪的 part id。 */
export function trimMessageForUi(msg: unknown): { msg: Record<string, any>; trimmed: string[] } {
  const m = { ...(msg as Record<string, any>) };
  const info = { ...(m.info || {}) } as Record<string, any>;
  delete info.system;
  m.info = info;
  const trimmed: string[] = [];
  const parts = Array.isArray(m.parts) ? m.parts : [];
  m.parts = parts.map((p: Record<string, any>) => {
    if (!p || typeof p !== 'object') return p;
    if (JSON.stringify(p).length <= MSG_TRIM_THRESHOLD) return p;
    if (p.id) trimmed.push(String(p.id));
    const clipped: Record<string, any> = { ...p };
    const clipTail = (field: 'output' | 'text') => {
      const v = (clipped.state && clipped.state[field]) || clipped[field];
      if (typeof v !== 'string' || v.length <= 10 * 1024) return;
      const head = v.slice(0, 2048);
      const tail = v.slice(-8192);
      const marked = `${head}\n\n…（中间省略 ${v.length - 10240} 字符，点"完整原文"查看）…\n\n${tail}`;
      if (clipped.state && typeof clipped.state === 'object' && field in (clipped.state || {})) clipped.state = { ...clipped.state, [field]: marked };
      else clipped[field] = marked;
    };
    clipTail('output');
    clipTail('text');
    // input 巨块（图片 base64 / 长 diff）：折叠为占位，避免裁剪失效前端仍收几百 KB。
    // input 可能是对象/数组/字符串（base64 直塞）——按 JSON 长度判断，不挑形态
    const st = clipped.state;
    if (st && typeof st === 'object' && st.input !== undefined && st.input !== null) {
      const inputJson = JSON.stringify(st.input);
      if (inputJson.length > 32 * 1024) {
        clipped.state = { ...st, input: { __trimmed: `输入参数过大（${inputJson.length} 字符，含图片/长文本），已折叠——点"完整原文"查看` } };
      }
    }
    // attachments 巨块（实测：read 图片的 tool part 把 base64 全塞 attachments，单条 291KB）
    const att = st?.attachments;
    if (Array.isArray(att) && JSON.stringify(att).length > 32 * 1024) {
      const names = att.map((a: Record<string, any>) => a?.filename || a?.path || a?.id || 'file').slice(0, 8);
      clipped.state = { ...st, attachments: names.map((n) => ({ filename: n })), __attachmentsTrimmed: `${att.length} 个附件内容过大已折叠（${JSON.stringify(att).length} 字符）——点"完整原文"查看` };
    }
    // metadata 巨块（个别工具把结果塞 metadata）同样折叠
    const md = clipped.metadata;
    if (md && typeof md === 'object' && JSON.stringify(md).length > 32 * 1024) {
      clipped.metadata = { __trimmed: `元数据过大（${JSON.stringify(md).length} 字符），已折叠——点"完整原文"查看` };
    }
    return clipped;
  });
  return { msg: m, trimmed };
}

/** ${ENV_VAR} 占位展开（密钥只走环境变量，与 mcp/transports.ts 同语义） */
function expandEnv(v: string): string {
  return v.replace(/\$\{([A-Z0-9_]+)\}/gi, (m, k: string) => process.env[k] ?? m);
}

/** 实例有效档位：managed 缺省 control（自家子进程）；attached 缺省 readonly */
function modeOf(cfg: OpencodeInstanceConfig): OpencodeInstanceMode {
  if (cfg.mode) return cfg.mode;
  return cfg.kind === 'managed' ? 'control' : 'readonly';
}

function withProbeTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, rej) => setTimeout(() => rej(new Error(`探测超时（${ms / 1000}s）`)), ms)),
  ]);
}

export class OpencodeManager implements OpencodeBridge {
  private instances = new Map<string, InstanceState>();
  private logger: Logger;
  /** agent → 可见实例 id 列表（agent.yaml 的 opencode_instances）；provider 未注册=全部不可见 */
  private agentProvider?: (agent: string) => string[] | undefined;
  /** managed 启动前钩子（W1 模型注入：按模型池写实例的 opencode.json）。
   *  返回值 = 需要注入 serve 进程的环境变量（如 provider apiKey——密钥绝不落盘） */
  private prepareHook?: (cfg: OpencodeInstanceConfig) => Promise<Record<string, string> | void>;
  /** SSE 事件转发（W2：→ co-team WS 总线 / 审批收件箱） */
  private eventForwarder?: (instanceId: string, event: OcEvent) => void;
  /** co-team 模型池（setModelPool 注入；W1 的模型名 → opencode model ref） */
  private modelPool: ModelConfig[] = [];
  /** 会话消息缓存（翻页 + 完整原文；LRU，SSE 增量 patch） */
  private msgCache = new Map<string, { messages: Record<string, any>[]; loadedAt: number }>();
  /**
   * 服务端 pending 聚合态（审批收件箱数据源）：instance → id → 权限/提问请求。
   * 由 SSE 事件驱动维护（asked 入队、replied/rejected 出队）——与前端 stream 各自维护
   * 的面板内卡片互补：这张表给 co-team 审批收件箱跨实例聚合用。
   */
  private pendingPerms = new Map<string, Map<string, Record<string, any>>>();
  private pendingQuestions = new Map<string, Map<string, Record<string, any>>>();
  private stopped = false;

  constructor(configs: OpencodeInstanceConfig[] = [], logger?: Logger) {
    this.logger = logger ?? getLogger();
    for (const cfg of configs) this.instances.set(cfg.id, this.newState(cfg));
  }

  private newState(cfg: OpencodeInstanceConfig): InstanceState {
    return {
      cfg,
      state: 'stopped',
      url: (cfg.url || '').replace(/\/+$/, ''),
      retries: 0,
      projectRoot: cfg.project_root,
    };
  }

  // ---------- 装配钩子 ----------

  setAgentProvider(fn: (agent: string) => string[] | undefined): void {
    this.agentProvider = fn;
  }

  setPrepareHook(fn: (cfg: OpencodeInstanceConfig) => Promise<Record<string, string> | void>): void {
    this.prepareHook = fn;
  }

  setEventForwarder(fn: (instanceId: string, event: OcEvent) => void): void {
    this.eventForwarder = fn;
    // 后注册的转发方对已连接的实例补发不了历史事件——由面板层主动拉消息补偿，这里只保证新事件
  }

  /** 模型池注入（W1：resolveModel / listModelsForAgent 的候选源） */
  setModelPool(pool: ModelConfig[]): void {
    this.modelPool = pool;
  }

  // ---------- 生命周期 ----------

  /** 启动：managed auto_start 拉起；attached 进健康巡检 + SSE。单实例失败不影响其他实例与主链路。 */
  start(): void {
    // 先清杀上个 co-team 会话遗留的孤儿 serve（重启不 = serve 消失——它们会占端口耗内存）
    this.cleanupOrphanServes();
    for (const st of this.instances.values()) {
      if (st.cfg.enabled === false) continue;
      if (st.cfg.kind === 'managed') {
        if (st.cfg.auto_start !== false) void this.startManaged(st);
      } else {
        void this.bootstrapAttached(st);
      }
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.msgCache.clear();
    this.pendingPerms.clear();
    this.pendingQuestions.clear();
    for (const st of this.instances.values()) {
      if (st.healthTimer) clearInterval(st.healthTimer);
      if (st.restartTimer) clearTimeout(st.restartTimer);
      st.eventAbort?.abort();
      st.batcher?.dispose();
      if (st.proc) this.killTree(st);
    }
  }

  /** 保存即热生效（PUT /api/config/opencode 用）：diff——新增/变更的重启，删除/禁用的停止，未变更不动 */
  async applyConfig(configs: OpencodeInstanceConfig[]): Promise<void> {
    this.stopped = false;
    const next = new Map(configs.map((c) => [c.id, c]));
    for (const [id, st] of this.instances) {
      const cfg = next.get(id);
      if (!cfg || JSON.stringify(cfg) !== JSON.stringify(st.cfg)) {
        if (st.healthTimer) clearInterval(st.healthTimer);
        if (st.restartTimer) clearTimeout(st.restartTimer);
        st.eventAbort?.abort();
        st.batcher?.dispose();
        if (st.proc) this.killTree(st);
        this.instances.delete(id);
      }
    }
    for (const cfg of next.values()) {
      if (this.instances.has(cfg.id)) continue;
      const st = this.newState(cfg);
      this.instances.set(cfg.id, st);
      if (cfg.enabled !== false) {
        if (cfg.kind === 'managed') {
          if (cfg.auto_start !== false) void this.startManaged(st);
        } else {
          void this.bootstrapAttached(st);
        }
      }
    }
  }

  // ---------- managed ----------

  private async startManaged(st: InstanceState): Promise<void> {
    if (this.stopped || st.cfg.enabled === false) return;
    st.state = 'starting';
    st.error = undefined;
    try {
      // W1 模型注入钩子：写 opencode.json（providers 来自模型池）后再拉起，保证 serve 启动即带配置；
      // 钩子回注的 env（provider apiKey）随 spawn 进子进程，密钥不落盘
      let extraEnv: Record<string, string> = {};
      if (st.cfg.model_injection && this.prepareHook) extraEnv = (await this.prepareHook(st.cfg)) || {};
      const port = st.cfg.port && st.cfg.port > 0 ? st.cfg.port : await pickFreePort();
      const hostname = st.cfg.hostname || DEFAULT_OC_HOSTNAME;
      const command = st.cfg.command || DEFAULT_OC_COMMAND;
      // 浏览器直连 SSE（managed 实例无鉴权）需要 CORS 放行前后端 dev 源；默认带常用本地源
      const corsOrigins = st.cfg.cors_origins?.length
        ? st.cfg.cors_origins
        : ['http://localhost:8856', 'http://127.0.0.1:8856', 'http://localhost:8857', 'http://127.0.0.1:8857'];
      const args = [...(st.cfg.args || []), 'serve', '--port', String(port), '--hostname', hostname, '--cors', corsOrigins.join(',')];
      if (!st.cfg.project_root) throw new Error('managed 实例必须配置 project_root');
      fs.mkdirSync(st.cfg.project_root, { recursive: true });
      const logDir = path.join(os.tmpdir(), 'coteam-opencode-logs');
      fs.mkdirSync(logDir, { recursive: true });
      const logPath = path.join(logDir, `${st.cfg.id}-${Date.now()}.log`);
      const fd = fs.openSync(logPath, 'a');
      const env: Record<string, string> = { ...process.env } as Record<string, string>;
      for (const [k, v] of Object.entries(st.cfg.env || {})) env[k] = expandEnv(v);
      for (const [k, v] of Object.entries(extraEnv)) env[k] = v;
      // Windows 裸命令（opencode/node 等无扩展名）走 shell:true——CreateProcess 不做
      // PATHEXT 解析，直接 spawn 报 ENOENT（2026-09-24 本机实测）；带路径的命令不走 shell
      const bareName = !/[\\/]/.test(command);
      const useShell = process.platform === 'win32' && bareName;
      const proc = spawn(command, args, { cwd: st.cfg.project_root, env, stdio: ['ignore', fd, fd], ...(useShell ? { shell: true } : {}) });
      fs.closeSync(fd);
      st.proc = proc;
      st.pid = proc.pid;
      st.logPath = logPath;
      // 登记 pid+port：co-team 意外重启后据此清理孤儿 serve（见 cleanupOrphanServes）
      try {
        const reg = pidRegistryPath();
        const dir = path.dirname(reg);
        fs.mkdirSync(dir, { recursive: true });
        const cur = fs.existsSync(reg) ? (JSON.parse(fs.readFileSync(reg, 'utf-8')) as Record<string, unknown>) : {};
        cur[st.cfg.id] = { pid: proc.pid, port };
        fs.writeFileSync(reg, JSON.stringify(cur), 'utf-8');
      } catch { /* 登记失败不阻塞拉起（代价仅是本会话重启后少清一个孤儿） */ }
      st.url = `http://${hostname}:${port}`;
      st.client = this.buildClient(st);
      proc.on('exit', (code) => {
        st.proc = undefined;
        st.pid = undefined;
        st.eventAbort?.abort();
        st.batcher?.dispose();
        if (this.stopped) return;
        st.state = 'error';
        st.error = `serve 进程退出（code=${code}）`;
        if (st.cfg.auto_start !== false) this.scheduleRestart(st);
      });
      proc.on('error', (e) => {
        st.state = 'error';
        st.error = `启动失败：${String(e.message || e).slice(0, 200)}`;
      });
      this.logger.info('Opencode managed instance spawned', { id: st.cfg.id, port, project_root: st.cfg.project_root });
      // 健康等待 + capabilities + SSE
      await this.waitHealthy(st);
      this.ensureHealthLoop(st);
    } catch (e: any) {
      st.state = 'error';
      st.error = String(e?.message || e).slice(0, 300);
      this.logger.warn('Opencode managed instance start failed', { id: st.cfg.id, error: st.error });
      if (st.cfg.auto_start !== false) this.scheduleRestart(st);
    }
  }

  private scheduleRestart(st: InstanceState): void {
    if (this.stopped || st.cfg.enabled === false) return;
    const delay = RESTART_BACKOFF_MS[Math.min(st.retries, RESTART_BACKOFF_MS.length - 1)];
    st.retries += 1;
    if (st.restartTimer) clearTimeout(st.restartTimer);
    st.restartTimer = setTimeout(() => void this.startManaged(st), delay);
    this.logger.info('Opencode instance restart scheduled', { id: st.cfg.id, delayMs: delay });
  }

  // ---------- attached ----------

  /** attached 引导：解析 URL（桌面版自动发现端口）→ 健康 → capabilities → SSE + 巡检 */
  private async bootstrapAttached(st: InstanceState): Promise<void> {
    if (this.stopped || st.cfg.enabled === false) return;
    st.state = 'starting';
    st.error = undefined;
    try {
      let url = st.cfg.url || '';
      if (!url) {
        if (st.cfg.kind === 'attached-desktop') {
          const port = discoverDesktopPort();
          if (port) url = `http://127.0.0.1:${port}`;
        }
        if (!url) throw new Error('未配置 url 且自动发现失败（attached-desktop 会解析桌面日志；其余请手填 url）');
      }
      st.url = url.replace(/\/+$/, '');
      st.client = this.buildClient(st);
      const caps = await withProbeTimeout(st.client.probe(), PROBE_TIMEOUT_MS).catch((e) => {
        throw new Error(String(e?.message || e).slice(0, 200));
      });
      st.capabilities = caps;
      st.state = caps.healthy ? 'connected' : 'error';
      // 带上health 的失败详情（401=鉴权缺失/错误最常见——桌面版密码没配就是这个）
      st.error = caps.healthy ? undefined : `连接失败：${(await st.client.health().then((h) => h.error)) || 'health 未通过'}`;
      st.lastCheckedAt = new Date().toISOString();
      // attached 会话的项目根以 opencode 自己为准（只读探测，失败不阻塞）
      const proj = await st.client.currentProject();
      if (proj.ok && proj.data?.worktree) st.projectRoot = proj.data.worktree;
      if (st.state === 'connected') {
        this.subscribeEvents(st);
        this.ensureHealthLoop(st);
      }
      this.logger.info('Opencode attached instance bootstrapped', { id: st.cfg.id, url: st.url, version: caps.version });
    } catch (e: any) {
      st.state = 'error';
      st.error = String(e?.message || e).slice(0, 300);
      this.logger.warn('Opencode attached instance bootstrap failed', { id: st.cfg.id, error: st.error });
      this.ensureHealthLoop(st); // 巡检兜底：用户随后打开桌面版/TUI 时自动恢复
    }
  }

  private buildClient(st: InstanceState): OpencodeClient {
    const auth = st.cfg.auth?.password
      ? { username: st.cfg.auth.username, password: expandEnv(st.cfg.auth.password) }
      : undefined;
    return new OpencodeClient({
      baseUrl: st.url,
      ...(auth ? { auth } : {}),
      timeoutSec: st.cfg.timeout_sec,
      maxResultChars: st.cfg.max_result_chars,
    });
  }

  // ---------- 健康巡检 / SSE ----------

  private ensureHealthLoop(st: InstanceState): void {
    if (st.healthTimer) clearInterval(st.healthTimer);
    st.healthTimer = setInterval(() => void this.healthTick(st), HEALTH_INTERVAL_MS);
  }

  private async healthTick(st: InstanceState): Promise<void> {
    if (this.stopped || !st.client || st.cfg.enabled === false) return;
    const h = await st.client.health();
    st.lastCheckedAt = new Date().toISOString();
    if (h.ok) {
      const was = st.state;
      st.state = 'connected';
      st.error = undefined;
      st.retries = 0;
      if (was !== 'connected' && st.cfg.kind !== 'managed') {
        // 恢复：补探测 capabilities + 重订 SSE（managed 场景进程退出已由重启逻辑接管）
        st.capabilities = await st.client.probe().catch(() => st.capabilities);
        this.subscribeEvents(st);
      }
      return;
    }
    st.state = 'error';
    st.error = `健康检查失败：${h.error}`;
    if (st.cfg.kind === 'managed' && st.cfg.auto_start !== false && !st.proc) this.scheduleRestart(st);
  }

  private async waitHealthy(st: InstanceState): Promise<void> {
    const begin = Date.now();
    for (;;) {
      const h = await st.client!.health();
      st.lastCheckedAt = new Date().toISOString();
      if (h.ok) {
        st.capabilities = await st.client!.probe().catch(() => st.capabilities);
        st.state = 'connected';
        st.error = undefined;
        st.retries = 0;
        this.subscribeEvents(st);
        return;
      }
      if (Date.now() - begin > HEALTH_WAIT_MS) throw new Error(`等待 serve 就绪超时：${h.error}`);
      await new Promise((r) => setTimeout(r, 800));
    }
  }

  /** SSE 订阅循环：断流按退避重订，直到 stop/applyConfig abort。delta 走微批器。 */
  private subscribeEvents(st: InstanceState): void {
    st.eventAbort?.abort();
    st.batcher?.dispose();
    const batcher = new EventBatcher(
      (instanceId, frame) => {
        try {
          if (frame.events) {
            for (const ev of frame.events) this.eventForwarder?.(instanceId, ev);
          } else if (frame.event) {
            this.eventForwarder?.(instanceId, frame.event);
          }
        } catch { /* 转发方异常不杀流 */ }
      },
      st.cfg.id,
    );
    st.batcher = batcher;
    const ac = new AbortController();
    st.eventAbort = ac;
    void (async () => {
      while (!ac.signal.aborted && !this.stopped) {
        try {
          for await (const ev of st.client!.eventStream(ac.signal)) {
            if (ac.signal.aborted) break;
            if (isDroppedEvent(ev.type)) continue;
            // run_task 的 idle 等待器先行（本地唤醒，不依赖转发方接线）
            this.wakeIdleWaiters(st, ev);
            // pending 聚合态（审批收件箱数据源）——先于缓存与转发
            this.trackPending(st, ev);
            // 已加载会话的消息缓存增量维护（翻页/完整原文的数据源）
            this.patchCache(st, ev);
            batcher.push(ev);
          }
        } catch { /* 断流/被 abort——走退避 */ }
        if (ac.signal.aborted || this.stopped) break;
        const delay = SSE_BACKOFF_MS[Math.min(st.retries, SSE_BACKOFF_MS.length - 1)];
        st.retries += 1;
        await new Promise((r) => setTimeout(r, delay));
      }
    })();
  }

  /** SSE 事件 → idle 等待器：session.idle 唤醒为 idle，session.error 唤醒为 error */
  private wakeIdleWaiters(st: InstanceState, ev: OcEvent): void {
    if (!st.idleWaiters?.size) return;
    if (ev.type !== 'session.idle' && ev.type !== 'session.error') return;
    const sid = String((ev.properties as Record<string, unknown> | undefined)?.sessionID || (ev.properties as Record<string, unknown> | undefined)?.session_id || (ev.properties as Record<string, unknown> | undefined)?.sessionId || '');
    // sid 缺失（个别版本不带归属）时唤醒全部等待者——run_task 等的是"我的会话动了"，
    // 误唤醒的代价只是一次多余的消息拉取，漏唤醒的代价是干等 30 分钟
    if (!sid) {
      for (const w of [...st.idleWaiters.values()]) w.resolve(ev.type === 'session.error' ? 'error' : 'idle');
      st.idleWaiters.clear();
      return;
    }
    const w = st.idleWaiters.get(sid);
    if (w) {
      w.resolve(ev.type === 'session.error' ? 'error' : 'idle');
      st.idleWaiters.delete(sid);
    }
  }

  /**
   * 孤儿 serve 清理：读 pid+port 登记表，逐条校验"该端口当前监听者仍是登记的 pid"
   * （双条件防误杀——端口被回收或 pid 被复用都不杀），命中则 taskkill 进程树。
   * 用户的桌面版 service / 手动 serve 的端口从不在表里，天然不碰。
   */
  private cleanupOrphanServes(): void {
    try {
      const reg = pidRegistryPath();
      if (!fs.existsSync(reg)) return;
      const entries = JSON.parse(fs.readFileSync(reg, 'utf-8')) as Record<string, { pid?: number; port?: number }>;
      // 立即清表：本会话的 spawn 会重新登记；清理失败也不留旧条目误导下次
      fs.writeFileSync(reg, '{}', 'utf-8');
      const targets = Object.values(entries || {}).filter((e) => e && Number.isInteger(e.pid) && Number.isInteger(e.port));
      if (!targets.length) return;
      void (async () => {
        for (const t of targets) {
          try {
            const owner = await portOwner(t.port as number);
            if (owner !== t.pid) continue; // 端口易主——登记的是历史 pid，不动
            spawn(`taskkill /PID ${t.pid} /T /F`, { shell: true, stdio: 'ignore' });
            this.logger.info('Opencode orphan serve cleaned', { pid: t.pid, port: t.port });
          } catch { /* 单条失败不影响其余 */ }
        }
      })();
    } catch { /* 清理失败不阻塞启动 */ }
  }

  private killTree(st: InstanceState): void {
    try {
      if (process.platform === 'win32' && st.pid) {
        spawn(`taskkill /PID ${st.pid} /T /F`, { shell: true, stdio: 'ignore' });
      } else if (st.proc?.pid) {
        st.proc.kill('SIGTERM');
      }
    } catch { /* 进程已退出——fine */ }
  }

  // ---------- OpencodeBridge ----------

  private visible(agent: string | undefined, id: string): boolean {
    if (agent === undefined) return true; // API 层调用（面板/审批）不看 agent 白名单
    const allowed = this.agentProvider?.(agent);
    if (!Array.isArray(allowed)) return false;
    return allowed.includes('*') || allowed.includes(id);
  }

  private resolve(agent: string | undefined, id: string): { st?: InstanceState; err?: string } {
    const st = this.instances.get(id);
    if (!st) return { err: `未配置的 opencode 实例: ${id}` };
    if (st.cfg.enabled === false) return { err: `opencode 实例 ${id} 已禁用` };
    if (!this.visible(agent, id)) return { err: `当前 agent 未绑定 opencode 实例 ${id}（agent.yaml 的 opencode_instances）` };
    if (!st.client || st.state !== 'connected') return { err: `opencode 实例 ${id} 未连接：${st.error || '启动中或不可达'}` };
    return { st };
  }

  private requireControl(st: InstanceState): string | undefined {
    if (modeOf(st.cfg) !== 'control') return `opencode 实例 ${st.cfg.id} 为 readonly 档，拒绝控制操作（在配置里把 mode 改为 control）`;
    return undefined;
  }

  private audit(action: string, st: InstanceState, detail: Record<string, unknown>): void {
    this.logger.info('Opencode control audit', { instance: st.cfg.id, action, ...detail });
  }

  listInstances(agent?: string): OpencodeInstanceStatus[] {
    const out: OpencodeInstanceStatus[] = [];
    for (const st of this.instances.values()) {
      if (st.cfg.enabled === false) continue;
      if (!this.visible(agent, st.cfg.id)) continue;
      out.push({
        id: st.cfg.id,
        kind: st.cfg.kind,
        ...(st.cfg.label ? { label: st.cfg.label } : {}),
        enabled: true,
        state: st.state,
        url: st.url,
        mode: modeOf(st.cfg),
        version: st.capabilities?.version || '',
        ...(st.capabilities ? { capabilities: st.capabilities } : {}),
        ...(st.pid ? { pid: st.pid } : {}),
        ...(st.projectRoot ? { project_root: st.projectRoot } : {}),
        model_injection: st.cfg.model_injection === true,
        ...(st.error ? { error: st.error } : {}),
        ...(st.lastCheckedAt ? { last_checked_at: st.lastCheckedAt } : {}),
      });
    }
    return out;
  }

  instanceCapabilities(id: string): OcCapabilities | undefined {
    return this.instances.get(id)?.capabilities;
  }

  async listSessions(agent: string | undefined, instance: string): Promise<OcCallResult<OcSession[]>> {
    const { st, err } = this.resolve(agent, instance);
    if (err || !st) return { ok: false, error: err };
    return st.client!.listSessions();
  }

  async createSession(agent: string | undefined, instance: string, title?: string): Promise<OcCallResult<OcSession>> {
    const { st, err } = this.resolve(agent, instance);
    if (err || !st) return { ok: false, error: err };
    const gate = this.requireControl(st);
    if (gate) return { ok: false, error: gate };
    this.audit('create_session', st, { title });
    return st.client!.createSession(title);
  }

  /**
   * 读会话消息（尾优先分页）。
   * - 不带 before：从缓存取尾 limit 条；无缓存则拉上游 limit 条（opencode 1.18.32 原生尾优先）
   *   并后台建缓存（翻页与"完整原文"都依赖它）
   * - 带 before：本地缓存切片（上游 before 参数该版本 BadRequest，翻页只能缓存切）
   * - 响应路径统一裁剪（system 剥离/巨块头尾），trimmed 回传被裁 part id；full=true 跳过
   */
  async readMessages(agent: string | undefined, instance: string, sessionId: string, opts?: { limit?: number; before?: string; full?: boolean }): Promise<OcCallResult<{ messages: unknown[]; has_more: boolean; next_before?: string; trimmed: string[] }>> {
    const { st, err } = this.resolve(agent, instance);
    if (err || !st) return { ok: false, error: err };
    const limit = Math.min(MSG_PAGE_MAX, Math.max(1, Math.floor(Number(opts?.limit || MSG_PAGE_DEFAULT))));
    const full = opts?.full === true;
    try {
      let page: Record<string, any>[] = [];
      let hasMore = false;
      let nextBefore: string | undefined;
      const cached = this.msgCache.get(cacheKey(instance, sessionId));
      if (opts?.before) {
        const cache = (await this.ensureCache(st, instance, sessionId)) || [];
        const idx = cache.findIndex((m) => msgId(m) === String(opts!.before));
        if (idx < 0) return { ok: false, error: `翻页游标 ${String(opts!.before).slice(0, 16)} 不在消息列表（可能已被压缩/删除）` };
        const from = Math.max(0, idx - limit);
        page = cache.slice(from, idx);
        hasMore = from > 0;
        nextBefore = page.length ? msgId(page[0]) : undefined;
      } else if (cached) {
        page = cached.messages.slice(-limit);
        hasMore = cached.messages.length > limit;
        nextBefore = page.length ? msgId(page[0]) : undefined;
      } else {
        const r = await st.client!.listMessages(sessionId, limit);
        if (!r.ok || !Array.isArray(r.data)) return { ok: false, error: r.error || '消息读取失败' };
        page = r.data as Record<string, any>[];
        hasMore = page.length >= limit;
        nextBefore = page.length ? msgId(page[0]) : undefined;
        void this.ensureCache(st, instance, sessionId); // 后台建缓存，翻页/原文零延迟
      }
      const trimmed: string[] = [];
      const messages = page.map((m) => {
        if (full) return m;
        const t = trimMessageForUi(m);
        trimmed.push(...t.trimmed);
        return t.msg;
      });
      return { ok: true, data: { messages, has_more: hasMore, ...(nextBefore ? { next_before: nextBefore } : {}), trimmed: [...new Set(trimmed)] } };
    } catch (e: any) {
      return { ok: false, error: String(e?.message || e).slice(0, 300) };
    }
  }

  /** 确保会话消息缓存（拉全量；loopback 8MB 级实测可接受）。LRU 淘汰 + SSE patch 增量维护。 */
  private async ensureCache(st: InstanceState, instance: string, sessionId: string): Promise<Record<string, any>[] | null> {
    const key = cacheKey(instance, sessionId);
    const hit = this.msgCache.get(key);
    if (hit) {
      // LRU 触碰：移至队尾
      this.msgCache.delete(key);
      this.msgCache.set(key, hit);
      return hit.messages;
    }
    const r = await st.client!.listMessages(sessionId);
    if (!r.ok || !Array.isArray(r.data)) return null;
    const entry = { messages: r.data as Record<string, any>[], loadedAt: Date.now() };
    this.msgCache.set(key, entry);
    while (this.msgCache.size > MSG_CACHE_MAX) {
      const oldest = this.msgCache.keys().next().value;
      if (oldest === undefined) break;
      this.msgCache.delete(oldest);
    }
    return entry.messages;
  }

  /** 单条消息全文：优先缓存原文（未经 UI 裁剪），未命中走上游单条端点（透传 {info, parts}） */
  async readMessageFull(agent: string | undefined, instance: string, sessionId: string, messageID: string): Promise<OcCallResult<unknown>> {
    const { st, err } = this.resolve(agent, instance);
    if (err || !st) return { ok: false, error: err };
    const cache = this.msgCache.get(cacheKey(instance, sessionId));
    const hit = cache?.messages.find((m) => msgId(m) === messageID);
    if (hit) return { ok: true, data: hit };
    const r = await st.client!.getMessage(sessionId, messageID);
    if (!r.ok || !r.data) return { ok: false, error: r.error || '消息不存在' };
    return { ok: true, data: r.data };
  }

  /**
   * pending 聚合态维护（审批收件箱数据源）：permission/question 的 asked 入队、replied/rejected 出队。
   * 与前端面板内的 stream 各自维护互补——这张表是跨实例的 server 侧事实源。
   */
  private trackPending(st: InstanceState, ev: OcEvent): void {
    const p = (ev.properties || {}) as Record<string, any>;
    try {
      if (ev.type === 'permission.asked' || ev.type === 'permission.updated') {
        const id = String(p.id || '');
        if (!id) return;
        const m = this.pendingPerms.get(st.cfg.id) || new Map();
        m.set(id, p);
        this.pendingPerms.set(st.cfg.id, m);
      } else if (ev.type === 'permission.replied') {
        const id = String(p.permissionID || p.id || '');
        this.pendingPerms.get(st.cfg.id)?.delete(id);
      } else if (ev.type === 'question.asked') {
        const id = String(p.id || '');
        if (!id) return;
        const m = this.pendingQuestions.get(st.cfg.id) || new Map();
        m.set(id, p);
        this.pendingQuestions.set(st.cfg.id, m);
      } else if (ev.type === 'question.replied' || ev.type === 'question.rejected') {
        const id = String(p.requestID || p.id || '');
        this.pendingQuestions.get(st.cfg.id)?.delete(id);
      }
    } catch { /* 聚合失败不影响主链 */ }
  }

  /** 跨实例 pending 聚合（审批收件箱）：权限申请 + 提问，按实例/会话归组 */
  pendingAll(): { permissions: Record<string, any>[]; questions: Record<string, any>[] } {
    const perms: Record<string, any>[] = [];
    const questions: Record<string, any>[] = [];
    for (const [instId, m] of this.pendingPerms) {
      for (const [id, p] of m) perms.push({ instance: instId, id, ...p });
    }
    for (const [instId, m] of this.pendingQuestions) {
      for (const [id, p] of m) questions.push({ instance: instId, id, ...p });
    }
    return { permissions: perms, questions };
  }

  /** SSE 增量 patch 缓存（只维护已加载过的会话；delta 不 patch——part.updated 会带全量覆盖） */
  private patchCache(st: InstanceState, ev: OcEvent): void {
    const key = cacheKey(st.cfg.id, eventSessionId(ev));
    if (!eventSessionId(ev)) return;
    const entry = this.msgCache.get(key);
    if (!entry) return;
    const p = (ev.properties || {}) as Record<string, any>;
    try {
      if (ev.type === 'message.updated') {
        const info = p.info || {};
        const id = String(info.id || '');
        const idx = entry.messages.findIndex((m) => msgId(m) === id);
        if (idx >= 0) entry.messages[idx] = { ...entry.messages[idx], ...info, parts: entry.messages[idx].parts };
        else entry.messages.push({ info, parts: [] });
      } else if (ev.type === 'message.part.updated') {
        const part = p.part || {};
        const mid = String(part.messageID || '');
        const pid = String(part.id || '');
        const m = entry.messages.find((x) => msgId(x) === mid);
        if (!m) return;
        const parts = Array.isArray(m.parts) ? [...m.parts] : [];
        const pi = parts.findIndex((x) => String(x.id) === pid);
        if (pi >= 0) parts[pi] = part; else parts.push(part);
        m.parts = parts;
      } else if (ev.type === 'message.removed') {
        const mid = String(p.messageID || '');
        const idx = entry.messages.findIndex((m) => msgId(m) === mid);
        if (idx >= 0) entry.messages.splice(idx, 1);
      } else if (ev.type === 'message.part.removed') {
        const m = entry.messages.find((x) => msgId(x) === String(p.messageID || ''));
        if (m && Array.isArray(m.parts)) m.parts = m.parts.filter((x) => String(x.id) !== String(p.partID || ''));
      }
    } catch { /* patch 失败不影响主链 */ }
  }

  async sendPrompt(agent: string | undefined, instance: string, sessionId: string, prompt: string, model?: { providerID: string; modelID: string }, ocAgent?: string): Promise<OcCallResult<unknown>> {
    const { st, err } = this.resolve(agent, instance);
    if (err || !st) return { ok: false, error: err };
    const gate = this.requireControl(st);
    if (gate) return { ok: false, error: gate };
    this.audit('send_prompt', st, { session: sessionId, model, ocAgent, prompt_chars: prompt.length });
    return st.client!.prompt(sessionId, prompt, model, ocAgent);
  }

  async sendPromptAsync(agent: string | undefined, instance: string, sessionId: string, prompt: string, model?: { providerID: string; modelID: string }, ocAgent?: string): Promise<OcCallResult<{ messageID?: string }>> {
    const { st, err } = this.resolve(agent, instance);
    if (err || !st) return { ok: false, error: err };
    const gate = this.requireControl(st);
    if (gate) return { ok: false, error: gate };
    this.audit('send_prompt_async', st, { session: sessionId, model, ocAgent, prompt_chars: prompt.length });
    return st.client!.promptAsync(sessionId, prompt, model, ocAgent);
  }

  async abortSession(agent: string | undefined, instance: string, sessionId: string): Promise<OcCallResult<boolean>> {
    const { st, err } = this.resolve(agent, instance);
    if (err || !st) return { ok: false, error: err };
    const gate = this.requireControl(st);
    if (gate) return { ok: false, error: gate };
    this.audit('abort', st, { session: sessionId });
    return st.client!.abortSession(sessionId);
  }

  async revertMessage(agent: string | undefined, instance: string, sessionId: string, messageID: string): Promise<OcCallResult<boolean>> {
    const { st, err } = this.resolve(agent, instance);
    if (err || !st) return { ok: false, error: err };
    const gate = this.requireControl(st);
    if (gate) return { ok: false, error: gate };
    this.audit('revert', st, { session: sessionId, message: messageID });
    return st.client!.revert(sessionId, messageID);
  }

  async sessionDiff(agent: string | undefined, instance: string, sessionId: string): Promise<OcCallResult<unknown[]>> {
    const { st, err } = this.resolve(agent, instance);
    if (err || !st) return { ok: false, error: err };
    return st.client!.diff(sessionId);
  }

  async answerPermission(agent: string | undefined, instance: string, sessionId: string, permissionID: string, response: 'once' | 'always' | 'reject'): Promise<OcCallResult<boolean>> {
    const { st, err } = this.resolve(agent, instance);
    if (err || !st) return { ok: false, error: err };
    this.audit('answer_permission', st, { session: sessionId, permission: permissionID, response });
    return st.client!.answerPermission(sessionId, permissionID, response);
  }

  /**
   * 回答 opencode 的提问（AskUserQuestion）。需 control 档——替用户做决定不能发生在只读实例上。
   * requestID 来自 question.asked 事件的 QuestionRequest.id；answers 按问题顺序（每题选中的 label 数组）。
   */
  async answerQuestion(agent: string | undefined, instance: string, requestID: string, answers: string[][]): Promise<OcCallResult<boolean>> {
    const { st, err } = this.resolve(agent, instance);
    if (err || !st) return { ok: false, error: err };
    const gate = this.requireControl(st);
    if (gate) return { ok: false, error: gate };
    this.audit('answer_question', st, { request: requestID, answers });
    return st.client!.answerQuestion(requestID, answers);
  }

  /** 拒绝/不回答提问（需 control 档；agent 收到 rejected 后自行继续） */
  async rejectQuestion(agent: string | undefined, instance: string, requestID: string): Promise<OcCallResult<boolean>> {
    const { st, err } = this.resolve(agent, instance);
    if (err || !st) return { ok: false, error: err };
    const gate = this.requireControl(st);
    if (gate) return { ok: false, error: gate };
    this.audit('reject_question', st, { request: requestID });
    return st.client!.rejectQuestion(requestID);
  }

  async runShell(agent: string | undefined, instance: string, sessionId: string, command: string): Promise<OcCallResult<unknown>> {
    const { st, err } = this.resolve(agent, instance);
    if (err || !st) return { ok: false, error: err };
    if (st.cfg.allow_shell !== true) return { ok: false, error: `实例 ${st.cfg.id} 未开启 allow_shell（高危：在 opencode 会话内执行任意命令）` };
    const gate = this.requireControl(st);
    if (gate) return { ok: false, error: gate };
    this.audit('shell', st, { session: sessionId, command: command.slice(0, 200) });
    return st.client!.shell(sessionId, command);
  }

  /** run_task 的等待原语：SSE 收到 session.idle → 'idle'；session.error → 'error'；超时兜底 */
  async waitSessionIdle(agent: string | undefined, instance: string, sessionId: string, timeoutMs: number): Promise<OcCallResult<'idle' | 'error'>> {
    const { st, err } = this.resolve(agent, instance);
    if (err || !st) return { ok: false, error: err };
    const budget = Math.min(Math.max(1000, timeoutMs), IDLE_WAIT_MAX_MS);
    return new Promise<OcCallResult<'idle' | 'error'>>((resolve) => {
      const waiters: NonNullable<InstanceState['idleWaiters']> = (st.idleWaiters ||= new Map());
      const done = (v: 'idle' | 'error', ok: boolean) => {
        const w = waiters.get(sessionId);
        if (w) {
          clearTimeout(w.timer);
          waiters.delete(sessionId);
        }
        resolve(ok ? { ok: true, data: v } : { ok: false, error: v === 'error' ? 'opencode 会话报错（session.error）' : `等待会话空闲超时（${Math.round(budget / 1000)}s）` });
      };
      const timer = setTimeout(() => done('idle', false), budget);
      waiters.set(sessionId, { resolve: (v) => done(v, true), timer });
    });
  }

  /** 教学块：实例清单 + 能力 + 工具用法（convo/harness 注入；无可用实例返回空串） */
  toolsIndex(agent: string): string {
    const list = this.listInstances(agent);
    if (!list.length) return '';
    const lines: string[] = ['外部 OpenCode 实例（可接管的运行时）：'];
    for (const i of list) {
      const caps = i.capabilities;
      lines.push(`- ${i.id}（${i.kind}，${i.mode} 档，${i.state}${i.version ? `，v${i.version}` : ''}${i.project_root ? `，项目根 ${i.project_root}` : ''}${i.model_injection ? '，模型由 co-team 注入' : '，模型归 opencode'}）`);
      if (caps) {
        const able: string[] = [];
        if (caps.async_prompt || caps.sync_prompt) able.push('发指令');
        if (caps.abort) able.push('打断');
        if (caps.revert) able.push('回退');
        if (caps.diff) able.push('看 diff');
        if (caps.permissions) able.push('审批');
        if (caps.tui) able.push('TUI 驱动');
        lines.push(`  能力：${able.join(' / ') || '（探测中）'}`);
      }
    }
    const models = this.listModelsForAgent(agent);
    if (models.some((m) => m.models.length)) {
      lines.push('可注入模型（managed 实例）：' + models.filter((m) => m.models.length).map((m) => `${m.instance} → ${m.models.slice(0, 12).join(', ')}${m.models.length > 12 ? ' …' : ''}`).join('；'));
    }
    lines.push('工具用法（instance 传上面的实例 id）：');
    lines.push(' oc_instances 列实例；oc_create_session 开会话；oc_send / oc_run_task 派活（run_task 会自动等 idle 并回收 diff）；oc_read 读消息；oc_abort 打断；oc_revert 回退；oc_diff 看变更；oc_permission 回应权限请求');
    lines.push(' {"tool_calls":[{"tool":"oc_run_task","arguments":{"instance":"<id>","prompt":"要它干什么"}}]}');
    return lines.join('\n');
  }

  /** managed 且开了模型注入的实例 → 池内模型名（oc_send/oc_run_task 的 model 候选） */
  listModelsForAgent(agent?: string): { instance: string; models: string[] }[] {
    const out: { instance: string; models: string[] }[] = [];
    for (const i of this.listInstances(agent)) {
      if (!i.model_injection) continue;
      out.push({ instance: i.id, models: this.modelPool.map((m) => m.name) });
    }
    return out;
  }

  hasShellEnabled(agent?: string): boolean {
    for (const st of this.instances.values()) {
      if (st.cfg.enabled === false || st.cfg.allow_shell !== true) continue;
      if (modeOf(st.cfg) !== 'control') continue;
      if (agent !== undefined && !this.visible(agent, st.cfg.id)) continue;
      return true;
    }
    return false;
  }

  /** 模型名 → opencode model ref：managed 池内精确匹配；其余按 opencode 原生 'provider/model' 解析（attached 实例） */
  resolveModel(instance: string, modelName: string): { providerID: string; modelID: string } | undefined {
    const st = this.instances.get(instance);
    if (!st) return undefined;
    if (st.cfg.model_injection === true && this.modelPool.length) {
      const hit = resolveModelRef(this.modelPool, modelName);
      if (hit) return hit;
    }
    const slash = modelName.indexOf('/');
    if (slash > 0 && slash < modelName.length - 1) return { providerID: modelName.slice(0, slash), modelID: modelName.slice(slash + 1) };
    return undefined;
  }

  async sessionStatus(agent: string | undefined, instance: string): Promise<OcCallResult<Record<string, { type: string }>>> {
    const { st, err } = this.resolve(agent, instance);
    if (err || !st) return { ok: false, error: err };
    const r = await st.client!.sessionStatus();
    if (!r.ok || !r.data) return { ok: false, error: r.error };
    const out: Record<string, { type: string }> = {};
    for (const [k, v] of Object.entries(r.data)) out[k] = { type: String((v as { type?: unknown })?.type ?? 'unknown') };
    return { ok: true, data: out };
  }

  /**
   * 接管当前对话：TUI 无 state API（tui.* 全是 POST），只能启发式——
   * ① status 表里 busy 的会话（多个取最近更新）；② 否则 time.updated 最新的会话。
   * reason 让 UI 明示"为什么是这个"，用户可手动改选。
   */
  async activeSession(agent: string | undefined, instance: string): Promise<OcCallResult<{ session: OcSession; reason: 'busy' | 'recent' }>> {
    const { st, err } = this.resolve(agent, instance);
    if (err || !st) return { ok: false, error: err };
    const [status, sessions] = await Promise.all([st.client!.sessionStatus(), st.client!.listSessions()]);
    if (!sessions.ok || !Array.isArray(sessions.data) || !sessions.data.length) return { ok: false, error: sessions.error || '该实例没有任何会话' };
    const ts = (s: OcSession): number => {
      const t = (s as Record<string, any>).time || {};
      return Number(t.updated || t.created || 0);
    };
    const sorted = [...sessions.data].sort((a, b) => ts(b) - ts(a));
    if (status.ok && status.data) {
      const busy = sorted.filter((s) => {
        const v = status.data![s.id];
        return v && String((v as { type?: string }).type || '') !== 'idle';
      });
      if (busy.length) return { ok: true, data: { session: busy[0], reason: 'busy' as const } };
    }
    return { ok: true, data: { session: sorted[0], reason: 'recent' as const } };
  }

  async listAgents(agent: string | undefined, instance: string): Promise<OcCallResult<{ name: string; description?: string; mode?: string }[]>> {
    const { st, err } = this.resolve(agent, instance);
    if (err || !st) return { ok: false, error: err };
    const r = await st.client!.listAgents();
    if (!r.ok) return r;
    return { ok: true, data: (r.data || []).map((a) => ({ name: a.name, ...(a.description ? { description: a.description } : {}), ...(a.mode ? { mode: a.mode } : {}) })) };
  }

  async listProviders(agent: string | undefined, instance: string): Promise<OcCallResult<{ providers?: unknown[]; default?: Record<string, string> }>> {
    const { st, err } = this.resolve(agent, instance);
    if (err || !st) return { ok: false, error: err };
    return st.client!.listProviders();
  }

  async runCommand(agent: string | undefined, instance: string, sessionId: string, command: string, args = '', ocAgent?: string): Promise<OcCallResult<unknown>> {
    const { st, err } = this.resolve(agent, instance);
    if (err || !st) return { ok: false, error: err };
    const gate = this.requireControl(st);
    if (gate) return { ok: false, error: gate };
    this.audit('command', st, { session: sessionId, command: command.slice(0, 80) });
    return st.client!.runCommand(sessionId, command, args, ocAgent);
  }

  async sessionTodos(agent: string | undefined, instance: string, sessionId: string): Promise<OcCallResult<{ content: string; status: string; priority: string }[]>> {
    const { st, err } = this.resolve(agent, instance);
    if (err || !st) return { ok: false, error: err };
    return st.client!.sessionTodos(sessionId);
  }

  async tuiAppend(agent: string | undefined, instance: string, text: string): Promise<OcCallResult<boolean>> {
    const { st, err } = this.resolve(agent, instance);
    if (err || !st) return { ok: false, error: err };
    const gate = this.requireControl(st);
    if (gate) return { ok: false, error: gate };
    this.audit('tui_append', st, { chars: text.length });
    return st.client!.appendPrompt(text);
  }

  async tuiSubmit(agent: string | undefined, instance: string): Promise<OcCallResult<boolean>> {
    const { st, err } = this.resolve(agent, instance);
    if (err || !st) return { ok: false, error: err };
    const gate = this.requireControl(st);
    if (gate) return { ok: false, error: gate };
    this.audit('tui_submit', st, {});
    return st.client!.submitPrompt();
  }

  async tuiToast(agent: string | undefined, instance: string, message: string, variant: 'info' | 'success' | 'warning' | 'error' = 'info'): Promise<OcCallResult<boolean>> {
    const { st, err } = this.resolve(agent, instance);
    if (err || !st) return { ok: false, error: err };
    const gate = this.requireControl(st);
    if (gate) return { ok: false, error: gate };
    return st.client!.showToast(message, variant);
  }

  async tuiOpenSessions(agent: string | undefined, instance: string): Promise<OcCallResult<boolean>> {
    const { st, err } = this.resolve(agent, instance);
    if (err || !st) return { ok: false, error: err };
    const gate = this.requireControl(st);
    if (gate) return { ok: false, error: gate };
    return st.client!.openSessions();
  }

  /** 让位式接管：把 TUI 导航到指定会话（需 control 档；审计留痕） */
  async tuiSelectSession(agent: string | undefined, instance: string, sessionId: string): Promise<OcCallResult<boolean>> {
    const { st, err } = this.resolve(agent, instance);
    if (err || !st) return { ok: false, error: err };
    const gate = this.requireControl(st);
    if (gate) return { ok: false, error: gate };
    this.audit('tui_select_session', st, { to: sessionId });
    return st.client!.selectSession(sessionId);
  }

  /**
   * attached 实例的浏览器侧代理 SSE：co-team 持 Basic 鉴权代收（EventSource 无法设请求头）。
   * managed 实例无鉴权，前端走 /direct 拿地址直连，不占这里。
   */
  async proxyEvents(id: string, onEvent: (ev: OcEvent) => void, signal: AbortSignal): Promise<void> {
    const st = this.instances.get(id);
    if (!st?.client) throw new Error(`实例 ${id} 不存在或未连接`);
    for await (const ev of st.client.eventStream(signal)) {
      if (isDroppedEvent(ev.type)) continue;
      onEvent(ev);
    }
  }

  /** PTY 列表（TUI 的实时终端） */
  async ptyList(agent: string | undefined, instance: string): Promise<OcCallResult<{ id: string; title?: string; command?: string; status?: string }[]>> {
    const { st, err } = this.resolve(agent, instance);
    if (err || !st) return { ok: false, error: err };
    return st.client!.listPtys();
  }

  /** 签 PTY 连接票：浏览器持 ticket 直连 opencode 的 /pty/{id}/connect（WebSocket） */
  async ptyTicket(agent: string | undefined, instance: string, ptyId: string): Promise<OcCallResult<{ ticket: string; expires_in: number; ws_url: string }>> {
    const { st, err } = this.resolve(agent, instance);
    if (err || !st) return { ok: false, error: err };
    const r = await st.client!.ptyConnectToken(ptyId);
    if (!r.ok || !r.data) return { ok: false, error: r.error || '签票失败' };
    const wsBase = st.url.replace(/^http/, 'ws');
    return { ok: true, data: { ...r.data, ws_url: `${wsBase}/pty/${encodeURIComponent(ptyId)}/connect` } };
  }

  /** managed 实例的直连信息（无鉴权 + CORS 已放行 → 浏览器 EventSource/WS 直连） */
  directInfo(id: string): { ok: boolean; url: string; direct: boolean; reason?: string } {
    const st = this.instances.get(id);
    if (!st || st.cfg.enabled === false) return { ok: false, url: '', direct: false, reason: '实例不存在或已禁用' };
    if (st.cfg.kind !== 'managed') return { ok: false, url: st.url, direct: false, reason: 'attached 实例带鉴权，走 /events 代理' };
    if (st.state !== 'connected') return { ok: false, url: st.url, direct: false, reason: `实例未连接：${st.error || '启动中'}` };
    return { ok: true, url: st.url, direct: true };
  }

  // ---------- 运行时状态（/api/opencode、/api/status） ----------

  status(): OpencodeInstanceStatus[] {
    return [...this.instances.values()].map((st) => ({
      id: st.cfg.id,
      kind: st.cfg.kind,
      ...(st.cfg.label ? { label: st.cfg.label } : {}),
      enabled: st.cfg.enabled !== false,
      state: st.state,
      url: st.url,
      mode: modeOf(st.cfg),
      version: st.capabilities?.version || '',
      ...(st.capabilities ? { capabilities: st.capabilities } : {}),
      ...(st.pid ? { pid: st.pid } : {}),
      ...(st.projectRoot ? { project_root: st.projectRoot } : {}),
      model_injection: st.cfg.model_injection === true,
      ...(st.error ? { error: st.error } : {}),
      ...(st.lastCheckedAt ? { last_checked_at: st.lastCheckedAt } : {}),
      ...(st.logPath ? { log: st.logPath } : {}),
    }));
  }

  hasInstances(): boolean {
    return [...this.instances.values()].some((s) => s.cfg.enabled !== false);
  }

  /** managed 实例手动启停（面板按钮） */
  async startInstance(id: string): Promise<boolean> {
    const st = this.instances.get(id);
    if (!st || st.cfg.kind !== 'managed') return false;
    if (st.proc) return true;
    if (st.healthTimer) clearInterval(st.healthTimer);
    if (st.restartTimer) clearTimeout(st.restartTimer);
    await this.startManaged(st);
    return st.state === 'connected';
  }

  async stopInstance(id: string): Promise<boolean> {
    const st = this.instances.get(id);
    if (!st || st.cfg.kind !== 'managed') return false;
    if (st.healthTimer) clearInterval(st.healthTimer);
    if (st.restartTimer) clearTimeout(st.restartTimer);
    st.eventAbort?.abort();
    st.batcher?.dispose();
    this.killTree(st);
    // 摘掉登记条目：下次启动的孤儿清理不需要尝试这个已退的
    try {
      const reg = pidRegistryPath();
      if (fs.existsSync(reg)) {
        const cur = JSON.parse(fs.readFileSync(reg, 'utf-8')) as Record<string, unknown>;
        delete cur[id];
        fs.writeFileSync(reg, JSON.stringify(cur), 'utf-8');
      }
    } catch { /* 忽略 */ }
    st.state = 'stopped';
    st.error = undefined;
    return true;
  }
}

/** 查端口当前监听者 pid（孤儿清理的双条件校验之一；查不到返回 undefined） */
function portOwner(port: number): Promise<number | undefined> {
  return new Promise((resolve) => {
    const cmd = process.platform === 'win32'
      ? `powershell -NoProfile -Command "(Get-NetTCPConnection -State Listen -LocalPort ${port} -ErrorAction SilentlyContinue).OwningProcess"`
      : `lsof -ti :${port} -sTCP:LISTEN 2>/dev/null`;
    exec(cmd, { timeout: 5000, windowsHide: true }, (err, stdout) => {
      if (err) return resolve(undefined);
      const pid = Number(String(stdout).trim().split(/\s+/)[0]);
      resolve(Number.isInteger(pid) && pid > 0 ? pid : undefined);
    });
  });
}

/** 本机空闲端口挑选（managed 未配 port 时用） */
function pickFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      srv.close(() => (port ? resolve(port) : reject(new Error('no free port'))));
    });
  });
}

/**
 * 桌面版 service 端口自动发现：解析 %APPDATA%/ai.opencode.desktop/logs/<最新目录>/*.log
 * 里的 `port: '<n>'`（2026-09-24 实测 crash.log 有该行）。失败返回 undefined（转手填兜底）。
 */
export function discoverDesktopPort(): number | undefined {
  try {
    const logsRoot = path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'ai.opencode.desktop', 'logs');
    if (!fs.existsSync(logsRoot)) return undefined;
    const dirs = fs.readdirSync(logsRoot, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort()
      .reverse();
    for (const dir of dirs.slice(0, 3)) {
      const full = path.join(logsRoot, dir);
      const files = fs.readdirSync(full).filter((f) => f.endsWith('.log'));
      for (const f of files) {
        const text = fs.readFileSync(path.join(full, f), 'utf-8');
        const m = text.match(/port:\s*'(\d+)'/i) || text.match(/port[=:]\s*(\d{2,5})/i);
        if (m) {
          const port = Number(m[1]);
          if (port > 0 && port < 65536) return port;
        }
      }
    }
    return undefined;
  } catch {
    return undefined;
  }
}

/** 结构校验（PUT /api/config/opencode 与「测试连接」共用）：失败 throw，消息可直接给 UI */
export function validateOpencodeInstanceConfigs(list: unknown): OpencodeInstanceConfig[] {
  if (!Array.isArray(list)) throw new Error('instances 必须是数组');
  const ids = new Set<string>();
  const out: OpencodeInstanceConfig[] = [];
  for (const raw of list as Record<string, any>[]) {
    if (!raw || typeof raw !== 'object') throw new Error('instances 中存在非对象条目');
    const id = String(raw.id || '').trim().toLowerCase();
    if (!/^[a-z0-9][a-z0-9_-]*$/.test(id)) throw new Error(`无效实例 id "${String(raw.id || '')}"（需小写字母/数字开头，仅含 a-z0-9_-）`);
    if (ids.has(id)) throw new Error(`重复的实例 id: ${id}`);
    ids.add(id);
    const kind = raw.kind === 'managed' || raw.kind === 'attached-cli' || raw.kind === 'attached-desktop' ? raw.kind : undefined;
    if (!kind) throw new Error(`${id}: kind 必须是 managed | attached-cli | attached-desktop`);
    const cfg: OpencodeInstanceConfig = { id, kind, enabled: raw.enabled !== false };
    if (raw.label !== undefined) cfg.label = String(raw.label);
    if (kind === 'managed') {
      if (raw.project_root !== undefined && typeof raw.project_root !== 'string') throw new Error(`${id}: project_root 必须是字符串`);
      if (raw.project_root) cfg.project_root = raw.project_root;
      if (raw.command !== undefined) {
        if (typeof raw.command !== 'string' || !raw.command.trim()) throw new Error(`${id}: command 必须是非空字符串`);
        cfg.command = raw.command.trim();
      }
      if (raw.port !== undefined) {
        const p = Number(raw.port);
        if (!Number.isInteger(p) || p < 0 || p > 65535) throw new Error(`${id}: port 必须是 0-65535 的整数`);
        cfg.port = p;
      }
      cfg.model_injection = raw.model_injection === true;
      cfg.auto_start = raw.auto_start !== false;
      // managed 是 co-team 自家子进程：缺省 control，显式 readonly 才收紧
      cfg.mode = raw.mode === 'readonly' ? 'readonly' : 'control';
    } else {
      if (raw.url !== undefined) {
        if (typeof raw.url !== 'string') throw new Error(`${id}: url 必须是字符串`);
        cfg.url = raw.url.trim();
        if (cfg.url) {
          try {
            const u = new URL(cfg.url);
            if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('bad protocol');
          } catch {
            throw new Error(`${id}: url 必须是合法的 http(s) 地址`);
          }
        }
      }
      const mode = raw.mode === 'control' ? 'control' : raw.mode === undefined || raw.mode === 'readonly' ? 'readonly' : undefined;
      if (!mode) throw new Error(`${id}: mode 必须是 readonly | control`);
      cfg.mode = mode;
      if (raw.auth !== undefined) {
        if (!raw.auth || typeof raw.auth !== 'object' || Array.isArray(raw.auth)) throw new Error(`${id}: auth 必须是对象`);
        cfg.auth = { ...(raw.auth.username !== undefined ? { username: String(raw.auth.username) } : {}), ...(raw.auth.password !== undefined ? { password: String(raw.auth.password) } : {}) };
      }
    }
    if (raw.env !== undefined) {
      if (!raw.env || typeof raw.env !== 'object' || Array.isArray(raw.env)) throw new Error(`${id}: env 必须是对象`);
      cfg.env = Object.fromEntries(Object.entries(raw.env).map(([k, v]) => [k, String(v)]));
    }
    if (raw.args !== undefined) {
      if (!Array.isArray(raw.args) || raw.args.some((a: unknown) => typeof a !== 'string')) throw new Error(`${id}: args 必须是字符串数组`);
      cfg.args = raw.args.map(String);
    }
    cfg.allow_shell = raw.allow_shell === true;
    if (raw.timeout_sec !== undefined) {
      const n = Number(raw.timeout_sec);
      if (!Number.isFinite(n) || n <= 0) throw new Error(`${id}: timeout_sec 必须是正数`);
      cfg.timeout_sec = Math.floor(n);
    }
    if (raw.max_result_chars !== undefined) {
      const n = Number(raw.max_result_chars);
      if (!Number.isFinite(n) || n <= 0) throw new Error(`${id}: max_result_chars 必须是正数`);
      cfg.max_result_chars = Math.floor(n);
    }
    out.push(cfg);
  }
  return out;
}
