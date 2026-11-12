// Messages over the mesh: with no internet, a phone seals a short message and
// sends it through its Meshtastic tracker; the home base hands the packet to
// the server (POST /mesh/packets), which can't read it. Group messages reach
// everyone; a direct one only its recipient, and the rest of the circle can't
// open it even though it's sealed with the circle key outside.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/index.js';
import { CircleClient, allFeatures } from '../../packages/core/src/index.js';

const SETUP = 'test-setup-token-mesh-chat';
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

const client = () => new CircleClient({ storage: new MemoryStorage(), onError: () => {} });

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'homecircle-mesh-chat-'));
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

const mom = client();
const dad = client();
const kid = client();
const sync = () => Promise.all([mom, dad, kid].map((c) => c.fetchMessages()));
// What a home base does with a packet it heard.
const handIn = async (packet) => {
  const r = await fetch(`${url}/api/v1/mesh/packets`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ packets: [Buffer.from(packet).toString('base64')] }),
  });
  return (await r.json()).results[0];
};

test('a phone’s group message over the mesh reaches everyone, marked as sent over radio', async () => {
  await mom.createCircle({ features: { ...allFeatures(), meshtastic: true }, serverUrl: url, setupToken: SETUP, name: 'Mom', circleName: 'Family' });
  await dad.joinWithInvite((await mom.createInvite()).link, { name: 'Dad' });
  await kid.joinWithInvite((await mom.createInvite()).link, { name: 'Kid' });
  await Promise.all([mom, dad, kid].map((c) => c.refresh()));

  assert.equal(kid.meshReady, false);
  await kid.prepareMesh(); // online, once
  assert.equal(kid.meshReady, true);
  const { id, packet } = await kid.meshMessage('Battery died, at the library 📚');
  assert.ok(packet.length <= 221, `one LoRa packet, addressed to the home base: ${packet.length} bytes`);
  assert.equal(await handIn(packet), 'ok');
  assert.equal(await handIn(packet), 'duplicate', 'heard by two home bases: stored once');
  await sync();
  const m = dad.messages.find((x) => x.id === id);
  assert.equal(m.from, kid.account.memberId);
  assert.deepEqual(m.body, { text: 'Battery died, at the library 📚', via: 'radio' });
  assert.ok(kid.messages.some((x) => x.id === id), 'and the sender has it too, once back online');
  assert.ok(!JSON.stringify(app.store.db.prepare('SELECT env FROM messages').all()).includes('library'), 'the server can’t read it');
});

test('a direct message over the mesh reaches only its recipient, and only they can read it', async () => {
  const { id, packet } = await kid.meshMessage('Please pick me up at 5', { to: mom.account.memberId });
  assert.equal(await handIn(packet), 'ok');
  await sync();
  const m = mom.messages.find((x) => x.id === id);
  assert.equal(m?.body.text, 'Please pick me up at 5');
  assert.equal(m.to, mom.account.memberId);
  assert.ok(!dad.messages.some((x) => x.id === id), 'Dad doesn’t get it');
  // Even with the packet in hand, the circle key alone doesn’t open the text.
  const row = app.store.db.prepare('SELECT env FROM messages WHERE id = ?').get(id);
  const stolen = dad._open(JSON.parse(row.env), kid.account.memberId, ['chat'], dad.account.memberId, id);
  assert.equal(stolen, null);
});

test('too long, replayed, or forged packets are refused', async () => {
  assert.equal(kid.meshFits('x'.repeat(kid.meshTextMax.chat)), true);
  assert.equal(kid.meshFits('x'.repeat(kid.meshTextMax.chat + 1)), false);
  assert.equal(kid.meshFits('x'.repeat(kid.meshTextMax.direct + 1), mom.account.memberId), false);
  await assert.rejects(() => kid.meshMessage('x'.repeat(200)), /Too long for the mesh/);
  const { packet } = await kid.meshMessage('once');
  const forged = Uint8Array.from(packet);
  forged[forged.length - 1] ^= 1;
  assert.equal(await handIn(forged), 'unknown', 'a wrong tag: not from Kid');
  assert.equal(await handIn(packet), 'ok');
  // The same counter again (a copy with a new id would need Kid's keys): refused.
  const again = await kid.meshMessage('twice');
  const replay = Uint8Array.from(again.packet);
  replay.set(packet.subarray(12, 16), 12); // the old counter
  assert.notEqual(await handIn(replay), 'ok');
  // Mom can't send one with no mesh key registered.
  await assert.rejects(() => mom.meshMessage('hi'), /online once first/);
});
