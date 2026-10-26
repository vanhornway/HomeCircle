// Plugins: behind their feature, outside calls only to declared hosts; the
// weather plugin rounds to a grid cell and keeps answers 15 minutes.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createApp } from '../src/index.js';
import { hostFetch } from '../src/plugins/index.js';
import { CircleClient, defaultFeatures } from '../../packages/core/src/index.js';

const SETUP = 'test-setup-token-plugins';
let app;
let url;
let dir;
const asked = [];

// Open-Meteo, Google Pollen and a Home Assistant stand-in: records what each
// was asked, answers like the real ones.
const ha = { registrations: [], hooks: [], gone: new Set(), token: 'ha-long-lived-token' };
const reply = (status, body) => ({ ok: status >= 200 && status < 300, status, text: async () => (body === undefined ? '' : JSON.stringify(body)) });
async function fakeFetch(u, opts = {}) {
  asked.push(u);
  const body = opts.body ? JSON.parse(opts.body) : null;
  if (u.startsWith('https://api.open-meteo.com/')) {
    return reply(200, {
      timezone: 'America/Los_Angeles',
      current: { time: '2026-10-25T16:45', temperature_2m: 18.33, apparent_temperature: 17.9, weather_code: 3, is_day: 1 },
      daily: { temperature_2m_max: [21.7], temperature_2m_min: [9.4], precipitation_probability_max: [10] },
      hourly: { time: ['2026-10-25T17:00', '2026-10-25T18:00'], temperature_2m: [17, 15.5], precipitation_probability: [0, 10], weather_code: [3, 61], is_day: [1, 0] },
    });
  }
  if (u.startsWith('https://air-quality-api.open-meteo.com/')) {
    // Pollen only in Europe (latitude 48 here); null elsewhere, as the real one.
    const europe = /latitude=48/.test(u);
    const none = { alder_pollen: null, birch_pollen: null, olive_pollen: null, grass_pollen: null, mugwort_pollen: null, ragweed_pollen: null };
    const pollen = europe ? { alder_pollen: 0, birch_pollen: 120.4, olive_pollen: 0, grass_pollen: 3.2, mugwort_pollen: 0, ragweed_pollen: 0 } : none;
    return reply(200, { current: { time: '2026-10-25T16:00', us_aqi: 57.4, european_aqi: 31, pm2_5: 12.6, pm10: 18.1, ozone: 61.2, ...pollen }, hourly: { time: ['2026-10-25T17:00', '2026-10-25T18:00'], us_aqi: [55, 61] } });
  }
  if (u.startsWith('https://pollen.googleapis.com/')) {
    if (!/key=good-key/.test(u)) return reply(403, { error: { message: 'API key not valid' } });
    return reply(200, { dailyInfo: [{ pollenTypeInfo: [{ code: 'GRASS', indexInfo: { value: 1 } }, { code: 'TREE', indexInfo: { value: 4 } }, { code: 'WEED', inSeason: false }] }] });
  }
  if (u.startsWith('http://ha.test:8123/')) {
    const path = new URL(u).pathname;
    const authed = opts.headers?.Authorization === `Bearer ${ha.token}`;
    if (path === '/api/') return authed ? reply(200, { message: 'API running.' }) : reply(401);
    if (path === '/api/mobile_app/registrations') {
      if (!authed) return reply(401);
      const webhook_id = `hook${ha.registrations.length + 1}`;
      ha.registrations.push({ ...body, webhook_id });
      return reply(201, { webhook_id, cloudhook_url: null, remote_ui_url: null, secret: null });
    }
    const hook = path.match(/^\/api\/webhook\/(\w+)$/)?.[1];
    if (hook) {
      if (ha.gone.has(hook)) return reply(410);
      ha.hooks.push({ hook, ...body });
      return reply(body.type === 'register_sensor' ? 201 : 200, {});
    }
    return reply(404);
  }
  throw new Error(`fake fetch: unexpected ${u}`);
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
const kid = new CircleClient({ storage: new MemoryStorage() });

test('the server lists its plugins; weather is off in a new circle and refused until an admin turns it on', async () => {
  const info = await (await fetch(`${url}/api/v1/info`)).json();
  assert.deepEqual(info.plugins, ['weather', 'air', 'homeAssistant']);
  await mom.createCircle({ serverUrl: url, setupToken: SETUP, name: 'Mom', circleName: 'Family', features: defaultFeatures() });
  assert.equal(mom.feature('weather'), false);
  await assert.rejects(() => mom.api.weather(37.3382, -121.8863), (e) => e.status === 403 && /Weather is turned off/.test(e.message));
  assert.equal(asked.length, 0);
  await mom.setFeatures({ weather: true });
  assert.equal(mom.feature('weather'), true);
});

test('weather: only a grid cell goes out, the answer is cut to the tile, and it is kept 15 minutes', async () => {
  asked.length = 0;
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

test('air and pollen: a grid cell only; pollen from Open-Meteo in Europe, none elsewhere without a key', async () => {
  await assert.rejects(() => mom.api.air(37.3382, -121.8863), (e) => e.status === 403 && /Air and pollen is turned off/.test(e.message));
  await mom.setFeatures({ air: true });
  asked.length = 0;
  const us = await mom.api.air(37.3382, -121.8863);
  assert.equal(asked.length, 1);
  assert.match(asked[0], /^https:\/\/air-quality-api\.open-meteo\.com\/v1\/air-quality\?latitude=37\.3&longitude=-121\.9&/);
  assert.deepEqual(us.aqi, { us: 57, eu: 31, category: 'Moderate', pm25: 13, pm10: 18, ozone: 61 });
  assert.deepEqual(us.hours[1], { time: '2026-10-25T18:00', aqi: 61 });
  assert.equal(us.pollen, null);
  const eu = await mom.api.air(48.137, 11.575);
  assert.equal(eu.pollen.source, 'Open-Meteo');
  assert.deepEqual(
    eu.pollen.types.map((t) => [t.id, t.level, t.category]),
    [
      ['tree', 4, 'High'],
      ['grass', 2, 'Low'],
      ['weed', 0, 'None'],
    ],
  );
  // Kept for half an hour: no new call.
  await mom.api.air(37.31, -121.94);
  assert.equal(asked.length, 2);
});

test('air and pollen: an admin can add a Google Pollen key; a wrong one is refused and none is ever shown back', async () => {
  const s0 = await mom.api.pluginSettings('air');
  assert.deepEqual(s0.values, { googleKey: { set: false } });
  await assert.rejects(() => mom.api.putPluginSettings('air', { googleKey: 'bad-key' }), (e) => e.status === 400 && /Google didn’t accept that key/.test(e.message));
  const saved = await mom.api.putPluginSettings('air', { googleKey: 'good-key' });
  assert.deepEqual(saved.values, { googleKey: { set: true } });
  assert.doesNotMatch(JSON.stringify(await mom.api.pluginSettings('air')), /good-key/);
  const us = await mom.api.air(37.3382, -121.8863);
  assert.equal(us.pollen.source, 'Google');
  assert.deepEqual(
    us.pollen.types.map((t) => [t.id, t.level, t.category]),
    [
      ['tree', 4, 'High'],
      ['grass', 1, 'Very low'],
      ['weed', 0, 'None'],
    ],
  );
  // Saving again with the key left empty keeps it.
  assert.deepEqual((await mom.api.putPluginSettings('air', { googleKey: '' })).values, { googleKey: { set: true } });
});

test('Home Assistant: only admins set it up, the address and token are checked, and the token is never shown back', async () => {
  await kid.joinWithInvite((await mom.createInvite()).link, { name: 'Maya' });
  await assert.rejects(() => mom.api.pluginSettings('homeAssistant'), (e) => e.status === 403 && /Home Assistant is turned off/.test(e.message));
  await mom.setFeatures({ homeAssistant: true });
  await kid.refresh();
  assert.equal(kid.feature('homeAssistant'), true);
  await assert.rejects(() => kid.api.pluginSettings('homeAssistant'), (e) => e.status === 403);
  // Not set up yet: a phone's position is refused, and nothing reaches Home Assistant.
  await assert.rejects(() => kid.api.homeAssistantLocation({ lat: 37.33, lng: -121.88, name: 'Maya' }), (e) => e.status === 409);
  await assert.rejects(() => mom.api.putPluginSettings('homeAssistant', { url: 'http://ha.test:8123', token: 'wrong' }), (e) => e.status === 400 && /didn’t accept that token/.test(e.message));
  await assert.rejects(() => mom.api.putPluginSettings('homeAssistant', { url: 'ftp://ha.test', token: ha.token }), (e) => e.status === 400);
  const heard = new Promise((r) => kid.on('plugin', r));
  kid.connect();
  await new Promise((r) => setTimeout(r, 150));
  const saved = await mom.api.putPluginSettings('homeAssistant', { url: 'http://ha.test:8123/lovelace/0', token: ha.token });
  assert.deepEqual(saved.values, { url: 'http://ha.test:8123', token: { set: true } });
  // Phones hear about it, so each can send its position straight away.
  assert.equal(await heard, 'homeAssistant');
  kid.disconnect();
  assert.doesNotMatch(JSON.stringify(await mom.api.pluginSettings('homeAssistant')), new RegExp(ha.token));
});

test('Home Assistant: each person becomes a Mobile App device with a battery sensor; positions go straight on', async () => {
  const r = await kid.api.homeAssistantLocation({ lat: 37.3382, lng: -121.8863, accuracy: 12.4, battery: 81, charging: true, speed: 2, name: 'Maya' });
  assert.equal(r.entity, 'device_tracker.homecircle_maya');
  assert.equal(ha.registrations.length, 1);
  const reg = ha.registrations[0];
  assert.equal(reg.device_name, 'HomeCircle Maya');
  assert.equal(reg.app_id, 'homecircle');
  assert.equal(reg.device_id, `homecircle-${kid.account.memberId}`);
  assert.deepEqual(
    ha.hooks.filter((h) => h.type === 'register_sensor').map((h) => h.data.unique_id),
    ['battery_level', 'charging'],
  );
  const loc = ha.hooks.find((h) => h.type === 'update_location');
  assert.deepEqual(loc.data, { gps: [37.3382, -121.8863], gps_accuracy: 12, battery: 81, speed: 2 });
  assert.deepEqual(ha.hooks.at(-1).data, [
    { type: 'sensor', unique_id: 'battery_level', state: 81, icon: 'mdi:battery' },
    { type: 'binary_sensor', unique_id: 'charging', state: true, icon: 'mdi:battery-charging' },
  ]);
  // Next time: the same device, no new registration.
  await kid.api.homeAssistantLocation({ lat: 37.34, lng: -121.88, name: 'Maya' });
  assert.equal(ha.registrations.length, 1);
  // Deleted in Home Assistant: registered again, once.
  ha.gone.add('hook1');
  await kid.api.homeAssistantLocation({ lat: 37.35, lng: -121.88, name: 'Maya' });
  assert.equal(ha.registrations.length, 2);
  assert.equal(ha.hooks.at(-1).hook, 'hook2');
  // Nothing about where anyone is stays on the server.
  const db = new DatabaseSync(join(dir, 'homecircle.db'));
  const kept = JSON.stringify(db.prepare("SELECT v FROM meta WHERE k LIKE 'plugin:%'").all());
  db.close();
  assert.doesNotMatch(kept, /37\.3|121\.8/);
});
