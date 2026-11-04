// Demo mode: throwaway copies handed to visitors, on a server that takes no
// real circles. Off by default: a normal server has none of this.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import { createApp } from '../src/index.js';
import { CircleClient, allFeatures } from '../../packages/core/src/index.js';
import { PEOPLE, PLACES, TRIPS, routeKey } from '../demo/family.mjs';
import { readFileSync } from 'node:fs';

const TOKEN = 'test-director-token-789';
const memory = () => {
  const m = new Map();
  return { getItem: async (k) => m.get(k) ?? null, setItem: async (k, v) => void m.set(k, v), removeItem: async (k) => void m.delete(k) };
};
const fetchImpl = (url, init = {}) => fetch(url, { ...init, headers: { ...init.headers, 'x-demo-token': TOKEN } });
class DirectorSocket extends WebSocket {
  constructor(url) {
    super(url, { headers: { 'x-demo-token': TOKEN } });
  }
}
const director = () => new CircleClient({ storage: memory(), fetchImpl, WebSocketImpl: DirectorSocket, onError: () => {} });
const visitor = () => new CircleClient({ storage: memory(), WebSocketImpl: WebSocket, onError: () => {} });
const post = async (url, path, body = {}, headers = {}) => {
  const res = await fetch(`${url}/api/v1${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
  return { status: res.status, body: await res.json() };
};
const waitFor = async (fn, ms = 3000) => {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 20));
  }
};

let app;
let url;
let dir;

/** A ready copy: a small circle, registered, with a visitor's invite. */
async function readyCopy() {
  const owner = director();
  await owner.createCircle({ serverUrl: url, setupToken: 'unused', name: 'Maya', circleName: 'Demo family', features: allFeatures() });
  const { link } = await owner.createInvite({ hours: 48 });
  const res = await post(url, '/demo/copies', { circleId: owner.circleId, link }, { 'x-demo-token': TOKEN });
  assert.equal(res.status, 200);
  return owner;
}
const start = (device) => post(url, '/demo/start', { device: device ?? `d${Math.random()}` });

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'homecircle-demo-'));
  app = createApp({
    port: 0,
    host: '127.0.0.1',
    dataDir: dir,
    setupToken: 'test-setup-token-demo',
    maxRetentionDays: 365,
    locationRequestCooldown: 60,
    inviteMaxHours: 168,
    push: 'none',
    webClient: false,
    publicPerMinute: 1000,
    demoMode: true,
    demoToken: TOKEN,
    demoMinutes: 60,
    demoIdleMinutes: 10,
    demoUnusedMinutes: 5,
    demoMaxRunning: 2,
    demoStartsPerIp: 1000,
    demoStartsPerDevice: 2,
    demoSweepMs: 3_600_000,
  });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  url = `http://127.0.0.1:${app.server.address().port}`;
});

after(async () => {
  await app.close();
  rmSync(dir, { recursive: true, force: true });
});

const clear = () => {
  for (const c of app.demo.copies()) app.demo.end(c.circle_id, 'test');
};

test('a demo server says so, and takes no circles of its own', async () => {
  const info = await (await fetch(`${url}/api/v1/info`)).json();
  assert.deepEqual(info.demo, { minutes: 60 });
  for (const path of ['/setup', '/recover', '/recover/delete', '/recover/rejoin']) {
    const res = await post(url, path, { setupToken: 'test-setup-token-demo' });
    assert.equal(res.status, 403, path);
    assert.equal(res.body.error, 'demo_mode', path);
  }
});

test('the director’s routes need its token', async () => {
  assert.equal((await post(url, '/demo/copies', { circleId: 'x'.repeat(12), link: 'l' })).status, 403);
  assert.equal((await fetch(`${url}/api/v1/demo/copies`)).status, 403);
  assert.equal((await post(url, '/demo/copies', { circleId: 'x'.repeat(12), link: 'l' }, { 'x-demo-token': 'wrong' })).status, 403);
});

test('a visitor gets a copy of their own, once; no copy ready means busy', async () => {
  clear();
  assert.equal((await start()).body.error, 'demo_busy');
  const owner = await readyCopy();
  const res = await start();
  assert.equal(res.status, 200);
  assert.ok(res.body.link.startsWith(`${url}/join#`));
  assert.equal(res.body.minutes, 60);
  assert.ok(res.body.expiresAt > Date.now() + 59 * 60_000);
  // The link is forgotten once it's handed out.
  assert.equal(app.demo.copy(owner.circleId).link, null);
  assert.equal((await start()).body.error, 'demo_busy');
});

test('only so many copies run at once', async () => {
  clear();
  await readyCopy();
  await readyCopy();
  await readyCopy();
  assert.equal((await start()).status, 200);
  assert.equal((await start()).status, 200);
  const res = await start();
  assert.equal(res.status, 503);
  assert.equal(res.body.error, 'demo_busy');
});

