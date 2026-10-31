// A phone opens on the newest messages, whatever its cache holds, and the
// cache survives the app being closed at a bad moment.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/index.js';
import { CircleClient } from '../../packages/core/src/index.js';

const SETUP = 'test-setup-token-history';
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
  dir = mkdtempSync(join(tmpdir(), 'homecircle-history-'));
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
    // A big history in a few seconds: the per-device limits are for one person.
    loadTest: true,
  });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  url = `http://127.0.0.1:${app.server.address().port}`;
});

after(async () => {
  await app.close();
  rmSync(dir, { recursive: true, force: true });
});

const mom = new CircleClient({ storage: new MemoryStorage() });
// A phone: its keys and its message cache survive "closing the app".
const storage = new MemoryStorage();
const cache = new MemoryStorage();
let ali;

/** A new run of the app on the same phone. */
async function launch() {
  const c = new CircleClient({ storage, cache });
  c.backfillPauseMs = 20;
  await c.load();
  return c;
}

/** Closing the app: nothing more is written, whatever was waiting. */
function kill(c) {
  clearTimeout(c._cacheTimer);
  c._cacheTimer = null;
  c.disconnect();
}

/** Counts envelopes really opened (decrypted and checked) and the message requests made. */
function watch(client) {
  const n = { opened: 0, calls: [] };
  const real = client._open.bind(client);
  client._open = (...args) => {
    if (!client._opened.has(`${client.account.known[args[1]]?.signPub}|${args[3] ?? ''}|${args[4] ?? ''}|${args[0]?.ct}`)) n.opened++;
    return real(...args);
  };
  for (const name of ['messages', 'messagesTail', 'messagesBefore']) {
    const f = client.api[name];
    client.api[name] = (...args) => {
      n.calls.push([name, ...args]);
      return f(...args);
    };
  }
  return n;
}

const texts = (c) => c.conversation().filter((m) => m.kind === 'chat').map((m) => m.body.text);
const sendMany = async (from, label, count) => {
  for (let i = 0; i < count; i++) await from.sendChat(`${label} ${i}`);
};
/** Messages from `label` 0 up to count - 1, in order. */
const run = (label, count) => Array.from({ length: count }, (_, i) => `${label} ${i}`);

test('the server gives the newest messages first, and reads back from there', async () => {
  await mom.createCircle({ serverUrl: url, setupToken: SETUP, name: 'Mom', circleName: 'Family' });
  const other = new CircleClient({ storage: new MemoryStorage() });
  await other.joinWithInvite((await mom.createInvite()).link, { name: 'Other' });
  ali = new CircleClient({ storage, cache });
  await ali.joinWithInvite((await mom.createInvite()).link, { name: 'Ali' });
  await mom.refresh();
  await sendMany(mom, 'old', 12);
  // A private conversation between Mom and Other: Ali never gets it, in any order.
  await mom.sendChat('secret', { to: other.account.memberId });
  await sendMany(mom, 'new', 12);

  const { messages: tail } = await ali.api.messagesTail(5);
  assert.equal(tail.length, 5);
  assert.deepEqual(tail.map((m) => m.seq), [...tail.map((m) => m.seq)].sort((a, b) => a - b));
  const { messages: before } = await ali.api.messagesBefore(tail[0].seq, 5);
  assert.equal(before.length, 5);
  assert.equal(before.at(-1).seq < tail[0].seq, true);
  const all = (await ali.api.messages(0, 500)).messages;
  assert.deepEqual([...before, ...tail].map((m) => m.seq), all.slice(-10).map((m) => m.seq));
  const { messages: everything } = await ali.api.messagesBefore(Number.MAX_SAFE_INTEGER, 500);
  assert.equal(everything.length, all.length);
  // Other's copy of the same history has the private message; Ali's doesn't.
  assert.equal((await other.api.messagesTail(500)).messages.length, all.length + 1);
  // Nothing below the first message.
  assert.deepEqual((await ali.api.messagesBefore(all[0].seq, 5)).messages, []);
});

