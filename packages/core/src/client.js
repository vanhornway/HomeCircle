// CircleClient: everything a HomeCircle app needs on top of the raw API —
// keys, trust, decrypting members/locations/messages/places, invites and
// key rotation. Used by the web client, the mobile app and the tests.
import { Api, ApiError } from './api.js';
import {
  seal,
  open,
  openProfile,
  generateIdentity,
  newCircleKey,
  randomId,
  newInviteSecret,
  deriveInvite,
  inviteAuthHash,
  wrapInvite,
  unwrapInvite,
  boxCircleKey,
  openCircleKeyBox,
  safetyNumber,
  normalizeServerUrl,
  parseInviteLink,
  inviteLink,
  appInviteLink,
} from './crypto.js';
import { isValidReaction } from './emoji.js';

// Storage key for the account. A device in several circles keeps one
// CircleClient per circle, each with its own key (see `accountKey`).
export const ACCOUNT_KEY = 'homecircle.account';
export const MEMBER_COLORS = ['#2f7d6d', '#d9644a', '#4a6fd9', '#b0479c', '#c79a1e', '#3c8fb5', '#7a5bd6', '#5d8a2e'];
const randomColor = () => MEMBER_COLORS[Math.floor(Math.random() * MEMBER_COLORS.length)];

export class CircleClient {
  /**
   * @param {object} opts
   * @param {{getItem(k:string):Promise<string|null>, setItem(k:string,v:string):Promise<void>, removeItem(k:string):Promise<void>}} opts.storage
   * @param {string} [opts.accountKey] where this circle's account is stored
   */
  constructor({ storage, accountKey = ACCOUNT_KEY, fetchImpl, WebSocketImpl, onError = () => {} }) {
    this.storage = storage;
    this.accountKey = accountKey;
    this.fetchImpl = fetchImpl;
    this.WebSocketImpl = WebSocketImpl;
    this.onError = onError;
    this.listeners = new Map();
    this._reset();
  }

  _reset() {
    this.account = null;
    this.api = null;
    this.state = null;
    this.circle = { name: 'HomeCircle' };
    this.members = new Map();
    this.locations = new Map();
    this.messages = [];
    this.seenMessageIds = new Set();
    // messageId -> emoji -> memberId -> { on, seq }
    this.reactions = new Map();
    this.places = new Map();
    this.lastSeq = 0;
    this.connection = null;
    this.status = 'offline';
  }

  // --- events ------------------------------------------------------------

  on(event, fn) {
    if (!this.listeners.has(event)) this.listeners.set(event, new Set());
    this.listeners.get(event).add(fn);
    return () => this.listeners.get(event).delete(fn);
  }

  emit(event, data) {
    for (const fn of this.listeners.get(event) || []) {
      try {
        fn(data);
      } catch (e) {
        this.onError(e);
      }
    }
  }

  // --- account -----------------------------------------------------------

  get me() {
    return this.account ? this.members.get(this.account.memberId) : null;
  }

  get isAdmin() {
    const role = this.me?.role;
    return role === 'owner' || role === 'admin';
  }

  get serverUrl() {
    return this.account?.server;
  }

  get circleId() {
    return this.account?.circleId ?? null;
  }

  /** Whether this device's member can create more circles on this server. */
  get isServerAdmin() {
    return !!this.state?.serverAdmin;
  }

  _makeApi(server, token = null) {
    return new Api(server, { token, fetchImpl: this.fetchImpl, WebSocketImpl: this.WebSocketImpl });
  }

  async load() {
    const raw = await this.storage.getItem(this.accountKey);
    if (!raw) return false;
    this.account = JSON.parse(raw);
    this.api = this._makeApi(this.account.server, this.account.token);
    return true;
  }

  async _save() {
    await this.storage.setItem(this.accountKey, JSON.stringify(this.account));
  }

  /** Forget this device's keys locally. */
  async signOut() {
    this.disconnect();
    await this.storage.removeItem(this.accountKey);
    this._reset();
    this.emit('signedOut');
  }

  /**
   * Point this device at a new address for the same server (e.g. a new
   * domain). Only accepted if that server hosts our circle.
   */
  async changeServer(serverUrl) {
    const info = await this.verifyServer(serverUrl);
    this.disconnect();
    this.account.server = info.server;
    this.api = this._makeApi(info.server, this.account.token);
    await this._save();
    return info;
  }

