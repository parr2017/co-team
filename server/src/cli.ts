#!/usr/bin/env node
/**
 * Co_team built-in CLI (improvement 1 / R8).
 *
 * Usage:
 *   coteam init <dir> [--name <name>] [--description <text>]
 *
 * Scaffolds a standard project (dirs + structured docs + git repo) without
 * needing the dashboard UI or the REST API. Running with no subcommand prints
 * usage (the dashboard server itself starts via `npm start`).
 */
import * as path from 'node:path';
import { scaffoldProject } from './scaffold';
import { initBus, closeBus } from './bus';

export interface CliArgs {
  command: string;
  dir?: string;
  name?: string;
  description?: string;
}

/** Parse `coteam init <dir> [--name x] [--description y]` (kept pure for unit tests). */
export function parseArgs(argv: string[]): CliArgs | null {
  const args = argv.slice(2); // skip node + script
  if (args.length === 0) return null;
  const command = args[0];
  if (command !== 'init') return null;
  const rest = args.slice(1);
  let dir: string | undefined;
  let name: string | undefined;
  let description: string | undefined;
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === '--name' || a === '--description') {
      const val = rest[i + 1];
      if (!val) return null; // flag without a value is a usage error
      if (a === '--name') name = val;
      else description = val;
      i += 1;
    } else if (!dir) {
      dir = a;
    } else {
      return null; // a second positional argument is a usage error
    }
  }
  if (!dir) return null;
  return { command, dir, name, description };
}

export function usage(): string {
  return [
    'Co_team CLI',
    '',
    'Usage:',
    '  coteam init <dir> [--name <项目名>] [--description <描述>]',
    '  coteam            # print this help',
    '',
    'Commands:',
    '  init    Create a standard project scaffold: docs/src/tests/config dirs,',
    '          structured docs (README / CONTRIBUTING / ARCHITECTURE) and a git',
    '          repo with a root commit.',
    '',
    'The dashboard server itself starts with `npm start` (node server/dist/index.js).',
  ].join('\n');
}

/** Execute a parsed init command. Returns the scaffold result. */
export async function runInit(args: CliArgs): Promise<{ workspace: string; name: string; result: Awaited<ReturnType<typeof scaffoldProject>> }> {
  const workspace = path.resolve(args.dir!);
  const name = args.name || path.basename(workspace) || 'my-project';
  // scaffoldProject may touch the bus (snapshot/notify paths) — use the in-memory fallback
  process.env.COTEAM_FORCE_MEMORY = '1';
  await initBus({ host: '127.0.0.1', port: 6379, db: 0 }).catch(() => {});
  try {
    const result = await scaffoldProject(workspace, { name, description: args.description });
    return { workspace, name, result };
  } finally {
    closeBus();
  }
}

export async function main(argv: string[]): Promise<number> {
  const args = parseArgs(argv);
  if (!args) {
    // bare `coteam` (no subcommand) → help; a malformed command → help + exit 1
    console.log(usage());
    const bare = argv.length <= 2 || (argv.length === 3 && argv[2] === '--help');
    return bare ? 0 : 1;
  }
  const { workspace, name, result } = await runInit(args);
  console.log(`✔ 项目脚手架已生成`);
  console.log(`  目录: ${workspace}`);
  console.log(`  名称: ${name}`);
  console.log(`  结构: ${result.dirs.join(', ') || '（已存在，跳过）'}`);
  console.log(`  文档: ${result.files.join(', ') || '（已存在，跳过）'}`);
  console.log(`  git : ${result.git_initialized ? `已初始化${result.root_commit ? `（root commit ${result.root_commit.slice(0, 8)}）` : ''}` : '初始化失败或已存在'}`);
  return 0;
}

// run only when invoked directly (dist/cli.js), not when imported by tests
if (require.main === module) {
  main(process.argv)
    .then((code) => process.exit(code))
    .catch((e) => {
      console.error('[coteam] error:', String(e?.message || e));
      process.exit(1);
    });
}
