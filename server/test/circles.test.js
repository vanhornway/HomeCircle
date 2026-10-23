// Several circles on one server: each is fully isolated from the others.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createApp } from '../src/index.js';
import { openDb } from '../src/db.js';
import { CircleClient } from '../../packages/core/src/index.js';

const SETUP = 'test-setup-token-456';
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
const client = (opts = {}) => new CircleClient({ storage: new MemoryStorage(), onError: (e) => errors.push(e), ...opts });
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

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'homecircle-circles-'));
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
  for (const c of [me, meParents, wife, dad]) c.disconnect();
  await app.close();
  rmSync(dir, { recursive: true, force: true });
});

// One phone, two circles: same storage, separate account keys.
const phone = new MemoryStorage();
const me = client({ storage: phone, accountKey: 'homecircle.account' });
const meParents = client({ storage: phone, accountKey: 'homecircle.account.parents' });
const wife = client();
const dad = client();

test('the server admin creates a second circle; others cannot', async () => {
  await me.createCircle({ serverUrl: url, setupToken: SETUP, name: 'Umair', circleName: 'Home' });
  assert.equal(me.isServerAdmin, true);
  const info = await CircleClient.serverInfo(url);
  assert.equal(info.multiCircle, true);
  assert.equal(info.circleId, me.circleId);

  await wife.joinWithInvite((await me.createInvite()).link, { name: 'Sara' });
  assert.equal(wife.isServerAdmin, false);
  await assert.rejects(
    () => client().createCircle({ serverUrl: url, admin: wife, name: 'Sara', circleName: 'Mine' }),
    (e) => e.status === 403,
  );
  // The setup code keeps working after the first circle, for a separate circle.
  const viaCode = client();
  await viaCode.createCircle({ serverUrl: url, setupToken: SETUP, name: 'Umair', circleName: 'Second' });
  assert.notEqual(viaCode.circleId, me.circleId);
  assert.equal(viaCode.isServerAdmin, true);
  await viaCode.deleteCircle();

  await meParents.createCircle({ serverUrl: url, admin: me, name: 'Umair', circleName: 'Parents & siblings' });
  assert.equal(meParents.me.role, 'owner');
  assert.equal(meParents.isServerAdmin, true);
  assert.notEqual(meParents.circleId, me.circleId);
  assert.equal((await CircleClient.serverInfo(url)).circleId, null);

  // Both accounts live side by side on the phone.
  const reloaded = client({ storage: phone, accountKey: 'homecircle.account' });
  assert.ok(await reloaded.load());
  assert.equal(reloaded.circleId, me.circleId);

  const inv = await meParents.createInvite();
  const preview = await dad.previewInvite(inv.link);
  assert.equal(preview.circleName, 'Parents & siblings');
  await dad.joinWithInvite(inv.link, { name: 'Dad' });
});

test('members, messages, locations and places never cross circles', async () => {
  await Promise.all([me, meParents, wife, dad].map((c) => c.start()));
  await Promise.all([me, meParents, wife, dad].map(waitOnline));

  assert.deepEqual(me.memberList().map((m) => m.name).sort(), ['Sara', 'Umair']);
  assert.deepEqual(dad.memberList().map((m) => m.name).sort(), ['Dad', 'Umair']);

  // Chat in Home reaches Home, not the parents' circle.
  const got = waitFor(me, 'newMessage');
  let leaked = false;
  const off = dad.on('newMessage', () => (leaked = true));
  await wife.sendChat('Dinner at 7');
  assert.equal((await got).body.text, 'Dinner at 7');
  await sleep(200);
  off();
  assert.equal(leaked, false);
  await dad.fetchMessages();
  assert.ok(dad.messages.every((m) => m.body?.text !== 'Dinner at 7'));
  assert.equal((await dad.api.messages(0, 500)).messages.length, 0);

  // Locations.
  await wife.shareLocation({ lat: 37.33, lng: -121.88 });
  await dad.shareLocation({ lat: 33.68, lng: -117.82 });
  const homeIds = (await me.api.locations()).locations.map((l) => l.memberId);
  const parentIds = (await meParents.api.locations()).locations.map((l) => l.memberId);
  assert.deepEqual(homeIds, [wife.account.memberId]);
  assert.deepEqual(parentIds, [dad.account.memberId]);

  // Locate only reaches your own circle.
  const res = await meParents.requestLocations();
  assert.equal(res.requested, 1);

  // Places: another circle can't see, overwrite or delete them.
  const placeId = await wife.savePlace({ name: 'School', lat: 37.3, lng: -121.9 });
  assert.equal((await dad.api.places()).places.length, 0);
  await assert.rejects(() => dad.api.deletePlace(placeId), (e) => e.status === 404);
  await assert.rejects(() => dad.api.putPlace(placeId, dad._seal('place', { id: placeId, name: 'X', lat: 0, lng: 0 })), (e) => e.status === 409);
  await me.fetchPlaces();
  assert.equal(me.places.get(placeId)?.name, 'School');

  // Members of another circle can't be removed or promoted.
  await assert.rejects(() => meParents.api.removeMember(wife.account.memberId), (e) => e.status === 404);
  await assert.rejects(() => meParents.api.setRole(wife.account.memberId, 'admin'), (e) => e.status === 404);
});

