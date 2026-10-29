// Sealed records: admin settings about a member, and family names (what one
// member calls another). The server checks who may write from ids alone and
// never reads them; phones check the signatures again.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/index.js';
import { CircleClient, allFeatures } from '../../packages/core/src/index.js';

const SETUP = 'test-setup-token-records';
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
  dir = mkdtempSync(join(tmpdir(), 'homecircle-records-'));
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

// Umair owns the circle; Sara is an admin; Zara and Ali are grandkids; Fatima is the grandmother.
const umair = client();
const sara = client();
const zara = client();
const ali = client();
const fatima = client();
const all = [umair, sara, zara, ali, fatima];
const id = (c) => c.account.memberId;
const syncRecords = () => Promise.all(all.map((c) => c.fetchRecords()));

test('set up a family', async () => {
  await umair.createCircle({ features: allFeatures(), serverUrl: url, setupToken: SETUP, name: 'Umair', circleName: 'Family' });
  for (const [c, name] of [[sara, 'Sara'], [zara, 'Zara'], [ali, 'Ali'], [fatima, 'Fatima']]) await c.joinWithInvite((await umair.createInvite()).link, { name });
  await Promise.all(all.map((c) => c.refresh()));
  await umair.setRole(id(sara), 'admin');
  await Promise.all(all.map((c) => c.refresh()));
});

test('family names are per pair: Nani to one grandchild, Dadi to another', async () => {
  await zara.setFamilyName(id(zara), id(fatima), { name: 'Nani', rel: 'grandparent' });
  await fatima.setFamilyName(id(ali), id(fatima), { name: 'Dadi', rel: 'grandparent' }); // the named person sets it
  await sara.setFamilyName(id(umair), id(fatima), { name: 'Ammi' }); // an admin sets it for someone else
  await syncRecords();
  for (const c of all) {
    assert.equal(c.familyName(id(zara), id(fatima)), 'Nani');
    assert.equal(c.familyName(id(ali), id(fatima)), 'Dadi');
    assert.equal(c.familyName(id(umair), id(fatima)), 'Ammi');
  }
  // Each viewer sees their own name for her; anyone else sees her own name.
  assert.equal(zara.displayName(id(fatima)), 'Nani');
  assert.equal(ali.displayName(id(fatima)), 'Dadi');
  assert.equal(sara.displayName(id(fatima)), 'Fatima', 'falls back to her profile name');
  // Both ways: what Fatima calls Zara.
  await fatima.setFamilyName(id(fatima), id(zara), { name: 'زارا' });
  await syncRecords();
  assert.equal(fatima.displayName(id(zara)), 'زارا');
  const stored = JSON.stringify(app.store.db.prepare('SELECT env FROM records').all());
  for (const word of ['Nani', 'Dadi', 'Ammi', 'grandparent']) assert.ok(!stored.includes(word), `server can't read "${word}"`);
});

test('only the caller, the named person or an admin may set a family name', async () => {
  // Ali isn't Zara, isn't Fatima, isn't an admin.
  await assert.rejects(ali.setFamilyName(id(zara), id(fatima), { name: 'Grandma' }), /either of them or an admin/);
  // Past the client check, the server refuses too.
  const env = ali._seal('alias', { caller: id(zara), member: id(fatima), name: 'Grandma' });
  await assert.rejects(ali.api.putRecord('alias', `${id(zara)}.${id(fatima)}`, env), (e) => e.status === 403);
  await syncRecords();
  assert.equal(umair.familyName(id(zara), id(fatima)), 'Nani');
});

test('the latest valid change wins, and an empty name removes it', async () => {
  await umair.setFamilyName(id(zara), id(fatima), { name: 'Nano' });
  await zara.setFamilyName(id(zara), id(fatima), { name: 'Nani Jan' });
  await syncRecords();
  assert.equal(ali.familyName(id(zara), id(fatima)), 'Nani Jan');
  await zara.setFamilyName(id(zara), id(fatima), { name: '' });
  await syncRecords();
  assert.equal(ali.familyName(id(zara), id(fatima)), null);
  assert.equal(zara.displayName(id(fatima)), 'Fatima');
});

