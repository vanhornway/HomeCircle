// Signing in a browser from the phone: the web page shows a QR code with a
// one-time key, the phone seals the account to it, and the browser gets a
// token of its own, which the phone can sign out. The server never sees keys.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/index.js';
import { CircleClient, allFeatures, parseBrowserLink } from '../../packages/core/src/index.js';

const SETUP = 'test-setup-token-link';
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
const client = () => new CircleClient({ storage: new MemoryStorage(), onError: () => {} });
const waitUntil = async (fn, ms = 3000) => {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 20));
  }
};

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'homecircle-link-'));
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
  for (const c of [phone, sara, browser]) c.disconnect();
  await app.close();
  rmSync(dir, { recursive: true, force: true });
});

const phone = client();
const sara = client();
const browser = client();

test('the phone scans the browser’s code: the browser is signed in as that member, with its own token', async () => {
  await phone.createCircle({ features: allFeatures(), serverUrl: url, setupToken: SETUP, name: 'Umair', circleName: 'Family' });
  await sara.joinWithInvite((await phone.createInvite()).link, { name: 'Sara' });

  const start = await CircleClient.startLink(url, 'Chrome on macOS');
  const read = parseBrowserLink(start.url);
  assert.deepEqual(read, { server: start.server, id: start.id, boxPub: start.boxPub, label: 'Chrome on macOS' });
  assert.equal(parseBrowserLink('homecircle://join?server=x&i=y&s=z'), null);
  assert.ok(!start.url.includes(start.boxSecret), 'the secret stays in the browser');

  const waiting = browser.finishLink(start, { every: 30 });
  const answer = await phone.linkBrowser(read);
  assert.equal(answer.session.label, 'Chrome on macOS');
  assert.equal(await waiting, true);
  assert.equal(browser.account.memberId, phone.account.memberId);
  assert.notEqual(browser.account.token, phone.account.token);
  assert.equal(browser.isLinkedBrowser, true);
  assert.equal(phone.isLinkedBrowser, false);

  // The code works once.
  await assert.rejects(phone.linkBrowser(read), (e) => e.status === 404);
  // The server kept no keys: what it handed over is sealed.
  assert.ok(!JSON.stringify([...app.store.sessionsOf(phone.account.memberId)]).includes(phone.account.identity.boxSecret));

  // It reads the circle and writes as Umair.
  await browser.refresh();
  assert.equal(browser.circle.name, 'Family');
  await browser.sendChat('From the computer');
  const { messages } = await sara.api.messages(0);
  assert.equal(messages.at(-1).from, phone.account.memberId);
});

test('a browser open doesn’t make the phone count as online, nor take its pushes or delivered ticks', async () => {
  const me = phone.account.memberId;
  await browser.start();
  await waitUntil(() => browser.status === 'online');
  assert.equal(app.hub.isOnline(me), false, 'only the browser is connected');
  await phone.start();
  await waitUntil(() => phone.status === 'online');
  assert.equal(app.hub.isOnline(me), true);
  phone.disconnect();
  await waitUntil(() => !app.hub.isOnline(me));

  // The browser can't overwrite (or clear) the phone's push token.
  app.store.setPush({ id: me, circleId: phone.account.circleId }, 'ExponentPushToken[phone]', 'android');
  await browser.api.putPush(null, 'web');
  assert.equal(app.store.member(phone.account.circleId, me).pushToken, 'ExponentPushToken[phone]');

  // Sara writes; the browser reads it; the phone hasn't, so it isn't delivered to it.
  const before = app.store.deliveredSeqOf(me);
  await sara.sendChat('Dinner at 7');
  const { messages } = await browser.api.messages(0);
  assert.ok(messages.length >= 2);
  assert.equal(app.store.deliveredSeqOf(me), before);
});

test('the phone lists browsers and signs one out; a browser leaving only signs itself out', async () => {
  const list = await phone.browserSessions();
  assert.equal(list.length, 1);
  assert.equal(list[0].label, 'Chrome on macOS');
  assert.equal(list[0].current, false);
  assert.equal((await browser.browserSessions())[0].current, true);

  await phone.signOutBrowser(list[0].id);
  await assert.rejects(browser.api.state(), (e) => e.status === 401);
  assert.equal((await phone.browserSessions()).length, 0);

  // Link another, which then leaves: Umair stays in the circle with the phone.
  const again = client();
  const start = await CircleClient.startLink(url, 'Firefox on Windows');
  const waiting = again.finishLink(start, { every: 30 });
  await phone.linkBrowser(parseBrowserLink(start.url));
  assert.equal(await waiting, true);
  const res = await again.api.removeMember(again.account.memberId);
  assert.equal(res.signedOut, true);
  await assert.rejects(again.api.state(), (e) => e.status === 401);
  await phone.refresh();
  assert.ok(phone.memberList().some((m) => m.id === phone.account.memberId));

  // Signing out in the browser signs it out on the server too.
  const third = client();
  const s3 = await CircleClient.startLink(url, 'Edge on Windows');
  const w3 = third.finishLink(s3, { every: 30 });
  await phone.linkBrowser(parseBrowserLink(s3.url));
  assert.equal(await w3, true);
  const api = third.api;
  await third.signOut();
  await assert.rejects(api.state(), (e) => e.status === 401);
  assert.equal((await phone.browserSessions()).length, 0);
  // The phone signing out of its own circle doesn't touch the server.
  await assert.rejects(phone.api.deleteSession('current'), (e) => e.status === 400);

  // Removing a member signs out their browsers too.
  const sarasBrowser = client();
  const s2 = await CircleClient.startLink(url, 'Safari');
  const w2 = sarasBrowser.finishLink(s2, { every: 30 });
  await sara.linkBrowser(parseBrowserLink(s2.url));
  assert.equal(await w2, true);
  await phone.removeMember(sara.account.memberId);
  await assert.rejects(sarasBrowser.api.state(), (e) => e.status === 401);
});

test('an expired or unknown code', async () => {
  const start = await CircleClient.startLink(url, 'Old tab');
  assert.equal(await client().finishLink({ ...start, expiresAt: Date.now() + 50 }, { every: 20 }), false);
  await assert.rejects(phone.linkBrowser({ ...parseBrowserLink(start.url), id: 'AAAAAAAAAAAAAAAAAAAAAA' }), (e) => e.status === 404);
  await assert.rejects(phone.linkBrowser({ ...parseBrowserLink(start.url), server: 'https://elsewhere.example' }), /another server/);
});