test('with no cache the newest messages are there first, and the rest is read back behind them', async () => {
  await sendMany(mom, 'history', 230);
  const phone = await launch();
  const w = watch(phone);
  await phone.start();
  // Opened on the newest page: a few dozen messages, not all 260 or so.
  const first = texts(phone);
  assert.equal(first.length, 80);
  assert.equal(first.at(-1), 'history 229');
  assert.equal(phone.hasOlder, true);
  assert.ok(w.opened < 80 + phone.memberList().length + phone.locations.size + 5, `opened ${w.opened}`);
  assert.deepEqual(w.calls.map((c) => c[0]).slice(0, 1), ['messagesTail']);
  assert.equal(w.calls.some((c) => c[0] === 'messages' && c[1] === 0), false, 'never starts at the oldest');

  // Behind the screen: the rest, oldest first in the list, nothing twice.
  await phone.backfillHistory();
  assert.equal(phone.hasOlder, false);
  assert.deepEqual(texts(phone), [...run('old', 12), ...run('new', 12), ...run('history', 230)]);
  const seqs = phone.messages.map((m) => m.seq);
  assert.deepEqual(seqs, [...new Set(seqs)].sort((a, b) => a - b));
  await phone.flushCache();
  kill(phone);
});

test('one page of older history on request, when the person scrolls up', async () => {
  const phone = new CircleClient({ storage: new MemoryStorage() });
  await phone.joinWithInvite((await mom.createInvite()).link, { name: 'Scroller' });
  phone.backfillPauseMs = 300;
  await phone.start();
  // Closing the connection pauses reading back; this asks for a page by hand.
  phone.disconnect();
  assert.equal(texts(phone).length, 80);
  const got = await phone.loadOlder(30);
  assert.equal(got, 30);
  assert.equal(texts(phone).length, 110);
  assert.equal(phone.hasOlder, true);
  assert.equal(texts(phone).at(-1), 'history 229');
});

test('a restart with the cache fetches only what is new', async () => {
  await mom.sendChat('while you were away 1');
  await mom.sendChat('while you were away 2');
  const phone = await launch();
  const w = watch(phone);
  await phone.start();
  phone.disconnect();
  // Opened: the new messages and the members and locations, never the history.
  assert.ok(w.opened - phone.memberList().length - phone.locations.size <= 2, `opened ${w.opened}`);
  assert.deepEqual(w.calls.filter((c) => c[0] !== 'messages'), []);
  assert.equal(w.calls.filter((c) => c[0] === 'messages').length, 1);
  assert.equal(w.calls.find((c) => c[0] === 'messages')[1] > 0, true);
  assert.equal(phone.hasOlder, false);
  assert.equal(texts(phone).length, 12 + 12 + 230 + 2);
  assert.deepEqual(texts(phone).slice(-2), ['while you were away 1', 'while you were away 2']);
  await phone.flushCache();
  kill(phone);
});

test('the cache already has the chat, the names and the map before the network answers', async () => {
  const phone = await launch();
  // Offline: nothing can be asked of the server.
  phone.api.state = () => Promise.reject(new Error('offline'));
  await assert.rejects(phone.start());
  phone.disconnect();
  assert.equal(texts(phone).length, 256);
  assert.equal(phone.memberList().length, (await mom.api.state()).members.length);
  assert.equal(phone.circle.name, 'Family');
  assert.equal(phone.timings.cache.rows >= 256, true);
  kill(phone);
});

test('a phone that missed more than a page opens on the newest and fills the gap in behind', async () => {
  // The phone's cache stops here; the circle carries on without it.
  await sendMany(mom, 'missed', 520);
  const phone = await launch();
  const w = watch(phone);
  await phone.start();
  const first = texts(phone);
  // The cached copy and the newest page: the latest is on screen without waiting for the 520.
  assert.equal(first.at(-1), 'missed 519');
  assert.equal(first.length, 80);
  assert.equal(phone.hasOlder, true);
  assert.equal(w.calls.slice(0, 2).map((c) => c[0]).join(), 'messages,messagesTail');
  await phone.backfillHistory();
  // Missing about as many as the phone keeps: the old copy would only leave a hole, so the newest 520 come in instead.
  assert.equal(phone.hasOlder, false);
  const have = texts(phone);
  assert.ok(have.length >= 500 && have.length < 500 + 100, `${have.length} messages`);
  assert.deepEqual(have.slice(-520), run('missed', 520));
  assert.ok(w.opened < 600 + phone.memberList().length + phone.locations.size, `opened ${w.opened}`);
  const before = w.calls.filter((c) => c[0] === 'messagesBefore');
  assert.ok(before.length <= 6, `${before.length} pages read back`);
  await phone.flushCache();
  // And what's kept is the newest 500.
  const saved = JSON.parse(await cache.getItem(`${phone.accountKey}.messages`));
  assert.equal(saved.rows.length, 500);
  assert.equal(saved.backSeq, 0);
  await phone.flushCache();
  kill(phone);
});

