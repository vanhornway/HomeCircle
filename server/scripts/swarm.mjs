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
import { SCENARIOS, SCALES } from './swarm/scenarios.mjs';
import { startDashboard } from './swarm/dashboard.mjs';

const HELP = `HomeCircle swarm: simulated people using a HomeCircle server.

  node scripts/swarm.mjs --server <url> --setup-code <code> [options]

  --server <url>         the load-test server, e.g. http://192.168.1.20:8081   (env HC_SERVER)
  --setup-code <code>    its setup code, from the add-on log (first run only)  (env HC_SETUP_CODE)
  --invite-server <url>  address in the invite links for your phone, e.g.
                         https://homecircle.your-tailnet.ts.net:8443         (env HC_INVITE_SERVER)
  --scale <size>         small (5 circles, ~45 people), medium (~10, ~100),
                         large (~24, ~250), xl (~50, ~500). Default small.
  --speed <n>            how many times busier than a normal day. Default 1.
  --ramp <minutes>       bring circles online gradually over this long. Default 5.
  --duration <minutes>   stop after this long. Default: run until Ctrl+C.
  --near <lat,lng>       where the simulated town is. Default 34.05,-118.25.
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
    'invite-server': { type: 'string', default: process.env.HC_INVITE_SERVER },
    scale: { type: 'string', default: 'small' },
    speed: { type: 'string', default: '1' },
    ramp: { type: 'string', default: '5' },
    duration: { type: 'string', default: '0' },
    near: { type: 'string', default: '34.05,-118.25' },
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
if (!SCALES[opt.scale]) {
  console.error(`--scale must be one of: ${Object.keys(SCALES).join(', ')}`);
  process.exit(1);
}

const server = normalizeServerUrl(opt.server);
const inviteServer = opt['invite-server'] ? normalizeServerUrl(opt['invite-server']) : null;
const speed = Math.max(0.1, Number(opt.speed) || 1);
const [nearLat, nearLng] = opt.near.split(',').map(Number);
const near = { lat: nearLat, lng: nearLng };
const alwaysOpenShare = Math.min(1, Math.max(0, Number(opt['always-open']) || 0));
const dataDir = resolve(opt.data);
mkdirSync(dataDir, { recursive: true });
const tag = server.replace(/^https?:\/\//, '').replace(/[^A-Za-z0-9.-]+/g, '_');
const statePath = join(dataDir, `${tag}.json`);
const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
const csvPath = join(dataDir, `${tag}-${stamp}.csv`);

const log = (...a) => console.log(new Date().toLocaleTimeString(), ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- saved state: accounts (keys) and what was built ----------------------

let state = existsSync(statePath) ? JSON.parse(readFileSync(statePath, 'utf8')) : null;
if (state && state.server !== server) state = null;
state ??= { server, created: Date.now(), ipCounter: 2, hq: null, accounts: {}, circles: [] };

let saveTimer = null;
const saveNow = () => {
  clearTimeout(saveTimer);
  saveTimer = null;
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
await hqInvite();

// --- 2. build the circles this scale needs ---------------------------------

const wanted = [];
for (const [key, n] of Object.entries(SCALES[opt.scale])) for (let i = 0; i < n; i++) wanted.push({ key, i });

const takenNames = new Set(state.circles.map((c) => c.spec.circleName));
async function buildCircle(key) {
  const sc = SCENARIOS[key];
  // Distinct names, so you can tell circles apart in the app. Reserved
  // before any await: several circles are built at once.
  let spec = sc.build();
  for (let i = 0; i < 10 && takenNames.has(spec.circleName); i++) spec = sc.build();
  if (takenNames.has(spec.circleName)) {
    let n = 2;
    while (takenNames.has(`${spec.circleName} ${n}`)) n++;
    spec.circleName = `${spec.circleName} ${n}`;
  }
  takenNames.add(spec.circleName);
  const center = offset(near, Math.random() * 12);
  const saved = {
    key,
    spec: { circleName: spec.circleName, homes: !!spec.homes },
    center,
    places: spec.places.map((p) => ({ key: p.key, name: p.name, radius: 150, ...(p.km ? offset(center, p.km) : center) })),
    members: [],
    userInvite: null,
  };
  const people = spec.people.map((p, index) => ({
    ...p,
    index,
    accountKey: `swarm:${Math.random().toString(36).slice(2, 12)}`,
    ip: nextIp(),
    home: spec.homes ? offset(center, 1 + Math.random() * 7) : null,
    work: offset(center, 4 + Math.random() * 11),
    alwaysOpen: index === 0 || Math.random() < alwaysOpenShare,
  }));
  const [first, ...rest] = people;
  const owner = makeClient(first.accountKey, first.ip);
  await patiently(() => owner.createCircle({ serverUrl: server, admin: hq, name: first.name, circleName: spec.circleName }), 'create circle');
  saved.members.push(first);
  for (const p of saved.places) p.id = await owner.savePlace({ name: p.name, lat: p.lat, lng: p.lng, radius: p.radius });
  state.circles.push(saved);
  saveSoon();
  for (const p of rest) {
    const inv = await patiently(() => owner.createInvite({ hours: 1 }), 'invite');
    const c = makeClient(p.accountKey, p.ip);
    await patiently(() => c.joinWithInvite(inv.link, { name: p.name }), 'join');
    metrics.count('joins');
    saved.members.push(p);
    saveSoon();
  }
  log(`built “${spec.circleName}” (${sc.label}, ${saved.members.length} people)`);
  return saved;
}

const byKey = (key) => state.circles.filter((c) => c.key === key);
const plan = [];
const toBuild = [];
for (const w of wanted) {
  const have = byKey(w.key)[w.i];
  if (have) plan.push(have);
  else toBuild.push(w);
}
if (toBuild.length) log(`building ${toBuild.length} circle(s)…`);
// A few circles at a time: realistic sign-up bursts without hammering.
for (let i = 0; i < toBuild.length; i += 3) {
  const built = await Promise.all(toBuild.slice(i, i + 3).map((w) => buildCircle(w.key)));
  plan.push(...built);
}
saveNow();

// --- 3. bring them to life --------------------------------------------------

for (const saved of plan) {
  const members = [];
  const circle = new SimCircle({ world, key: saved.key, spec: saved.spec, center: saved.center, places: saved.places, members, owner: null });
  circle.spec = { ...saved.spec, circleName: saved.spec.circleName };
  for (const p of saved.members) {
    const client = makeClient(p.accountKey, p.ip);
    await client.load();
    const m = new SimMember({ world, circle, person: p, index: p.index, client, ip: p.ip, home: p.home, work: p.work, alwaysOpen: p.alwaysOpen });
    members.push(m);
    world.simIds.add(client.account.memberId);
  }
  circle.owner = members[0];
  circle.saved = saved;
  world.circles.push(circle);
}
world.simIds.add(hq.account.memberId);

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
    scale: opt.scale,
    server,
    inviteServer,
    csvPath,
    counts: world.counts(),
    totals: metrics.totals,
    lastMinute: metrics.lastMinute(),
    timeline: metrics.timeline,
    ha: metrics.ha,
    hq: { name: hq.circle.name, invite: state.hqInvite?.link, joined: hq.memberList().filter((m) => !world.simIds.has(m.id)).length > 0 },
    circles: world.circles.map((c) => ({
      name: c.name,
      label: c.scenario.label,
      active: c.active,
      people: c.members.length,
      online: c.members.filter((m) => m.client.status === 'online').length,
      messages: c.messages,
      invite: c.userInvite?.link,
      you: c.userMembers().map((m) => m.name),
    })),
    feed: feedItems.slice(-40).reverse(),
    recentErrors: metrics.recentErrors.slice(-5).reverse(),
  }),
  setSpeed: (s) => {
    world.speed = Math.min(500, Math.max(0.1, s));
    log(`speed is now ${world.speed}×`);
  },
});
log(`dashboard: http://localhost:${dashboard.port}`);

