// Voice call signals: sealed by the sender for one member, relayed live (or
// held in memory for a phone that is asleep), never stored, limited, and only
// between members of one circle that has calls on.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHmac } from 'node:crypto';
import { createApp } from '../src/index.js';
import { CallRelay } from '../src/calls.js';
import { CircleClient, allFeatures, defaultFeatures, seal, directKey, randomId } from '../../packages/core/src/index.js';

const SETUP = 'test-setup-token-calls';
let app;
let url;
let dir;
const pushed = [];

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
const client = () => new CircleClient({ storage: new MemoryStorage(), onError: (e) => process.env.DEBUG_CALLS && console.error('client error', e.message) });
const mom = client();
const dad = client();
const kid = client();
const stranger = client();

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
const got = (c) => {
  const list = [];
  c.on('callSignal', (s) => list.push(s));
  return list;
};
const id = (c) => c.account.memberId;
const tick = (ms = 120) => new Promise((r) => setTimeout(r, ms));

const baseConfig = (dataDir) => ({
    version: 'test',
    dataDir,
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

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'homecircle-calls-'));
  // Rings are limited in the last test; the others ring a lot.
  app = createApp({ ...baseConfig(dir), callRingsPerMinute: 1000, callRingsPerPairPerMinute: 1000 });
  // Watch what the routes ask the push relay for.
  app.push.call = (members) => pushed.push(members.map((m) => m.id));
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  url = `http://127.0.0.1:${app.server.address().port}`;
});

after(async () => {
  for (const c of [mom, dad, kid, stranger]) c.disconnect();
  await app.close();
  rmSync(dir, { recursive: true, force: true });
});

test('the server says it relays calls', async () => {
  assert.equal((await CircleClient.serverInfo(url)).calls, true);
});

test('calls are off by default, and refused while off', async () => {
  assert.equal(defaultFeatures().calls, false);
  await mom.createCircle({ serverUrl: url, setupToken: SETUP, name: 'Mom', circleName: 'Family', features: defaultFeatures() });
  await dad.joinWithInvite((await mom.createInvite()).link, { name: 'Dad' });
  await kid.joinWithInvite((await mom.createInvite()).link, { name: 'Kid' });
  assert.equal(dad.feature('calls'), false);
  await mom.refresh();
  await assert.rejects(() => mom.sendCallSignal(id(dad), { callId: 'c1', op: 'offer' }, { ring: true }), (e) => e.status === 403 && e.code === 'feature_off' && /Voice calls are turned off/.test(e.message));
  await assert.rejects(() => dad.api.callsPending(), (e) => e.code === 'feature_off');
  await assert.rejects(() => dad.callsConfig(), (e) => e.code === 'feature_off');
  assert.deepEqual(pushed, []);
});

test('an admin turns calls on; members can’t', async () => {
  await assert.rejects(() => dad.setFeatures({ calls: true }), (e) => e.status === 403);
  await mom.setFeatures({ calls: true });
  await dad.refresh();
  await kid.refresh();
  assert.equal(dad.feature('calls'), true);
  const cfg = await dad.callsConfig();
  assert.ok(cfg.iceServers.length >= 1 && cfg.iceServers.every((s) => /^stuns?:/.test(s.urls)));
});

// Rows in every table, so "never stored" is checked against the whole database.
const tableCounts = () =>
  Object.fromEntries(
    app.store.db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
      .all()
      .map(({ name }) => [name, app.store.db.prepare(`SELECT COUNT(*) AS n FROM "${name}"`).get().n]),
  );

test('a signal reaches only the person it is for, opened with the pair’s key, and is never stored', async () => {
  for (const c of [mom, dad, kid]) {
    c.connect();
    await waitOnline(c);
    await c.refresh();
  }
  const atDad = got(dad);
  const atKid = got(kid);
  const before = tableCounts();
  const sdp = 'v=0\r\n' + 'a=fingerprint:sha-256 AB:CD\r\n'.repeat(40);
  const res = await mom.sendCallSignal(id(dad), { callId: 'call-1', op: 'offer', sdp }, { ring: true });
  assert.deepEqual(res, { online: true, held: false, pushed: false }); // nobody to push: no token registered
  await tick();
  assert.equal(atDad.length, 1);
  assert.equal(atDad[0].from, id(mom));
  assert.equal(atDad[0].callId, 'call-1');
  assert.equal(atDad[0].op, 'offer');
  assert.equal(atDad[0].sdp, sdp);
  assert.deepEqual(atKid, []);
  // Answer and candidates go back the same way.
  const atMom = got(mom);
  await dad.sendCallSignal(id(mom), { callId: 'call-1', op: 'answer', sdp: 'ans' });
  await dad.sendCallSignal(id(mom), { callId: 'call-1', op: 'ice', cands: [{ candidate: 'candidate:1 1 udp 1 1.2.3.4 5 typ host' }] });
  await tick();
  assert.deepEqual(atMom.map((s) => s.op), ['answer', 'ice']);
  assert.deepEqual(tableCounts(), before);
});