  /** Check that an address reaches the server holding this circle, without switching. */
  async verifyServer(serverUrl) {
    const info = await CircleClient.serverInfo(serverUrl, this.fetchImpl);
    if (!info.setup) throw new Error('That server hasn’t been set up, so your circle isn’t on it.');
    // Ask the new address who we are: only the server that holds our circle
    // knows this device's token.
    const st = await this._makeApi(info.server, this.account.token)
      .state()
      .catch((e) => {
        if (e instanceof ApiError && e.status === 401) return null;
        throw e;
      });
    if (st?.circleId !== this.account.circleId || st?.me !== this.account.memberId) {
      throw new Error('That server hosts a different circle. Your circle’s data isn’t there.');
    }
    return { ...info, circleId: st.circleId };
  }

  static async serverInfo(serverUrl, fetchImpl) {
    const server = normalizeServerUrl(serverUrl);
    const info = await new Api(server, { fetchImpl }).info();
    if (info?.app !== 'homecircle') throw new Error("That address isn't a HomeCircle server");
    return { server, ...info };
  }

  _seal(kind, body, epoch = this.account.epoch) {
    const a = this.account;
    return seal({
      kind,
      from: a.memberId,
      circle: a.circleId,
      epoch,
      key: a.keyring[epoch],
      signSecret: a.identity.signSecret,
      body,
    });
  }

  _profileBody() {
    const a = this.account;
    return { name: a.profile.name, color: a.profile.color, boxPub: a.identity.boxPub, signPub: a.identity.signPub };
  }

  /**
   * Create a circle. The first circle on a new server needs the server's
   * `setupToken`. Later circles on the same server are created by a server
   * admin: pass `admin`, a CircleClient already in a circle on that server.
   */
  async createCircle({ serverUrl, setupToken, admin, name, circleName }) {
    const server = normalizeServerUrl(serverUrl);
    const identity = generateIdentity();
    const memberId = randomId();
    const circleId = randomId();
    const epoch = 1;
    this.account = {
      server,
      token: null,
      memberId,
      circleId,
      identity,
      epoch,
      keyring: { [epoch]: newCircleKey() },
      profile: { name: cleanName(name), color: randomColor() },
      known: {},
    };
    try {
      const body = {
        circleId,
        epoch,
        member: {
          id: memberId,
          boxPub: identity.boxPub,
          signPub: identity.signPub,
          profile: this._seal('profile', this._profileBody()),
        },
        circle: this._seal('circle', { name: cleanName(circleName) || 'Our Circle' }),
      };
      const res = admin
        ? await this._makeApi(server, admin.account.token).createCircle(body)
        : await this._makeApi(server).setup({ setupToken: String(setupToken || '').trim(), ...body });
      this.account.token = res.token;
    } catch (e) {
      this.account = null;
      throw e;
    }
    this.api = this._makeApi(server, this.account.token);
    await this._save();
    await this.refresh();
  }

  /** Decrypts the invite so the UI can show "Join <circle> invited by <name>?" */
  async previewInvite(link) {
    const { serverUrl, inviteId, secret } = parseInviteLink(link);
    const { inviteAuth, wrapKey } = deriveInvite(secret);
    const api = this._makeApi(serverUrl);
    const res = await api.joinPreview({ inviteId, inviteAuth });
    const payload = unwrapInvite(wrapKey, res.wrapped);
    return { serverUrl, inviteId, inviteAuth, payload, circleId: payload.circle, circleName: payload.circleName, invitedBy: payload.invitedByName };
  }

  async joinWithInvite(link, { name }) {
    const preview = await this.previewInvite(link);
    const { serverUrl, inviteId, inviteAuth, payload } = preview;
    const identity = generateIdentity();
    const memberId = randomId();
    this.account = {
      server: serverUrl,
      token: null,
      memberId,
      circleId: payload.circle,
      identity,
      epoch: payload.epoch,
      keyring: { [payload.epoch]: payload.circleKey },
      profile: { name: cleanName(name), color: randomColor() },
      known: {},
    };
    try {
      const res = await this._makeApi(serverUrl).join({
        inviteId,
        inviteAuth,
        member: {
          id: memberId,
          boxPub: identity.boxPub,
          signPub: identity.signPub,
          profile: this._seal('profile', this._profileBody()),
        },
      });
      this.account.token = res.token;
    } catch (e) {
      this.account = null;
      throw e;
    }
    this.api = this._makeApi(serverUrl, this.account.token);
    await this._save();
    await this.refresh();
  }

