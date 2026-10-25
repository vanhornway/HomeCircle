// Ticks: sent, delivered (every recipient's phone has it) and read (every
// recipient opened the chat), in groups and direct chats.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/index.js';
import { CircleClient, allFeatures } from '../../packages/core/src/index.js';

const SETUP = 'test-setup-token-ticks';
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
  dir = mkdtempSync(join(tmpdir(), 'homecircle-ticks-'));
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
const mine = (c, text) => c.messages.find((m) => m.body?.text === text);

test('a group message: sent, then delivered once every phone has it, then read once everyone has read it', async () => {
  await mom.createCircle({ features: allFeatures(), serverUrl: url, setupToken: SETUP, name: 'Mom', circleName: 'Family' });
  await dad.joinWithInvite((await mom.createInvite()).link, { name: 'Dad' });
  await kid.joinWithInvite((await mom.createInvite()).link, { name: 'Kid' });
  await Promise.all([mom, dad, kid].map((c) => c.refresh()));

  await mom.sendChat('Dinner at 7');
  const m = mine(mom, 'Dinner at 7');
  assert.equal(mom.receipt(m), 'sent');
  await dad.fetchMessages();
  await mom.refresh();
  assert.equal(mom.receipt(m), 'sent', 'Kid’s phone doesn’t have it yet');
  assert.deepEqual(mom.receiptsFor(m), { read: [], delivered: ['Dad'], waiting: ['Kid'] });
  await kid.fetchMessages();
  await mom.refresh();
  assert.equal(mom.receipt(m), 'delivered');

  await dad.sendReadReceipt(null, mine(dad, 'Dinner at 7').seq);
  await mom.fetchMessages();
  assert.equal(mom.receipt(m), 'delivered');
  assert.deepEqual(mom.receiptsFor(m).read, ['Dad']);
  await kid.sendReadReceipt(null, mine(kid, 'Dinner at 7').seq);
  await mom.fetchMessages();
  assert.equal(mom.receipt(m), 'read');
  // Receipts don't show as chat lines or reactions, here or in older apps.
  assert.equal(mom.conversation(null).filter((x) => x.kind === 'chat').length, 1);
  assert.deepEqual(mom.reactionsFor(m.id), []);
});

test('a direct message: only the other person counts', async () => {
  await mom.sendChat('Can you pick up milk?', { to: dad.account.memberId });
  const m = mine(mom, 'Can you pick up milk?');
  await dad.fetchMessages();
  await mom.refresh();
  assert.equal(mom.receipt(m), 'delivered');
  await dad.sendReadReceipt(mom.account.memberId, mine(dad, 'Can you pick up milk?').seq);
  await mom.fetchMessages();
  assert.equal(mom.receipt(m), 'read');
  // Kid never sees the direct chat's receipt.
  await kid.fetchMessages();
  assert.equal(kid.reads.has(`${dad.account.memberId}|${mom.account.memberId}`), false);
});

test('someone who joined later doesn’t hold back ticks on older messages', async () => {
  const gran = client();
  await gran.joinWithInvite((await mom.createInvite()).link, { name: 'Gran' });
  await mom.refresh();
  assert.equal(mom.receipt(mine(mom, 'Dinner at 7')), 'read');
});

test('phones with the app open get it delivered right away', async () => {
  dad.connect();
  await new Promise((r) => setTimeout(r, 300));
  await mom.sendChat('Running late', { to: dad.account.memberId });
  await mom.refresh();
  assert.equal(mom.receipt(mine(mom, 'Running late')), 'delivered');
  dad.disconnect();
});

test('no unexpected client errors', () => {
  assert.deepEqual(
    errors.map((e) => e.message),
    [],
  );
});
