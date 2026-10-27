// The JSON schemas the agent sends follow Anthropic's structured-output rules.
// The end-to-end tests use a fake AI that never reads them, so a schema the
// real API rejects (like a type list next to an enum) would only show up live.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { UNDERSTAND, NOTES_ONLY, PDF_EVENTS, DREAM, UPLOAD } from '../src/agent/brain.js';

const TYPES = new Set(['object', 'array', 'string', 'integer', 'number', 'boolean', 'null']);
const UNSUPPORTED = ['minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf', 'minLength', 'maxLength', 'minItems', 'maxItems', 'uniqueItems', 'pattern'];
const fits = (v, type) => (type === 'null' ? v === null : type === 'integer' ? Number.isInteger(v) : type === 'number' ? typeof v === 'number' : typeof v === type);

/** Every rule broken anywhere in the schema, with where. */
function problems(s, at = '$') {
  const out = [];
  if (s.anyOf) return s.anyOf.flatMap((x, i) => problems(x, `${at}.anyOf[${i}]`));
  if (typeof s.type !== 'string' || !TYPES.has(s.type)) out.push(`${at}: type must be one name (use anyOf for null), got ${JSON.stringify(s.type)}`);
  for (const k of UNSUPPORTED) if (k in s) out.push(`${at}: ${k} isn't supported`);
  if (s.enum) for (const v of s.enum) if (!fits(v, s.type)) out.push(`${at}: enum value ${JSON.stringify(v)} isn't a ${s.type}`);
  if (s.type === 'object') {
    if (s.additionalProperties !== false) out.push(`${at}: objects need additionalProperties: false`);
    const keys = Object.keys(s.properties ?? {});
    for (const r of s.required ?? []) if (!keys.includes(r)) out.push(`${at}: required ${r} isn't a property`);
    for (const k of keys) out.push(...problems(s.properties[k], `${at}.${k}`));
  }
  if (s.type === 'array') out.push(...problems(s.items ?? {}, `${at}[]`));
  return out;
}

test('the schemas the agent sends follow the structured-output rules', () => {
  assert.deepEqual(problems(UNDERSTAND), []);
  assert.deepEqual(problems(NOTES_ONLY), []);
  assert.deepEqual(problems(PDF_EVENTS), []);
  assert.deepEqual(problems(DREAM), []);
  assert.deepEqual(problems(UPLOAD), []);
});

/** How big a schema is for the provider to compile: its properties, and its unions (each anyOf). */
function size(s) {
  const add = (a, b) => ({ props: a.props + b.props, unions: a.unions + b.unions });
  if (s.anyOf) return s.anyOf.reduce((n, x) => add(n, size(x)), { props: 0, unions: 1 });
  let out = { props: Object.keys(s.properties ?? {}).length, unions: 0 };
  for (const p of Object.values(s.properties ?? {})) out = add(out, size(p));
  if (s.items) out = add(out, size(s.items));
  return out;
}

test('the schemas stay small enough to compile: 0.19.0’s note format was rejected as “too large”', () => {
  // 0.19.0 sent 52 properties and 13 unions to understand a message, and every question failed.
  for (const [name, s] of Object.entries({ UNDERSTAND, NOTES_ONLY, DREAM, UPLOAD })) {
    const { props, unions } = size(s);
    assert.ok(props <= 45, `${name} has ${props} properties`);
    assert.ok(unions <= 10, `${name} has ${unions} unions`);
  }
});

test('the check catches what the API rejected: an enum next to a type list', () => {
  const bad = { type: 'object', properties: { role: { type: ['string', 'null'], enum: ['kid', 'adult', null] } }, required: ['role'], additionalProperties: false };
  assert.ok(problems(bad).some((p) => p.startsWith('$.role: type must be one name')));
});
