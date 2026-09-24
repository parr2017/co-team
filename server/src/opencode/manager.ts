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
import { spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as path from 'node:path';
import * as os from 'node:os';
import { getLogger, type Logger } from '../logger';
import type { ModelConfig } from '../types';
import { resolveModelRef } from './modelInjection';
import { OpencodeClient } from './client';
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
}

/** idle 等待的绝对值定义：run_task 的最坏等待预算（opencode 自主跑一个任务可能很久） */
const IDLE_WAIT_MAX_MS = 30 * 60_000;

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
    for (const st of this.instances.values()) {
      if (st.healthTimer) clearInterval(st.healthTimer);
      if (st.restartTimer) clearTimeout(st.restartTimer);
      st.eventAbort?.abort();
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
      const args = [...(st.cfg.args || []), 'serve', '--port', String(port), '--hostname', hostname];
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
      st.url = `http://${hostname}:${port}`;
      st.client = this.buildClient(st);
      proc.on('exit', (code) => {
        st.proc = undefined;
        st.pid = undefined;
        st.eventAbort?.abort();
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

  /** SSE 订阅循环：断流按退避重订，直到 stop/applyConfig abort */
  private subscribeEvents(st: InstanceState): void {
    st.eventAbort?.abort();
    const ac = new AbortController();
    st.eventAbort = ac;
    void (async () => {
      while (!ac.signal.aborted && !this.stopped) {
        try {
          for await (const ev of st.client!.eventStream(ac.signal)) {
            if (ac.signal.aborted) break;
            // run_task 的 idle 等待器先行（本地唤醒，不依赖转发方接线）
            this.wakeIdleWaiters(st, ev);
            try { this.eventForwarder?.(st.cfg.id, ev); } catch { /* 转发方异常不杀流 */ }
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

  async readMessages(agent: string | undefined, instance: string, sessionId: string): Promise<OcCallResult<unknown[]>> {
    const { st, err } = this.resolve(agent, instance);
    if (err || !st) return { ok: false, error: err };
    return st.client!.listMessages(sessionId);
  }

  async sendPrompt(agent: string | undefined, instance: string, sessionId: string, prompt: string, model?: { providerID: string; modelID: string }): Promise<OcCallResult<unknown>> {
    const { st, err } = this.resolve(agent, instance);
    if (err || !st) return { ok: false, error: err };
    const gate = this.requireControl(st);
    if (gate) return { ok: false, error: gate };
    this.audit('send_prompt', st, { session: sessionId, model, prompt_chars: prompt.length });
    return st.client!.prompt(sessionId, prompt, model);
  }

  async sendPromptAsync(agent: string | undefined, instance: string, sessionId: string, prompt: string, model?: { providerID: string; modelID: string }): Promise<OcCallResult<{ messageID?: string }>> {
    const { st, err } = this.resolve(agent, instance);
    if (err || !st) return { ok: false, error: err };
    const gate = this.requireControl(st);
    if (gate) return { ok: false, error: gate };
    this.audit('send_prompt_async', st, { session: sessionId, model, prompt_chars: prompt.length });
    return st.client!.promptAsync(sessionId, prompt, model);
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

  /** 模型名 → opencode model ref（仅 model_injection 实例；attached 实例模型归 opencode，不解析） */
  resolveModel(instance: string, modelName: string): { providerID: string; modelID: string } | undefined {
    const st = this.instances.get(instance);
    if (!st || st.cfg.model_injection !== true || !this.modelPool.length) return undefined;
    return resolveModelRef(this.modelPool, modelName);
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
    this.killTree(st);
    st.state = 'stopped';
    st.error = undefined;
    return true;
  }
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
