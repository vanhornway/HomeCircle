// Direct messages, message retention and paused sharing.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/index.js';
import { CircleClient, seal, directKey, approximate, placeState, distanceM } from '../../packages/core/src/index.js';

const SETUP = 'test-setup-token-789';
let app;
let url;
let dir;

class MemoryStorage {
  constructor() {
    this.m = new Map();
  }
  async getItem(k) {
    return this.m.has(k) ? this.m.get(k) : null;
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
const waitFor = (c, event, pred = () => true, ms = 3000) =>
  new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout waiting for ${event}`)), ms);
    const off = c.on(event, (d) => {
      if (pred(d)) {
        clearTimeout(t);
        off();
        resolve(d);
      }
    });
  });
const waitOnline = (c) => (c.status === 'online' ? Promise.resolve() : waitFor(c, 'status', (s) => s === 'online'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const mom = client();
const dad = client();
const kid = client();

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'homecircle-msg-'));
  app = createApp({
    version: 'test',
    dataDir: dir,
    setupToken: SETUP,
    trustProxy: false,
    locationRequestCooldown: 60,
    inviteMaxHours: 168,
    push: 'none',
    tileUrl: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
    tileAttribution: 'OSM',
    webClient: false,
  });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  url = `http://127.0.0.1:${app.server.address().port}`;
  await mom.createCircle({ serverUrl: url, setupToken: SETUP, name: 'Mom', circleName: 'Family' });
  await dad.joinWithInvite((await mom.createInvite()).link, { name: 'Dad' });
  await kid.joinWithInvite((await mom.createInvite()).link, { name: 'Kid' });
  await Promise.all([mom, dad, kid].map((c) => c.start()));
  await Promise.all([mom, dad, kid].map(waitOnline));
  await mom.refresh();
});

after(async () => {
  for (const c of [mom, dad, kid]) c.disconnect();
  await app.close();
  rmSync(dir, { recursive: true, force: true });
});

test('direct messages reach only the two people in them', async () => {
  const got = waitFor(dad, 'newMessage', (m) => m.peer === mom.account.memberId);
  let leaked = false;
  const off = kid.on('messages', (ms) => {
    if (ms.some((m) => m.body?.text === 'Anniversary gift idea?')) leaked = true;
  });
  await mom.sendChat('Anniversary gift idea?', { to: dad.account.memberId });
  const m = await got;
  assert.equal(m.body.text, 'Anniversary gift idea?');
  assert.equal(m.to, dad.account.memberId);
  await sleep(200);
  off();
  assert.equal(leaked, false);

  // The server never hands the DM to anyone else in the circle.
  const kidView = (await kid.api.messages(0, 500)).messages;
  assert.equal(kidView.filter((x) => x.to).length, 0);
  await kid.fetchMessages();
  assert.equal(kid.conversation(mom.account.memberId).length, 0);

  // Replies, and both sides can read the whole conversation after a restart.
  await dad.sendChat('Flowers 💐', { to: mom.account.memberId });
  const fresh = client();
  Object.assign(fresh, { account: mom.account, api: mom.api, members: mom.members });
  await fresh.fetchMessages();
  assert.deepEqual(
    fresh.conversation(dad.account.memberId).map((x) => x.body.text),
    ['Anniversary gift idea?', 'Flowers 💐'],
  );
  assert.deepEqual(fresh.directPeers(), [dad.account.memberId]);
  // Not mixed into the group chat.
  assert.ok(fresh.conversation(null).every((x) => !x.to));
});

test('a direct message can’t be read with the circle key or redirected', async () => {
  // Kid has the circle key but not the pair's direct key.
  const dm = (await mom.api.messages(0, 500)).messages.find((x) => x.to === dad.account.memberId);
  assert.equal(kid._open(dm.env, dm.from, ['chat'], dm.to), null);
  assert.equal(kid._open(dm.env, dm.from, ['chat']), null);
  // Re-targeting a DM to someone else fails verification on their phone.
  const env = seal({
    kind: 'chat',
    from: mom.account.memberId,
    to: dad.account.memberId,
    circle: mom.circleId,
    epoch: mom.account.epoch,
    key: directKey(mom.account.identity.boxSecret, kid.account.identity.boxPub),
    signSecret: mom.account.identity.signSecret,
    body: { text: 'meant for dad' },
  });
  assert.equal(kid._open(env, mom.account.memberId, ['chat'], kid.account.memberId), null);
  // Only members of the circle can be messaged.
  await assert.rejects(() => mom.api.postMessage('x'.repeat(16), mom._seal('chat', { text: 'x' }), { to: 'nobody-here-12345' }), (e) => e.status === 404);
});

test('direct-message reactions stay in the conversation', async () => {
  await dad.fetchMessages();
  const target = dad.conversation(mom.account.memberId)[0];
  await dad.react(target.id, '❤️');
  await mom.fetchMessages();
  assert.deepEqual(mom.reactionsFor(target.id).map((r) => r.emoji), ['❤️']);
  await kid.fetchMessages();
  assert.deepEqual(kid.reactionsFor(target.id), []);
});

