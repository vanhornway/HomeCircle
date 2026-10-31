// Call-back requests from the Elderly Companion app: a group chat message
// with `callback` in it, answered by replies that point at it. Only "I'm
// calling you now" closes one. No server changes; the server sees ciphertext.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/index.js';
import { CircleClient, allFeatures, CALLBACK_REPLIES } from '../../packages/core/src/index.js';

const SETUP = 'test-setup-token-callback';
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
  dir = mkdtempSync(join(tmpdir(), 'homecircle-callback-'));
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

const umair = client();
const sara = client();
const hamza = client();
const ammi = client();
const everyone = [umair, sara, hamza, ammi];
const sync = () => Promise.all(everyone.map((c) => c.fetchMessages()));
const id = (c) => c.account.memberId;

test('an Elderly Companion invite carries her name and page, so she joins without typing', async () => {
  await umair.createCircle({ features: allFeatures(), serverUrl: url, setupToken: SETUP, name: 'Umair', circleName: 'Ammi’s care circle' });
  await sara.joinWithInvite((await umair.createInvite()).link, { name: 'Sara' });
  await hamza.joinWithInvite((await umair.createInvite()).link, { name: 'Hamza' });
  const invite = await umair.createInvite({ hours: 168, companion: { name: 'Ammi', page: 'care' } });
  const preview = await ammi.previewInvite(invite.link);
  assert.deepEqual(preview.companion, { name: 'Ammi', page: 'care', skin: 'elderly' });
  assert.equal(preview.invitedBy, 'Umair');
  await ammi.joinWithInvite(invite.link);
  await Promise.all(everyone.map((c) => c.refresh()));
  assert.equal(umair.members.get(id(ammi)).name, 'Ammi');
  // A normal invite says nothing about the companion app.
  assert.equal((await client().previewInvite((await umair.createInvite()).link)).companion, null);
});

test('Ring everyone reaches the whole circle, readable as text by older apps', async () => {
  const req = await ammi.askCallback({ tz: 'Asia/Karachi', awake: true, remind: 10 });
  await sync();
  const m = sara.messages.find((x) => x.id === req);
  assert.equal(m.body.text, '📞 Ammi would like a call back. Update HomeCircle to reply.');
  const s = sara.callbackState(req);
  assert.deepEqual(
    { from: s.from, name: s.name, for: s.for, tz: s.tz, awake: s.awake, remind: s.remind, open: s.open, takenBy: s.takenBy, replies: s.replies },
    { from: id(ammi), name: 'Ammi', for: null, tz: 'Asia/Karachi', awake: true, remind: 10, open: true, takenBy: null, replies: [] },
  );
  for (const c of [umair, sara, hamza]) {
    assert.ok(c.callbackAsks(s), 'everyone else is asked');
    assert.deepEqual(c.callbacksAwaitingMe().map((x) => x.id), [req]);
  }
  assert.equal(ammi.callbackAsks(s, id(ammi)), false, 'not herself');
  assert.deepEqual(ammi.callbacksAwaitingMe(), []);
  const stored = JSON.stringify(app.store.db.prepare('SELECT env FROM messages').all());
  for (const word of ['call back', 'Asia/Karachi', 'callback', 'Ammi']) assert.ok(!stored.includes(word), `server can't read "${word}"`);
});

