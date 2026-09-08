import * as fs from 'node:fs';
import * as path from 'node:path';
import { busGet, busSet } from './bus';
import { emitProgress } from './store';

export type SsotDocType = 'TASK_SPEC' | 'API_CONTRACT' | 'STATUS_REPORT';

export const SSOT_DOC_TYPES: SsotDocType[] = ['TASK_SPEC', 'API_CONTRACT', 'STATUS_REPORT'];

export interface SsotDoc {
  doc_id: string;
  type: SsotDocType;
  path: string;
  version: number;
  hash: string;
  content: string;
  updated_at: string;
  updated_by: string;
}

const MAX_DOC_CONTENT = 64 * 1024;

export function docsKey(taskId: string): string {
  return `ssot:docs:${taskId}`;
}

export function contentHash(content: string): string {
  let h = 5381;
  for (let i = 0; i < content.length; i++) h = ((h << 5) + h + content.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

export async function getDocRegistry(taskId: string): Promise<SsotDoc[]> {
  return (await busGet<SsotDoc[]>(docsKey(taskId))) || [];
}

/** Render the docs section injected into agent prompts so every agent works from the SSOT.
 *  Short docs ride inline (agents otherwise burn a recon round reading the file); long ones
 *  stay pointer-only with a truncation note. */
const DOC_INLINE_MAX_CHARS = 2 * 1024;
const DOC_INLINE_MAX_DOCS = 3;
const DOC_INLINE_TOTAL_MAX_CHARS = 6 * 1024;

export async function docsSection(taskId: string): Promise<string> {
  const docs = await getDocRegistry(taskId);
  if (!docs.length) return '';
  const pointers = docs.map((d) => `- docs/${d.type}.md (v${d.version})`).join('\n');
  let budget = DOC_INLINE_TOTAL_MAX_CHARS;
  const bodies: string[] = [];
  for (const d of docs) {
    if (bodies.length >= DOC_INLINE_MAX_DOCS || budget <= 0) break;
    const text = d.content || '';
    if (!text.trim()) continue;
    if (text.length <= DOC_INLINE_MAX_CHARS && text.length <= budget) {
      bodies.push(`### docs/${d.type}.md (v${d.version})\n${text}`);
      budget -= text.length;
    } else {
      const head = text.slice(0, Math.min(DOC_INLINE_MAX_CHARS, budget));
      bodies.push(`### docs/${d.type}.md (v${d.version}，内容过长已截断，可用 read_file 读取全文)\n${head}`);
      break;
    }
  }
  let out = '\n\n## 协同文档（单一事实来源，请勿在回复中复述，直接以文档为准）\n' + pointers;
  if (bodies.length) out += '\n\n#### 文档内容\n' + bodies.join('\n\n');
  return out;
}

/** Atomic file write: temp file + rename prevents concurrent-write corruption. */
function atomicWrite(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp-${Date.now()}`;
  fs.writeFileSync(tmp, content, 'utf-8');
  fs.renameSync(tmp, filePath);
}

/**
 * Write/replace a task document (improvement 4). Bumps the version, persists content
 * in the registry (single source of truth) and broadcasts doc_updated so dependent
 * agents can reload.
 */
export async function writeDoc(taskId: string, type: SsotDocType, content: string, updatedBy: string, sandboxDir?: string): Promise<SsotDoc> {
  const body = content.slice(0, MAX_DOC_CONTENT);
  const registry = await getDocRegistry(taskId);
  const prev = registry.find((d) => d.type === type);
  const doc: SsotDoc = {
    doc_id: prev?.doc_id || `${taskId}-${type.toLowerCase()}`,
    type,
    path: `docs/${type}.md`,
    version: (prev?.version ?? 0) + 1,
    hash: contentHash(body),
    content: body,
    updated_at: new Date().toISOString(),
    updated_by: updatedBy,
  };
  const next = [...registry.filter((d) => d.type !== type), doc];
  await busSet(docsKey(taskId), next);

  if (sandboxDir) {
    const withHeader = `<!-- ${type} v${doc.version} | updated_at: ${doc.updated_at} | by: ${updatedBy} -->\n\n${body}`;
    atomicWrite(path.join(sandboxDir, 'docs', `${type}.md`), withHeader);
  }
  await emitProgress('doc_updated', { task_id: taskId, doc_type: type, version: doc.version, updated_by: updatedBy });
  return doc;
}

export async function readDoc(taskId: string, type: SsotDocType): Promise<SsotDoc | null> {
  return (await getDocRegistry(taskId)).find((d) => d.type === type) ?? null;
}

export interface DocCheckResult {
  ok: boolean;
  restored: SsotDocType[];
  issues: string[];
}

/**
 * Pre-execution document check (improvement 4 step 4): every registered doc must exist
 * in the sandbox and match the registry content; missing/tampered files are restored
 * from the registry so agents always read the latest authoritative version.
 */
export async function checkDocs(taskId: string, sandboxDir: string): Promise<DocCheckResult> {
  const registry = await getDocRegistry(taskId);
  const result: DocCheckResult = { ok: true, restored: [], issues: [] };
  for (const doc of registry) {
    const file = path.join(sandboxDir, 'docs', `${doc.type}.md`);
    if (!fs.existsSync(file)) {
      atomicWrite(file, `<!-- ${doc.type} v${doc.version} -->\n\n${doc.content}`);
      result.restored.push(doc.type);
      continue;
    }
    const onDisk = fs.readFileSync(file, 'utf-8');
    if (contentHash(onDisk.replace(/^<!--[\s\S]*?-->\n*/, '')) !== doc.hash) {
      atomicWrite(file, `<!-- ${doc.type} v${doc.version} -->\n\n${doc.content}`);
      result.restored.push(doc.type);
      result.issues.push(`${doc.type}.md 内容与注册表不一致，已恢复为 v${doc.version}`);
    }
  }
  if (result.issues.length) result.ok = false;
  return result;
}

// ---------- doc content builders ----------

export function buildTaskSpec(description: string, level: string, nodes: { id: string; name: string; agent: string }[], goal?: string): string {
  return [
    `# TASK_SPEC（任务规格书）`,
    '',
    `## 全局目标`,
    goal || description,
    '',
    `## 任务描述`,
    description,
    '',
    `## 任务级别`,
    level,
    '',
    `## 节点清单`,
    ...nodes.map((n) => `- [${n.id}] ${n.name}（agent: ${n.agent}）`),
    '',
    `> 本文档由编排器维护，是所有 Agent 协同的单一事实来源。`,
  ].join('\n');
}

export function buildStatusReport(description: string, completed: string[], running: string[], pending: string[], lastSummary?: string): string {
  return [
    `# STATUS_REPORT（状态报告）`,
    '',
    `## 任务`,
    description,
    '',
    `## 当前进度`,
    `- 已完成: ${completed.length ? completed.join('、') : '（无）'}`,
    `- 进行中: ${running.length ? running.join('、') : '（无）'}`,
    `- 待执行: ${pending.length ? pending.join('、') : '（无）'}`,
    ...(lastSummary ? [`\n## 最近节点产出\n${lastSummary}`] : []),
  ].join('\n');
}

export function buildApiContract(description: string): string {
  return [
    `# API_CONTRACT（接口契约）`,
    '',
    `## 任务`,
    description,
    '',
    `## 接口清单`,
    `| 方法 | 路径 | 请求 | 响应 | 备注 |`,
    `|------|------|------|------|------|`,
    `| （待实现节点填写） | | | | |`,
    '',
    `> 涉及 API 的节点实现时必须更新本文档；下游节点以本文档为准。`,
  ].join('\n');
}

/** Cleanup hook for deleteTask. */
export async function deleteDocs(taskId: string): Promise<void> {
  await busSet(docsKey(taskId), []);
}
