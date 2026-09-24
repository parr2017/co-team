import { describe, expect, it } from 'vitest';
import { buildConvoTools, buildOrchTools } from '../src/toolSchema';

const names = (t: unknown[]): string[] => t.map((x) => String((x as { function?: { name?: string } }).function?.name || ''));

// C：plan_only/readonly 不暴露会被权限直接拒绝的工具，避免模型反复尝试空转、白耗迭代。
describe('buildConvoTools 权限过滤（C）', () => {
  const convoNames = (level?: string): string[] =>
    names(buildConvoTools({ agentId: 'partner', execTimeoutSec: 180, level }));

  it('plan_only：剔除 exec/exec_background/kill_process/write_file/edit_file，保留只读工具', () => {
    const n = convoNames('plan_only');
    for (const blocked of ['exec', 'exec_background', 'kill_process', 'write_file', 'edit_file']) {
      expect(n).not.toContain(blocked);
    }
    for (const kept of ['read_file', 'grep', 'list_files', 'write_knowledge', 'ask_user']) {
      expect(n).toContain(kept);
    }
  });

  it('readonly：剔除 write_file/edit_file，但保留 exec（白名单命令可跑）', () => {
    const n = convoNames('readonly');
    expect(n).not.toContain('write_file');
    expect(n).not.toContain('edit_file');
    expect(n).toContain('exec');
  });

  it('full / 未指定：全部工具可用', () => {
    const n = convoNames('full');
    for (const t of ['exec', 'exec_background', 'kill_process', 'write_file', 'edit_file']) {
      expect(n).toContain(t);
    }
    expect(convoNames(undefined)).toContain('exec');
  });
});

// 2026-09-23 回归（learn-english 任务 s2-1 失败实证）：任务管线（orchestrator）的 FC 工具表
// 曾不含 exec/exec_background/kill_process——test agent 拿不到 shell，只能申报"本沙箱没有
// exec/run_command/bash"，验证节点无法跑 flutter analyze/test，整任务停在合法阻塞。
describe('buildOrchTools 命令执行工具（回归）', () => {
  const orchNames = (level?: string): string[] =>
    names(buildOrchTools({ agent: 'test', execTimeoutSec: 180, level }));

  it('默认（未指定 level）：必须有 exec/exec_background/kill_process', () => {
    const n = orchNames();
    for (const t of ['exec', 'exec_background', 'kill_process', 'write_file', 'edit_file']) {
      expect(n).toContain(t);
    }
  });

  it('六档权限下 exec 可用性：plan_only 剔除，其余保留', () => {
    expect(orchNames('plan_only')).not.toContain('exec');
    for (const lv of ['readonly', 'approve_required', 'whitelist_auto', 'full', 'unrestricted']) {
      expect(orchNames(lv), lv).toContain('exec');
    }
  });

  it('plan_only：剔除 exec/write 类，保留只读与文档类工具', () => {
    const n = orchNames('plan_only');
    for (const blocked of ['exec', 'exec_background', 'kill_process', 'write_file', 'edit_file']) {
      expect(n).not.toContain(blocked);
    }
    for (const kept of ['list_files', 'read_file', 'grep', 'write_doc', 'send_message', 'ask_user']) {
      expect(n).toContain(kept);
    }
  });

  it('readonly：剔除 write_file/edit_file，保留 exec（与协作会话同语义）', () => {
    const n = orchNames('readonly');
    expect(n).not.toContain('write_file');
    expect(n).not.toContain('edit_file');
    expect(n).toContain('exec');
  });

  it('exec 描述透传超时预算（≤{execTimeoutSec}s）', () => {
    const spec = buildOrchTools({ agent: 'test', execTimeoutSec: 42 }).find(
      (t) => String((t as { function?: { name?: string } }).function?.name) === 'exec',
    ) as { function: { description: string } };
    expect(spec.function.description).toContain('≤42s');
  });
});