test('a device only gets so many starts a day, and a refused start isn’t counted', async () => {
  clear();
  const device = 'phone-limit';
  assert.equal((await start(device)).body.error, 'demo_busy');
  await readyCopy();
  assert.equal((await start(device)).status, 200);
  clear();
  await readyCopy();
  assert.equal((await start(device)).status, 200);
  clear();
  await readyCopy();
  const res = await start(device);
  assert.equal(res.status, 429);
  assert.equal(res.body.error, 'demo_limit');
});

test('the visitor sees the time left, can’t invite anyone, and leaving ends the copy for everyone', async () => {
  clear();
  const owner = await readyCopy();
  owner.connect();
  await waitFor(() => owner.status === 'online');
  const { link } = (await start()).body;
  const me = visitor();
  await me.joinWithInvite(link, { name: 'Sam' });
  assert.ok(me.demo.endsAt > Date.now() + 59 * 60_000);
  assert.equal(app.demo.visitorOf(owner.circleId), me.account.memberId);
  await assert.rejects(me.createInvite(), (e) => e.status === 403);
  const removed = new Promise((r) => owner.on('removed', r));
  await me.leave();
  assert.equal((await removed).reason, 'circle_deleted');
  assert.equal(app.store.circleExists(owner.circleId), false);
  assert.equal(app.demo.copy(owner.circleId), null);
});

test('a member of the family leaving doesn’t end the copy', async () => {
  clear();
  const owner = await readyCopy();
  const { link } = (await start()).body;
  const me = visitor();
  await me.joinWithInvite(link, { name: 'Sam' });
  const cousin = director();
  const invite = await owner.createInvite();
  await cousin.joinWithInvite(invite.link, { name: 'Cousin' });
  assert.equal(app.demo.visitorOf(owner.circleId), me.account.memberId);
  await cousin.leave();
  assert.equal(app.store.circleExists(owner.circleId), true);
});

test('a copy ends when its hour is up, and the visitor’s app is told', async () => {
  clear();
  const owner = await readyCopy();
  const { link } = (await start()).body;
  const me = visitor();
  await me.joinWithInvite(link, { name: 'Sam' });
  me.connect();
  await waitFor(() => me.status === 'online');
  const removed = new Promise((r) => me.on('removed', r));
  app.demo.sweep(Date.now() + 59 * 60_000);
  assert.equal(app.store.circleExists(owner.circleId), true);
  app.demo.sweep(Date.now() + 61 * 60_000);
  assert.equal((await removed).reason, 'circle_deleted');
  assert.equal(app.store.circleExists(owner.circleId), false);
});

test('a visitor who goes quiet loses the copy; one who stays connected keeps it', async () => {
  clear();
  const owner = await readyCopy();
  const { link } = (await start()).body;
  const me = visitor();
  await me.joinWithInvite(link, { name: 'Sam' });
  me.connect();
  await waitFor(() => me.status === 'online');
  app.demo.sweep(Date.now() + 20 * 60_000);
  assert.equal(app.store.circleExists(owner.circleId), true, 'connected: still theirs');
  me.disconnect();
  await waitFor(() => !app.hub.isOnline(me.account.memberId));
  app.demo.sweep(Date.now() + 25 * 60_000);
  assert.equal(app.store.circleExists(owner.circleId), true, 'five minutes quiet: still theirs');
  app.demo.sweep(Date.now() + 31 * 60_000);
  assert.equal(app.store.circleExists(owner.circleId), false, 'ten minutes quiet: gone');
});

test('a link handed out and never used frees its copy', async () => {
  clear();
  const owner = await readyCopy();
  await start();
  app.demo.sweep(Date.now() + 4 * 60_000);
  assert.equal(app.store.circleExists(owner.circleId), true);
  app.demo.sweep(Date.now() + 6 * 60_000);
  assert.equal(app.store.circleExists(owner.circleId), false);
});

test('ready copies wait: the sweep leaves them alone', async () => {
  clear();
  const owner = await readyCopy();
  app.demo.sweep(Date.now() + 30 * 86_400_000);
  assert.equal(app.store.circleExists(owner.circleId), true);
});

test('the demo family’s day holds together', () => {
  const routes = JSON.parse(readFileSync(new URL('../demo/routes.json', import.meta.url), 'utf8'));
  assert.equal(Object.keys(PEOPLE).length, 20);
  const at = Object.fromEntries(Object.entries(PEOPLE).map(([k, p]) => [k, p.at]));
  const busyUntil = {};
  for (const t of [...TRIPS].sort((a, b) => a.at - b.at)) {
    assert.ok(t.at + t.mins <= 59, `${t.from}>${t.to} is over before the hour`);
    assert.ok(PLACES[t.from] && PLACES[t.to]);
    assert.ok(routes[routeKey(t.from, t.to)]?.length > 1, `route ${t.from}>${t.to}`);
    for (const who of t.who) {
      assert.equal(at[who], t.from, `${who} leaves from where they are (minute ${t.at})`);
      assert.ok(t.at >= (busyUntil[who] ?? 0), `${who} has arrived before leaving again (minute ${t.at})`);
      at[who] = t.to;
      busyUntil[who] = t.at + t.mins;
    }
  }
  assert.ok(Object.values(at).every((p) => p === 'nani'), 'everyone ends at Nani’s');
});