  // --- state -------------------------------------------------------------

  /** Fetches members/keys/circle info, verifies everything, rotates keys if needed. */
  async refresh() {
    const st = await this.api.state();
    this.state = st;
    if (st.epoch > this.account.epoch || !this.account.keyring[st.epoch]) await this._syncKeys(st);
    this._decodeMembers(st);
    this._decodeCircle(st);

    const mine = st.members.find((m) => m.id === this.account.memberId);
    if (mine && mine.profile.epoch < st.epoch && this.account.keyring[st.epoch]) {
      await this.api.putProfile(this._seal('profile', this._profileBody()));
    }
    await this._save();
    this.emit('members', this.memberList());
    this.emit('circle', this.circle);

    if (st.rotationNeeded && this.isAdmin) {
      try {
        await this.rotateKey();
      } catch (e) {
        if (!(e instanceof ApiError && e.code === 'stale_epoch')) this.onError(e);
      }
    }
    return st;
  }

  async _syncKeys(st) {
    const { envelopes } = await this.api.envelopes(this.account.epoch);
    for (const env of envelopes.sort((a, b) => a.epoch - b.epoch)) {
      if (this.account.keyring[env.epoch]) continue;
      const sender = st.members.find((m) => m.id === env.from);
      const pinned = this.account.known[env.from];
      // The sender must be an admin whose keys we verified before the rotation.
      if (!sender || !['owner', 'admin'].includes(sender.role) || !pinned) {
        this.onError(new Error(`Ignoring key from unverified member ${env.from}`));
        continue;
      }
      try {
        this.account.keyring[env.epoch] = openCircleKeyBox(env, {
          fromBoxPub: pinned.boxPub,
          myBoxSecret: this.account.identity.boxSecret,
          epoch: env.epoch,
          circle: this.account.circleId,
        });
        this.account.epoch = Math.max(this.account.epoch, env.epoch);
      } catch (e) {
        this.onError(e);
      }
    }
  }

  _decodeMembers(st) {
    const known = this.account.known;
    this.members = new Map();
    for (const m of st.members) {
      const view = {
        id: m.id,
        role: m.role,
        removed: !!m.removed,
        joinedAt: m.joinedAt,
        lastSeenAt: m.lastSeenAt,
        isMe: m.id === this.account.memberId,
        name: 'Unverified member',
        color: '#8a8f98',
        verified: false,
        current: false,
        keyChanged: false,
        safetyNumber: safetyNumber(m.signPub, m.boxPub),
      };
      const pinned = known[m.id];
      if (pinned && (pinned.signPub !== m.signPub || pinned.boxPub !== m.boxPub)) {
        // The server is claiming different keys for someone we already verified.
        view.keyChanged = true;
        view.name = pinned.name;
        this.members.set(m.id, view);
        continue;
      }
      const key = this.account.keyring[m.profile.epoch];
      if (key) {
        try {
          const p = openProfile(m.profile, {
            key,
            circle: this.account.circleId,
            memberId: m.id,
            boxPub: m.boxPub,
            signPub: m.signPub,
          });
          view.name = cleanName(p.body.name) || 'Member';
          view.color = MEMBER_COLORS.includes(p.body.color) ? p.body.color : MEMBER_COLORS[0];
          view.verified = true;
          view.current = m.profile.epoch === st.epoch;
          known[m.id] = { signPub: m.signPub, boxPub: m.boxPub, name: view.name };
        } catch (e) {
          this.onError(e);
        }
      } else if (pinned) {
        view.name = pinned.name;
        view.verified = true;
      }
      this.members.set(m.id, view);
    }
  }

  _decodeCircle(st) {
    if (!st.circle) return;
    const env = st.circle.env;
    const signPub = this.account.known[st.circle.by]?.signPub;
    const key = this.account.keyring[env.epoch];
    if (!signPub || !key) return;
    try {
      const msg = open(env, { key, signPub, kind: 'circle', from: st.circle.by, circle: this.account.circleId });
      this.circle = { name: cleanName(msg.body.name) || 'Our Circle' };
    } catch (e) {
      this.onError(e);
    }
  }

  memberList() {
    return [...this.members.values()]
      .filter((m) => !m.removed)
      .sort((a, b) => (a.isMe ? -1 : b.isMe ? 1 : a.name.localeCompare(b.name)));
  }

