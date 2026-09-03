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
import { policyFromConfig } from './sandbox';
import { emitProgress } from './store';
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

function staticMiddleware(webDist: string) {
  return async (c: Context, next: Next) => {
    const urlPath = decodeURIComponent(new URL(c.req.url).pathname);
    if (urlPath.startsWith('/api/') || urlPath === '/ws/events') return next();
    const hasExtension = path.extname(urlPath) !== '';
    let filePath = path.join(webDist, urlPath === '/' ? 'index.html' : urlPath);
    if (!filePath.startsWith(webDist)) return next();
    if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
      // SPA fallback only for navigations; never serve index.html as a fake asset
      if (hasExtension) return c.body('not found', 404);
      filePath = path.join(webDist, 'index.html');
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

  await initBus(config.redis);
  logger.info('Message bus initialized');

  const modelPool = new ModelPool(config.model_pool);
  logger.info('Model pool initialized', { 
    models: config.model_pool.map(m => m.name) 
  });

  const orchestrator = new Orchestrator({
    agentsDir: config.agents_dir,
    modelPool,
    policy: policyFromConfig(config.permissions),
    maxRetries: config.orchestrator.max_retries,
    sandboxEnabled: config.orchestrator.sandbox,
    gitEnabled: config.orchestrator.git,
    branchWorkflow: config.orchestrator.branch_workflow,
    tokenBudget: config.orchestrator.token_budget,
  });

  await orchestrator.loadAgents();
  logger.info('Agents loaded', { 
    agents: [...orchestrator.plugins.keys()] 
  });

  orchestrator.onProgress = (type, payload) => void emitProgress(type, payload);

  const ctx: ApiContext = { config, orchestrator, modelPool };
  const app = createApi(ctx);

  // static hosting of the built web dashboard (SPA fallback to index.html)
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
