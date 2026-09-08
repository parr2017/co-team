#!/usr/bin/env node
/**
 * 一次性存量清理：任务 git 落点治理（2026-09-08）落地后的历史遗留。
 *
 *   node scripts/cleanup-workspace-legacy.mjs            # dry-run 报告（默认，不改任何东西）
 *   node scripts/cleanup-workspace-legacy.mjs --apply    # 执行清理（仅无独有提交的分支 + tmp 目录 + 嵌套项目记录）
 *
 * 规则：
 * 1. co-team 仓库的 coteam/task-* 分支：对 main 无独有提交 → 可删；有独有提交 → 只报告，绝不自动删。
 * 2. 仓库根下的 tmp-* 演示目录：删除；Redis 中 workspace 指向它们的 project 记录（含 :memory/:deleted）一并删除。
 * 3. 外部项目仓库 HEAD 停在 coteam/task-* 的：只报告（服务启动时 restoreStaleTaskHeads 会安全处理）。
 */
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import Redis from 'ioredis';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const APPLY = process.argv.includes('--apply');
const REDIS = { host: '127.0.0.1', port: 6379, db: 0 };

const git = (args, cwd = ROOT) => execFileSync('git', args, { cwd, encoding: 'utf-8' }).trim();

// ---------- 1. co-team 仓库内的任务分支 ----------
console.log(`\n=== co-team 仓库 coteam/task-* 分支（${APPLY ? 'APPLY' : 'dry-run'}）===`);
const mainBranch = git(['rev-parse', '--verify', 'main']).length ? 'main' : 'master';
const branches = git(['branch', '--list', 'coteam/task-*', '--format=%(refname:short)']).split('\n').filter(Boolean);
let cur = '';
try {
  cur = git(['rev-parse', '--abbrev-ref', 'HEAD']);
} catch { /* ignore */ }
for (const b of branches) {
  let ahead = -1;
  try {
    ahead = parseInt(git(['rev-list', '--count', `${mainBranch}..${b}`]), 10);
  } catch { /* ignore */ }
  if (b === cur) {
    console.log(`  [当前分支，跳过] ${b}`);
    continue;
  }
  if (ahead === 0) {
    console.log(`  [可删·无独有提交] ${b}`);
    if (APPLY) git(['branch', '-D', b]);
  } else {
    console.log(`  [保留·有 ${ahead} 条独有提交，需人工确认] ${b}`);
    console.log(git(['log', '--oneline', `${mainBranch}..${b}`]).split('\n').map((l) => '      ' + l).join('\n'));
  }
}

// ---------- 2. Redis 项目记录 + tmp 目录 ----------
const redis = new Redis(REDIS);
const projectKeys = (await redis.keys('project:*')).filter((k) => !k.includes(':memory') && !k.includes(':deleted'));
console.log('\n=== 项目记录 workspace 落点 ===');
const nested = [];
for (const k of projectKeys) {
  const raw = await redis.get(k);
  if (!raw) continue;
  let p;
  try { p = JSON.parse(raw); } catch { continue; }
  const ws = (p.workspace || '').replace(/\\/g, '/');
  const inside = ws === ROOT.replace(/\\/g, '/') || ws.startsWith(ROOT.replace(/\\/g, '/') + '/');
  const isTmp = /\/tmp-[^/]+$/.test(ws);
  console.log(`  ${inside ? '[在 co-team 树内]' : '[ok]'} ${p.id} ${p.name} → ${p.workspace}${isTmp ? ' ← tmp 演示目录' : ''}`);
  if (inside && isTmp) nested.push({ key: k, id: p.id, ws: p.workspace });
}

console.log('\n=== 仓库根下 tmp-* 目录 ===');
const tmpDirs = fs.readdirSync(ROOT).filter((d) => d.startsWith('tmp-') && fs.statSync(path.join(ROOT, d)).isDirectory());
for (const d of tmpDirs) console.log(`  ${d}/`);

if (APPLY) {
  for (const n of nested) {
    await redis.del(n.key, `project:${n.id}:memory`, `project:${n.id}:deleted`);
    console.log(`  [已删项目记录] ${n.id}`);
  }
  for (const d of tmpDirs) {
    fs.rmSync(path.join(ROOT, d), { recursive: true, force: true });
    console.log(`  [已删目录] ${d}/`);
  }
}

// ---------- 3. 外部项目仓库 HEAD 报告 ----------
console.log('\n=== 外部项目仓库 HEAD 检查（启动清扫会自动处理，此处仅报告）===');
for (const k of projectKeys) {
  const raw = await redis.get(k);
  if (!raw) continue;
  let p;
  try { p = JSON.parse(raw); } catch { continue; }
  const ws = p.workspace;
  if (!ws || !fs.existsSync(path.join(ws, '.git')) || ws.startsWith(ROOT)) continue;
  try {
    const head = git(['rev-parse', '--abbrev-ref', 'HEAD'], ws);
    if (head.startsWith('coteam/task-')) console.log(`  [HEAD 停在任务分支] ${p.name}: ${head}`);
  } catch { /* ignore */ }
}

await redis.quit();
console.log(`\n${APPLY ? '✅ 已执行清理' : 'ℹ️ dry-run 完成——确认无误后加 --apply 执行'}`);
