import * as fs from 'node:fs';
import * as path from 'node:path';

export interface TestFailure {
  name: string;
  message: string;
  stack?: string;
}

export interface ParsedTestOutput {
  framework: 'vitest' | 'jest' | 'pytest' | 'js' | 'unknown';
  passed: boolean;
  failures: TestFailure[];
  summary: string;
  /** E8: false when the output carries no parseable structured result —
   *  crashed command / "no tests collected" / runner banner absent. */
  parseOk: boolean;
}

/** E9: wrong-stack test run — pytest/python inside a Node workspace can never
 *  exercise the JS code, so its failures are noise, not repair input. */
export function detectStackMismatch(command: string, workspace: string): boolean {
  if (!/(^|[\s/])(pytest|python3?|pip3?)(\s|$)/.test(command || '')) return false;
  const hasNode = fs.existsSync(path.join(workspace, 'package.json'));
  const hasPy = fs.existsSync(path.join(workspace, 'pyproject.toml'))
    || fs.existsSync(path.join(workspace, 'requirements.txt'))
    || fs.existsSync(path.join(workspace, 'setup.py'));
  return hasNode && !hasPy;
}

const TEST_COMMAND_PATTERN =
  /^\s*(npm (run )?test|npx (vitest|jest)|yarn (test|vitest|jest)|pnpm (test|vitest|jest)|pytest|python -m pytest|python3 -m pytest|vitest|jest|go test|cargo test|node (--test|--experimental-test)\b)/;

export function isTestCommand(command: string): boolean {
  return TEST_COMMAND_PATTERN.test(command || '');
}

/** Identify a failed test run inside a node's command results. */
export function findTestFailure(commandResults: { command: string; returncode: number; stderr: string; stdout?: string }[] | undefined): { command: string; output: string } | null {
  for (const r of commandResults || []) {
    if (r.returncode !== 0 && isTestCommand(r.command)) {
      return { command: r.command, output: `${r.stderr || ''}\n${r.stdout || ''}`.trim() };
    }
  }
  return null;
}

/**
 * Parse test output (improvement 8): extracts failed cases, messages and stacks for
 * pytest / vitest / jest / generic runners.
 */
export function parseTestOutput(output: string, hint?: string): ParsedTestOutput {
  const text = (output || '').slice(-8000);
  const failures: TestFailure[] = [];

  const looksPytest = hint === 'pytest' || /={3,}\s*(FAILURES|short test summary info)\s*={3,}|FAILED\s+tests?[/\\]/i.test(text) || /_{5,}\s+\w+\s+_{5,}/.test(text) && /assert|Error/i.test(text);
  const looksJs = hint === 'vitest' || hint === 'jest' || /FAIL\s+\S+\s\(/.test(text) || /(✕|×|FAIL)\s/i.test(text) || /Tests:\s+\d+\s+failed/i.test(text);

  if (looksPytest) {
    // FAILED tests/test_x.py::test_y - AssertionError: msg
    const re = /FAILED\s+(\S+)::(\S+?)\s*-\s*(.+)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
      failures.push({ name: `${m[1]}::${m[2]}`, message: m[3].slice(0, 300), stack: extractPytestStack(text, m[2]) });
    }
    if (!failures.length) {
      const re2 = /_{5,}\s+([\w./\\-]+?)\s+_{5,}[\s\S]{0,600}?(?:E\s+\w*(?:Error|Exception)[^\n]*)/g;
      while ((m = re2.exec(text))) {
        failures.push({ name: m[1], message: (m[0].match(/E\s+.*/)?.[0] || 'assertion failed').slice(0, 300), stack: m[0].slice(0, 600) });
      }
    }
    const pytestSummary = summarize(text);
    return { framework: 'pytest', passed: failures.length === 0, failures: dedupe(failures).slice(0, 10), summary: pytestSummary || `${failures.length} 个 pytest 用例失败`, parseOk: pytestSummary !== '' || failures.length > 0 };
  }

  if (looksJs) {
    // vitest/jest: line-based extraction — "FAIL file ( n tests )" / "✕ case name 12 ms"
    for (const line of text.split('\n')) {
      const m = line.match(/^\s*(?:✕|×|FAIL)\s+(.+?)\s*(?:\(\s*\d+[^)]*\))?\s*(?:\d+(?:\.\d+)?\s*(?:ms|s)\s*)?$/i);
      if (!m) continue;
      const name = m[1].trim();
      if (!name || name.length < 3) continue;
      failures.push({ name: name.slice(0, 200), message: extractJsMessage(text, name) });
    }
    const jsSummary = summarize(text);
    return { framework: 'js', passed: failures.length === 0, failures: dedupe(failures).slice(0, 10), summary: jsSummary || `${failures.length} 个用例失败`, parseOk: jsSummary !== '' || failures.length > 0 };
  }

  const rawSummary = summarize(text);
  return { framework: 'unknown', passed: false, failures: [], summary: rawSummary || '测试命令执行失败', parseOk: rawSummary !== '' };
}

