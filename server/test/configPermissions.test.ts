import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * B9（2026-09-17）：permissions.level 非法值启动校验——手改 config.yaml 写错时
 * 加载即告警并置空（不再静默穿透到 policyFromConfig 的隐式回退）。
 */
import { loadConfig } from '../src/config';

let tmp: string;
let warnSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-cfg-'));
  fs.mkdirSync(path.join(tmp, 'config'), { recursive: true });
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  warnSpy.mockRestore();
  fs.rmSync(tmp, { recursive: true, force: true });
});

function writeConfig(yamlText: string): void {
  fs.writeFileSync(path.join(tmp, 'config', 'config.yaml'), yamlText, 'utf-8');
}

describe('config permissions.level 校验（B9）', () => {
  it('非法 level → console.warn 且被置空（不透传给运行时）', () => {
    writeConfig('permissions:\n  level: normal\n  whitelist_commands:\n    - python\n');
    const cfg = loadConfig(tmp);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(String(warnSpy.mock.calls[0][0])).toContain('normal');
    expect(String(warnSpy.mock.calls[0][0])).toContain('whitelist_auto');
    expect((cfg.permissions as any).level).toBeUndefined();
    expect((cfg.permissions as any).whitelist_commands).toEqual(['python']);
  });

  it('合法 level 原样保留，不告警', () => {
    writeConfig('permissions:\n  level: approve_required\n');
    const cfg = loadConfig(tmp);
    expect(warnSpy).not.toHaveBeenCalled();
    expect((cfg.permissions as any).level).toBe('approve_required');
  });

  it('五档合法值全部放行', () => {
    for (const lvl of ['plan_only', 'readonly', 'approve_required', 'whitelist_auto', 'full']) {
      warnSpy.mockClear();
      writeConfig(`permissions:\n  level: ${lvl}\n`);
      const cfg = loadConfig(tmp);
      expect(warnSpy).not.toHaveBeenCalled();
      expect((cfg.permissions as any).level).toBe(lvl);
    }
  });
});
