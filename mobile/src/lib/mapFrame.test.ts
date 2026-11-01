// What the family map opens on, and chips for people out of view.
//   node --experimental-strip-types --test src/lib/mapFrame.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { distanceKm, edgeChips, edgePoint, groups, inside, openingFrame } from './mapFrame.ts';

// The demo family: home, school and the library in Austin; Nani in Lahore.
const me = { id: 'me', lat: 30.2672, lng: -97.7431, ts: 10 };
const kid = { id: 'kid', lat: 30.2849, lng: -97.7341, ts: 9 };
const dad = { id: 'dad', lat: 30.2500, lng: -97.75, ts: 8 };
const nani = { id: 'nani', lat: 31.5204, lng: 74.3587, ts: 7 };
const ids = (ps: { id: string }[]) => ps.map((p) => p.id);

test('distances', () => {
  assert.equal(Math.round(distanceKm(me, me)), 0);
  // Austin to Lahore is about 13,000 km.
  assert.ok(Math.abs(distanceKm(me, nani) - 13_100) < 300);
});

test('a family in one town is one group; Nani abroad is another', () => {
  assert.deepEqual(groups([me, nani, kid, dad]).map(ids), [['me', 'kid', 'dad'], ['nani']]);
  // A chain links up: each within reach of the next.
  const a = { id: 'a', lat: 0, lng: 0 };
  const b = { id: 'b', lat: 0, lng: 0.4 }; // ~44 km on
  const c = { id: 'c', lat: 0, lng: 0.8 };
  assert.deepEqual(groups([a, c, b]).map(ids), [['a', 'c', 'b']]);
  assert.deepEqual(groups([a, c]).map(ids), [['a'], ['c']]);
  assert.deepEqual(groups([]), []);
});

test('opens on the people near you, with Nani as an away group', () => {
  const { frame, away } = openingFrame([me, kid, nani, dad], 'me');
  assert.deepEqual(ids(frame), ['me', 'kid', 'dad']);
  assert.deepEqual(away.map(ids), [['nani']]);
});

test('just you: you', () => {
  assert.deepEqual(openingFrame([me], 'me'), { frame: [me], away: [] });
});

test('one other person and no location for you: them', () => {
  assert.deepEqual(openingFrame([nani], 'me'), { frame: [nani], away: [] });
});

test('nobody has a location yet (or sharing is off): nothing to fit', () => {
  assert.deepEqual(openingFrame([], 'me'), { frame: [], away: [] });
});

test('no location for you: the biggest group', () => {
  const { frame, away } = openingFrame([nani, kid, dad], 'me');
  assert.deepEqual(ids(frame), ['kid', 'dad']);
  assert.deepEqual(away.map(ids), [['nani']]);
  // No one signed in on this phone yet, same thing.
  assert.deepEqual(ids(openingFrame([nani, kid, dad], null).frame), ['kid', 'dad']);
});

test('you on a trip: the family at home, with you as a chip', () => {
  const paris = { id: 'me', lat: 48.8566, lng: 2.3522, ts: 11 };
  const { frame, away } = openingFrame([paris, kid, dad, nani], 'me');
  assert.deepEqual(ids(frame), ['kid', 'dad']);
  assert.deepEqual(away.map(ids), [['me'], ['nani']]);
});

test('everyone far from everyone: you, or the freshest', () => {
  const tokyo = { id: 'aunt', lat: 35.68, lng: 139.69, ts: 12 };
  const { frame, away } = openingFrame([nani, me, tokyo], 'me');
  assert.deepEqual(ids(frame), ['me']);
  assert.deepEqual(away.map(ids), [['nani'], ['aunt']]);
  assert.deepEqual(ids(openingFrame([nani, tokyo], 'me').frame), ['aunt']);
});

test('two groups the same size: the one with the freshest location', () => {
  const k2 = { ...kid, ts: 1 };
  const d2 = { ...dad, ts: 2 };
  const n1 = { ...nani, ts: 5 };
  const n2 = { id: 'nana', lat: 31.53, lng: 74.35, ts: 3 };
  assert.deepEqual(ids(openingFrame([k2, d2, n1, n2], null).frame), ['nani', 'nana']);
  // All the same age: the first.
  const same = [kid, dad, nani, n2].map((p) => ({ ...p, ts: 1 }));
  assert.deepEqual(ids(openingFrame(same, null).frame), ['kid', 'dad']);
});

// A 400 × 800 map with a 100 px bar on top and a 300 px drawer below.
const visible = { left: 0, top: 100, right: 400, bottom: 500 };
const W = 140;
const H = 36;

test('a point in view needs no chip', () => {
  assert.ok(inside({ x: 200, y: 300 }, visible));
  assert.ok(!inside({ x: 200, y: 600 }, visible));
  assert.deepEqual(edgeChips([[{ id: 'kid', x: 200, y: 300 }]], visible, visible, W, H), []);
});

test('chips sit on the edge facing the person, wholly inside the area', () => {
  // Far to the right, level with the middle.
  const r = edgePoint({ x: 5000, y: 300 }, visible, W, H);
  assert.equal(r.side, 'right');
  assert.equal(r.left, 400 - W);
  assert.equal(r.top, 300 - H / 2);
  assert.equal(Math.round(r.angle), 0);
  // Above and to the left.
  const tl = edgePoint({ x: -5000, y: -5000 }, visible, W, H);
  assert.ok(tl.left >= 0 && tl.top >= 100);
  assert.ok(tl.angle < -90 && tl.angle > -180);
  // Straight down, behind the drawer.
  const d = edgePoint({ x: 200, y: 700 }, visible, W, H);
  assert.equal(d.side, 'bottom');
  assert.equal(d.top, 500 - H);
  assert.equal(d.left, 200 - W / 2);
  assert.equal(Math.round(d.angle), 90);
});

test('one chip per group, aimed at the ones out of view', () => {
  const chips = edgeChips(
    [
      [{ id: 'kid', x: 200, y: 300 }, { id: 'dad', x: 9000, y: 300 }],
      [{ id: 'nani', x: -8000, y: 300 }],
      [{ id: 'aunt', x: 200, y: 300 }],
    ],
    visible,
    visible,
    W,
    H,
  );
  assert.deepEqual(
    chips.map((c) => [c.ids, c.side]),
    [
      [['dad'], 'right'],
      [['nani'], 'left'],
    ],
  );
});

test('chips on the same edge are moved apart, and kept in the area', () => {
  const area = { ...visible, bottom: visible.bottom - 80 }; // clear of the SOS button
  const chips = edgeChips(
    [[{ id: 'a', x: 5000, y: 5300 }], [{ id: 'b', x: 5000, y: 5310 }], [{ id: 'c', x: 5000, y: 5320 }]],
    visible,
    area,
    W,
    H,
  );
  const tops = chips.map((c) => c.top).sort((a, b) => a - b);
  assert.ok(chips.every((c) => c.side === 'right'));
  for (let i = 1; i < tops.length; i++) assert.ok(tops[i] - tops[i - 1] >= H);
  assert.ok(tops[0] >= area.top && tops.at(-1)! + H <= area.bottom);
});

test('a point with no position (not on the map yet) is skipped', () => {
  assert.deepEqual(edgeChips([[{ id: 'x', x: NaN, y: 1 }]], visible, visible, W, H), []);
});
