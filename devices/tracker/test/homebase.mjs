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
  env: { ...process.env, HOST: '127.0.0.1', PORT: String(port), DATA_DIR: join(dir, 'data'), SETUP_TOKEN: setupToken, PUSH_PROVIDER: 'none', LOAD_TEST: 'true', TRUST_PROXY: 'true', LOCATION_REQUEST_COOLDOWN_SECONDS: '1', MESH_PUBLIC_MQTT: 'off' },
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
  let askTick = [];
  const ask = async (text) => {
    const before = maya.messages.length;
    await maya.sendChat(text, { to: hbId });
    await radio('advance 21');
    askTick = await radio('tick');
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
  assert.ok(askTick.includes(`introduce ${TRACKER}`), `it sends the new tracker its key: ${askTick.join(' | ')}`);
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
  // It's on mains or solar: it reports every minute, with its own health and what it knows about each tracker.
  assert.equal(status.every, 60, 'it reports every minute');
  assert.deepEqual(
    { plugged: status.self?.plugged, wifi: status.self?.wifi, up: status.self?.up, heap: status.self?.heap, ch: status.self?.ch, tx: status.self?.tx },
    { plugged: true, wifi: -58, up: 3600, heap: 120, ch: 3.3, tx: 0.4 },
    'its own power, Wi-Fi, uptime, memory and airtime',
  );
  const radioFacts = status.trackers[0].radio;
  assert.deepEqual({ snr: radioFacts?.snr, battery: radioFacts?.battery, volts: radioFacts?.volts }, { snr: 6.3, battery: 80, volts: 4 }, 'each tracker’s signal and battery');
  const firstAt = status.at;
  await radio('advance 61');
  await radio('tick');
  await maya.fetchRecords();
  assert.ok(maya.memberRecord(hbId).homeBase.at > firstAt, 'a minute later, a fresh status');
  pass('the home base publishes its status every minute: its own health, the nodes it hears, its trackers’ signal and battery');

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
  const onAt = maya.memberRecord(hbId)?.homeBase?.at;
  await assert.rejects(maya.api.putPluginSettings('meshtastic', { quietMinutes: '5' }), /10 to 720/);
  await maya.setFeatures({ ...maya.features, meshtastic: false });
  await radio('advance 601');
  await radio('tick');
  assert.match(await ask('list'), /turned off in this circle/);
  // Off, it still says it's alive, so the app doesn't call it offline.
  await radio('advance 301');
  await radio('tick');
  await maya.fetchRecords();
  const offAt = maya.memberRecord(hbId)?.homeBase?.at;
  assert.ok(offAt > onAt, 'its status stays fresh while the plugin is off');
  // Turned back on, it notices within a minute, not ten.
  await maya.setFeatures({ ...maya.features, meshtastic: true });
  await radio('advance 61');
  await radio('tick');
  assert.doesNotMatch(await ask('list'), /turned off/, 'back on within a minute');
  pass('Meshtastic is a plugin: its settings reach the home base, and switched off it stays idle');

  // The app's buttons, aimed at the tracker: the server hands them to the home base.
  const located = await maya.requestLocations([tracker.id]);
  assert.equal(located.delivery[tracker.id], 'pushed', 'Locate goes somewhere, not "unreachable"');
  await radio('advance 9');
  out = await radio('tick');
  assert.ok(out.includes(`request ${TRACKER}`), `Locate asks the tracker over the mesh: ${out.join(' | ')}`);
  const beforeLocate = maya.messages.length;
  await radio(`position ${TRACKER} 37.63 -122.07 69`);
  await radio('tick');
  await maya.fetchLocations();
  assert.equal(maya.locations.get(tracker.id).lat, 37.63);
  await maya._fetchMessages();
  const here = maya.messages.slice(beforeLocate).find((m) => m.from === tracker.id && m.to === maya.account.memberId);
  assert.match(here?.body.text ?? '', /^📍 Here now · battery 69%\nhttps:\/\/www\.openstreetmap\.org\/\?mlat=37\.630000&mlon=-122\.070000/, 'and answers in Maya’s chat with it');
  pass('Locate on the tracker asks it over the mesh; the new position comes back on the map and in the chat');

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
  assert.deepEqual(
    mesh.path.map((h) => [h.lat, h.lng]),
    [
      [null, null],
      [37.643, -122.077],
      [null, null],
      [null, null],
    ],
    'a relay that said where it is carries its position (rounded), for the line on the map',
  );
  pass('the path from the tracker to the home base (tracker → meshunit1 → meshunit2 → Home base) reaches the app');

  // Out on a trip: each position heard is logged with how it got home (hops, the last relay), for the map.
  await radio(`rx ${TRACKER} 2 !11111111 -3.5`);
  await radio(`position ${TRACKER} 37.6612 -122.0901 66`);
  await radio('advance 31');
  await radio('tick');
  await radio('advance 61');
  await radio('tick');
  await maya.fetchRecords();
  const trip = maya.memberRecord(hbId).homeBase.trackers.find((x) => x.node === TRACKER).log;
  const last = trip.at(-1);
  assert.deepEqual(
    { lat: last.lat, lng: last.lng, hops: last.hops, snr: last.snr, relay: last.relay },
    { lat: 37.6612, lng: -122.0901, hops: 2, snr: -3.5, relay: { id: '!11111111', name: 'meshunit1', lat: 37.643, lng: -122.077 } },
  );
  assert.ok(trip.length >= 2, 'earlier positions stay in the log too');
  pass('each position heard on a trip is logged with its hops and last relay, for the trail on the map');

  // Back in reach after a while away: something heard from it (not a position) gets it asked where it is.
  await radio('advance 1300');
  await radio(`seen ${TRACKER} 3`);
  out = await radio('tick');
  assert.ok(out.includes(`request ${TRACKER}`), `heard again after 20 minutes: asked for its position: ${out.join(' | ')}`);
  await radio(`seen ${TRACKER} 3`);
  out = await radio('tick');
  assert.ok(!out.includes(`request ${TRACKER}`), 'not again for 10 minutes');
  await radio(`position ${TRACKER} 37.67 -122.1 64`);
  await radio('tick');
  await maya.fetchLocations();
  assert.equal(maya.locations.get(tracker.id).lat, 37.67, 'its new position goes on the map at once (it was asked for)');
  pass('a tracker heard again after a while away is asked where it is, and its new position goes on the map');

  await maya.chirp(tracker.id);
  await radio('advance 9');
  out = await radio('tick');
  assert.ok(out.some((l) => l === `alert ${TRACKER} \\aMaya chirped you`), `a chirp beeps the tracker: ${out.join(' | ')}`);
  await maya.chirp(null);
  await radio('advance 9');
  out = await radio('tick');
  assert.ok(!out.some((l) => l.startsWith(`alert ${TRACKER}`)), `"Chirp everyone" is for people, not trackers: ${out.join(' | ')}`);
  pass('a chirp to the tracker makes it beep (the alert bell); chirping everyone leaves trackers out');

  // A Locate the tracker doesn't answer: the chat says so (Leo asks: Maya asked a moment ago).
  await leo.refresh(); // so Leo's app has the tracker's keys
  await leo.requestLocations([tracker.id]);
  await radio('advance 9');
  await radio('tick');
  await leo._fetchMessages();
  const beforeSilence = leo.messages.length;
  await radio('advance 181');
  await radio('tick');
  await leo._fetchMessages();
  const silence = leo.messages.slice(beforeSilence).find((m) => m.from === tracker.id && m.to === leo.account.memberId);
  assert.match(silence?.body?.text ?? '', /^📡 No answer over the radio yet\. My last position is \d+ min ago\./);
  // A tracker that answers without a position (no GPS fix, indoors): said at once.
  await new Promise((r) => setTimeout(r, 1100)); // the server's Locate cooldown in this test
  await maya.requestLocations([tracker.id]);
  await radio('advance 9');
  await radio('tick');
  await maya._fetchMessages();
  const beforeNoFix = maya.messages.length;
  await radio(`nofix ${TRACKER}`);
  await radio('tick');
  await maya._fetchMessages();
  const noFix = maya.messages.slice(beforeNoFix).find((m) => m.from === tracker.id && m.to === maya.account.memberId);
  assert.match(noFix?.body?.text ?? '', /^📡 I heard you, but I don't have a GPS fix right now\./);
  pass('a Locate the tracker doesn’t answer within 3 minutes is reported in the chat, and one it answers without a GPS fix at once');

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

  // Button presses: the HomeCircle tracker firmware says "#press N", and the
  // home base sends the message for it (the circle's, or the tracker's own).
  const saidByTracker = async (since) => {
    await maya._fetchMessages();
    return maya.messages.slice(since).filter((m) => m.from === tracker.id && m.kind === 'chat' && !m.to).map((m) => m.body.text);
  };
  let since = maya.messages.length;
  await radio(`text ${TRACKER} #press 1`); // no check-in waiting: a bump in a pocket sends nothing
  await radio(`text ${TRACKER} #press 2`);
  await radio(`position ${TRACKER} 37.66 -122.09 66`);
  await radio('tick');
  assert.deepEqual(await saidByTracker(since), ['📍 Here’s where I am'], '2 presses: the default message');
  await maya.fetchLocations();
  assert.equal(maya.locations.get(tracker.id)?.lat, 37.66, 'with a fresh position, sent at once');
  await maya.api.putPluginSettings('meshtastic', { quietMinutes: '45', traceMinutes: '0', sosWords: 'Mayday, SOS', press4: 'Heading home now' });
  await maya.setMemberRecord(tracker.id, { tracker: { ...maya.memberRecord(tracker.id).tracker, custom: { still: 60, presses: { 3: 'Gate B, please' } } } });
  await radio('advance 601'); // the plugin and each tracker's own settings are read every 10 minutes
  out = await radio('tick');
  assert.ok(out.includes(`configure ${TRACKER} 120 3600 1800 h7`), `its own position interval goes onto the tracker, and up to 7 hops home: ${out.join(' | ')}`);
  since = maya.messages.length;
  await radio(`text ${TRACKER} #press 3`);
  await radio('tick');
  await radio(`text ${TRACKER} #press 4`);
  await radio('tick');
  assert.deepEqual(await saidByTracker(since), ['Gate B, please', 'Heading home now'], 'its own message for 3, the circle’s for 4');
  const urgent = maya.messages.find((m) => m.body?.text === 'Gate B, please');
  assert.ok(urgent, 'come pick me up arrives');
  pass('button presses send the message for them: the tracker’s own, the circle’s, or the default');

  // Its settings go onto the tracker over the radio once it trusts the home base's key.
  await radio(`configured ${TRACKER} needs-key`);
  await radio('advance 61');
  await radio('tick');
  await maya.fetchRecords();
  let hbStatus = maya.memberRecord(hbId).homeBase;
  assert.equal(hbStatus.trackers.find((x) => x.node === TRACKER)?.settings, 'needs-key', 'the app can say the tracker needs the key');
  assert.equal(hbStatus.key, 'vF3zUvwXwuAElnZ54StHuwcop/EZIIeu0IOKOnbiyA4=', 'and show the key to add');
  assert.equal(hbStatus.node, '!69852494', 'and its node id, for phones to address messages over the mesh');
  await radio(`configured ${TRACKER} set`);
  await radio('advance 61');
  out = await radio('tick');
  await maya.fetchRecords();
  hbStatus = maya.memberRecord(hbId).homeBase;
  assert.equal(hbStatus.trackers.find((x) => x.node === TRACKER)?.settings, 'set');
  await radio('advance 3600');
  out = await radio('tick');
  assert.ok(!out.some((l) => l.startsWith(`configure ${TRACKER}`)), 'set once: a change made on the tracker itself stays');
  await maya.setMemberRecord(tracker.id, { tracker: { ...maya.memberRecord(tracker.id).tracker, mode: 'pet', carriedBy: null } });
  await radio('advance 601');
  await radio('tick');
  assert.match(await ask('list'), /Leo's tracker \(!a1b2c3d4\), pet,/, 'the home base follows what an admin chose in the app');
  answer = await ask(`rename ${TRACKER} to Leo's tag`);
  await maya.fetchRecords();
  assert.equal(maya.memberRecord(tracker.id).tracker.custom?.presses?.['3'], 'Gate B, please', 'renaming keeps its own settings');
  assert.equal(maya.memberRecord(tracker.id).tracker.mode, 'pet', 'and what it is');
  await maya.setMemberRecord(tracker.id, { tracker: { ...maya.memberRecord(tracker.id).tracker, mode: 'carried', carriedBy: leo.account.memberId } });
  await radio('advance 601');
  await radio('tick');
  await ask(`rename ${TRACKER} to Leo's tracker`);
  assert.equal(maya.memberRecord(tracker.id).tracker.carriedBy, leo.account.memberId, 'given back to Leo');
  pass('settings go onto the tracker over the radio, once; without the home base’s key the app is told');

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

  // Adding from the tracker's "Share contact" link (Meshtastic app → Share contact): a QR code in the app, or pasted here.
  const varint = (n) => {
    const out = [];
    do {
      let b = n % 128;
      n = Math.floor(n / 128);
      if (n) b |= 128;
      out.push(b);
    } while (n);
    return out;
  };
  const field = (num, bytes) => [num * 8 + 2, ...varint(bytes.length), ...bytes];
  const utf8 = (s) => [...Buffer.from(s, 'utf8')];
  const user = [...field(1, utf8('!0c0ffee1')), ...field(2, utf8('Rex collar')), ...field(3, utf8('REX')), 5 * 8, ...varint(71), ...field(8, Array(32).fill(7))];
  const contact = Buffer.from([8, ...varint(0x0c0ffee1), ...field(2, user)]).toString('base64url');
  await radio('heard !0c0ffee1 Rex collar');
  answer = await ask(`add https://meshtastic.org/v/#${contact} as pet`);
  assert.match(answer, /Added Rex collar \(!0c0ffee1\)/, answer);
  assert.ok(askTick.some((l) => /^contact \d+ bytes$/.test(l)), `the home base keeps its contact, key included: ${askTick.join(' | ')}`);
  assert.match(await ask('list'), /Rex collar \(!0c0ffee1\), pet,/);
  answer = await ask(`contact https://meshtastic.org/v/#${contact}`);
  assert.match(answer, /Got Rex collar's contact\./, answer);
  assert.ok(askTick.some((l) => /^contact \d+ bytes$/.test(l)) && askTick.includes('introduce !0c0ffee1'), `"contact" passes its key on, and sends it ours: ${askTick.join(' | ')}`);
  answer = await ask(`add !0c0ffee1 Rex again`);
  assert.match(answer, /already Rex collar/, 'the chat way still works, and knows it');
  await radio('advance 61');
  await radio('tick');
  await maya.fetchRecords();
  assert.equal(maya.memberRecord(hbId).homeBase.channel, 'https://meshtastic.org/e/#TEST', 'its status carries the channel link for the app’s QR code');
  pass('a tracker’s Share contact link adds it (named from the contact, as a pet); the channel link reaches the app');

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

  // Updates over Wi-Fi: an admin's "update <link> <sha256>" (the app sends it); its version in its status.
  assert.match(await ask('version'), /Home base firmware \S+\./);
  const sha = 'ab'.repeat(32);
  answer = await ask(`update https://github.com/x/y/releases/download/v1/homebase.bin ${sha.toUpperCase()}`);
  assert.match(answer, /Updating from \S+\. I'll download it/, answer);
  assert.ok(askTick.includes(`update https://github.com/x/y/releases/download/v1/homebase.bin ${sha} by ${maya.account.memberId}`), `the module gets the update to do: ${askTick.join(' | ')}`);
  assert.match(await ask('update http://insecure.example/fw.bin ' + sha), /Update with: update <https link/);
  assert.match(await ask('update https://example.com/fw.bin 1234'), /Update with/);
  const before2 = leo.messages.length;
  await leo.sendChat(`update https://example.com/fw.bin ${sha}`, { to: hbId });
  await radio('advance 21');
  await radio('tick');
  await leo._fetchMessages();
  assert.match(leo.messages.slice(before2).find((m) => m.from === hbId)?.body.text ?? '', /Only the circle's admins can update the home base/);
  await radio('advance 61');
  await radio('tick');
  await maya.fetchRecords();
  assert.ok(maya.memberRecord(hbId).homeBase.fw, 'its status says which firmware it runs');
  pass('“update” (admins only) hands the module a link and checksum to update from; its version is in its status');

  // The internet bridge (MQTT): set by an admin; a position a gateway heard comes "via internet".
  assert.match(await ask('mqtt'), /The internet bridge is off/);
  assert.match(await ask('mqtt broker.example.com'), /Set it with: mqtt <broker/);
  answer = await ask('mqtt broker.example.com:8883 homecircle s3cret-pass');
  assert.match(answer, /Internet bridge set to broker\.example\.com\. I'll restart/, answer);
  assert.doesNotMatch(answer, /s3cret/, 'it never repeats the password');
  assert.ok(askTick.includes('mqtt on broker.example.com 8883 homecircle 11'), `the module gets it: ${askTick.join(' | ')}`);
  assert.match(await ask('mqtt'), /on, to broker\.example\.com, and connected/);
  await radio(`net ${TRACKER}`);
  await radio(`position ${TRACKER} 37.6 -122.1 80`);
  await radio('advance 31');
  await radio('tick');
  await maya.fetchLocations();
  const viaNet = maya.locations.get(tracker.id);
  assert.equal(viaNet?.lat, 37.6);
  assert.equal(viaNet?.mesh?.src, 'internet', 'its position says it came over the internet');
  await radio('advance 61');
  await radio('tick');
  await maya.fetchRecords();
  assert.equal(maya.memberRecord(hbId).homeBase.self.mqtt, true, 'its status says the bridge is connected');
  assert.equal(maya.memberRecord(hbId).homeBase.trackers.find((t) => t.node === TRACKER).log.at(-1).src, 'internet');
  assert.match(await ask('mqtt off'), /Turning the internet bridge off/);
  pass('the internet bridge: an admin sets it (the password stays out of replies); positions a gateway heard show as via internet');

  // The phone bridge: a phone passes its tracker's position on, sealed and silent.
  await maya.sendTrackerFix(hbId, { node: TRACKER, lat: 37.7, lng: -122.2, at: Date.now() + ahead - 5000, battery: 64 });
  assert.ok(!maya.conversation(hbId).some((m) => m.body?.trackerFix), 'it isn’t a chat message');
  await radio('advance 21');
  await radio('tick');
  await radio('advance 31');
  await radio('tick');
  await maya.fetchLocations();
  const viaPhone = maya.locations.get(tracker.id);
  assert.equal(viaPhone?.lat, 37.7);
  assert.equal(viaPhone?.mesh?.src, 'phone');
  assert.match(viaPhone?.mesh?.gateway ?? '', /^Maya's phone$/);
  // The car isn't Leo's to move: he neither carries it nor is an admin.
  await leo.refresh();
  const carBefore = maya.locations.get(car.id)?.ts ?? 0;
  await leo.sendTrackerFix(hbId, { node: '!0badcafe', lat: 1, lng: 1 });
  await radio('advance 21');
  await radio('tick');
  await radio('advance 31');
  await radio('tick');
  await maya.fetchLocations();
  assert.equal(maya.locations.get(car.id)?.ts ?? 0, carBefore, 'someone who neither carries it nor is an admin can’t move it');
  pass('the phone bridge: a position from the carrier’s (or an admin’s) phone shows “via <name>’s phone”, and isn’t a chat message');

  // SOS delivery: the home base answers each SOS it gets with "#sos-ack" (at most every 20 s).
  await radio(`text ${TRACKER} \u0007🆘 SOS`);
  let acks = await radio('tick');
  assert.ok(acks.includes(`sos-ack ${TRACKER}`), `it tells the tracker its SOS got here: ${acks.join(' | ')}`);
  await radio(`text ${TRACKER} \u0007🆘 SOS`);
  acks = await radio('tick');
  assert.ok(!acks.includes(`sos-ack ${TRACKER}`), 'not again within 20 s');
  await radio(`text ${TRACKER} OK, I'm safe`);
  await radio('advance 21');
  await radio('tick');

  // The public beacon and public SOS: sent to a HomeCircle tracker as "#cfg" until it confirms.
  await maya.setMemberRecord(tracker.id, { tracker: { ...maya.memberRecord(tracker.id).tracker, beacon: 30 } });
  const s0 = await maya.api.pluginSettings('meshtastic');
  const vals = Object.fromEntries(s0.fields.map((f) => [f.id, typeof s0.values[f.id] === 'string' ? s0.values[f.id] : '']));
  await maya.api.putPluginSettings('meshtastic', { ...vals, publicSos: 'on' });
  let cfgLine = null;
  for (let i = 0; i < 14 && !cfgLine; i++) {
    await radio('advance 61');
    cfgLine = (await radio('tick')).find((l) => l.startsWith(`cfg ${TRACKER} `));
  }
  assert.equal(cfgLine, `cfg ${TRACKER} psos=1 beacon=1800 prec=13`);
  await radio(`text ${TRACKER} #cfg-ok psos=1 beacon=1800 prec=13`);
  let again = null;
  for (let i = 0; i < 12 && !again; i++) {
    await radio('advance 61');
    again = (await radio('tick')).find((l) => l.startsWith(`cfg ${TRACKER} `));
  }
  assert.equal(again ?? null, null, 'confirmed: not sent again');
  pass('SOS delivery: “#sos-ack” back to the tracker; public SOS and beacon go to it as “#cfg” until it confirms');

  // Messages both ways: text from the mesh reaches the chat; a direct message reaches the tracker.
  const beforeChat = maya.messages.length;
  await radio(`text ${TRACKER} Running late, at the gas station`);
  await radio(`chantext !0c0ffee9 Cousin Ali|Hello from the trail`);
  await radio('advance 21');
  await radio('tick');
  await maya._fetchMessages();
  const fresh = maya.messages.slice(beforeChat).map((m) => [m.from, m.body?.text]);
  assert.ok(fresh.some(([who, text]) => who === tracker.id && text === 'Running late, at the gas station'), `a tracker's text, as the tracker: ${JSON.stringify(fresh)}`);
  assert.ok(fresh.some(([who, text]) => who === hbId && /Cousin Ali \(Meshtastic\): Hello from the trail/.test(text)), `anyone else's on the private channel, from the home base: ${JSON.stringify(fresh)}`);
  await maya.sendChat('Dinner at 7', { to: tracker.id });
  await radio('advance 21');
  const relayed = await radio('tick');
  assert.ok(relayed.some((l) => l === `alert ${TRACKER} Maya: Dinner at 7`), `a direct message goes to the tracker over the radio: ${relayed.join(' | ')}`);

  // Away: its position is old, so the home base asks it where it is (every 15 minutes).
  await radio('advance 1300');
  const pinged = await radio('tick');
  assert.ok(pinged.includes(`request ${TRACKER}`), `asked where it is: ${pinged.join(' | ')}`);
  await radio('advance 120');
  assert.ok(!(await radio('tick')).includes(`request ${TRACKER}`), 'not again for 15 minutes');
  pass('messages both ways between the mesh and the chat; a tracker whose position is old gets asked where it is');

  // "trace": the path now, on request (the app's "Trace its path now").
  answer = await ask(`trace ${TRACKER}`);
  assert.match(answer, /Tracing .+'s path now/, answer);
  assert.ok(askTick.includes(`trace ${TRACKER}`), `it starts a traceroute: ${askTick.join(' | ')}`);
  assert.match(await ask('trace nobody'), /I don't have a tracker called nobody/);
  pass('“trace” traces a tracker’s path on request');

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