function dedupe(failures: TestFailure[]): TestFailure[] {
  const seen = new Set<string>();
  return failures.filter((f) => (seen.has(f.name) ? false : (seen.add(f.name), true)));
}

function summarize(text: string): string {
  const m = text.match(/Tests:\s+(.*)/i)?.[1] || text.match(/=\+\s*(.*?)\s*\+=/)?.[1] || text.match(/(\d+ passed[^\n]*)/i)?.[1];
  return m ? m.trim().slice(0, 200) : '';
}

function extractJsMessage(text: string, name: string): string {
  const idx = text.indexOf(name);
  if (idx === -1) return '';
  const after = text.slice(idx, idx + 800);
  const errLine = after.match(/((?:AssertionError|Error|Expect\w*|TypeError|ReferenceError)[^\n]{0,250})/)?.[1];
  return errLine || after.split('\n').slice(1, 4).join(' ').trim().slice(0, 250);
}

function extractPytestStack(text: string, caseName: string): string | undefined {
  const idx = text.indexOf(caseName);
  if (idx === -1) return undefined;
  const block = text.slice(Math.max(0, idx - 1500), idx + 400);
  const eLines = block.split('\n').filter((l) => /^E\s+/.test(l) || /Error|assert/.test(l)).slice(-8);
  return eLines.length ? eLines.join('\n').slice(0, 600) : undefined;
}

const MAX_FIX_ROUNDS = 3;

/** Build a targeted fix prompt from parsed failures (fed to the repair agent).
 *  E8: pass rawOutput when no failure case could be parsed — the model then sees
 *  the unfiltered tail (crash stack / "no tests collected") instead of nothing. */
export function buildFixPrompt(parsed: ParsedTestOutput, command: string, round: number, maxRounds = MAX_FIX_ROUNDS, rawOutput?: string): string {
  const lines = [
    `自动化测试修复循环（第 ${round}/${maxRounds} 轮）：测试命令「${command}」失败，请根据以下失败信息修复代码后重新验证。`,
    '',
    `测试框架: ${parsed.framework}`,
    `失败用例数: ${parsed.failures.length}`,
  ];
  for (const f of parsed.failures.slice(0, 5)) {
    lines.push(`- 用例: ${f.name}`, `  错误: ${f.message}`);
    if (f.stack) lines.push(`  堆栈: ${f.stack.split('\n').slice(0, 6).join('\n  ')}`);
  }
  if (!parsed.failures.length) {
    lines.push(`输出摘要: ${parsed.summary}`);
    if (rawOutput) lines.push('原始输出（截断，真实错误通常在末尾）:', rawOutput.slice(-2000));
  }
  lines.push('', '请定位根因并修复（优先修改被测代码而非删除测试；确属测试过时才可调整测试；若输出显示命令本身崩溃或未收集到用例，先修测试环境/命令而非业务代码）。');
  return lines.join('\n');
}

export { MAX_FIX_ROUNDS };