test('turning off sharing with one circle removes your location only there', async () => {
  const gone = waitFor(meParents, 'locations', (l) => !l.has(dad.account.memberId));
  await meParents.fetchLocations();
  assert.ok(meParents.locations.has(dad.account.memberId));
  await dad.clearLocation();
  await gone;
  assert.equal((await meParents.api.locations()).locations.length, 0);
  assert.equal((await me.api.locations()).locations.length, 1);
});

test('one phone can register the same push token in each circle', () => {
  const token = 'ExponentPushToken[same-phone-token]';
  const a = app.store.member(me.circleId, me.account.memberId);
  const b = app.store.member(meParents.circleId, meParents.account.memberId);
  app.store.setPush(a, token, 'android');
  app.store.setPush(b, token, 'android');
  assert.equal(app.store.member(me.circleId, a.id).pushToken, token);
  assert.equal(app.store.member(meParents.circleId, b.id).pushToken, token);
});

test('removing someone rotates only that circle’s key', async () => {
  const parentsEpoch = meParents.account.epoch;
  await me.removeMember(wife.account.memberId);
  assert.equal(me.account.epoch, 2);
  await meParents.refresh();
  assert.equal(meParents.account.epoch, parentsEpoch);
  assert.equal(app.store.circle(meParents.circleId).epoch, parentsEpoch);
});

test('the owner can delete a circle; the other circle is untouched', async () => {
  const dadToken = dad.account.token;
  const removed = waitFor(dad, 'removed');
  await assert.rejects(() => dad.api.deleteCircle(), (e) => e.status === 403);
  await meParents.deleteCircle();
  await removed;
  assert.equal(meParents.account, null);
  const res = await fetch(`${url}/api/v1/state`, { headers: { Authorization: `Bearer ${dadToken}` } });
  assert.equal(res.status, 401);
  await me.refresh();
  assert.equal(me.circle.name, 'Home');
  assert.equal((await CircleClient.serverInfo(url)).circleId, me.circleId);
});

test('changing address checks the circle with this device’s token', async () => {
  const other = client();
  await other.joinWithInvite((await me.createInvite()).link, { name: 'Kid' });
  const info = await other.changeServer(url.replace('127.0.0.1', 'localhost'));
  assert.equal(info.circleId, me.circleId);
  other.disconnect();
});

test('a single-circle database from an older server is upgraded in place', () => {
  const old = mkdtempSync(join(tmpdir(), 'homecircle-old-'));
  const db = new DatabaseSync(join(old, 'homecircle.db'));
  db.exec(`
    CREATE TABLE meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);
    CREATE TABLE members (id TEXT PRIMARY KEY, role TEXT NOT NULL, box_pub TEXT NOT NULL, sign_pub TEXT NOT NULL,
      profile TEXT NOT NULL, token_hash TEXT UNIQUE, push_token TEXT, push_platform TEXT, joined_at INTEGER NOT NULL,
      last_seen_at INTEGER, removed_at INTEGER);
    CREATE TABLE invites (id TEXT PRIMARY KEY, auth_hash TEXT NOT NULL, wrapped TEXT NOT NULL, epoch INTEGER NOT NULL,
      created_by TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, used_by TEXT, used_at INTEGER, revoked_at INTEGER);
    CREATE TABLE key_envelopes (epoch INTEGER NOT NULL, member_id TEXT NOT NULL, from_id TEXT NOT NULL, env TEXT NOT NULL,
      created_at INTEGER NOT NULL, PRIMARY KEY (epoch, member_id));
    CREATE TABLE locations (member_id TEXT PRIMARY KEY, env TEXT NOT NULL, updated_at INTEGER NOT NULL);
    CREATE TABLE messages (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, from_id TEXT NOT NULL,
      env TEXT NOT NULL, created_at INTEGER NOT NULL);
    CREATE TABLE places (id TEXT PRIMARY KEY, env TEXT NOT NULL, updated_by TEXT NOT NULL, updated_at INTEGER NOT NULL);
    INSERT INTO meta VALUES ('circle_id','oldcircle1'),('epoch','3'),('rotation_needed','0'),
      ('circle_env','{"epoch":3,"nonce":"n","ct":"c"}'),('circle_by','owner1'),('created_at','1700000000000');
    INSERT INTO members (id, role, box_pub, sign_pub, profile, token_hash, joined_at) VALUES
      ('owner1','owner','b','s','{}','h1',1),('kid1','member','b','s','{}','h2',2);
    INSERT INTO messages (id, from_id, env, created_at) VALUES ('m1','kid1','{}',3);
    INSERT INTO places VALUES ('p1','{}','owner1',4);
  `);
  db.close();

  const store = openDb(old);
  assert.equal(store.circleCount(), 1);
  const c = store.circle('oldcircle1');
  assert.equal(c.epoch, 3);
  assert.equal(c.by, 'owner1');
  assert.equal(store.memberByToken('h1').circleId, 'oldcircle1');
  assert.equal(store.memberByToken('h1').serverAdmin, true);
  assert.equal(store.memberByToken('h2').serverAdmin, false);
  assert.equal(store.messagesAfter('oldcircle1', 'kid1', 0, 10).length, 1);
  assert.equal(store.places('oldcircle1').length, 1);
  assert.equal(store.getMeta('circle_id'), null);
  store.close();
  // Opening again is a no-op.
  const again = openDb(old);
  assert.equal(again.circleCount(), 1);
  again.close();
  rmSync(old, { recursive: true, force: true });
});

after(() => {
  const unexpected = errors.filter((e) => !/Could not open encrypted data/.test(e.message));
  assert.deepEqual(unexpected.map((e) => e.message), []);
});
