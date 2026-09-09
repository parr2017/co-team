import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as http from 'node:http';
import { detectTestCommand, runPostMergeAcceptance } from '../src/orchestrator/acceptance';
import { checkPage, findHeadlessBrowser } from '../src/tools';

function mkProject(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-acc-'));
  for (const [rel, content] of Object.entries(files)) {
    const p = path.join(dir, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content, 'utf-8');
  }
  return dir;
}

describe('detectTestCommand', () => {
  it('无测试标记 → null', () => {
    const dir = mkProject({ 'readme.md': 'x' });
    expect(detectTestCommand(dir)).toBeNull();
  });

  it('package.json scripts.test → npm test', () => {
    const dir = mkProject({ 'package.json': JSON.stringify({ scripts: { test: 'node -e 0' } }) });
    expect(detectTestCommand(dir)).toEqual({ command: 'npm test', kind: 'npm' });
  });

  it('scripts.test 为空串不算', () => {
    const dir = mkProject({ 'package.json': JSON.stringify({ scripts: { test: '  ' } }) });
    expect(detectTestCommand(dir)).toBeNull();
  });

  it('pytest.ini → python -m pytest -q', () => {
    const dir = mkProject({ 'pytest.ini': '[pytest]' });
    expect(detectTestCommand(dir)).toEqual({ command: 'python -m pytest -q', kind: 'pytest' });
  });

  it('tests/test_*.py 也算 pytest 标记', () => {
    const dir = mkProject({ 'tests/test_a.py': 'def test_a():\n    assert True\n' });
    expect(detectTestCommand(dir)?.kind).toBe('pytest');
  });
});

describe('runPostMergeAcceptance', () => {
  it('测试通过 → passed（真实执行 npm test）', async () => {
    const dir = mkProject({ 'package.json': JSON.stringify({ name: 'acc-ok', scripts: { test: 'node -e "console.log(1)"' } }) });
    const r = await runPostMergeAcceptance(dir, 120);
    expect(r.status).toBe('passed');
    expect(r.command).toBe('npm test');
    expect(r.exitCode).toBe(0);
  }, 180_000);

  it('测试失败 → failed 且带输出尾部证据', async () => {
    const dir = mkProject({ 'package.json': JSON.stringify({ name: 'acc-bad', scripts: { test: 'node -e "console.error(boom);process.exit(3)"' } }) });
    const r = await runPostMergeAcceptance(dir, 120);
    expect(r.status).toBe('failed');
    // npm 在 Windows 下会把子进程退出码归一为 1，只断言非零
    expect(r.exitCode).toBeGreaterThan(0);
    expect(r.tail).toContain('boom');
  }, 180_000);

  it('无测试命令 → no-test-command（不判失败但留痕）', async () => {
    const dir = mkProject({ 'readme.md': 'x' });
    const r = await runPostMergeAcceptance(dir);
    expect(r.status).toBe('no-test-command');
    expect(r.tail).toContain('未探测到');
  });
});

describe('checkPage', () => {
  it('非 localhost / 非法 URL / 非 http 一律拒绝', async () => {
    expect((await checkPage('not a url')).ok).toBe(false);
    expect((await checkPage('http://example.com/')).error).toContain('localhost');
    expect((await checkPage('file:///etc/passwd')).ok).toBe(false);
  });

  it('headless 浏览器渲染 JS 注入的文本，expect 命中/缺失判定正确', async () => {
    const browser = findHeadlessBrowser();
    if (!browser) { console.warn('本机无 Chrome/Edge，跳过真实渲染用例'); return; }
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('<html><head><title>记账</title></head><body><div id="a"></div><script>document.getElementById("a").textContent = "环形图渲染成功 25.50";</script></body></html>');
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as { port: number }).port;
    try {
      const hit = await checkPage(`http://127.0.0.1:${port}/`, ['环形图渲染成功', '25.50'], 40);
      expect(hit.ok).toBe(true);
      expect(hit.title).toBe('记账');
      expect(hit.missing).toEqual([]);
      const miss = await checkPage(`http://127.0.0.1:${port}/`, ['不存在的文本XYZ'], 40);
      expect(miss.ok).toBe(false);
      expect(miss.missing).toEqual(['不存在的文本XYZ']);
    } finally {
      server.close();
    }
  }, 120_000);
});