  /** Open any envelope from a member, using their pinned signing key. */
  _open(env, from, kinds) {
    const signPub = this.account.known[from]?.signPub;
    const key = this.account.keyring[env.epoch];
    if (!signPub || !key) return null;
    try {
      const msg = open(env, { key, signPub, from, circle: this.account.circleId });
      if (!kinds.includes(msg.kind)) return null;
      return msg;
    } catch (e) {
      this.onError(e);
      return null;
    }
  }

  /** Retry a write once after picking up a rotated key. */
  async _withEpochRetry(fn) {
    try {
      return await fn();
    } catch (e) {
      if (e instanceof ApiError && e.code === 'stale_epoch') {
        await this.refresh();
        return fn();
      }
      throw e;
    }
  }

  // --- locations ---------------------------------------------------------

  _decodeLocation(memberId, env, updatedAt) {
    const msg = this._open(env, memberId, ['location']);
    if (!msg) return null;
    const b = msg.body;
    if (typeof b.lat !== 'number' || typeof b.lng !== 'number') return null;
    const loc = {
      lat: b.lat,
      lng: b.lng,
      accuracy: num(b.accuracy),
      battery: num(b.battery),
      charging: !!b.charging,
      speed: num(b.speed),
      trigger: typeof b.trigger === 'string' ? b.trigger : 'update',
      placeId: typeof b.placeId === 'string' ? b.placeId : null,
      ts: msg.ts,
      receivedAt: updatedAt,
    };
    const prev = this.locations.get(memberId);
    if (prev && prev.ts > loc.ts) return prev;
    this.locations.set(memberId, loc);
    return loc;
  }

  async fetchLocations() {
    const { locations } = await this.api.locations();
    for (const l of locations) this._decodeLocation(l.memberId, l.env, l.updatedAt);
    this.emit('locations', this.locations);
    return this.locations;
  }

  /** Upload this device's location, encrypted. */
  async shareLocation({ lat, lng, accuracy, battery, charging, speed, trigger = 'update', placeId = null, ts }) {
    const body = { lat, lng, accuracy, battery, charging, speed, trigger, placeId };
    await this._withEpochRetry(() => {
      const env = this._seal('location', body);
      return this.api.putLocation(env);
    });
    this.locations.set(this.account.memberId, { ...body, ts: ts || Date.now(), receivedAt: Date.now() });
    this.emit('locations', this.locations);
  }

  /** Remove this device's location from the circle (stop sharing with it). */
  async clearLocation() {
    await this.api.deleteLocation();
    this.locations.delete(this.account.memberId);
    this.emit('locations', this.locations);
  }

  /** Ask phones for a fresh location. `targets` omitted = everyone. */
  requestLocations(targets) {
    return this.api.requestLocations(targets);
  }

  // --- messages ----------------------------------------------------------

  _addMessage(m) {
    if (this.seenMessageIds.has(m.id)) return false;
    this.seenMessageIds.add(m.id);
    this.lastSeq = Math.max(this.lastSeq, m.seq);
    const msg = this._open(m.env, m.from, ['chat', 'event', 'reaction']);
    if (msg?.kind === 'reaction') {
      this._applyReaction(m.from, m.seq, msg.body);
      return { kind: 'reaction', id: m.id, from: m.from, seq: m.seq, body: msg.body };
    }
    const entry = {
      seq: m.seq,
      id: m.id,
      from: m.from,
      createdAt: m.createdAt,
      kind: msg?.kind || 'unreadable',
      ts: msg?.ts || m.createdAt,
      body: msg?.body || null,
    };
    this.messages.push(entry);
    this.messages.sort((a, b) => a.seq - b.seq);
    return entry;
  }

  _applyReaction(from, seq, body) {
    if (!body || typeof body.target !== 'string' || !isValidReaction(body.emoji)) return;
    let byEmoji = this.reactions.get(body.target);
    if (!byEmoji) this.reactions.set(body.target, (byEmoji = new Map()));
    let byMember = byEmoji.get(body.emoji);
    if (!byMember) byEmoji.set(body.emoji, (byMember = new Map()));
    const prev = byMember.get(from);
    // Reactions can arrive out of order (live vs. fetched); the latest wins.
    if (prev && prev.seq > seq) return;
    byMember.set(from, { on: body.on !== false, seq });
  }

