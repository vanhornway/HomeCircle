// One visitor's copy of the demo family: twenty real clients, each with its
// own keys, in a circle of their own. A copy is built ahead of time and waits
// quietly; when its visitor joins, the day starts. Everyone stays end-to-end
// encrypted like any circle. Only the visitor's own words are read, and only
// so someone can answer.
import { readFileSync } from 'node:fs';
import WebSocket from 'ws';
import { CircleClient } from '../../packages/core/src/index.js';
import { CIRCLE_NAME, FEATURES, HELPER, OWNER, PEOPLE, PLACES, TIME_ZONE, TRIPS, routeKey } from './family.mjs';
import { CHAT, DINNER_POLL, FALLBACK, HISTORY, OLD_POLL, REPLIES } from './script.mjs';
import { LISTS, RECIPES, notes, reminders } from './content.mjs';

const ROUTES = JSON.parse(readFileSync(new URL('./routes.json', import.meta.url), 'utf8'));
const APP = '0.23.0';
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
// How often someone on the road shares, and someone sitting still (seconds).
const MOVING_EVERY = 7;
const STILL_EVERY = 240;
// At most one group answer to the visitor in this long, so a stream of messages doesn't get a stream back.
const GROUP_REPLY_GAP_MS = 15_000;

const memoryStore = () => {
  const m = new Map();
  return {
    getItem: async (k) => m.get(k) ?? null,
    setItem: async (k, v) => void m.set(k, v),
    removeItem: async (k) => void m.delete(k),
  };
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pick = (list) => list[Math.floor(Math.random() * list.length)];
const metres = ([a, b], [c, d]) => Math.hypot((a - c) * 111_320, (b - d) * 111_320 * Math.cos((a * Math.PI) / 180));

/** Where a route is, `f` of the way along it by distance. */
function along(route, f) {
  const legs = route.slice(1).map((p, i) => metres(route[i], p));
  let left = f * legs.reduce((t, d) => t + d, 0);
  for (let i = 0; i < legs.length; i++) {
    if (left <= legs[i]) {
      const s = legs[i] ? left / legs[i] : 0;
      return [route[i][0] + (route[i + 1][0] - route[i][0]) * s, route[i][1] + (route[i + 1][1] - route[i][1]) * s];
    }
    left -= legs[i];
  }
  return route.at(-1);
}

export class Copy {
  /**
   * `pace` makes the day go faster for testing; `ai` is the AI provider for
   * the helper ({ provider, model, apiKey }, or null for none); `budgetUsd`
   * caps what it may spend on this copy.
   */
  constructor({ server, token, minutes = 60, pace = 1, ai = null, budgetUsd = 0.25, log = () => {} }) {
    this.server = server;
    this.token = token;
    this.scale = (60 / minutes) * pace;
    this.ai = ai;
    this.budgetUsd = budgetUsd;
    this.log = log;
    this.people = {};
    this.placeIds = {};
    this.circleId = null;
    this.visitorId = null;
    this.running = false;
    this.lastGroupReply = 0;
    this.pollId = null;
    this.callback = null;
  }

  get owner() {
    return this.people[OWNER].client;
  }

  _client() {
    const { token } = this;
    const fetchImpl = (url, init = {}) => fetch(url, { ...init, headers: { ...init.headers, 'x-demo-token': token } });
    class DirectorSocket extends WebSocket {
      constructor(url) {
        super(url, { headers: { 'x-demo-token': token } });
      }
    }
    return new CircleClient({ storage: memoryStore(), fetchImpl, WebSocketImpl: DirectorSocket, onError: (e) => this.log(`client: ${e?.message ?? e}`) });
  }

  // --- building ----------------------------------------------------------

  /** Make the circle and everything in it. Returns the visitor's invite link. */
  async build() {
    for (const [key, spec] of Object.entries(PEOPLE)) {
      const place = PLACES[spec.at];
      this.people[key] = { key, spec, client: this._client(), lat: place.lat, lng: place.lng, placeKey: spec.at, battery: spec.battery, charging: false, trip: null, nextShare: 0 };
    }
    const owner = this.owner;
    await owner.createCircle({ serverUrl: this.server, setupToken: 'director', name: PEOPLE[OWNER].name, circleName: CIRCLE_NAME, features: FEATURES });
    this.circleId = owner.circleId;
    for (const p of Object.values(this.people)) {
      if (p.key === OWNER) continue;
      const { link } = await owner.createInvite({ hours: 1 });
      await p.client.joinWithInvite(link, { name: p.spec.name });
      await sleep(0); // others share this process
    }
    await owner.refresh();
    for (const [key, place] of Object.entries(PLACES)) {
      this.placeIds[key] = await owner.savePlace({ name: place.name, lat: place.lat, lng: place.lng, radius: place.radius ?? 150, icon: place.icon });
    }
    for (const p of Object.values(this.people)) {
      await p.client.refresh();
      p.placeId = this.placeIds[p.placeKey];
      await this._share(p);
      await sleep(0);
    }
    const nani = Object.values(this.people).find((p) => p.spec.elder);
    await owner.markElder(nani.client.account.memberId, { page: 'care' });
    await this._history();
    // The helper answers on the live connection; the owner only needs one while building.
    owner.connect();
    try {
      await this._seedHelper();
      await this._frequentPlaces();
    } finally {
      owner.disconnect();
    }
    const { link } = await owner.createInvite({ hours: 48 });
    return link;
  }

  async _history() {
    const now = Date.now();
    for (const [hoursAgo, who, text] of HISTORY) {
      const c = this.people[who].client;
      c.sealTime = () => now - hoursAgo * HOUR;
      await c.sendChat(text);
      c.sealTime = null;
    }
    // A poll that finished yesterday.
    const owner = this.owner;
    owner.sealTime = () => now - 20 * HOUR;
    await owner.createPoll({ question: OLD_POLL.question, options: OLD_POLL.options, allowAdd: false });
    owner.sealTime = null;
    const id = owner.messages.filter((m) => m.body?.poll).at(-1).id;
    const options = owner.pollState(id).options;
    for (const [who, choice] of OLD_POLL.votes) {
      const c = this.people[who].client;
      await c.fetchMessages();
      await c.vote(id, [options[choice].id]);
    }
    await owner.fetchMessages();
    await owner.closePoll(id);
  }

  async _seedHelper() {
    const owner = this.owner;
    await owner.setUpAgent({ name: HELPER });
    await owner.agentRpc('setSettings', { budgetUsd: this.budgetUsd, ...(this.ai ? { provider: this.ai, test: false } : {}) });
    const add = (note) => owner.agentRpc('add', { note });
    for (const p of Object.values(this.people)) {
      const age = Number(p.spec.note.match(/ is (\d+)/)?.[1] ?? 40);
      await add({ type: 'person', title: p.spec.name, body: p.spec.note, people: [p.spec.name], tags: ['family'], data: { role: age < 18 ? 'kid' : 'adult' } });
    }
    for (const note of [...RECIPES, ...notes()]) await add(note);
    for (const list of LISTS) {
      await owner.agentRpc('listCreate', { name: list.name });
      const id = (await owner.agentRpc('lists')).find((l) => l.name === list.name).id;
      // Six shops, two weeks apart, oldest first.
      for (let shop = 0; shop < 6; shop++) {
        const items = list.usual
          .filter(([, , often]) => (shop * often) % 6 < often || shop >= 6 - often)
          .map(([name, price]) => ({ name, price: Math.round(price * (1 + ((shop % 3) - 1) * 0.03) * 100) / 100 }));
        await owner.agentRpc('demoBought', { listId: id, items, currency: 'USD', at: Date.now() - (6 - shop) * 14 * DAY });
      }
      await owner.agentRpc('itemAdd', { listId: id, names: list.today });
    }
    for (const r of reminders()) await owner.agentRpc('reminderAdd', r);
  }

  async _frequentPlaces() {
    const now = Date.now();
    const entry = (id, place, kind, visits, hours) => ({ id, name: PLACES[place].name, kind, lat: PLACES[place].lat, lng: PLACES[place].lng, visits, hours, lastAt: now });
    const usual = { home: ['home', 'home', 30, 410], office: ['office', 'work', 20, 172], clinic: ['clinic', 'work', 20, 168], maple: ['maple', 'school', 18, 6], alder: ['alder', 'school', 20, 140], park: ['park', 'park', 6, 9], costco: ['costco', 'other', 4, 3] };
    const sets = { maya: ['home', 'clinic', 'maple', 'costco'], omar: ['home', 'office', 'alder'], zara: ['home', 'alder', 'park'], dada: ['home', 'park'] };
    for (const [who, places] of Object.entries(sets)) {
      await this.people[who].client.shareFrequent(places.map((k) => entry(k, ...usual[k])));
    }
  }

  // --- the day -----------------------------------------------------------

  /** The visitor joined: everyone comes online and the day begins. */
  async run(visitorId) {
    this.visitorId = visitorId;
    await this.owner.refresh();
    this.visitorName = this.owner.members.get(visitorId)?.name || 'friend';
    this.script = [...CHAT].sort((a, b) => a[0] - b[0]);
    this.trips = [...TRIPS].sort((a, b) => a.at - b.at);
    this.startedAt = Date.now();
    this.running = true;
    for (const p of Object.values(this.people)) {
      p.conn = p.client.api.connect({ onEvent: (e) => this._hear(p, e).catch((err) => this.log(`hear: ${err.message}`)) });
      p.nextStill = Date.now() + Math.random() * STILL_EVERY * 1000;
      // Fresh on the map as the visitor arrives.
      this._share(p).catch(() => {});
      await sleep(30);
    }
    this.timer = setInterval(() => this._tick().catch((e) => this.log(`tick: ${e.message}`)), 1000);
  }

  stop() {
    this.running = false;
    clearInterval(this.timer);
    for (const p of Object.values(this.people)) {
      p.conn?.close();
      p.conn = null;
      p.client.disconnect();
    }
  }

  /** The minute of the day-in-an-hour it is now. */
  get minute() {
    return ((Date.now() - this.startedAt) / 60_000) * this.scale;
  }

  async _tick() {
    if (!this.running) return;
    const now = Date.now();
    const minute = this.minute;
    while (this.script.length && this.script[0][0] <= minute) this._act(this.script.shift());
    while (this.trips.length && this.trips[0].at <= minute) this._depart(this.trips.shift());
    for (const p of Object.values(this.people)) {
      if (p.trip) this._drive(p, minute, now);
      else if (now >= p.nextStill) {
        p.nextStill = now + (STILL_EVERY * 1000) / Math.max(1, this.scale);
        p.battery = Math.max(0.03, p.battery - 0.01);
        this._share(p).catch(() => {});
      }
    }
  }

  _depart(trip) {
    for (const key of trip.who) {
      const p = this.people[key];
      const from = p.placeKey;
      p.trip = { ...trip, route: ROUTES[routeKey(trip.from, trip.to)] };
      p.placeKey = null;
      p.placeId = null;
      p.nextShare = 0;
      if (from) this._placeEvent(p, 'left', from);
    }
  }

  _drive(p, minute, now) {
    const f = (minute - p.trip.at) / p.trip.mins;
    if (f >= 1) {
      const to = p.trip.to;
      const place = PLACES[to];
      Object.assign(p, { trip: null, lat: place.lat, lng: place.lng, placeKey: to, placeId: this.placeIds[to], nextStill: now + (STILL_EVERY * 1000) / Math.max(1, this.scale) });
      this._share(p, { trigger: 'geofence' }).catch(() => {});
      this._placeEvent(p, 'arrived', to);
    } else if (now >= p.nextShare) {
      p.nextShare = now + (MOVING_EVERY * 1000 + Math.random() * 1000) / Math.max(1, this.scale / 2);
      [p.lat, p.lng] = along(p.trip.route, f);
      this._share(p, { speed: p.trip.speed }).catch(() => {});
    }
  }

  _placeEvent(p, action, place) {
    p.client
      .sendEvent({ type: 'place', action, placeId: this.placeIds[place], placeName: PLACES[place].name, at: Date.now() })
      .catch((e) => this.log(`place: ${e.message}`));
  }

  _share(p, { trigger = 'update', speed = null, forceTrigger } = {}) {
    const { spec } = p;
    const jitter = () => (Math.random() - 0.5) * 0.00006;
    const elder = spec.elder ? { skin: 'elderly', page: 'care', used: Date.now() } : {};
    return p.client.shareLocation({
      lat: p.lat + jitter(),
      lng: p.lng + jitter(),
      accuracy: 6 + Math.random() * 10,
      battery: p.battery,
      charging: p.charging,
      speed,
      trigger: forceTrigger ?? trigger,
      placeId: p.placeId ?? null,
      power: spec.power ?? 'normal',
      perm: spec.perm ?? 'always',
      precise: true,
      app: APP,
      tz: TIME_ZONE,
      ...elder,
    });
  }

  _text(text, p) {
    const place = p?.placeKey ? PLACES[p.placeKey].name : 'on the road';
    return text.replaceAll('{you}', this.visitorName).replaceAll('{place}', place);
  }

  /** Someone who hasn't heard of the visitor yet looks them up first (they need their key to write). */
  async _knowVisitor(c) {
    if (!c.members.has(this.visitorId)) await c.refresh();
  }

  _act([, action, who, ...args]) {
    const run = async () => {
      if (!this.running) return;
      const p = who ? this.people[who] : null;
      const c = p?.client;
      switch (action) {
        case 'say':
          return c.sendChat(this._text(args[0], p));
        case 'dm':
          await this._knowVisitor(c);
          return c.sendChat(this._text(args[0], p), { to: this.visitorId });
        case 'checkin':
          await this._knowVisitor(c);
          return c.askToCheckIn(this.visitorId);
        case 'callback': {
          // Everyone at first; later, the visitor alone.
          if (args[0]) await this._knowVisitor(c);
          const id = await c.askCallback({ to: args[0] ? this.visitorId : null, tz: TIME_ZONE });
          this.callback = id;
          return id;
        }
        case 'callbackReply':
          await c.fetchMessages();
          return this.callback ? c.replyCallback(this.callback, args[0]) : null;
        case 'poll':
          await c.createPoll({ question: DINNER_POLL.question, options: DINNER_POLL.options });
          this.pollId = c.messages.filter((m) => m.body?.poll).at(-1).id;
          return null;
        case 'vote': {
          await c.fetchMessages();
          const options = c.pollState(this.pollId)?.options ?? [];
          return options[args[0]] ? c.vote(this.pollId, [options[args[0]].id]) : null;
        }
        case 'closePoll':
          await c.fetchMessages();
          return c.closePoll(this.pollId);
        case 'battery':
          [p.battery, p.charging] = args;
          return this._share(p, { forceTrigger: !p.charging ? 'low_battery' : 'update' });
        case 'chirp':
          await this._knowVisitor(c);
          return c.chirp(this.visitorId);
        case 'helper':
          // Only with an AI behind it: otherwise there's nothing to show.
          return this.ai ? this.owner.askAgent(args[0]) : null;
        case 'listAdd':
        case 'listTick':
          return this._listStep(action, c, args);
        default:
          return null;
      }
    };
    run().catch((e) => this.log(`${action}: ${e.message}`));
  }

  async _listStep(action, c, [name, items]) {
    // Asked of the helper over a short-lived live connection.
    c.connect();
    try {
      const list = (await c.agentRpc('lists')).find((l) => l.name === name);
      if (action === 'listAdd') await c.agentRpc('itemAdd', { listId: list.id, names: items });
      else {
        for (const item of list.items.filter((i) => items.includes(i.name))) {
          await c.agentRpc('itemTick', { listId: list.id, itemId: item.id, ticked: true });
        }
      }
    } finally {
      c.connection?.close();
      c.connection = null;
    }
  }

  // --- hearing the visitor ------------------------------------------------

  /**
   * Each person's socket. Nobody opens what isn't for them: a person hears
   * direct messages, the owner also hears the group, and locations aren't
   * opened at all, which keeps twenty people cheap to run.
   */
  async _hear(p, e) {
    if (!this.running) return;
    if (e.type === 'location_request') {
      setTimeout(() => this.running && this._share(p, { trigger: 'requested' }).catch(() => {}), 1500 + Math.random() * 2500);
      return;
    }
    if (e.type !== 'message' || e.message.from !== this.visitorId) return;
    const direct = e.message.to === p.client.account.memberId;
    if (!direct && !(e.message.to == null && p.key === OWNER)) return;
    await this._knowVisitor(p.client);
    const m = p.client._addMessage(e.message);
    if (m && m.kind === 'chat') this._answer(p, m, direct);
  }

  _answer(p, m, direct) {
    const body = m.body ?? {};
    const later = (ms, fn) => setTimeout(() => this.running && fn().catch((e) => this.log(`answer: ${e.message}`)), ms);
    // Blue ticks a moment later.
    later(2000 + Math.random() * 3000, () => p.client.sendReadReceipt(direct ? m.from : null, m.seq));
    if (body.checkin === 'request') return later(4000, () => p.client.checkIn(m.from));
    if (body.checkin === 'ok') return later(3000, () => p.client.sendChat('Thanks! Just making sure 😊', { to: m.from }));
    // Nani hears the visitor answered her.
    if (body.callback) {
      const nani = Object.values(this.people).find((x) => x.spec.elder);
      if (body.callback.state === 'reply') later(4000, () => nani.client.sendChat(this._text('Thank you beta {you} ❤️', nani), { to: this.visitorId }));
      return undefined;
    }
    const text = String(body.text ?? '');
    // A question for the helper is the helper's to answer.
    if (!text || text.startsWith('/') || body.agentAdded) return undefined;
    if (direct) return this._reply(p, text, m.from);
    if (Date.now() - this.lastGroupReply < GROUP_REPLY_GAP_MS) return undefined;
    this.lastGroupReply = Date.now();
    const someone = pick(Object.values(this.people).filter((x) => !x.spec.elder));
    return this._reply(someone, text, null);
  }

  _reply(p, text, to) {
    const tone = p.spec.tone;
    const lines = REPLIES.find((r) => r.match.test(text))?.[tone] ?? FALLBACK[tone];
    const line = this._text(pick(lines), p);
    const answer = async () => {
      await this._knowVisitor(p.client);
      await p.client.sendChat(line, { to });
    };
    setTimeout(() => this.running && answer().catch((e) => this.log(`reply: ${e.message}`)), 2500 + Math.random() * 4000);
  }

  /** Delete this copy on the server (a half-built one, or a leftover). */
  async remove() {
    this.stop();
    await this.owner.deleteCircle().catch(() => {});
  }
}
