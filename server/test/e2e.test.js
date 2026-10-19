// End-to-end test: real server + real clients (packages/core) talking over
// HTTP and WebSocket. Verifies the server only ever stores ciphertext.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/index.js';
import { CircleClient } from '../../packages/core/src/index.js';

const SETUP = 'test-setup-token-123';
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
  dir = mkdtempSync(join(tmpdir(), 'homecircle-test-'));
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
    webClient: true,
  });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  url = `http://127.0.0.1:${app.server.address().port}`;
});

after(async () => {
  await app.close();
  rmSync(dir, { recursive: true, force: true });
});

const owner = client();
const bob = client();
const carol = client();

test('setup: wrong code rejected, circle created once', async () => {
  const info = await CircleClient.serverInfo(url);
  assert.equal(info.setup, false);
  await assert.rejects(
    () => client().createCircle({ serverUrl: url, setupToken: 'nope-nope-nope', name: 'X', circleName: 'Y' }),
    (e) => e.code === 'bad_setup_token',
  );
  await owner.createCircle({ serverUrl: url, setupToken: SETUP, name: 'Mom', circleName: 'The Parkers' });
  assert.equal(owner.me.role, 'owner');
  assert.equal(owner.me.name, 'Mom');
  assert.equal(owner.circle.name, 'The Parkers');
  await assert.rejects(
    () => client().createCircle({ serverUrl: url, setupToken: SETUP, name: 'Eve', circleName: 'Hijack' }),
    (e) => e.code === 'already_setup',
  );
});

