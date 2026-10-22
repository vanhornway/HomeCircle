// The simulated people and circles: where they go, when they open the app,
// what they say. Everything runs on a simulated clock (World.simMin) that
// moves --speed times faster than real time, so --speed 10 is a 10× busier day.
import { distanceM, QUICK_REACTIONS, isValidReaction } from '../../../packages/core/src/index.js';
import { SCENARIOS, REPLIES_TO_YOU, DM_LINES, pick } from './scenarios.mjs';

const rand = (a, b) => a + Math.random() * (b - a);
const MOVE_UPLOAD_M = 500; // the app uploads after moving this far…
const HEARTBEAT_MIN = 15; // …or this often
const PLACE_MARGIN_M = 50; // leaving needs this much past the edge, like the app
const REACTIONS = (QUICK_REACTIONS || ['❤️', '👍', '😂', '😮', '🎉']).filter((e) => isValidReaction(e));

/** A point `km` away from `p` in a random direction (±30%). */
export function offset(p, km) {
  const d = km * 1000 * rand(0.7, 1.3);
  const a = Math.random() * 2 * Math.PI;
  return {
    lat: p.lat + (d * Math.cos(a)) / 111_320,
    lng: p.lng + (d * Math.sin(a)) / (111_320 * Math.cos((p.lat * Math.PI) / 180)),
  };
}

export class World {
  constructor({ speed, metrics, feed }) {
    this.speed = speed;
    this.metrics = metrics;
    this.feed = feed;
    this.simMin = 0;
    this.circles = [];
    this.simIds = new Set();
    this.inflight = 0;
    this.maxInflight = 256;
    this.waiting = [];
  }

  /** Real milliseconds for a span of simulated minutes. */
  realMs(simMinutes) {
    return (simMinutes * 60_000) / this.speed;
  }

  later(simMinutes, fn) {
    const t = setTimeout(fn, this.realMs(simMinutes));
    t.unref?.();
  }

  /** Keep the swarm's own machine from melting: cap requests in flight. */
  async run(fn) {
    if (this.inflight >= this.maxInflight) await new Promise((r) => this.waiting.push(r));
    this.inflight++;
    try {
      return await fn();
    } finally {
      this.inflight--;
      this.waiting.shift()?.();
    }
  }

  start() {
    let last = Date.now();
    this.timer = setInterval(() => {
      const now = Date.now();
      const dt = ((now - last) / 60_000) * this.speed;
      last = now;
      this.simMin += dt;
      for (const c of this.circles) if (c.active) c.tick(dt);
    }, 1000);
  }

  stop() {
    clearInterval(this.timer);
    for (const c of this.circles) for (const m of c.members) m.client.disconnect();
  }

  counts() {
    let people = 0;
    let online = 0;
    for (const c of this.circles) {
      if (!c.active) continue;
      people += c.members.length;
      online += c.members.filter((m) => m.client.status === 'online').length;
    }
    return { people, online, circles: this.circles.filter((c) => c.active).length };
  }
}

export class SimCircle {
  constructor({ world, key, spec, center, places, members, owner }) {
    this.world = world;
    this.key = key; // scenario key
    this.scenario = SCENARIOS[key];
    this.spec = spec; // { circleName, people, places, homes }
    this.center = center;
    this.places = places; // [{ key, name, lat, lng, radius, id }]
    this.members = members;
    this.owner = owner;
    this.active = false;
    this.stopped = false; // paused: nobody in it does anything
    this.messages = 0;
    this.userInvite = null;
    this.handled = new Set();
    this.next = {};
  }

  get name() {
    return this.spec.circleName;
  }

  place(key) {
    return this.places.find((p) => p.key === key) || null;
  }

  /** The person outside the swarm (you) in this circle, if you joined. */
  userMembers() {
    return this.owner.client.memberList().filter((m) => !m.removed && !this.world.simIds.has(m.id));
  }

  _schedule(what, every) {
    if (!every) return;
    this.next[what] = this.world.simMin + rand(0.2, 1.8) * every;
  }

