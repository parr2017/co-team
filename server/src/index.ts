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
  const config = loadConfig(process.env.COTEAM_ROOT || PROJECT_ROOT);
  await initBus(config.redis);
  const modelPool = new ModelPool(config.model_pool);
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
  orchestrator.onProgress = (type, payload) => void emitProgress(type, payload);

  const ctx: ApiContext = { config, orchestrator, modelPool };
  const app = createApi(ctx);

  // static hosting of the built web dashboard (SPA fallback to index.html)
  const webDist = process.env.COTEAM_WEB_DIST || path.resolve(PROJECT_ROOT, 'web', 'dist');
  if (fs.existsSync(webDist)) app.use('*', staticMiddleware(webDist));

  const server = serve({ fetch: app.fetch, port: config.dashboard.port, hostname: config.dashboard.host }, (info) => {
    console.log(`[co-team] dashboard  http://localhost:${info.port}`);
    console.log(`[co-team] agents    ${[...orchestrator.plugins.keys()].join(', ') || '(none)'}`);
    console.log(`[co-team] models    ${config.model_pool.map((m) => m.name).join(', ') || '(none)'}`);
  });
  attachWebSocket(server as unknown as import('node:http').Server, 'coteam:dashboard');

  const shutdown = () => {
    console.log('\n[co-team] shutting down...');
    closeBus();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((e) => {
  console.error('[co-team] fatal:', e);
  process.exit(1);
});
