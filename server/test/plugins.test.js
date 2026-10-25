// Plugins: behind their feature, outside calls only to declared hosts; the
// weather plugin rounds to a grid cell and keeps answers 15 minutes.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/index.js';
import { hostFetch } from '../src/plugins/index.js';
import { CircleClient, defaultFeatures } from '../../packages/core/src/index.js';

const SETUP = 'test-setup-token-plugins';
let app;
let url;
let dir;
const asked = [];

// Open-Meteo stand-in: records what it was asked, answers like the real one.
async function fakeFetch(u) {
  asked.push(u);
  const body = {
    timezone: 'America/Los_Angeles',
    current: { time: '2026-10-25T16:45', temperature_2m: 18.33, apparent_temperature: 17.9, weather_code: 3, is_day: 1 },
    daily: { temperature_2m_max: [21.7], temperature_2m_min: [9.4], precipitation_probability_max: [10] },
    hourly: { time: ['2026-10-25T17:00', '2026-10-25T18:00'], temperature_2m: [17, 15.5], precipitation_probability: [0, 10], weather_code: [3, 61], is_day: [1, 0] },
  };
  return { ok: true, status: 200, text: async () => JSON.stringify(body) };
}

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

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'homecircle-plugins-'));
  app = createApp({
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
    pluginFetch: fakeFetch,
  });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  url = `http://127.0.0.1:${app.server.address().port}`;
});

after(async () => {
  await app.close();
  rmSync(dir, { recursive: true, force: true });
});

const mom = new CircleClient({ storage: new MemoryStorage() });

test('the server lists its plugins; weather is off in a new circle and refused until an admin turns it on', async () => {
  const info = await (await fetch(`${url}/api/v1/info`)).json();
  assert.deepEqual(info.plugins, ['weather']);
  await mom.createCircle({ serverUrl: url, setupToken: SETUP, name: 'Mom', circleName: 'Family', features: defaultFeatures() });
  assert.equal(mom.feature('weather'), false);
  await assert.rejects(() => mom.api.weather(37.3382, -121.8863), (e) => e.status === 403 && /Weather is turned off/.test(e.message));
  assert.equal(asked.length, 0);
  await mom.setFeatures({ weather: true });
  assert.equal(mom.feature('weather'), true);
});

test('weather: only a grid cell goes out, the answer is cut to the tile, and it is kept 15 minutes', async () => {
  const w = await mom.api.weather(37.3382, -121.8863);
  assert.equal(asked.length, 1);
  // The exact position never left the server: 0.1° cells.
  assert.match(asked[0], /^https:\/\/api\.open-meteo\.com\/v1\/forecast\?latitude=37\.3&longitude=-121\.9&/);
  assert.deepEqual(w.cell, { lat: 37.3, lng: -121.9 });
  assert.deepEqual(w.now, { temp: 18.3, feels: 17.9, code: 3, day: true });
  assert.deepEqual(w.today, { high: 21.7, low: 9.4, rain: 10 });
  assert.deepEqual(w.hours[1], { time: '2026-10-25T18:00', temp: 15.5, rain: 10, code: 61, day: false });
  // Someone else in the same town: no new call.
  await mom.api.weather(37.31, -121.94);
  assert.equal(asked.length, 1);
  await assert.rejects(() => mom.api.weather(200, 0), (e) => e.status === 400);
});

test('a plugin can only call the hosts it declared', async () => {
  const f = hostFetch({ id: 'weather', hosts: ['api.open-meteo.com'] }, fakeFetch);
  await assert.rejects(() => f('https://example.com/steal'), /may not call example\.com/);
  await assert.rejects(() => f('http://api.open-meteo.com/v1/forecast'), /may not call/);
  await f('https://api.open-meteo.com/v1/forecast?latitude=1&longitude=2');
});
