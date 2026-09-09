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
