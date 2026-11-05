// A normal server has no demo: no routes, nothing new in what it says.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createApp } from '../src/index.js';
import { CircleClient } from '../../packages/core/src/index.js';

let app;
let url;
let dir;

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'homecircle-nodemo-'));
  app = createApp({ port: 0, host: '127.0.0.1', dataDir: dir, setupToken: 'test-setup-token-nodemo', inviteMaxHours: 168, locationRequestCooldown: 60, push: 'none', webClient: false });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  url = `http://127.0.0.1:${app.server.address().port}`;
});

after(async () => {
  await app.close();
  rmSync(dir, { recursive: true, force: true });
});

test('no demo routes, no demo fields, no demo table', async () => {
  const start = await fetch(`${url}/api/v1/demo/start`, { method: 'POST', headers: { 'x-demo-token': 'anything' }, body: '{}' });
  assert.equal(start.status, 404);
  const info = await (await fetch(`${url}/api/v1/info`)).json();
  assert.equal('demo' in info, false);
  assert.equal(info.recovery, true);
  const m = new Map();
  const storage = { getItem: async (k) => m.get(k) ?? null, setItem: async (k, v) => void m.set(k, v), removeItem: async (k) => void m.delete(k) };
  const owner = new CircleClient({ storage, onError: () => {} });
  await owner.createCircle({ serverUrl: url, setupToken: 'test-setup-token-nodemo', name: 'Sam', circleName: 'Home' });
  assert.equal('demo' in (await owner.api.state()), false);
  assert.equal(owner.demo, null);
  const db = new DatabaseSync(join(dir, 'homecircle.db'));
  assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE name = 'demo_copies'").get(), undefined);
  db.close();
});
