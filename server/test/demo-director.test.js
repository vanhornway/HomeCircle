// The demo director, end to end: it builds a copy of the family, a visitor
// starts it, the day runs, and when the copy ends a fresh one replaces it.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import { createApp } from '../src/index.js';
import { CircleClient } from '../../packages/core/src/index.js';
import { Director } from '../demo/director.mjs';

const TOKEN = 'test-director-token-456';
let app;
let url;
let dir;
let director;

const memory = () => {
  const m = new Map();
  return { getItem: async (k) => m.get(k) ?? null, setItem: async (k, v) => void m.set(k, v), removeItem: async (k) => void m.delete(k) };
};
const waitFor = async (fn, ms = 20_000) => {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 50));
  }
};

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'homecircle-director-'));
  app = createApp({
    port: 0,
    host: '127.0.0.1',
    dataDir: dir,
    setupToken: 'test-setup-token-director',
    inviteMaxHours: 168,
    locationRequestCooldown: 60,
    push: 'none',
    webClient: false,
    agent: true,
    demoMode: true,
    demoToken: TOKEN,
    demoMinutes: 60,
    demoIdleMinutes: 10,
    demoUnusedMinutes: 5,
    demoMaxRunning: 3,
    demoStartsPerIp: 100,
    demoStartsPerDevice: 100,
    demoSweepMs: 3_600_000,
  });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  url = `http://127.0.0.1:${app.server.address().port}`;
  await app.agentHost.start(url);
  // A minute of the demo goes by in a second or so.
  director = new Director({ server: url, token: TOKEN, pool: 1, pace: 60 });
  await director.start();
});

after(async () => {
  await director.stop();
  await app.close();
  rmSync(dir, { recursive: true, force: true });
});

test('a visitor joins a full family, the day happens, and leaving makes room for the next', { timeout: 90_000 }, async () => {
  await waitFor(() => app.demo.counts().ready === 1, 60_000);

  const res = await fetch(`${url}/api/v1/demo/start`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ device: 'test' }) });
  const { link } = await res.json();
  const me = new CircleClient({ storage: memory(), WebSocketImpl: WebSocket, onError: () => {} });
  await me.joinWithInvite(link, { name: 'Sam' });

  // Twenty people and the helper, a home base with three trackers, and places.
  await me.fetchRecords();
  assert.equal(me.peopleList().length, 21);
  assert.deepEqual(me.deviceList().map((m) => m.name).sort(), ['Family car', 'Home base', 'Leo’s backpack', 'Nani’s tracker']);
  const car = me.memberList().find((m) => m.name === 'Family car');
  assert.equal(me.memberRecord(car.id)?.tracker?.mode, 'car');
  assert.ok(me.memberRecord(me.memberList().find((m) => m.name === 'Home base').id)?.homeBase?.trackers.length === 3, 'the home base reports its trackers');
  assert.ok(me.agent, 'the helper is there');
  await me.fetchPlaces();
  assert.equal(me.places.size, 15);
  await me.fetchLocations();
  assert.ok(me.locations.size >= 20, 'everyone is on the map');

  // Their history can be read, and everyone's real: signatures check out.
  await me.fetchMessages();
  const chat = me.conversation().filter((m) => m.kind === 'chat');
  assert.ok(chat.length >= 20, `chat history (${chat.length})`);
  assert.ok(!me.messages.some((m) => m.kind === 'unreadable'), 'nothing unreadable');
  const old = chat.find((m) => m.body?.text?.includes('Sunday dinner'));
  assert.ok(Date.now() - old.ts > 24 * 3_600_000, 'history is dated yesterday');
  assert.ok(chat.find((m) => m.body?.poll && me.pollState(m.id).closed), 'an old poll, finished');

  // Nani's on the elder profile.
  const nani = me.memberList().find((m) => m.name === 'Nani');
  await me.fetchRecords();
  assert.equal(me.memberRecord(nani.id)?.skin, 'elderly');

  // What the helper holds, as a plain member sees it.
  me.connect();
  await waitFor(() => me.status === 'online');
  const lists = await me.agentRpc('lists');
  assert.deepEqual(lists.map((l) => l.name).sort(), ['Costco', 'Fresh Valley Market', 'Spice Bazaar']);
  const costco = lists.find((l) => l.name === 'Costco');
  assert.equal(costco.currency, 'USD');
  assert.ok(costco.total.high > 0, 'the list has a price');
  assert.ok(costco.items.some((i) => i.name === 'Whole milk' && i.price?.est > 0));
  assert.ok(costco.usual.length >= 4, 'you usually get');
  assert.equal((await me.agentRpc('list', { type: 'recipe' })).length, 10);
  assert.ok((await me.agentRpc('list', { type: 'document' })).length >= 3);
  assert.ok((await me.agentRpc('reminders')).length >= 5);

  // The day: a welcome, messages and movement arrive.
  await waitFor(() => me.conversation(me.memberList().find((m) => m.name === 'Maya').id).some((m) => m.body?.text?.includes('Sam')));
  await waitFor(() => me.messages.some((m) => m.kind === 'event' && m.body?.type === 'place' && m.body.action === 'left'));
  // The car leaves Home with Omar: it's on the move, its way kept; the backpack says Leo's OK.
  await waitFor(() => me.journeys.has(car.id));
  const backpack = me.memberList().find((m) => m.name === 'Leo’s backpack');
  await waitFor(() => me.messages.some((m) => m.from === backpack.id && m.body?.text === '✅ I’m OK'));
  assert.ok((await me.journeyPath(me.journeys.get(car.id).id)).points.length >= 1, 'the car’s way, opened by the visitor');

  // Say something: someone answers.
  await me.sendChat('Hello everyone');
  const before = me.messages.length;
  await waitFor(() => me.messages.length > before);

  // A direct message gets an answer too.
  const zara = me.memberList().find((m) => m.name === 'Zara');
  await me.sendChat('Where are you?', { to: zara.id });
  await waitFor(() => me.conversation(zara.id).some((m) => m.from === zara.id && m.seq > 0 && /map|road|\w+!!|at /i.test(m.body?.text ?? '')));

  // Leave early: the copy goes, the director lets go of it and builds another.
  const circleId = me.circleId;
  await me.leave();
  assert.equal(app.store.circleExists(circleId), false);
  await waitFor(() => !director.copies.has(circleId));
  await waitFor(() => app.demo.counts().ready === 1, 60_000);
});