test('nothing readable is stored', () => {
  const files = readdirSync(dir).filter((f) => f.startsWith('homecircle.db'));
  const raw = Buffer.concat(files.map((f) => readFileSync(join(dir, f))));
  for (const secret of ['Anniversary', 'Flowers', '💐']) assert.ok(!raw.includes(Buffer.from(secret)), secret);
});

test('admins choose how long messages are kept; never more than a year', async () => {
  assert.equal(mom.retention.days, 90);
  assert.deepEqual(mom.retention.choices, [1, 7, 30, 90, 365]);
  await assert.rejects(() => dad.setRetention(7), (e) => e.status === 403);
  await assert.rejects(() => mom.setRetention(400), (e) => e.status === 400);
  await assert.rejects(() => mom.setRetention(5), (e) => e.status === 400);
  const changed = waitFor(dad, 'circle', () => dad.retention.days === 7);
  await mom.setRetention(7);
  await changed;

  // Messages older than the circle's setting are deleted, DMs included.
  const old = Date.now() - 8 * 86400_000;
  app.store.db.prepare('UPDATE messages SET created_at = ? WHERE circle_id = ?').run(old, mom.circleId);
  await mom.sendChat('fresh');
  app.store.pruneMessages(Date.now(), 365);
  const left = (await mom.api.messages(0, 500)).messages;
  assert.equal(left.length, 1);

  // A server can't be configured to keep anything longer than a year.
  const capped = createApp({ ...app.config, dataDir: mkdtempSync(join(tmpdir(), 'homecircle-cap-')) });
  assert.equal(capped.config.maxRetentionDays, 365);
  await capped.close();
});

test('pausing shares "paused", not a stale location', async () => {
  await kid.shareLocation({ lat: 10, lng: 20 });
  await mom.fetchLocations();
  assert.equal(mom.locations.get(kid.account.memberId).lat, 10);
  const seen = waitFor(mom, 'locations', () => mom.paused.has(kid.account.memberId));
  await kid.pauseSharing();
  await seen;
  assert.equal(mom.locations.has(kid.account.memberId), false);
  await dad.fetchLocations();
  assert.ok(dad.paused.has(kid.account.memberId));
  assert.equal(dad.locations.has(kid.account.memberId), false);
  // Sharing again clears it.
  await kid.shareLocation({ lat: 11, lng: 21 });
  await dad.fetchLocations();
  assert.equal(dad.paused.has(kid.account.memberId), false);
  assert.equal(dad.locations.get(kid.account.memberId).lat, 11);
});

test('anyone in the circle can ask anyone else for their location', async () => {
  const got = waitFor(mom, 'locationRequest');
  let dadAsked = false;
  const off = dad.on('locationRequest', () => (dadAsked = true));
  const res = await kid.requestLocations([mom.account.memberId]);
  assert.equal(res.requested, 1);
  assert.equal((await got).from, kid.account.memberId);
  await sleep(150);
  off();
  assert.equal(dadAsked, false, 'Locate on one person must only reach that person');
});

test('each person has their own Locate cooldown, separate from refresh everyone', async () => {
  // Mom was just asked: asking again waits, but Dad and "everyone" don't.
  await assert.rejects(() => kid.requestLocations([mom.account.memberId]), (e) => e.status === 429 && e.retryAfter > 0);
  const dadGot = waitFor(dad, 'locationRequest');
  assert.equal((await kid.requestLocations([dad.account.memberId])).requested, 1);
  await dadGot;
  const all = await kid.requestLocations();
  assert.equal(all.requested, 2);
  await assert.rejects(() => kid.requestLocations(), (e) => e.status === 429);
});

test('check-ins: a one-tap "where are you?" between two people', async () => {
  const asked = waitFor(dad, 'newMessage', (m) => m.body?.checkin === 'request');
  const located = waitFor(dad, 'locationRequest');
  await mom.askToCheckIn(dad.account.memberId);
  const req = await asked;
  assert.equal(req.peer, mom.account.memberId);
  assert.match(req.body.text, /Where are you/);
  await located;
  const ok = waitFor(mom, 'newMessage', (m) => m.body?.checkin === 'ok');
  await dad.checkIn(mom.account.memberId);
  assert.equal((await ok).from, dad.account.memberId);
  await kid.fetchMessages();
  assert.ok(kid.messages.every((m) => !m.body?.checkin), 'check-ins are private to the two people');
});

test('approximate sharing and pause reasons reach the circle sealed', async () => {
  const fine = { lat: 37.33467, lng: -121.88812 };
  const rough = approximate(fine);
  assert.ok(Math.abs(rough.lat - 37.33) < 1e-9 && Math.abs(rough.lng + 121.89) < 1e-9);
  assert.equal(rough.accuracy, 1000);
  await kid.shareLocation({ ...rough, approx: true });
  await mom.fetchLocations();
  const seen = mom.locations.get(kid.account.memberId);
  assert.equal(seen.approximate, true);
  assert.equal(seen.lat, rough.lat);
  await kid.pauseSharing('At the dentist');
  await mom.fetchLocations();
  assert.equal(mom.paused.get(kid.account.memberId).reason, 'At the dentist');
});

