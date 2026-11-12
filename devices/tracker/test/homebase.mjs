// End-to-end check of the home base against a real server.
//
// Starts a local HomeCircle server and a family with the app's own client,
// then drives the home base's code built for this computer
// (pio run -e native-homebase), standing in for its Meshtastic radio. An
// admin manages a stock Meshtastic tracker entirely by chatting with the home
// base, and everything the home base sends for it is opened and checked by
// the admin's client.
//
//   cd devices/tracker && pio run -e native-homebase && node test/homebase.mjs
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import assert from 'node:assert/strict';
import { CircleClient } from '../../../packages/core/src/index.js';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '../../..');
const binary = join(here, '../.pio/build/native-homebase/program');
if (!existsSync(binary)) throw new Error('Build the home base program first: pio run -e native-homebase');

const port = 19000 + Math.floor(Math.random() * 1000);
const serverUrl = `http://127.0.0.1:${port}`;
const setupToken = 'homebase-e2e-setup-code';
const dir = mkdtempSync(join(tmpdir(), 'hc-homebase-'));

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
const client = () => new CircleClient({ storage: memory(), fetchImpl: fetch, onError: () => {} });

// The home base program: one command per line, output up to a "." line.
const hb = spawn(binary, ['--store', join(dir, 'homebase.json')], { stdio: ['pipe', 'pipe', 'inherit'] });
const lines = createInterface({ input: hb.stdout });
const waiting = [];
let buffer = [];
lines.on('line', (l) => {
  if (l === '.') {
    waiting.shift()?.(buffer);
    buffer = [];
  } else buffer.push(l);
});
// The home base's clock runs ahead when the test makes time pass ("advance");
// phones in the test follow the same clock.
let ahead = 0;
const radio = (cmd) =>
  new Promise((resolve) => {
    if (cmd.startsWith('advance ')) ahead += Number(cmd.slice(8)) * 1000;
    waiting.push(resolve);
    hb.stdin.write(`${cmd}\n`);
  });
async function atTestTime(fn) {
  const real = Date.now;
  Date.now = () => real() + ahead;
  try {
    return await fn();
  } finally {
    Date.now = real;
  }
}

let step = 0;
const pass = (what) => console.log(`ok ${++step} - ${what}`);
const TRACKER = '!a1b2c3d4';

