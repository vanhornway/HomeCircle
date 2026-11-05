// Busy times, plans and travel times: worked out on the phone.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/index.js';
import { travelAnswer } from '../src/agent/travel.js';
import { CircleClient, busyDays, busyNow, cleanBusy, cleanPlan, travelStats, tripsFrom } from '../../packages/core/src/index.js';

const MIN = 60_000;
const HOUR = 60 * MIN;

test('busy times keep only a start and an end, and join where they touch', () => {
  const out = cleanBusy([{ s: 10, e: 20, title: 'Oncologist' }, { s: 15, e: 30, location: 'Clinic' }, { s: 40, e: 50 }, { s: 60, e: 55 }, 'nonsense', null]);
  assert.deepEqual(out, [{ s: 10, e: 30 }, { s: 40, e: 50 }]);
});

test('where someone stands now', () => {
  const blocks = cleanBusy([{ s: 100, e: 200 }, { s: 300, e: 400 }]);
  assert.deepEqual(busyNow(blocks, 150), { busy: true, until: 200 });
  assert.deepEqual(busyNow(blocks, 250), { busy: false, until: 300 });
  assert.deepEqual(busyNow(blocks, 500), { busy: false, until: null });
});

test('a day counts as taken when most of it is', () => {
  const nine = new Date(2026, 10, 9, 9).getTime();
  const two = new Date(2026, 10, 10, 9).getTime();
  assert.deepEqual(busyDays([{ s: nine, e: nine + 9 * HOUR }, { s: two, e: two + HOUR }]), ['2026-11-09']);
  // Across midnight, each day counts for itself.
  const late = new Date(2026, 10, 11, 12).getTime();
  assert.deepEqual(busyDays([{ s: late, e: late + 24 * HOUR }]), ['2026-11-11', '2026-11-12']);
});

test('a plan needs a title and a start, and ends after it starts', () => {
  assert.equal(cleanPlan({ title: '', start: 5 }), null);
  assert.equal(cleanPlan({ title: 'Picnic' }), null);
  assert.deepEqual(cleanPlan({ title: ' Picnic\n', start: 1000, end: 500, where: 'Lake' }), { title: 'Picnic', start: 1000, end: 1000 + HOUR, allDay: false, where: 'Lake' });
});

// --- trips

const event = (id, from, action, placeName, at) => ({ id, kind: 'event', from, ts: at, body: { type: 'place', action, placeId: placeName, placeName, at } });
// Mondays through Fridays of two weeks, leaving Home a little after 7:30.
const schoolRun = (durations) => {
  const out = [];
  durations.forEach((mins, i) => {
    const left = new Date(2026, 10, 2 + i + (i >= 5 ? 2 : 0), 7, 30 + i).getTime();
    out.push(event(`l${i}`, 'nyel', 'left', 'Home', left), event(`a${i}`, 'nyel', 'arrived', 'EVHS', left + mins * MIN));
  });
  return out;
};

test('trips pair a departure with an arrival somewhere else', () => {
  const t = 1_800_000_000_000;
  const trips = tripsFrom([
    event('1', 'zara', 'left', 'Home', t),
    event('2', 'zara', 'arrived', 'Gym', t + 20 * MIN),
    // Too long apart to be one trip.
    event('3', 'zara', 'left', 'Gym', t + 60 * MIN),
    event('4', 'zara', 'arrived', 'Home', t + 5 * HOUR),
    // Walking along the edge isn't a trip.
    event('5', 'zara', 'left', 'Home', t + 6 * HOUR),
    event('6', 'zara', 'arrived', 'Home', t + 6 * HOUR + MIN),
  ]);
  assert.deepEqual(trips, [{ memberId: 'zara', from: 'Home', to: 'Gym', left: t, arrived: t + 20 * MIN }]);
});

test('the usual trip: how long, when, and whether it has changed', () => {
  const trips = tripsFrom(schoolRun([17, 16, 18, 17, 19, 22, 23]));
  const now = new Date(2026, 10, 11, 12).getTime();
  const [r] = travelStats(trips, { now });
  assert.equal(r.n, 7);
  assert.equal(r.mins, 18);
  assert.deepEqual([r.low, r.high], [16, 23]);
  assert.equal(r.days, 'weekdays');
  assert.equal(r.leaves, 7 * 60 + 33);
  assert.ok(r.trend >= 3, `trend ${r.trend}`);
});

