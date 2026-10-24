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
  directKey,
  openCircleKeyBox,
  boxRejoin,
  openRejoinBox,
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
/**
 * The ten chirp sounds. Each member picks one (in their encrypted profile);
 * phones play the sender's chirp, so you can tell who it is without looking.
 */
export const CHIRP_SOUNDS = ['robin', 'wren', 'finch', 'chickadee', 'cardinal', 'bluebird', 'canary', 'sparrow', 'lark', 'dove'];
const MAX_FREQUENT = 8;

const AGENT_NAME = /^[\p{L}\p{N}][\p{L}\p{N} _-]{0,23}$/u;
/** An agent's name: what people call it (/Name), so letters, digits, space, _ and - only. */
function cleanAgentName(name) {
  const n = String(name || '').trim().replace(/\s+/g, ' ');
  return AGENT_NAME.test(n) ? n : '';
}

/** The agent card in the circle record: { name, id?, signPub?, boxPub? } or null. */
function cleanAgentCard(c) {
  if (!c || typeof c !== 'object') return null;
  const name = cleanAgentName(c.name);
  if (!name) return null;
  const b64 = (v) => typeof v === 'string' && /^[A-Za-z0-9_-]{43}$/.test(v);
  if (typeof c.id === 'string' && /^[A-Za-z0-9_-]{8,64}$/.test(c.id) && b64(c.signPub) && b64(c.boxPub)) {
    return { name, id: c.id, signPub: c.signPub, boxPub: c.boxPub };
  }
  return { name };
}

