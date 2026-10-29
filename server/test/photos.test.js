// Members' photos: encrypted on the phone, the key only inside a sealed
// profile (your own photo) or member record (a photo an admin adds for an
// elder's tiles). Kept until replaced or their uploader leaves.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/index.js';
import { CircleClient, allFeatures } from '../../packages/core/src/index.js';

const SETUP = 'test-setup-token-photos';
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
const client = () => new CircleClient({ storage: new MemoryStorage() });

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'homecircle-photos-'));
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
const hamza = client();
const ammi = client();
const id = (c) => c.account.memberId;
const jpeg = (n) => new Uint8Array(Array.from({ length: 3000 }, (_, i) => (i * n) % 256));
const fileRows = () => app.store.db.prepare('SELECT id, uploader_id, purpose, expires_at FROM files').all();

test('your own photo: encrypted, its key only in your sealed profile', async () => {
  await umair.createCircle({ features: allFeatures(), serverUrl: url, setupToken: SETUP, name: 'Umair', circleName: 'Care' });
  await hamza.joinWithInvite((await umair.createInvite()).link, { name: 'Hamza' });
  await ammi.joinWithInvite((await umair.createInvite({ companion: { name: 'Ammi', page: 'care' } })).link);
  await Promise.all([umair, hamza, ammi].map((c) => c.refresh()));
  await umair.setProfilePhoto(jpeg(7));
  await ammi.refresh();
  const ref = ammi.members.get(id(umair)).photo;
  assert.ok(ref?.id && ref.key);
  assert.deepEqual(await ammi.photoBytes(ref), jpeg(7));
  // On the server: ciphertext only, kept (no expiry), and the key nowhere.
  const [row] = fileRows();
  assert.deepEqual([row.purpose, row.expires_at], ['photo', null]);
  assert.notDeepEqual(new Uint8Array(readFileSync(join(dir, 'files', row.id))).subarray(24, 3024), jpeg(7));
  assert.ok(!JSON.stringify(app.store.db.prepare('SELECT * FROM members').all()).includes(ref.key));
});

test('a new photo replaces the old one, and its file is deleted', async () => {
  const old = (await hamza.refresh(), hamza.members.get(id(umair)).photo);
  await umair.setProfilePhoto(jpeg(9));
  await hamza.refresh();
  const now = hamza.members.get(id(umair)).photo;
  assert.notEqual(now.id, old.id);
  assert.equal(fileRows().length, 1);
  assert.ok(!existsSync(join(dir, 'files', old.id)));
  await umair.setProfilePhoto(null);
  await hamza.refresh();
  assert.equal(hamza.members.get(id(umair)).photo, null);
  assert.equal(fileRows().length, 0);
});

test('her tiles: the person’s own photo first, else the one an admin added', async () => {
  await umair.setTilePhoto(id(ammi), id(hamza), jpeg(3));
  await ammi.fetchRecords();
  assert.deepEqual(await ammi.photoBytes(ammi.tilePhoto(id(ammi), id(hamza))), jpeg(3));
  // Hamza adds his own: it comes first.
  await hamza.setProfilePhoto(jpeg(5));
  await ammi.refresh();
  assert.deepEqual(await ammi.photoBytes(ammi.tilePhoto(id(ammi), id(hamza))), jpeg(5));
  assert.equal(ammi.tilePhoto(id(ammi), id(umair)), null, 'no photo yet: her tile shows the name');
  // Not an admin: can't add one.
  await assert.rejects(hamza.setTilePhoto(id(ammi), id(umair), jpeg(1)), /Only circle admins/);
});

test('photos are refused when too big or when the circle turned them off', async () => {
  await assert.rejects(umair.api.uploadFile(new Uint8Array(2 * 1024 * 1024 + 10), { purpose: 'photo' }), (e) => e.status === 413);
  await umair.setFeatures({ photos: false });
  await assert.rejects(hamza.setProfilePhoto(jpeg(2)), (e) => e.code === 'feature_off');
  await umair.setFeatures({ photos: true });
  const info = await (await fetch(`${url}/api/v1/info`)).json();
  assert.equal(info.photos, true);
});

test('a member who leaves takes their photos; removing the helper doesn’t touch photos', async () => {
  const before = fileRows().filter((r) => r.uploader_id === id(hamza)).length;
  assert.ok(before >= 1);
  await umair.removeMember(id(hamza));
  assert.equal(fileRows().filter((r) => r.uploader_id === id(hamza)).length, 0);
  // Umair's tile photo for Hamza (uploaded by Umair) stays until replaced.
  assert.equal(fileRows().filter((r) => r.uploader_id === id(umair)).length, 1);
  // The agent-removal path deletes only agent files.
  app.store.insertFile({ id: 'agentfile0123456789ab', circleId: umair.circleId, uploaderId: id(umair), size: 1, now: Date.now(), expiresAt: Date.now() + 1000, purpose: 'agent' });
  const ids = app.store.agentFileIds(umair.circleId);
  assert.deepEqual(ids, ['agentfile0123456789ab']);
});
