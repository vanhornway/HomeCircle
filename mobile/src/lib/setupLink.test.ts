// Reading the first page's QR code, checked with plain Node:
//   node --test --experimental-strip-types src/lib/setupLink.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSetupLink } from './setupLink.ts';

test('the code from a server', () => {
  assert.deepEqual(parseSetupLink('https://homecircle-parker.onrender.com/start#t=7KQ2M9PX'), { server: 'https://homecircle-parker.onrender.com', ticket: '7KQ2M9PX' });
  assert.deepEqual(parseSetupLink(' http://192.168.1.20:8080/start#t=7KQ2M9PX\n'), { server: 'http://192.168.1.20:8080', ticket: '7KQ2M9PX' });
});

test('anything else is not a setup code', () => {
  assert.equal(parseSetupLink('https://example.com/join#abc.def'), null);
  assert.equal(parseSetupLink('https://example.com/start'), null);
  assert.equal(parseSetupLink('hello'), null);
});
