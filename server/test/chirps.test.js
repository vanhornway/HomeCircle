// Chirps (a sound, and maybe a flash, on someone's phone) and most visited
// places (each phone's own summary, end-to-end encrypted).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/index.js';
import { CircleClient, CHIRP_SOUNDS } from '../../packages/core/src/index.js';

const SETUP = 'test-setup-token-chirp';
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

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'homecircle-chirps-'));
  app = createApp({
    version: 'test',
    dataDir: dir,
    setupToken: SETUP,
    trustProxy: false,
    messageRetentionDays: 90,
    locationRequestCooldown: 60,
    inviteMaxHours: 168,
    push: 'none',
    tileUrl: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
    tileAttribution: 'OSM',
    webClient: false,
  });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  url = `http://127.0.0.1:${app.server.address().port}`;
});

after(async () => {
  for (const c of [mom, dad, kid]) c.disconnect();
  await app.close();
  rmSync(dir, { recursive: true, force: true });
});

const mom = client();
const dad = client();
const kid = client();

test('the server says it supports chirps and most visited places', async () => {
  const info = await CircleClient.serverInfo(url);
  assert.equal(info.chirps, true);
  assert.equal(info.frequentPlaces, true);
});

test('a chirp reaches one person with the sender’s own sound', async () => {
  await mom.createCircle({ serverUrl: url, setupToken: SETUP, name: 'Mom', circleName: 'Family' });
  await dad.joinWithInvite((await mom.createInvite()).link, { name: 'Dad' });
  await kid.joinWithInvite((await mom.createInvite()).link, { name: 'Kid' });
  await mom.setChirp('wren');
  assert.equal(mom.me.chirp, 'wren');
  await assert.rejects(() => mom.setChirp('vuvuzela'), /Unknown chirp/);

  dad.connect();
  await waitOnline(dad);
  await dad.refresh();
  const live = waitFor(dad, 'chirp');
  const res = await mom.chirp(dad.account.memberId, { flash: true });
  assert.deepEqual(res, { sent: 1, remaining: 2, cooldownUntil: null });
  await live;
  const [c] = await dad.collectChirps();
  assert.equal(c.name, 'Mom');
  assert.equal(c.sound, 'wren');
  assert.equal(c.flash, true);
  assert.equal(c.from, mom.account.memberId);
  // Collected once; Kid got nothing.
  assert.deepEqual(await dad.collectChirps(), []);
  assert.deepEqual(await kid.collectChirps(), []);
});

test('chirping everyone reaches every other member; no sound picked yet means the first one', async () => {
  await kid.refresh();
  const res = await kid.chirp(null);
  assert.equal(res.sent, 2);
  const [toMom] = await mom.collectChirps();
  const [toDad] = await dad.collectChirps();
  assert.equal(toMom.name, 'Kid');
  assert.equal(toDad.sound, CHIRP_SOUNDS[0]);
  assert.equal(toMom.flash, false);
});

test('three chirps in a row, then 30 minutes off; separately for a person and for everyone', async () => {
  const dadId = dad.account.memberId;
  assert.equal((await mom.chirp(dadId)).remaining, 1); // second (the first was above)
  const third = await mom.chirp(dadId);
  assert.equal(third.remaining, 0);
  assert.ok(third.cooldownUntil > Date.now() + 29 * 60_000);
  await assert.rejects(
    () => mom.chirp(dadId),
    (e) => e.status === 429 && e.code === 'chirp_cooldown' && e.cooldownUntil === third.cooldownUntil && /30 min/.test(e.message),
  );
  // Other targets have their own count.
  assert.equal((await mom.chirp(kid.account.memberId)).sent, 1);
  assert.equal((await mom.chirp(null)).sent, 2);

  // After the break, a new run of three.
  app.store.db.prepare('UPDATE chirp_limits SET blocked_until = ?, last_at = ? WHERE key = ?').run(Date.now() - 1, Date.now() - 31 * 60_000, `${mom.account.memberId}>${dadId}`);
  assert.equal((await mom.chirp(dadId)).remaining, 2);
  for (const c of [mom, dad, kid]) await c.collectChirps();
});

test('chirps go only to members of this circle', async () => {
  const other = client();
  await other.createCircle({ serverUrl: url, setupToken: SETUP, name: 'Stranger', circleName: 'Elsewhere' });
  await assert.rejects(() => other.chirp(dad.account.memberId), (e) => e.status === 404);
  await assert.rejects(() => other.chirp(null), (e) => e.status === 409 && e.code === 'nobody');
  await other.deleteCircle();
});

test('most visited places are shared end-to-end encrypted, and can be withdrawn', async () => {
  kid.connect();
  await waitOnline(kid);
  const live = waitFor(kid, 'frequent', (f) => f.has(dad.account.memberId));
  await dad.shareFrequent([
    { id: 'p1', name: 'Costco Wholesale', kind: 'shopping', lat: 37.338231, lng: -121.886329, visits: 4, hours: 3.26, lastAt: Date.now() },
    { id: 'p2', name: 'Home', kind: 'home', lat: 37.3, lng: -121.9, visits: 30, hours: 400, lastAt: Date.now() },
    { id: 'bad', name: 'Nowhere', kind: 'home', lat: 'x', lng: 0 },
  ]);
  const got = (await live).get(dad.account.memberId).places;
  assert.deepEqual(
    got.map((p) => [p.name, p.kind, p.lat, p.hours]),
    [
      ['Costco Wholesale', 'shopping', 37.3382, 3.3],
      ['Home', 'home', 37.3, 400],
    ],
  );
  // The server only stores ciphertext.
  const raw = app.store.db.prepare('SELECT env FROM frequent_places').get().env;
  assert.ok(!raw.includes('Costco'));
  assert.ok(!raw.includes('37.33'));

  const gone = waitFor(kid, 'frequent', (f) => !f.has(dad.account.memberId));
  await dad.clearFrequent();
  await gone;
});

test('no unexpected client errors', () => {
  assert.deepEqual(
    errors.map((e) => e.message),
    [],
  );
});
