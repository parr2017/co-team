/**
 * 项目工作区治理（2026-09-08）：
 * 1. 项目必须拥有独立目录 + 独立 git 仓库——workspace 落在其他仓库（尤其 co-team 自身）
 *    工作树内时，simple-git 的 checkIsRepo 会向上穿透，任务分支/提交污染外层仓库（已发生：
 *    tmp-* 子目录的任务分支落进了 co-team 仓库）。assertStandaloneWorkspace 在入口拦截。
 * 2. 任务的一切命令被限制在项目目录（监狱）内：assertWithinJail 扫描命令里的绝对路径与
 *    `..` 逃逸，越界即拒——与权限级别无关（full = 目录内完全控制）。这是护栏而非安全边界
 *    （shell:true 无法做到 OS 级隔离），目标是防误伤与防污染，不是防恶意。
 * 3. gitCommit 曾把 workspace 仓库 HEAD 切到任务分支后不回切，吸附后续人工提交；
 *    restoreStaleTaskHeads 在启动时清扫遗留 HEAD。
 * 4. 自指任务（用 co-team 开发 co-team）物理隔离：本地克隆到 projects.selfdev_root，
 *    主副本 HEAD/分支零触碰。
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { simpleGit } from 'simple-git';

/** Error carrying an HTTP status so the API layer maps it 1:1 (same shape as DiscussionError). */
export class WorkspaceError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

/** True when `child` is `parent` itself or lives inside it. */
export function isInside(parent: string, child: string): boolean {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return rel === '' || (!!rel && !rel.startsWith('..') && !path.isAbsolute(rel));
}

