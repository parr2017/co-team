import { simpleGit } from 'simple-git';
import { busGet, busSet, busKeys, busDel } from './bus';
import { emitProgress } from './store';

export interface SnapshotMeta {
  id: string;
  task_id: string;
  tag: string;
  workspace: string;
  git_ref: string | null;
  branch: string | null;
  kv_keys: string[];
  created_at: string;
  note?: string;
}

export interface SnapshotRollbackResult {
  ok: boolean;
  snapshot_id: string;
  git_action: string;
  kv_restored: number;
  details: string[];
}

const INDEX_KEY = 'snapshot:index';
const AUDIT_KEY = 'snapshot:audit';
const MAX_SNAPSHOTS = 100;

function snapshotDataKey(id: string): string {
  return `snapshot:data:${id}`;
}

function snapshotKeysForTask(taskId: string): Promise<string[]> {
  return busKeys(`task:${taskId}:*`);
}

/**
 * Create a state snapshot (improvement 10): git ref of the task workspace/sandbox
 * plus an export of the task's bus KV state (sessions, journals, docs registry, goal…).
 */
export async function createSnapshot(taskId: string, opts: { tag: string; workspace?: string; sandbox?: string; note?: string }): Promise<SnapshotMeta> {
  const meta: SnapshotMeta = {
    id: `snap-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    task_id: taskId,
    tag: opts.tag,
    workspace: opts.workspace || '',
    git_ref: null,
    branch: null,
    kv_keys: [],
    created_at: new Date().toISOString(),
    note: opts.note,
  };

  // resolve workspace from the task graph when not supplied
  const graph = await busGet<{ workspace?: string }>(`task:graph:${taskId}`);
  if (!opts.workspace && graph?.workspace) meta.workspace = graph.workspace;

  const gitDir = opts.sandbox || meta.workspace;
  if (gitDir) {
    try {
      const g = simpleGit({ baseDir: gitDir });
      if (await g.checkIsRepo().catch(() => false)) {
        meta.git_ref = (await g.revparse('HEAD')).trim() || null;
        meta.branch = (await g.branchLocal()).current || null;
      }
    } catch {
      /* no git state available */
    }
  }

  const kvKeys = (await snapshotKeysForTask(taskId)).slice(0, 60);
  meta.kv_keys = kvKeys;
  const data: Record<string, unknown> = {};
  for (const key of kvKeys) {
    const value = await busGet(key);
    if (value !== null) data[key] = value;
  }
  await busSet(snapshotDataKey(meta.id), data);

  const index = (await busGet<SnapshotMeta[]>(INDEX_KEY)) || [];
  index.push(meta);
  await busSet(INDEX_KEY, index.slice(-MAX_SNAPSHOTS));
  await emitProgress('snapshot_created', { task_id: taskId, snapshot_id: meta.id, tag: meta.tag, git_ref: meta.git_ref });
  return meta;
}

export async function listSnapshots(filter: { task_id?: string; tag?: string } = {}): Promise<SnapshotMeta[]> {
  const index = (await busGet<SnapshotMeta[]>(INDEX_KEY)) || [];
  return index
    .filter((s) => (filter.task_id ? s.task_id === filter.task_id : true))
    .filter((s) => (filter.tag ? s.tag === filter.tag : true))
    .sort((a, b) => b.created_at.localeCompare(a.created_at));
}

export async function getSnapshot(id: string): Promise<SnapshotMeta | null> {
  return ((await busGet<SnapshotMeta[]>(INDEX_KEY)) || []).find((s) => s.id === id) ?? null;
}

async function audit(action: string, detail: Record<string, unknown>): Promise<void> {
  const log = (await busGet<{ ts: string; action: string; detail: Record<string, unknown> }[]>(AUDIT_KEY)) || [];
  log.push({ ts: new Date().toISOString(), action, detail });
  await busSet(AUDIT_KEY, log.slice(-200));
}

/**
 * Roll back to a snapshot (improvement 10). Requires explicit confirmation to prevent
 * accidents; every attempt is recorded in the audit log.
 *
 * Git strategy: when the task sandbox still exists → hard reset to the ref (atomic restore
 * of the execution state). Otherwise → create a non-destructive `coteam/rollback-*` branch
 * at the ref in the task workspace.
 */
export async function rollbackSnapshot(id: string, opts: { confirmed: boolean; sandbox?: string }): Promise<SnapshotRollbackResult> {
  if (!opts.confirmed) throw new Error('rollback requires explicit confirmation');
  const meta = await getSnapshot(id);
  if (!meta) throw new Error(`snapshot not found: ${id}`);

  const result: SnapshotRollbackResult = { ok: true, snapshot_id: id, git_action: 'none', kv_restored: 0, details: [] };

  // 1. restore bus KV state (overwrites current values with the snapshotted ones)
  const data = await busGet<Record<string, unknown>>(snapshotDataKey(id));
  if (data) {
    for (const [key, value] of Object.entries(data)) {
      await busSet(key, value);
      result.kv_restored++;
    }
    // drop task keys that did not exist at snapshot time (created after it)
    const currentKeys = await snapshotKeysForTask(meta.task_id);
    for (const key of currentKeys) {
      if (!(key in data)) {
        await busDel(key);
        result.details.push(`removed post-snapshot key ${key}`);
      }
    }
  }

  // 2. restore git state
  const gitDir = opts.sandbox || meta.workspace;
  if (meta.git_ref && gitDir) {
    try {
      const g = simpleGit({ baseDir: gitDir });
      if (await g.checkIsRepo().catch(() => false)) {
        const branches = await g.branchLocal();
        if (opts.sandbox) {
          await g.reset(['--hard', meta.git_ref]);
          result.git_action = `sandbox reset to ${meta.git_ref.slice(0, 8)}`;
        } else {
          const rollbackBranch = `coteam/rollback-${id}`;
          await g.checkout(['-B', rollbackBranch, meta.git_ref]);
          result.git_action = `workspace branch ${rollbackBranch} created at ${meta.git_ref.slice(0, 8)}`;
        }
        void branches;
      }
    } catch (e: any) {
      result.details.push(`git rollback failed: ${String(e?.message || e).slice(0, 200)}`);
    }
  }

  await audit('rollback', { task_id: meta.task_id, ...result });
  await emitProgress('snapshot_rolled_back', { task_id: meta.task_id, snapshot_id: id, git_action: result.git_action });
  return result;
}

export async function getAuditLog(): Promise<{ ts: string; action: string; detail: Record<string, unknown> }[]> {
  return (await busGet(AUDIT_KEY)) || [];
}
