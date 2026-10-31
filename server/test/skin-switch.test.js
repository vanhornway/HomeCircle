// An admin switches a member between the full app, the elder's care page and
// the grandkids page, in any order and as many times as they like, and the
// member's phone follows every time: with the app open, after it was away
// (live events missed), after a cold start, and with the app closed (a
// silent push wakes it). The admin can see when it has.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/index.js';
import { CircleClient, allFeatures } from '../../packages/core/src/index.js';

const SETUP = 'test-setup-token-skins';
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
const client = (storage = new MemoryStorage()) => new CircleClient({ storage, onError: (e) => errors.push(e) });
const id = (c) => c.account.memberId;
// What a phone shows for its own record: the app's profileOf (mobile/src/skins/profile.ts).
const shows = (c) => {
  const rec = c.memberRecord(id(c));
  return rec?.skin !== 'elderly' ? 'full' : rec.page === 'grandkids' ? 'grandkids' : 'care';
};
const waitFor = async (fn, what) => {
  for (let i = 0; i < 100; i++) {
    if (fn()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  assert.fail(`timed out waiting for ${what}`);
};

const woken = [];
before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'homecircle-skins-'));
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
  // What the server would push: the silent wake-up for settings.
  const real = app.push.settingsChanged.bind(app.push);
  app.push.settingsChanged = (members) => {
    woken.push(...members.map((m) => m.id));
    return real(members);
  };
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  url = `http://127.0.0.1:${app.server.address().port}`;
});

after(async () => {
  umair.disconnect();
  nani.disconnect();
  await app.close();
  rmSync(dir, { recursive: true, force: true });
});

const umair = client(); // the owner
const nani = client(); // the elder; her phone's storage survives a "cold start"

test('set up: Umair owns the circle, Nani joined', async () => {
  await umair.createCircle({ features: allFeatures(), serverUrl: url, setupToken: SETUP, name: 'Umair', circleName: 'Family' });
  await nani.joinWithInvite((await umair.createInvite()).link, { name: 'Nani' });
  await Promise.all([umair.refresh(), nani.refresh()]);
  await Promise.all([umair.start(), nani.start()]);
  assert.equal(shows(nani), 'full');
  await waitFor(() => nani.status === 'online', 'her live connection');
  await nani.api.putPush('ExponentPushToken[abc123]', 'android');
});

test('full → elder → full → grandkids → elder → full, with the app open', async () => {
  const steps = [
    ['care', () => umair.markElder(id(nani), { page: 'care' })],
    ['full', () => umair.setMemberRecord(id(nani), { skin: 'full' })],
    ['grandkids', () => umair.markElder(id(nani), { page: 'grandkids' })],
    ['care', () => umair.markElder(id(nani), { page: 'care' })],
    ['full', () => umair.setMemberRecord(id(nani), { skin: 'full' })],
  ];
  for (const [want, run] of steps) {
    await run();
    await waitFor(() => shows(nani) === want, `her phone to show ${want}`);
    assert.equal(shows(nani), want);
  }
});

test('her phone was away: every change made meanwhile is there when she is back', async () => {
  nani.disconnect();
  await umair.markElder(id(nani), { page: 'grandkids' });
  await umair.setMemberRecord(id(nani), { skin: 'full' });
  await umair.markElder(id(nani), { page: 'care' });
  assert.equal(shows(nani), 'full', 'a closed app has not heard');
  await nani.start(); // what opening the app does on a phone that was already running
  assert.equal(shows(nani), 'care', 'resume picks the change up');

  nani.disconnect();
  await umair.setMemberRecord(id(nani), { skin: 'full' });
  await nani.start();
  assert.equal(shows(nani), 'full');
});

test('a live connection that dropped and came back also catches up', async () => {
  // The same catch-up the client runs when its WebSocket reconnects.
  nani.disconnect();
  await umair.markElder(id(nani), { page: 'grandkids' });
  await nani.catchUp();
  assert.equal(shows(nani), 'grandkids');
  await umair.setMemberRecord(id(nani), { skin: 'full' });
  await nani.catchUp();
  assert.equal(shows(nani), 'full');
  await nani.start();
});

