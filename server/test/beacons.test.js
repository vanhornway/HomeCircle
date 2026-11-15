// Public beacons: a tracker's rounded position on the public Meshtastic
// channel, read from the public MQTT server and handed to its home base.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCipheriv } from 'node:crypto';
import { createApp } from '../src/index.js';
import { decodeBeacon } from '../src/beacons.js';
import { CircleClient, allFeatures } from '../../packages/core/src/index.js';

// --- a ServiceEnvelope as a gateway publishes it -------------------------------------
const varint = (n) => {
  const out = [];
  let v = BigInt.asUintN(64, BigInt(n));
  while (v > 127n) {
    out.push(Number(v & 127n) | 128);
    v >>= 7n;
  }
  out.push(Number(v));
  return out;
};
const tag = (n, w) => varint((n << 3) | w);
const len = (n, b) => [...tag(n, 2), ...varint(b.length), ...b];
const f32 = (n, v, signed = false) => {
  const b = Buffer.alloc(4);
  signed ? b.writeInt32LE(v) : b.writeUInt32LE(v >>> 0);
  return [...tag(n, 5), ...b];
};
const uv = (n, v) => [...tag(n, 0), ...varint(v)];
function envelope({ from, id = 12345, lat, lng, time, port = 3, encrypt = true, gateway = '!0badf00d' }) {
  const position = Buffer.from([...f32(1, Math.round(lat * 1e7), true), ...f32(2, Math.round(lng * 1e7), true), ...f32(4, time)]);
  const data = Buffer.from([...uv(1, port), ...len(2, position)]);
  let body;
  if (encrypt) {
    const iv = Buffer.alloc(16);
    iv.writeUInt32LE(id, 0);
    iv.writeUInt32LE(from, 8);
    const c = createCipheriv('aes-128-ctr', Buffer.from('1PG7OiApB1nwvP+rz05pAQ==', 'base64'), iv);
    body = len(5, Buffer.concat([c.update(data), c.final()]));
  } else body = len(4, data);
  const pkt = Buffer.from([...f32(1, from), ...f32(2, 0xffffffff), ...body, ...f32(6, id)]);
  return Buffer.from([...len(1, pkt), ...len(2, Buffer.from('LongFast')), ...len(3, Buffer.from(gateway))]);
}

test('a beacon from a watched tracker opens with the default key; anything else is skipped', () => {
  const UT2 = 0x9e58f8c9;
  const watch = new Map([[UT2, new Set(['hb'])]]);
  const b = decodeBeacon(envelope({ from: UT2, lat: 37.53, lng: -121.95, time: 1794600000 }), watch);
  assert.deepEqual(b, { from: UT2, lat: 37.53, lng: -121.95, at: 1794600000000, gateway: '!0badf00d' });
  assert.equal(decodeBeacon(envelope({ from: 0x11111111, lat: 1, lng: 1, time: 1 }), watch), null, 'not one of ours');
  assert.equal(decodeBeacon(envelope({ from: UT2, lat: 1, lng: 1, time: 1, port: 1 }), watch), null, 'not a position');
  assert.equal(decodeBeacon(Buffer.from([1, 2, 3]), watch), null, 'garbage');
  assert.equal(decodeBeacon(envelope({ from: UT2, lat: 2, lng: 3, time: 5, encrypt: false }), watch).lat, 2, 'or sent in the clear');
});

test('fuzz: whatever the public server sends, the decoder answers null or a sane beacon, quickly', () => {
  const UT2 = 0x9e58f8c9;
  const watch = new Map([[UT2, new Set(['hb'])]]);
  const good = envelope({ from: UT2, lat: 37.53, lng: -121.95, time: 1794600000 });
  // A small, seeded generator: the same cases every run.
  let seed = 0x2545f491;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32);
  const started = Date.now();
  for (let i = 0; i < 20_000; i++) {
    let buf;
    if (i % 3 === 0) {
      buf = Buffer.alloc(Math.floor(rnd() * 300));
      for (let j = 0; j < buf.length; j++) buf[j] = Math.floor(rnd() * 256);
    } else {
      // A real envelope with a few bytes changed, cut short or grown.
      buf = Buffer.from(good);
      for (let k = 0; k < 1 + Math.floor(rnd() * 4); k++) buf[Math.floor(rnd() * buf.length)] = Math.floor(rnd() * 256);
      if (i % 3 === 1) buf = buf.subarray(0, Math.floor(rnd() * buf.length));
      else buf = Buffer.concat([buf, Buffer.from([0xff, 0xff, 0xff, 0xff, 0x0f])]);
    }
    const b = decodeBeacon(buf, watch);
    if (b === null) continue;
    assert.equal(b.from, UT2);
    assert.ok(Number.isFinite(b.lat) && Math.abs(b.lat) <= 90 && Number.isFinite(b.lng) && Math.abs(b.lng) <= 180, JSON.stringify(b));
    assert.ok(b.gateway === null || /^![0-9a-f]{8}$/.test(b.gateway));
  }
  // A huge length or deep nesting in the input can't make it slow.
  assert.equal(decodeBeacon(Buffer.from([0x0a, 0xff, 0xff, 0xff, 0xff, 0x0f, 1, 2, 3]), watch), null);
  assert.equal(decodeBeacon(Buffer.alloc(1 << 20, 0x0a), watch), null);
  assert.ok(Date.now() - started < 5000, `took ${Date.now() - started} ms`);
});

