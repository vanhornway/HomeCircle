// Hardening in 0.30: tokens renew, plugins can't be pointed at cloud metadata
// or follow redirects, and a copy of the data folder taken while the server
// runs (as a Home Assistant backup is) opens with everything in it.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/index.js';
import { addressFetch, forbiddenAddress } from '../src/plugins/index.js';
import { CircleClient, allFeatures } from '../../packages/core/src/index.js';

const SETUP = 'test-setup-hardening-030';
const opts = (dataDir) => ({ version: 'test', dataDir, setupToken: SETUP, trustProxy: false, messageRetentionDays: 90, locationRequestCooldown: 60, inviteMaxHours: 168, push: 'none', tileUrl: 'x', tileAttribution: 'x', webClient: false, meshPublicMqtt: 'off' });
let app;
let url;
let dir;
class MemoryStorage {
  constructor(m = new Map()) {
    this.m = m;
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
const client = (storage = new MemoryStorage()) => new CircleClient({ storage, onError: () => {} });
const state = (base, token) => fetch(`${base}/api/v1/state`, { headers: { Authorization: `Bearer ${token}` } }).then((r) => r.status);

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'homecircle-hardening-030-'));
  app = createApp(opts(join(dir, 'data')));
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  url = `http://127.0.0.1:${app.server.address().port}`;
});
after(async () => {
  await app.close();
  rmSync(dir, { recursive: true, force: true });
});

test('a token renews every 30 days; the old one works until the new one is used', async () => {
  const mom = client();
  const kid = client();
  await mom.createCircle({ features: allFeatures(), serverUrl: url, setupToken: SETUP, name: 'Mom', circleName: 'Family' });
  await kid.joinWithInvite((await mom.createInvite()).link, { name: 'Kid' });
  await kid.refresh();
  assert.ok(kid.account.tokenAt, 'the clock starts');

  const old = kid.account.token;
  await kid._renewToken(kid.account.tokenAt + 29 * 86400_000);
  assert.equal(kid.account.token, old, 'not before 30 days');
  await kid._renewToken(kid.account.tokenAt + 31 * 86400_000);
  const fresh = kid.account.token;
  assert.notEqual(fresh, old);
  assert.equal(await state(url, old), 200, 'the old one still works: the answer might have been lost');
  assert.equal(await state(url, fresh), 200);
  assert.equal(await state(url, old), 401, 'once the new one is used, the old one is gone');
  await kid.refresh();

  // A removed member's tokens, old and new, both stop.
  const before = kid.account.token;
  await kid._renewToken(kid.account.tokenAt + 31 * 86400_000);
  await mom.removeMember(kid.account.memberId);
  assert.equal(await state(url, before), 401);
  assert.equal(await state(url, kid.account.token), 401);
});

test('plugins: no cloud metadata, no "any address", no following redirects', async () => {
  for (const ip of ['169.254.169.254', '::ffff:169.254.169.254', '0.0.0.0', 'fe80::1', '100.100.100.200', 'fd00:ec2::254', '::']) assert.equal(forbiddenAddress(ip), true, ip);
  for (const ip of ['127.0.0.1', '192.168.1.10', '10.0.0.5', '172.17.0.2', '93.184.216.34', '::1']) assert.equal(forbiddenAddress(ip), false, ip);

  const seen = [];
  const fake = async (u, init) => {
    seen.push([u, init.redirect]);
    return new Response('', { status: 302, headers: { Location: 'http://169.254.169.254/latest/meta-data/' } });
  };
  await assert.rejects(addressFetch('http://169.254.169.254', fake)('/latest/meta-data/'), /may not call/);
  await assert.rejects(addressFetch('http://metadata.google.internal', fake)('/computeMetadata/v1/'), /may not call/);
  assert.equal(seen.length, 0, 'never called');
  const res = await addressFetch('http://127.0.0.1:8123', fake)('/api/');
  assert.equal(res.status, 302, 'a redirect is an answer, not followed');
  assert.deepEqual(seen, [['http://127.0.0.1:8123/api/', 'manual']]);
});

test('a copy of the data folder taken while the server runs opens with everything in it', async () => {
  const live = createApp(opts(join(dir, 'live')));
  await new Promise((r) => live.server.listen(0, '127.0.0.1', r));
  const lurl = `http://127.0.0.1:${live.server.address().port}`;
  const mom = client();
  try {
    await mom.createCircle({ features: allFeatures(), serverUrl: lurl, setupToken: SETUP, name: 'Mom', circleName: 'Backup test' });
    await mom.sendChat('Before the backup');
    await mom.savePlace({ name: 'Home', lat: 37.5, lng: -122, radius: 150 });
    // Copied as it is, mid-write-ahead-log, the way a hot backup copies files.
    cpSync(join(dir, 'live'), join(dir, 'restored'), { recursive: true });
  } finally {
    await live.close();
  }
  const restored = createApp(opts(join(dir, 'restored')));
  await new Promise((r) => restored.server.listen(0, '127.0.0.1', r));
  try {
    const rurl = `http://127.0.0.1:${restored.server.address().port}`;
    const again = client(new MemoryStorage(new Map(mom.storage.m)));
    await again.load();
    again.account.server = rurl;
    again.api = again._makeApi(rurl, again.account.token);
    await again.refresh();
    await again._fetchMessages();
    assert.ok(again.messages.some((m) => m.body?.text === 'Before the backup'), 'the message is there');
    await again.fetchPlaces();
    assert.ok([...again.places.values()].some((p) => p.name === 'Home'), 'the place is there');
  } finally {
    await restored.close();
  }
});