try {
  for (let i = 0; ; i++) {
    try {
      if ((await fetch(`${serverUrl}/api/v1/info`)).ok) break;
    } catch {}
    if (i > 100) throw new Error(`server didn't start:\n${serverLog}`);
    await new Promise((r) => setTimeout(r, 100));
  }

  // A family: Maya (owner) and Leo, whose phone shares its location.
  const maya = client();
  await maya.createCircle({ serverUrl, setupToken, name: 'Maya', circleName: 'Family' });
  await maya.setFeatures({ ...maya.features, sos: true, placeAlerts: true, chirps: true, locate: true, meshtastic: true });
  const leo = client();
  await leo.joinWithInvite((await maya.createInvite({ hours: 1 })).link, { name: 'Leo' });
  await leo.refresh();
  await leo.shareLocation({ lat: 37.5, lng: -122.0, accuracy: 10, battery: 0.9, charging: false, speed: 0, cadence: { stop: 4, moving: 3, still: 15 } });

  // The home base joins with an ordinary invite, and Maya makes it an admin.
  const [joined] = await radio(`setup ${(await maya.createInvite({ hours: 1 })).link}`);
  assert.match(joined, /^ok /, joined);
  const hbId = joined.split(' ')[1];
  await maya.refresh();
  await maya.setRole(hbId, 'admin');
  await maya.refresh();
  assert.equal(maya.memberList().find((m) => m.id === hbId)?.name, 'Home base');
  pass('the home base joins with an ordinary invite and becomes an admin');

  // Talking to it: Maya sends direct messages, the home base answers in the chat.
  const ask = async (text) => {
    const before = maya.messages.length;
    await maya.sendChat(text, { to: hbId });
    await radio('advance 21');
    await radio('tick');
    for (let i = 0; i < 50; i++) {
      await maya._fetchMessages();
      const reply = maya.messages.slice(before).find((m) => m.from === hbId);
      if (reply) return reply.body.text;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error(`no answer to "${text}"`);
  };

  await radio(`heard ${TRACKER} T1000-E`);
  let answer = await ask('list');
  assert.match(answer, /!a1b2c3d4 T1000-E/);
  pass('“list” shows Meshtastic nodes it can hear');

  answer = await ask(`add ${TRACKER} Leo's tracker`);
  assert.match(answer, /Added Leo's tracker \(!a1b2c3d4\)/, answer);
  await maya.refresh();
  const tracker = maya.memberList().find((m) => m.name === "Leo's tracker");
  assert.ok(tracker, 'the tracker is a member of its own, verified by the app');
  pass('“add” makes the tracker its own member of the circle, with the name an admin gave it');

  // Its position comes over the radio; the home base seals it as the tracker.
  await radio(`position ${TRACKER} 37.612345 -122.054321 72`);
  await radio('tick');
  await maya.fetchLocations();
  let loc = maya.locations.get(tracker.id);
  assert.ok(loc, 'the admin opens the tracker’s location');
  assert.equal(loc.lat, 37.612345);
  assert.equal(loc.battery, 0.72);
  assert.equal(loc.via, 'radio');
  assert.equal(loc.app, 'meshtastic');
  pass('its position, heard over the mesh, shows on the map as its own pin, marked via radio');

  // Who carries it: saved in the tracker's member record for the apps.
  answer = await ask("link Leo's tracker to Leo");
  assert.match(answer, /carried by Leo/, answer);
  await maya.fetchRecords();
  const rec = maya.memberRecord(tracker.id)?.tracker;
  assert.deepEqual({ node: rec?.node, carriedBy: rec?.carriedBy, mode: rec?.mode }, { node: TRACKER, carriedBy: leo.account.memberId, mode: 'carried' });
  pass('“link” records who carries it, signed by the home base as an admin');

  // Its own status, for the app's Trackers screen: alive, what it hears, its trackers.
  await radio('advance 301');
  await radio('tick');
  await maya.fetchRecords();
  const status = maya.memberRecord(hbId)?.homeBase;
  assert.ok(status && Date.now() - status.at < 3600_000 * 2, 'a recent status');
  assert.ok(status.heard.some((h) => h.node === TRACKER && h.name === 'T1000-E'), 'the nodes it hears');
  assert.deepEqual(status.trackers.map((t) => [t.node, t.member]), [[TRACKER, tracker.id]]);
  pass('the home base publishes its status: when it checked in, the nodes it hears, its trackers');

  // Leo's phone goes quiet for an hour: the home base asks his tracker where it is.
  let out = await radio('advance 3600');
  out = await radio('tick');
  assert.ok(out.includes(`request ${TRACKER}`), `asked the tracker: ${out.join(' | ')}`);
  out = await radio('tick');
  assert.ok(!out.includes(`request ${TRACKER}`), 'and not again straight away');
  await radio(`position ${TRACKER} 37.62 -122.06 70`);
  await radio('tick');
  await maya.fetchLocations();
  loc = maya.locations.get(tracker.id);
  assert.equal(loc.lat, 37.62);
  assert.equal(loc.trigger, 'requested');
  pass('when Leo’s phone goes quiet, it asks his tracker for a position over the mesh');

  // Leo's phone comes back: no more asking.
  await atTestTime(() => leo.shareLocation({ lat: 37.5, lng: -122.0, accuracy: 10, battery: 0.9, charging: false, speed: 0, cadence: { stop: 4, moving: 3, still: 15 } }));
  await radio('advance 900');
  out = await radio('tick');
  assert.ok(!out.includes(`request ${TRACKER}`), 'a phone that is reporting again is left alone');

  // An alert from the tracker becomes an SOS from it.
  await radio(`text ${TRACKER} SOS`);
  await radio('tick');
  await maya._fetchMessages();
  assert.ok(maya.activeSos().some((s) => s.memberId === tracker.id), 'an open SOS from the tracker');
  await radio(`text ${TRACKER} ok`);
  await radio('tick');
  await maya._fetchMessages();
  assert.ok(!maya.activeSos().some((s) => s.memberId === tracker.id), 'closed by "ok"');
  pass('an “SOS” text from the tracker opens an SOS for it; “ok” closes it');

  // The Meshtastic plugin: its settings reach the home base, and off means idle.
  await maya.api.putPluginSettings('meshtastic', { quietMinutes: '45', traceMinutes: '0', sosWords: 'Mayday, SOS' });
  await radio('advance 601');
  await radio('tick');
  await radio(`text ${TRACKER} MAYDAY mayday`);
  await radio('tick');
  await maya._fetchMessages();
  assert.ok(maya.activeSos().some((s) => s.memberId === tracker.id), 'the plugin’s own SOS word');
  await radio(`text ${TRACKER} ok`);
  await radio('tick');
  await radio('advance 301');
  await radio('tick');
  await maya.fetchRecords();
  assert.equal(maya.memberRecord(hbId)?.homeBase?.quietMinutes, 45, 'its status carries the plugin’s quiet time for the app');
  await assert.rejects(maya.api.putPluginSettings('meshtastic', { quietMinutes: '5' }), /10 to 720/);
  await maya.setFeatures({ ...maya.features, meshtastic: false });
  await radio('advance 601');
  await radio('tick');
  assert.match(await ask('list'), /turned off in this circle/);
  await maya.setFeatures({ ...maya.features, meshtastic: true });
  await radio('advance 601');
  await radio('tick');
  pass('Meshtastic is a plugin: its settings reach the home base, and switched off it stays idle');

  // The app's buttons, aimed at the tracker: the server hands them to the home base.
  const located = await maya.requestLocations([tracker.id]);
  assert.equal(located.delivery[tracker.id], 'pushed', 'Locate goes somewhere, not "unreachable"');
  await radio('advance 9');
  out = await radio('tick');
  assert.ok(out.includes(`request ${TRACKER}`), `Locate asks the tracker over the mesh: ${out.join(' | ')}`);
  await radio(`position ${TRACKER} 37.63 -122.07 69`);
  await radio('tick');
  await maya.fetchLocations();
  assert.equal(maya.locations.get(tracker.id).lat, 37.63);
  pass('Locate on the tracker asks it over the mesh, and the new position comes back');

  // The radio path: Locate also traces the route; the answer goes onto the tracker's pin.
  assert.ok(out.includes(`trace ${TRACKER}`), `Locate traces the path: ${out.join(' | ')}`);
  await radio('heard !11111111 meshunit1');
  await radio('heard !22222222 meshunit2');
  await radio(`route ${TRACKER} !11111111,!22222222 24,-10,41`);
  await radio('tick');
  await maya.fetchLocations();
  const mesh = maya.locations.get(tracker.id).mesh;
  assert.equal(mesh.hops, 2);
  assert.deepEqual(
    mesh.path.map((h) => [h.id, h.name, h.snr]),
    [
      [TRACKER, "Leo's tracker", null],
      ['!11111111', 'meshunit1', 6],
      ['!22222222', 'meshunit2', -2.5],
      [null, 'Home base', 10.25],
    ],
  );
  assert.equal(maya.locations.get(tracker.id).lat, 37.63, 'the same position, now with its path');
  pass('the path from the tracker to the home base (tracker → meshunit1 → meshunit2 → Home base) reaches the app');

  await maya.chirp(tracker.id);
  await radio('advance 9');
  out = await radio('tick');
  assert.ok(out.some((l) => l === `alert ${TRACKER} \\aMaya chirped you`), `a chirp beeps the tracker: ${out.join(' | ')}`);
  pass('a chirp to the tracker makes it beep (the alert bell)');

  await maya.askToCheckIn(tracker.id);
  await radio('advance 9');
  out = await radio('tick');
  assert.ok(out.some((l) => l.startsWith(`alert ${TRACKER} \\aCheck in, please: Maya asked`)), `check-in beeps it: ${out.join(' | ')}`);
  assert.ok(out.includes(`request ${TRACKER}`), 'and asks for a position');
  const beforeOk = maya.messages.length;
  await radio(`text ${TRACKER} OK`);
  await radio('tick');
  await maya._fetchMessages();
  const ok = maya.messages.slice(beforeOk).find((m) => m.from === tracker.id);
  assert.equal(ok?.body.checkin, 'ok', 'Maya gets "I’m OK" from the tracker');
  pass('“Ask to check in” beeps the tracker; “OK” from it answers Maya’s check-in');

  // Arrived and left, worked out by the home base as a phone would.
  await maya.savePlace({ name: 'School', lat: 37.7, lng: -122.1, radius: 150 });
  await radio('advance 601'); // places are read every 10 minutes
  await radio(`position ${TRACKER} 37.65 -122.08 68`); // away from school: noted, not announced
  await radio('tick');
  const placeEvents = async () => {
    await maya._fetchMessages();
    return maya.messages.filter((m) => m.from === tracker.id && m.kind === 'event' && m.body?.type === 'place').map((m) => m.body.action);
  };
  assert.deepEqual(await placeEvents(), []);
  await radio('advance 61');
  await radio(`position ${TRACKER} 37.7001 -122.1001 67`);
  await radio('tick');
  assert.deepEqual(await placeEvents(), ['arrived']);
  await maya.fetchLocations();
  assert.equal(maya.locations.get(tracker.id).placeId, [...maya.places.values()].find((p) => p.name === 'School').id);
  await radio('advance 61');
  await radio(`position ${TRACKER} 37.66 -122.09 66`);
  await radio('tick');
  assert.deepEqual(await placeEvents(), ['arrived', 'left']);
  pass('arriving at and leaving a place send the same alerts a phone does');

  // Renaming, and a car.
  answer = await ask("rename Leo's tracker to Leo (backpack)");
  assert.match(answer, /is now Leo \(backpack\)/);
  await maya.refresh();
  assert.equal(maya.memberList().find((m) => m.id === tracker.id)?.name, 'Leo (backpack)');
  answer = await ask('add !0badcafe Honda CR-V as car');
  assert.match(answer, /Added Honda CR-V/);
  await maya.refresh();
  const car = maya.memberList().find((m) => m.name === 'Honda CR-V');
  await maya.fetchRecords();
  assert.equal(maya.memberRecord(car.id)?.tracker?.mode, 'car');
  pass('trackers can be renamed, and a car is marked as one');

  // Only admins change trackers.
  const before = leo.messages.length;
  await leo.refresh();
  await leo.sendChat('remove Honda CR-V', { to: hbId });
  await radio('advance 21');
  await radio('tick');
  await leo._fetchMessages();
  const refusal = leo.messages.slice(before).find((m) => m.from === hbId)?.body.text;
  assert.match(refusal ?? '', /Only the circle's admins/);
  pass('someone who isn’t an admin can’t change trackers');

  // The home base's own GPS: where it is, what it can see, and its own pin.
  const nmea = (body) => {
    let sum = 0;
    for (const c of body) sum ^= c.charCodeAt(0);
    return `$${body}*${sum.toString(16).toUpperCase().padStart(2, '0')}`;
  };
  answer = await ask('gps');
  assert.match(answer, /no GPS/);
  await radio('selfgps 37.548271 -121.988571 9 0.9');
  for (const s of [
    'GPGSV,2,1,07,02,62,045,42,12,48,310,39,25,33,120,36,29,15,200,28',
    'GPGSV,2,2,07,05,10,075,,13,08,250,,31,05,330,',
    'BDGSV,1,1,03,08,55,020,40,23,40,180,35,30,12,090,22',
    'GNGSA,A,3,02,12,25,29,,,,,,,,,1.6,0.9,1.3,1',
    'GNGSA,A,3,08,23,,,,,,,,,,,1.6,0.9,1.3,4',
    'GPGSV,1,1,01,99,10,010,30*00', // a bad checksum: ignored
  ])
    await radio(`nmea ${s.endsWith('*00') ? `$${s}` : nmea(s)}`);
  answer = await ask('gps');
  assert.match(answer, /GPS fix: 37\.548271, -121\.988571/, answer);
  assert.match(answer, /3D fix from 9 satellites, HDOP 0\.9 \(excellent\)/, answer);
  assert.match(answer, /Satellites in view: 10, 7 with a signal, 6 used \(BeiDou 3, GPS 7\)/, answer);
  assert.match(answer, /• GPS 2: 42 dB, 62° up, NE, in the fix/, answer);
  assert.doesNotMatch(answer, / 99:/);
  assert.match(answer, /openstreetmap\.org\/\?mlat=37\.548271/);
  await maya.fetchLocations();
  assert.equal(maya.locations.get(hbId)?.lat, 37.548271);
  pass('“gps” answers with its fix and the satellites it sees, and puts the home base on the map');

  answer = await ask('remove Honda CR-V');
  assert.match(answer, /Removed Honda CR-V/);
  await maya.refresh();
  assert.ok(!maya.memberList().some((m) => m.name === 'Honda CR-V'));
  pass('“remove” takes a tracker out of the circle');

  console.log(`\nall ${step} passed`);
} catch (e) {
  console.error(e);
  console.error('\n--- server log ---\n' + serverLog.slice(-3000));
  process.exitCode = 1;
} finally {
  hb.stdin.end();
  hb.kill();
  server.kill();
  rmSync(dir, { recursive: true, force: true });
}
