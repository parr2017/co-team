/**
 * Streaming vs non-streaming on glm-5.3-flash with the EXACT launcher prompt that
 * 504'd five times (non-streaming). If streaming completes, the 60s wall is the
 * relay's ALB idle-timeout on non-streaming connections — which is why chat UIs
 * (streaming) work everywhere else.
 */
import fs from 'node:fs';
import yaml from 'js-yaml';
import OpenAI from 'openai';

const cfg = yaml.load(fs.readFileSync(new URL('../config/config.yaml', import.meta.url), 'utf-8'));
const payload = JSON.parse(fs.readFileSync(new URL('../tmp-probe-payload.json', import.meta.url), 'utf-8'));
const m = cfg.model_pool.find((x) => x.name === 'glm-5.3-flash');
const client = new OpenAI({ apiKey: m.api_key, baseURL: String(m.base_url || '').replace(/\/+$/, ''), timeout: 600_000, maxRetries: 0 });

const messages = [{ role: 'system', content: payload.system }, { role: 'user', content: payload.user }];

// --- non-streaming control (expect 504 at ~60s) ---
{
  const t0 = Date.now();
  try {
    const resp = await client.chat.completions.create({ model: m.name, messages, max_tokens: 16384, temperature: 0 }, { timeout: 600_000 });
    const c = resp.choices?.[0]?.message?.content;
    console.log(`[non-stream] ${((Date.now() - t0) / 1000).toFixed(1)}s finish=${resp.choices?.[0]?.finish_reason} len=${c == null ? -1 : c.length}`);
  } catch (e) {
    console.log(`[non-stream] ${((Date.now() - t0) / 1000).toFixed(1)}s EXC: ${String(e?.message || e).replace(/\s+/g, ' ').slice(0, 80)}`);
  }
}

// --- streaming (hypothesis: first byte flows early, connection stays alive) ---
{
  const t0 = Date.now();
  try {
    const stream = await client.chat.completions.create({ model: m.name, messages, max_tokens: 16384, temperature: 0, stream: true }, { timeout: 600_000 });
    let len = 0;
    let firstChunkMs = -1;
    let finish = null;
    let usage = null;
    let head = '';
    for await (const chunk of stream) {
      const delta = chunk.choices?.[0]?.delta?.content || '';
      if (delta && firstChunkMs < 0) { firstChunkMs = Date.now() - t0; head = delta.slice(0, 40); }
      len += delta.length;
      if (chunk.choices?.[0]?.finish_reason) finish = chunk.choices[0].finish_reason;
      if (chunk.usage) usage = chunk.usage;
    }
    console.log(`[stream] ${((Date.now() - t0) / 1000).toFixed(1)}s firstByte=${(firstChunkMs / 1000).toFixed(1)}s finish=${finish} len=${len} usage(completion=${usage?.completion_tokens ?? 'n/a'}) head=${JSON.stringify(head)}`);
  } catch (e) {
    console.log(`[stream] ${((Date.now() - t0) / 1000).toFixed(1)}s EXC: ${String(e?.message || e).replace(/\s+/g, ' ').slice(0, 120)}`);
  }
}
console.log('streamtest done');