test('what the server holds is sealed: nothing readable without the pair’s key', async () => {
  // The relay is a pass-through: the ciphertext it forwards doesn't contain the SDP.
  let seen = null;
  const orig = app.hub.send.bind(app.hub);
  app.hub.send = (memberId, msg) => {
    if (msg.type === 'call_signal') seen = JSON.stringify(msg);
    return orig(memberId, msg);
  };
  try {
    await mom.sendCallSignal(id(dad), { callId: 'call-2', op: 'offer', sdp: 'SECRET-SDP-TEXT' }, { ring: true });
    await tick();
  } finally {
    app.hub.send = orig;
  }
  assert.ok(seen);
  assert.ok(!seen.includes('SECRET-SDP-TEXT') && !seen.includes('call-2') && !seen.includes('"offer"'));
  await mom.sendCallSignal(id(dad), { callId: 'call-2', op: 'hangup' });
});

test('a ring pushes the callee; other signals don’t', async () => {
  app.store.db.prepare('UPDATE members SET push_token = ?, push_platform = ? WHERE id = ?').run('ExponentPushToken[dad-token]', 'android', id(dad));
  pushed.length = 0;
  const res = await mom.sendCallSignal(id(dad), { callId: 'call-3', op: 'offer' }, { ring: true });
  assert.equal(res.pushed, true);
  await mom.sendCallSignal(id(dad), { callId: 'call-3', op: 'ice', cands: [] });
  await mom.sendCallSignal(id(dad), { callId: 'call-3', op: 'hangup' });
  assert.deepEqual(pushed, [[id(dad)]]);
});

test('a phone that is asleep gets the signals when it connects, once', async () => {
  dad.disconnect();
  await tick(250);
  assert.equal(app.hub.isOnline(id(dad)), false);
  pushed.length = 0;
  const res = await mom.sendCallSignal(id(dad), { callId: 'call-4', op: 'offer', sdp: 'o' }, { ring: true });
  assert.deepEqual(res, { online: false, held: true, pushed: true });
  await mom.sendCallSignal(id(dad), { callId: 'call-4', op: 'ice', cands: [{ candidate: 'x' }] });
  assert.deepEqual(pushed, [[id(dad)]]);
  const atDad = got(dad);
  dad.connect();
  await waitOnline(dad);
  await tick(250);
  assert.deepEqual(atDad.map((s) => `${s.callId}:${s.op}`), ['call-4:offer', 'call-4:ice']);
  // Handed over once: nothing left to collect, and a second connection gets nothing.
  assert.equal(await dad.collectCallSignals(), 0);
});

test('a phone can also collect what waited, and collecting removes it', async () => {
  dad.disconnect();
  await tick(250);
  await mom.sendCallSignal(id(dad), { callId: 'call-5', op: 'offer', sdp: 'o' }, { ring: true });
  const atDad = got(dad);
  assert.equal(await dad.collectCallSignals(), 1);
  assert.equal(atDad[0].callId, 'call-5');
  assert.equal(await dad.collectCallSignals(), 0);
  dad.connect();
  await waitOnline(dad);
  await tick(150);
  assert.equal(atDad.length, 1);
});

test('the relay forgets held signals after 45 seconds and caps what it holds', () => {
  const r = new CallRelay({ holdMs: 45_000, perMember: 2, total: 3 });
  const t = 1_000_000;
  assert.equal(r.hold('a', { id: '1' }, t), true);
  assert.equal(r.hold('a', { id: '2' }, t), true);
  assert.equal(r.hold('a', { id: '3' }, t), false); // per member
  assert.equal(r.hold('b', { id: '4' }, t), true);
  assert.equal(r.hold('c', { id: '5' }, t), false); // in total
  assert.deepEqual(r.take('a', t + 44_000).map((s) => s.id), ['1', '2']);
  assert.deepEqual(r.take('b', t + 46_000), []);
  assert.equal(r.count, 0);
  r.hold('x', { id: '6' }, t);
  r.sweep(t + 60_000);
  assert.equal(r.held.size, 0);
});