test('replies are kept per person; only "I’m calling you now" closes the request', async () => {
  const [{ id: req }] = umair.openCallbacks();
  await hamza.replyCallback(req, 'morning');
  await sara.replyCallback(req, '5min');
  await sync();
  let s = ammi.callbackState(req);
  assert.equal(s.open, true);
  assert.deepEqual(s.replies.map((r) => [r.name, r.reply]), [['Hamza', 'morning'], ['Sara', '5min']]);
  // Answering stops your own reminders; the others' keep going.
  assert.deepEqual(hamza.callbacksAwaitingMe(), []);
  assert.deepEqual(umair.callbacksAwaitingMe().map((x) => x.id), [req]);

  await umair.replyCallback(req, 'now');
  await sync();
  s = ammi.callbackState(req);
  assert.equal(s.open, false);
  assert.deepEqual([s.takenBy.memberId, s.takenBy.name], [id(umair), 'Umair']);
  assert.equal(sara.messages.at(-1).body.text, '📞 Umair: I’m calling you now');
  for (const c of everyone) assert.deepEqual(c.openCallbacks(), [], 'closed for everyone');
  for (const c of everyone) assert.deepEqual(c.callbacksAwaitingMe(), []);

  // A second "now" after it was taken: recorded, but Umair still took it.
  await sara.replyCallback(req, 'now');
  await sync();
  s = hamza.callbackState(req);
  assert.equal(s.takenBy.name, 'Umair');
  assert.equal(s.replies.find((r) => r.name === 'Sara').reply, 'now');
});

test('a request to one person asks only them', async () => {
  const req = await ammi.askCallback({ to: id(sara), tz: 'Asia/Karachi', remind: 10 });
  await sync();
  const s = umair.callbackState(req);
  assert.deepEqual(s.for, [id(sara)]);
  assert.equal(umair.messages.find((x) => x.id === req).body.text, '📞 Ammi would like a call back from Sara. Update HomeCircle to reply.');
  assert.equal(umair.callbackAsks(s), false);
  assert.equal(sara.callbackAsks(sara.callbackState(req)), true);
  assert.deepEqual(umair.callbacksAwaitingMe(), []);
  assert.deepEqual(sara.callbacksAwaitingMe().map((x) => x.id), [req]);
  await sara.replyCallback(req, 'now');
  await sync();
  assert.equal(ammi.callbackState(req).takenBy.name, 'Sara');
});

test('without reminders (a grandkids circle) nobody is reminded, but it stays open', async () => {
  const req = await ammi.askCallback({ tz: 'Asia/Karachi', remind: 0 });
  await sync();
  assert.equal(umair.callbackState(req).remind, 0);
  assert.equal(umair.callbackState(req).open, true);
  for (const c of everyone) assert.deepEqual(c.callbacksAwaitingMe(), []);
  await umair.replyCallback(req, 'now');
  await sync();
});

test('bad replies and odd values are refused or cleaned', async () => {
  const req = await ammi.askCallback({ tz: 'not a zone!', remind: 9999 });
  await sync();
  const s = umair.callbackState(req);
  assert.equal(s.tz, null);
  assert.equal(s.remind, 240);
  await assert.rejects(umair.replyCallback(req, 'tomorrow'), /Not a call-back reply/);
  await assert.rejects(umair.replyCallback('nope', 'now'), /No such call-back request/);
  // Her own "now" doesn't close her request.
  await ammi.replyCallback(req, 'now');
  await sync();
  assert.equal(umair.callbackState(req).open, true);
  // A reply sent as a direct message doesn't count either.
  await hamza._post('chat', { text: 'x', callback: { state: 'reply', of: req, reply: 'now' } }, { to: id(ammi) });
  await sync();
  assert.equal(ammi.callbackState(req).open, true);
  assert.equal(umair.callbackState('not-a-request'), null);
  assert.deepEqual(CALLBACK_REPLIES, ['now', '5min', 'morning', 'evening']);
  assert.deepEqual(errors, []);
});

test('a background task (no member list loaded) still knows which requests to remind about', async () => {
  const req = await ammi.askCallback({ tz: 'Asia/Karachi', remind: 15 });
  const bg = new CircleClient({ storage: hamza.storage, onError: (e) => errors.push(e) });
  await bg.load();
  await bg.fetchMessages();
  assert.equal(bg.members.size, 0);
  const s = bg.callbacksAwaitingMe().find((x) => x.id === req);
  assert.deepEqual([s.id, s.name, s.remind], [req, 'Ammi', 15]);
  await umair.fetchMessages();
  await umair.replyCallback(req, 'now');
  await bg.fetchMessages();
  assert.equal(bg.callbacksAwaitingMe().some((x) => x.id === req), false);
  assert.deepEqual(errors, []);
});

