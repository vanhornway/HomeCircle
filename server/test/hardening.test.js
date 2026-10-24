// Hardening: the client address behind proxies, request timeouts, write and
// storage limits, and connection caps.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket } from 'ws';
import { clientIp } from '../src/http.js';
import { createApp } from '../src/index.js';
import { CircleClient } from '../../packages/core/src/index.js';

const req = (xff, remote = '10.0.0.9') => ({ headers: xff == null ? {} : { 'x-forwarded-for': xff }, socket: { remoteAddress: remote } });

test('behind one proxy, the client is the address the proxy appended', () => {
  // A client can put anything at the front; only the last entry is the proxy's.
  assert.equal(clientIp(req('6.6.6.6, 203.0.113.7'), 1), '203.0.113.7');
  assert.equal(clientIp(req('203.0.113.7'), 1), '203.0.113.7');
  assert.equal(clientIp(req('1.1.1.1, 2.2.2.2, 203.0.113.7, 10.1.1.1'), 2), '203.0.113.7');
  // Fewer entries than proxies: the first one.
  assert.equal(clientIp(req('203.0.113.7'), 3), '203.0.113.7');
});

test('without a trusted proxy, forwarded headers are ignored', () => {
  assert.equal(clientIp(req('6.6.6.6'), 0), '10.0.0.9');
  assert.equal(clientIp(req(null), 1), '10.0.0.9');
});

// --- limits against a real server ------------------------------------------

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

const SETUP = 'test-setup-token-hardening';
const start = async (limits) => {
  const dir = mkdtempSync(join(tmpdir(), 'homecircle-hard-'));
  const app = createApp({
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
    ...limits,
  });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${app.server.address().port}`;
  const stop = async () => {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  };
  return { app, url, stop };
};
const newCircle = async (url) => {
  const c = new CircleClient({ storage: new MemoryStorage() });
  await c.createCircle({ serverUrl: url, setupToken: SETUP, name: 'Mom', circleName: 'Family' });
  return c;
};

test('a device that writes too fast is slowed down', async () => {
  const { url, stop } = await start({ writesPerMinute: 5 });
  try {
    const mom = await newCircle(url);
    for (let i = 0; i < 5; i++) await mom.sendChat(`hi ${i}`);
    await assert.rejects(() => mom.sendChat('one too many'), (e) => e.status === 429 && e.code === 'rate_limited');
    // Reads still work.
    await mom.fetchMessages();
  } finally {
    await stop();
  }
});

test('a device can only post so many messages a day', async () => {
  const { url, stop } = await start({ maxMessagesPerDay: 3 });
  try {
    const mom = await newCircle(url);
    for (let i = 0; i < 3; i++) await mom.sendChat(`hi ${i}`);
    await assert.rejects(() => mom.sendChat('too many'), (e) => e.status === 429);
  } finally {
    await stop();
  }
});

test('a circle whose message storage is full refuses new messages', async () => {
  const { url, stop } = await start({ maxCircleBytes: 1000 });
  try {
    const mom = await newCircle(url);
    // Under the line when sent, so it's stored; after it the circle is over.
    await mom.sendChat('x'.repeat(1500));
    await assert.rejects(() => mom.sendChat('full now'), (e) => e.status === 507 && e.code === 'circle_full');
  } finally {
    await stop();
  }
});

test('one address can only hold so many live connections', async () => {
  const { url, stop } = await start({ maxSocketsPerIp: 2 });
  try {
    const wsUrl = `${url.replace('http', 'ws')}/api/v1/ws`;
    const open = () =>
      new Promise((resolve) => {
        const ws = new WebSocket(wsUrl);
        ws.on('open', () => resolve({ ok: true, ws }));
        ws.on('unexpected-response', (_req, res) => resolve({ ok: false, status: res.statusCode }));
        ws.on('error', () => {});
      });
    const a = await open();
    const b = await open();
    const c = await open();
    assert.equal(a.ok && b.ok, true);
    assert.deepEqual([c.ok, c.status], [false, 429]);
    // Closing one frees a slot.
    a.ws.close();
    await new Promise((r) => setTimeout(r, 100));
    const d = await open();
    assert.equal(d.ok, true);
    b.ws.close();
    d.ws.close();
  } finally {
    await stop();
  }
});
