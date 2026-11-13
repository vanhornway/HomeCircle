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