test('the cache is written soon after the first messages arrive, not at some later quiet moment', async () => {
  const fresh = new CircleClient({ storage: new MemoryStorage(), cache: new MemoryStorage() });
  await fresh.joinWithInvite((await mom.createInvite()).link, { name: 'Soon' });
  fresh.backfillPauseMs = 300;
  await fresh.start();
  fresh.disconnect();
  assert.equal(await fresh.cache.getItem(`${fresh.accountKey}.messages`), null);
  // Well inside the 2 s the old timer waited; the app is killed right after.
  await new Promise((r) => setTimeout(r, 700));
  kill(fresh);
  const saved = JSON.parse(await fresh.cache.getItem(`${fresh.accountKey}.messages`));
  assert.equal(saved.v, 2);
  assert.equal(saved.rows.length, 80);
  assert.equal(saved.fetchedSeq, fresh.fetchedSeq);
  assert.ok(saved.backSeq > 0);
  assert.equal(saved.state.members.length, (await mom.api.state()).members.length);
});

test('closing the app right after messages arrive loses none of them', async () => {
  const phone = await launch();
  await phone.start();
  await mom.sendChat('just before the app closed');
  await phone.fetchMessages();
  // What the app does on its way to the background.
  await phone.flushCache();
  kill(phone);
  const again = await launch();
  const w = watch(again);
  await again.loadCache();
  assert.equal(texts(again).at(-1), 'just before the app closed');
  assert.equal(w.opened, 0);
  assert.equal(again.fetchedSeq, phone.fetchedSeq);
});

test('a background task that only sends or fetches does not replace the cache with less', async () => {
  const key = `${(await launch()).accountKey}.messages`;
  const before = JSON.parse(await cache.getItem(key));
  // A place alert sent from the background: a fresh client, nothing started.
  const task = await launch();
  await task.sendChat('arrived at school');
  await task.flushCache();
  kill(task);
  const afterPost = JSON.parse(await cache.getItem(key));
  assert.equal(afterPost.rows.at(-1).opened.body.text, 'arrived at school');
  assert.equal(afterPost.rows.length, Math.min(500, before.rows.length + 1));
  assert.ok(afterPost.fetchedSeq >= before.fetchedSeq);
  assert.equal(afterPost.backSeq, before.backSeq);

  // A push that fetches new messages: from where the cache stops, not from 0.
  await mom.sendChat('push me');
  const push = await launch();
  const w = watch(push);
  await push.fetchMessages();
  await push.flushCache();
  kill(push);
  assert.deepEqual(w.calls.map((c) => c[0]), ['messages']);
  assert.ok(w.calls[0][1] > 0);
  assert.ok(w.opened <= 2, `opened ${w.opened}`);
  const afterFetch = JSON.parse(await cache.getItem(key));
  assert.equal(afterFetch.rows.at(-1).opened.body.text, 'push me');
  assert.equal(afterFetch.rows.length, Math.min(500, afterPost.rows.length + 1));
  assert.equal(afterFetch.state.members.length, (await mom.api.state()).members.length);
});

test('a cache that was cut off while being written is ignored, and the newest messages still come first', async () => {
  const key = `${(await launch()).accountKey}.messages`;
  await cache.setItem(key, (await cache.getItem(key)).slice(0, 5000));
  const phone = await launch();
  const w = watch(phone);
  await phone.start();
  phone.disconnect();
  assert.equal(w.calls[0][0], 'messagesTail');
  assert.equal(texts(phone).length, 80);
  assert.equal(texts(phone).at(-1), 'push me');
  kill(phone);
});

test('signing out deletes the cache, and a save in flight does not bring it back', async () => {
  const phone = await launch();
  await phone.start();
  phone.disconnect();
  const saving = phone._saveCache();
  await phone.signOut();
  await saving;
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(await cache.getItem(`${phone.accountKey}.messages`), null);
});
