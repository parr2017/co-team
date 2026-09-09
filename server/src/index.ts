#!/usr/bin/env node
import * as fs from 'node:fs';
import * as path from 'node:path';
import { serve } from '@hono/node-server';
import type { Context, Next } from 'hono';
import { createApi, attachWebSocket, ApiContext } from './api';
import { initBus, closeBus } from './bus';
import { loadConfig, PROJECT_ROOT } from './config';
import { Orchestrator } from './orchestrator/orchestrator';
import { ModelPool } from './scheduler';
import { TaskQueueManager } from './taskQueue';
import { policyFromConfig } from './sandbox';
import { emitProgress } from './store';
import { startClarifyTimeoutScanner } from './clarifyTimeout';
import { startDailyReportScanner } from './dailyReport';
import { configureGrader } from './grader';
import { configureLlmTimeouts } from './llm';
import { initLogger, getLogger } from './logger';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

/** Serve a built SPA. `prefix` ('' for web root, '/m' for mobile) maps URL paths into `dist`. */
function staticMiddleware(dist: string, prefix = '') {
  return async (c: Context, next: Next) => {
    const urlPath = decodeURIComponent(new URL(c.req.url).pathname);
    if (urlPath.startsWith('/api/') || urlPath === '/ws/events') return next();
    if (prefix) {
      if (urlPath === prefix) {
        // "/m" → redirect to "/m/" so relative assets resolve under the base
        return c.redirect(`${prefix}/`, 302);
      }
      if (urlPath !== `${prefix}/` && !urlPath.startsWith(`${prefix}/`)) return next();
    }
    const relative = prefix ? urlPath.slice(prefix.length) : urlPath;
    const hasExtension = path.extname(relative) !== '';
    let filePath = path.join(dist, relative === '/' || relative === '' ? 'index.html' : relative);
    if (!filePath.startsWith(dist)) return next();
    if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
      // SPA fallback only for navigations; never serve index.html as a fake asset
      if (hasExtension) return c.body('not found', 404);
      filePath = path.join(dist, 'index.html');
    }
    if (!fs.existsSync(filePath)) return next();
    const isIndex = filePath.endsWith('index.html');
    const cacheControl = isIndex ? 'no-cache' : 'public, max-age=31536000, immutable';
    return c.body(fs.readFileSync(filePath), 200, {
      'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream',
      'Cache-Control': cacheControl,
    });
  };
}