// What _open returns for an envelope signed under another id (a replay).
const REPLAYED = Symbol('replayed');

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
    // memberId -> { since, reason } for members who paused sharing with this circle
    this.paused = new Map();
    this.messages = [];
    this.seenMessageIds = new Set();
    // Envelope nonces already taken in: the same envelope stored again under
    // another id (a replay) is dropped.
    this.seenNonces = new Set();
    // messageId -> emoji -> memberId -> { on, seq }
    this.reactions = new Map();
    // pollId -> { votes: Map<memberId, [{ options, seq }]>, added: [], closes: [], spins: [] }
    this.polls = new Map();
    this.places = new Map();
    // memberId -> { places: [...], ts } for members who share their most visited places
    this.frequent = new Map();
    // The newest message seen, live or fetched.
    this.lastSeq = 0;
    // Where the next fetch starts: moved only by fetches. Messages that arrive
    // live can't move it, or a catch-up after reconnecting would skip whatever
    // was sent just before them.
    this.fetchedSeq = 0;
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

  /** Your name, even before the member list has loaded (e.g. a background task). */
  get myName() {
    return this.me?.name || cleanName(this.account?.profile?.name) || 'Someone';
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
    // Last known name, so the circle is recognizable while its server is down.
    if (this.account.circleName) this.circle = { name: this.account.circleName };
    return true;
  }

  async _save() {
    await this.storage.setItem(this.accountKey, JSON.stringify(this.account));
  }

  /**
   * Forget this device's keys locally. `reason` is passed on with the
   * 'signedOut' event so apps can log why: 'signed_out' (the person chose
   * to), 'left', 'deleted_circle', 'removed' or 'circle_deleted'.
   */
  async signOut(reason = 'signed_out') {
    this.disconnect();
    await this.storage.removeItem(this.accountKey);
    this._reset();
    this.emit('signedOut', { reason });
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

  _seal(kind, body, epoch = this.account.epoch, { to = null, id } = {}) {
    const a = this.account;
    return seal({
      kind,
      from: a.memberId,
      to,
      circle: a.circleId,
      epoch,
      key: to ? this._directKey(to) : a.keyring[epoch],
      signSecret: a.identity.signSecret,
      body,
      id,
    });
  }

  /** Key shared only with one other member, from their verified identity key. */
  _directKey(peerId) {
    const peer = this.account.known[peerId];
    if (!peer) throw new Error('Can’t message someone whose keys haven’t been verified yet');
    return directKey(this.account.identity.boxSecret, peer.boxPub);
  }

  /** Days this circle keeps messages, and the choices an admin has. */
  get retention() {
    return { days: this.state?.retentionDays ?? null, choices: this.state?.retentionChoices ?? [] };
  }

  async setRetention(days) {
    await this.api.putRetention(days);
    await this.refresh();
  }

  _profileBody() {
    const a = this.account;
    return {
      name: a.profile.name,
      color: a.profile.color,
      ...(a.profile.chirp ? { chirp: a.profile.chirp } : {}),
      boxPub: a.identity.boxPub,
      signPub: a.identity.signPub,
    };
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

  // --- recovery with the setup code ----------------------------------------
  //
  // Whoever set up the server can always get back in with its setup code:
  // start a new circle (createCircle with setupToken), delete an abandoned
  // one, or ask to rejoin one. A rejoin only completes once a member of that
  // circle approves it on their phone, which encrypts the circle key to the
  // requester: the server and the setup code alone can't read any circle.

  /** The server's circles: id, createdAt, members, lastSeenAt, waiting (open rejoin requests). */
  static async recoverCircles(serverUrl, setupToken, fetchImpl) {
    const server = normalizeServerUrl(serverUrl);
    const { circles } = await new Api(server, { fetchImpl }).recover(String(setupToken || '').trim());
    return { server, circles };
  }

  /** Delete a circle and everything in it, for everyone in it. */
  static async recoverDeleteCircle(serverUrl, setupToken, circleId, fetchImpl) {
    await new Api(normalizeServerUrl(serverUrl), { fetchImpl }).recoverDelete(String(setupToken || '').trim(), circleId);
  }

  /**
   * Ask to rejoin a circle as its owner. Returns the pending request, which
   * holds this device's new keys: keep it in secure storage until
   * finishRejoin() says it's done. Show `safetyNumber` so the approving
   * member can check it's really you.
   */
  static async requestRejoin({ serverUrl, setupToken, circleId, name, fetchImpl }) {
    const server = normalizeServerUrl(serverUrl);
    const identity = generateIdentity();
    const requestId = randomId();
    const auth = newInviteSecret();
    const res = await new Api(server, { fetchImpl }).requestRejoin({
      setupToken: String(setupToken || '').trim(),
      circleId,
      requestId,
      name: cleanName(name),
      boxPub: identity.boxPub,
      signPub: identity.signPub,
      authHash: inviteAuthHash(auth),
    });
    return {
      server,
      circleId,
      requestId,
      auth,
      identity,
      name: cleanName(name),
      expiresAt: res.expiresAt,
      safetyNumber: safetyNumber(identity.signPub, identity.boxPub),
    };
  }

  /**
   * Check a pending rejoin and, once a member approved it, join the circle as
   * its owner. Returns 'joined', 'pending', 'denied' or 'expired'.
   */
  async finishRejoin(pending) {
    const api = this._makeApi(pending.server);
    const auth = { requestId: pending.requestId, auth: pending.auth };
    const st = await api.rejoinStatus(auth);
    if (st.status === 'done') return 'expired';
    if (st.status !== 'approved') return st.status;
    const got = openRejoinBox(st.wrapped, {
      fromBoxPub: st.from.boxPub,
      myBoxSecret: pending.identity.boxSecret,
      epoch: st.epoch,
      circle: pending.circleId,
    });
    this.account = {
      server: pending.server,
      token: null,
      memberId: randomId(),
      circleId: pending.circleId,
      identity: pending.identity,
      epoch: st.epoch,
      keyring: { [st.epoch]: got.key },
      profile: { name: pending.name, color: randomColor() },
      known: {},
      circleName: cleanName(got.circleName) || 'Our Circle',
      rejoined: true,
    };
    try {
      const res = await api.completeRejoin({
        ...auth,
        member: {
          id: this.account.memberId,
          boxPub: pending.identity.boxPub,
          signPub: pending.identity.signPub,
          profile: this._seal('profile', this._profileBody()),
        },
      });
      this.account.token = res.token;
    } catch (e) {
      this.account = null;
      // The key changed after they approved: the request is waiting again.
      if (e instanceof ApiError && e.code === 'stale_epoch') return 'pending';
      throw e;
    }
    this.circle = { name: this.account.circleName };
    this.api = this._makeApi(pending.server, this.account.token);
    await this._save();
    await this.refresh();
    return 'joined';
  }

  /** Requests to rejoin this circle with the setup code, waiting for a member. */
  async rejoinRequests() {
    const { requests } = await this.api.rejoinRequests();
    return requests.map((q) => ({ ...q, safetyNumber: safetyNumber(q.signPub, q.boxPub) }));
  }

  /** Let them back in: they get the circle key and become its owner. */
  async approveRejoin(request) {
    const a = this.account;
    const wrapped = boxRejoin({
      circleKey: a.keyring[a.epoch],
      epoch: a.epoch,
      circle: a.circleId,
      circleName: this.circle.name,
      approvedByName: (this.me?.name || this.account?.profile?.name || ''),
      toBoxPub: request.boxPub,
      fromBoxSecret: a.identity.boxSecret,
    });
    await this.api.approveRejoin(request.id, { epoch: a.epoch, wrapped });
  }

  denyRejoin(id) {
    return this.api.denyRejoin(id);
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
    if (st.epoch > this.account.epoch || !this.account.keyring[st.epoch]) {
      // Recognize members we can already verify first: a new key is only
      // accepted from an admin whose keys we know.
      this._decodeMembers(st);
      await this._syncKeys(st);
    }
    this._decodeMembers(st);
    this._decodeCircle(st);
    if (this.isAdmin) await this._cardAgent(st).catch(this.onError);

    const mine = st.members.find((m) => m.id === this.account.memberId);
    if (mine && mine.profile?.epoch < st.epoch && this.account.keyring[st.epoch]) {
      await this.api.putProfile(this._seal('profile', this._profileBody()));
    }
    await this._save();
    this.emit('members', this.memberList());
    this.emit('circle', this.circle);

    if (st.rotationNeeded && this.isAdmin && !this._holdRotation(st)) {
      try {
        await this.rotateKey();
      } catch (e) {
        if (!(e instanceof ApiError && e.code === 'stale_epoch')) this.onError(e);
      }
    }
    return st;
  }

  /**
   * After rejoining with the setup code, don't rotate the key until every
   * other member has been online since (so their phones verified this one;
   * they only accept a new key from an admin they know), or a day has passed.
   */
  _holdRotation(st) {
    if (!this.account.rejoined) return false;
    const mine = st.members.find((m) => m.id === this.account.memberId);
    if (!mine || Date.now() - mine.joinedAt > 86400_000) return false;
    return st.members.some((m) => !m.removed && m.id !== mine.id && !((m.lastSeenAt ?? 0) > mine.joinedAt));
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
        kind: m.kind === 'agent' ? 'agent' : 'person',
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
      // The circle's agent: no profile (it can't seal one). Named and
      // verified from the circle's own record (_decodeCircle).
      if (view.kind === 'agent') {
        view.name = pinned?.name || 'Agent';
        view.verified = !!pinned;
        this.members.set(m.id, view);
        continue;
      }
      const key = this.account.keyring[m.profile?.epoch];
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
          view.chirp = CHIRP_SOUNDS.includes(p.body.chirp) ? p.body.chirp : null;
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
      this.circle = { name: cleanName(msg.body.name) || 'Our Circle', agent: cleanAgentCard(msg.body.agent) };
      this.account.circleName = this.circle.name;
      // The agent's keys, as the admin who added it saw them: trusted only if
      // the server lists the same ones for an agent.
      const card = this.circle.agent;
      const listed = card?.id && st.members.find((m) => m.id === card.id && m.kind === 'agent' && !m.removed);
      if (listed && listed.signPub === card.signPub && listed.boxPub === card.boxPub) {
        this.account.known[card.id] = { signPub: card.signPub, boxPub: card.boxPub, name: card.name };
        const view = this.members.get(card.id);
        if (view) Object.assign(view, { name: card.name, verified: true });
      }
    } catch (e) {
      this.onError(e);
    }
  }

  /** The people in the circle (not its agent). */
  memberList() {
    return [...this.members.values()]
      .filter((m) => !m.removed && m.kind !== 'agent')
      .sort((a, b) => (a.isMe ? -1 : b.isMe ? 1 : a.name.localeCompare(b.name)));
  }

  /** Open any envelope from a member, using their pinned signing key. Pass `to` for a direct message. */
  _open(env, from, kinds, to = null, id = undefined) {
    const signPub = this.account.known[from]?.signPub;
    if (!signPub) return null;
    let key;
    try {
      key = to ? this._directKey(from === this.account.memberId ? to : from) : this.account.keyring[env.epoch];
    } catch {
      return null;
    }
    if (!key) return null;
    try {
      const msg = open(env, { key, signPub, from, to, circle: this.account.circleId, id });
      if (!kinds.includes(msg.kind)) return null;
      return msg;
    } catch (e) {
      // Signed for another id: a copy stored again by someone else. Not news.
      if (e?.reason === 'id') return REPLAYED;
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
    // They stopped sharing with this circle: show that, never an old position.
    if (b?.paused === true) {
      this.locations.delete(memberId);
      const reason = typeof b.reason === 'string' ? b.reason.replace(/[\u0000-\u001f]/g, '').trim().slice(0, 80) : '';
      this.paused.set(memberId, { since: msg.ts, reason: reason || null });
      return null;
    }
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
      // Shared on purpose as a rough area (~1 km), not an exact pin.
      approximate: b.approx === true,
      // Phone health, so the circle can see why updates may be late.
      power: b.power === 'saver' ? 'saver' : b.power === 'normal' ? 'normal' : null,
      perm: b.perm === 'always' || b.perm === 'foreground' ? b.perm : null,
      precise: typeof b.precise === 'boolean' ? b.precise : null,
      ts: msg.ts,
      receivedAt: updatedAt,
    };
    const prev = this.locations.get(memberId);
    if (prev && prev.ts > loc.ts) return prev;
    this.locations.set(memberId, loc);
    this.paused.delete(memberId);
    return loc;
  }

  async fetchLocations() {
    const { locations } = await this.api.locations();
    this.paused = new Map();
    for (const l of locations) this._decodeLocation(l.memberId, l.env, l.updatedAt);
    this.emit('locations', this.locations);
    return this.locations;
  }

  /** Upload this device's location, encrypted. */
  async shareLocation({ lat, lng, accuracy, battery, charging, speed, trigger = 'update', placeId = null, approx = false, power, perm, precise, ts }) {
    const body = { lat, lng, accuracy, battery, charging, speed, trigger, placeId };
    if (approx) body.approx = true;
    if (power) body.power = power;
    if (perm) body.perm = perm;
    if (typeof precise === 'boolean') body.precise = precise;
    await this._withEpochRetry(() => {
      const env = this._seal('location', body);
      return this.api.putLocation(env);
    });
    this.locations.set(this.account.memberId, { ...body, approximate: !!approx, ts: ts || Date.now(), receivedAt: Date.now() });
    this.paused.delete(this.account.memberId);
    this.emit('locations', this.locations);
  }

  /**
   * Stop sharing with this circle. Replaces your last location with an
   * encrypted "paused" marker, so the circle sees you paused rather than a
   * stale position.
   */
  async pauseSharing(reason = '') {
    const why = String(reason || '').trim().slice(0, 80);
    await this._withEpochRetry(() => this.api.putLocation(this._seal('location', why ? { paused: true, reason: why } : { paused: true })));
    this.locations.delete(this.account.memberId);
    this.paused.set(this.account.memberId, { since: Date.now(), reason: why || null });
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
    // Before the duplicate check: a fetch that returns our own messages
    // (already shown) must still move past them.
    this.lastSeq = Math.max(this.lastSeq, m.seq);
    if (this.seenMessageIds.has(m.id)) return false;
    this.seenMessageIds.add(m.id);
    if (this.seenNonces.has(m.env?.nonce)) return false;
    this.seenNonces.add(m.env?.nonce);
    const to = m.to ?? null;
    // Direct messages: the other person in the conversation. null = the group.
    const peer = to ? (m.from === this.account.memberId ? to : m.from) : null;
    const msg = this._open(m.env, m.from, to ? ['chat', 'reaction'] : ['chat', 'event', 'reaction'], to, m.id);
    if (msg === REPLAYED) return false;
    if (msg?.kind === 'reaction') {
      if (isPollUpdate(msg.body)) this._applyPollUpdate(m.from, m.seq, msg.body);
      else this._applyReaction(m.from, m.seq, msg.body);
      return { kind: 'reaction', id: m.id, from: m.from, to, peer, seq: m.seq, body: msg.body };
    }
    if (msg?.kind === 'chat' && msg.body?.pollSpin) this._applyPollSpin(m.from, m.seq, msg.ts, msg.body.pollSpin);
    // What you sent the agent alongside a question or Remember in the group:
    // only for the agent, not a conversation of its own.
    if (msg?.kind === 'chat' && msg.body?.agentCopy) return { kind: 'agentCopy', id: m.id, from: m.from, to, peer, seq: m.seq, body: msg.body };
    const agentId = this.circle?.agent?.id;
    const entry = {
      seq: m.seq,
      id: m.id,
      from: m.from,
      to,
      // The agent answers a group question to each person separately; it
      // belongs in the group chat.
      peer: agentId && m.from === agentId && msg?.body?.thread === 'group' ? null : peer,
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
    // Reactions to a direct message stay between the same two people.
    const to = this.messages.find((m) => m.id === messageId)?.peer ?? null;
    return this._post('reaction', { target: messageId, emoji, on: !mine?.on }, { silent: true, to });
  }

  // --- polls -------------------------------------------------------------
  //
  // A poll is a chat message with `poll` in its body; older apps just show its
  // text. Votes, suggested options and closing ride on reactions that carry
  // no emoji, which older apps ignore. A spin of the wheel is a chat line, so
  // everyone hears about it. No server changes: it's all sealed messages.

  _poll(pollId) {
    let p = this.polls.get(pollId);
    if (!p) this.polls.set(pollId, (p = { votes: new Map(), added: [], closes: [], spins: [] }));
    return p;
  }

  // Everything is kept as it arrives (live and fetched can come out of order);
  // pollState() decides what counts once it knows who started the poll.
  _applyPollUpdate(from, seq, body) {
    const p = this._poll(body.target);
    if (Array.isArray(body.vote)) {
      let mine = p.votes.get(from);
      if (!mine) p.votes.set(from, (mine = []));
      if (!mine.some((v) => v.seq === seq)) mine.push({ options: body.vote.filter((x) => typeof x === 'string').slice(0, MAX_POLL_OPTIONS), seq });
    } else if (body.add) {
      const opt = cleanPollOption(body.add);
      if (opt && !p.added.some((a) => a.id === opt.id)) p.added.push({ ...opt, by: from, seq });
    } else if (body.close === true) {
      if (!p.closes.some((c) => c.seq === seq)) p.closes.push({ by: from, seq });
    }
  }

  _applyPollSpin(from, seq, ts, spin) {
    if (typeof spin.poll !== 'string' || typeof spin.option !== 'string') return;
    const p = this._poll(spin.poll);
    if (!p.spins.some((s) => s.seq === seq)) p.spins.push({ by: from, option: spin.option, seq, ts });
  }

  /**
   * Start a poll in the group chat (or a direct chat with `to`): 2–8 options,
   * each with an optional emoji. `closesAt` (ms) closes it automatically.
   */
  createPoll({ question, options, multi = false, allowAdd = true, closesAt = null }, { to = null } = {}) {
    const poll = cleanPoll({ question, options: options.map((o, i) => ({ ...o, id: `o${i + 1}` })), multi, allowAdd, closesAt });
    if (!poll) return Promise.reject(new Error('A poll needs a question and 2 to 8 options'));
    const lines = poll.options.map((o) => `${o.emoji || '•'} ${o.label}`).join('\n');
    return this._post('chat', { text: `📊 ${poll.question}\n${lines}\n(Update HomeCircle to vote)`, poll }, { to });
  }

  _pollMessage(pollId) {
    return this.messages.find((m) => m.id === pollId && m.kind === 'chat' && m.body?.poll);
  }

  /** Vote: the option ids you pick (one, unless the poll allows several; [] withdraws). */
  vote(pollId, optionIds) {
    const m = this._pollMessage(pollId);
    if (!m) return Promise.reject(new Error('No such poll'));
    const state = this.pollState(pollId);
    if (state.closed) return Promise.reject(new Error('This poll is closed'));
    const valid = optionIds.filter((id) => state.options.some((o) => o.id === id));
    const vote = state.multi ? [...new Set(valid)] : valid.slice(0, 1);
    return this._post('reaction', { target: pollId, vote }, { silent: true, to: m.peer });
  }

  /** Suggest another option (if the poll allows it). */
  suggestOption(pollId, label, emoji = '') {
    const m = this._pollMessage(pollId);
    if (!m) return Promise.reject(new Error('No such poll'));
    const state = this.pollState(pollId);
    if (state.closed || !state.allowAdd) return Promise.reject(new Error('This poll doesn’t take new options'));
    if (state.options.length >= MAX_POLL_OPTIONS) return Promise.reject(new Error(`A poll can have at most ${MAX_POLL_OPTIONS} options`));
    const opt = cleanPollOption({ id: `a${randomId(6)}`, label, emoji });
    if (!opt) return Promise.reject(new Error('Give the option a name'));
    return this._post('reaction', { target: pollId, add: opt }, { silent: true, to: m.peer });
  }

  /** Close the poll (its creator only) and tell everyone the result. */
  async closePoll(pollId) {
    const m = this._pollMessage(pollId);
    if (!m) throw new Error('No such poll');
    if (m.from !== this.account.memberId) throw new Error('Only the person who started the poll can close it');
    // Every vote in before closing, so the result posted is right.
    await this.fetchMessages();
    await this._post('reaction', { target: pollId, close: true }, { silent: true, to: m.peer });
    const s = this.pollState(pollId);
    const text = s.winners.length === 1 ? `🏁 Poll closed: ${s.winners[0].emoji || ''} ${s.winners[0].label} wins` : s.winners.length ? `🏁 Poll closed: a tie between ${s.winners.map((w) => w.label).join(' and ')}` : '🏁 Poll closed with no votes';
    await this._post('chat', { text: text.replace(/\s+/g, ' ').trim(), pollResult: { poll: pollId } }, { to: m.peer });
  }

  /**
   * Spin the wheel: pick one of the leading options (or any, before anyone
   * voted) at random, and tell everyone.
   */
  async spinWheel(pollId) {
    const m = this._pollMessage(pollId);
    if (!m) throw new Error('No such poll');
    await this.fetchMessages();
    const s = this.pollState(pollId);
    const pool = s.winners.length ? s.winners : s.options;
    const pick = pool[Math.floor(Math.random() * pool.length)];
    const who = this.myName;
    await this._post('chat', { text: `🎡 ${who} spun the wheel: ${pick.emoji ? `${pick.emoji} ` : ''}${pick.label}!`, pollSpin: { poll: pollId, option: pick.id } }, { to: m.peer });
    return pick;
  }

  /**
   * Everything about a poll for drawing it: options with votes and voters,
   * who voted, whether it's closed, the winners, and the latest spin.
   */
  pollState(pollId, now = Date.now()) {
    const m = this._pollMessage(pollId);
    if (!m) return null;
    const poll = cleanPoll(m.body.poll);
    if (!poll) return null;
    const p = this.polls.get(pollId) || { votes: new Map(), added: [], closes: [], spins: [] };
    const options = [...poll.options];
    if (poll.allowAdd) {
      for (const a of [...p.added].sort((x, y) => x.seq - y.seq)) {
        if (options.length >= MAX_POLL_OPTIONS) break;
        if (!options.some((o) => o.id === a.id || o.label.toLowerCase() === a.label.toLowerCase())) options.push({ id: a.id, label: a.label, emoji: a.emoji, by: a.by });
      }
    }
    // Who may vote: everyone in the circle, or the two people in a direct chat.
    const members = this.memberList().filter((x) => !x.removed);
    const eligible = m.peer ? members.filter((x) => x.id === m.from || x.id === m.peer || x.id === m.to) : members;
    // Only its creator can close it; votes sent after that don't count.
    const closedAt = Math.min(Infinity, ...p.closes.filter((c) => c.by === m.from).map((c) => c.seq));
    const counted = new Map();
    for (const [memberId, history] of p.votes) {
      if (!eligible.some((x) => x.id === memberId)) continue;
      const v = history.filter((x) => x.seq < closedAt).sort((a, b) => b.seq - a.seq)[0];
      if (!v) continue;
      const picks = v.options.filter((id) => options.some((o) => o.id === id));
      const list = poll.multi ? [...new Set(picks)] : picks.slice(0, 1);
      if (list.length) counted.set(memberId, list);
    }
    const nameOf = (id) => this.members.get(id)?.name || 'Former member';
    const withVotes = options.map((o) => {
      const voters = [...counted].filter(([, list]) => list.includes(o.id)).map(([id]) => id);
      return { ...o, votes: voters.length, voters: voters.map(nameOf), mine: voters.includes(this.account?.memberId) };
    });
    const top = Math.max(0, ...withVotes.map((o) => o.votes));
    const spin = [...p.spins].sort((a, b) => b.seq - a.seq)[0];
    const spinOption = spin && withVotes.find((o) => o.id === spin.option);
    return {
      id: pollId,
      question: poll.question,
      multi: poll.multi,
      allowAdd: poll.allowAdd,
      closesAt: poll.closesAt,
      creator: m.from,
      creatorName: nameOf(m.from),
      mine: m.from === this.account?.memberId,
      options: withVotes,
      voters: counted.size,
      eligible: eligible.length,
      everyoneVoted: eligible.length > 0 && counted.size >= eligible.length,
      myVote: counted.get(this.account?.memberId) || [],
      closed: closedAt !== Infinity || (poll.closesAt != null && poll.closesAt <= now),
      winners: top > 0 ? withVotes.filter((o) => o.votes === top) : [],
      spin: spinOption ? { option: spinOption, by: nameOf(spin.by), ts: spin.ts } : null,
    };
  }

  /** Messages in one conversation: the group (peer null) or a direct chat with `peer`. */
  conversation(peer = null) {
    return this.messages.filter((m) => (m.peer ?? null) === peer);
  }

  // --- the circle's agent -------------------------------------------------
  // An admin invites it (the invite carries no circle key) and names it; once
  // it joins, an admin's phone puts its id and keys in the circle's sealed
  // record, which is how everyone's phone knows and trusts it. People talk to
  // it with messages sealed only for it; it answers each person the same way.

  _circleBody(patch = {}) {
    const body = { name: this.circle.name, ...patch };
    if (this.circle.agent && !('agent' in patch)) body.agent = this.circle.agent;
    if (!body.agent) delete body.agent;
    return body;
  }

  /** The circle's agent once it has joined: { id, name }, or null. */
  get agent() {
    const card = this.circle?.agent;
    const m = card?.id ? this.members.get(card.id) : null;
    return m && !m.removed && m.kind === 'agent' && m.verified ? { id: card.id, name: card.name } : null;
  }

  /** The agent's name while it's invited but hasn't joined yet, or null. */
  get agentInvited() {
    const card = this.circle?.agent;
    return card && !this.agent ? { name: card.name } : null;
  }

  /** Admins: invite an agent with this name. The link goes to the agent, never to a person. */
  async createAgentInvite({ name, hours = 168 } = {}) {
    if (!this.isAdmin) throw new Error('Only circle admins can add an agent');
    const agentName = cleanAgentName(name);
    if (!agentName) throw new Error('Give the agent a name');
    const secret = newInviteSecret();
    const { inviteAuth } = deriveInvite(secret);
    const id = randomId(9);
    const a = this.account;
    const res = await this.api.createInvite({ id, authHash: inviteAuthHash(inviteAuth), epoch: a.epoch, hours, agent: true });
    await this.api.putCircle(this._seal('circle', this._circleBody({ agent: { name: agentName } })));
    await this.refresh();
    return { id, expiresAt: res.expiresAt, link: inviteLink(a.server, id, secret) };
  }

  /** Once the invited agent has joined, record its id and keys (any admin's phone does this). */
  async _cardAgent(st) {
    const card = this.circle?.agent;
    if (!card || card.id) return;
    const joined = st.members.find((m) => m.kind === 'agent' && !m.removed);
    if (!joined) return;
    const agent = { name: card.name, id: joined.id, signPub: joined.signPub, boxPub: joined.boxPub };
    await this.api.putCircle(this._seal('circle', this._circleBody({ agent })));
    this.circle.agent = agent;
    this.account.known[agent.id] = { signPub: agent.signPub, boxPub: agent.boxPub, name: agent.name };
    const view = this.members.get(agent.id);
    if (view) Object.assign(view, { name: agent.name, verified: true });
  }

  /** Admins: rename the agent (also what people call it: /Name). */
  async setAgentName(name) {
    const card = this.circle?.agent;
    if (!card) throw new Error('This circle has no agent');
    const agentName = cleanAgentName(name);
    if (!agentName) throw new Error('Give the agent a name');
    await this.api.putCircle(this._seal('circle', this._circleBody({ agent: { ...card, name: agentName } })));
    await this.refresh();
  }

  /** Admins: remove the agent (and forget its card). */
  async removeAgent() {
    const id = this.circle?.agent?.id;
    if (id && this.members.get(id) && !this.members.get(id).removed) await this.api.removeMember(id);
    await this.api.putCircle(this._seal('circle', this._circleBody({ agent: null })));
    await this.refresh();
  }

  _agentContext() {
    return { asker: this.myName, people: this.memberList().map((m) => ({ id: m.id, name: m.name })) };
  }

  /**
   * Ask the agent. In the group (`peer` null) everyone sees the question as
   * "/Name …" and the answer; only the agent gets the question sealed for it.
   * In a direct chat with the agent (`peer` = its id), only you do.
   */
  async askAgent(text, { peer = null } = {}) {
    const agent = this.agent;
    if (!agent) throw new Error('This circle has no agent');
    const q = String(text || '').trim().slice(0, 2000);
    if (!q) return null;
    if (peer && peer !== agent.id) throw new Error('Ask the agent in the group or in a chat with it');
    if (peer) {
      const id = randomId(12);
      await this._post('chat', { text: q, ask: q, thread: 'dm', ...this._agentContext() }, { to: agent.id, id });
      return id;
    }
    const id = randomId(12);
    await this._post('chat', { text: `/${agent.name} ${q}`, agentAsk: true }, { id });
    await this._post('chat', { ask: q, thread: 'group', replyTo: id, agentCopy: true, ...this._agentContext() }, { to: agent.id, silent: true });
    return id;
  }

  /**
   * Remember with the agent: sends it just this one message. From the group
   * it goes to circle memory; from a direct chat, to your private notes.
   */
  async rememberWithAgent(messageId) {
    const agent = this.agent;
    if (!agent) throw new Error('This circle has no agent');
    const m = this.messages.find((x) => x.id === messageId);
    const text = m && typeof m.body?.text === 'string' ? m.body.text : '';
    if (!text) throw new Error('Only messages with text can be remembered');
    const remember = { text: text.slice(0, 4000), by: this.members.get(m.from)?.name || 'Someone', at: m.ts, scope: m.peer ? 'private' : 'circle' };
    await this._post('chat', { remember, thread: m.peer ? 'dm' : 'group', agentCopy: true, ...this._agentContext() }, { to: agent.id, silent: true });
  }

  // --- SOS ---------------------------------------------------------------
  // An SOS is a group chat message with `body.sos` (older apps show its text),
  // followed by "arrived at …" lines and finally "I'm safe". While it's on,
  // the sender's phone shares its location every minute.

  /** Send an SOS to the whole circle. Returns its id. */
  async startSos() {
    const id = randomId(12);
    const name = this.myName;
    await this._post('chat', { text: `🆘 ${name} sent an SOS. Open HomeCircle to see where they are.`, sos: { state: 'start' } }, { id });
    return id;
  }

  /** Tell the circle you reached a safe place during an SOS. */
  sosArrived(sosId, placeName) {
    const place = String(placeName || '').slice(0, 80) || 'a safe place';
    const name = this.myName;
    return this._post('chat', { text: `📍 ${name} reached ${place}`, sos: { state: 'arrived', of: sosId, place } });
  }

  /** End your SOS: "I'm safe". */
  endSos(sosId) {
    const name = this.myName;
    return this._post('chat', { text: `✅ ${name} is safe now.`, sos: { state: 'safe', of: sosId } });
  }

  /**
   * SOSes still on, newest first: [{ id, memberId, name, since, arrived }].
   * One ends with "I'm safe" from its sender, when they leave the circle, or
   * after a day without one (a phone that died mid-SOS).
   */
  activeSos(now = Date.now()) {
    const open = new Map(); // memberId -> sos
    for (const m of this.messages) {
      const s = m.kind === 'chat' && !m.peer ? m.body?.sos : null;
      if (!s || typeof s !== 'object') continue;
      if (s.state === 'start') open.set(m.from, { id: m.id, memberId: m.from, since: m.ts, arrived: null });
      const cur = open.get(m.from);
      if (cur && s.of === cur.id) {
        if (s.state === 'safe') open.delete(m.from);
        else if (s.state === 'arrived') cur.arrived = { place: String(s.place || ''), at: m.ts };
      }
    }
    return [...open.values()]
      .filter((s) => now - s.since < 86400_000 && this.members.get(s.memberId) && !this.members.get(s.memberId).removed)
      .map((s) => ({ ...s, name: this.members.get(s.memberId)?.name || 'Someone' }))
      .sort((a, b) => b.since - a.since);
  }

  /** Direct-message partners, most recent conversation first. */
  directPeers() {
    const last = new Map();
    for (const m of this.messages) if (m.peer) last.set(m.peer, m.seq);
    return [...last].sort((a, b) => b[1] - a[1]).map(([id]) => id);
  }

  async fetchMessages() {
    for (;;) {
      const { messages } = await this.api.messages(this.fetchedSeq, 500);
      for (const m of messages) {
        this._addMessage(m);
        this.fetchedSeq = Math.max(this.fetchedSeq, m.seq);
      }
      if (messages.length < 500) break;
    }
    this.emit('messages', this.messages);
    return this.messages;
  }

  async _post(kind, body, { silent = false, to = null, id = randomId(12) } = {}) {
    let env;
    const res = await this._withEpochRetry(() => {
      env = this._seal(kind, body, this.account.epoch, { to, id });
      return this.api.postMessage(id, env, { silent, to });
    });
    // Our own message's seq says nothing about what others posted before it
    // (the live connection may be down), so it doesn't count as seen; our own
    // copy is de-duplicated by id when it comes back in the next fetch.
    const seenUpTo = this.lastSeq;
    this._addMessage({ seq: res.seq, id, from: this.account.memberId, to, createdAt: res.createdAt, env });
    this.lastSeq = seenUpTo;
    this.emit('messages', this.messages);
  }

  /** Send to the whole circle, or only to `to` (a direct message). */
  sendChat(text, { to = null } = {}) {
    const t = String(text || '').trim().slice(0, 4000);
    if (!t) return Promise.resolve();
    return this._post('chat', { text: t }, { to });
  }

  /**
   * "Where are you?": a direct message the other person can answer with one
   * tap, plus a request for a fresh location. The text reads fine on older
   * apps that don't know about check-ins.
   */
  async askToCheckIn(peer) {
    await this._post('chat', { text: '📍 Where are you? Tap “I’m OK” to check in.', checkin: 'request' }, { to: peer });
    await this.requestLocations([peer]).catch(() => {});
  }

  /**
   * Admins: ask someone to fix their setup (a direct message with a button to
   * the setup check on newer apps; readable text on older ones).
   */
  nudgeSetup(peer, problem = '') {
    const text = `⚠️ Your HomeCircle setup needs attention${problem ? `: ${problem}` : ''}. Open Settings → Setup check to fix it.`;
    return this._post('chat', { text, nudge: true }, { to: peer });
  }

  /** Answer a check-in: "I'm OK", as a direct message. */
  checkIn(peer) {
    return this._post('chat', { text: '✅ I’m OK', checkin: 'ok' }, { to: peer });
  }

  /**
   * e.g. { type: 'place', action: 'arrived' | 'left', placeId, placeName, at }.
   * Pass a stable `id` to retry safely: the server keeps the first copy and
   * refuses repeats (409), which counts as delivered.
   */
  async sendEvent(body, { id } = {}) {
    try {
      await this._post('event', body, id ? { id } : {});
    } catch (e) {
      if (id && e instanceof ApiError && e.status === 409 && e.code === 'conflict') return;
      throw e;
    }
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
      // Street address it was added from, if any.
      address: typeof b.address === 'string' ? b.address.slice(0, 200) : null,
      // The same place added to several circles shares a group id.
      group: typeof b.group === 'string' ? b.group.slice(0, 40) : null,
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

  async savePlace({ id = randomId(9), name, lat, lng, radius = 150, icon = 'pin', address = null, group = null }) {
    const body = { id, name: cleanName(name), lat, lng, radius, icon, address, group };
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
      invitedByName: (this.me?.name || this.account?.profile?.name || ''),
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

  /** Pick the chirp others hear when you chirp them (one of CHIRP_SOUNDS). */
  async setChirp(sound) {
    if (!CHIRP_SOUNDS.includes(sound)) throw new Error('Unknown chirp');
    this.account.profile.chirp = sound;
    await this.api.putProfile(this._seal('profile', this._profileBody()));
    await this._save();
    await this.refresh();
  }

  /**
   * Chirp one member (`to`), or everyone else in the circle (`to` null): a
   * short sound, and with `flash` a few blinks of their camera light. Three in
   * a row, then a 30-minute break (the server enforces it): returns
   * { sent, remaining, cooldownUntil }, or throws ApiError 'chirp_cooldown'
   * with `cooldownUntil`.
   */
  chirp(to = null, { flash = false } = {}) {
    return this.api.chirp({ to, flash });
  }

  /**
   * Chirps waiting for this device, with who sent them: [{ id, from, name,
   * sound, flash, at }]. Collecting them removes them from the server.
   */
  async collectChirps() {
    const { chirps } = await this.api.chirps();
    if (chirps.length && chirps.some((c) => !this.members.has(c.from))) await this.refresh();
    return chirps.map((c) => {
      const m = this.members.get(c.from);
      return { ...c, name: m?.name || 'Someone', sound: m?.chirp || CHIRP_SOUNDS[0] };
    });
  }

  // --- most visited places -------------------------------------------------

  /**
   * Share this phone's most visited places with the circle, sealed with the
   * circle key: [{ id, name, kind, lat, lng, visits, hours, lastAt }].
   */
  async shareFrequent(places) {
    const clean = places.slice(0, MAX_FREQUENT).map(cleanFrequent).filter(Boolean);
    await this.api.putFrequent(this._seal('frequent', { places: clean }));
  }

  /** Stop sharing most visited places with this circle. */
  async clearFrequent() {
    await this.api.deleteFrequent();
  }

  async fetchFrequent() {
    const { frequent } = await this.api.frequent();
    this.frequent = new Map();
    for (const f of frequent) {
      const msg = this._open(f.env, f.memberId, ['frequent']);
      const places = Array.isArray(msg?.body?.places) ? msg.body.places.map(cleanFrequent).filter(Boolean).slice(0, MAX_FREQUENT) : null;
      if (places) this.frequent.set(f.memberId, { places, ts: msg.ts });
    }
    this.emit('frequent', this.frequent);
    return this.frequent;
  }

  async setCircleName(name) {
    await this.api.putCircle(this._seal('circle', this._circleBody({ name: cleanName(name) })));
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
    await this.signOut('left');
  }

  /** Owner only: delete this circle and everything in it, for everyone. */
  async deleteCircle() {
    await this.api.deleteCircle();
    await this.signOut('deleted_circle');
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
    await this.api.putCircle(this._seal('circle', this._circleBody()));
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
        if (s === 'unauthorized') this._checkMembership();
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

  /**
   * The server closed the live connection saying it doesn't know this device.
   * Ask again before believing it: a server that lost or misplaced its data
   * says the same thing, and deleting this device's keys can't be undone.
   * Only an explicit "removed" or "circle deleted" message signs it out;
   * otherwise the app is told ('unrecognized') and the person decides.
   */
  async _checkMembership() {
    if (!this.account) return; // already signed out by a "removed" message
    if (this.connection) this.connection.close();
    this.connection = null;
    try {
      await this.refresh();
      this.connect();
    } catch (e) {
      if (!this.account) return;
      if (e instanceof ApiError && e.status === 401) {
        this.status = 'unauthorized';
        this.emit('status', 'unauthorized');
        this.emit('unrecognized');
      } else {
        setTimeout(() => {
          if (!this.connection && this.account) this.connect();
        }, 15000);
      }
    }
  }

  /** The server said, in so many words, that this device is out: 'removed' or 'circle_deleted'. */
  async _handleRemoved(reason) {
    this.emit('removed', { reason });
    await this.signOut(reason);
  }

  async _onEvent(e) {
    switch (e.type) {
      case 'location': {
        const wasPaused = this.paused.has(e.memberId);
        const loc = this._decodeLocation(e.memberId, e.env, e.updatedAt);
        if (loc || wasPaused !== this.paused.has(e.memberId)) this.emit('locations', this.locations);
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
        if (e.memberId === this.account.memberId) return this._handleRemoved('removed');
        this.locations.delete(e.memberId);
        await this.refresh();
        break;
      case 'circle_deleted':
        return this._handleRemoved('circle_deleted');
      case 'members_changed':
      case 'key_rotated':
      case 'circle':
        await this.refresh();
        break;
      case 'rejoin_requests':
        this.emit('rejoinRequests');
        break;
      case 'chirp':
        this.emit('chirp');
        break;
      case 'frequent':
        await this.fetchFrequent();
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

const MAX_POLL_OPTIONS = 12; // 8 to start with, plus suggestions

/** A poll update riding on a reaction: a vote, a suggested option, or closing it. */
function isPollUpdate(b) {
  return !!b && typeof b.target === 'string' && b.emoji === undefined && (Array.isArray(b.vote) || !!b.add || b.close === true);
}

function cleanPollOption(o) {
  if (!o || typeof o.id !== 'string' || !/^[A-Za-z0-9_-]{1,24}$/.test(o.id)) return null;
  const label = String(o.label ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .trim()
    .slice(0, 60);
  if (!label) return null;
  const emoji = typeof o.emoji === 'string' && o.emoji.length <= 16 && isValidReaction(o.emoji) ? o.emoji : '';
  return { id: o.id, label, emoji };
}

/** A poll as stored in its message, checked and trimmed (null if unusable). */
function cleanPoll(p) {
  if (!p || typeof p.question !== 'string' || !Array.isArray(p.options)) return null;
  const question = p.question.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 200);
  const options = [];
  for (const o of p.options.slice(0, 8)) {
    const c = cleanPollOption(o);
    if (c && !options.some((x) => x.id === c.id)) options.push(c);
  }
  if (!question || options.length < 2) return null;
  return {
    question,
    options,
    multi: p.multi === true,
    allowAdd: p.allowAdd !== false,
    closesAt: typeof p.closesAt === 'number' && Number.isFinite(p.closesAt) ? p.closesAt : null,
  };
}

const FREQUENT_KINDS = ['home', 'work', 'school', 'shopping', 'grocery', 'gas', 'food', 'gym', 'health', 'worship', 'park', 'other'];

/** A most-visited place as shared, checked and trimmed. */
function cleanFrequent(p) {
  if (!p || typeof p.lat !== 'number' || typeof p.lng !== 'number' || Math.abs(p.lat) > 90 || Math.abs(p.lng) > 180) return null;
  return {
    id: String(p.id || '').slice(0, 40),
    name: cleanName(p.name) || 'Place',
    kind: FREQUENT_KINDS.includes(p.kind) ? p.kind : 'other',
    lat: Math.round(p.lat * 1e4) / 1e4,
    lng: Math.round(p.lng * 1e4) / 1e4,
    visits: Math.max(0, Math.min(10000, Math.round(num(p.visits) ?? 0))),
    hours: Math.max(0, Math.min(10000, Math.round((num(p.hours) ?? 0) * 10) / 10)),
    lastAt: num(p.lastAt),
  };
}

function num(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}
