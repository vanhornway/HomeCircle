// Journeys: while a tracker is "on the move", the server keeps each position it
// posts, sealed as it came; phones open them to draw the way it went, and end
// the journey once it has been away and is back inside Home.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/index.js';
import { CircleClient, allFeatures } from '../../packages/core/src/index.js';

const SETUP = 'test-setup-journeys';
let app;
let url;
let dir;
class MemoryStorage {
  constructor() {
    this.m = new Map();
  }
  async getItem(k) {
    return this.m.get(k) ?? null;
  }
  async setItem(k, v) {
    this.m.set(k, v);
  }
  async removeItem(k) {
    this.m.delete(k);
  }
}
const errors = [];
const client = () => new CircleClient({ storage: new MemoryStorage(), onError: (e) => errors.push(e) });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'homecircle-journeys-'));
  app = createApp({ version: 'test', dataDir: dir, setupToken: SETUP, trustProxy: false, messageRetentionDays: 90, locationRequestCooldown: 60, inviteMaxHours: 168, push: 'none', tileUrl: 'x', tileAttribution: 'x', webClient: false, meshPublicMqtt: 'off', journeyGapMs: 0 });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  url = `http://127.0.0.1:${app.server.address().port}`;
});
after(async () => {
  await app.close();
  rmSync(dir, { recursive: true, force: true });
});

const HOME = { lat: 37.5485, lng: -121.9886 };
const AWAY = [
  { lat: 37.5531, lng: -121.9802 },
  { lat: 37.5602, lng: -121.9711 },
  { lat: 37.5650, lng: -121.9650 },
];

test('a tracker on the move: its way is kept, drawn, and the journey ends once it is back home', async () => {
  const mom = client();
  const hb = client();
  const ut = client();
  const kid = client();
  await mom.createCircle({ features: { ...allFeatures(), meshtastic: true }, serverUrl: url, setupToken: SETUP, name: 'Mom', circleName: 'Family' });
  for (const [c, name] of [[hb, 'Home base'], [ut, 'UT1'], [kid, 'Kid']]) await c.joinWithInvite((await mom.createInvite()).link, { name });
  await ut.api.req('PUT', '/members/me/keeper', { keeper: hb.account.memberId });
  await mom.savePlace({ name: 'Home', ...HOME, radius: 150 });
  await mom.fetchPlaces();
  await mom.refresh();

  // A journey is for a tracker or for yourself, not for another person.
  await assert.rejects(kid.startJourney(mom.account.memberId), (e) => e.status === 403);
  const own = await kid.startJourney(kid.account.memberId);
  await kid.endJourney(own.id);

  await ut.shareLocation({ ...HOME, accuracy: 10 });
  const j = await kid.startJourney(ut.account.memberId);
  assert.equal(j.points, 1, 'where it is now is where it starts');
  assert.equal((await mom.startJourney(ut.account.memberId)).id, j.id, 'one open journey per tracker');
  await mom.refresh();
  assert.equal(mom.journeys.get(ut.account.memberId)?.id, j.id, 'open journeys come with the state');

  for (const p of AWAY) {
    await wait(5);
    await ut.shareLocation({ ...p, accuracy: 10 });
  }
  const { points } = await mom.journeyPath(j.id);
  assert.deepEqual(points.map((p) => [p.lat, p.lng]), [[HOME.lat, HOME.lng], ...AWAY.map((p) => [p.lat, p.lng])], 'the way it went, in order, opened on the phone');

  // Away: nothing ends it.
  await mom.fetchLocations();
  await wait(50);
  assert.equal((await mom.journeyList(ut.account.memberId))[0].endedAt, null);

  // Back home: the journey ends at the time it got there, even though the phone notices later.
  await wait(5);
  await ut.shareLocation({ ...HOME, accuracy: 10 });
  const backAt = (await mom.journeyPath(j.id)).points.at(-1).at;
  await wait(5);
  await ut.shareLocation({ lat: HOME.lat + 0.0002, lng: HOME.lng, accuracy: 10 });
  await mom.fetchLocations();
  for (let i = 0; i < 50 && mom.journeys.has(ut.account.memberId); i++) await wait(20);
  const [ended] = await mom.journeyList(ut.account.memberId);
  assert.equal(ended.endReason, 'home');
  assert.equal(ended.endedAt, backAt);
  assert.equal(ended.points, 5, 'positions after it got home are dropped');
  assert.equal(mom.journeys.has(ut.account.memberId), false);

  // After it ended, nothing more is kept.
  await ut.shareLocation({ ...AWAY[0], accuracy: 10 });
  assert.equal((await mom.journeyPath(j.id)).points.length, 5);

  // Deleting: whoever started it, or an admin; not someone else.
  const j2 = await mom.startJourney(ut.account.memberId);
  await mom.endJourney(j2.id);
  await assert.rejects(kid.deleteJourney(j2.id), (e) => e.status === 403);
  await mom.deleteJourney(j2.id);
  assert.equal((await mom.journeyList(ut.account.memberId)).length, 1);

  // Another circle can't see them.
  const other = client();
  await other.createCircle({ features: allFeatures(), serverUrl: url, setupToken: SETUP, name: 'X', circleName: 'Other' }).catch(() => null);
  if (other.api) await assert.rejects(other.journeyPath(j.id), (e) => e.status === 404);

  // A removed tracker's journeys go with it.
  await mom.removeMember(ut.account.memberId);
  await assert.rejects(mom.journeyPath(j.id), (e) => e.status === 404);
  assert.deepEqual(errors, []);
});
