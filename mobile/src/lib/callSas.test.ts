// The call's four words:  node --test --experimental-strip-types src/lib/callSas.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SAS_WORDS, sasWords } from './callSas.ts';

test('there are 256 different words, one per byte', () => {
  assert.equal(SAS_WORDS.length, 256);
  assert.equal(new Set(SAS_WORDS).size, 256);
  assert.ok(SAS_WORDS.every((w) => /^[a-z]{3,10}$/.test(w)));
});

test('both phones get the same four words, whichever one started the call', () => {
  const a = ['sha-256 AA:BB'];
  const b = ['sha-256 CC:DD'];
  assert.deepEqual(sasWords(a, b), sasWords(b, a));
  assert.equal(sasWords(a, b).length, 4);
});

test('a different certificate on either side changes the words', () => {
  const a = ['sha-256 AA:BB'];
  const b = ['sha-256 CC:DD'];
  const swapped = ['sha-256 EE:FF'];
  assert.notDeepEqual(sasWords(a, b), sasWords(a, swapped));
  assert.notDeepEqual(sasWords(a, b), sasWords(swapped, b));
});
