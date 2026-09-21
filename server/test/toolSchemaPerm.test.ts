import { describe, expect, it } from 'vitest';
import { buildConvoTools } from '../src/toolSchema';

// C：plan_only/readonly 不暴露会被权限直接拒绝的工具，避免模型反复尝试空转、白耗迭代。
describe('buildConvoTools 权限过滤（C）', () => {
  const names = (level?: string): string[] =>
    buildConvoTools({ agentId: 'partner', execTimeoutSec: 180, level }).map(
      (t) => String((t as { function?: { name?: string } }).function?.name || ''),
    );

  it('plan_only：剔除 exec/exec_background/kill_process/write_file/edit_file，保留只读工具', () => {
    const n = names('plan_only');
    for (const blocked of ['exec', 'exec_background', 'kill_process', 'write_file', 'edit_file']) {
      expect(n).not.toContain(blocked);
    }
    for (const kept of ['read_file', 'grep', 'list_files', 'write_knowledge', 'ask_user']) {
      expect(n).toContain(kept);
    }
  });

  it('readonly：剔除 write_file/edit_file，但保留 exec（白名单命令可跑）', () => {
    const n = names('readonly');
    expect(n).not.toContain('write_file');
    expect(n).not.toContain('edit_file');
    expect(n).toContain('exec');
  });

  it('full / 未指定：全部工具可用', () => {
    const n = names('full');
    for (const t of ['exec', 'exec_background', 'kill_process', 'write_file', 'edit_file']) {
      expect(n).toContain(t);
    }
    expect(names(undefined)).toContain('exec');
  });
});
