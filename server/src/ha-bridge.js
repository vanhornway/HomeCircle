// HomeCircle Bridge: Home Assistant as a member of a circle.
//
// It runs next to Home Assistant (the "HomeCircle Bridge" app), joins a
// circle with an ordinary invite, and keeps its own keys there, so the
// circle's messages and locations stay end-to-end encrypted: the HomeCircle
// server, wherever it runs, still reads nothing. In the app it shows as a
// device called "Home Assistant", not as a person.
//
// What it does:
// - Trackers in Home Assistant: each tracker in the circle becomes a device
//   of Home Assistant's Mobile App integration (as the Companion app is): a
//   device_tracker that Home Assistant puts in its zones itself, and a
//   battery sensor. People come in through the Home Assistant plugin, each
//   from their own phone, so each can turn it off; this only adds trackers.
// - Home Assistant posts to the chat: fire the event `homecircle_send` with
//   `message` (and `to`, someone's name, for a direct message) from an
//   automation or script, and it's posted as Home Assistant.
// - The chat in Home Assistant: each new message fires `homecircle_message`
//   (from, text, direct), for automations.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { CircleClient } from '../../packages/core/src/index.js';

export const SEND_EVENT = 'homecircle_send';
export const MESSAGE_EVENT = 'homecircle_message';
const APP_ID = 'homecircle_bridge';
const MAX_TEXT = 2000;
const clean = (s, n = 40) =>
  String(s ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .trim()
    .slice(0, n);

/** The bridge's keys and settings, in one JSON file (Home Assistant backs up /data). */
export class FileStorage {
  constructor(path) {
    this.path = path;
    try {
      this.data = JSON.parse(readFileSync(path, 'utf8'));
    } catch {
      this.data = {};
    }
  }
  async getItem(k) {
    return this.data[k] ?? null;
  }
  async setItem(k, v) {
    this.data[k] = v;
    this._write();
  }
  async removeItem(k) {
    delete this.data[k];
    this._write();
  }
  _write() {
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.data), { mode: 0o600 });
    renameSync(tmp, this.path);
  }
}

/** Home Assistant's API, through the Supervisor (or any address and token). */
export class HomeAssistant {
  constructor({ base, token, fetchImpl = fetch, WebSocketImpl = globalThis.WebSocket, log = () => {} }) {
    this.base = base.replace(/\/$/, '');
    this.token = token;
    this.fetch = fetchImpl;
    this.WebSocket = WebSocketImpl;
    this.log = log;
  }

