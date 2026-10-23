// Guardrails for load tests: the swarm only ever runs on a server that says
// it's for load tests, so it can't fill a family's server with simulated people.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/index.js';

const servers = [];
let dir;

const start = async (loadTest) => {
  const app = createApp({
    version: 'test',
    dataDir: mkdtempSync(join(dir, 'data-')),
    setupToken: 'loadtest-guard-code',
    trustProxy: false,
    locationRequestCooldown: 60,
    inviteMaxHours: 168,
    push: 'none',
    tileUrl: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
    tileAttribution: 'OSM',
    webClient: false,
    loadTest,
  });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  servers.push(app);
  return `http://127.0.0.1:${app.server.address().port}`;
};

/** Run the swarm briefly; resolves with its exit code and output. */
const swarm = (args) =>
  new Promise((resolve) => {
    const child = spawn(process.execPath, ['scripts/swarm.mjs', ...args], {
      cwd: new URL('..', import.meta.url).pathname,
      env: { PATH: process.env.PATH },
    });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    const timer = setTimeout(() => child.kill(), 20000);
    child.on('exit', (code) => {
      clearTimeout(timer);
      resolve({ code, out });
    });
  });

before(() => {
  dir = mkdtempSync(join(tmpdir(), 'homecircle-loadtest-'));
});

after(async () => {
  for (const app of servers) await app.close();
  rmSync(dir, { recursive: true, force: true });
});

test('/info says whether a server is for load tests', async () => {
  const real = await start(false);
  const lt = await start(true);
  assert.equal((await (await fetch(`${real}/api/v1/info`)).json()).loadTest, false);
  assert.equal((await (await fetch(`${lt}/api/v1/info`)).json()).loadTest, true);
});

test('the swarm refuses a server that is not a load-test server', async () => {
  const real = await start(false);
  const { code, out } = await swarm(['--server', real, '--setup-code', 'loadtest-guard-code', '--data', join(dir, 'swarm-real'), '--duration', '0.05']);
  assert.equal(code, 1);
  assert.match(out, /isn't a load-test server/);
  // Nothing was created on it.
  assert.equal((await (await fetch(`${real}/api/v1/info`)).json()).setup, false);
});

test('the swarm rejects an unknown --invite-my-phone value', async () => {
  const { code, out } = await swarm(['--server', 'http://127.0.0.1:9', '--invite-my-phone', 'everyone']);
  assert.equal(code, 1);
  assert.match(out, /--invite-my-phone must be none, hq or all/);
});
