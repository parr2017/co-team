/**
 * 协作会话 API（/api/convos/*）：convo.ts 引擎的 HTTP 面。
 * 全部挂载在 createApi 的 app 上（Bearer 门禁由 api/index.ts 统一生效）。
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Hono } from 'hono';
import type { Context } from 'hono';
import type { ApiContext } from './index';
import { HttpError } from './index';
import { readJsonAuto } from './index';
import {
  listConvos, getConvo, getConvoMessages, getConvoDiff, createConvo, updateConvo, deleteConvo,
  sendConvoMessage, stopConvo, resolveConvoApproval, answerConvoAsk, rollbackConvo,
  listPendingApprovals, listPendingAsks, appendConvoFileMessage, forkConvo, searchConvoFiles, type ConvoDeps,
} from '../convo';
import type { IncomingImage } from '../media';
import { getLogger } from '../logger';

/** 会话文件上传的落盘目录（data/media/files/）；下载路由按文件名白名单拒绝穿越 */
const CONVO_FILE_RE = /^cf-[a-z0-9]{6,14}-[A-Za-z0-9._\-\u4e00-\u9fa5]+$/;
const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;

export function convoDeps(ctx: ApiContext): ConvoDeps {
  return { orchestrator: ctx.orchestrator, pool: ctx.modelPool, logger: getLogger(), mcp: ctx.mcp };
}

