import * as fs from 'node:fs';
import * as path from 'node:path';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LOG_LEVELS: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

/** 单个日志文件上限 50MB——2026-09-14 单日 2.7GB 的教训（EPIPE 风暴无上限刷盘） */
const MAX_LOG_BYTES = 50 * 1024 * 1024;
/** 同一天最多保留的分卷数（含主文件），超出删最旧 */
const KEEP_LOG_PARTS = 5;

interface LoggerOptions {
  level: LogLevel;
  logDir?: string;
  prefix?: string;
}

class Logger {
  private level: number;
  private logDir?: string;
  private prefix: string;
  private stream?: fs.WriteStream;
  private streamDate = '';
  private streamSeq = 0;
  /** EPIPE 风暴熔断（2026-09-15）：console 管道对端死亡（launcher/终端关闭）后，
   *  每条 console 写入都会同步抛 EPIPE 并再触发 uncaughtException——2433 万条/日的
   *  自我喂养死循环就是这么来的。一旦写失败，永久禁用 console 侧，只写文件。 */
  private consoleDead = false;

  constructor(options: LoggerOptions) {
    this.level = LOG_LEVELS[options.level] ?? LOG_LEVELS.info;
    this.logDir = options.logDir;
    this.prefix = options.prefix || '[co-team]';

    if (this.logDir) {
      this.initFileStream();
    }
  }

  private initFileStream(): void {
    if (!this.logDir) return;

    try {
      if (!fs.existsSync(this.logDir)) {
        fs.mkdirSync(this.logDir, { recursive: true });
      }

      const date = new Date().toISOString().split('T')[0];
      const seqSuffix = this.streamSeq > 0 ? `.${this.streamSeq}` : '';
      const logFile = path.join(this.logDir, `co-team-${date}${seqSuffix}.log`);

      this.stream = fs.createWriteStream(logFile, { flags: 'a' });
      // 文件流自身的错误（磁盘满、文件被删、EBUSY）必须静默——日志系统永远不能变成
      // 杀死进程的东西（2026-09-14 EPIPE 风暴的文件侧同款教训）
      this.stream.on('error', () => { /* swallow: 下一次 ensureStream 会重建 */ });

      process.on('exit', () => {
        this.stream?.end();
      });
    } catch (err) {
      this.safeConsole('error', 'Failed to initialize log file:', err);
    }
  }

  /** OBS-1 修复：跨天滚动——长期运行的进程此前一直写启动当天那份文件；
   *  2026-09-15 追加大小滚动：单文件超 50MB 切 .1/.2/...，每天最多保留 5 份防磁盘打爆。 */
  private ensureStream(): void {
    if (!this.logDir) return;
    const date = new Date().toISOString().split('T')[0];
    if (this.streamDate !== date || (this.stream && this.stream.bytesWritten >= MAX_LOG_BYTES)) {
      if (this.stream && this.stream.bytesWritten >= MAX_LOG_BYTES) this.streamSeq += 1;
      else this.streamSeq = 0;
      this.streamDate = date;
      this.stream?.end();
      this.pruneOldParts(date);
      this.initFileStream();
    }
  }

  /** 大小滚动后清理：同日只保留最近 KEEP_LOG_PARTS 份分卷（含主文件）。 */
  private pruneOldParts(date: string): void {
    if (!this.logDir) return;
    try {
      const parts = fs.readdirSync(this.logDir)
        .filter((f) => f.startsWith(`co-team-${date}.`) && f.endsWith('.log'))
        .map((f) => Number(f.slice(`co-team-${date}.`.length, -'.log'.length)))
        .filter((n) => Number.isFinite(n))
        .sort((a, b) => b - a);
      for (const n of parts.slice(KEEP_LOG_PARTS - 1)) {
        try { fs.unlinkSync(path.join(this.logDir, `co-team-${date}.${n}.log`)); } catch { /* 并发删已不存在 */ }
      }
    } catch { /* 目录不可读时放弃清理，不影响写日志 */ }
  }

  /** console 写入的唯一入口：EPIPE（或任何写失败）后拉闸，进程继续、文件日志不受影响。 */
  private safeConsole(level: 'log' | 'warn' | 'error', ...args: unknown[]): void {
    if (this.consoleDead) return;
    try {
      // eslint-disable-next-line no-console
      (level === 'error' ? console.error : level === 'warn' ? console.warn : console.log)(...args);
    } catch (e: any) {
      if (e?.code === 'EPIPE' || e?.code === 'ERR_STREAM_DESTROYED' || e?.code === 'ERR_STREAM_WRITE_AFTER_END') {
        this.consoleDead = true;
      }
    }
  }

