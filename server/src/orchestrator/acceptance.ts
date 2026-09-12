/**
 * 合并后全量验收（post-merge acceptance）——jr3gdkxq 质检的结构性补刀。
 *
 * 教训：分支工作流里每个节点只验证自己的切片（dataService 节点跑脚本全绿、页面节点
 * "走查通过"），但"页面默认导入 vs 服务具名导出"这类**跨节点接口断裂**只有在合并后的
 * 完整代码上实际运行才会暴露。本模块在产物同步回真实工作区后、任务判成功前，
 * 强制跑一次项目自身的测试套件：测试不过 → 任务不得为 success。
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { executeCommandAsync, type PermissionPolicy } from '../sandbox';

export interface TestCommand {
  command: string;
  kind: 'npm' | 'pytest';
}

/** 探测项目测试入口：package.json scripts.test 优先，其次 pytest 标记 */
export function detectTestCommand(workspace: string): TestCommand | null {
  try {
    const pkgPath = path.join(workspace, 'package.json');
    if (fs.existsSync(pkgPath)) {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
      if (pkg && pkg.scripts && typeof pkg.scripts.test === 'string' && pkg.scripts.test.trim()) {
        return { command: 'npm test', kind: 'npm' };
      }
    }
  } catch { /* malformed package.json → fall through */ }
  try {
    const markers = ['pytest.ini', 'conftest.py', 'setup.cfg', 'tox.ini'];
    let py = markers.some((m) => fs.existsSync(path.join(workspace, m)));
    if (!py) {
      const pyproj = path.join(workspace, 'pyproject.toml');
      if (fs.existsSync(pyproj)) py = fs.readFileSync(pyproj, 'utf-8').includes('[tool.pytest');
    }
    if (!py && fs.existsSync(path.join(workspace, 'tests'))) {
      py = fs.readdirSync(path.join(workspace, 'tests')).some((f) => /^test_.*\.py$/.test(f) || /_test\.py$/.test(f));
    }
    if (py) return { command: 'python -m pytest -q', kind: 'pytest' };
  } catch { /* best effort */ }
  return null;
}

export interface AcceptanceResult {
  status: 'passed' | 'failed' | 'no-test-command';
  command?: string;
  exitCode?: number;
  /** 输出尾部（进 result 与日志，作为可追溯证据） */
  tail: string;
}

/**
 * 在合并后的真实工作区跑项目测试套件。命令无路径参数，jail 天然通过；
 * 执行策略固定 full（这是系统验收行为，不受 agent 命令白名单约束，但受超时约束）。
 */
export async function runPostMergeAcceptance(workspace: string, timeoutSec = 240): Promise<AcceptanceResult> {
  const tc = detectTestCommand(workspace);
  if (!tc) return { status: 'no-test-command', tail: '未探测到测试命令（package.json scripts.test / pytest 标记均无）——合并后无全量验证证据' };
  const policy: PermissionPolicy = { level: 'full', whitelistCommands: null, maxTimeSec: timeoutSec };
  try {
    const r = await executeCommandAsync(tc.command, workspace, policy, timeoutSec);
    const tail = (r.stdout + (r.stdout && r.stderr ? '\n' : '') + r.stderr).slice(-1500);
    return {
      status: r.returncode === 0 ? 'passed' : 'failed',
      command: tc.command,
      exitCode: r.returncode,
      tail,
    };
  } catch (e: any) {
    return { status: 'failed', command: tc.command, exitCode: -1, tail: String(e?.message || e).slice(0, 500) };
  }
}

// ---------- M5 验收体系：平台探测 + 清单机审 + E2E runner ----------

import type { ChecklistItem } from '../types';

export interface ProjectProfile {
  /** 声明的交付端集合 */
  platforms: string[];
  testCommand: TestCommand | null;
  buildCommand: string | null;
  /** playwright 可用（依赖装好且 tests/e2e 有脚本） */
  e2e: { runnable: boolean; note: string };
}