  /** [{ emoji, count, mine, names }] for a message, most popular first. */
  reactionsFor(messageId) {
    const byEmoji = this.reactions.get(messageId);
    if (!byEmoji) return [];
    const out = [];
    for (const [emoji, byMember] of byEmoji) {
      const ids = [...byMember].filter(([, r]) => r.on).map(([id]) => id);
      if (!ids.length) continue;
      out.push({
        emoji,
        count: ids.length,
        mine: ids.includes(this.account?.memberId),
        names: ids.map((id) => this.members.get(id)?.name || 'Former member'),
        first: Math.min(...ids.map((id) => byMember.get(id).seq)),
      });
    }
    return out.sort((a, b) => b.count - a.count || a.first - b.first).map(({ first, ...r }) => r);
  }

  /** Add or remove this person's reaction. Doesn't trigger a notification. */
  react(messageId, emoji) {
    if (!isValidReaction(emoji)) return Promise.reject(new Error('Not a reaction emoji'));
    const mine = this.reactions.get(messageId)?.get(emoji)?.get(this.account.memberId);
    return this._post('reaction', { target: messageId, emoji, on: !mine?.on }, { silent: true });
  }

  async fetchMessages() {
    for (;;) {
      const { messages } = await this.api.messages(this.lastSeq, 500);
      for (const m of messages) this._addMessage(m);
      if (messages.length < 500) break;
    }
    this.emit('messages', this.messages);
    return this.messages;
  }

  async _post(kind, body, { silent = false } = {}) {
    const id = randomId(12);
    let env;
    const res = await this._withEpochRetry(() => {
      env = this._seal(kind, body);
      return this.api.postMessage(id, env, { silent });
    });
    this._addMessage({ seq: res.seq, id, from: this.account.memberId, createdAt: res.createdAt, env });
    this.emit('messages', this.messages);
  }

  sendChat(text) {
    const t = String(text || '').trim().slice(0, 4000);
    if (!t) return Promise.resolve();
    return this._post('chat', { text: t });
  }

  /** e.g. { type: 'place', action: 'arrived' | 'left', placeId, placeName } */
  sendEvent(body) {
    return this._post('event', body);
  }

  // --- places ------------------------------------------------------------

  _decodePlace(p) {
    const msg = this._open(p.env, p.updatedBy, ['place']);
    if (!msg || msg.body.id !== p.id) return null;
    const b = msg.body;
    const place = {
      id: p.id,
      name: cleanName(b.name) || 'Place',
      lat: b.lat,
      lng: b.lng,
      radius: Math.min(5000, Math.max(50, num(b.radius) || 150)),
      icon: typeof b.icon === 'string' ? b.icon.slice(0, 16) : 'pin',
      updatedBy: p.updatedBy,
    };
    this.places.set(p.id, place);
    return place;
  }

  async fetchPlaces() {
    const { places } = await this.api.places();
    this.places = new Map();
    for (const p of places) this._decodePlace(p);
    this.emit('places', this.places);
    return this.places;
  }

  async savePlace({ id = randomId(9), name, lat, lng, radius = 150, icon = 'pin' }) {
    const body = { id, name: cleanName(name), lat, lng, radius, icon };
    await this._withEpochRetry(() => this.api.putPlace(id, this._seal('place', body)));
    this.places.set(id, { ...body, updatedBy: this.account.memberId });
    this.emit('places', this.places);
    return id;
  }

  async deletePlace(id) {
    await this.api.deletePlace(id);
    this.places.delete(id);
    this.emit('places', this.places);
  }

  // --- membership --------------------------------------------------------

  async createInvite({ hours = 48 } = {}) {
    const secret = newInviteSecret();
    const { inviteAuth, wrapKey } = deriveInvite(secret);
    const id = randomId(9);
    const a = this.account;
    const wrapped = wrapInvite(wrapKey, {
      circleKey: a.keyring[a.epoch],
      epoch: a.epoch,
      circle: a.circleId,
      circleName: this.circle.name,
      invitedByName: this.me?.name || '',
    });
    const res = await this.api.createInvite({ id, authHash: inviteAuthHash(inviteAuth), wrapped, epoch: a.epoch, hours });
    return {
      id,
      expiresAt: res.expiresAt,
      link: inviteLink(a.server, id, secret),
      appLink: appInviteLink(a.server, id, secret),
    };
  }

  async setName(name) {
    this.account.profile.name = cleanName(name);
    await this.api.putProfile(this._seal('profile', this._profileBody()));
    await this._save();
    await this.refresh();
  }

  async setCircleName(name) {
    await this.api.putCircle(this._seal('circle', { name: cleanName(name) }));
    await this.refresh();
  }

