// When the phone's voice counts as started, checked with plain Node:
//   node --test --experimental-strip-types src/companion/speechWatch.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { captionMs, watchStart } from './speechWatch.ts';

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const fast = { withinMs: 40, everyMs: 5 };

test('no start event, but the engine is speaking: it did not fail', async () => {
  let failed = 0;
  watchStart(async () => true, () => failed++, fast);
  await wait(80);
  assert.equal(failed, 0);
});

test('the engine starts late, within the time allowed: it did not fail', async () => {
  let failed = 0;
  let calls = 0;
  watchStart(async () => ++calls > 3, () => failed++, fast);
  await wait(80);
  assert.equal(failed, 0);
});

test('never speaking: it fails once', async () => {
  let failed = 0;
  watchStart(async () => false, () => failed++, fast);
  await wait(80);
  assert.equal(failed, 1);
});

test('asking the engine throws: treated as not speaking', async () => {
  let failed = 0;
  watchStart(() => Promise.reject(new Error('gone')), () => failed++, fast);
  await wait(80);
  assert.equal(failed, 1);
});

test('the start event arrives: the watch ends', async () => {
  let failed = 0;
  const w = watchStart(async () => false, () => failed++, fast);
  w.started();
  await wait(80);
  assert.equal(failed, 0);
});

test('a newer line cancels the watch', async () => {
  let failed = 0;
  const w = watchStart(async () => false, () => failed++, fast);
  w.cancel();
  await wait(80);
  assert.equal(failed, 0);
});

test('short lines stay up long enough to read, long ones longer', () => {
  assert.equal(captionMs('سلام'), 6000);
  assert.ok(captionMs('ا'.repeat(100)) > 6000);
});
