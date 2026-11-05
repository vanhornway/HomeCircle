// Someone walking along a place's edge: "left" then "arrived" a moment apart.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { QUICK_RETURN_MS, quickReturns } from '../../packages/core/src/places.js';

const MIN = 60_000;
let n = 0;
const ev = (from, placeId, action, at) => ({ id: `m${++n}`, kind: 'event', from, ts: at, body: { type: 'place', action, placeId, placeName: 'School', at } });
const ids = (...ms) => new Set(ms.map((m) => m.id));

test('left and back within 3 minutes: both entries go', () => {
  const a = ev('zara', 'school', 'left', 0);
  const b = ev('zara', 'school', 'arrived', 2 * MIN);
  assert.deepEqual(quickReturns([a, b]), ids(a, b));
});

test('exactly at the limit still counts, a moment over does not', () => {
  const a = ev('zara', 'school', 'left', 0);
  assert.equal(quickReturns([a, ev('zara', 'school', 'arrived', QUICK_RETURN_MS)]).size, 2);
  assert.equal(quickReturns([a, ev('zara', 'school', 'arrived', QUICK_RETURN_MS + 1)]).size, 0);
});

test('a real trip stays', () => {
  const list = [ev('zara', 'school', 'left', 0), ev('zara', 'school', 'arrived', 40 * MIN)];
  assert.equal(quickReturns(list).size, 0);
});

test('still gone: the "left" stays, departures are never held back', () => {
  assert.equal(quickReturns([ev('zara', 'school', 'left', 0)]).size, 0);
});

test('a different person or a different place does not cancel', () => {
  assert.equal(quickReturns([ev('zara', 'school', 'left', 0), ev('leo', 'school', 'arrived', MIN)]).size, 0);
  assert.equal(quickReturns([ev('zara', 'school', 'left', 0), ev('zara', 'gym', 'arrived', MIN)]).size, 0);
});

test('arriving then leaving is not a quick return', () => {
  assert.equal(quickReturns([ev('zara', 'school', 'arrived', 0), ev('zara', 'school', 'left', MIN)]).size, 0);
});

test('several classes in a row: every pair goes, the real departure stays', () => {
  const pairs = [ev('zara', 'school', 'left', 0), ev('zara', 'school', 'arrived', MIN), ev('zara', 'school', 'left', 50 * MIN), ev('zara', 'school', 'arrived', 52 * MIN)];
  const home = ev('zara', 'school', 'left', 200 * MIN);
  assert.deepEqual(quickReturns([...pairs, home]), ids(...pairs));
});

test('other messages in between do not matter', () => {
  const a = ev('zara', 'school', 'left', 0);
  const b = ev('zara', 'school', 'arrived', MIN);
  const chat = { id: 'c1', kind: 'chat', from: 'mum', ts: 30_000, body: { text: 'hi' } };
  assert.deepEqual(quickReturns([a, chat, b]), ids(a, b));
});
