// One visitor's copy of the demo family: twenty real clients, each with its
// own keys, in a circle of their own. A copy is built ahead of time and waits
// quietly; when its visitor joins, the day starts. Everyone stays end-to-end
// encrypted like any circle. Only the visitor's own words are read, and only
// so someone can answer.
import { readFileSync } from 'node:fs';
import WebSocket from 'ws';
import { CircleClient } from '../../packages/core/src/index.js';
import { CIRCLE_NAME, FEATURES, HELPER, HOME_BASE, OWNER, PEOPLE, PLACES, PRESSES, PRESS_TEXT, TIME_ZONE, TRACKERS, TRIPS, routeKey } from './family.mjs';
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
    this.trackers = {};
    this.homeBase = null;
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
    await this._buildTrackers();
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

  // --- trackers ----------------------------------------------------------
  // A home base and its Meshtastic trackers, simulated: each tracker is a
  // member the home base keeps, as a real one is, and posts where its person
  // is, as having come over the radio. No hardware, no radio.

  async _buildTrackers() {
    const owner = this.owner;
    const hb = this._client();
    await hb.joinWithInvite((await owner.createInvite({ hours: 1 })).link, { name: HOME_BASE.name });
    this.homeBase = hb;
    for (const [key, spec] of Object.entries(TRACKERS)) {
      const c = this._client();
      await c.joinWithInvite((await owner.createInvite({ hours: 1 })).link, { name: spec.name });
      await c.api.req('PUT', '/members/me/keeper', { keeper: hb.account.memberId });
      const p = this.people[spec.follows];
      this.trackers[key] = { key, spec, client: c, battery: spec.battery, lat: p.lat, lng: p.lng, nextShare: 0, journey: null };
    }
    await owner.refresh();
    for (const t of Object.values(this.trackers)) {
      const carriedBy = t.spec.mode === 'carried' ? this.people[t.spec.follows].client.account.memberId : null;
      await owner.setMemberRecord(t.client.account.memberId, {
        tracker: { mode: t.spec.mode, moving: 2, still: 15, quiet: null, sos: false, node: t.spec.node, carriedBy, custom: null },
      });
    }
    await this._homeBaseStatus();
    await owner.pinHomeBase(this.placeIds.home);
    for (const t of Object.values(this.trackers)) {
      await t.client.refresh();
      await this._shareTracker(t);
    }
  }

  /** What a home base says about itself and its trackers (in the member record about it). */
  async _homeBaseStatus() {
    const now = Date.now();
    const trackers = Object.values(this.trackers).map((t, i) => ({
      node: t.spec.node,
      member: t.client.account.memberId,
      at: t.sharedAt ?? null,
      radio: { at: now - 40_000 * (i + 1), hops: i === 1 ? 0 : 1, snr: [4.5, 9.25, -6.75][i] ?? 2, battery: Math.round(t.battery * 100) },
      settings: 'set',
      log: [],
    }));
    await this.owner.setMemberRecord(this.homeBase.account.memberId, {
      homeBase: {
        at: now,
        every: 60,
        self: { battery: null, volts: 5.1, plugged: true, wifi: -57, up: 3 * 86400, heap: 142, ch: 6, tx: 1 },
        gps: { fix: true, sats: 9, hdop: 1.1 },
        fw: '0.29.0',
        heard: [],
        trackers,
        node: HOME_BASE.node,
      },
    });
  }

  /** A tracker where its person is (a car parks a few metres off), as it came over the radio. */
  _shareTracker(t) {
    const p = this.people[t.spec.follows];
    const off = t.spec.mode === 'car' && !p.trip ? 0.00012 : 0;
    t.lat = p.lat + off;
    t.lng = p.lng + off;
    t.sharedAt = Date.now();
    const c = t.client;
    const body = {
      lat: t.lat,
      lng: t.lng,
      accuracy: 5,
      battery: t.battery,
      charging: false,
      trigger: 'update',
      app: 'meshtastic',
      via: 'radio',
      mesh: { hops: t.spec.mode === 'car' ? 0 : 1, src: 'radio' },
      skin: 'tracker',
      tz: TIME_ZONE,
    };
    return c.api.putLocation(c._seal('location', body));
  }

  _tickTrackers(now) {
    for (const t of Object.values(this.trackers)) {
      const p = this.people[t.spec.follows];
      if (now < t.nextShare) continue;
      // Every few seconds of the hour on the road, every few minutes standing still.
      t.nextShare = now + ((p.trip ? MOVING_EVERY * 2 : STILL_EVERY) * 1000) / Math.max(1, this.scale / (p.trip ? 2 : 1));
      t.battery = Math.max(0.05, t.battery - 0.002);
      this._shareTracker(t).catch((e) => this.log(`tracker: ${e.message}`));
    }
    if (now - (this.statusAt ?? 0) > 60_000) {
      this.statusAt = now;
      this._homeBaseStatus().catch((e) => this.log(`home base: ${e.message}`));
    }
  }

  /** The car leaves Home: it's on the move until it's back. */
  _carJourney(trip) {
    for (const t of Object.values(this.trackers)) {
      if (!t.spec.journeys || !trip.who.includes(t.spec.follows)) continue;
      if (trip.from === 'home' && !t.journey) {
        t.journey = 'starting';
        this.owner
          .startJourney(t.client.account.memberId)
          .then((j) => (t.journey = j.id))
          .catch((e) => {
            t.journey = null;
            this.log(`journey: ${e.message}`);
          });
      } else if (trip.to === 'home' && t.journey && t.journey !== 'starting') {
        // A phone in the circle ends it once it sees the car home; an older app won't, so the director does too.
        const id = t.journey;
        t.journey = null;
        setTimeout(() => this.owner.endJourney(id, { reason: 'home' }).catch(() => {}), ((trip.mins * 60_000) / this.scale) + 5000);
      }
    }
  }

  _press(key, n) {
    const t = this.trackers[key];
    return t ? t.client.sendChat(PRESS_TEXT[n]) : null;
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
    this.script = [...CHAT, ...PRESSES.map(([at, key, n]) => [at, 'press', key, n])].sort((a, b) => a[0] - b[0]);
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
    for (const t of Object.values(this.trackers)) {
      t.conn = t.client.api.connect({ onEvent: () => {} });
      t.nextShare = 0;
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
    for (const t of Object.values(this.trackers)) {
      t.conn?.close();
      t.conn = null;
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
    this._tickTrackers(now);
  }

  _depart(trip) {
    this._carJourney(trip);
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
    if (action === 'press') {
      if (this.running) Promise.resolve(this._press(who, args[0])).catch((e) => this.log(`press: ${e.message}`));
      return;
    }
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