export function registerConvoRoutes(app: Hono, ctx: ApiContext): void {
  const deps = () => convoDeps(ctx);

  app.get('/api/convos', async (c) => {
    let items = await listConvos();
    const pid = c.req.query('project_id');
    if (pid) items = items.filter((x) => x.project_id === pid);
    return c.json({ convos: items });
  });

  app.post('/api/convos', async (c) => {
    const body = await readJsonAuto<{ project_id?: string; title?: string; model_id?: string; agent_id?: string; policy_level?: string }>(c);
    const convo = await createConvo(deps(), body);
    return c.json({ status: 'created', convo });
  });

  app.get('/api/convos/:id', async (c) => {
    const id = String(c.req.param('id'));
    const convo = await getConvo(id);
    if (!convo) throw new HttpError(404, 'convo not found');
    const { busGet } = await import('../bus');
    const messages = await getConvoMessages(id);
    const pending = ((await busGet<number[]>(`convo:${id}:pending`)) || []).length;
    const approvals = await listPendingApprovals(id);
    const asks = await listPendingAsks(id);
    return c.json({ ...convo, messages, pending_queue: pending, pending_approvals: approvals, pending_asks: asks, busy: !!await busGet(`convo:${id}:busy`) });
  });

  app.patch('/api/convos/:id', async (c) => {
    const body = await readJsonAuto<{ title?: string; model_id?: string | null; policy_level?: string | null }>(c);
    const convo = await updateConvo(deps(), c.req.param('id'), body);
    return c.json({ status: 'updated', convo });
  });

  app.delete('/api/convos/:id', async (c) => {
    const { busGet } = await import('../bus');
    const id = String(c.req.param('id'));
    if (!(await getConvo(id))) throw new HttpError(404, 'convo not found');
    if (await busGet(`convo:${id}:busy`)) throw new HttpError(409, '会话正在执行，请先停止再删除');
    await deleteConvo(id);
    return c.json({ status: 'deleted' });
  });

  app.post('/api/convos/:id/messages', async (c) => {
    const id = String(c.req.param('id'));
    const body = await readJsonAuto<{ text?: string; images?: IncomingImage[]; mode?: 'queue' | 'interrupt'; model_id?: string }>(c);
    const r = await sendConvoMessage(deps(), id, { text: body.text || '', images: body.images, mode: body.mode, model_id: body.model_id });
    return c.json({ status: r.queued ? 'queued' : 'accepted', queued: r.queued });
  });

  app.post('/api/convos/:id/stop', async (c) => {
    await stopConvo(deps(), c.req.param('id'));
    return c.json({ status: 'stopped' });
  });

  app.post('/api/convos/:id/approvals/:cid', async (c) => {
    const body = await readJsonAuto<{ action: 'once' | 'reject' | 'always' }>(c);
    if (!['once', 'reject', 'always'].includes(body.action)) throw new HttpError(400, 'action 必须是 once | reject | always');
    const rec = await resolveConvoApproval(deps(), c.req.param('id'), c.req.param('cid'), body.action);
    return c.json({ status: 'resolved', approval: rec });
  });

  app.post('/api/convos/:id/asks/:aid', async (c) => {
    const body = await readJsonAuto<{ answer?: string }>(c);
    const rec = await answerConvoAsk(deps(), c.req.param('id'), c.req.param('aid'), body.answer || '');
    return c.json({ status: 'answered', ask: rec });
  });

  // 文件上传（multipart）：≤20MB，落 data/media/files/ + 拷入 <ws>/.coteam/user-files/，
  // 消息流插 file 卡片（agent 用 read_file 读取工作区副本）
  app.post('/api/convos/:id/files', async (c: Context) => {
    const id = String(c.req.param('id'));
    const convo = await getConvo(id);
    if (!convo) throw new HttpError(404, 'convo not found');
    const body = await c.req.parseBody();
    const entries = Object.entries(body).filter(([, v]) => typeof v !== 'string');
    if (!entries.length) throw new HttpError(400, '没有收到文件字段（multipart form-data）');
    const saved: { id: string; name: string; url: string; wsPath?: string; size: number }[] = [];
    for (const [, v] of entries.slice(0, 10)) {
      const f = v as File;
      const bytes = Buffer.from(await f.arrayBuffer());
      if (!bytes.byteLength) continue;
      if (bytes.byteLength > MAX_UPLOAD_BYTES) throw new HttpError(400, `文件 ${f.name} 超过 20MB 上限`);
      const { mediaDir } = await import('../media');
      const dir = path.join(mediaDir(), 'files');
      fs.mkdirSync(dir, { recursive: true });
      const fileId = Math.random().toString(36).slice(2, 10);
      const safeName = (f.name || 'file.bin').replace(/[/\\?%*:|"<>\x00-\x1f]/g, '_').slice(0, 80) || 'file.bin';
      const fileName = `cf-${fileId}-${safeName}`;
      fs.writeFileSync(path.join(dir, fileName), bytes);
      const item: { id: string; name: string; url: string; wsPath?: string; size: number } = {
        id: fileId, name: safeName, url: `/api/convos/files/${encodeURIComponent(fileName)}`, size: bytes.byteLength,
      };
      if (convo.workspace) {
        const wsDir = path.join(convo.workspace, '.coteam', 'user-files');
        fs.mkdirSync(wsDir, { recursive: true });
        fs.writeFileSync(path.join(wsDir, fileName), bytes);
        item.wsPath = `.coteam/user-files/${fileName}`;
      }
      saved.push(item);
    }
    if (!saved.length) throw new HttpError(400, '文件内容为空');
    await appendConvoFileMessage(deps(), id, saved);
    return c.json({ status: 'uploaded', files: saved });
  });

  // 会话上传文件下载：文件名白名单拒绝路径穿越
  app.get('/api/convos/files/:name', async (c) => {
    const name = c.req.param('name');
    if (!CONVO_FILE_RE.test(name)) return c.json({ detail: 'invalid file name' }, 400);
    const { mediaDir } = await import('../media');
    const full = path.join(mediaDir(), 'files', name);
    if (!fs.existsSync(full)) return c.json({ detail: 'file not found' }, 404);
    const body = await fs.promises.readFile(full);
    c.header('Content-Type', 'application/octet-stream');
    c.header('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(name.replace(/^cf-[a-z0-9]{6,14}-/, ''))}`);
    return c.body(body);
  });

  app.get('/api/convos/:id/diff', async (c) => {
    return c.json(await getConvoDiff(c.req.param('id')));
  });

  // 工作区文件预览/下载（share_file 卡片与 diff 审阅）：监狱校验，文本返内容、图片返 dataURL
  app.get('/api/convos/:id/file', async (c) => {
    const convo = await getConvo(c.req.param('id'));
    if (!convo) throw new HttpError(404, 'convo not found');
    const rel = String(c.req.query('path') || '').trim();
    if (!convo.workspace || !rel) throw new HttpError(400, 'path is required');
    const abs = path.resolve(convo.workspace, rel);
    if (!abs.startsWith(path.resolve(convo.workspace))) throw new HttpError(400, 'path outside workspace（目录监狱）');
    if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) throw new HttpError(404, `file not found: ${rel}`);
    const size = fs.statSync(abs).size;
    if (size > 512 * 1024) throw new HttpError(400, `文件超过 512KB 预览上限（${Math.round(size / 1024)}KB），请用 share_file 下载查看`);
    const ext = path.extname(abs).toLowerCase();
    const IMAGE_MEDIA: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp' };
    if (IMAGE_MEDIA[ext]) {
      const b64 = (await fs.promises.readFile(abs)).toString('base64');
      return c.json({ name: path.basename(abs), size, kind: 'image', dataUrl: `data:${IMAGE_MEDIA[ext]};base64,${b64}` });
    }
    return c.json({ name: path.basename(abs), size, kind: 'text', content: (await fs.promises.readFile(abs, 'utf-8')).slice(0, 512 * 1024) });
  });

  app.post('/api/convos/:id/rollback', async (c) => {
    const r = await rollbackConvo(deps(), c.req.param('id'));
    return c.json({ status: 'rolled_back', ...r });
  });

  // fork：按消息锚点复制出新会话
  app.post('/api/convos/:id/fork', async (c) => {
    const body = await readJsonAuto<{ message_id?: string; title?: string }>(c);
    const convo = await forkConvo(deps(), c.req.param('id'), body);
    return c.json({ status: 'forked', convo });
  });

  // @引用文件模糊搜索
  app.get('/api/convos/:id/search', async (c) => {
    const r = await searchConvoFiles(deps(), c.req.param('id'), c.req.query('q') || '', Number(c.req.query('limit')) || 20);
    return c.json(r);
  });
}