test('invites: join, preview shows circle, single use', async () => {
  const inv = await owner.createInvite();
  assert.match(inv.link, /\/join#[\w-]+\.[\w-]+$/);
  const preview = await bob.previewInvite(inv.link);
  assert.equal(preview.circleName, 'The Parkers');
  assert.equal(preview.invitedBy, 'Mom');
  await bob.joinWithInvite(inv.link, { name: 'Bob' });
  await assert.rejects(() => client().joinWithInvite(inv.link, { name: 'Again' }), (e) => e.code === 'invalid_invite');

  // A tampered secret can't even preview.
  const bad = inv.link.replace(/\.([\w-]+)$/, '.' + 'A'.repeat(43));
  await assert.rejects(() => client().previewInvite(bad), (e) => e.code === 'invalid_invite');

  const inv2 = await owner.createInvite({ hours: 1 });
  await carol.joinWithInvite(inv2.appLink, { name: 'Carol' });

  await owner.refresh();
  const names = owner.memberList().map((m) => m.name).sort();
  assert.deepEqual(names, ['Bob', 'Carol', 'Mom']);
  assert.ok(owner.memberList().every((m) => m.verified && m.current));
  assert.equal(bob.members.get(owner.account.memberId).safetyNumber, owner.me.safetyNumber);
});

test('locations are end-to-end encrypted and pushed live', async () => {
  await Promise.all([owner.start(), bob.start(), carol.start()]);
  await Promise.all([waitOnline(owner), waitOnline(bob), waitOnline(carol)]);

  const live = waitFor(owner, 'locations', (l) => l.get(bob.account.memberId)?.lat === 40.712776);
  await bob.shareLocation({ lat: 40.712776, lng: -74.005974, accuracy: 12, battery: 0.81, trigger: 'update' });
  await live;
  const fresh = client();
  Object.assign(fresh, { account: owner.account, api: owner.api, members: owner.members });
  await fresh.fetchLocations();
  assert.equal(fresh.locations.get(bob.account.memberId).lng, -74.005974);
  assert.equal(fresh.locations.get(bob.account.memberId).battery, 0.81);
});

test('location requests reach open apps and are rate limited', async () => {
  const got = waitFor(bob, 'locationRequest');
  const res = await owner.requestLocations();
  assert.equal(res.requested, 2);
  assert.equal(res.online, 2);
  assert.equal((await got).from, owner.account.memberId);
  await assert.rejects(() => owner.requestLocations(), (e) => e.status === 429 && e.retryAfter > 0);
});

test('chat and places', async () => {
  const got = waitFor(bob, 'newMessage');
  await carol.sendChat('Pick up milk 🥛');
  const m = await got;
  assert.equal(m.kind, 'chat');
  assert.equal(m.body.text, 'Pick up milk 🥛');
  assert.equal(m.from, carol.account.memberId);

  const placeEvt = waitFor(bob, 'places', (p) => p.size === 1);
  await owner.savePlace({ name: 'Home', lat: 40.7, lng: -74, radius: 120, icon: 'home' });
  const places = await placeEvt;
  assert.equal([...places.values()][0].name, 'Home');

  await carol.sendEvent({ type: 'place', action: 'arrived', placeName: 'Home' });
  await bob.fetchMessages();
  assert.equal(bob.messages.at(-1).kind, 'event');
});

test('server cannot read anything', () => {
  const files = readdirSync(dir).filter((f) => f.startsWith('homecircle.db'));
  const raw = files.map((f) => readFileSync(join(dir, f)).toString('latin1')).join('');
  for (const secret of ['Mom', 'Bob', 'Carol', 'The Parkers', '40.712776', '74.005974', 'milk', 'Home']) {
    assert.ok(!raw.includes(secret), `database contains plaintext "${secret}"`);
  }
});

test('forged or tampered envelopes are rejected by clients', async () => {
  // Carol signs a location claiming to be Bob: outer sender mismatch.
  const forged = carol._seal('location', { lat: 1, lng: 1 });
  assert.equal(owner._decodeLocation(bob.account.memberId, forged, Date.now())?.lat === 1, false);
  // Flip a byte of the ciphertext.
  const env = bob._seal('location', { lat: 2, lng: 2 });
  const ct = env.ct.slice(0, 10) + (env.ct[10] === 'A' ? 'B' : 'A') + env.ct.slice(11);
  assert.equal(owner._decodeLocation(bob.account.memberId, { ...env, ct }, Date.now())?.lat === 2, false);
  // A chat message replayed as a location.
  const chat = bob._seal('chat', { text: 'hi' });
  assert.equal(owner._open(chat, bob.account.memberId, ['location']), null);
});

test('removing a member rotates the key and locks them out', async () => {
  const carolId = carol.account.memberId;
  const carolToken = carol.account.token;
  const removed = waitFor(carol, 'removed');
  const rotated = waitFor(bob, 'members', () => bob.account.epoch === 2, 5000);
  await owner.removeMember(carolId);
  await removed;
  assert.equal(carol.account, null);
  assert.equal(owner.account.epoch, 2);
  await rotated;
  assert.ok(bob.account.keyring[2]);
  assert.notEqual(bob.account.keyring[2], bob.account.keyring[1]);

  // Old token is dead.
  const res = await fetch(`${url}/api/v1/state`, { headers: { Authorization: `Bearer ${carolToken}` } });
  assert.equal(res.status, 401);

  // New-epoch data decrypts for remaining members only.
  const live = waitFor(owner, 'locations', (l) => l.get(bob.account.memberId)?.lat === 51.5);
  await bob.shareLocation({ lat: 51.5, lng: -0.12 });
  await live;
  const loc = (await owner.api.locations()).locations.find((l) => l.memberId === bob.account.memberId);
  assert.equal(loc.env.epoch, 2);

  // Writes with the old key are refused.
  const stale = bob._seal('location', { lat: 0, lng: 0 }, 1);
  await assert.rejects(() => bob.api.putLocation(stale), (e) => e.code === 'stale_epoch');
});

test('new member after rotation sees re-sealed places and circle name', async () => {
  const inv = await owner.createInvite();
  const dave = client();
  await dave.joinWithInvite(inv.link, { name: 'Dave' });
  await dave.fetchPlaces();
  assert.equal([...dave.places.values()][0]?.name, 'Home');
  assert.equal(dave.circle.name, 'The Parkers');
  assert.ok(dave.members.get(owner.account.memberId).verified);
  dave.disconnect();
});

test('roles: members cannot invite or remove', async () => {
  await assert.rejects(() => bob.createInvite(), (e) => e.status === 403);
  await assert.rejects(() => bob.api.removeMember(owner.account.memberId), (e) => e.status === 403);
  await owner.setRole(bob.account.memberId, 'admin');
  await bob.refresh();
  assert.equal(bob.isAdmin, true);
});

test('web client is served with a strict CSP', async () => {
  const res = await fetch(`${url}/`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-security-policy'), /script-src 'self'/);
  const core = await (await fetch(`${url}/core/crypto.js`)).text();
  assert.match(core, /from '\/vendor\/tweetnacl\.mjs'/);
  assert.equal((await fetch(`${url}/core/../src/index.js`)).status, 404);
});

after(() => {
  owner.disconnect();
  bob.disconnect();
  const unexpected = errors.filter((e) => !/Could not open encrypted data/.test(e.message));
  assert.deepEqual(unexpected.map((e) => e.message), []);
});
