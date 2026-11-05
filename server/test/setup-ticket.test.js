// Setting up from the phone: a one-time ticket stands in for the setup code.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/index.js';
import { CircleClient } from '../../packages/core/src/index.js';

const memoryStorage = () => {
  const m = new Map();
  return { getItem: async (k) => m.get(k) ?? null, setItem: async (k, v) => void m.set(k, v), removeItem: async (k) => void m.delete(k) };
};

let app, url, dir;
const SETUP = 'ticket-test-setup-code';

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'hc-ticket-'));
  app = createApp({
    version: 'test',
    dataDir: dir,
    setupToken: SETUP,
    trustProxy: false,
    messageRetentionDays: 90,
    locationRequestCooldown: 60,
    inviteMaxHours: 168,
    push: 'none',
    tileUrl: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
    tileAttribution: 'OSM',
    webClient: true,
  });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  url = `http://127.0.0.1:${app.server.address().port}`;
});

after(async () => {
  await app.close();
  rmSync(dir, { recursive: true, force: true });
});

const post = (path, body) => fetch(`${url}/api/v1${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

test('a wrong setup code gets no ticket', async () => {
  await assert.rejects(CircleClient.setupTicket(url, 'not-the-code'));
});

test('the first page and the phone page are served', async () => {
  const res = await fetch(`${url}/start`);
  assert.equal(res.status, 200);
  assert.match(await res.text(), /id="root"/);
});

test('a ticket can be checked, typed with a dash, and does not work on recovery', async () => {
  const t = await CircleClient.setupTicket(url, SETUP);
  assert.equal(t.code.length, 8);
  assert.ok(t.expiresAt > Date.now());
  const typed = `${t.code.slice(0, 4)}-${t.code.slice(4).toLowerCase()}`;
  assert.equal((await CircleClient.setupTicket(url, typed)).code, t.code);
  assert.equal((await post('/recover', { setupToken: t.code })).status, 403);
});

test('a new ticket replaces the old one', async () => {
  const a = await CircleClient.setupTicket(url, SETUP);
  const b = await CircleClient.setupTicket(url, SETUP);
  assert.notEqual(a.code, b.code);
  await assert.rejects(CircleClient.setupTicket(url, a.code));
});

test('a ticket creates the first circle, once', async () => {
  const t = await CircleClient.setupTicket(url, SETUP);
  const c = new CircleClient({ storage: memoryStorage() });
  await c.createCircle({ serverUrl: url, setupToken: t.code, name: 'Sam', circleName: 'The Parkers' });
  assert.ok(c.circleId);
  const again = new CircleClient({ storage: memoryStorage() });
  await assert.rejects(again.createCircle({ serverUrl: url, setupToken: t.code, name: 'Other', circleName: 'Second' }));
  await assert.rejects(CircleClient.setupTicket(url, SETUP), /already set up/);
});