test('a family name moved to another pair, or signed by someone not allowed, is ignored', async () => {
  // A server replaying Zara's alias for Ali's pair: the sealed ids don't match the subject.
  await zara.setFamilyName(id(zara), id(fatima), { name: 'Nani' });
  const row = app.store.db.prepare("SELECT * FROM records WHERE kind = 'alias' AND subject = ?").get(`${id(zara)}.${id(fatima)}`);
  app.store.putRecord({ circleId: umair.circleId, kind: 'alias', subject: `${id(ali)}.${id(fatima)}`, env: JSON.parse(row.env), by: id(zara), now: Date.now() });
  // And one signed by Ali, slipped in by the server past its own check.
  const forged = ali._seal('alias', { caller: id(sara), member: id(umair), name: 'Boss' });
  app.store.putRecord({ circleId: umair.circleId, kind: 'alias', subject: `${id(sara)}.${id(umair)}`, env: forged, by: id(ali), now: Date.now() });
  await umair.fetchRecords();
  assert.equal(umair.familyName(id(ali), id(fatima)), null);
  assert.equal(umair.familyName(id(sara), id(umair)), null);
  assert.equal(umair.familyName(id(zara), id(fatima)), 'Nani');
});

test('member records: admins write them, phones accept only an admin’s signature', async () => {
  await sara.setMemberRecord(id(fatima), { skin: 'elderly', page: 'care', ringEveryone: true, sleep: { from: '22:00', to: '07:00' }, remindEvery: 15, lang: 'ur', g: 'f' });
  await syncRecords();
  const r = fatima.memberRecord(id(fatima));
  assert.deepEqual(
    { skin: r.skin, page: r.page, ringEveryone: r.ringEveryone, sleep: r.sleep, remindEvery: r.remindEvery, lang: r.lang, g: r.g, by: r.by },
    { skin: 'elderly', page: 'care', ringEveryone: true, sleep: { from: '22:00', to: '07:00' }, remindEvery: 15, lang: 'ur', g: 'f', by: id(sara) },
  );
  // A patch keeps the rest.
  await umair.setMemberRecord(id(fatima), { remindEvery: 10 });
  await syncRecords();
  assert.equal(fatima.memberRecord(id(fatima)).remindEvery, 10);
  assert.equal(fatima.memberRecord(id(fatima)).page, 'care');
  // Not an admin: the app, then the server, refuse.
  await assert.rejects(zara.setMemberRecord(id(ali), { skin: 'elderly' }), /Only circle admins/);
  await assert.rejects(zara.api.putRecord('member', id(ali), zara._seal('member', { member: id(ali), skin: 'elderly' })), (e) => e.status === 403);
  // A record signed by a non-admin, slipped in by the server: phones ignore it.
  app.store.putRecord({ circleId: umair.circleId, kind: 'member', subject: id(ali), env: zara._seal('member', { member: id(ali), skin: 'elderly' }), by: id(zara), now: Date.now() });
  await ali.fetchRecords();
  assert.equal(ali.memberRecord(id(ali)), null);
});

test('he or she: your own profile first, else an admin’s choice', async () => {
  assert.equal(umair.genderOf(id(fatima)), 'f', 'from the admin record');
  await zara.setGender('f');
  await umair.refresh();
  assert.equal(umair.genderOf(id(zara)), 'f', 'from her own profile');
  assert.equal(umair.members.get(id(zara)).g, 'f');
  assert.equal(umair.genderOf(id(ali)), null);
});

test('marking an admin as an elder removes the admin role; only the owner can', async () => {
  await assert.rejects(sara.markElder(id(umair)), /owner can’t be marked/);
  await umair.setRole(id(ali), 'admin');
  await Promise.all(all.map((c) => c.refresh()));
  await assert.rejects(sara.markElder(id(ali)), /Only the circle’s owner/);
  await umair.markElder(id(ali), { page: 'grandkids' });
  await Promise.all(all.map((c) => c.refresh()));
  await syncRecords();
  assert.equal(sara.members.get(id(ali)).role, 'member');
  assert.equal(ali.memberRecord(id(ali)).skin, 'elderly');
});

test('an elder announces herself; admins see who still needs a member record', async () => {
  const nana = client();
  await nana.joinWithInvite((await umair.createInvite({ companion: { name: 'Nana', page: 'grandkids' } })).link);
  await Promise.all([umair.refresh(), nana.refresh()]);
  await nana.announceElder({ page: 'grandkids' });
  await umair.fetchMessages();
  await umair.fetchRecords();
  assert.deepEqual(umair.unrecordedElders(), [{ memberId: id(nana), page: 'grandkids', skin: 'elderly' }]);
  await umair.setMemberRecord(id(nana), { skin: 'elderly', page: 'grandkids' });
  assert.deepEqual(umair.unrecordedElders(), []);
});

test('a removed member’s records go with them', async () => {
  await umair.removeMember(id(fatima));
  const left = app.store.db.prepare('SELECT subject FROM records').all().map((r) => r.subject);
  assert.ok(!left.some((s) => s.split('.').includes(id(fatima))));
  const info = await (await fetch(`${url}/api/v1/info`)).json();
  assert.equal(info.records, true);
  assert.deepEqual(errors.filter((e) => !/signature|verif/i.test(String(e?.message))), []);
});