test('only members of the same circle, and only real members', async () => {
  await stranger.createCircle({ serverUrl: url, setupToken: SETUP, name: 'Stranger', circleName: 'Elsewhere', features: allFeatures() });
  const box = got(dad);
  // Into another circle's member, and out of one.
  await assert.rejects(() => stranger.api.callSignal(id(dad), randomId(12), { epoch: 1, nonce: randomId(24), ct: 'AAAA' }), (e) => e.status === 404);
  await assert.rejects(() => mom.api.callSignal(id(stranger), randomId(12), { epoch: 1, nonce: randomId(24), ct: 'AAAA' }), (e) => e.status === 404);
  // Yourself, and someone who doesn't exist.
  await assert.rejects(() => mom.api.callSignal(id(mom), randomId(12), { epoch: 1, nonce: randomId(24), ct: 'AAAA' }), (e) => e.status === 404);
  await assert.rejects(() => mom.api.callSignal('nobody', randomId(12), { epoch: 1, nonce: randomId(24), ct: 'AAAA' }), (e) => e.status === 404 || e.status === 400);
  await tick();
  assert.deepEqual(box, []);
});

test('a removed member can’t be signalled', async () => {
  const gone = client();
  await gone.joinWithInvite((await mom.createInvite()).link, { name: 'Gone' });
  const goneId = id(gone);
  await mom.refresh();
  await mom.removeMember(goneId);
  await assert.rejects(() => mom.sendCallSignal(goneId, { callId: 'x', op: 'offer' }, { ring: true }), (e) => e.status === 404 || /keys/.test(e.message));
});

test('envelopes must be well formed and no bigger than 16 KB', async () => {
  await assert.rejects(() => mom.api.callSignal(id(dad), randomId(12), { epoch: 1, nonce: randomId(24), ct: 'A'.repeat(16 * 1024 + 1) }), (e) => e.status === 400);
  await assert.rejects(() => mom.api.callSignal(id(dad), randomId(12), { epoch: 1, nonce: 'short', ct: 'AAAA' }), (e) => e.status === 400);
  await assert.rejects(() => mom.api.callSignal(id(dad), '', { epoch: 1, nonce: randomId(24), ct: 'AAAA' }), (e) => e.status === 400);
});

test('signals that are old, repeated, or sealed with the wrong key are ignored by the phone', async () => {
  const atDad = got(dad);
  const key = directKey(mom.account.identity.boxSecret, mom.account.known[id(dad)].boxPub);
  const sealAt = (sid, ts, withKey = key, body = { callId: 'late', op: 'offer' }) =>
    seal({ kind: 'call', from: id(mom), to: id(dad), circle: mom.account.circleId, epoch: mom.account.epoch, key: withKey, signSecret: mom.account.identity.signSecret, body, id: sid, ts });
  // Five minutes old: a replay from a call that ended.
  const oldId = randomId(12);
  await mom.api.callSignal(id(dad), oldId, sealAt(oldId, Date.now() - 5 * 60_000));
  // Fresh, sent twice with the same id.
  const freshId = randomId(12);
  const env = sealAt(freshId, Date.now());
  await mom.api.callSignal(id(dad), freshId, env);
  await mom.api.callSignal(id(dad), freshId, env);
  // Sealed with the circle's key, not the pair's: the server can't tell, the phone can.
  const wrongId = randomId(12);
  await mom.api.callSignal(id(dad), wrongId, sealAt(wrongId, Date.now(), mom.account.keyring[mom.account.epoch]));
  // The id inside is what was signed: the same envelope under another id doesn't open.
  const otherId = randomId(12);
  await mom.api.callSignal(id(dad), otherId, env);
  await tick(200);
  assert.deepEqual(atDad.map((s) => s.id), [freshId]);
});