  async removeMember(id) {
    await this.api.removeMember(id);
    await this.refresh(); // rotates the key if we're an admin
  }

  setRole(id, role) {
    return this.api.setRole(id, role).then(() => this.refresh());
  }

  async leave() {
    await this.api.removeMember(this.account.memberId);
    await this.signOut();
  }

  /** Owner only: delete this circle and everything in it, for everyone. */
  async deleteCircle() {
    await this.api.deleteCircle();
    await this.signOut();
  }

  /** New circle key for everyone still in the circle. Admin only. */
  async rotateKey() {
    const a = this.account;
    const st = this.state;
    const epoch = st.epoch + 1;
    const key = newCircleKey();
    const envelopes = {};
    for (const m of st.members) {
      if (m.removed) continue;
      // Prefer keys we verified; fall back to what the server lists for
      // members whose profile we couldn't check (see docs/PROTOCOL.md).
      const boxPub = a.known[m.id]?.boxPub || m.boxPub;
      envelopes[m.id] = boxCircleKey({ circleKey: key, epoch, circle: a.circleId, toBoxPub: boxPub, fromBoxSecret: a.identity.boxSecret });
    }
    await this.api.rotate({ epoch, envelopes });
    a.keyring[epoch] = key;
    a.epoch = epoch;
    await this._save();
    // Re-seal shared data so people who join later can read it.
    await this.api.putProfile(this._seal('profile', this._profileBody()));
    await this.api.putCircle(this._seal('circle', { name: this.circle.name }));
    for (const p of this.places.size ? this.places.values() : (await this.fetchPlaces()).values()) {
      const { updatedBy, ...body } = p;
      await this.api.putPlace(p.id, this._seal('place', body));
    }
    await this.refresh();
  }

  // --- live connection ---------------------------------------------------

  /** Load everything and keep it live while the app is in the foreground. */
  async start() {
    await this.refresh();
    await Promise.all([this.fetchLocations(), this.fetchMessages(), this.fetchPlaces()]);
    this.connect();
  }

  connect() {
    if (this.connection) return;
    let connectedBefore = false;
    this.connection = this.api.connect({
      onStatus: (s) => {
        this.status = s;
        this.emit('status', s);
        if (s === 'unauthorized') this._handleRemoved();
        if (s === 'online') {
          // Anything sent while we were disconnected never reached us live.
          if (connectedBefore) this.catchUp().catch(this.onError);
          connectedBefore = true;
        }
      },
      onEvent: (e) => this._onEvent(e).catch(this.onError),
    });
  }

  /** Fetch whatever changed while the live connection was down. */
  async catchUp() {
    await this.refresh();
    await Promise.all([this.fetchMessages(), this.fetchLocations(), this.fetchPlaces()]);
  }

  disconnect() {
    if (this.connection) this.connection.close();
    this.connection = null;
    if (this.status !== 'offline') {
      this.status = 'offline';
      this.emit('status', 'offline');
    }
  }

  async _handleRemoved() {
    this.emit('removed');
    await this.signOut();
  }

  async _onEvent(e) {
    switch (e.type) {
      case 'location': {
        const loc = this._decodeLocation(e.memberId, e.env, e.updatedAt);
        if (loc) this.emit('locations', this.locations);
        break;
      }
      case 'message': {
        const m = this._addMessage(e.message);
        if (m) {
          this.emit('messages', this.messages);
          if (m.from !== this.account.memberId && m.kind !== 'reaction') this.emit('newMessage', m);
        }
        break;
      }
      case 'location_deleted':
        if (this.locations.delete(e.memberId)) this.emit('locations', this.locations);
        break;
      case 'location_request':
        this.emit('locationRequest', { from: e.from });
        break;
      case 'place':
        if (this._decodePlace(e.place)) this.emit('places', this.places);
        break;
      case 'place_deleted':
        this.places.delete(e.id);
        this.emit('places', this.places);
        break;
      case 'removed':
        if (e.memberId === this.account.memberId) return this._handleRemoved();
        this.locations.delete(e.memberId);
        await this.refresh();
        break;
      case 'circle_deleted':
        return this._handleRemoved();
      case 'members_changed':
      case 'key_rotated':
      case 'circle':
        await this.refresh();
        break;
      default:
        break;
    }
  }
}

function cleanName(s) {
  return String(s || '')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .trim()
    .slice(0, 40);
}

function num(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}
