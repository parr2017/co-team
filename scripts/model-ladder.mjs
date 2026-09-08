/**
 * Payload ladder: same launcher prompt, truncated to different fractions, sent to
 * glm-5.3-flash. Shows WHERE the gateway starts failing (connectivity vs load).
 */
import fs from 'node:fs';
import yaml from 'js-yaml';
import OpenAI from 'openai';

const cfg = yaml.load(fs.readFileSync(new URL('../config/config.yaml', import.meta.url), 'utf-8'));
const payload = JSON.parse(fs.readFileSync(new URL('../tmp-probe-payload.json', import.meta.url), 'utf-8'));
const m = cfg.model_pool.find((x) => x.name === 'glm-5.3-flash');
const client = new OpenAI({ apiKey: m.api_key, baseURL: String(m.base_url || '').replace(/\/+$/, ''), timeout: 90_000, maxRetries: 0 });

const SCALES = [0.1, 0.25, 0.5, 0.75, 1.0];
for (const scale of SCALES) {
  const system = payload.system.slice(0, Math.floor(payload.system.length * scale));
  const t0 = Date.now();
  try {
    const resp = await client.chat.completions.create({
      model: m.name,
      messages: [{ role: 'system', content: system }, { role: 'user', content: payload.user }],
      max_tokens: 16384,
      temperature: 0,
    }, { timeout: 90_000 });
    const choice = resp.choices?.[0];
    const c = choice?.message?.content;
    console.log(`scale=${(scale * 100).toFixed(0)}% sysChars=${system.length} prompt≈${resp.usage?.prompt_tokens}tok -> ${((Date.now() - t0) / 1000).toFixed(1)}s finish=${choice?.finish_reason} content_len=${c == null ? -1 : c.length} reasoning=${resp.usage?.completion_tokens_details?.reasoning_tokens ?? 'n/a'}`);
  } catch (e) {
    const msg = String(e?.message || e).replace(/\s+/g, ' ').slice(0, 60);
    console.log(`scale=${(scale * 100).toFixed(0)}% sysChars=${system.length} -> ${((Date.now() - t0) / 1000).toFixed(1)}s EXC: ${msg}`);
  }
}
console.log('ladder done');
