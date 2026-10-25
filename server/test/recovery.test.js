// Recovery with the setup code: the person who set up the server lost their
// phone (or signed out) and gets back in, without the server ever reading a
// circle: a member has to approve the rejoin on their phone.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/index.js';
import { CircleClient, allFeatures } from '../../packages/core/src/index.js';

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

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'homecircle-recovery-'));
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
    wsAuthTimeoutMs: 300,
  });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  url = `http://127.0.0.1:${app.server.address().port}`;
});

after(async () => {
  for (const c of [wife, back]) c.disconnect();
  await app.close();
  rmSync(dir, { recursive: true, force: true });
});

const lostPhone = client();
const wife = client();
const back = client();
let circleId;

test('the setup code is checked, and lists circles without their names', async () => {
  await lostPhone.createCircle({ features: allFeatures(), serverUrl: url, setupToken: SETUP, name: 'Umair', circleName: 'Family' });
  circleId = lostPhone.circleId;
  await wife.joinWithInvite((await lostPhone.createInvite()).link, { name: 'Sara' });
  wife.connect();
  await waitOnline(wife);

  await assert.rejects(() => CircleClient.recoverCircles(url, 'wrong-code-1234'), (e) => e.code === 'bad_setup_token');
  const { circles } = await CircleClient.recoverCircles(url, ` ${SETUP} `);
  assert.equal(circles.length, 1);
  assert.equal(circles[0].id, circleId);
  assert.equal(circles[0].members, 2);
  assert.equal(circles[0].waiting, 0);
  assert.ok(!JSON.stringify(circles).includes('Family'));
});

test('a member denies a rejoin request', async () => {
  const seen = waitFor(wife, 'rejoinRequests');
  const pending = await CircleClient.requestRejoin({ serverUrl: url, setupToken: SETUP, circleId, name: 'Not Umair' });
  await seen;
  const [req] = await wife.rejoinRequests();
  assert.equal(req.name, 'Not Umair');
  await wife.denyRejoin(req.id);
  assert.equal(await client().finishRejoin(pending), 'denied');
  assert.deepEqual(await wife.rejoinRequests(), []);
});

test('rejoin: a member approves, and the setup code holder is the owner again', async () => {
  const pending = await CircleClient.requestRejoin({ serverUrl: url, setupToken: SETUP, circleId, name: 'Umair' });
  assert.equal((await CircleClient.recoverCircles(url, SETUP)).circles[0].waiting, 1);
  assert.equal(await back.finishRejoin(pending), 'pending');
  assert.equal(back.account, null);

  // The approving member sees the same safety number the requester shows.
  const [req] = await wife.rejoinRequests();
  assert.equal(req.safetyNumber, pending.safetyNumber);
  await wife.approveRejoin(req);

  const joined = waitFor(wife, 'members', (ms) => ms.some((m) => m.name === 'Umair' && m.role === 'owner'));
  assert.equal(await back.finishRejoin(pending), 'joined');
  await joined;
  assert.equal(back.circle.name, 'Family');
  assert.equal(back.me.role, 'owner');
  assert.equal(back.isServerAdmin, true);
  // The lost phone's member is still there, now an admin, until removed.
  const ghost = back.memberList().find((m) => m.id === lostPhone.account.memberId);
  assert.equal(ghost.role, 'admin');
  assert.equal(await back.finishRejoin(pending), 'expired');

  // End-to-end encryption still works both ways.
  back.connect();
  await waitOnline(back);
  const got = waitFor(wife, 'newMessage');
  await back.sendChat('I’m back');
  assert.equal((await got).body.text, 'I’m back');
});

test('after removing the old phone, the key rotates and everyone keeps reading', async () => {
  await back.removeMember(lostPhone.account.memberId);
  // Rotation waits until the other phones have seen the rejoined owner.
  assert.equal(back.state.rotationNeeded, true);
  back.account.rejoined = false;
  await back.refresh();
  assert.equal(back.state.rotationNeeded, false);
  assert.equal(back.state.epoch, 2);

  await wife.refresh();
  assert.ok(wife.account.keyring[2], 'wife accepted the new key from the rejoined owner');
  const got = waitFor(back, 'newMessage');
  await wife.sendChat('Welcome back');
  assert.equal((await got).body.text, 'Welcome back');
});

test('the setup code starts a new circle and deletes an abandoned one', async () => {
  const extra = client();
  await extra.createCircle({ features: allFeatures(), serverUrl: url, setupToken: SETUP, name: 'Umair', circleName: 'Old test' });
  assert.equal((await CircleClient.recoverCircles(url, SETUP)).circles.length, 2);
  await CircleClient.recoverDeleteCircle(url, SETUP, extra.circleId);
  const { circles } = await CircleClient.recoverCircles(url, SETUP);
  assert.deepEqual(
    circles.map((c) => c.id),
    [circleId],
  );
  await assert.rejects(() => extra.refresh(), (e) => e.status === 401);
});

test('a phone slow to log in on the live connection is told to retry, not that it is unknown', async () => {
  const ws = new WebSocket(`${url.replace(/^http/, 'ws')}/api/v1/ws`);
  const code = await new Promise((resolve) => ws.addEventListener('close', (e) => resolve(e.code)));
  // 4001 makes apps before 0.8 delete their keys; a timeout must never send it.
  assert.equal(code, 4000);
});

test('a stray 4001 while still a member: the phone checks, reconnects and stays in', async () => {
  await waitOnline(wife);
  let signedOut = false;
  const off = wife.on('signedOut', () => (signedOut = true));
  const rejected = waitFor(wife, 'status', (s) => s === 'unauthorized');
  const reconnected = waitFor(wife, 'status', (s) => s === 'online');
  app.hub.disconnect(wife.account.memberId); // closes with 4001, as for a removal
  await rejected;
  await reconnected;
  off();
  assert.equal(signedOut, false);
  assert.ok(wife.account, 'keys kept');
});

test('a phone the server stops recognizing keeps its keys and is told', async () => {
  const memberId = wife.account.memberId;
  wife.disconnect();
  // As if the server lost this member's data (no "removed" message is sent).
  app.store.db.prepare('UPDATE members SET token_hash = NULL WHERE id = ?').run(memberId);
  const told = waitFor(wife, 'unrecognized');
  wife.connect();
  await told;
  assert.equal(wife.status, 'unauthorized');
  assert.ok(wife.account, 'keys kept');
  assert.equal(wife.account.memberId, memberId);
});

test('no unexpected client errors', () => {
  assert.deepEqual(
    errors.map((e) => e.message),
    [],
  );
});