/** Directory-name-safe slug: keeps letters/digits/CJK, collapses the rest to '-'. */
export function slugifyProjectName(name: string): string {
  const s = (name || '')
    .trim()
    .replace(/[\\/:*?"<>|\s]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return s || 'project';
}

/** `git rev-parse --show-toplevel` inside ws (probing the nearest existing ancestor),
 *  or null when nothing around ws is in a repo. */
export async function repoToplevel(ws: string): Promise<string | null> {
  let probe = path.resolve(ws);
  const root = path.parse(probe).root;
  while (probe.length >= root.length && !fs.existsSync(probe)) {
    const parent = path.dirname(probe);
    if (parent === probe) break;
    probe = parent;
  }
  if (!fs.existsSync(probe)) return null;
  try {
    const out = await simpleGit({ baseDir: probe }).raw(['rev-parse', '--show-toplevel']);
    const top = out.trim();
    return top || null;
  } catch {
    return null;
  }
}

/**
 * Validate a project/task workspace.
 * - inside co-team's own repo → rejected unless allowSelfRef (self-ref tasks run in an
 *   isolated clone instead, see prepareSelfdevClone);
 * - nested inside another git repo's work tree → rejected (its branches/commits would
 *   land in that repo); a standalone repo or a plain directory is fine.
 */
export async function assertStandaloneWorkspace(
  ws: string,
  opts: { allowSelfRef?: boolean; projectRoot: string }
): Promise<string> {
  const base = path.resolve(ws);
  if (isInside(opts.projectRoot, base)) {
    if (!opts.allowSelfRef) {
      throw new WorkspaceError(
        400,
        `workspace 不能位于 co-team 自身仓库内（${opts.projectRoot}）——项目应拥有独立目录。请改用 projects.root 下的目录；` +
          `确需「用 co-team 开发 co-team」请勾选自指任务（将在隔离克隆中执行，不碰主副本）`
      );
    }
    return base; // self-ref: isolation happens at execute time
  }
  const top = await repoToplevel(base);
  if (top && path.resolve(top) !== base) {
    throw new WorkspaceError(
      400,
      `该目录不是独立 git 仓库：它位于 ${top} 的工作树内，任务分支与提交会落进那个仓库。` +
        `请把项目放到自己的目录（projects.root），或先在该目录 git init 成独立仓库`
    );
  }
  return base;
}

// ---------- directory jail ----------

const TOKEN_RE = /"[^"]*"|'[^']*'|\S+/g;
// absolute path candidates embedded in a token: drive paths, POSIX roots, and
// `..` escapes — incl. `--flag=D:\x` / `--flag=/x` forms via the boundary class.
const PATH_IN_TOKEN = /(?:^|[=,:[\s])((?:[A-Za-z]:[\\/]|\/|\.\.[\\/])[^"'\s,;]*)/g;

/**
 * Scan a command string for filesystem paths that resolve outside the jail.
 * Returns the offending tokens; empty = safe. Skips URLs (anything with `://`).
 */
export function assertWithinJail(command: string, jailRoot: string): { ok: boolean; violations: string[] } {
  const jail = path.resolve(jailRoot);
  const violations = new Set<string>();
  for (const raw of command.match(TOKEN_RE) || []) {
    const tok = raw.replace(/^["']|["']$/g, '');
    if (!tok || tok.includes('://')) continue;
    // bare `..` / `.` arguments: `..` escapes by definition, `.` is the jail itself
    if (tok === '..') {
      violations.add(tok);
      continue;
    }
    for (const m of (tok + ' ').matchAll(PATH_IN_TOKEN)) {
      const cand = m[1];
      if (!cand || cand === '/') continue;
      const abs = path.resolve(jail, cand);
      if (!isInside(jail, abs)) violations.add(cand);
    }
  }
  return { ok: violations.size === 0, violations: [...violations] };
}

/** Guard message shown to the agent/user when a command escapes the jail. */
export function jailViolationMessage(violations: string[], jailRoot: string): string {
  return `路径越界：${violations.slice(0, 3).join('、')}${violations.length > 3 ? ' 等' : ''} 不在项目目录 ${jailRoot} 内——产物与日志一律写项目目录内（相对路径），禁止操作外部绝对路径`;
}

// ---------- stale HEAD cleanup (defect: gitCommit switched branches and never restored) ----------

export interface RestoreResult {
  checked: number;
  restored: string[];
  held: { workspace: string; branch: string; ahead: number }[];
}

/**
 * Startup sweep: any project workspace left with HEAD on a `coteam/task-*` branch by a
 * previous task run gets restored to its main branch — but only when the task branch has
 * no commits ahead of main (never silently drop human work; those are reported instead).
 */
export async function restoreStaleTaskHeads(logger?: { info(m: string, meta?: unknown): void; warn(m: string, meta?: unknown): void }): Promise<RestoreResult> {
  const { listProjects } = await import('./store');
  const { detectMainBranch } = await import('./git');
  const result: RestoreResult = { checked: 0, restored: [], held: [] };
  for (const p of await listProjects()) {
    const ws = p.workspace;
    if (!ws || !fs.existsSync(path.join(ws, '.git'))) continue;
    result.checked += 1;
    const g = simpleGit({ baseDir: ws });
    const current = (await g.revparse(['--abbrev-ref', 'HEAD']).catch(() => '')) || '';
    if (!current.startsWith('coteam/task-')) continue;
    const main = await detectMainBranch(ws);
    const ahead = parseInt((await g.raw(['rev-list', '--count', `${main}..${current}`]).catch(() => '0')) || '0', 10) || 0;
    if (ahead === 0) {
      await g.checkout(main).catch(() => undefined);
      result.restored.push(`${ws} (${current} → ${main})`);
      logger?.info('restored stale task HEAD', { workspace: ws, from: current, to: main });
    } else {
      result.held.push({ workspace: ws, branch: current, ahead });
      logger?.warn('task branch has unmerged commits — HEAD left in place', { workspace: ws, branch: current, ahead });
    }
  }
  return result;
}

// ---------- self-referential task isolation (local clone) ----------

/**
 * Prepare the isolated execution dir for a self-ref task: a local clone of co-team at
 * `<selfdevRoot>/<taskId>`. Idempotent — reuses an existing clone (resume after restart).
 */
export async function prepareSelfdevClone(taskId: string, selfdevRoot: string, sourceRepo: string): Promise<string> {
  const target = path.join(path.resolve(selfdevRoot), taskId);
  if (fs.existsSync(path.join(target, '.git'))) return target;
  fs.mkdirSync(path.dirname(target), { recursive: true });
  // --no-hardlinks: a fully independent object store; the clone must never write back
  await simpleGit().clone(sourceRepo, target, ['--no-hardlinks', '--quiet']);
  return target;
}

export function removeSelfdev(target: string): void {
  fs.rmSync(target, { recursive: true, force: true });
}
