// The agent's AI providers (against fake servers, no real calls) and name
// swapping.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { complete, cleanProviderConfig, parseJson, LlmError } from '../src/agent/llm.js';
import { nameSwapper } from '../src/agent/names.js';

// A fake provider: records each request, answers with whatever `reply` says.
const seen = [];
let reply = () => ({ status: 200, body: {} });
const server = createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    seen.push({ url: req.url, headers: req.headers, body: JSON.parse(body || '{}') });
    const r = reply(seen.at(-1));
    res.writeHead(r.status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(r.body));
  });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;
after(() => server.close());

const anthropicReply = (text, usage = { input_tokens: 1000, output_tokens: 200 }, stop = 'end_turn') => ({
  status: 200,
  body: { id: 'msg_1', type: 'message', role: 'assistant', model: 'x', content: [{ type: 'text', text }], stop_reason: stop, usage },
});

test('provider settings are checked; Claude prices are known, others are given', () => {
  assert.throws(() => cleanProviderConfig({ provider: 'nope' }), /Pick an AI provider/);
  assert.throws(() => cleanProviderConfig({ provider: 'anthropic', model: 'claude-opus-5-5' }), /API key/);
  const c = cleanProviderConfig({ provider: 'anthropic', model: 'claude-opus-5-5', apiKey: 'sk-test' });
  assert.deepEqual([c.inUsd, c.outUsd], [4, 20]);
  assert.throws(() => cleanProviderConfig({ provider: 'openai', model: 'some-model', apiKey: 'k' }), /price per million/);
  const local = cleanProviderConfig({ provider: 'other', model: 'llama3', baseUrl: 'http://192.168.1.20:11434/v1/', inUsd: 0, outUsd: 0 });
  assert.equal(local.baseUrl, 'http://192.168.1.20:11434/v1');
});

test('Anthropic: low effort, a JSON schema when asked, server-side fallback on Opus and Sonnet, cost from usage', async () => {
  reply = () => anthropicReply('{"intent":"free_time","days":5}');
  const cfg = cleanProviderConfig({ provider: 'anthropic', model: 'claude-opus-5-5', apiKey: 'sk-test' });
  const schema = { type: 'object', properties: { intent: { type: 'string' }, days: { type: 'integer' } }, required: ['intent', 'days'], additionalProperties: false };
  const r = await complete(cfg, { system: 'You help a family.', messages: [{ role: 'user', content: 'When are the kids free?' }], schema }, { anthropicBaseUrl: base });
  assert.deepEqual(r.json, { intent: 'free_time', days: 5 });
  // 1000 in × $4/M + 200 out × $20/M
  assert.equal(r.usd.toFixed(4), '0.0080');
  const sent = seen.at(-1);
  assert.equal(sent.url.split('?')[0], '/v1/messages');
  assert.equal(sent.headers['x-api-key'], 'sk-test');
  assert.match(sent.headers['anthropic-beta'], /server-side-fallback-2026-07-01/);
  assert.equal(sent.body.fallbacks, 'default');
  assert.deepEqual(sent.body.output_config, { effort: 'low', format: { type: 'json_schema', schema } });
  assert.equal(sent.body.system, 'You help a family.');

  // Haiku has no server-side fallback: none sent.
  const haiku = cleanProviderConfig({ provider: 'anthropic', model: 'claude-haiku-5-5', apiKey: 'sk-test' });
  await complete(haiku, { system: 's', messages: [{ role: 'user', content: 'hi' }] }, { anthropicBaseUrl: base });
  assert.equal(seen.at(-1).body.fallbacks, undefined);
  assert.equal(seen.at(-1).headers['anthropic-beta'], undefined);
});

test('Anthropic: a refusal is reported, not shown as an answer; a bad key says so', async () => {
  const cfg = cleanProviderConfig({ provider: 'anthropic', model: 'claude-sonnet-5-5', apiKey: 'sk-test' });
  reply = () => anthropicReply('', { input_tokens: 10, output_tokens: 0 }, 'refusal');
  const r = await complete(cfg, { system: 's', messages: [{ role: 'user', content: 'x' }] }, { anthropicBaseUrl: base });
  assert.equal(r.refused, true);
  reply = () => ({ status: 401, body: { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } } });
  await assert.rejects(
    () => complete(cfg, { system: 's', messages: [{ role: 'user', content: 'x' }] }, { anthropicBaseUrl: base }),
    (e) => e instanceof LlmError && e.auth,
  );
});

test('OpenAI-style providers: chat completions, JSON mode, cost from usage', async () => {
  reply = () => ({ status: 200, body: { choices: [{ message: { content: '```json\n{"intent":"recall"}\n```' } }], usage: { prompt_tokens: 2000, completion_tokens: 100 } } });
  const cfg = cleanProviderConfig({ provider: 'other', model: 'family-model', apiKey: 'k1', baseUrl: `${base}/v1`, inUsd: 1, outUsd: 2 });
  const r = await complete(cfg, { system: 'You help.', messages: [{ role: 'user', content: 'What did we decide?' }], schema: { type: 'object' } });
  assert.deepEqual(r.json, { intent: 'recall' });
  assert.equal(r.usd.toFixed(4), '0.0022');
  const sent = seen.at(-1);
  assert.equal(sent.url, '/v1/chat/completions');
  assert.equal(sent.headers.authorization, 'Bearer k1');
  assert.equal(sent.body.messages[0].role, 'system');
  assert.deepEqual(sent.body.response_format, { type: 'json_object' });
});

test('JSON is read from a reply with or without a fence', () => {
  assert.deepEqual(parseJson('{"a":1}'), { a: 1 });
  assert.deepEqual(parseJson('Sure!\n```json\n{"a":2}\n```'), { a: 2 });
  assert.deepEqual(parseJson('Here: {"a":3} done'), { a: 3 });
  assert.equal(parseJson('no json'), null);
});

test('names are swapped out before the provider sees them, and back in the answer', () => {
  const s = nameSwapper({ people: ['Mom', 'Kid', 'Sam'], places: ['Lincoln Elementary', 'Lincoln'] });
  const masked = s.mask('Are Kid and Sam free? Kid goes to Lincoln Elementary; Mom drives to Lincoln. Kidney beans stay.');
  assert.equal(masked, 'Are Person B and Person C free? Person B goes to Place 1; Person A drives to Place 2. Kidney beans stay.');
  assert.equal(s.unmask('Person B and Person C are both off Nov 25–30 (Place 1 is closed).'), 'Kid and Sam are both off Nov 25–30 (Lincoln Elementary is closed).');
});