world.start();
hq.on('newMessage', (m) => {
  if (world.simIds.has(m.from) || m.kind !== 'chat') return;
  if (/status|stats|how/i.test(m.body?.text || '')) hq.sendChat(summary()).catch(() => {});
});
hq.connect();

function summary() {
  const c = world.counts();
  const m = metrics.lastMinute();
  const v = metrics.ha.values;
  const ha = v.addonCpu != null ? ` · HomeCircle CPU ${v.addonCpu}% · memory ${v.addonMem ?? '?'}%` : '';
  return `📊 ${c.people} people in ${c.circles} circles · ${c.online} with the app open · ${m.perMin} requests/min · p95 ${m.p95 ?? '–'} ms · ${m.errorsPerMin} errors/min${ha} · speed ${world.speed}×`;
}

const stagger = world.circles.length > 1 ? rampMs / (world.circles.length - 1) : 0;
(async () => {
  phase = 'ramping up';
  for (const [i, circle] of world.circles.entries()) {
    const at = startedAt + i * stagger;
    if (at > Date.now()) await sleep(at - Date.now());
    await userInvite(circle).catch((e) => log(`invite for ${circle.name} failed: ${e.message}`));
    await Promise.all(
      circle.members.map(async (m, j) => {
        await sleep(Math.random() * Math.min(20_000, 400 * j + 1000));
        await m.boot().catch((e) => log(`${m.name} couldn’t start: ${e.message}`));
      }),
    );
    circle.activate();
    log(`online: “${circle.name}” (${circle.members.length} people)`);
  }
  phase = 'running';
  const c = world.counts();
  log(`all ${c.circles} circles running, ${c.people} people`);
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
  if (!hq.memberList().some((m) => !world.simIds.has(m.id))) await hqInvite();
  for (const c of world.circles) if (c.active && !c.userMembers().length) await userInvite(c);
});
every(60_000, () => world.circles.forEach((c) => c.members.forEach((m) => m.trim())));

let stopping = false;
async function stop(why) {
  if (stopping) return;
  stopping = true;
  log(`stopping (${why})…`);
  world.stop();
  hq.disconnect();
  saveNow();
  const t = metrics.totals;
  log(
    `done. ${t.requests} requests, ${t.errors} errors, ${t.rateLimited} rate-limited; ` +
      `${t.messages} messages, ${t.dms} DMs, ${t.reactions} reactions, ${t.locations} locations, ${t.placeEvents} place events, ${t.locates} Locates.`,
  );
  log(`timeline saved to ${csvPath}`);
  process.exit(0);
}
process.on('SIGINT', () => stop('Ctrl+C'));
process.on('SIGTERM', () => stop('terminated'));
const duration = Number(opt.duration) || 0;
if (duration > 0) setTimeout(() => stop(`${duration} minutes`), duration * 60_000);
