// End-to-end check of the tracker's protocol code against a real server.
//
// Starts a local HomeCircle server, makes a circle with the app's own client
// (packages/core) as the admin, then drives the tracker code built for this
// computer (pio run -e native) to join, send locations and an SOS, read its
// settings, follow a key rotation, and notice being removed. Everything the
// tracker sends is opened and checked by the admin's client, so it proves
// the tracker speaks the same protocol as the app.
//
//   cd devices/tracker && pio run -e native && node test/e2e.mjs
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { CircleClient } from '../../../packages/core/src/index.js';
import { startMeshBridge, frame, pbBytes, pbVarint, pbFixed32, PRIVATE_APP } from '../../../server/src/meshtastic.js';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '../../..');
const binary = join(here, '../.pio/build/native/program');
if (!existsSync(binary)) throw new Error('Build the host program first: pio run -e native');

const port = 18000 + Math.floor(Math.random() * 1000);
const serverUrl = `http://127.0.0.1:${port}`;
const setupToken = 'tracker-e2e-setup-code';
const dir = mkdtempSync(join(tmpdir(), 'hc-tracker-'));
const trackerStore = join(dir, 'tracker.json');

const server = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', join(repo, 'server/src/index.js')], {
  env: { ...process.env, HOST: '127.0.0.1', PORT: String(port), DATA_DIR: join(dir, 'data'), SETUP_TOKEN: setupToken, PUSH_PROVIDER: 'none', LOAD_TEST: 'true', TRUST_PROXY: 'true' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let serverLog = '';
server.stdout.on('data', (d) => (serverLog += d));
server.stderr.on('data', (d) => (serverLog += d));

const memory = () => {
  const m = new Map();
  return { getItem: async (k) => m.get(k) ?? null, setItem: async (k, v) => void m.set(k, v), removeItem: async (k) => void m.delete(k) };
};
const client = () => new CircleClient({ storage: memory(), fetchImpl: fetch, onError: process.env.DEBUG_MESH ? (e) => console.error('client error:', e?.message) : () => {} });

/** Run the tracker program; returns { code, out, err }. */
function tracker(...args) {
  try {
    const out = execFileSync(binary, ['--store', trackerStore, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return { code: 0, out: out.trim(), err: '' };
  } catch (e) {
    return { code: e.status, out: String(e.stdout || '').trim(), err: String(e.stderr || '').trim() };
  }
}
function ok(...args) {
  const r = tracker(...args);
  assert.equal(r.code, 0, `tracker ${args.join(' ')} failed: ${r.err}`);
  return r.out;
}

let step = 0;
const pass = (what) => console.log(`ok ${++step} - ${what}`);

try {
  for (let i = 0; ; i++) {
    try {
      if ((await fetch(`${serverUrl}/api/v1/info`)).ok) break;
    } catch {}
    if (i > 100) throw new Error(`server didn't start:\n${serverLog}`);
    await new Promise((r) => setTimeout(r, 100));
  }

  const admin = client();
  await admin.createCircle({ serverUrl, setupToken, name: 'Maya', circleName: 'Test family' });
  // SOS is a circle feature an admin turns on; a family with a tracker would.
  await admin.setFeatures({ ...admin.features, sos: true, meshtastic: true });
  const { link } = await admin.createInvite({ hours: 1 });

  // Join.
  const joined = ok('join', link, 'Car tracker');
  assert.match(joined, /in circle "Test family"/);
  await admin.refresh();
  const car = admin.memberList().find((m) => m.name === 'Car tracker');
  assert.ok(car, 'the admin sees the tracker as a verified member');
  pass('joins with an ordinary invite; the admin verifies its sealed, self-signed profile');

  // Location.
  ok('location', '37.548271', '-121.988571', '80');
  await admin.fetchLocations();
  let loc = admin.locations.get(car.id);
  assert.ok(loc, 'the admin can open the location');
  assert.equal(loc.lat, 37.548271);
  assert.equal(loc.lng, -121.988571);
  assert.equal(loc.battery, 0.8);
  assert.equal(loc.app, 'tracker');
  assert.deepEqual(loc.cadence, { stop: 'custom', moving: 2, still: 60, charging: false, limited: false });
  pass('sends a location the admin opens and verifies (position, battery, cadence)');

  // SOS.
  ok('sos', 'start');
  await admin._fetchMessages();
  let sos = admin.activeSos();
  assert.equal(sos.length, 1);
  assert.equal(sos[0].memberId, car.id);
  assert.match(admin.messages.at(-1).body.text, /Car tracker sent an SOS/);
  pass('an SOS reaches the circle as an open SOS');

  // Settings from the admin.
  let s = JSON.parse(ok('settings'));
  assert.equal(s.fromAdmin, false);
  await admin.fetchRecords();
  await admin.setMemberRecord(car.id, { tracker: { mode: 'carried', moving: 3, still: 30, quiet: { from: '23:00', to: '06:00' }, sos: true } });
  s = JSON.parse(ok('settings'));
  assert.deepEqual(s, { fromAdmin: true, mode: 'carried', moving: 3, still: 30, quiet: { from: '23:00', to: '06:00' }, sos: true });
  pass('reads the admin’s signed settings for it');

  // Key rotation: someone else joins and is removed; the admin rotates the key.
  const leo = client();
  const inv2 = await admin.createInvite({ hours: 1 });
  await leo.joinWithInvite(inv2.link, { name: 'Leo' });
  await admin.refresh();
  const epochBefore = admin.account.epoch;
  await admin.removeMember(leo.account.memberId);
  await admin.refresh();
  assert.ok(admin.account.epoch > epochBefore, 'the admin rotated the key');
  ok('location', '37.551000', '-121.990000', '79');
  await admin.fetchLocations();
  loc = admin.locations.get(car.id);
  assert.equal(loc.lat, 37.551);
  const refreshed = ok('refresh');
  assert.match(refreshed, new RegExp(`epoch ${admin.account.epoch}`));
  pass('follows a key rotation: takes the new key from the admin and keeps sending');

  // Safe.
  ok('sos', 'safe');
  await admin._fetchMessages();
  sos = admin.activeSos();
  assert.equal(sos.length, 0);
  pass('“safe” closes the SOS');

  // --- The mesh: a fake Meshtastic node hands tracker packets to the home base bridge.
  const heard = [];
  const node = createServer((sock) => {
    sock.on('data', () => {}); // want_config, heartbeats
    const send = () => {
      while (heard.length) {
        const payload = Buffer.from(heard.shift(), 'base64url');
        const data = Buffer.concat([pbVarint(1, PRIVATE_APP), pbBytes(2, payload)]);
        const packet = Buffer.concat([pbFixed32(1, 0x1234abcd), pbFixed32(2, 0xffffffff), pbBytes(4, data), pbFixed32(6, (Math.random() * 1e9) >>> 0)]);
        // Some debug log text between frames, as a real node writes.
        sock.write(Buffer.from('INFO | heard a packet\n'));
        sock.write(frame(pbBytes(2, packet)));
      }
    };
    const t = setInterval(send, 50);
    sock.on('close', () => clearInterval(t));
  });
  await new Promise((r) => node.listen(0, '127.0.0.1', r));
  const bridge = startMeshBridge({ node: `tcp://127.0.0.1:${node.address().port}`, server: serverUrl, log: process.env.DEBUG_MESH ? console.log : () => {} });
  const until = async (fn, what) => {
    for (let i = 0; i < 100; i++) {
      if (await fn()) return;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error(`timed out: ${what}`);
  };
  try {
    // Mesh times are whole seconds: be a second past the last internet location.
    await new Promise((r) => setTimeout(r, 1100));
    const meshLoc = execFileSync(binary, ['--store', trackerStore, 'mesh-location', '37.560000', '-121.980000', '64'], { encoding: 'utf8' }).trim();
    const size = Buffer.from(meshLoc, 'base64url').length;
    assert.ok(size <= 233, `a mesh location fits one Meshtastic packet (${size} bytes)`);
    heard.push(meshLoc);
    await until(async () => (await admin.fetchLocations()).get(car.id)?.via === 'radio', 'mesh location');
    loc = admin.locations.get(car.id);
    assert.equal(loc.lat, 37.56);
    assert.equal(loc.battery, 0.64);
    pass(`a location over the mesh (${size} bytes) reaches the circle through the home base, sealed end to end`);

    const post = async (packets) => (await (await fetch(`${serverUrl}/api/v1/mesh/packets`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ packets }) })).json()).results;
    assert.deepEqual(await post([meshLoc]), ['replayed']);
    const forged = Buffer.from(meshLoc, 'base64url');
    forged[forged.length - 1] ^= 1;
    assert.deepEqual(await post([forged.toString('base64url')]), ['unknown']);
    const moved = Buffer.from(execFileSync(binary, ['--store', trackerStore, 'mesh-location', '1', '1'], { encoding: 'utf8' }).trim(), 'base64url');
    moved[30] ^= 1; // a byte inside the sealed part: the tag covers it too
    assert.deepEqual(await post([moved.toString('base64url')]), ['unknown']);
    pass('the server refuses replayed and forged mesh packets');

    // SOS over the mesh, then the same SOS over the internet: one SOS, not two.
    ok('sos-offline', 'start');
    heard.push(execFileSync(binary, ['--store', trackerStore, 'mesh-sos'], { encoding: 'utf8' }).trim());
    await until(async () => (await admin._fetchMessages(), admin.activeSos().length === 1), 'mesh SOS');
    const count = admin.messages.length;
    ok('sos', 'start'); // the internet copy: same id
    await admin._fetchMessages();
    assert.equal(admin.messages.length, count, 'the internet copy of the same SOS is not a second message');
    assert.equal(admin.messages.at(-1).body.via, 'radio');
    ok('sos-offline', 'safe');
    heard.push(execFileSync(binary, ['--store', trackerStore, 'mesh-sos'], { encoding: 'utf8' }).trim());
    await until(async () => (await admin._fetchMessages(), admin.activeSos().length === 0), 'mesh safe');
    pass('SOS and “safe” over the mesh; the same SOS over the internet too counts once');
  } finally {
    bridge.stop();
    node.close();
  }

  // Removed.
  await admin.removeMember(car.id);
  const gone = tracker('location', '37.5', '-121.9', '50');
  assert.equal(gone.code, 4, `expected "removed", got ${gone.code}: ${gone.err}`);
  pass('notices when it has been removed from the circle');

  console.log(`\nall ${step} passed`);
} catch (e) {
  console.error(e);
  console.error('\n--- server log ---\n' + serverLog.slice(-3000));
  process.exitCode = 1;
} finally {
  server.kill();
  rmSync(dir, { recursive: true, force: true });
}