/** 平台探测：从项目画像（package.json / manifest.json）判定交付端集合与测试手段矩阵 */
export function detectProjectProfile(workspace: string): ProjectProfile {
  const platforms = new Set<string>();
  let testCommand: TestCommand | null = null;
  let buildCommand: string | null = null;
  let uniApp = false;
  let deps: Record<string, string> = {};
  let scripts: Record<string, string> = {};
  let bin = false;
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(workspace, 'package.json'), 'utf-8'));
    deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
    scripts = pkg.scripts || {};
    bin = !!pkg.bin;
    if (deps['vue'] || deps['react'] || deps['vite'] || deps['next'] || scripts.build) platforms.add('web');
    if (deps['express'] || deps['koa'] || deps['fastify'] || deps['@nestjs/core'] || deps['hono']) platforms.add('api');
    if ((pkg.main || pkg.module || pkg.exports) && !scripts.build) platforms.add('library');
  } catch { /* 非 node 项目 */ }
  try {
    const manifestPath = path.join(workspace, 'src', 'manifest.json');
    const manifestRaw = fs.existsSync(manifestPath) ? fs.readFileSync(manifestPath, 'utf-8') : '';
    if (deps['@dcloudio/uni-app'] || deps['@dcloudio/vite-plugin-uni'] || manifestRaw) {
      uniApp = true;
      let manifest: any = {};
      try { manifest = JSON.parse(manifestRaw); } catch { /* 容忍半成品 */ }
      if (manifest['app-plus'] || manifest.app) platforms.add('app');
      if (manifest['mp-weixin']) platforms.add('miniprogram');
      if (manifest.h5 || !manifest['mp-weixin']) platforms.add('h5');
    }
  } catch { /* best effort */ }
  if (uniApp) platforms.delete('library');
  if (bin) platforms.add('cli');
  if (platforms.size === 0) platforms.add('web');

  testCommand = detectTestCommand(workspace);
  if (scripts.build) buildCommand = 'npm run build';
  else if (scripts['build:h5']) buildCommand = 'npm run build:h5';

  const e2eDir = fs.existsSync(path.join(workspace, 'tests', 'e2e')) || fs.existsSync(path.join(workspace, 'e2e')) || fs.existsSync(path.join(workspace, 'playwright.config.ts'));
  const playwrightInstalled = !!deps['@playwright/test'] || !!deps['playwright'];
  const e2e = playwrightInstalled && e2eDir
    ? { runnable: true, note: 'playwright 就绪' }
    : { runnable: false, note: !e2eDir ? 'tests/e2e 无 E2E 脚本' : 'playwright 未安装（需在项目 devDependencies 安装 @playwright/test）' };
  return { platforms: [...platforms], testCommand, buildCommand, e2e };
}

export interface ChecklistAuditItem extends ChecklistItem {
  /** 机审证据（命令+退出码/输出尾），无法机审时为降级说明 */
  audit_note?: string;
  machine: boolean;
}

/** 清单机审：build/unit/e2e 三类用真实命令产出证据；command/manual 留给人工裁决。
 *  铁律：每项只有"执行且附机器证据"或"显式降级留痕"两种终态，绝不静默跳过。 */
export async function runChecklistAudit(workspace: string, checklist: ChecklistItem[], timeoutSec = 240): Promise<{ items: ChecklistAuditItem[]; ranAny: boolean }> {
  const profile = detectProjectProfile(workspace);
  const items: ChecklistAuditItem[] = [];
  let ranAny = false;
  for (const item of checklist) {
    const base: ChecklistAuditItem = { ...item, status: item.status ?? 'open', machine: false };
    if (item.evidence_type === 'build') {
      if (profile.buildCommand) {
        const r = await runCommand(profile.buildCommand, workspace, timeoutSec);
        ranAny = true;
        items.push({ ...base, machine: true, status: r.exitCode === 0 ? 'done' : 'failed', evidence: `${profile.buildCommand} exit ${r.exitCode}`, audit_note: r.tail });
      } else {
        items.push({ ...base, status: 'open', audit_note: '降级留痕：项目无 build 命令，构建闸无法机审' });
      }
    } else if (item.evidence_type === 'unit') {
      if (profile.testCommand) {
        const r = await runCommand(profile.testCommand.command, workspace, timeoutSec);
        ranAny = true;
        items.push({ ...base, machine: true, status: r.exitCode === 0 ? 'done' : 'failed', evidence: `${profile.testCommand.command} exit ${r.exitCode}`, audit_note: r.tail });
      } else {
        items.push({ ...base, status: 'open', audit_note: '降级留痕：项目无测试命令，单测闸无法机审（no-test-command 不放行）' });
      }
    } else if (item.evidence_type === 'e2e') {
      if (profile.e2e.runnable) {
        const r = await runCommand('npx playwright test --reporter=line', workspace, Math.max(timeoutSec, 300));
        ranAny = true;
        items.push({ ...base, machine: true, status: r.exitCode === 0 ? 'done' : 'failed', evidence: `npx playwright test exit ${r.exitCode}`, audit_note: r.tail });
      } else {
        items.push({ ...base, status: 'open', audit_note: `降级留痕：E2E 未就绪（${profile.e2e.note}）——需人工实拍验证或补 E2E 脚本` });
      }
    } else {
      // command / manual：机器无法验证 → 保持 open，交给人工裁决（绝不静默放行）
      items.push(base);
    }
  }
  return { items, ranAny };
}

async function runCommand(command: string, cwd: string, timeoutSec: number): Promise<{ exitCode: number; tail: string }> {
  const policy: PermissionPolicy = { level: 'full', whitelistCommands: null, maxTimeSec: timeoutSec };
  try {
    const r = await executeCommandAsync(command, cwd, policy, timeoutSec);
    const tail = (r.stdout + (r.stdout && r.stderr ? '\n' : '') + r.stderr).slice(-1000);
    return { exitCode: r.returncode, tail };
  } catch (e: any) {
    return { exitCode: -1, tail: String(e?.message || e).slice(0, 500) };
  }
}