  activate() {
    this.active = true;
    this.stopped = false;
    const s = this.scenario;
    this._schedule('thread', s.threadEvery);
    this._schedule('dm', s.dmEvery);
    this._schedule('locate', s.locateEvery);
    this._schedule('checkin', s.checkinEvery);
    this._schedule('placeChurn', 600);
  }

  /** Pause the circle: everyone closes the app and stops moving and talking. */
  deactivate() {
    this.active = false;
    this.stopped = true;
    for (const m of this.members) {
      m.appOpen = false;
      m.client.disconnect();
    }
  }

  tick(dt) {
    const now = this.world.simMin;
    const s = this.scenario;
    for (const m of [...this.members]) m.tick(dt);
    if (this.next.thread <= now) {
      this._schedule('thread', s.threadEvery);
      this.startThread();
    }
    if (this.next.dm <= now) {
      this._schedule('dm', s.dmEvery);
      this.startDm();
    }
    if (this.next.locate <= now) {
      this._schedule('locate', s.locateEvery);
      this.locateSomeone();
    }
    if (this.next.checkin <= now) {
      this._schedule('checkin', s.checkinEvery);
      this.checkInOnSomeone();
    }
    if (this.next.placeChurn <= now) {
      this._schedule('placeChurn', 600);
      this.churnPlace();
    }
  }

  byRole(role, not = null) {
    const all = this.members.filter((m) => m !== not);
    const match = all.filter((m) => m.role === role);
    return pick(match.length ? match : all.length ? all : this.members);
  }

  someoneBut(not) {
    const others = this.members.filter((m) => m !== not);
    return pick(others.length ? others : this.members);
  }

  fill(text, speaker) {
    return text
      .replaceAll('{kid}', () => this.byRole('kid', speaker).name)
      .replaceAll('{parent}', () => this.byRole('parent', speaker).name)
      .replaceAll('{any}', () => this.someoneBut(speaker).name)
      .replaceAll('{place}', () => (this.places.length ? pick(this.places).name : 'the usual place'));
  }

  startThread() {
    const lines = pick(this.scenario.threads);
    let starter = null;
    let prev = null;
    let at = 0;
    for (const [who, text] of lines) {
      let speaker;
      if (who === 'starter') speaker = starter;
      else if (who === 'other' || who === 'any') speaker = this.someoneBut(prev);
      else speaker = this.byRole(who, who === prev?.role ? prev : null);
      starter ??= speaker;
      prev = speaker;
      const line = this.fill(text, speaker);
      const s = speaker;
      this.world.later(at, () => s.say(line));
      at += rand(0.3, 4);
    }
  }

  startDm() {
    if (this.members.length < 2) return;
    const a = pick(this.members);
    const b = this.someoneBut(a);
    let at = 0;
    pick(DM_LINES).forEach((text, i) => {
      const [from, to] = i % 2 ? [b, a] : [a, b];
      this.world.later(at, () => from.say(text, to));
      at += rand(0.5, 6);
    });
  }

  locateSomeone() {
    const asker = this.key === 'family' ? this.byRole('parent') : pick(this.members);
    const target = this.key === 'family' ? this.byRole('kid', asker) : this.someoneBut(asker);
    if (target && target !== asker) asker.locate(target);
  }

  checkInOnSomeone() {
    const asker = this.byRole(this.key === 'elders' ? 'relative' : 'parent');
    const target = this.byRole(this.key === 'elders' ? 'elder' : 'kid', asker);
    if (target && target !== asker) asker.askCheckIn(target);
  }

  churnPlace() {
    const m = pick(this.members);
    const at = offset(this.center, rand(1, 6));
    const name = pick(['New pizza place', 'Dog park', 'Library', 'Pharmacy', 'Farmers market', 'Tennis courts']);
    this.world
      .run(() => m.client.savePlace({ name, lat: at.lat, lng: at.lng, radius: 150 }))
      .then((id) => {
        this.world.feed(this, m.name, `added the place “${name}”`, 'place');
        this.world.later(rand(60, 240), () => this.world.run(() => m.client.deletePlace(id)).catch(() => {}));
      })
      .catch(() => {});
  }

