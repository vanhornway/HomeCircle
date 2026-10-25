// A circle's features: chosen when it's made, changed by admins, refused by
// the server where it can (chirps, Locate, …), all on for older circles.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/index.js';
import { openDb } from '../src/db.js';
import { CircleClient, FEATURES, defaultFeatures, hasFeature } from '../../packages/core/src/index.js';

const SETUP = 'test-setup-token-features';
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
const client = () => new CircleClient({ storage: new MemoryStorage() });

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'homecircle-features-'));
  app = createApp({
    version: 'test',
    dataDir: dir,
    setupToken: SETUP,
    trustProxy: 0,
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
  await app.close();
  rmSync(dir, { recursive: true, force: true });
});

const mom = client();
const dad = client();

test('the defaults: chat, check-ins, low battery, circle health, lists and reminders on; the rest off', () => {
  const on = Object.entries(defaultFeatures())
    .filter(([, v]) => v)
    .map(([k]) => k);
  assert.deepEqual(on, ['locationSharing', 'checkIns', 'lowBattery', 'groupChat', 'directMessages', 'readReceipts', 'circleHealth', 'shoppingLists', 'reminders']);
  // Lists and reminders need the helper, which starts off.
  assert.equal(hasFeature(defaultFeatures(), 'shoppingLists'), false);
  assert.equal(hasFeature({ ...defaultFeatures(), agent: true }, 'shoppingLists'), true);
  assert.equal(new Set(FEATURES.map((f) => f.id)).size, FEATURES.length);
});

test('a new circle gets the features its owner chose; members see them', async () => {
  await mom.createCircle({ serverUrl: url, setupToken: SETUP, name: 'Mom', circleName: 'Family', features: { ...defaultFeatures(), polls: true } });
  await dad.joinWithInvite((await mom.createInvite()).link, { name: 'Dad' });
  assert.equal(dad.feature('polls'), true);
  assert.equal(dad.feature('chirps'), false);
  assert.equal(dad.feature('groupChat'), true);
});

test('what the server can refuse, it refuses while off', async () => {
  await assert.rejects(() => dad.chirp(mom.account.memberId), (e) => e.status === 403 && e.code === 'feature_off' && /Chirps are turned off in this circle/.test(e.message));
  await assert.rejects(() => dad.api.requestLocations([mom.account.memberId]), (e) => e.code === 'feature_off' && /Locate is turned off/.test(e.message));
  await assert.rejects(() => mom.createAgentInvite({ name: 'Jarvis' }), (e) => e.code === 'feature_off' && /The circle helper is turned off/.test(e.message));
});

test('admins change features; everyone hears; members can’t', async () => {
  await assert.rejects(() => dad.setFeatures({ chirps: true }), (e) => e.status === 403);
  await mom.setFeatures({ chirps: true, nonsense: true });
  await dad.refresh();
  assert.equal(dad.feature('chirps'), true);
  assert.equal(dad.features.nonsense, undefined);
  await dad.chirp(mom.account.memberId);
});

test('circles from before features keep everything on; an older app making a circle gets everything', async () => {
  const old = mkdtempSync(join(tmpdir(), 'homecircle-features-old-'));
  try {
    // A 0.12 database: circles without the features column.
    openDb(old).close();
    const db = new DatabaseSync(join(old, 'homecircle.db'));
    db.exec('ALTER TABLE circles DROP COLUMN features');
    db.prepare("INSERT INTO circles (id, epoch, rotation_needed, retention_days, env, env_by, created_at) VALUES ('c-old', 1, 0, 90, '{}', 'm', 1)").run();
    db.close();
    const store = openDb(old);
    assert.equal(Object.values(store.circle('c-old').features).every(Boolean), true);
    store.close();
  } finally {
    rmSync(old, { recursive: true, force: true });
  }
  // An app from before features: its new circle request has no features.
  const gran = client();
  const makeApi = gran._makeApi.bind(gran);
  gran._makeApi = (...a) => {
    const api = makeApi(...a);
    const create = api.createCircle;
    api.createCircle = (body) => {
      delete body.features;
      return create(body);
    };
    return api;
  };
  await gran.createCircle({ serverUrl: url, admin: mom, name: 'Gran', circleName: 'Old app' });
  assert.equal(Object.values(gran.features).every(Boolean), true);
  assert.equal(gran.feature('chirps'), true);
});
