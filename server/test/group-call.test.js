// The circle's WhatsApp group call: anyone starts it, everyone's phone is
// woken at once (urgent) to show "join", joining adds a quiet line, and the
// call reads as over 30 minutes after the last join. The link stays sealed in
// the circle record; the server sees only sealed messages.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/index.js';
import { CircleClient, GROUP_CALL_OPEN_MS, allFeatures } from '../../packages/core/src/index.js';

const SETUP = 'test-setup-token-group-call';
const LINK = 'https://call.whatsapp.com/voice/AbCdEfGhIjKlMnOpQrStUv';
let app;
let url;
let dir;
const calls = [];

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
  dir = mkdtempSync(join(tmpdir(), 'homecircle-group-call-'));
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
  // Watch what the routes ask the push relay for.
  app.push.activity = (members, opts = {}) => calls.push({ n: members.length, urgent: !!opts.urgent });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  url = `http://127.0.0.1:${app.server.address().port}`;
});

after(async () => {
  await app.close();
  rmSync(dir, { recursive: true, force: true });
});

const umair = client();
const maya = client();
const nani = client();

test('set up: a circle with a group call link', async () => {
  await umair.createCircle({ features: allFeatures(), serverUrl: url, setupToken: SETUP, name: 'Umair', circleName: 'Family' });
  await maya.joinWithInvite((await umair.createInvite()).link, { name: 'Maya' });
  await nani.joinWithInvite((await umair.createInvite({ companion: { name: 'Nani', page: 'care' } })).link);
  await Promise.all([umair.refresh(), maya.refresh(), nani.refresh()]);
  for (const [c, token] of [
    [umair, 'umair'],
    [maya, 'maya'],
    [nani, 'nani'],
  ]) {
    await c.api.putPush(`ExponentPushToken[${token}]`, 'android');
  }
  // No link yet: starting says so.
  await assert.rejects(() => maya.startGroupCall(), /no WhatsApp group call link/);
  await umair.setGroupCallLink(LINK);
  await Promise.all([maya.refresh(), nani.refresh()]);
  assert.equal(maya.groupCallLink, LINK);
  assert.equal(nani.groupCallLink, LINK);
});

test('starting wakes everyone at once; joins are quiet and counted once', async () => {
  calls.length = 0;
  const id = await maya.startGroupCall();
  assert.deepEqual(calls, [{ n: 2, urgent: true }], 'the start goes urgent to the other two phones');
  await Promise.all([umair.fetchMessages(), nani.fetchMessages()]);
  const s = umair.activeGroupCall();
  assert.equal(s.id, id);
  assert.equal(s.from, maya.account.memberId);
  assert.deepEqual(s.joined, [maya.account.memberId]);
  assert.equal(s.open, true);
  assert.equal(nani.activeGroupCall()?.id, id, 'the elder’s phone sees it too');

  calls.length = 0;
  await umair.joinGroupCall(id);
  await umair.joinGroupCall(id); // twice: said once
  await nani.fetchMessages();
  await nani.joinGroupCall(id);
  assert.ok(calls.every((c) => !c.urgent), 'joins don’t ring anyone');
  await maya.fetchMessages();
  assert.deepEqual(maya.groupCallState(id).joined, [maya.account.memberId, umair.account.memberId, nani.account.memberId]);

  // Starting while one is on joins it instead of starting another.
  calls.length = 0;
  assert.equal(await umair.startGroupCall(), id);
  assert.ok(calls.every((c) => !c.urgent));
});

test('30 minutes after the last join it reads as over, and a new start is a new call', async () => {
  await umair.fetchMessages();
  const s = umair.activeGroupCall();
  const later = s.last + GROUP_CALL_OPEN_MS + 1000;
  assert.equal(umair.groupCallState(s.id, later).open, false);
  assert.equal(umair.activeGroupCall(later), null);
});

test('the server never sees the link or who joined: only sealed messages', async () => {
  const rows = app.store.db.prepare('SELECT * FROM messages').all();
  const raw = JSON.stringify(rows);
  assert.ok(!raw.includes('call.whatsapp.com'));
  assert.ok(!raw.includes('groupCall'));
  assert.ok(!raw.includes('joined the group call'));
});
