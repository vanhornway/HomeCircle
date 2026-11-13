// node --experimental-strip-types --test src/lib/pb.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { all, decode, encode, fixed32, msg, num, patch, sfixed32, str, sub, text, u } from './pb.ts';

test('round trip, with unknown fields kept', () => {
  const m = [u(1, 1800), u(2, true), str(3, 'HomeCircle'), fixed32(4, 0xdeadbeef), msg(7, [u(1, 13)]), u(99, 5)];
  const back = decode(encode(m));
  assert.equal(num(back, 1), 1800);
  assert.equal(num(back, 2), 1);
  assert.equal(text(back, 3), 'HomeCircle');
  assert.equal(num(back, 4), 0xdeadbeef);
  assert.equal(num(sub(back, 7)!, 1), 13);
  assert.equal(num(back, 99), 5, 'a field we don’t know survives');
});

test('patch replaces only what it sets; repeated fields take all the new values', () => {
  const m = decode(encode([u(1, 900), u(8, 3), u(99, 1)]));
  const p = decode(encode(patch(m, [u(8, 7), u(105, true)])));
  assert.equal(num(p, 1), 900);
  assert.equal(num(p, 8), 7);
  assert.equal(num(p, 105), 1);
  assert.equal(num(p, 99), 1);
  const keys = patch(decode(encode([str(3, 'a'), str(3, 'b'), u(1, 1)])), [str(3, 'c')]);
  assert.deepEqual(all(keys, 3).map((f) => new TextDecoder().decode(f.b)), ['c']);
});

test('negative numbers and sfixed32', () => {
  const lat = -122.1234567 * 1e7;
  const buf = new Uint8Array(4);
  new DataView(buf.buffer).setInt32(0, Math.round(lat), true);
  const m = decode(encode([{ n: 2, wire: 5, b: buf }, u(10, -20)]));
  assert.equal(sfixed32(m, 2), Math.round(lat));
  assert.equal(num(m, 10), -20);
});
