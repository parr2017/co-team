import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { readPermissions, savePermissions } from '../src/configStore';

// 包 D（2026-09-16）：全局命令权限落盘回环——设置界面保存 → config.yaml → 读回
describe('configStore permissions round-trip', () => {
  it('save → read round-trips level/whitelist/max_time_sec; missing node reads empty', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-perm-'));
    try {
      // 无 config.yaml：读回空 level + 空白名单
      const empty = readPermissions(root);
      expect(empty.level).toBe('');
      expect(empty.whitelist_commands).toEqual([]);

      savePermissions({ level: 'whitelist_auto', whitelist_commands: ['node', 'git', 'python'], max_time_sec: 120 }, root);
      const saved = readPermissions(root);
      expect(saved.level).toBe('whitelist_auto');
      expect(saved.whitelist_commands).toEqual(['node', 'git', 'python']);
      expect(saved.max_time_sec).toBe(120);

      // 二次保存覆盖（不残留旧键）
      savePermissions({ level: 'approve_required', whitelist_commands: ['node'] }, root);
      const updated = readPermissions(root);
      expect(updated.level).toBe('approve_required');
      expect(updated.whitelist_commands).toEqual(['node']);
      expect(updated.max_time_sec).toBeUndefined();
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
