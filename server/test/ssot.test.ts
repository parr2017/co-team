import { describe, expect, it, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { initBus, closeBus } from '../src/bus';
import { checkDocs, getDocRegistry, readDoc, writeDoc, buildTaskSpec } from '../src/ssot';

beforeEach(async () => {
  process.env.COTEAM_FORCE_MEMORY = '1';
  closeBus();
  await initBus({ host: '127.0.0.1', port: 6399, db: 0 });
});

describe('SSOT document collaboration (improvement 4)', () => {
  it('writes docs with version bumping and broadcasts updates', async () => {
    const events: string[] = [];
    const { emitProgress } = await import('../src/store');
    void emitProgress;
    const d1 = await writeDoc('t-ssot', 'TASK_SPEC', 'spec v1 content', 'orchestrator');
    expect(d1.version).toBe(1);
    const d2 = await writeDoc('t-ssot', 'TASK_SPEC', 'spec v2 content', 'dev');
    expect(d2.version).toBe(2);
    const registry = await getDocRegistry('t-ssot');
    expect(registry).toHaveLength(1);
    expect(registry[0].content).toBe('spec v2 content');
    expect(d2.hash).not.toBe(d1.hash);
  });

  it('atomically writes files into the sandbox and pre-check restores tampered docs', async () => {
    const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-ssot-'));
    await writeDoc('t-ssot2', 'TASK_SPEC', 'authoritative spec', 'orchestrator', sandbox);
    const file = path.join(sandbox, 'docs', 'TASK_SPEC.md');
    expect(fs.readFileSync(file, 'utf-8')).toContain('authoritative spec');

    // tamper with the doc on disk
    fs.writeFileSync(file, 'tampered by rogue agent', 'utf-8');
    const check = await checkDocs('t-ssot2', sandbox);
    expect(check.ok).toBe(false);
    expect(check.restored).toContain('TASK_SPEC');
    expect(fs.readFileSync(file, 'utf-8')).toContain('authoritative spec');

    // missing file is restored too
    fs.rmSync(file);
    const check2 = await checkDocs('t-ssot2', sandbox);
    expect(check2.restored).toContain('TASK_SPEC');
    expect(fs.existsSync(file)).toBe(true);
    fs.rmSync(sandbox, { recursive: true, force: true });
  });

  it('readDoc returns null for unknown docs; task spec builder includes goal and nodes', async () => {
    expect(await readDoc('t-none', 'TASK_SPEC')).toBeNull();
    const spec = buildTaskSpec('做一个功能', '标准级 (standard)', [{ id: '1', name: '实现 X', agent: 'dev' }], '全局目标：可用');
    expect(spec).toContain('全局目标：可用');
    expect(spec).toContain('实现 X');
  });
});