test('Locate says how it reached each person', async () => {
  // Dad's app is connected, so it's "delivered" live.
  const r1 = await dad.requestLocations([kid.account.memberId]);
  assert.equal(r1.delivery[kid.account.memberId], 'delivered');
});

test('at most 6 Locates per person per hour, even without the 60-second cooldown', async () => {
  const dir2 = mkdtempSync(join(tmpdir(), 'homecircle-cap-'));
  const app2 = createApp({ ...app.config, dataDir: dir2, locationRequestCooldown: 0 });
  await new Promise((r) => app2.server.listen(0, '127.0.0.1', r));
  const url2 = `http://127.0.0.1:${app2.server.address().port}`;
  const a = client();
  const b = client();
  await a.createCircle({ serverUrl: url2, setupToken: SETUP, name: 'A', circleName: 'Cap' });
  await b.joinWithInvite((await a.createInvite()).link, { name: 'B' });
  await a.refresh();
  let ok = 0;
  let limited = 0;
  for (let i = 0; i < 9; i++) {
    try {
      await a.requestLocations([b.account.memberId]);
      ok++;
    } catch (e) {
      assert.equal(e.status, 429);
      limited++;
    }
  }
  assert.equal(ok, 6);
  assert.equal(limited, 3);
  // Refresh everyone isn't counted against one person.
  assert.equal((await a.requestLocations()).requested, 1);
  await app2.close();
  rmSync(dir2, { recursive: true, force: true });
});

test('a place event sent twice with the same id is stored once (outbox retries)', async () => {
  const body = { type: 'place', action: 'arrived', placeId: 'p1', placeName: 'Home', at: Date.now() - 600_000 };
  await kid.sendEvent(body, { id: 'outbox-event-0001' });
  await kid.sendEvent(body, { id: 'outbox-event-0001' }); // retry after "no answer": counts as delivered
  await mom.fetchMessages();
  const events = mom.messages.filter((m) => m.kind === 'event' && m.body?.at === body.at);
  assert.equal(events.length, 1);
  assert.equal(events[0].body.at, body.at, 'keeps the time the phone detected it');
});

test('phone health travels with the location', async () => {
  await kid.shareLocation({ lat: 1, lng: 2, power: 'saver', perm: 'foreground', precise: false });
  await mom.fetchLocations();
  const l = mom.locations.get(kid.account.memberId);
  assert.equal(l.power, 'saver');
  assert.equal(l.perm, 'foreground');
  assert.equal(l.precise, false);
});

test('posting while the app is closed doesn’t skip messages others sent meanwhile', async () => {
  // Dad's app is closed (no live connection) while Mom writes...
  dad.disconnect();
  await mom.sendChat('Dinner at 7?');
  // ...then his phone posts a place event from the background...
  await dad.sendEvent({ type: 'place', action: 'arrived', placeId: 'lib1', placeName: 'Library' });
  // ...and when he opens the app, Mom's message must still show up.
  await dad.catchUp();
  assert.ok(dad.messages.some((m) => m.body?.text === 'Dinner at 7?'), 'Dad missed a message sent while his app was closed');
  assert.equal(dad.messages.filter((m) => m.body?.placeName === 'Library').length, 1);
});

test('place detection needs a margin before counting someone as gone', () => {
  const home = { radius: 100 };
  assert.equal(placeState({ ...home, distance: 40, accuracy: 15 }), 'inside');
  assert.equal(placeState({ ...home, distance: 100, accuracy: 15 }), 'inside');
  // Just past the edge with ordinary GPS: too close to call, so no false "left".
  assert.equal(placeState({ ...home, distance: 115, accuracy: 20 }), null);
  assert.equal(placeState({ ...home, distance: 140, accuracy: 20 }), 'outside');
  // The margin grows with a less precise fix (capped at 100 m).
  assert.equal(placeState({ ...home, distance: 180, accuracy: 120 }), null);
  assert.equal(placeState({ ...home, distance: 210, accuracy: 120 }), 'outside');
  // Very rough fixes only decide when clearly in or out.
  assert.equal(placeState({ ...home, distance: 150, accuracy: 400 }), null);
  assert.equal(placeState({ ...home, distance: 900, accuracy: 400 }), 'outside');
  assert.ok(Math.abs(distanceM({ lat: 37.3382, lng: -121.8863 }, { lat: 37.4221, lng: -122.0841 }) - 19700) < 300);
});

after(() => {
  const unexpected = errors.filter((e) => !/Could not open encrypted data/.test(e.message));
  assert.deepEqual(unexpected.map((e) => e.message), []);
});