test('rings are limited: 3 a minute to one person, 6 in all; other signals have room', async () => {
  const dir2 = mkdtempSync(join(tmpdir(), 'homecircle-calls-limits-'));
  const app2 = createApp(baseConfig(dir2));
  await new Promise((r) => app2.server.listen(0, '127.0.0.1', r));
  const url2 = `http://127.0.0.1:${app2.server.address().port}`;
  const a = client();
  const b = client();
  const c = client();
  const d = client();
  try {
    await a.createCircle({ serverUrl: url2, setupToken: SETUP, name: 'A', circleName: 'Limits', features: { ...defaultFeatures(), calls: true } });
    await b.joinWithInvite((await a.createInvite()).link, { name: 'B' });
    await c.joinWithInvite((await a.createInvite()).link, { name: 'C' });
    await d.joinWithInvite((await a.createInvite()).link, { name: 'D' });
    await a.refresh();
    for (let i = 0; i < 3; i++) await a.sendCallSignal(id(b), { callId: `r${i}`, op: 'offer' }, { ring: true });
    await assert.rejects(() => a.sendCallSignal(id(b), { callId: 'r3', op: 'offer' }, { ring: true }), (e) => e.status === 429 && e.code === 'rate_limited' && e.retryAfter > 0);
    // Someone else still can be called, up to six in all.
    for (let i = 0; i < 3; i++) await a.sendCallSignal(id(c), { callId: `s${i}`, op: 'offer' }, { ring: true });
    await assert.rejects(() => a.sendCallSignal(id(c), { callId: 's3', op: 'offer' }, { ring: true }), (e) => e.status === 429);
    await assert.rejects(() => a.sendCallSignal(id(d), { callId: 't0', op: 'offer' }, { ring: true }).then(() => a.sendCallSignal(id(d), { callId: 't1', op: 'offer' }, { ring: true })).then(() => a.sendCallSignal(id(d), { callId: 't2', op: 'offer' }, { ring: true })), (e) => e.status === 429);
    // Candidates and hang-ups aren't rings.
    for (let i = 0; i < 20; i++) await a.sendCallSignal(id(b), { callId: 'r0', op: 'ice', cands: [] });
    // Nor is there more than 90 signals a minute of any kind.
    let refused = null;
    for (let i = 0; i < 90 && !refused; i++) refused = await a.sendCallSignal(id(b), { callId: 'r0', op: 'ice', cands: [] }).then(() => null, (e) => e);
    assert.equal(refused?.status, 429);
  } finally {
    await app2.close();
    rmSync(dir2, { recursive: true, force: true });
  }
});

test('a TURN relay is offered only when configured, with credentials that expire', async () => {
  // Not configured: STUN only.
  const plain = (await dad.callsConfig()).iceServers;
  assert.ok(plain.every((s) => !s.username && !String(s.urls).startsWith('turn')));

  const dir3 = mkdtempSync(join(tmpdir(), 'homecircle-calls-turn-'));
  const app3 = createApp({ ...baseConfig(dir3), callsStun: ['stun:stun.example.org:3478'], callsTurnUrls: ['turn:turn.example.org:3478?transport=udp', 'turns:turn.example.org:443?transport=tcp'], callsTurnSecret: 'a-long-shared-secret', callsTurnTtlHours: 2, callsRelayOnly: true });
  await new Promise((r) => app3.server.listen(0, '127.0.0.1', r));
  const a = client();
  try {
    await a.createCircle({ serverUrl: `http://127.0.0.1:${app3.server.address().port}`, setupToken: SETUP, name: 'A', circleName: 'Relay', features: { ...defaultFeatures(), calls: true } });
    const cfg = await a.callsConfig();
    assert.deepEqual(cfg.iceServers[0], { urls: 'stun:stun.example.org:3478' });
    const turn = cfg.iceServers[1];
    assert.deepEqual(turn.urls, ['turn:turn.example.org:3478?transport=udp', 'turns:turn.example.org:443?transport=tcp']);
    // coturn's use-auth-secret: username "<expiry>:<name>", password = base64(HMAC-SHA1(secret, username)).
    const [expiry] = turn.username.split(':');
    const ttl = Number(expiry) - Date.now() / 1000;
    assert.ok(ttl > 7000 && ttl <= 7200 + 5, `expires in about 2 hours, got ${ttl}`);
    assert.equal(turn.credential, createHmac('sha1', 'a-long-shared-secret').update(turn.username).digest('base64'));
    assert.equal(cfg.relayOnly, true);
    // The member id isn't in the username.
    assert.ok(!turn.username.includes(id(a)));
  } finally {
    await app3.close();
    rmSync(dir3, { recursive: true, force: true });
  }
});

test('the caller leaves "missed" and "how long" lines in the direct chat', async () => {
  const seen = waitFor(dad, 'newMessage', (m) => m.body?.call?.state === 'missed');
  await mom.logCall(id(dad), { missed: true });
  assert.match((await seen).body.text, /Missed voice call/);
  const done = waitFor(dad, 'newMessage', (m) => m.body?.call?.state === 'ended');
  await mom.logCall(id(dad), { seconds: 192 });
  const m = await done;
  assert.equal(m.body.text, '📞 Voice call · 3:12');
  assert.equal(m.body.call.seconds, 192);
});
