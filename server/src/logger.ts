import * as fs from 'node:fs';
import * as path from 'node:path';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LOG_LEVELS: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

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
      const logFile = path.join(this.logDir, `co-team-${date}.log`);
      
      this.stream = fs.createWriteStream(logFile, { flags: 'a' });
      
      process.on('exit', () => {
        this.stream?.end();
      });
    } catch (err) {
      console.error('Failed to initialize log file:', err);
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
    
    // 写入控制台
    if (level === 'error') {
      console.error(formattedMessage);
    } else if (level === 'warn') {
      console.warn(formattedMessage);
    } else {
      console.log(formattedMessage);
    }
    
    // 写入文件
    if (this.stream) {
      this.stream.write(formattedMessage + '\n');
    }
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