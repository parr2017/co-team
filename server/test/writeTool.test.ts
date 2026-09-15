import { describe, it, expect, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { applyToolCalls, applyFinalOutput } from '../src/tools';
import { policyFromConfig } from '../src/sandbox';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'coteam-writetool-'));
afterAll(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* windows EBUSY 抖动容忍 */ } });

describe('轮内 write_file/edit_file 渐进落盘', () => {
  it('write_file 写入文件并返回相对路径与字节数', async () => {
    const results = await applyToolCalls(tmp, [{ tool: 'write_file', path: 'src/hello.py', content: 'print("hi")\n' }]);
    expect(results[0]).toMatchObject({ tool: 'write_file', ok: true, path: 'src/hello.py' });
    expect(fs.readFileSync(path.join(tmp, 'src/hello.py'), 'utf-8')).toBe('print("hi")\n');
  });

  it('write_file 拒绝越界路径（目录监狱）', async () => {
    const results = await applyToolCalls(tmp, [{ tool: 'write_file', path: '../escape.txt', content: 'x' }]);
    expect(results[0]).toMatchObject({ tool: 'write_file', ok: false });
  });

  it('edit_file 按 find/replace 修改已有文件；find 不命中报软错误', async () => {
    fs.writeFileSync(path.join(tmp, 'app.py'), 'value = 1\n', 'utf-8');
    const ok = await applyToolCalls(tmp, [{ tool: 'edit_file', path: 'app.py', find: 'value = 1', replace: 'value = 2' }]);
    expect(ok[0]).toMatchObject({ tool: 'edit_file', ok: true, path: 'app.py' });
    expect(fs.readFileSync(path.join(tmp, 'app.py'), 'utf-8')).toBe('value = 2\n');

    const miss = await applyToolCalls(tmp, [{ tool: 'edit_file', path: 'app.py', find: 'not-exist', replace: 'x' }]);
    expect(miss[0]).toMatchObject({ tool: 'edit_file', ok: false });
  });

  it('write_file 落盘后最终 JSON files 留空不报错、无 unreported 标记', async () => {
    await applyToolCalls(tmp, [{ tool: 'write_file', path: 'a.txt', content: 'A' }]);
    const out = applyFinalOutput(tmp, { status: 'success', summary: 's', verification: 'v', files: [], changes: ['a.txt: 轮内落盘'] }, policyFromConfig({ level: 'full' }));
    // files 留空 → applyFinalOutput 不写任何文件；申报 changes 覆盖磁盘事实 → 无 unreported_files
    expect(out.unreported_files).toBeUndefined();
    expect(out.changes).toContain('a.txt: 轮内落盘');
    expect(fs.readFileSync(path.join(tmp, 'a.txt'), 'utf-8')).toBe('A');
  });
});