  private formatMessage(level: LogLevel, message: string, ...args: any[]): string {
    const timestamp = new Date().toISOString();
    const formattedArgs = args.length > 0 ? ' ' + args.map(arg => 
      typeof arg === 'object' ? JSON.stringify(arg) : String(arg)
    ).join(' ') : '';
    
    return `${timestamp} ${this.prefix} [${level.toUpperCase()}] ${message}${formattedArgs}`;
  }

  private write(level: LogLevel, message: string, ...args: any[]): void {
    if (LOG_LEVELS[level] < this.level) return;

    const formattedMessage = this.formatMessage(level, message, ...args);

    // 写入控制台（EPIPE 安全：管道死亡只丢 console 侧，绝不反向炸出异常风暴）
    if (level === 'error') {
      this.safeConsole('error', formattedMessage);
    } else if (level === 'warn') {
      this.safeConsole('warn', formattedMessage);
    } else {
      this.safeConsole('log', formattedMessage);
    }

    // 写入文件（磁盘异常同样不外抛——日志永远不能变成杀死进程的东西）
    try {
      this.ensureStream();
      if (this.stream) {
        this.stream.write(formattedMessage + '\n');
      }
    } catch { /* 文件写失败静默：console 已尽力 */ }
  }

  debug(message: string, ...args: any[]): void {
    this.write('debug', message, ...args);
  }

  info(message: string, ...args: any[]): void {
    this.write('info', message, ...args);
  }

  warn(message: string, ...args: any[]): void {
    this.write('warn', message, ...args);
  }

  error(message: string, ...args: any[]): void {
    this.write('error', message, ...args);
  }

  // 任务相关的便捷方法
  taskStart(taskId: string, description: string): void {
    this.info(`Task started: ${taskId}`, { description });
  }

  taskComplete(taskId: string, status: string, changes: number): void {
    this.info(`Task completed: ${taskId}`, { status, changes });
  }

  taskFailed(taskId: string, error: string): void {
    this.error(`Task failed: ${taskId}`, { error });
  }

  nodeStart(taskId: string, nodeId: string, agent: string, nodeName: string): void {
    this.debug(`Node started: ${nodeName}`, { taskId, nodeId, agent });
  }

  nodeComplete(taskId: string, nodeId: string, agent: string): void {
    this.debug(`Node completed: ${nodeId}`, { taskId, nodeId, agent });
  }

  nodeFailed(taskId: string, nodeId: string, agent: string, error: string): void {
    this.error(`Node failed: ${nodeId}`, { taskId, nodeId, agent, error });
  }

  // Agent 相关的日志
  agentDispatch(taskId: string, nodeId: string, agent: string, model: string): void {
    this.debug(`Agent dispatched: ${agent}`, { taskId, nodeId, model });
  }

  agentResponse(taskId: string, nodeId: string, agent: string, tokens: number): void {
    this.debug(`Agent responded: ${agent}`, { taskId, nodeId, tokens });
  }

  // 系统相关的日志
  systemStart(port: number): void {
    this.info(`System started on port ${port}`);
  }

  systemError(error: string, stack?: string): void {
    this.error(`System error: ${error}`, { stack });
  }

  // 配置相关的日志
  configLoaded(agents: string[], models: string[]): void {
    this.info('Configuration loaded', { agents, models });
  }

  // Redis/总线相关的日志
  busConnected(type: string): void {
    this.info(`Message bus connected: ${type}`);
  }

  busError(error: string): void {
    this.error(`Message bus error: ${error}`);
  }

  // LLM 调用相关的日志
  llmCall(model: string, tokens: number): void {
    this.debug(`LLM call: ${model}`, { tokens });
  }

  llmError(model: string, error: string): void {
    this.error(`LLM call failed: ${model}`, { error });
  }
}

// 创建默认 logger 实例
let defaultLogger: Logger | null = null;

export function initLogger(options: Partial<LoggerOptions> = {}): Logger {
  const defaultOptions: LoggerOptions = {
    level: (process.env.COTEAM_LOG_LEVEL as LogLevel) || 'info',
    logDir: process.env.COTEAM_LOG_DIR || path.join(process.cwd(), 'logs'),
    prefix: '[co-team]',
  };

  defaultLogger = new Logger({ ...defaultOptions, ...options });
  return defaultLogger;
}

export function getLogger(): Logger {
  if (!defaultLogger) {
    defaultLogger = initLogger();
  }
  return defaultLogger;
}

export { Logger };