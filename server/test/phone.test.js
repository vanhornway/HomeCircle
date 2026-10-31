// Sealed phone numbers (a member's own, or an admin's for an elder) and the
// circle's WhatsApp call link: the server holds ciphertext only, and only the
// right people may set them.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/index.js';
import { CircleClient, allFeatures, defaultFeatures, hasFeature, cleanPhone, cleanCallLink } from '../../packages/core/src/index.js';

const SETUP = 'test-setup-token-phone';
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
  dir = mkdtempSync(join(tmpdir(), 'homecircle-phone-'));
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
const zara = client();
const fatima = client();
const all = [umair, sara, zara, fatima];
const id = (c) => c.account.memberId;
const syncAll = async () => {
  await refreshAll();
  await Promise.all(all.map((c) => c.fetchRecords()));
};
const refreshAll = () => Promise.all(all.map((c) => c.refresh()));
const LINK = 'https://call.whatsapp.com/video/AbCdEfGh12345';

test('set up a family', async () => {
  await umair.createCircle({ features: allFeatures(), serverUrl: url, setupToken: SETUP, name: 'Umair', circleName: 'Family' });
  for (const [c, name] of [[sara, 'Sara'], [zara, 'Zara'], [fatima, 'Fatima']]) await c.joinWithInvite((await umair.createInvite()).link, { name });
  await refreshAll();
  await umair.setRole(id(sara), 'admin');
  await refreshAll();
});

test('phone numbers are cleaned to +digits, and one without a country code is refused', () => {
  assert.equal(cleanPhone('+92 (300) 123-4567'), '+923001234567');
  assert.equal(cleanPhone('0092 300 1234567'), '+923001234567', 'a leading 00 is a +');
  assert.equal(cleanPhone('+1.555.123.4567'), '+15551234567');
  for (const bad of ['03001234567', '(555) 123-4567', '+1234567', '+1234567890123456', '+0123456789', 'call me', '+92 300 abc', '++923001234567', '92+3001234567', '', null, undefined, 5551234567]) {
    assert.equal(cleanPhone(bad), null, String(bad));
  }
});

test('only WhatsApp call links are kept, trimmed of anything extra', () => {
  assert.equal(cleanCallLink(` ${LINK}?src=x#y `), LINK);
  assert.equal(cleanCallLink('https://call.whatsapp.com/voice/AbCdEfGh12345/'), 'https://call.whatsapp.com/voice/AbCdEfGh12345');
  for (const bad of ['http://call.whatsapp.com/video/AbCdEfGh12345', 'https://wa.me/15551234567', 'https://call.whatsapp.com.evil.com/video/AbCdEfGh12345', 'https://evil.com/call.whatsapp.com/video/AbCdEfGh12345', 'https://call.whatsapp.com/video/', 'https://call.whatsapp.com/other/AbCdEfGh12345', 'https://u:p@call.whatsapp.com/video/AbCdEfGh12345', 'javascript:alert(1)', '', null]) {
    assert.equal(cleanCallLink(bad), null, String(bad));
  }
});

test('a member adds their own number: the circle reads it, the server cannot', async () => {
  await assert.rejects(zara.setPhone('0300 1234567'), /country code/);
  await zara.setPhone('+1 (555) 010-2030');
  await refreshAll();
  for (const c of all) assert.equal(c.phoneOf(id(zara)), '+15550102030');
  assert.equal(umair.phoneOf(id(sara)), null);
  for (const table of ['members', 'records', 'circles']) {
    let rows = [];
    try {
      rows = app.store.db.prepare(`SELECT * FROM ${table}`).all();
    } catch {
      continue;
    }
    assert.ok(!JSON.stringify(rows).includes('5550102030'), `server can't read it (${table})`);
  }
  await zara.setPhone('');
  await refreshAll();
  assert.equal(umair.phoneOf(id(zara)), null);
});

test('an admin sets an elder’s number in her member record; she cannot, and a non-admin cannot', async () => {
  await sara.setMemberRecord(id(fatima), { skin: 'elderly', phone: '0092 300 7654321' });
  await syncAll();
  for (const c of all) {
    assert.equal(c.memberRecord(id(fatima)).phone, '+923007654321');
    assert.equal(c.phoneOf(id(fatima)), '+923007654321');
  }
  await assert.rejects(zara.setMemberRecord(id(fatima), { phone: '+15550000000' }), /Only circle admins/);
  // A later record without a phone keeps it (merged), and a bad one is dropped.
  await sara.setMemberRecord(id(fatima), { lang: 'ur' });
  await sara.setMemberRecord(id(fatima), { phone: 'nonsense' });
  await syncAll();
  assert.equal(umair.memberRecord(id(fatima)).phone, null);
  await sara.setMemberRecord(id(fatima), { phone: '+923007654321' });
  await syncAll();
  // Her own number, once she adds it, wins over the admin's.
  await fatima.setPhone('+92 300 1111111');
  await syncAll();
  assert.equal(umair.phoneOf(id(fatima)), '+923001111111');
  const stored = JSON.stringify(app.store.db.prepare('SELECT env FROM records').all());
  assert.ok(!stored.includes('7654321') && !stored.includes('1111111'));
});

test('the group call link: admins set it, everyone reads it, the server cannot', async () => {
  assert.equal(zara.groupCallLink, null);
  await assert.rejects(zara.setGroupCallLink(LINK), /Only circle admins/);
  await assert.rejects(sara.setGroupCallLink('https://example.com/video/AbCdEfGh12345'), /isn.t a WhatsApp call link/);
  await sara.setGroupCallLink(`${LINK}?junk=1`);
  await refreshAll();
  for (const c of all) assert.equal(c.groupCallLink, LINK);
  assert.ok(!JSON.stringify(app.store.db.prepare('SELECT * FROM circles').all()).includes('AbCdEfGh12345'));

  // Past the client check, the server refuses a non-admin's circle record too.
  await assert.rejects(zara.api.putCircle(zara._seal('circle', { name: 'Family', groupCallLink: LINK })), (e) => e.status === 403);

  // Other circle edits keep the link (renaming, adding an agent card).
  await umair.setCircleName('Our Family');
  await refreshAll();
  assert.equal(zara.circle.name, 'Our Family');
  assert.equal(zara.groupCallLink, LINK);

  await umair.setGroupCallLink('');
  await refreshAll();
  assert.equal(fatima.groupCallLink, null);
});

test('WhatsApp calls are a plugin: off in a new circle, on only when an admin switches it on', async () => {
  assert.equal(defaultFeatures().whatsapp, false);
  assert.equal(hasFeature(allFeatures(), 'whatsapp'), true, 'circles from before features keep everything');
  await umair.setFeatures({ whatsapp: false });
  await refreshAll();
  for (const c of all) assert.equal(c.feature('whatsapp'), false);
  await assert.rejects(zara.setFeatures({ whatsapp: true }), (e) => e.status === 403);
  await sara.setFeatures({ whatsapp: true });
  await refreshAll();
  for (const c of all) assert.equal(c.feature('whatsapp'), true);
});

test('no client reported an error', () => {
  assert.deepEqual(errors, []);
});