  /** Someone outside the swarm (you) wrote. Answer like a person would. */
  onUserMessage(msg, receiver) {
    if (this.handled.has(msg.id)) return;
    this.handled.add(msg.id);
    const userName = this.owner.client.members.get(msg.from)?.name || 'You';
    const text = msg.body?.text;
    this.world.feed(this, userName, text || (msg.kind === 'event' ? 'shared an update' : '…'), 'you');
    if (msg.kind !== 'chat') return;
    if (msg.to) {
      // A direct message to one of us.
      const me = this.members.find((m) => m.memberId === msg.to) || receiver;
      if (msg.body?.checkin === 'request') {
        setTimeout(() => {
          me.wake();
          me.run(() => me.client.checkIn(msg.from)).then(() => me.metrics.count('checkins'));
        }, rand(3, 15) * 1000);
        setTimeout(() => me.upload('requested', { force: true }), rand(2, 8) * 1000);
        return;
      }
      setTimeout(() => me.say(pick(REPLIES_TO_YOU), { memberId: msg.from }), rand(5, 20) * 1000);
      return;
    }
    const repliers = [...this.members].sort(() => Math.random() - 0.5).slice(0, Math.min(2, this.members.length));
    repliers.forEach((m, i) => setTimeout(() => m.say(pick(REPLIES_TO_YOU)), rand(4, 25) * 1000 + i * 3000));
    const reactor = pick(this.members);
    setTimeout(() => reactor.react(msg.id), rand(2, 6) * 1000);
  }
}

export class SimMember {
  constructor({ world, circle, person, index, client, ip, home, work, alwaysOpen }) {
    this.world = world;
    this.metrics = world.metrics;
    this.circle = circle;
    this.name = person.name;
    this.role = person.role;
    this.travel = person.travel;
    this.index = index;
    this.client = client;
    this.ip = ip;
    this.points = { home, work };
    this.alwaysOpen = alwaysOpen;
    this.battery = rand(0.5, 1);
    this.perm = Math.random() < 0.08 ? 'foreground' : 'always';
    this.inside = new Set();
    this.queue = Promise.resolve();
    this.dead = false;
    this.client.on('newMessage', (m) => this.onMessage(m, true));
    this.client.on('locationRequest', () => setTimeout(() => this.upload('requested', { force: true }), rand(1, 4) * 1000));
    this.client.on('removed', () => (this.dead = true));
  }

  get memberId() {
    return this.client.account?.memberId;
  }

  point(key) {
    const p = this.circle.place(key);
    if (p) return p;
    return this.points[key] || this.points.home;
  }

  /** One thing at a time per phone, and within the swarm's in-flight cap. */
  run(fn) {
    const job = this.queue.then(() => (this.dead || this.circle.stopped ? null : this.world.run(fn)));
    this.queue = job.catch(() => {});
    return job;
  }

  /** Like opening the app for the first time today. */
  async boot() {
    const start = this.circle.scenario.next(this, this.world.simMin);
    const p = this.point(start) || this.points.home;
    this.pos = { lat: p.lat, lng: p.lng };
    this.at = start;
    this.state = 'dwell';
    this.until = this.world.simMin + rand(0, this.circle.scenario.dwell[1]);
    this.appOpen = this.alwaysOpen;
    this.nextToggle = this.world.simMin + rand(...this.circle.scenario.appOpenEvery);
    this.inside = new Set();
    for (const pl of this.circle.places) if (distanceM(this.pos, pl) <= pl.radius) this.inside.add(pl.key);
    await this.run(() => this.client.catchUp());
    if (this.appOpen) this.client.connect();
    await this.upload('update', { force: true });
  }

  /** Leave the circle for good (the circle got smaller). */
  async leave() {
    this.dead = true;
    this.client.disconnect();
    await this.world.run(() => this.client.leave());
    this.world.feed(this.circle, this.name, 'left the circle', 'place');
  }

