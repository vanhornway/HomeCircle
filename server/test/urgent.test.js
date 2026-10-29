// Urgent messages (call-back requests and replies, SOS) skip push
// coalescing. The flag is outer routing metadata: the server learns only
// that it was set, and past 10 a minute from one sender it falls back to
// normal delivery instead of refusing the message.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/index.js';
import { CircleClient, allFeatures } from '../../packages/core/src/index.js';

const SETUP = 'test-setup-token-urgent';
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
  dir = mkdtempSync(join(tmpdir(), 'homecircle-urgent-'));
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
const ammi = client();

test('call-back requests, replies and SOS are sent urgent; chat is not', async () => {
  await umair.createCircle({ features: allFeatures(), serverUrl: url, setupToken: SETUP, name: 'Umair', circleName: 'Care' });
  await ammi.joinWithInvite((await umair.createInvite({ companion: { name: 'Ammi', page: 'care' } })).link);
  await Promise.all([umair.refresh(), ammi.refresh()]);
  // A push token for each, so the routes ask for pushes (nobody is connected).
  await umair.api.putPush('ExponentPushToken[umair]', 'android');
  await ammi.api.putPush('ExponentPushToken[ammi]', 'android');
  calls.length = 0;
  await umair.sendChat('Hi Ammi');
  const req = await ammi.askCallback({ tz: 'Asia/Karachi', remind: 10 });
  await umair.fetchMessages();
  await umair.replyCallback(req, 'now');
  const sos = await ammi.startSos();
  await ammi.endSos(sos);
  assert.deepEqual(calls.map((c) => c.urgent), [false, true, true, true, true]);
  const info = await (await fetch(`${url}/api/v1/info`)).json();
  assert.equal(info.urgent, true);
});

test('past 10 urgent messages a minute from one sender, the rest go as normal messages', async () => {
  calls.length = 0;
  for (let i = 0; i < 12; i++) await ammi.askCallback({ remind: 0 });
  // Ammi sent 3 urgent messages in the first test, so 7 more fit in this minute.
  assert.deepEqual(calls.map((c) => c.urgent), [...Array(7).fill(true), ...Array(5).fill(false)]);
  assert.equal(calls.length, 12, 'none refused');
  // Another sender has their own allowance.
  calls.length = 0;
  await umair.fetchMessages();
  await umair.replyCallback(umair.openCallbacks()[0].id, '5min');
  assert.deepEqual(calls.map((c) => c.urgent), [true]);
});
