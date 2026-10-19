// The live connection must notice a silent (half-dead) socket and reconnect,
// and the client must fetch whatever it missed while disconnected.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Api, CircleClient } from '../../packages/core/src/index.js';
import { createApp } from '../src/index.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('watchdog replaces a socket that goes silent', async () => {
  const sockets = [];
  class SilentSocket {
    constructor(url) {
      this.url = url;
      sockets.push(this);
      setTimeout(() => {
        this.onopen?.();
        // Says "ready", then never sends anything again and never closes.
        this.onmessage?.({ data: JSON.stringify({ type: 'ready' }) });
      }, 5);
    }
    send() {}
    close() {
      this.closed = true;
    }
  }
  const statuses = [];
  const api = new Api('http://example.test', { token: 't', WebSocketImpl: SilentSocket });
  const conn = api.connect({ onEvent() {}, onStatus: (s) => statuses.push(s), staleMs: 80, checkMs: 20 });
  await sleep(1400);
  conn.close();
  assert.ok(sockets.length >= 2, `expected a reconnect, got ${sockets.length} socket(s)`);
  assert.equal(sockets[0].closed, true);
  assert.deepEqual(statuses.slice(0, 4), ['connecting', 'online', 'offline', 'connecting']);
});

test('client catches up on messages missed while disconnected', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'homecircle-conn-'));
  const app = createApp({
    version: 'test', dataDir: dir, setupToken: 'test-setup-token-123', trustProxy: false,
    messageRetentionDays: 90, locationRequestCooldown: 60, inviteMaxHours: 168, push: 'none',
    tileUrl: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png', tileAttribution: 'OSM', webClient: false,
  });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${app.server.address().port}`;
  const mem = () => {
    const m = new Map();
    return { getItem: async (k) => m.get(k) ?? null, setItem: async (k, v) => void m.set(k, v), removeItem: async (k) => void m.delete(k) };
  };
  const owner = new CircleClient({ storage: mem() });
  const bob = new CircleClient({ storage: mem() });
  try {
    await owner.createCircle({ serverUrl: url, setupToken: 'test-setup-token-123', name: 'Ann', circleName: 'C' });
    await bob.joinWithInvite((await owner.createInvite()).link, { name: 'Bob' });
    await owner.refresh();
    await bob.start();
    const online = () => new Promise((r) => { const off = bob.on('status', (s) => s === 'online' && (off(), r())); });
    if (bob.status !== 'online') await online();

    // Server drops Bob's socket (like a tunnel restart); Ann posts before he's back.
    const back = online();
    app.hub.disconnect(bob.account.memberId, 1012);
    await owner.sendChat('sent while you were away');
    await back;
    await sleep(300);
    assert.ok(bob.messages.some((m) => m.body?.text === 'sent while you were away'));
  } finally {
    owner.disconnect();
    bob.disconnect();
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