async function main(): Promise<void> {
  // 初始化日志系统
  const logger = initLogger({
    level: (process.env.COTEAM_LOG_LEVEL as any) || 'info',
    logDir: process.env.COTEAM_LOG_DIR || path.join(PROJECT_ROOT, 'logs'),
  });

  // 全局错误处理
  process.on('uncaughtException', (error) => {
    logger.error('Uncaught Exception:', error);
    console.error('Uncaught Exception:', error);
    // 不立即退出，让错误处理有机会执行
  });

  process.on('unhandledRejection', (reason, promise) => {
    logger.error('Unhandled Rejection:', reason);
    console.error('Unhandled Rejection:', reason);
    // 不立即退出，让错误处理有机会执行
  });

  logger.info('Starting co-team...');
  
  const config = loadConfig(process.env.COTEAM_ROOT || PROJECT_ROOT);
  logger.info('Configuration loaded', { 
    agentsDir: config.agents_dir,
    port: config.dashboard.port,
    modelsCount: config.model_pool.length 
  });

  // 超时语义重做：idle/cap 策略来自 config.yaml `llm:` 段（时长本身不判死）
  if (config.llm) {
    configureLlmTimeouts({
      first_token_idle_sec: config.llm.first_token_idle_sec,
      stream_idle_sec: config.llm.stream_idle_sec,
      wallclock_cap_sec: config.llm.wallclock_cap_sec,
      non_stream_timeout_sec: config.llm.non_stream_timeout_sec,
    });
    logger.info('LLM timeout policy loaded', {
      first_token_idle_sec: config.llm.first_token_idle_sec,
      stream_idle_sec: config.llm.stream_idle_sec,
      wallclock_cap_sec: config.llm.wallclock_cap_sec,
    });
  }

  await initBus(config.redis);
  logger.info('Message bus initialized');

  const modelPool = new ModelPool(config.model_pool);
  logger.info('Model pool initialized', {
    models: config.model_pool.map(m => m.name)
  });

  // knowledge RAG: point the embedding helper at the configured model_pool entry
  // (disabled / missing model → keyword search stays active everywhere)
  if (config.knowledge.embedding?.enabled && config.knowledge.embedding.model) {
    const { setEmbeddingConfig } = await import('./embeddings');
    setEmbeddingConfig({ pool: modelPool, model: config.knowledge.embedding.model });
    logger.info('Knowledge embedding enabled', { model: config.knowledge.embedding.model });
  }

  const orchestrator = new Orchestrator({
    agentsDir: config.agents_dir,
    modelPool,
    policy: policyFromConfig(config.permissions),
    maxRetries: config.orchestrator.max_retries,
    sandboxEnabled: config.orchestrator.sandbox,
    gitEnabled: config.orchestrator.git,
    branchWorkflow: config.orchestrator.branch_workflow,
    tokenBudget: config.orchestrator.token_budget,
    maxFixRounds: config.orchestrator.max_fix_rounds,
    modelWaitTimeoutSec: config.orchestrator.model_wait_timeout_sec,
    nodeClarify: config.orchestrator.node_clarify,
    selfModGate: config.orchestrator.self_mod_gate,
    projects: config.projects,
    slowSuccessSec: config.llm?.slow_success_sec,
    outputTiers: config.llm?.output_tiers,
    context: config.context,
  });

  await orchestrator.loadAgents();
  logger.info('Agents loaded', {
    agents: [...orchestrator.plugins.keys()]
  });

  // E7: tasks still 'running' at boot have no executor behind them (the previous
  // process died mid-dispatch) — mark them failed so they never zombie.
  const interrupted = await orchestrator.sweepInterruptedTasks();
  if (interrupted.length) logger.warn('Startup sweep: interrupted tasks marked failed', { tasks: interrupted });

  // 群组讨论：引擎 v2 配置（组内执行策略/轮数上限/背景注入预算）+ 上一进程死在轮次中
  // 会遗留 busy/stop 锁（无属主，TTL 内会卡住讨论）——启动即清
  const { clearStaleDiscussionLocks, configureDiscussion, resumeOrphanedDiscussions } = await import('./discussion');
  configureDiscussion(config.discussion);
  await clearStaleDiscussionLocks(logger);

  // 任务 git 落点治理：上一进程把项目仓库 HEAD 切到 coteam/task-* 后未回切的，启动时清扫
  // （分支无独有提交才回切；有独有提交保留并告警，绝不自动丢人工作）
  const { restoreStaleTaskHeads } = await import('./workspace');
  const heads = await restoreStaleTaskHeads(logger);
  if (heads.restored.length) logger.info('Startup sweep: stale task HEADs restored', { restored: heads.restored });
  if (heads.held.length) logger.warn('Startup sweep: task branches with unmerged commits held', { held: heads.held });

  // improvement 7 (R6): project-specific grading keywords from config.yaml
  if (config.grading) {
    configureGrader(config.grading);
    logger.info('Custom grading keywords loaded', {
      heavy: config.grading.heavy?.length || 0,
      light: config.grading.light?.length || 0,
    });
  }

  orchestrator.onProgress = (type, payload) => void emitProgress(type, payload);

  // project-scoped execution lanes: same project serial, cross-project parallel,
  // failures block the lane until the user resumes it
  const taskQueue = new TaskQueueManager(orchestrator, modelPool);
  logger.info('Task queue initialized (one running task per project)');

  // 重启/崩溃打断在飞轮时，"最后一条是用户消息"的讨论重新驱动——用户的话不能石沉大海
  await resumeOrphanedDiscussions({ orchestrator, pool: modelPool, taskQueue, logger });

  // improvement 5 (R5): periodic scan nudges tasks stuck in 'clarifying' (once per task)
  startClarifyTimeoutScanner({ timeoutHours: config.orchestrator.clarify_timeout_hours ?? 24 });
  logger.info('Clarify timeout scanner started', { timeoutHours: config.orchestrator.clarify_timeout_hours ?? 24 });

  // feature: 每日问题报告 — minute-tick scanner, inert until the UI switch turns it on
  const dailyReportScanner = startDailyReportScanner({ enabled: config.daily_report?.enabled ?? false, hour: config.daily_report?.hour ?? 9 });
  logger.info('Daily report scanner started', { enabled: config.daily_report?.enabled ?? false, hour: config.daily_report?.hour ?? 9 });

  const ctx: ApiContext = { config, orchestrator, modelPool, taskQueue, dailyReportScanner };
  const app = createApi(ctx);

  // browsers always probe /favicon.ico — answer 204 so it stops spamming the API log
  app.get('/favicon.ico', (c) => c.body(null, 204));

  // static hosting of the built frontends (SPA fallback to index.html):
  // mobile under /m/, desktop at the root — both same-origin, zero CORS
  const mobileDist = process.env.COTEAM_MOBILE_DIST || path.resolve(PROJECT_ROOT, 'mobile', 'dist');
  if (fs.existsSync(mobileDist)) {
    app.use('*', staticMiddleware(mobileDist, '/m'));
    logger.info('Mobile app loaded from', { path: mobileDist });
  }
  const webDist = process.env.COTEAM_WEB_DIST || path.resolve(PROJECT_ROOT, 'web', 'dist');
  if (fs.existsSync(webDist)) {
    app.use('*', staticMiddleware(webDist));
    logger.info('Web dashboard loaded from', { path: webDist });
  }

  const server = serve({ fetch: app.fetch, port: config.dashboard.port, hostname: config.dashboard.host }, (info) => {
    logger.info(`Dashboard started`, { 
      url: `http://localhost:${info.port}`,
      agents: [...orchestrator.plugins.keys()],
      models: config.model_pool.map((m) => m.name)
    });
  });
  attachWebSocket(server as unknown as import('node:http').Server, 'coteam:dashboard');

  const shutdown = () => {
    logger.info('Shutting down...');
    closeBus();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((e) => {
  const logger = getLogger();
  logger.error('Fatal error during startup:', e);
  console.error('[co-team] fatal:', e);
  process.exit(1);
});
