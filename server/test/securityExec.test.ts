import { describe, expect, it } from 'vitest';
import { classifyCommand, canExecuteChain, splitChained } from '../src/commandGuard';
import { assertWithinJail } from '../src/workspace';
import { applyFinalOutput } from '../src/tools';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

describe('SEC-P0 classifyCommand 高危形态', () => {
  it('解释器内联代码命中（python -c / node -e / powershell -Command）', () => {
    expect(classifyCommand('python -c "import os; os.system(\'whoami\')"').sensitive).toBe(true);
    expect(classifyCommand('node -e "require(\'fs\').rmSync(\'C:/x\',{recursive:true})"').sensitive).toBe(true);
    expect(classifyCommand('powershell -Command "Remove-Item C:/x"').sensitive).toBe(true);
    expect(classifyCommand('powershell -EncodedCommand AAAA').sensitive).toBe(true);
  });

  it('日常解释器形态放行（python script.py / npm run dev）', () => {
    expect(classifyCommand('python main.py').sensitive).toBe(false);
    expect(classifyCommand('npm run build').sensitive).toBe(false);
    expect(classifyCommand('node dist/index.js').sensitive).toBe(false);
  });

  it('pip install 装包命中；-r requirements 放行', () => {
    expect(classifyCommand('pip install requests').sensitive).toBe(true);
    expect(classifyCommand('pip install evil-pkg').reasons[0]).toContain('任意代码');
    expect(classifyCommand('pip install -r requirements.txt').sensitive).toBe(false);
  });

  it('git push / reset --hard / clean 命中；日常 git 放行', () => {
    expect(classifyCommand('git push origin main').sensitive).toBe(true);
    expect(classifyCommand('git reset --hard HEAD~1').sensitive).toBe(true);
    expect(classifyCommand('git clean -fd').sensitive).toBe(true);
    expect(classifyCommand('git log --oneline').sensitive).toBe(false);
    expect(classifyCommand('git status').sensitive).toBe(false);
  });

  it('删除类与系统级命令命中', () => {
    expect(classifyCommand('rm -rf build').sensitive).toBe(true);
    expect(classifyCommand('del x.txt').sensitive).toBe(true);
    expect(classifyCommand('rd /s /q tmp').sensitive).toBe(true);
    expect(classifyCommand('format D:').sensitive).toBe(true);
    expect(classifyCommand('shutdown /s').sensitive).toBe(true);
  });

  it('链式命令：任一段命中即整体 sensitive', () => {
    expect(classifyCommand('git log && python -c "x"').sensitive).toBe(true);
    expect(classifyCommand('echo a | del b').sensitive).toBe(true);
    expect(classifyCommand('python a.py && git status').sensitive).toBe(false);
  });

  it('splitChained 引号感知：管道符在引号内不切段', () => {
    expect(splitChained('python x.py --filter "a|b"')).toHaveLength(1);
    expect(splitChained('echo a && echo b')).toHaveLength(2);
  });
});

describe('SEC-P0 监狱环境变量逃逸', () => {
  const jail = 'D:\\proj';
  it('%VAR%\\x 与 $HOME/x 直接判违规', () => {
    expect(assertWithinJail('type %USERPROFILE%\\secret.txt', jail).ok).toBe(false);
    expect(assertWithinJail('cat $HOME/.ssh/id_rsa', jail).ok).toBe(false);
  });
  it('无路径语义的普通 token 不误伤', () => {
    expect(assertWithinJail('echo %PATH%', jail).ok).toBe(true);
    expect(assertWithinJail('python main.py', jail).ok).toBe(true);
  });
});

describe('SEC-P0 applyFinalOutput 敏感命令强制审批', () => {
  const mkWs = () => {
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-sec-'));
    fs.writeFileSync(path.join(ws, 'canary.txt'), 'keep me');
    return ws;
  };

  it('full 策略下可配置敏感命令直接执行（2026-09-19 放行决策），绝对禁止命令仍拦截', () => {
    const ws = mkWs();
    const out = applyFinalOutput(ws, { commands: ['del canary.txt', 'echo done'] }, { level: 'full', whitelistCommands: null, maxTimeSec: 10 });
    expect(fs.existsSync(path.join(ws, 'canary.txt'))).toBe(false); // 敏感命令已直接执行
    expect(out.pending_commands).toBeUndefined();
    const r = out.command_results.find((c: any) => c.command === 'del canary.txt');
    expect(r.returncode).toBe(0);
    expect(out.command_results.find((c: any) => c.command === 'echo done').returncode).toBe(0);
    fs.rmSync(ws, { recursive: true, force: true });
  });

  it('绝对禁止命令（strict）任何策略下都拦截——暂存待审批并带 sensitive 标', () => {
    const ws = mkWs();
    const out = applyFinalOutput(ws, { commands: ['schtasks /create /tn evil /tr cmd'] }, { level: 'full', whitelistCommands: null, maxTimeSec: 10 });
    expect(out.pending_commands).toEqual(['schtasks /create /tn evil /tr cmd']);
    expect(out.sensitive_commands).toEqual(['schtasks /create /tn evil /tr cmd']);
    const r = out.command_results.find((c: any) => c.command === 'schtasks /create /tn evil /tr cmd');
    expect(r.sensitive).toBe(true);
    expect(r.stderr).toContain('绝对禁止');
    fs.rmSync(ws, { recursive: true, force: true });
  });

  it('链式命令含白名单外片段 → 转待审批（不再借首词放行）', () => {
    const ws = mkWs();
    const policy = { level: 'approve_required' as const, whitelistCommands: ['git'], maxTimeSec: 10 };
    const out = applyFinalOutput(ws, { commands: ['git status && node -e "x"'] }, policy);
    const r = out.command_results[0];
    expect(r.needs_approval).toBe(true);
    fs.rmSync(ws, { recursive: true, force: true });
  });

  it('canExecuteChain：链式每段过白名单', () => {
    const policy = { level: 'whitelist_auto', whitelistCommands: ['git'] } as any;
    expect(canExecuteChain(policy, 'git status', (seg) => policy.whitelistCommands.includes(seg.trim().split(/\s+/)[0]))).toBe(true);
    expect(canExecuteChain(policy, 'git status && del x', (seg) => policy.whitelistCommands.includes(seg.trim().split(/\s+/)[0]))).toBe(false);
  });
});
