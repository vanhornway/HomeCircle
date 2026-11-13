// Tracker helpers: where a tracker was when it sent a message, and when it counts as away.
//   node --experimental-strip-types --test src/lib/trackers.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { CircleClient } from '@homecircle/core';
import { googleMapsUrl, heardNearby, messageSpot, trackerAway } from './trackers.ts';

const MIN = 60_000;
const NOW = 1_800_000_000_000;

// A circle with one tracker (UT2) and a home base that heard it, as the client keeps them.
function circle({ loc, log = [], radio = null }: { loc?: { lat: number; lng: number; ts: number }; log?: { lat: number; lng: number; at: number }[]; radio?: { at: number; hops: number } | null }) {
  const records = new Map<string, unknown>([
    ['ut2', { tracker: { node: '!9e58f8c9', mode: 'carried' } }],
    ['hb', { homeBase: { at: NOW - MIN, every: 1, trackers: [{ node: '!9e58f8c9', log, radio }] } }],
  ]);
  return {
    memberRecord: (id: string) => records.get(id) ?? null,
    memberList: () => [{ id: 'ut2', name: 'UT2' }, { id: 'hb', name: 'Home base' }],
    locations: new Map(loc ? [['ut2', loc]] : []),
  } as unknown as CircleClient;
}

test('a press: the position heard with it, not a later one', () => {
  const pressed = NOW - 60 * MIN;
  const c = circle({
    loc: { lat: 30.3, lng: -97.7, ts: NOW - 2 * MIN }, // it has moved on since
    log: [
      { lat: 30.1, lng: -97.9, at: pressed - 30 * MIN },
      { lat: 30.2, lng: -97.8, at: pressed + 20_000 }, // sent with the press
    ],
  });
  assert.deepEqual(messageSpot(c, 'ut2', pressed), { lat: 30.2, lng: -97.8, at: pressed + 20_000, exact: true });
});

test('no position since: its last one before, marked as not exact', () => {
  const pressed = NOW - 10 * MIN;
  const c = circle({ loc: { lat: 30.1, lng: -97.9, ts: pressed - 40 * MIN } });
  assert.deepEqual(messageSpot(c, 'ut2', pressed), { lat: 30.1, lng: -97.9, at: pressed - 40 * MIN, exact: false });
  assert.equal(messageSpot(circle({ loc: { lat: 1, lng: 2, ts: pressed - 13 * 60 * MIN } }), 'ut2', pressed), null, 'not from another day');
  assert.equal(messageSpot(c, 'hb', pressed), null, 'only trackers');
});

test('google maps link', () => {
  assert.equal(googleMapsUrl(30.26721, -97.74306), 'https://www.google.com/maps/search/?api=1&query=30.267210,-97.743060');
});

test('away: heard directly with an old position is in range, through relays is away', () => {
  const old = { lat: 30.1, lng: -97.9, ts: NOW - 90 * MIN };
  const direct = circle({ loc: old, radio: { at: NOW - 2 * MIN, hops: 0 } });
  assert.equal(heardNearby(direct, 'ut2', NOW), true);
  assert.equal(trackerAway(direct, 'ut2', NOW), false);
  const relayed = circle({ loc: old, radio: { at: NOW - 2 * MIN, hops: 2 } });
  assert.equal(trackerAway(relayed, 'ut2', NOW), true);
  const silent = circle({ loc: old, radio: { at: NOW - 30 * MIN, hops: 0 } });
  assert.equal(trackerAway(silent, 'ut2', NOW), true);
  const fresh = circle({ loc: { ...old, ts: NOW - MIN } });
  assert.equal(trackerAway(fresh, 'ut2', NOW), false);
});