test('a phone at night or on Do Not Disturb answers "asleep" by itself; she’s told, and it stays open', async () => {
  const req = await ammi.askCallback({ tz: 'Asia/Karachi', remind: 10 });
  await hamza.fetchMessages();
  await hamza.replyCallback(req, 'asleep');
  await Promise.all(everyone.map((c) => c.fetchMessages()));
  const s = ammi.callbackState(req);
  assert.equal(s.open, true);
  assert.deepEqual(s.replies.map((r) => [r.name, r.reply]), [['Hamza', 'asleep']]);
  assert.equal(umair.messages.find((m) => m.body?.callback?.reply === 'asleep').body.text, '📞 Hamza is asleep. Ammi was told.');
  // Answering, even "asleep", stops Hamza's own reminders; the others' keep going.
  assert.equal(hamza.callbacksAwaitingMe().some((x) => x.id === req), false);
  assert.equal(sara.callbacksAwaitingMe().some((x) => x.id === req), true);
  await umair.replyCallback(req, 'now');
});

test('presence rides in the sealed location: Do Not Disturb, time zone, and when she last used her phone', async () => {
  const at = Date.UTC(2026, 9, 28, 20, 0); // 1 am in Lahore, 3 pm in Austin
  await hamza.shareLocation({ lat: 30.27, lng: -97.74, dnd: true, tz: 'America/Chicago', ts: at });
  await ammi.shareLocation({ lat: 31.52, lng: 74.35, tz: 'Asia/Karachi', used: at - 30 * 3600_000 });
  await Promise.all([umair.fetchLocations(), ammi.fetchLocations()]);
  const h = ammi.locations.get(id(hamza));
  assert.deepEqual([h.dnd, h.tz], [true, 'America/Chicago']);
  // Asleep: Do Not Disturb is on (whatever the time is there).
  const a = ammi.availability(id(hamza), h.ts + 60_000);
  assert.deepEqual([a.asleep, a.dnd, a.tz], [true, true, 'America/Chicago']);
  // Night where she is (1 am in Lahore), without Do Not Disturb; afternoon in Austin.
  assert.equal(umair.availability(id(ammi), at).night, true);
  assert.equal(umair.availability(id(hamza), at).night, false);
  // A Do Not Disturb older than 12 hours doesn't count.
  assert.equal(ammi.availability(id(hamza), h.ts + 13 * 3600_000).dnd, false);
  const stored = JSON.stringify(app.store.db.prepare('SELECT env FROM locations').all());
  assert.ok(!stored.includes('Chicago') && !stored.includes('dnd'));
});

test('an elder whose phone hasn’t been used for longer than her admins set shows as inactive', async () => {
  await umair.setMemberRecord(id(ammi), { skin: 'elderly', page: 'care', inactiveHours: 24 });
  const used = umair.locations.get(id(ammi)).used;
  assert.deepEqual(umair.inactiveElders(used + 23 * 3600_000), []);
  const [x] = umair.inactiveElders(used + 31 * 3600_000);
  assert.deepEqual([x.memberId, x.name, x.hours], [id(ammi), 'Ammi', 31]);
  await umair.setMemberRecord(id(ammi), { inactiveHours: 48 });
  assert.deepEqual(umair.inactiveElders(used + 31 * 3600_000), []);
});

test('asking again: only her newest open request is reminded about, the older one stays open', async () => {
  const first = await ammi.askCallback({ tz: 'Asia/Karachi', remind: 10 });
  const second = await ammi.askCallback({ tz: 'Asia/Karachi', remind: 10 });
  await sync();
  assert.deepEqual(umair.callbacksAwaitingMe().map((x) => x.id), [second]);
  assert.equal(umair.callbackState(first).open, true, 'the older request is still open');
  // Answering the newest brings the older one's reminder back (it still asks).
  await umair.replyCallback(second, '5min');
  await sync();
  assert.deepEqual(umair.callbacksAwaitingMe().map((x) => x.id), [first]);
  await umair.replyCallback(first, 'now');
  await hamza.replyCallback(second, 'now');
  await sync();
});
