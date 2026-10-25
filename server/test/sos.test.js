// SOS: a group chat message with the SOS in it, "arrived at" lines, and
// "I'm safe". No server changes; the server only sees ciphertext.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/index.js';
import { CircleClient, allFeatures } from '../../packages/core/src/index.js';

const SETUP = 'test-setup-token-sos';
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

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'homecircle-sos-'));
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
const kid = client();
const sync = () => Promise.all([mom, dad, kid].map((c) => c.fetchMessages()));

test('an SOS reaches everyone, readable as text by older apps', async () => {
  await mom.createCircle({ features: allFeatures(), serverUrl: url, setupToken: SETUP, name: 'Mom', circleName: 'Family' });
  await dad.joinWithInvite((await mom.createInvite()).link, { name: 'Dad' });
  await kid.joinWithInvite((await mom.createInvite()).link, { name: 'Kid' });
  await Promise.all([mom, dad, kid].map((c) => c.refresh()));

  const id = await kid.startSos();
  await sync();
  const m = dad.messages.find((x) => x.id === id);
  assert.equal(m.body.text, '🆘 Kid sent an SOS. Open HomeCircle to see where they are.');
  assert.deepEqual(m.body.sos, { state: 'start' });
  const [s] = mom.activeSos();
  assert.deepEqual([s.id, s.memberId, s.name, s.arrived], [id, kid.account.memberId, 'Kid', null]);
  assert.ok(!JSON.stringify(app.store.db.prepare('SELECT env FROM messages').all()).includes('SOS'));
});

test('arriving at a safe place is posted and remembered', async () => {
  const [s] = dad.activeSos();
  await kid.sosArrived(s.id, 'Main St Police Station');
  await sync();
  assert.equal(mom.messages.at(-1).body.text, '📍 Kid reached Main St Police Station');
  assert.equal(mom.activeSos()[0].arrived.place, 'Main St Police Station');
});

test('"I\'m safe" ends it; only the sender can end their own', async () => {
  const [s] = mom.activeSos();
  // Someone else's "safe" doesn't end Kid's SOS.
  await dad.endSos(s.id);
  await sync();
  assert.equal(mom.activeSos().length, 1);
  await kid.endSos(s.id);
  await sync();
  assert.equal(mom.activeSos().length, 0);
  assert.equal(mom.messages.at(-1).body.text, '✅ Kid is safe now.');
});

test('an SOS left on for a day stops showing', async () => {
  await dad.startSos();
  await sync();
  assert.equal(kid.activeSos().length, 1);
  assert.equal(kid.activeSos(Date.now() + 86400_000 + 1).length, 0);
  await dad.endSos(kid.activeSos()[0].id);
});

test('no unexpected client errors', () => {
  assert.deepEqual(
    errors.map((e) => e.message),
    [],
  );
});
