// Tracker helpers: where a tracker was when it sent a message, and when it counts as away.
//   node --experimental-strip-types --test src/lib/trackers.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { CircleClient } from '@homecircle/core';
import { googleMapsUrl, heardNearby, messageSpot, trackerAway, trackerStatusLine, trackerVia } from './trackers.ts';

const MIN = 60_000;
const NOW = 1_800_000_000_000;

// A circle with one tracker (UT2) and a home base that heard it, as the client keeps them.
const HOME = { id: 'home', name: 'Home', lat: 30.1, lng: -97.9, radius: 150, homeBase: true };
function circle({ loc, log = [], radio = null, home = HOME }: { loc?: { lat: number; lng: number; ts: number; accuracy?: number; mesh?: object }; log?: { lat: number; lng: number; at: number }[]; radio?: { at: number; hops: number } | null; home?: typeof HOME | null }) {
  const records = new Map<string, unknown>([
    ['ut2', { tracker: { node: '!9e58f8c9', mode: 'carried' } }],
    ['hb', { homeBase: { at: NOW - MIN, every: 1, trackers: [{ node: '!9e58f8c9', log, radio }] } }],
  ]);
  return {
    memberRecord: (id: string) => records.get(id) ?? null,
    memberList: () => [{ id: 'ut2', name: 'UT2' }, { id: 'hb', name: 'Home base' }],
    locations: new Map(loc ? [['ut2', loc]] : []),
    places: new Map(home ? [[home.id, home]] : []),
    homeBasePlace: () => (home?.homeBase ? home : null),
    members: new Map([['ut2', { id: 'ut2', name: 'UT2' }]]),
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

test('away is where it is, like a person: outside the Home place, however it was heard', () => {
  const atHome = { lat: 30.1, lng: -97.9, ts: NOW - 90 * MIN };
  const farAway = { lat: 30.3, lng: -97.7, ts: NOW - 90 * MIN };
  assert.equal(trackerAway(circle({ loc: atHome }), 'ut2', NOW), false);
  assert.equal(trackerAway(circle({ loc: farAway }), 'ut2', NOW), true, 'old or not, its last position is away');
  assert.equal(trackerAway(circle({ loc: farAway, home: { ...HOME, homeBase: false } }), 'ut2', NOW), true, 'a place called Home counts');
  assert.equal(trackerAway(circle({ loc: farAway, home: null }), 'ut2', NOW), false, 'no Home place: can’t say');
  assert.equal(trackerAway(circle({}), 'ut2', NOW), false, 'never heard: can’t say');
  const direct = circle({ loc: atHome, radio: { at: NOW - 2 * MIN, hops: 0 } });
  assert.equal(heardNearby(direct, 'ut2', NOW), true);
});

test('its line says where, how fresh, and how it got here', () => {
  const where = () => '';
  const fresh = { lat: 30.3, lng: -97.7, ts: NOW - 5 * MIN };
  assert.equal(trackerStatusLine(circle({ loc: { ...fresh, mesh: { hops: 0 } } }), 'ut2', NOW, where), 'Away · 5 min ago · in range of home');
  assert.equal(trackerStatusLine(circle({ loc: { ...fresh, mesh: { hops: 2 } } }), 'ut2', NOW, where), 'Away · 5 min ago · via 2 relays');
  assert.equal(
    trackerStatusLine(circle({ loc: { ...fresh, mesh: { src: 'internet', gateway: 'Uncle’s node' } } }), 'ut2', NOW, where),
    'Away · 5 min ago · via internet (Uncle’s node)',
  );
  assert.equal(trackerStatusLine(circle({ loc: { ...fresh, ts: NOW - 3 * 60 * MIN, mesh: { src: 'beacon' } } }), 'ut2', NOW, where), 'Away · last seen 3 h ago · via public mesh');
  assert.equal(trackerStatusLine(circle({ loc: { lat: 30.1, lng: -97.9, ts: NOW - 20_000 } }), 'ut2', NOW, () => 'At Home'), 'At Home · just now · over radio');
  assert.equal(trackerStatusLine(circle({}), 'ut2', NOW, where), 'Not heard yet');
  assert.equal(trackerVia({ mesh: { src: 'phone', gateway: 'Sara’s phone' } } as never), 'via Sara’s phone');
});

test('firmware versions', async () => {
  const { compareVersions } = await import('./trackers.ts');
  assert.equal(compareVersions('0.29.0', '0.28.1'), 1);
  assert.equal(compareVersions('0.28.1', '0.29.0'), -1);
  assert.equal(compareVersions('0.29.0', 'v0.29.0'), 0);
  assert.equal(compareVersions('0.29.0', '0.29.0-test'), 1, 'a release is newer than its test build');
  assert.equal(compareVersions('0.30.0-test', '0.29.0'), 1);
  assert.equal(compareVersions('1.0', '0.99.9'), 1);
});

test('a person and their tracker apart: who left what behind', async () => {
  const { separation, separationText } = await import('./trackers.ts');
  const home = { id: 'home', name: 'Home', lat: 30.1, lng: -97.9, radius: 150, homeBase: true };
  const make = (phone: { lat: number; lng: number }, tag: { lat: number; lng: number }, age = 2 * MIN) =>
    ({
      memberRecord: (id: string) => (id === 'ut2' ? { tracker: { node: '!9e58f8c9', mode: 'carried', carriedBy: 'umair' } } : null),
      memberList: () => [{ id: 'umair', name: 'Umair' }, { id: 'ut2', name: 'UT2' }],
      locations: new Map([
        ['umair', { ...phone, ts: NOW - age, accuracy: 20 }],
        ['ut2', { ...tag, ts: NOW - age, accuracy: 10 }],
      ]),
      places: new Map([['home', home]]),
      homeBasePlace: () => home,
      members: new Map(),
    }) as unknown as CircleClient;
  const away = { lat: 30.2, lng: -97.8 };
  const atHome = { lat: 30.1, lng: -97.9 };
  assert.equal(separation(make(atHome, atHome), 'umair', NOW), null, 'together');
  assert.equal(separationText(separation(make(away, atHome), 'umair', NOW)!), '⚠️ left UT2 at home');
  assert.equal(separationText(separation(make(atHome, away), 'umair', NOW)!), '⚠️ UT2 is out without this phone');
  assert.match(separationText(separation(make(away, { lat: 30.25, lng: -97.75 }), 'umair', NOW)!), /^⚠️ \d+(\.\d)? km from UT2$/);
  assert.equal(separation(make(away, atHome, 40 * MIN), 'umair', NOW), null, 'old positions say nothing');
});