  async post(path, body, { auth = true } = {}) {
    const res = await this.fetch(`${this.base}/api${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(auth ? { Authorization: `Bearer ${this.token}` } : {}) },
      body: JSON.stringify(body),
    });
    let json = null;
    try {
      json = await res.json();
    } catch {}
    return { status: res.status, ok: res.ok, json };
  }

  /** A device for a tracker (Mobile App integration): its webhook id. */
  async registerDevice({ memberId, name, version }) {
    const res = await this.post('/mobile_app/registrations', {
      app_id: APP_ID,
      app_name: 'HomeCircle',
      app_version: String(version || '1'),
      device_name: `HomeCircle ${name}`,
      manufacturer: 'HomeCircle',
      model: 'Tracker',
      os_name: 'HomeCircle',
      os_version: String(version || '1'),
      device_id: `homecircle-${memberId}`,
      supports_encryption: false,
    });
    if (res.status === 404) throw new Error('Home Assistant’s Mobile App integration isn’t loaded (it comes with default_config)');
    if (!res.ok || !res.json?.webhook_id) throw new Error(`Home Assistant answered ${res.status} to registering ${name}`);
    const webhookId = res.json.webhook_id;
    await this.post(
      `/webhook/${webhookId}`,
      { type: 'register_sensor', data: { type: 'sensor', unique_id: 'battery_level', name: 'Battery level', device_class: 'battery', unit_of_measurement: '%', state_class: 'measurement', entity_category: 'diagnostic', icon: 'mdi:battery', state: 0 } },
      { auth: false },
    );
    return webhookId;
  }

  /** Where a tracker is; false if Home Assistant no longer has its device. */
  async updateDevice(webhookId, loc) {
    const res = await this.post(
      `/webhook/${webhookId}`,
      {
        type: 'update_location',
        data: {
          gps: [loc.lat, loc.lng],
          gps_accuracy: Math.max(0, Math.round(loc.accuracy || 0)),
          ...(Number.isFinite(loc.battery) ? { battery: batteryPercent(loc.battery) } : {}),
          ...(Number.isFinite(loc.speed) && loc.speed >= 0 ? { speed: Math.round(loc.speed) } : {}),
        },
      },
      { auth: false },
    );
    if (res.status === 404 || res.status === 410) return false;
    if (!res.ok) throw new Error(`Home Assistant answered ${res.status}`);
    if (Number.isFinite(loc.battery)) {
      await this.post(`/webhook/${webhookId}`, { type: 'update_sensor_states', data: [{ type: 'sensor', unique_id: 'battery_level', state: batteryPercent(loc.battery), icon: 'mdi:battery' }] }, { auth: false });
    }
    return true;
  }

  fireEvent(type, data) {
    return this.post(`/events/${type}`, data);
  }

  /**
   * Listen for an event type over Home Assistant's WebSocket API, connecting
   * again after a drop. Returns a function that stops it.
   */
  listen(eventType, onEvent) {
    let socket = null;
    let stopped = false;
    let wait = 1000;
    // Through the Supervisor it's /core/websocket; Home Assistant itself serves /api/websocket.
    const url = `${this.base.replace(/^http/, 'ws')}${/\/core$/.test(this.base) ? '/websocket' : '/api/websocket'}`;
    const open = () => {
      if (stopped) return;
      socket = new this.WebSocket(url);
      socket.onmessage = (e) => {
        let msg;
        try {
          msg = JSON.parse(typeof e.data === 'string' ? e.data : e.data.toString());
        } catch {
          return;
        }
        if (msg.type === 'auth_required') socket.send(JSON.stringify({ type: 'auth', access_token: this.token }));
        else if (msg.type === 'auth_ok') {
          wait = 1000;
          socket.send(JSON.stringify({ id: 1, type: 'subscribe_events', event_type: eventType }));
          this.log(`listening for ${eventType} in Home Assistant`);
        } else if (msg.type === 'auth_invalid') this.log('Home Assistant didn’t accept the token');
        else if (msg.type === 'event' && msg.event?.event_type === eventType) onEvent(msg.event.data ?? {});
      };
      socket.onclose = () => {
        if (stopped) return;
        setTimeout(open, wait);
        wait = Math.min(wait * 2, 60_000);
      };
      socket.onerror = () => {};
    };
    open();
    return () => {
      stopped = true;
      socket?.close();
    };
  }
}

const batteryPercent = (b) => Math.max(0, Math.min(100, Math.round(b <= 1 ? b * 100 : b)));

/** Joins (once), then keeps Home Assistant and the circle in step. */
export class Bridge {
  constructor({ client, ha, storage, log = () => {}, version = '1', now = () => Date.now() }) {
    this.client = client;
    this.ha = ha;
    this.storage = storage;
    this.log = log;
    this.version = version;
    this.now = now;
    this.sent = new Map(); // memberId -> ts of the position last sent to Home Assistant
    this.devices = {};
    this.offs = [];
  }

  /** Join with an invite if this bridge hasn't joined yet; then start. */
  async start({ invite, name = 'Home Assistant', trackers = true, chat = true } = {}) {
    const c = this.client;
    if (!(await c.load())) {
      if (!invite) throw new Error('Paste an invite link from the HomeCircle app (Invite someone) into the bridge’s settings, then start it again');
      await c.joinWithInvite(invite, { name, device: 'homeassistant' });
      this.log(`joined the circle as ${name}`);
    }
    this.devices = JSON.parse((await this.storage.getItem('ha.devices')) || '{}');
    await c.start();
    this.log(`in “${c.circle.name}” with ${c.memberList().length} members`);
    if (trackers) {
      await c.fetchRecords().catch(() => {});
      this.offs.push(c.on('locations', () => this.syncTrackers().catch((e) => this.log(`trackers: ${e.message}`))));
      await this.syncTrackers().catch((e) => this.log(`trackers: ${e.message}`));
    }
    if (chat) {
      this.offs.push(c.on('newMessage', (m) => this.onMessage(m).catch((e) => this.log(`chat → Home Assistant: ${e.message}`))));
      this.offs.push(this.ha.listen(SEND_EVENT, (data) => this.send(data).catch((e) => this.log(`couldn’t post to the chat: ${e.message}`))));
    }
  }

  stop() {
    for (const off of this.offs) off();
    this.offs = [];
    this.client.disconnect?.();
  }

  /** The circle's trackers with a position newer than what Home Assistant has. */
  async syncTrackers() {
    const c = this.client;
    for (const m of c.memberList()) {
      if (!c.memberRecord(m.id)?.tracker) continue;
      const loc = c.locations.get(m.id);
      if (!loc || this.sent.get(m.id) === loc.ts) continue;
      this.sent.set(m.id, loc.ts);
      let id = this.devices[m.id];
      if (!id) id = await this._register(m);
      if (!(await this.ha.updateDevice(id, loc))) {
        // Deleted in Home Assistant: register it again, once.
        await this.ha.updateDevice(await this._register(m), loc);
      }
    }
  }

  async _register(m) {
    const id = await this.ha.registerDevice({ memberId: m.id, name: m.name, version: this.version });
    this.devices[m.id] = id;
    await this.storage.setItem('ha.devices', JSON.stringify(this.devices));
    this.log(`${m.name} is now a device in Home Assistant`);
    return id;
  }

  /** A new chat message, as a Home Assistant event. */
  async onMessage(m) {
    const text = typeof m.body?.text === 'string' ? m.body.text : '';
    if (!text || m.kind === 'reaction') return;
    const from = this.client.members.get(m.from);
    await this.ha.fireEvent(MESSAGE_EVENT, {
      from: from?.name ?? 'Someone',
      from_id: m.from,
      text: text.slice(0, MAX_TEXT),
      direct: !!m.to,
      at: new Date(m.createdAt ?? this.now()).toISOString(),
    });
  }

  /** Home Assistant's `homecircle_send`: post it to the group, or to someone by name. */
  async send(data) {
    const text = String(data?.message ?? '').trim().slice(0, MAX_TEXT);
    if (!text) throw new Error('the event needs a “message”');
    let to = null;
    if (data.to) {
      const want = clean(data.to).toLowerCase();
      const m = this.client.memberList().find((x) => !x.isMe && x.name.toLowerCase() === want);
      if (!m) throw new Error(`no one called “${clean(data.to)}” in the circle`);
      to = m.id;
    }
    await this.client.sendChat(text, { to });
    this.log(to ? `posted a direct message to ${data.to}` : 'posted to the chat');
  }
}

/** Run as the Home Assistant app: settings from /data/options.json, Home Assistant through the Supervisor. */
async function main() {
  const log = (s) => console.log(`[homecircle-bridge] ${s}`);
  let opts = {};
  try {
    opts = JSON.parse(readFileSync(process.env.OPTIONS || '/data/options.json', 'utf8'));
  } catch {}
  const token = process.env.SUPERVISOR_TOKEN || process.env.HA_TOKEN;
  if (!token) throw new Error('No Home Assistant token: run this as the HomeCircle Bridge app, or set HA_URL and HA_TOKEN');
  const storage = new FileStorage(process.env.BRIDGE_STATE || '/data/bridge/account.json');
  const client = new CircleClient({ storage, onError: (e) => log(`error: ${e?.message ?? e}`) });
  const ha = new HomeAssistant({ base: process.env.HA_URL || 'http://supervisor/core', token, log });
  const version = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
  const bridge = new Bridge({ client, ha, storage, log, version });
  await bridge.start({
    invite: clean(opts.invite_link, 1000) || null,
    name: clean(opts.name) || 'Home Assistant',
    trackers: opts.trackers !== false,
    chat: opts.chat !== false,
  });
  log('running');
  const stop = () => {
    bridge.stop();
    process.exit(0);
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error(`[homecircle-bridge] ${e.message}`);
    process.exit(1);
  });
}
