// The HomeCircle Bridge: Home Assistant joins the circle as a device with its
// own keys; trackers become Mobile App devices in Home Assistant, the event
// homecircle_send posts to the chat, and new messages fire homecircle_message.
// Home Assistant here is a fake: its REST and WebSocket APIs, enough of them.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocketServer } from 'ws';
import { createApp } from '../src/index.js';
import { Bridge, FileStorage, HomeAssistant } from '../src/ha-bridge.js';
import { CircleClient, allFeatures } from '../../packages/core/src/index.js';

const SETUP = 'test-setup-ha-bridge';
const TOKEN = 'supervisor-token';
let app;
let url;
let dir;
let fakeHa;
let haUrl;
const calls = []; // [path, body, auth]
const sockets = new Set();

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
const until = async (fn, what) => {
  for (let i = 0; i < 100; i++) {
    const v = await fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 30));
  }
  throw new Error(`timed out: ${what}`);
};
/** Home Assistant fires an event: to every subscribed WebSocket. */
const fire = (type, data) => {
  for (const ws of sockets) if (ws.subscribed === type) ws.send(JSON.stringify({ id: 1, type: 'event', event: { event_type: type, data } }));
};

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'homecircle-ha-bridge-'));
  app = createApp({ version: 'test', dataDir: dir, setupToken: SETUP, trustProxy: false, messageRetentionDays: 90, locationRequestCooldown: 60, inviteMaxHours: 168, push: 'none', tileUrl: 'x', tileAttribution: 'x', webClient: false, meshPublicMqtt: 'off' });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  url = `http://127.0.0.1:${app.server.address().port}`;

  let n = 0;
  fakeHa = createServer((req, res) => {
    let raw = '';
    req.on('data', (d) => (raw += d));
    req.on('end', () => {
      const body = raw ? JSON.parse(raw) : null;
      const auth = req.headers.authorization === `Bearer ${TOKEN}`;
      calls.push([req.url, body, auth]);
      res.setHeader('Content-Type', 'application/json');
      if (req.url === '/api/mobile_app/registrations') {
        if (!auth) return res.writeHead(401).end('{}');
        return res.writeHead(201).end(JSON.stringify({ webhook_id: `hook${++n}` }));
      }
      if (req.url.startsWith('/api/webhook/') || req.url.startsWith('/api/events/')) return res.writeHead(200).end('{}');
      res.writeHead(404).end('{}');
    });
  });
  const wss = new WebSocketServer({ server: fakeHa, path: '/api/websocket' });
  wss.on('connection', (ws) => {
    sockets.add(ws);
    ws.on('close', () => sockets.delete(ws));
    ws.send(JSON.stringify({ type: 'auth_required' }));
    ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.type === 'auth') ws.send(JSON.stringify({ type: msg.access_token === TOKEN ? 'auth_ok' : 'auth_invalid' }));
      if (msg.type === 'subscribe_events') {
        ws.subscribed = msg.event_type;
        ws.send(JSON.stringify({ id: msg.id, type: 'result', success: true }));
      }
    });
  });
  await new Promise((r) => fakeHa.listen(0, '127.0.0.1', r));
  haUrl = `http://127.0.0.1:${fakeHa.address().port}`;
});
after(async () => {
  for (const ws of sockets) ws.terminate();
  fakeHa.closeAllConnections();
  await new Promise((r) => fakeHa.close(r));
  await app.close();
  rmSync(dir, { recursive: true, force: true });
});

