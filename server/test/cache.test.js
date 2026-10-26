// A phone keeps the messages it opened: the next launch opens only what's new,
// and shows the same conversation (reactions and polls included).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/index.js';
import { CircleClient } from '../../packages/core/src/index.js';

const SETUP = 'test-setup-token-cache';
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

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'homecircle-cache-'));
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

const storage = new MemoryStorage();
const cache = new MemoryStorage();
const mom = new CircleClient({ storage: new MemoryStorage() });
let ali;

/** How many envelopes a client really opened (decrypted and checked). */
function countOpens(client) {
  const n = { opened: 0 };
  const real = client._open.bind(client);
  client._open = (...args) => {
    if (!client._opened.has(`${client.account.known[args[1]]?.signPub}|${args[3] ?? ''}|${args[4] ?? ''}|${args[0]?.ct}`)) n.opened++;
    return real(...args);
  };
  return n;
}

test('the first launch opens every message and keeps them; the next one opens only new ones', async () => {
  await mom.createCircle({ serverUrl: url, setupToken: SETUP, name: 'Mom', circleName: 'Family' });
  ali = new CircleClient({ storage, cache });
  await ali.joinWithInvite((await mom.createInvite()).link, { name: 'Ali' });
  await mom.refresh();
  for (let i = 0; i < 30; i++) await mom.sendChat(`message ${i}`);
  await mom.createPoll({ question: 'Dinner?', options: [{ label: 'Pizza' }, { label: 'Biryani' }] });
  const pollId = mom.conversation().at(-1).id;
  await mom.vote(pollId, [mom.pollState(pollId).options[1].id]);
  await mom.react(mom.conversation().at(0).id, '❤️');

  const first = countOpens(ali);
  await ali.start();
  ali.disconnect();
  assert.ok(first.opened >= 33, `opened ${first.opened}`);
  await ali._saveCache();
  const before = ali.conversation().map((m) => [m.id, m.body?.text ?? null]);
  const reactions = JSON.stringify([...ali.reactions.get(mom.conversation().at(0).id) ?? []]);
  const votes = ali.pollState(pollId).options.map((o) => o.votes);

  // A new launch: same keys, same cache. Two more messages meanwhile.
  await mom.sendChat('new one');
  await mom.sendChat('and another');
  const again = new CircleClient({ storage, cache });
  await again.load();
  const second = countOpens(again);
  await again.start();
  again.disconnect();
  const messagesOpened = second.opened - again.memberList().length - again.locations.size;
  assert.ok(messagesOpened <= 2, `opened ${second.opened} (members ${again.memberList().length})`);
  assert.deepEqual(again.conversation().map((m) => [m.id, m.body?.text ?? null]).slice(0, before.length), before);
  assert.deepEqual(again.conversation().slice(-2).map((m) => m.body?.text), ['new one', 'and another']);
  assert.equal(JSON.stringify([...again.reactions.get(mom.conversation().at(0).id) ?? []]), reactions);
  assert.deepEqual(again.pollState(pollId).options.map((o) => o.votes), votes);
});

test('a cache from another circle or member is ignored; signing out deletes it', async () => {
  const raw = JSON.parse(await cache.getItem(`${ali.accountKey}.messages`));
  await cache.setItem(`${ali.accountKey}.messages`, JSON.stringify({ ...raw, circleId: 'someone-else' }));
  const other = new CircleClient({ storage, cache });
  await other.load();
  await other.start();
  other.disconnect();
  // Everything fetched and opened again, nothing taken from the wrong cache.
  assert.equal(other.conversation().filter((m) => m.kind === 'chat').length, ali.conversation().filter((m) => m.kind === 'chat').length + 2);
  await other.signOut();
  assert.equal(await cache.getItem(`${other.accountKey}.messages`), null);
});

test('catching up runs one at a time, however often it is asked', async () => {
  let inFlight = 0;
  let most = 0;
  const realRefresh = mom.refresh.bind(mom);
  mom.refresh = async () => {
    inFlight++;
    most = Math.max(most, inFlight);
    await new Promise((r) => setTimeout(r, 20));
    try {
      return await realRefresh();
    } finally {
      inFlight--;
    }
  };
  await Promise.all([mom.catchUp(), mom.catchUp(), mom.catchUp(), mom.catchUp()]);
  assert.equal(most, 1);
  mom.refresh = realRefresh;
});
