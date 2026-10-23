// Load test: a swarm of simulated people who join circles on a HomeCircle
// server and use it like real families, friends, coworkers and party guests:
// chatting, reacting, moving between places, Locating each other and opening
// and closing the app. A dashboard shows the load next to Home Assistant's
// CPU and memory. Point it at a TEST server (the add-on's load-test server),
// never at your family's.
//
//   cd server && npm ci && (cd ../packages/core && npm ci)
//   node scripts/swarm.mjs --server http://192.168.1.20:8081 --setup-code <code>
//
// See docs/LOAD-TEST.md for the whole walkthrough.
import { nativeSignatures } from './swarm/fastcrypto.mjs';
import { parseArgs } from 'node:util';
import { mkdirSync, readFileSync, writeFileSync, existsSync, renameSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { CircleClient, normalizeServerUrl } from '../../packages/core/src/index.js';
import { Metrics } from './swarm/metrics.mjs';
import { World, SimCircle, SimMember, offset } from './swarm/sim.mjs';
import { SCENARIOS, SCALES, MAX_PEOPLE, MAX_CIRCLES, newPerson } from './swarm/scenarios.mjs';
import { pickCity, customCity } from './swarm/world.mjs';
import { findings, report } from './swarm/analysis.mjs';
import { startDashboard } from './swarm/dashboard.mjs';

const HELP = `HomeCircle swarm: simulated people using a HomeCircle server.

  node scripts/swarm.mjs --server <url> --setup-code <code> [options]

  --server <url>         the load-test server, e.g. http://192.168.1.20:8081   (env HC_SERVER)
  --setup-code <code>    its setup code, from the add-on log (first run only)  (env HC_SETUP_CODE)
  --invite-my-phone <which>
                         make invite links so your phone can watch: hq (only the
                         "Load test HQ" status circle) or all (every circle).
                         Default: none. Every circle on a phone is another
                         connection it reopens at once after unlocking, so
                         don't use the phone your family relies on.
  --invite-server <url>  address in the invite links for your phone, e.g.
                         https://homecircle.your-tailnet.ts.net:8443         (env HC_INVITE_SERVER)
  --scale <size>         small (7 circles, ~85 people), medium (11, ~115),
                         large (26, ~250), xl (54, ~540). Default small, or
                         the mix from your last run.
  --circles <mix>        circles of each kind, e.g. family=4,friends=2,party=0
                         (kinds: family, friends, work, party, elders,
                         politics, history)
  --people <n | mix>     people in every circle (8), or per kind:
                         family=5,party=40. Up to ${MAX_PEOPLE}. Default: varied sizes.
                         Both can also be changed live on the dashboard.
  --speed <n>            how many times busier than a normal day. Default 1.
  --ramp <minutes>       bring circles online gradually over this long. Default 5.
  --duration <minutes>   stop after this long. Default: run until Ctrl+C.
  --near <lat,lng>       put every circle around one spot instead of in cities
                         around the world (the default).
  --always-open <0-1>    share of people with the app always open. Default 0.15.
  --ha-url <url>         Home Assistant, e.g. http://homeassistant.local:8123  (env HA_URL)
  --ha-token <token>     a long-lived access token from your HA profile        (env HA_TOKEN)
  --port <n>             dashboard port. Default 8090.
  --data <dir>           where accounts, state and CSV files go. Default .swarm
`;

const { values: opt } = parseArgs({
  options: {
    server: { type: 'string', default: process.env.HC_SERVER },
    'setup-code': { type: 'string', default: process.env.HC_SETUP_CODE },
    'invite-my-phone': { type: 'string', default: 'none' },
    'invite-server': { type: 'string', default: process.env.HC_INVITE_SERVER },
    scale: { type: 'string' },
    circles: { type: 'string' },
    people: { type: 'string' },
    speed: { type: 'string', default: '1' },
    ramp: { type: 'string', default: '5' },
    duration: { type: 'string', default: '0' },
    near: { type: 'string' },
    'always-open': { type: 'string', default: '0.15' },
    'ha-url': { type: 'string', default: process.env.HA_URL },
    'ha-token': { type: 'string', default: process.env.HA_TOKEN },
    port: { type: 'string', default: '8090' },
    data: { type: 'string', default: '.swarm' },
    help: { type: 'boolean', short: 'h' },
  },
});
if (opt.help || !opt.server) {
  console.log(HELP);
  process.exit(opt.help ? 0 : 1);
}
const phoneInvites = opt['invite-my-phone'];
if (!['none', 'hq', 'all'].includes(phoneInvites)) {
  console.error('--invite-my-phone must be none, hq or all');
  process.exit(1);
}
if (opt.scale && !SCALES[opt.scale]) {
  console.error(`--scale must be one of: ${Object.keys(SCALES).join(', ')}`);
  process.exit(1);
}
const KINDS = Object.keys(SCENARIOS);
/** "family=4,party=0" → { family: 4, party: 0 }; a bare number applies to every kind. */
function parseMix(text, what, max) {
  if (!text) return {};
  if (/^\d+$/.test(text.trim())) return Object.fromEntries(KINDS.map((k) => [k, Math.min(max, Number(text))]));
  const out = {};
  for (const part of text.split(',')) {
    const [k, v] = part.split('=').map((x) => x.trim());
    if (!KINDS.includes(k) || !/^\d+$/.test(v ?? '')) {
      console.error(`${what}: “${part}” isn’t kind=number. Kinds: ${KINDS.join(', ')}`);
      process.exit(1);
    }
    out[k] = Math.min(max, Number(v));
  }
  return out;
}
const circlesArg = parseMix(opt.circles, '--circles', MAX_CIRCLES);
const peopleArg = parseMix(opt.people, '--people', MAX_PEOPLE);

const server = normalizeServerUrl(opt.server);
const inviteServer = opt['invite-server'] ? normalizeServerUrl(opt['invite-server']) : null;
const speed = Math.max(0.1, Number(opt.speed) || 1);
const near = opt.near ? customCity(...opt.near.split(',').map(Number)) : null;
const alwaysOpenShare = Math.min(1, Math.max(0, Number(opt['always-open']) || 0));
const dataDir = resolve(opt.data);
mkdirSync(dataDir, { recursive: true });
const tag = server.replace(/^https?:\/\//, '').replace(/[^A-Za-z0-9.-]+/g, '_');
const statePath = join(dataDir, `${tag}.json`);
const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
const csvPath = join(dataDir, `${tag}-${stamp}.csv`);
const reportPath = join(dataDir, `${tag}-${stamp}-report.md`);

const log = (...a) => console.log(new Date().toLocaleTimeString(), ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- saved state: accounts (keys) and what was built ----------------------

let state = existsSync(statePath) ? JSON.parse(readFileSync(statePath, 'utf8')) : null;
if (state && state.server !== server) state = null;
state ??= { server, created: Date.now(), ipCounter: 2, hq: null, accounts: {}, circles: [] };

let saveTimer = null;
let worldRef = null;
const saveNow = () => {
  clearTimeout(saveTimer);
  saveTimer = null;
  // Remember how far each phone has read, so a restart doesn't make every
  // simulated phone download its circle's whole history again.
  for (const c of worldRef?.circles ?? []) {
    for (const m of c.members) {
      const p = c.saved.members.find((x) => x.accountKey === m.client.accountKey);
      if (p) p.lastSeq = m.client.lastSeq;
    }
  }
  writeFileSync(`${statePath}.tmp`, JSON.stringify(state));
  renameSync(`${statePath}.tmp`, statePath);
};
const saveSoon = () => {
  saveTimer ??= setTimeout(saveNow, 2000);
};
const storage = {
  getItem: async (k) => state.accounts[k] ?? null,
  setItem: async (k, v) => {
    state.accounts[k] = v;
    saveSoon();
  },
  removeItem: async (k) => {
    delete state.accounts[k];
    saveSoon();
  },
};

const metrics = new Metrics({ csvPath });
const feedItems = [];
const feed = (circle, who, text, kind) => {
  feedItems.push({ t: Date.now(), circle: circle?.name ?? '', who, text: String(text ?? '').slice(0, 140), kind });
  if (feedItems.length > 80) feedItems.shift();
};
const world = new World({ speed, metrics, feed });
worldRef = world;

const nextIp = () => {
  const n = state.ipCounter++;
  return `10.${(n >> 16) & 255}.${(n >> 8) & 255}.${n & 255}`;
};
const makeClient = (accountKey, ip) =>
  new CircleClient({ storage, accountKey, fetchImpl: metrics.fetchFor(ip), onError: () => {} });

/** Retry when the server says "too many", as a person would after a moment. */
async function patiently(fn, what) {
  for (let i = 0; ; i++) {
    try {
      return await fn();
    } catch (e) {
      if (e?.status === 429 && i < 20) {
        const wait = Math.max(1, Number(e.retryAfter) || 5);
        if (i === 0) log(`${what}: server is rate limiting, waiting ${wait}s`);
        await sleep(wait * 1000);
        continue;
      }
      throw e;
    }
  }
}

const inviteFor = (link) => (inviteServer ? inviteServer + link.slice(server.length) : link);

// --- 1. the server and the HQ circle ---------------------------------------

let info;
try {
  info = await CircleClient.serverInfo(server);
} catch (e) {
  console.error(`Can't reach ${server}: ${e.message}`);
  process.exit(1);
}
// Only ever on a server that says it's for load tests (LOAD_TEST=1, which the
// add-on sets for its load-test server). A swarm on a family's server would
// fill it with simulated people and slow it down for real phones.
if (!info.loadTest) {
  console.error(
    `${server} isn't a load-test server, so the swarm won't run on it.\n` +
      'Use the Home Assistant add-on\'s load-test server (load_test_server on, port 8081, add-on 0.8.2 or newer),\n' +
      'or a separate local server started with LOAD_TEST=1 (see docs/LOAD-TEST.md).',
  );
  process.exit(1);
}
log(`HomeCircle ${info.version} at ${server}${nativeSignatures ? '' : ' (slow signatures: expect the swarm itself to limit the load)'}`);
if (info.push) log('Note: this server sends push notifications. A swarm on a server with push on will notify your phone a lot; the add-on’s load-test server has push off.');

let hq;
if (state.hq) {
  hq = makeClient(state.hq.accountKey, state.hq.ip);
  await hq.load();
  try {
    await hq.refresh();
  } catch (e) {
    if (e?.status === 401) {
      console.error('This server no longer knows the swarm (it was reset?). Delete', statePath, 'and run again with its new setup code.');
      process.exit(1);
    }
    throw e;
  }
} else {
  if (info.setup) {
    console.error(
      'This server already has circles that the swarm didn’t make. Use a fresh load-test server:\n' +
        'in Home Assistant, turn on load_test_reset, restart the add-on, turn it off again, and use the new setup code.',
    );
    process.exit(1);
  }
  if (!opt['setup-code']) {
    console.error('First run on this server: pass --setup-code (it’s in the add-on log, with the [load-test] prefix).');
    process.exit(1);
  }
  state.hq = { accountKey: 'swarm:hq', ip: nextIp() };
  hq = makeClient(state.hq.accountKey, state.hq.ip);
  await hq.createCircle({ serverUrl: server, setupToken: opt['setup-code'], name: 'Load Test HQ', circleName: 'Load test HQ 📊' });
  saveNow();
  log('created the “Load test HQ” circle');
}
/**
 * Invites are single-use. Keep one open invite for you per circle: replace it
 * when it was used (by you on another phone, or anyone) or is about to expire.
 */
async function freshInvite(client, current) {
  if (current?.id && current.expiresAt > Date.now() + 3600_000) {
    const { invites } = await client.api.listInvites();
    if (invites.some((i) => i.id === current.id)) return current;
  }
  const inv = await client.createInvite({ hours: 168 });
  return { id: inv.id, link: inviteFor(inv.link), expiresAt: inv.expiresAt };
}
const hqInvite = async () => {
  const next = await freshInvite(hq, state.hqInvite);
  if (next !== state.hqInvite) {
    state.hqInvite = next;
    saveSoon();
  }
  return state.hqInvite;
};
if (phoneInvites !== 'none') await hqInvite();

// --- 2. the mix: how many circles of each kind, and how many people in each -

// Your last mix is remembered; --scale, --circles and --people change it.
const target = {
  circles: { ...(opt.scale ? SCALES[opt.scale] : (state.target?.circles ?? SCALES.small)), ...circlesArg },
  people: { ...(opt.scale || opt.circles ? {} : (state.target?.people ?? {})), ...peopleArg },
};
for (const k of KINDS) target.circles[k] ??= 0;
const clampTarget = () => {
  // The server holds at most 100 circles (HQ is one); trim the biggest kinds first.
  while (KINDS.reduce((n, k) => n + target.circles[k], 0) > MAX_CIRCLES) {
    const k = KINDS.reduce((a, b) => (target.circles[a] >= target.circles[b] ? a : b));
    target.circles[k]--;
  }
  for (const k of KINDS) {
    target.circles[k] = Math.max(0, Math.floor(target.circles[k] || 0));
    if (target.people[k] != null) target.people[k] = Math.min(MAX_PEOPLE, Math.max(2, Math.floor(target.people[k])));
  }
  state.target = target;
  saveSoon();
};
clampTarget();

const takenNames = new Set(state.circles.map((c) => c.spec.circleName));
const personRecord = (saved, p, index) => ({
  ...p,
  index,
  accountKey: `swarm:${Math.random().toString(36).slice(2, 12)}`,
  ip: nextIp(),
  home: saved.spec.homes ? offset(saved.center, 1 + Math.random() * 7) : null,
  work: offset(saved.center, 4 + Math.random() * 11),
  alwaysOpen: index === 0 || Math.random() < alwaysOpenShare,
});

/** A new circle of this kind on the server, with just its owner so far. */
async function createSavedCircle(key) {
  const sc = SCENARIOS[key];
  // Distinct names, so you can tell circles apart in the app. Reserved
  // before any await: several circles are built at once.
  // Each circle lives in a city somewhere in the world (or around --near).
  const city = near || pickCity();
  let spec = sc.build(city);
  for (let i = 0; i < 10 && takenNames.has(spec.circleName); i++) spec = sc.build(city);
  if (takenNames.has(spec.circleName)) {
    let n = 2;
    while (takenNames.has(`${spec.circleName} ${n}`)) n++;
    spec.circleName = `${spec.circleName} ${n}`;
  }
  takenNames.add(spec.circleName);
  const center = offset(city, near ? Math.random() * 12 : 0.5 + Math.random() * 3);
  const saved = {
    key,
    city: { name: city.name, flag: city.flag, region: city.region, landmark: city.landmark },
    spec: { circleName: spec.circleName, homes: !!spec.homes },
    center,
    places: spec.places.map((p) => ({
      key: p.key,
      name: p.name,
      radius: p.key === 'landmark' ? 250 : 150,
      ...(p.lat != null ? { lat: p.lat, lng: p.lng } : p.km ? offset(center, p.km) : { lat: center.lat, lng: center.lng }),
    })),
    members: [],
    // The rest of the people build() came up with, for a "natural" size.
    planned: spec.people.slice(1),
    userInvite: null,
  };
  const first = personRecord(saved, spec.people[0], 0);
  const owner = makeClient(first.accountKey, first.ip);
  await patiently(() => owner.createCircle({ serverUrl: server, admin: hq, name: first.name, circleName: spec.circleName }), 'create circle');
  saved.members.push(first);
  for (const p of saved.places) p.id = await owner.savePlace({ name: p.name, lat: p.lat, lng: p.lng, radius: p.radius });
  state.circles.push(saved);
  saveSoon();
  return saved;
}

/** The running version of a saved circle (people loaded, not started yet). */
async function hydrate(saved) {
  const members = [];
  const circle = new SimCircle({ world, key: saved.key, spec: saved.spec, center: saved.center, places: saved.places, members, owner: null });
  circle.saved = saved;
  circle.city = saved.city || null;
  for (const p of saved.members) members.push(await loadMember(circle, p));
  circle.owner = members[0];
  world.circles.push(circle);
  return circle;
}

async function loadMember(circle, p) {
  const client = makeClient(p.accountKey, p.ip);
  await client.load();
  client.lastSeq = p.lastSeq || 0;
  const m = new SimMember({ world, circle, person: p, index: p.index, client, ip: p.ip, home: p.home, work: p.work, alwaysOpen: p.alwaysOpen });
  world.simIds.add(client.account.memberId);
  return m;
}

/** One more person joins through an invite, like a real sign-up. */
async function addPerson(circle) {
  const saved = circle.saved;
  const names = new Set(saved.members.map((p) => p.name));
  const next = saved.planned?.length ? saved.planned.shift() : newPerson(saved.key, names, saved.city);
  if (names.has(next.name)) Object.assign(next, newPerson(saved.key, names, saved.city), { role: next.role, travel: next.travel });
  const p = personRecord(saved, next, Math.max(...saved.members.map((x) => x.index)) + 1);
  const owner = circle.owner;
  const inv = await patiently(() => owner.client.createInvite({ hours: 1 }), 'invite');
  const c = makeClient(p.accountKey, p.ip);
  await patiently(() => c.joinWithInvite(inv.link, { name: p.name }), 'join');
  metrics.count('joins');
  saved.members.push(p);
  saveSoon();
  const m = await loadMember(circle, p);
  circle.members.push(m);
  if (circle.active) {
    await m.boot();
    world.feed(circle, m.name, 'joined the circle', 'place');
  }
  return m;
}

/** The newest person (never the owner) leaves the circle. */
async function removePerson(circle) {
  if (circle.members.length <= 1) return;
  const m = circle.members[circle.members.length - 1];
  circle.members.pop();
  circle.saved.members = circle.saved.members.filter((p) => p.accountKey !== m.client.accountKey);
  saveSoon();
  await m.leave().catch((e) => log(`${m.name} couldn’t leave ${circle.name}: ${e.message}`));
}

/** How many people this circle should have right now. */
function wantedSize(circle) {
  const fixed = target.people[circle.key];
  if (fixed != null) return fixed;
  // Varied sizes: the size it was built with.
  return circle.saved.members.length + (circle.saved.planned?.length ?? 0);
}

async function startCircle(circle) {
  if (phoneInvites === 'all') await userInvite(circle).catch((e) => log(`invite for ${circle.name} failed: ${e.message}`));
  circle.stopped = false;
  await Promise.all(
    circle.members.map(async (m, j) => {
      await sleep(Math.random() * Math.min(20_000, 400 * j + 1000));
      await m.boot().catch((e) => log(`${m.name} couldn’t start: ${e.message}`));
    }),
  );
  circle.activate();
  log(`online: “${circle.name}” (${circle.members.length} people)`);
}

/** Make room for a new circle by deleting a paused one nobody outside the swarm joined. */
async function freeACircle() {
  const idle = world.circles.filter((c) => !c.active && !c.busy);
  const victim = idle.find((c) => !c.userMembers().length) || idle[0];
  if (!victim) return false;
  await victim.owner.run(() => victim.owner.client.deleteCircle()).catch(() => {});
  world.circles.splice(world.circles.indexOf(victim), 1);
  state.circles.splice(state.circles.indexOf(victim.saved), 1);
  saveSoon();
  log(`deleted paused circle “${victim.name}” to make room`);
  return true;
}

const status = { busy: false, note: '' };
let reconcileAgain = false;
let reconciling = null;
/**
 * Bring the running swarm to the target mix: build, resume or pause circles,
 * then have people join or leave until each circle is the right size.
 * Runs one at a time; a change made meanwhile triggers another pass.
 */
function reconcile({ rampMs = 0 } = {}) {
  if (reconciling) {
    reconcileAgain = true;
    return reconciling;
  }
  reconciling = (async () => {
    do {
      reconcileAgain = false;
      status.busy = true;
      try {
        await reconcileOnce(rampMs);
      } catch (e) {
        log(`couldn’t reach the target mix: ${e.message}`);
        status.note = e.message;
      }
      rampMs = 0;
    } while (reconcileAgain);
    status.busy = false;
  })().finally(() => (reconciling = null));
  return reconciling;
}

async function reconcileOnce(rampMs) {
  // Circles: the first N of each kind run, the rest pause (kept for later).
  const toStart = [];
  for (const k of KINDS) {
    const mine = world.circles.filter((c) => c.key === k);
    const want = target.circles[k];
    mine.slice(want).forEach((c) => {
      if (c.active || !c.stopped) {
        c.deactivate();
        log(`paused: “${c.name}”`);
      }
    });
    for (const c of mine.slice(0, want)) if (!c.active) toStart.push(c);
    for (let i = mine.length; i < want; i++) toStart.push({ build: k });
  }
  // Circles about to start must not be picked to make room.
  for (const c of world.circles) c.busy = toStart.includes(c);
  const needNew = toStart.filter((x) => x.build).length;
  if (needNew) log(`building ${needNew} circle(s)…`);
  status.note = needNew ? `building ${needNew} circle(s)` : '';
  // Build the new ones a few at a time: realistic sign-up bursts.
  for (let i = 0; i < toStart.length; i++) {
    const x = toStart[i];
    if (!x.build) continue;
    if (state.circles.length >= MAX_CIRCLES && !(await freeACircle())) {
      status.note = 'the server is full (100 circles)';
      toStart[i] = null;
      continue;
    }
    toStart[i] = await hydrate(await patiently(() => createSavedCircle(x.build), 'create circle'));
  }
  const starting = toStart.filter(Boolean);
  // Fill circles to size before they start, so they come online whole.
  await resize(starting);
  const stagger = starting.length > 1 ? rampMs / (starting.length - 1) : 0;
  const t0 = Date.now();
  for (const [i, c] of starting.entries()) {
    const at = t0 + i * stagger;
    if (at > Date.now()) await sleep(at - Date.now());
    status.note = `starting ${i + 1} of ${starting.length} circles`;
    await startCircle(c);
  }
  // Running circles: people join or leave to match the target size.
  await resize(world.circles.filter((c) => c.active));
  for (const c of world.circles) c.busy = false;
  status.note = '';
}

async function resize(circles) {
  const jobs = [];
  for (const c of circles) {
    const want = wantedSize(c);
    const diff = want - c.members.length;
    if (!diff) continue;
    jobs.push(async () => {
      for (let i = 0; i < Math.abs(diff); i++) {
        status.note = `${diff > 0 ? 'adding people to' : 'removing people from'} “${c.name}”`;
        try {
          if (diff > 0) await addPerson(c);
          else await removePerson(c);
        } catch (e) {
          if (e?.code === 'circle_full') break;
          log(`resizing “${c.name}”: ${e.message}`);
          break;
        }
        if (reconcileAgain) return; // the target changed again; start over
      }
      log(`“${c.name}” now has ${c.members.length} people`);
    });
  }
  // A few circles at a time.
  for (let i = 0; i < jobs.length; i += 4) await Promise.all(jobs.slice(i, i + 4).map((j) => j()));
}

for (const saved of state.circles) await hydrate(saved);
for (const c of world.circles) c.stopped = true;
world.simIds.add(hq.account.memberId);
saveNow();

async function userInvite(circle) {
  const s = circle.saved;
  const next = await circle.owner.run(() => freshInvite(circle.owner.client, s.userInvite));
  if (next !== s.userInvite) {
    s.userInvite = next;
    saveSoon();
  }
  circle.userInvite = s.userInvite;
}

const rampMs = Math.max(0, Number(opt.ramp) || 0) * 60_000;
const startedAt = Date.now();
let phase = 'starting';
metrics.start(() => world.counts());
await metrics.startHomeAssistant({ url: opt['ha-url'], token: opt['ha-token'] });
if (metrics.ha.hint) log(metrics.ha.hint);
if (metrics.ha.status === 'on') log('Home Assistant sensors:', JSON.stringify(metrics.ha.entities));

const dashboard = await startDashboard({
  port: Number(opt.port) || 8090,
  stats: () => ({
    startedAt,
    now: Date.now(),
    phase,
    speed: world.speed,
    scale: opt.scale ?? 'custom',
    mix: {
      busy: status.busy,
      note: status.note,
      maxPeople: MAX_PEOPLE,
      maxCircles: MAX_CIRCLES,
      kinds: KINDS.map((k) => {
        const running = world.circles.filter((c) => c.key === k && c.active);
        const sizes = running.map((c) => c.members.length);
        return {
          key: k,
          label: SCENARIOS[k].label,
          circles: target.circles[k],
          running: running.length,
          paused: world.circles.filter((c) => c.key === k && c.stopped).length,
          people: target.people[k] ?? null,
          minPeople: sizes.length ? Math.min(...sizes) : null,
          maxPeople: sizes.length ? Math.max(...sizes) : null,
          avgPeople: sizes.length ? Math.round((sizes.reduce((a, b) => a + b, 0) / sizes.length) * 10) / 10 : null,
        };
      }),
    },
    server,
    inviteServer,
    csvPath,
    counts: world.counts(),
    totals: metrics.totals,
    lastMinute: metrics.lastMinute(),
    timeline: metrics.timeline,
    ha: metrics.ha,
    phoneInvites,
    hq: { name: hq.circle.name, invite: phoneInvites !== 'none' ? state.hqInvite?.link : undefined, joined: hq.memberList().filter((m) => !world.simIds.has(m.id)).length > 0 },
    circles: world.circles.filter((c) => c.active || !c.stopped).map((c) => ({
      name: c.name,
      label: c.scenario.label,
      where: c.city ? `${c.city.flag} ${c.city.name}` : '',
      active: c.active,
      people: c.members.length,
      online: c.members.filter((m) => m.client.status === 'online').length,
      messages: c.messages,
      invite: phoneInvites === 'all' ? c.userInvite?.link : undefined,
      you: c.userMembers().map((m) => m.name),
    })),
    feed: feedItems.slice(-40).reverse(),
    recentErrors: metrics.recentErrors.slice(-5).reverse(),
    findings: currentFindings(),
    markers: metrics.markers,
    reportPath,
  }),
  report: () => report(analysisCtx()),
  setMix: ({ kind, circles, people }) => {
    if (!KINDS.includes(kind)) return;
    if (circles != null && Number.isFinite(Number(circles))) target.circles[kind] = Number(circles);
    if (people === 'varied') delete target.people[kind];
    else if (people != null && Number.isFinite(Number(people))) target.people[kind] = Number(people);
    clampTarget();
    const t = target.people[kind];
    log(`mix: ${SCENARIOS[kind].label}: ${target.circles[kind]} circle(s), ${t ?? 'varied'} people each`);
    metrics.mark(`${SCENARIOS[kind].label}: ${target.circles[kind]} circle(s) × ${t ?? 'varied'}`);
    reconcile();
  },
  setSpeed: (s) => {
    world.speed = Math.min(500, Math.max(0.1, s));
    log(`speed is now ${world.speed}×`);
    metrics.mark(`speed ${world.speed}×`);
  },
});
log(`dashboard: http://localhost:${dashboard.port}`);

world.start();
hq.on('newMessage', (m) => {
  if (world.simIds.has(m.from) || m.kind !== 'chat') return;
  const text = m.body?.text || '';
  if (/report|finding|learn|wrong|broke|slow/i.test(text)) {
    const top = currentFindings().slice(0, 6);
    const icon = { bad: '🔴', warn: '🟠', info: '🔵', good: '🟢' };
    hq.sendChat(top.length ? top.map((f) => `${icon[f.level]} ${f.title}`).join('\n') : 'Nothing to report yet: give it a few minutes ⏳').catch(() => {});
  } else if (/status|stats|how/i.test(text)) hq.sendChat(summary()).catch(() => {});
});
hq.connect();

const mixText = () =>
  KINDS.filter((k) => target.circles[k])
    .map((k) => `${target.circles[k]} ${SCENARIOS[k].label.toLowerCase()}${target.people[k] != null ? ` × ${target.people[k]}` : ''}`)
    .join(', ');
const analysisCtx = () => ({
  totals: metrics.totals,
  opTotals: metrics.opTotals(),
  timeline: metrics.timeline,
  markers: metrics.markers,
  fanoutAll: metrics.fanoutAll,
  ha: metrics.ha,
  speed: world.speed,
  counts: world.counts(),
  server,
  startedAt,
  mix: mixText(),
  csvPath,
});
let findingsCache = { t: 0, list: [] };
const currentFindings = () => {
  if (Date.now() - findingsCache.t > 10_000) findingsCache = { t: Date.now(), list: findings(analysisCtx()) };
  return findingsCache.list;
};
const writeReport = () => writeFileSync(reportPath, report(analysisCtx()));

function summary() {
  const c = world.counts();
  const m = metrics.lastMinute();
  const v = metrics.ha.values;
  const ha = v.addonCpu != null ? ` · HomeCircle CPU ${v.addonCpu}% · memory ${v.addonMem ?? '?'}%` : '';
  return `📊 ${c.people} people in ${c.circles} circles · ${c.online} with the app open · ${m.perMin} requests/min · p95 ${m.p95 ?? '–'} ms · ${m.errorsPerMin} errors/min${ha} · speed ${world.speed}×`;
}

(async () => {
  phase = 'ramping up';
  const mix = KINDS.map((k) => `${target.circles[k]} ${k}${target.people[k] != null ? ` × ${target.people[k]}` : ''}`).join(', ');
  log(`mix: ${mix}`);
  await reconcile({ rampMs });
  phase = 'running';
  const c = world.counts();
  log(`all ${c.circles} circles running, ${c.people} people`);
  metrics.mark(`everyone online: ${c.people} people`);
  hq.sendChat(`🚀 Swarm running: ${c.people} people in ${c.circles} circles at ${world.speed}× speed`).catch(() => {});
})();

// Housekeeping: status line, HQ summary, fresh invites, short message lists.
const every = (ms, fn) => setInterval(() => Promise.resolve().then(fn).catch(() => {}), ms);
every(30_000, () => {
  const m = metrics.lastMinute();
  const c = world.counts();
  const v = metrics.ha.values;
  log(
    `${c.people} people (${c.online} app open) · ${m.perMin} req/min · p50 ${m.p50 ?? '–'} / p95 ${m.p95 ?? '–'} ms · ` +
      `${m.errorsPerMin} errors, ${m.limitedPerMin} rate-limited` +
      (v.addonCpu != null ? ` · HomeCircle CPU ${v.addonCpu}% mem ${v.addonMem}%` : '') +
      (v.hostCpu != null ? ` · host CPU ${v.hostCpu}%` : ''),
  );
});
every(5 * 60_000, () => phase === 'running' && hq.sendChat(summary()));
every(60_000, async () => {
  if (phoneInvites !== 'none' && !hq.memberList().some((m) => !world.simIds.has(m.id))) await hqInvite();
  if (phoneInvites === 'all') for (const c of world.circles) if (c.active && !c.userMembers().length) await userInvite(c);
});
every(60_000, () => world.circles.forEach((c) => c.members.forEach((m) => m.trim())));
// New problems go to the HQ circle once, so you hear about them on your phone.
const alerted = new Set();
every(60_000, () => {
  for (const f of currentFindings()) {
    if ((f.level !== 'bad' && f.level !== 'warn') || alerted.has(f.id)) continue;
    alerted.add(f.id);
    log(`finding: ${f.title}`);
    hq.sendChat(`${f.level === 'bad' ? '🔴' : '🟠'} ${f.title}${f.action ? `\n→ ${f.action}` : ''}`).catch(() => {});
  }
});
every(5 * 60_000, writeReport);
every(60_000, saveNow);

let stopping = false;
async function stop(why) {
  if (stopping) return;
  stopping = true;
  log(`stopping (${why})…`);
  world.stop();
  hq.disconnect();
  saveNow();
  try {
    writeReport();
  } catch (e) {
    log(`couldn’t write the report: ${e.message}`);
  }
  const t = metrics.totals;
  log(
    `done. ${t.requests} requests, ${t.errors} errors, ${t.rateLimited} rate-limited; ` +
      `${t.messages} messages, ${t.dms} DMs, ${t.reactions} reactions, ${t.locations} locations, ${t.placeEvents} place events, ${t.locates} Locates.`,
  );
  log(`timeline saved to ${csvPath}`);
  log(`findings report: ${reportPath}`);
  process.exit(0);
}
process.on('SIGINT', () => stop('Ctrl+C'));
process.on('SIGTERM', () => stop('terminated'));
const duration = Number(opt.duration) || 0;
if (duration > 0) setTimeout(() => stop(`${duration} minutes`), duration * 60_000);