test('Home Assistant joins as a device: trackers go to it, it posts to the chat, the chat comes to it', async () => {
  const mom = client();
  const ut = client();
  await mom.createCircle({ features: { ...allFeatures(), meshtastic: true }, serverUrl: url, setupToken: SETUP, name: 'Mom', circleName: 'Family' });
  await ut.joinWithInvite((await mom.createInvite()).link, { name: 'UT1' });
  await mom.refresh();
  await mom.setMemberRecord(ut.account.memberId, { tracker: { node: '!28d59f33', mode: 'carried' } });

  const logs = [];
  const storage = new FileStorage(join(dir, 'bridge', 'account.json'));
  const bridgeClient = new CircleClient({ storage, onError: () => {} });
  const ha = new HomeAssistant({ base: haUrl, token: TOKEN });
  const bridge = new Bridge({ client: bridgeClient, ha, storage, log: (s) => logs.push(s), version: '0.30.0' });
  await bridge.start({ invite: (await mom.createInvite()).link, name: 'Home Assistant' });
  const bridgeId = bridgeClient.account.memberId;

  // In the app: a device, not a person.
  await mom.refresh();
  assert.equal(mom.members.get(bridgeId)?.name, 'Home Assistant');
  assert.equal(mom.isDevice(bridgeId), true);
  assert.ok(!mom.peopleList().some((m) => m.id === bridgeId), 'not counted as a person');

  // A tracker's position: a Mobile App device in Home Assistant, then its location.
  await ut.shareLocation({ lat: 37.55, lng: -121.98, accuracy: 12, battery: 0.71 });
  const update = await until(() => calls.find(([p, b]) => p.startsWith('/api/webhook/') && b?.type === 'update_location'), 'a location in Home Assistant');
  const reg = calls.find(([p]) => p === '/api/mobile_app/registrations');
  assert.equal(reg[2], true, 'registered with the token');
  assert.equal(reg[1].device_name, 'HomeCircle UT1');
  assert.equal(reg[1].device_id, `homecircle-${ut.account.memberId}`);
  assert.deepEqual(update[1].data.gps, [37.55, -121.98]);
  assert.equal(update[1].data.battery, 71);
  assert.equal(update[2], false, 'webhooks need no token');
  // Mom isn't a tracker: she comes through the plugin, from her own phone.
  await mom.shareLocation({ lat: 37.4, lng: -121.9, accuracy: 5 });
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(calls.filter(([p]) => p === '/api/mobile_app/registrations').length, 1, 'people aren’t sent');

  // The same position isn't sent twice; a new one is, to the same device.
  const before = calls.length;
  await bridge.syncTrackers();
  assert.equal(calls.length, before);
  await ut.shareLocation({ lat: 37.56, lng: -121.97, accuracy: 12 });
  await until(() => calls.slice(before).find(([p, b]) => b?.type === 'update_location' && b.data.gps[0] === 37.56), 'the next position');
  assert.equal(calls.filter(([p]) => p === '/api/mobile_app/registrations').length, 1);

  // Home Assistant posts to the group chat, and to someone directly.
  await until(() => [...sockets].some((ws) => ws.subscribed === 'homecircle_send'), 'the bridge listening');
  fire('homecircle_send', { message: 'The garage door is still open' });
  await until(async () => {
    await mom._fetchMessages();
    return mom.messages.find((m) => m.from === bridgeId && m.body?.text === 'The garage door is still open' && !m.to);
  }, 'the message in the chat');
  fire('homecircle_send', { message: 'Your package arrived', to: 'mom' });
  await until(async () => {
    await mom._fetchMessages();
    return mom.messages.find((m) => m.from === bridgeId && m.body?.text === 'Your package arrived' && m.to === mom.account.memberId);
  }, 'the direct message');
  fire('homecircle_send', { message: 'Hi', to: 'Nobody' });
  await until(() => logs.some((l) => /no one called “Nobody”/.test(l)), 'an unknown name is logged');

  // The chat in Home Assistant: a new message fires homecircle_message.
  await mom.sendChat('Leaving work now');
  const ev = await until(() => calls.find(([p, b]) => p === '/api/events/homecircle_message' && b?.text === 'Leaving work now'), 'the event');
  assert.equal(ev[1].from, 'Mom');
  assert.equal(ev[1].direct, false);
  assert.equal(ev[2], true);

  // It keeps its keys: started again, it's the same member.
  bridge.stop();
  const again = new Bridge({ client: new CircleClient({ storage: new FileStorage(join(dir, 'bridge', 'account.json')), onError: () => {} }), ha, storage: new FileStorage(join(dir, 'bridge', 'account.json')), log: () => {} });
  await again.start({});
  assert.equal(again.client.account.memberId, bridgeId);
  again.stop();
});
