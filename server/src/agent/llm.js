// Talking to the AI provider the circle's admin picked, with their own key
// (they pay the provider directly). Anthropic through its official SDK;
// OpenAI, Gemini, DeepSeek, Mistral, OpenRouter, and anything else that
// speaks the OpenAI-style chat API (including a model on your own machine)
// through that API. Every call reports what it cost, from the tokens used.
import Anthropic from '@anthropic-ai/sdk';

/** Price per million tokens, input and output, in US dollars. */
const ANTHROPIC_MODELS = [
  { id: 'claude-opus-5-5', name: 'Claude Opus 5.5', inUsd: 4, outUsd: 20 },
  { id: 'claude-sonnet-5-5', name: 'Claude Sonnet 5.5', inUsd: 2, outUsd: 10 },
  { id: 'claude-haiku-5-5', name: 'Claude Haiku 5.5', inUsd: 0.1, outUsd: 0.5 },
];

// Models that can hand a declined request to another model server-side.
const FALLBACK_MODELS = new Set(['claude-opus-5-5', 'claude-sonnet-5-5']);

/** What the app offers. For providers other than Anthropic the admin types the model name and its price. */
export const PROVIDERS = {
  anthropic: { name: 'Anthropic (Claude)', models: ANTHROPIC_MODELS, suggested: 'claude-opus-5-5' },
  openai: { name: 'OpenAI', baseUrl: 'https://api.openai.com/v1' },
  gemini: { name: 'Google Gemini', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai' },
  deepseek: { name: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1' },
  mistral: { name: 'Mistral', baseUrl: 'https://api.mistral.ai/v1' },
  openrouter: { name: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1' },
  other: { name: 'Other (OpenAI-compatible address)', baseUrl: null },
};

export class LlmError extends Error {
  constructor(message, { status = null, auth = false } = {}) {
    super(message);
    this.status = status;
    this.auth = auth;
  }
}

/** The provider settings an admin saved, checked: { provider, model, apiKey, baseUrl, inUsd, outUsd }. */
export function cleanProviderConfig(c) {
  const provider = PROVIDERS[c?.provider] ? c.provider : null;
  if (!provider) throw new Error('Pick an AI provider');
  const model = String(c.model || '').trim();
  if (!/^[\w./:@-]{1,100}$/.test(model)) throw new Error('Give a model name');
  const apiKey = String(c.apiKey || '').trim();
  if (!apiKey && provider !== 'other') throw new Error('Paste the API key');
  let baseUrl = PROVIDERS[provider].baseUrl ?? null;
  if (provider === 'other') {
    baseUrl = String(c.baseUrl || '').trim().replace(/\/+$/, '');
    if (!/^https?:\/\/[^\s]+$/.test(baseUrl)) throw new Error('Give the address of the OpenAI-compatible API, e.g. http://192.168.1.20:11434/v1');
  }
  const known = provider === 'anthropic' ? ANTHROPIC_MODELS.find((m) => m.id === model) : null;
  const price = (v) => (Number.isFinite(Number(v)) && Number(v) >= 0 ? Number(v) : null);
  const inUsd = known?.inUsd ?? price(c.inUsd);
  const outUsd = known?.outUsd ?? price(c.outUsd);
  if (inUsd == null || outUsd == null) throw new Error('Give the model’s price per million tokens (0 for a model on your own machine)');
  return { provider, model, apiKey, baseUrl, inUsd, outUsd };
}

/**
 * One request: a system prompt, the conversation, and optionally a JSON
 * schema the answer must follow. Returns { text, json, usd, refused }.
 */
export async function complete(cfg, { system, messages, schema = null, maxTokens = 2000 }, { fetchImpl = fetch, anthropicBaseUrl } = {}) {
  return cfg.provider === 'anthropic'
    ? completeAnthropic(cfg, { system, messages, schema, maxTokens }, anthropicBaseUrl)
    : completeOpenAiStyle(cfg, { system, messages, schema }, fetchImpl);
}

const cost = (cfg, inTokens, outTokens) => (inTokens * cfg.inUsd + outTokens * cfg.outUsd) / 1e6;

// A message's content is text, or a list of parts: { type: 'text', text },
// { type: 'image', mime, data } (base64), { type: 'pdf', data } (base64).
const toAnthropic = (content) =>
  typeof content === 'string'
    ? content
    : content.map((p) =>
        p.type === 'image'
          ? { type: 'image', source: { type: 'base64', media_type: p.mime, data: p.data } }
          : p.type === 'pdf'
            ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: p.data } }
            : { type: 'text', text: p.text },
      );
const toOpenAi = (content) => {
  if (typeof content === 'string') return content;
  if (content.some((p) => p.type === 'pdf')) throw new LlmError('This AI provider can’t read scanned PDFs. Send a photo of each page instead.');
  return content.map((p) => (p.type === 'image' ? { type: 'image_url', image_url: { url: `data:${p.mime};base64,${p.data}` } } : { type: 'text', text: p.text }));
};

async function completeAnthropic(cfg, { system, messages, schema, maxTokens }, baseURL) {
  const client = new Anthropic({ apiKey: cfg.apiKey, ...(baseURL ? { baseURL } : {}), maxRetries: 2, timeout: 120_000 });
  const params = {
    model: cfg.model,
    max_tokens: maxTokens,
    system,
    messages: messages.map((m) => ({ role: m.role, content: toAnthropic(m.content) })),
    // Short family questions: low effort answers well and costs least.
    output_config: { effort: 'low', ...(schema ? { format: { type: 'json_schema', schema } } : {}) },
  };
  let res;
  try {
    res = FALLBACK_MODELS.has(cfg.model)
      ? await client.beta.messages.create({ ...params, betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' })
      : await client.messages.create(params);
  } catch (e) {
    if (e instanceof Anthropic.AuthenticationError || e instanceof Anthropic.PermissionDeniedError) throw new LlmError('The AI provider didn’t accept the API key', { status: e.status, auth: true });
    if (e instanceof Anthropic.RateLimitError) throw new LlmError('The AI provider is busy (rate limited). Try again in a minute.', { status: 429 });
    // The provider's own sentence, not the status code and JSON around it.
    if (e instanceof Anthropic.APIError) throw new LlmError(`The AI provider said: ${e.error?.error?.message ?? e.message}`.slice(0, 300), { status: e.status ?? null });
    throw new LlmError(`Couldn’t reach the AI provider: ${e?.message ?? e}`.slice(0, 300));
  }
  const u = res.usage ?? {};
  // Cache writes cost 1.25× input, reads 0.1×.
  const inTokens = (u.input_tokens ?? 0) + 1.25 * (u.cache_creation_input_tokens ?? 0) + 0.1 * (u.cache_read_input_tokens ?? 0);
  const usd = cost(cfg, inTokens, u.output_tokens ?? 0);
  if (res.stop_reason === 'refusal') return { text: '', json: null, usd, refused: true };
  const text = res.content
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('')
    .trim();
  return { text, json: schema ? parseJson(text) : null, usd, refused: false };
}

async function completeOpenAiStyle(cfg, { system, messages, schema }, fetchImpl) {
  const body = {
    model: cfg.model,
    messages: [
      // Not every provider follows a schema, but they all take JSON mode with the shape in the prompt.
      { role: 'system', content: schema ? `${system}\n\nAnswer with only a JSON object matching this schema:\n${JSON.stringify(schema)}` : system },
      ...messages.map((m) => ({ role: m.role, content: toOpenAi(m.content) })),
    ],
    ...(schema ? { response_format: { type: 'json_object' } } : {}),
  };
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), 120_000);
  let res;
  try {
    res = await fetchImpl(`${cfg.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(cfg.apiKey ? { Authorization: `Bearer ${cfg.apiKey}` } : {}) },
      body: JSON.stringify(body),
      signal: abort.signal,
    });
  } catch (e) {
    throw new LlmError(`Couldn’t reach the AI provider: ${e?.message ?? e}`.slice(0, 300));
  } finally {
    clearTimeout(timer);
  }
  let data = null;
  try {
    data = await res.json();
  } catch {
    /* not JSON */
  }
  if (!res.ok) {
    if (res.status === 401 || res.status === 403) throw new LlmError('The AI provider didn’t accept the API key', { status: res.status, auth: true });
    if (res.status === 429) throw new LlmError('The AI provider is busy (rate limited). Try again in a minute.', { status: 429 });
    throw new LlmError(`The AI provider said: ${data?.error?.message ?? `error ${res.status}`}`.slice(0, 300), { status: res.status });
  }
  const text = String(data?.choices?.[0]?.message?.content ?? '').trim();
  const usd = cost(cfg, data?.usage?.prompt_tokens ?? 0, data?.usage?.completion_tokens ?? 0);
  return { text, json: schema ? parseJson(text) : null, usd, refused: false };
}

/** JSON from a reply, tolerating a ```json fence around it. */
export function parseJson(text) {
  const t = String(text).trim();
  const m = t.match(/```(?:json)?\s*([\s\S]*?)```/);
  try {
    return JSON.parse(m ? m[1] : t);
  } catch {
    const start = t.indexOf('{');
    const end = t.lastIndexOf('}');
    try {
      return start >= 0 && end > start ? JSON.parse(t.slice(start, end + 1)) : null;
    } catch {
      return null;
    }
  }
}
