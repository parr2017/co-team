/**
 * Model probe: replay the EXACT launcher-node prompt (the one that produced empty
 * responses inside co-team) directly against each model in the pool, bypassing the
 * orchestrator. Captures finish_reason / usage / content length to answer:
 *   空响应是模型/上游的问题，还是 co-team 调用参数的问题？
 * Usage: node tmp-modelprobe.mjs  (from server/ so js-yaml/openai resolve)
 */
import fs from 'node:fs';
import yaml from 'js-yaml';
import OpenAI from 'openai';

const cfg = yaml.load(fs.readFileSync(new URL('../config/config.yaml', import.meta.url), 'utf-8'));
const payload = JSON.parse(fs.readFileSync(new URL('../tmp-probe-payload.json', import.meta.url), 'utf-8'));
const models = cfg.model_pool || [];
const TIMEOUT_MS = Number(process.env.PROBE_TIMEOUT_MS || 120_000);
const REPS = Number(process.env.PROBE_REPS || 3);
const BUDGET = Number(process.env.PROBE_MAX_TOKENS || 8192);

const scenarios = {
  'A-launcher-replay': {
    system: payload.system,
    user: payload.user,
    maxTokens: BUDGET,
    reps: REPS,
  },
  'B-trivial-json': {
    system: '你是 JSON 生成器。只输出一个 JSON 对象，不要任何其他文字。',
    user: '输出 {"status":"success","summary":"探针测试"}',
    maxTokens: BUDGET,
    reps: REPS,
  },
};

function summarize(content) {
  if (content == null) return { len: -1, head: '(null)' };
  const head = content.replace(/\s+/g, ' ').slice(0, 90);
  const isJson = (() => { try { JSON.parse(content.trim().replace(/^```(?:json)?\s*|\s*```$/g, '')); return true; } catch { return /"tool_calls"|"status"\s*:/.test(content); } })();
  return { len: content.length, jsonish: isJson, head };
}

for (const m of models) {
  const client = new OpenAI({ apiKey: m.api_key, baseURL: String(m.base_url || '').replace(/\/+$/, ''), timeout: TIMEOUT_MS, maxRetries: 0 });
  console.log(`\n########## ${m.name} (${m.base_url}) ##########`);
  for (const [sname, sc] of Object.entries(scenarios)) {
    for (let i = 0; i < sc.reps; i++) {
      const t0 = Date.now();
      try {
        const resp = await client.chat.completions.create({
          model: m.name,
          messages: [{ role: 'system', content: sc.system }, { role: 'user', content: sc.user }],
          max_tokens: sc.maxTokens,
          temperature: 0,
        }, { timeout: TIMEOUT_MS });
        const choice = resp.choices?.[0];
        const msg = choice?.message || {};
        const s = summarize(msg.content);
        const toolCalls = (msg.tool_calls || []).length;
        console.log(
          `[${sname} #${i + 1}] ${((Date.now() - t0) / 1000).toFixed(1)}s finish=${choice?.finish_reason} ` +
          `content_len=${s.len} jsonish=${s.jsonish} tool_calls=${toolCalls} ` +
          `usage(prompt=${resp.usage?.prompt_tokens}, completion=${resp.usage?.completion_tokens}, reasoning=${resp.usage?.completion_tokens_details?.reasoning_tokens ?? 'n/a'})`
        );
        if (s.len > 0 && s.len <= 200) console.log(`   head: ${s.head}`);
        if (s.len > 200) console.log(`   head: ${s.head}...`);
      } catch (e) {
        console.log(`[${sname} #${i + 1}] ${((Date.now() - t0) / 1000).toFixed(1)}s EXC: ${String(e?.message || e).slice(0, 140).replace(/\s+/g, ' ')}`);
      }
    }
  }
}
console.log('\nprobe done');