test('two trips are not a habit', () => {
  assert.deepEqual(travelStats(tripsFrom(schoolRun([17, 16]))), []);
});

test('the helper answers from what the phone worked out, without any AI', () => {
  const routes = [
    { who: 'Nyel', from: 'Home', to: 'EVHS', n: 12, mins: 17, low: 13, high: 22, leaves: 455, arrives: 472, days: 'weekdays', trend: 4 },
    { who: 'Zara', from: 'Home', to: 'Gym', n: 4, mins: 20, low: 20, high: 20, leaves: 1020, arrives: 1040, days: 'all', trend: 0 },
  ];
  assert.equal(
    travelAnswer('How long does it take Nyel to get to EVHS in the morning?', routes, 'Sam'),
    '🚗 Nyel usually takes 17 min from Home to EVHS (12 trips, 13 to 22 min, on weekdays). Leaves around 7:35 am, gets there around 7:52 am. This past week it’s been about 4 min longer.',
  );
  assert.equal(travelAnswer('how long is my drive to the gym', routes, 'Zara'), '🚗 Zara usually takes 20 min from Home to Gym (4 trips). Leaves around 5:00 pm, gets there around 5:20 pm.');
  assert.equal(travelAnswer('how long to get to Paris', routes, 'Sam'), null);
});

// --- over the server

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

let app, url, dir, sam, zara;
const SETUP = 'schedule-test-setup-code';
const client = () => new CircleClient({ storage: new MemoryStorage() });
const until = async (fn, ms = 3000) => {
  const t = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t > ms) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 20));
  }
};

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'hc-schedule-'));
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
    webClient: false,
  });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  url = `http://127.0.0.1:${app.server.address().port}`;
  sam = client();
  await sam.createCircle({ serverUrl: url, setupToken: SETUP, name: 'Sam', circleName: 'Parkers' });
  zara = client();
  await zara.joinWithInvite((await sam.createInvite()).link, { name: 'Zara' });
  await sam.start();
  await zara.start();
});

after(async () => {
  sam.disconnect();
  zara.disconnect();
  await app.close();
  rmSync(dir, { recursive: true, force: true });
});

test('busy times reach the circle sealed, and can be taken back', async () => {
  const now = Date.now();
  await zara.shareBusy([{ s: now, e: now + HOUR, title: 'Never sent' }]);
  const seen = await until(async () => (await sam.fetchBusy()).get(zara.account.memberId));
  assert.deepEqual(seen.blocks, [{ s: now, e: now + HOUR }]);
  // What the server holds is ciphertext: no time or title in it.
  const raw = JSON.stringify(await sam.api.busy());
  assert.doesNotMatch(raw, /Never sent/);
  assert.ok(!raw.includes(String(now)));
  await zara.clearBusy();
  await until(async () => !(await sam.fetchBusy()).has(zara.account.memberId));
});

test('a plan: answers from everyone, and cancelled only by whoever made it', async () => {
  const start = Date.now() + 24 * HOUR;
  const id = await sam.createPlan({ title: 'Picnic', start, where: 'Lake' });
  await until(() => zara.planState(id));
  await zara.answerPlan(id, 'going');
  await sam.answerPlan(id, 'maybe');
  const s = await until(() => {
    const p = sam.planState(id);
    return p?.answers.length === 2 ? p : null;
  });
  assert.equal(s.title, 'Picnic');
  assert.equal(s.mine, 'maybe');
  assert.deepEqual(s.answers.find((a) => a.memberId === zara.account.memberId).answer, 'going');
  await zara.answerPlan(id, 'no');
  await until(() => sam.planState(id).answers.some((a) => a.memberId === zara.account.memberId && a.answer === 'no'));
  await assert.rejects(zara.cancelPlan(id), /Only whoever made/);
  await sam.cancelPlan(id);
  await until(() => zara.planState(id).cancelled);
  await assert.rejects(zara.answerPlan(id, 'going'), /cancelled/);
});
