import { describe, expect, it } from 'vitest';
import * as os from 'node:os';
import * as path from 'node:path';
import { assertWithinJail, jailViolationMessage, isInside } from '../src/workspace';

const JAIL = path.resolve(os.tmpdir(), 'coteam-jail-test');

const check = (cmd: string) => assertWithinJail(cmd, JAIL);

describe('isInside', () => {
  it('parent itself counts as inside; siblings do not', () => {
    expect(isInside(JAIL, JAIL)).toBe(true);
    expect(isInside(JAIL, path.join(JAIL, 'a', 'b'))).toBe(true);
    expect(isInside(JAIL, path.resolve(JAIL, '..'))).toBe(false);
  });
});

describe('assertWithinJail', () => {
  it('allows relative paths and plain commands', () => {
    expect(check('cat README.md').ok).toBe(true);
    expect(check('npm run build').ok).toBe(true);
    expect(check('node build.js --out dist/app.js').ok).toBe(true);
    expect(check('echo hello > notes.txt').ok).toBe(true);
    expect(check('mkdir -p src/utils && touch src/utils/a.ts').ok).toBe(true);
  });

  it('rejects absolute paths outside the jail', () => {
    const r = check('cat D:\\pxx\\co-team\\AGENTS.md');
    expect(r.ok).toBe(false);
    expect(r.violations.join(' ')).toContain('co-team');
    expect(check('rm -rf C:\\Users\\someone\\docs').ok).toBe(false);
    expect(check('node server/dist/index.js').ok).toBe(true); // relative is fine
  });

  it('rejects .. escapes incl. bare cd ..', () => {
    expect(check('rm -rf ../outside').ok).toBe(false);
    expect(check('cd ..').ok).toBe(false);
    expect(check('cp ./a.txt ../../shared/b.txt').ok).toBe(false);
  });

  it('rejects absolute paths embedded in flag values', () => {
    expect(check('python launch.py --log-dir=D:\\elsewhere\\logs').ok).toBe(false);
    expect(check('git -C /home/other/repo status').ok).toBe(false);
  });

  it('skips URLs and accepts paths that resolve inside the jail', () => {
    expect(check('curl https://example.com/a/b -o page.html').ok).toBe(true);
    expect(check(`cat ${path.join(JAIL, 'notes.txt')}`).ok).toBe(true);
    expect(check(`node ${path.join(JAIL, 'sub', 'index.js')}`).ok).toBe(true);
  });

  it('violation message names the offender and the jail', () => {
    const msg = jailViolationMessage(['D:\\x\\y'], JAIL);
    expect(msg).toContain('路径越界');
    expect(msg).toContain('D:\\x\\y');
    expect(msg).toContain(JAIL);
  });
});