  tick(dt) {
    if (this.dead || !this.pos) return;
    const now = this.world.simMin;
    const sc = this.circle.scenario;
    // Battery: drains away from home, charges at home.
    const home = this.at === 'home' && this.state === 'dwell';
    this.battery = Math.min(1, Math.max(0.03, this.battery + (dt / 60) * (home ? 0.25 : this.appOpen ? -0.08 : -0.04)));

    if (this.state === 'dwell' && now >= this.until) {
      const next = sc.next(this, now);
      const dest = this.point(next);
      if (next === this.at || !dest || distanceM(this.pos, dest) < 50) {
        this.until = now + rand(...sc.dwell);
      } else {
        this.state = 'travel';
        this.to = next;
        this.dest = dest;
      }
    }
    if (this.state === 'travel') {
      const v = this.travel === 'walk' ? 1.4 : rand(8, 14); // m/s
      const step = v * dt * 60;
      const d = distanceM(this.pos, this.dest);
      if (d <= step) {
        this.pos = { lat: this.dest.lat, lng: this.dest.lng };
        this.state = 'dwell';
        this.at = this.to;
        this.until = now + rand(...sc.dwell);
      } else {
        const f = step / d;
        this.pos = { lat: this.pos.lat + (this.dest.lat - this.pos.lat) * f, lng: this.pos.lng + (this.dest.lng - this.pos.lng) * f };
      }
      this.v = v;
    } else this.v = 0;

    // Places: arrive inside the radius, leave a margin past it.
    let crossed = null;
    for (const pl of this.circle.places) {
      const d = distanceM(this.pos, pl);
      const was = this.inside.has(pl.key);
      if (!was && d <= pl.radius) {
        this.inside.add(pl.key);
        crossed = { pl, action: 'arrived' };
      } else if (was && d > pl.radius + PLACE_MARGIN_M) {
        this.inside.delete(pl.key);
        crossed = { pl, action: 'left' };
      }
      if (crossed && crossed.pl === pl) this.placeEvent(pl, crossed.action);
    }

    if (crossed) this.upload(crossed.action, { force: true });
    else if (!this.lastUp || now - this.lastUp.t >= HEARTBEAT_MIN || (this.state === 'travel' && distanceM(this.lastUp, this.pos) > MOVE_UPLOAD_M)) {
      this.upload('update');
    }

    // Opening and closing the app.
    if (!this.alwaysOpen && now >= this.nextToggle) {
      if (this.appOpen) {
        this.appOpen = false;
        this.client.disconnect();
        this.nextToggle = now + rand(...sc.appOpenEvery);
      } else {
        this.appOpen = true;
        this.nextToggle = now + rand(...sc.appOpenFor);
        this.openApp();
      }
    }
  }

  /** The person picks up the phone to do something: the app opens first. */
  wake() {
    if (this.appOpen || this.dead) return;
    this.appOpen = true;
    this.nextToggle = this.world.simMin + rand(...this.circle.scenario.appOpenFor);
    this.openApp();
  }

  openApp() {
    this.metrics.count('appOpens');
    const before = this.client.lastSeq;
    this.run(async () => {
      await this.client.catchUp();
      if (!this.appOpen || this.dead) return;
      this.client.connect();
      // Messages that came in while the app was closed: read them now.
      for (const m of this.client.messages) if (m.seq > before) this.onMessage(m, false);
    }).catch(() => {});
  }

  upload(trigger, { force = false } = {}) {
    if (this.dead || !this.pos) return Promise.resolve();
    if (this.uploading && !force) return this.uploading;
    const t = this.world.simMin;
    const here = { lat: this.pos.lat + rand(-1, 1) * 0.00008, lng: this.pos.lng + rand(-1, 1) * 0.0001 };
    const placeKey = [...this.inside][0];
    const placeId = placeKey ? this.circle.place(placeKey)?.id ?? null : null;
    this.lastUp = { t, ...this.pos };
    this.uploading = this.run(() =>
      this.client.shareLocation({
        ...here,
        accuracy: Math.round(Math.random() < 0.1 ? rand(40, 90) : rand(6, 25)),
        battery: Math.round(this.battery * 100) / 100,
        charging: this.at === 'home' && this.state === 'dwell',
        speed: this.v || 0,
        trigger,
        placeId,
        power: this.battery < 0.2 ? 'saver' : 'normal',
        perm: this.perm,
        precise: true,
        ts: Date.now(),
      }),
    )
      .then(() => this.metrics.count('locations'))
      .catch(() => {})
      .finally(() => (this.uploading = null));
    return this.uploading;
  }

