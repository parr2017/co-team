import * as fs from 'node:fs';
import * as path from 'node:path';
import { simpleGit } from 'simple-git';
import { architectureTemplate, contributingTemplate, readmeTemplate } from './templates';

export interface ScaffoldOptions {
  name: string;
  description?: string;
  /** skip existing directories/files instead of overwriting */
  skipExisting?: boolean;
}

export interface ScaffoldResult {
  dirs: string[];
  files: string[];
  git_initialized: boolean;
  root_commit: string | null;
}

/** Standard project directory layout created by the initialization workflow. */
export const SCAFFOLD_DIRS = ['docs', 'src', 'tests', 'config'];

/**
 * Create the standard project scaffold: directory structure + structured docs
 * (README.md / CONTRIBUTING.md / ARCHITECTURE.md) + a git repo with a root commit.
 */
export async function scaffoldProject(workspace: string, options: ScaffoldOptions): Promise<ScaffoldResult> {
  const result: ScaffoldResult = { dirs: [], files: [], git_initialized: false, root_commit: null };
  const base = path.resolve(workspace);
  fs.mkdirSync(base, { recursive: true });

  for (const dir of SCAFFOLD_DIRS) {
    const target = path.join(base, dir);
    if (!fs.existsSync(target)) {
      fs.mkdirSync(target, { recursive: true });
      result.dirs.push(dir);
    }
  }

  const date = new Date().toISOString().slice(0, 10);
  const gitignore = [
    '# runtime artifacts (databases/caches) must never be committed — tests then hit their own leftover rows',
    '__pycache__/',
    '.pytest_cache/',
    '*.pyc',
    '*.db',
    '*.sqlite',
    '*.sqlite3',
    'node_modules/',
    '.venv/',
    'venv/',
    'dist/',
    '.env',
    '',
  ].join('\n');
  const files: Record<string, string> = {
    'README.md': readmeTemplate(options.name, options.description || ''),
    'CONTRIBUTING.md': contributingTemplate(options.name),
    'ARCHITECTURE.md': architectureTemplate(options.name, options.description || '').replace('{{DATE}}', date),
    '.gitignore': gitignore,
  };
  for (const [name, content] of Object.entries(files)) {
    const target = path.join(base, name);
    if (options.skipExisting && fs.existsSync(target)) continue;
    fs.writeFileSync(target, content, 'utf-8');
    result.files.push(name);
  }

  const git = simpleGit({ baseDir: base });
  if (!(await git.checkIsRepo().catch(() => false))) {
    await git.init();
    await git.addConfig('user.name', 'co-team');
    await git.addConfig('user.email', 'coteam@local');
    result.git_initialized = true;
  }
  // initial commit records the scaffold as the project baseline (idempotent: skipped when clean)
  const status = await git.status().catch(() => null);
  if (status && (status.staged.length || status.files.length)) {
    await git.add('-A');
    const commit = await git.commit(`chore: scaffold project ${options.name}`).catch(() => null);
    result.root_commit = commit?.commit ?? null;
  }
  return result;
}

/** Initialize git only (no scaffold files) — used when the user declines scaffolding. */
export async function initGitOnly(workspace: string): Promise<boolean> {
  const base = path.resolve(workspace);
  fs.mkdirSync(base, { recursive: true });
  const git = simpleGit({ baseDir: base });
  if (await git.checkIsRepo().catch(() => false)) return false;
  await git.init();
  await git.addConfig('user.name', 'co-team');
  await git.addConfig('user.email', 'coteam@local');
  return true;
}