// --- the route ------------------------------------------------------------------------
const SETUP = 'test-setup-beacons';
let app;
let url;
let dir;
class MemoryStorage {
  constructor() {
    this.m = new Map();
  }
  async getItem(k) {
    return this.m.get(k) ?? null;
  }
  async setItem(k, v) {
    this.m.set(k, v);
  }
  async removeItem(k) {
    this.m.delete(k);
  }
}
const client = () => new CircleClient({ storage: new MemoryStorage(), onError: () => {} });
before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'homecircle-beacons-'));
  app = createApp({ version: 'test', dataDir: dir, setupToken: SETUP, trustProxy: false, messageRetentionDays: 90, locationRequestCooldown: 60, inviteMaxHours: 168, push: 'none', tileUrl: 'x', tileAttribution: 'x', webClient: false, wsAuthTimeoutMs: 300, meshPublicMqtt: 'off' });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  url = `http://127.0.0.1:${app.server.address().port}`;
});
after(async () => {
  await app.close();
  rmSync(dir, { recursive: true, force: true });
});

test('a home base names its trackers with a beacon on; their beacons wait for it like requests', async () => {
  const admin = client();
  const hb = client();
  const ut2 = client();
  const other = client();
  await admin.createCircle({ features: { ...allFeatures(), meshtastic: true }, serverUrl: url, setupToken: SETUP, name: 'Umair', circleName: 'Family' });
  for (const [c, name] of [[hb, 'Home base'], [ut2, 'UT2'], [other, 'Someone']]) await c.joinWithInvite((await admin.createInvite()).link, { name });
  await ut2.api.req('PUT', '/members/me/keeper', { keeper: hb.account.memberId });

  const res = await hb.api.req('PUT', '/keeper/beacons', {
    nodes: [
      { node: '!9e58f8c9', member: ut2.account.memberId },
      { node: '!12345678', member: other.account.memberId }, // not one it keeps: ignored
    ],
  });
  assert.equal(res.watching, 1);
  assert.equal(app.beacons.watching, 1);

  app.beacons.onBeacon(0x9e58f8c9, { lat: 37.53, lng: -121.95, at: 1794600000000, gateway: '!0badf00d' });
  app.beacons.onBeacon(0x12345678, { lat: 1, lng: 1, at: 1, gateway: null });
  const { pending } = await hb.api.req('GET', '/keeper/pending');
  assert.equal(pending.length, 1);
  assert.deepEqual(
    { type: pending[0].type, member: pending[0].member, lat: pending[0].lat, lng: pending[0].lng, gateway: pending[0].gateway },
    { type: 'beacon', member: ut2.account.memberId, lat: 37.53, lng: -121.95, gateway: '!0badf00d' },
  );

  // Turned off: nothing to watch.
  await hb.api.req('PUT', '/keeper/beacons', { nodes: [] });
  assert.equal(app.beacons.watching, 0);
});

test('a home base in two circles keeps the same tracker in each: each circle gets its beacon', async () => {
  const circle = async (name) => {
    const admin = client();
    const hb = client();
    const tag = client();
    await admin.createCircle({ features: { ...allFeatures(), meshtastic: true }, serverUrl: url, setupToken: SETUP, name: 'Admin', circleName: name });
    for (const [c, n] of [[hb, 'Home base'], [tag, 'UT1']]) await c.joinWithInvite((await admin.createInvite()).link, { name: n });
    await tag.api.req('PUT', '/members/me/keeper', { keeper: hb.account.memberId });
    await hb.api.req('PUT', '/keeper/beacons', { nodes: [{ node: '!28d59f33', member: tag.account.memberId }] });
    return { hb, tag };
  };
  const family = await circle('Family');
  const extended = await circle('Extended family');
  app.beacons.onBeacon(0x28d59f33, { lat: 37.5, lng: -121.9, at: 1794600000000, gateway: null });
  for (const c of [family, extended]) {
    const { pending } = await c.hb.api.req('GET', '/keeper/pending');
    assert.deepEqual(pending.map((p) => [p.type, p.member]), [['beacon', c.tag.account.memberId]]);
  }
  // One circle stops watching: the other still does.
  await family.hb.api.req('PUT', '/keeper/beacons', { nodes: [] });
  app.beacons.onBeacon(0x28d59f33, { lat: 37.6, lng: -121.9, at: 1794600060000, gateway: null });
  assert.equal((await family.hb.api.req('GET', '/keeper/pending')).pending.length, 0);
  assert.equal((await extended.hb.api.req('GET', '/keeper/pending')).pending.length, 1);
  await extended.hb.api.req('PUT', '/keeper/beacons', { nodes: [] });
});