  placeEvent(pl, action) {
    if (!pl.id) return;
    this.run(() => this.client.sendEvent({ type: 'place', action, placeId: pl.id, placeName: pl.name, at: Date.now() }, { id: randomEventId() }))
      .then(() => {
        this.metrics.count('placeEvents');
        this.world.feed(this.circle, this.name, `${action === 'arrived' ? 'arrived at' : 'left'} ${pl.name}`, 'place');
      })
      .catch(() => {});
  }

  /** Post to the group, or a DM to `to` (a SimMember or { memberId }). */
  say(text, to = null) {
    if (this.dead) return;
    this.wake();
    const toId = to?.memberId ?? null;
    this.run(() => this.client._post('chat', { text, t0: Date.now() }, toId ? { to: toId } : {}))
      .then(() => {
        this.metrics.count(toId ? 'dms' : 'messages');
        this.circle.messages++;
        if (!toId) this.world.feed(this.circle, this.name, text, 'chat');
      })
      .catch(() => {});
  }

  react(messageId) {
    this.run(() => this.client.react(messageId, pick(REACTIONS)))
      .then(() => this.metrics.count('reactions'))
      .catch(() => {});
  }

  locate(target) {
    if (!target.memberId) return;
    this.wake();
    this.run(() => this.client.requestLocations([target.memberId]))
      .then((r) => {
        this.metrics.count('locates');
        this.world.feed(this.circle, this.name, `located ${target.name}`, 'locate');
        // Phones whose app is closed would get a push and answer; the test
        // server sends no pushes, so the swarm plays the push here.
        const how = r?.delivery?.[target.memberId];
        if (how && how !== 'delivered') setTimeout(() => target.upload('requested', { force: true }), rand(2, 8) * 1000);
      })
      .catch(() => {});
  }

  askCheckIn(target) {
    if (!target.memberId) return;
    this.wake();
    this.run(() => this.client.askToCheckIn(target.memberId))
      .then(() => {
        this.metrics.count('checkins');
        this.world.feed(this.circle, this.name, `asked ${target.name} to check in`, 'locate');
        setTimeout(() => target.upload('requested', { force: true }), rand(2, 8) * 1000);
        this.world.later(rand(0.5, 10), () => {
          target.wake();
          target.run(() => target.client.checkIn(this.memberId)).catch(() => {});
        });
      })
      .catch(() => {});
  }

  onMessage(m, live) {
    if (this.dead || m.from === this.memberId) return;
    if (live && typeof m.body?.t0 === 'number') this.metrics.fanoutMs(Date.now() - m.body.t0);
    if (!this.world.simIds.has(m.from)) return this.circle.onUserMessage(m, this);
    if (live && m.kind === 'chat' && !m.to && Math.random() < this.circle.scenario.reactChance) {
      setTimeout(() => this.react(m.id), rand(1, 8) * 1000);
    }
  }

  /** Long runs: keep each phone's message list short, like a real app's memory. */
  trim() {
    const c = this.client;
    if (c.messages.length <= 300) return;
    c.messages = c.messages.slice(-200);
    const keep = new Set(c.messages.map((m) => m.id));
    c.seenMessageIds = keep;
    for (const id of c.reactions.keys()) if (!keep.has(id)) c.reactions.delete(id);
  }
}

let eventCounter = 0;
function randomEventId() {
  return `swarm${Date.now().toString(36)}${(eventCounter++).toString(36)}`.slice(0, 32);
}
