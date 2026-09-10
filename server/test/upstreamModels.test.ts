import { afterEach, describe, expect, it } from 'vitest';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';

// feature: 模型池服务分组编辑 —— 同一 baseUrl+apikey 下拉取上游可用模型列表
// 覆盖：llm.listUpstreamModels（排序/去重/鉴权头/错误传播）与 API 端点参数校验

import { listUpstreamModels } from '../src/llm';
import { createApi } from '../src/api';

const servers: http.Server[] = [];
afterEach(() => {
  for (const s of servers.splice(0)) s.close();
});

/** stub for an OpenAI-compatible GET /models. `mode`: ok | unauthorized */
async function startModelsStub(mode: 'ok' | 'unauthorized'): Promise<number> {
  const server = http.createServer((req, res) => {
    if (mode === 'unauthorized') {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'invalid api key' } }));
      return;
    }
    expect(req.url).toBe('/v1/models');
    expect(req.headers.authorization).toBe('Bearer sk-test');
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      object: 'list',
      data: [
        { object: 'model', id: 'glm-5.3-flash', created: 1, owned_by: 'zhipu' },
        { object: 'model', id: 'deepseek-v4-flash', created: 1, owned_by: 'deepseek' },
        { object: 'model', id: 'glm-5.3-flash', created: 2, owned_by: 'zhipu' }, // duplicate on purpose
      ],
    }));
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return (server.address() as AddressInfo).port;
}

describe('listUpstreamModels', () => {
  it('returns sorted unique model ids from an OpenAI-compatible /models', async () => {
    const port = await startModelsStub('ok');
    const names = await listUpstreamModels('sk-test', `http://127.0.0.1:${port}/v1/`);
    expect(names).toEqual(['deepseek-v4-flash', 'glm-5.3-flash']);
  });

  it('rejects when the upstream refuses the key', async () => {
    const port = await startModelsStub('unauthorized');
    await expect(listUpstreamModels('sk-bad', `http://127.0.0.1:${port}/v1`)).rejects.toBeTruthy();
  });
});

describe('POST /api/config/upstream-models', () => {
  const api = () => createApi({ config: {} as any, orchestrator: {} as any, modelPool: {} as any, taskQueue: {} as any });

  it('400s when base_url or api_key is missing', async () => {
    const res = await api().request('/api/config/upstream-models', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ base_url: 'http://127.0.0.1:1/v1' }),
    });
    expect(res.status).toBe(400);
  });

  it('ok:true with model list when the upstream is reachable', async () => {
    const port = await startModelsStub('ok');
    const res = await api().request('/api/config/upstream-models', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ base_url: `http://127.0.0.1:${port}/v1`, api_key: 'sk-test' }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; models: string[] };
    expect(body.ok).toBe(true);
    expect(body.models).toContain('deepseek-v4-flash');
  });

  it('400 ok:false when the upstream fails (never a 500)', async () => {
    const port = await startModelsStub('unauthorized');
    const res = await api().request('/api/config/upstream-models', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ base_url: `http://127.0.0.1:${port}/v1`, api_key: 'sk-bad' }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { ok: boolean; error: string };
    expect(body.ok).toBe(false);
    expect(body.error).toBeTruthy();
  });
});

describe('PUT /api/config/model-pool name uniqueness', () => {
  it('rejects duplicate model names before touching the config file', async () => {
    const app = createApi({
      config: { model_pool: [] } as any,
      orchestrator: {} as any,
      modelPool: { replaceModels: () => { throw new Error('must not be called'); } } as any,
      taskQueue: {} as any,
    });
    const dup = { name: 'm1', api_key: 'k', base_url: 'http://x/v1' };
    const res = await app.request('/api/config/model-pool', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model_pool: [dup, { ...dup }] }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: string };
    expect(JSON.stringify(body)).toContain('duplicate model name');
  });
});