test('a cold start (a new process with only what is stored) reads the current settings', async () => {
  nani.disconnect();
  await umair.markElder(id(nani), { page: 'care' });
  const cold = new CircleClient({ storage: nani.storage, onError: (e) => errors.push(e) });
  await cold.load();
  await cold.start();
  assert.equal(shows(cold), 'care');
  cold.disconnect();
  await umair.setMemberRecord(id(nani), { skin: 'full' });
  await nani.start();
  assert.equal(shows(nani), 'full');
});

test('every change to her record wakes her phone with a silent push, so a closed app follows', async () => {
  woken.length = 0;
  await umair.markElder(id(nani), { page: 'grandkids' });
  await umair.setMemberRecord(id(nani), { skin: 'full' });
  assert.equal(woken.filter((w) => w === id(nani)).length, 2);
  // Nothing about the change is in the push itself, only that she should look.
  const sent = [];
  const real = app.push._send;
  app.push._send = (msgs) => (sent.push(...msgs), Promise.resolve());
  app.push.settingsChanged([{ id: id(nani), pushToken: 'ExponentPushToken[abc]' }]);
  app.push._send = real;
  assert.equal(sent.length, 1);
  assert.deepEqual(Object.keys(sent[0].data).sort(), ['c', 't']);
  assert.equal(sent[0].data.t, 'rec');
  // Her own settings changes don't wake anyone else, and aliases don't wake anyone.
  woken.length = 0;
  await nani.setFamilyName(id(nani), id(umair), { name: 'Beta' });
  assert.deepEqual(woken, []);
});

test('the admin sees when her phone has followed: it reports the skin and page it shows', async () => {
  await umair.markElder(id(nani), { page: 'grandkids' });
  await nani.fetchRecords();
  assert.equal(shows(nani), 'grandkids');
  await nani.shareLocation({ lat: 30.27, lng: -97.74, accuracy: 20, trigger: 'manual', skin: 'elderly', page: 'grandkids' });
  await umair.fetchLocations();
  const seen = umair.locations.get(id(nani));
  assert.equal(seen.skin, 'elderly');
  assert.equal(seen.page, 'grandkids');
  assert.ok(seen.ts >= umair.memberRecord(id(nani)).ts, 'reported after the change');
  await umair.setMemberRecord(id(nani), { skin: 'full' });
  await nani.fetchRecords();
  await nani.shareLocation({ lat: 30.27, lng: -97.74, accuracy: 20, trigger: 'manual', skin: 'full' });
  await umair.fetchLocations();
  assert.equal(umair.locations.get(id(nani)).skin, 'full');
  assert.equal(umair.locations.get(id(nani)).page, null);
});

test('after a key rotation a new member can still read the settings records', async () => {
  await umair.markElder(id(nani), { page: 'care' });
  await umair.rotateKey();
  const nana = client();
  await nana.joinWithInvite((await umair.createInvite()).link, { name: 'Nana' });
  await nana.refresh();
  await nana.fetchRecords();
  assert.equal(nana.memberRecord(id(nani))?.skin, 'elderly', 'sealed under the new key');
  assert.equal(nana.memberRecord(id(nani))?.page, 'care');
  // And she follows the next change like anyone.
  await umair.setMemberRecord(id(nani), { skin: 'full' });
  await nani.refresh();
  await nani.fetchRecords();
  assert.equal(shows(nani), 'full');
});

test('an admin who joined since her last refresh still counts: the record is not dropped', async () => {
  const sara = client();
  await sara.joinWithInvite((await umair.createInvite()).link, { name: 'Sara' });
  await Promise.all([umair.refresh(), sara.refresh()]);
  await umair.setRole(id(sara), 'admin');
  await sara.refresh();
  await sara.setMemberRecord(id(nani), { skin: 'elderly', page: 'grandkids' });
  // Nani's phone has not refreshed its members since Sara joined.
  await nani.fetchRecords();
  assert.equal(shows(nani), 'grandkids');
  assert.deepEqual(errors.filter((e) => !/signature|verif/i.test(String(e?.message))), []);
});
