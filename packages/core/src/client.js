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
  sealToKey,
  encryptFile,
  decryptFile,
  appInviteLink,
} from './crypto.js';
import { isValidReaction } from './emoji.js';
import { allFeatures, cleanFeatures, defaultFeatures, hasFeature, resolveFeatures } from './features.js';

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
/** Answers to a call-back request, and how each reads in the chat. Only 'now' closes a request. */
export const CALLBACK_REPLIES = ['now', '5min', 'morning', 'evening'];
export const CALLBACK_REPLY_TEXT = {
  now: 'I’m calling you now',
  '5min': 'I’ll call you back in 5 minutes',
  morning: 'I’ll call you in the morning',
  evening: 'I’ll call you in the evening',
};
const MAX_MEMBERS_ASKED = 50;

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

/** Let the screen draw and taps through (a macrotask), then carry on. */
const yieldToUi = () => new Promise((r) => setTimeout(r, 0));

export class CircleClient {
  /**
   * @param {object} opts
   * @param {{getItem(k:string):Promise<string|null>, setItem(k:string,v:string):Promise<void>, removeItem(k:string):Promise<void>}} opts.storage
   * @param {string} [opts.accountKey] where this circle's account is stored
   * @param {{getItem(k:string):Promise<string|null>, setItem(k:string,v:string):Promise<void>, removeItem(k:string):Promise<void>}} [opts.cache]
   *   where opened messages are kept between launches (optional; can be big)
   */
  constructor({ storage, cache = null, accountKey = ACCOUNT_KEY, fetchImpl, binaryFetchImpl, WebSocketImpl, onError = () => {} }) {
    this.storage = storage;
    this.cache = cache;
    this.accountKey = accountKey;
    this.fetchImpl = fetchImpl;
    this.binaryFetchImpl = binaryFetchImpl;
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
    // Ticks: how far each member's phone has fetched (delivered), and how far
    // each has read each conversation ("memberId|peer" -> seq; peer '' = group).
    this.delivered = new Map();
    this.reads = new Map();
    // agentRpc requests waiting for the agent's answer: id -> callback.
    this._rpcWaiters = new Map();
    // A big answer arrives in parts: id -> parts so far.
    this._rpcParts = new Map();
    // messageId -> emoji -> memberId -> { on, seq }
    this.reactions = new Map();
    // pollId -> { votes: Map<memberId, [{ options, seq }]>, added: [], closes: [], spins: [] }
    this.polls = new Map();
    this.places = new Map();
    // memberId -> { places: [...], ts } for members who share their most visited places
    this.frequent = new Map();
    // Sealed records (fetchRecords): member settings by member id, and
    // family names by "caller.member".
    this.records = { member: new Map(), alias: new Map() };
    // The newest message seen, live or fetched.
    this.lastSeq = 0;
    // Where the next fetch starts: moved only by fetches. Messages that arrive
    // live can't move it, or a catch-up after reconnecting would skip whatever
    // was sent just before them.
    this.fetchedSeq = 0;
    this.connection = null;
    this.status = 'offline';
    // Opened envelopes, so the same location, place or profile isn't
    // decrypted and checked again on every refresh: "from|to|id|ct" -> msg.
    this._opened = new Map();
    // Messages as opened, kept on this phone between launches (opts.cache):
    // a cold start then only opens what's new. seq -> row.
    this._cacheRows = new Map();
    this._cacheLoaded = false;
    this._cacheTimer = null;
    this._started = false;
    this._catching = null;
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
    return new Api(server, { token, fetchImpl: this.fetchImpl, binaryFetchImpl: this.binaryFetchImpl, WebSocketImpl: this.WebSocketImpl });
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
    clearTimeout(this._cacheTimer);
    await this.storage.removeItem(this.accountKey);
    await this.cache?.removeItem(this._cacheKey).catch(() => {});
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

  /** The circle's features ({ id: on }); everything on until the server says (older servers). */
  get features() {
    return this.state?.features ?? allFeatures();
  }

  /** Whether a feature works in this circle (on, and so is whatever it needs). */
  feature(id) {
    return hasFeature(this.features, id);
  }

  /** Admins: turn features on or off ({ id: true | false }). */
  async setFeatures(features) {
    await this.api.putFeatures(cleanFeatures(features));
    await this.refresh();
  }

  _profileBody() {
    const a = this.account;
    return {
      name: a.profile.name,
      color: a.profile.color,
      ...(a.profile.chirp ? { chirp: a.profile.chirp } : {}),
      ...(GENDERS.includes(a.profile.g) ? { g: a.profile.g } : {}),
      ...(cleanPhotoRef(a.profile.photo) ? { photo: a.profile.photo } : {}),
      boxPub: a.identity.boxPub,
      signPub: a.identity.signPub,
    };
  }

  /**
   * Create a circle. The first circle on a new server needs the server's
   * `setupToken`. Later circles on the same server are created by a server
   * admin: pass `admin`, a CircleClient already in a circle on that server.
   */
  async createCircle({ serverUrl, setupToken, admin, name, circleName, features = defaultFeatures() }) {
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
        features: resolveFeatures(features),
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
    return {
      serverUrl,
      inviteId,
      inviteAuth,
      payload,
      circleId: payload.circle,
      circleName: payload.circleName,
      invitedBy: payload.invitedByName,
      companion: cleanCompanionInvite(payload.companion),
    };
  }

  /**
   * Join with an invite link. An Elderly Companion invite carries the name
   * the family gave her, so `name` can be left out.
   */
  async joinWithInvite(link, { name } = {}) {
    const preview = await this.previewInvite(link);
    const { serverUrl, inviteId, inviteAuth, payload } = preview;
    name = cleanName(name) || preview.companion?.name || '';
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
    for (const m of st.members) if ((m.deliveredSeq ?? 0) > (this.delivered.get(m.id) ?? 0)) this.delivered.set(m.id, m.deliveredSeq);
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
          view.g = GENDERS.includes(p.body.g) ? p.body.g : null;
          view.photo = cleanPhotoRef(p.body.photo);
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
    // The same envelope from the same sender opens to the same thing: checking
    // a signature is slow on phones (tens of ms), so each is checked once.
    const memo = typeof env?.ct === 'string' ? `${signPub}|${to ?? ''}|${id ?? ''}|${env.ct}` : null;
    if (memo && this._opened.has(memo)) {
      const msg = this._opened.get(memo);
      return kinds.includes(msg.kind) ? msg : null;
    }
    let key;
    try {
      key = to ? this._directKey(from === this.account.memberId ? to : from) : this.account.keyring[env.epoch];
    } catch {
      return null;
    }
    if (!key) return null;
    try {
      const msg = open(env, { key, signPub, from, to, circle: this.account.circleId, id });
      if (memo) {
        this._opened.set(memo, msg);
        // Oldest out: messages are kept by the cache below, this is for the rest.
        if (this._opened.size > 3000) this._opened.delete(this._opened.keys().next().value);
      }
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
      app: typeof b.app === 'string' ? b.app.slice(0, 16) : null,
      cadence: cleanCadence(b.cadence),
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
  async shareLocation({ lat, lng, accuracy, battery, charging, speed, trigger = 'update', placeId = null, approx = false, power, perm, precise, app, cadence, ts }) {
    const body = { lat, lng, accuracy, battery, charging, speed, trigger, placeId };
    // Which HomeCircle app the phone runs, for Circle health (0.16+).
    if (typeof app === 'string' && app) body.app = app.slice(0, 16);
    // How often this phone updates now (0.18+): { stop, moving, still } in
    // minutes, and whether charging or the battery budget changes it.
    if (cadence && typeof cadence === 'object') body.cadence = cleanCadence(cadence);
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
    const kinds = to ? ['chat', 'reaction'] : ['chat', 'event', 'reaction'];
    // From this phone's cache: opened (and checked) on an earlier launch.
    const msg = m.opened ? (kinds.includes(m.opened.kind) ? m.opened : null) : this._open(m.env, m.from, kinds, to, m.id);
    if (msg === REPLAYED) return false;
    this._remember(m, msg);
    if (msg?.kind === 'reaction') {
      // A read receipt: "I've read this conversation up to here".
      if (Number.isInteger(msg.body?.read) && msg.body.read > 0) {
        const key = `${m.from}|${peer ?? ''}`;
        if (msg.body.read > (this.reads.get(key) ?? 0)) this.reads.set(key, Math.min(msg.body.read, m.seq));
        this.emit('receipts');
        return { kind: 'reaction', id: m.id, from: m.from, to, peer, seq: m.seq, body: msg.body };
      }
      if (isPollUpdate(msg.body)) this._applyPollUpdate(m.from, m.seq, msg.body);
      else this._applyReaction(m.from, m.seq, msg.body);
      return { kind: 'reaction', id: m.id, from: m.from, to, peer, seq: m.seq, body: msg.body };
    }
    if (msg?.kind === 'chat' && msg.body?.pollSpin) this._applyPollSpin(m.from, m.seq, msg.ts, msg.body.pollSpin);
    // What you sent the agent alongside a question or Remember in the group:
    // only for the agent, not a conversation of its own.
    if (msg?.kind === 'chat' && msg.body?.agentCopy) {
      // The agent's answer to an app request (agentRpc).
      const r = msg.body.rpcResult;
      if (r && m.from === this.circle?.agent?.id) {
        const whole = this._rpcWhole(r);
        if (whole) {
          this._rpcWaiters.get(r.id)?.(whole);
          this._rpcWaiters.delete(r.id);
        }
      }
      return { kind: 'agentCopy', id: m.id, from: m.from, to, peer, seq: m.seq, body: msg.body };
    }
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

  // --- ticks ---------------------------------------------------------------
  // ✓ sent (the server has it), ✓✓ delivered (every recipient's phone has it),
  // read (every recipient has read it). Recipients: the other person in a
  // direct chat, or everyone who was in the circle when it was sent.

  /** Tell the others you've read a conversation up to `seq` (sealed, silent). */
  sendReadReceipt(peer, seq) {
    if (!Number.isInteger(seq) || seq <= (this.reads.get(`${this.account.memberId}|${peer ?? ''}`) ?? 0)) return Promise.resolve();
    this.reads.set(`${this.account.memberId}|${peer ?? ''}`, seq);
    return this._post('reaction', { read: seq }, { silent: true, to: peer });
  }

  _recipients(m) {
    if (m.peer) return [m.peer];
    return [...this.members.values()].filter((x) => !x.isMe && !x.removed && x.kind !== 'agent' && x.joinedAt <= m.createdAt).map((x) => x.id);
  }

  /** For your own message: 'sent', 'delivered' or 'read'. */
  receipt(m) {
    const to = this._recipients(m);
    if (!to.length) return 'sent';
    if (to.every((id) => (this.reads.get(`${id}|${m.peer ?? ''}`) ?? 0) >= m.seq)) return 'read';
    if (to.every((id) => (this.delivered.get(id) ?? 0) >= m.seq)) return 'delivered';
    return 'sent';
  }

  /** Who has read, has, or hasn't got your message yet: { read, delivered, waiting } (names). */
  receiptsFor(m) {
    const out = { read: [], delivered: [], waiting: [] };
    for (const id of this._recipients(m)) {
      const name = this.members.get(id)?.name || 'Former member';
      if ((this.reads.get(`${id}|${m.peer ?? ''}`) ?? 0) >= m.seq) out.read.push(name);
      else if ((this.delivered.get(id) ?? 0) >= m.seq) out.delivered.push(name);
      else out.waiting.push(name);
    }
    return out;
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
    // The time zone, so reminders come at a sensible hour where the family is.
    let tz = null;
    try {
      tz = Intl.DateTimeFormat().resolvedOptions().timeZone || null;
    } catch {
      // not known on this device
    }
    return { asker: this.myName, agentName: this.circle?.agent?.name, people: this.memberList().map((m) => ({ id: m.id, name: m.name })), tz };
  }

  /** Whether this server can run an agent: { available, running }. */
  async agentHostStatus() {
    const { available, running } = await this.api.agentHost();
    return { available, running };
  }

  /**
   * Admins: add the circle's agent, named `name`, run by this server. The
   * invite goes to the server's agent host sealed to its key, so the server
   * itself never sees it.
   */
  async setUpAgent({ name }) {
    const host = await this.api.agentHost();
    if (!host.available) throw new Error('This server doesn’t run agents yet. Turn on AGENT=true (or run_agent in the Home Assistant app).');
    const { link } = await this.createAgentInvite({ name, hours: 1 });
    await this.api.agentSetup({ from: this.account.identity.boxPub, box: sealToKey({ link }, host.boxPub, this.account.identity.boxSecret) });
    await this.refresh();
    const agent = this.agent;
    // Everyone is told, in the group chat.
    if (agent) await this._post('chat', { text: `🤖 ${this.myName} added ${agent.name}, the circle’s helper. Ask it with “/${agent.name} …”. It only sees what you send it, never your chats.`, agentAdded: true });
    return agent;
  }

  /**
   * Ask the agent for something the app shows (the Memory screen, its
   * settings): sealed for it like any message, never shown in a chat.
   * Resolves with its answer; rejects with its error.
   */
  /** The agent's whole answer, once every part of a big one is here (null until then). */
  _rpcWhole(r) {
    if (!(r.parts > 1)) return r;
    if (!this._rpcWaiters.has(r.id)) return null;
    const got = this._rpcParts.get(r.id) ?? [];
    got[r.part] = String(r.chunk ?? '');
    this._rpcParts.set(r.id, got);
    if (got.filter((c) => c != null).length < r.parts) return null;
    this._rpcParts.delete(r.id);
    try {
      return JSON.parse(got.join(''));
    } catch {
      return { ok: false, error: 'The agent’s answer didn’t come through whole. Try again.' };
    }
  }

  async agentRpc(op, args = {}, { timeoutMs = 60_000 } = {}) {
    const agent = this.agent;
    if (!agent) throw new Error('This circle has no agent');
    const id = randomId(9);
    const answer = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._rpcWaiters.delete(id);
        this._rpcParts.delete(id);
        reject(new Error(`${agent.name} didn’t answer. Is the server running it?`));
      }, timeoutMs);
      this._rpcWaiters.set(id, (r) => {
        clearTimeout(timer);
        if (r.ok) resolve(r.data);
        else reject(new Error(r.error || 'The agent couldn’t do that'));
      });
    });
    await this._post('chat', { rpc: { id, op, args }, agentCopy: true, thread: 'dm', ...this._agentContext() }, { to: agent.id, silent: true });
    // The answer arrives live; without a live connection, look for it.
    const poll = setInterval(() => !this.connection && this.fetchMessages().catch(() => {}), 1000);
    try {
      return await answer;
    } finally {
      clearInterval(poll);
    }
  }

  /** Undo what the agent just remembered (the Undo on its "📌 Remembered" message). */
  async undoAgent(noteIds, { peer = null } = {}) {
    const agent = this.agent;
    if (!agent) throw new Error('This circle has no agent');
    await this._post('chat', { undo: noteIds, thread: peer ? 'dm' : 'group', agentCopy: true, ...this._agentContext() }, { to: agent.id, silent: true });
  }

  /**
   * Send the agent a file (a photo, a PDF, a document, a spreadsheet). It's
   * encrypted here with a key of its own; the server stores only that, and
   * the key goes to the agent sealed for it. In the group (`peer` null)
   * everyone sees "/Name 📎 file" and the agent's answer; in a chat with the
   * agent, only you do.
   */
  async sendFileToAgent(bytes, { name, mime }, { peer = null } = {}) {
    const agent = this.agent;
    if (!agent) throw new Error('This circle has no agent');
    if (peer && peer !== agent.id) throw new Error('Send files to the agent in the group or in a chat with it');
    if (!(bytes instanceof Uint8Array) || !bytes.length) throw new Error('That file is empty');
    if (bytes.length > 15 * 1024 * 1024) throw new Error('That file is too big (over 15 MB)');
    const fileName = String(name || 'file').replace(/[\r\n/\\]+/g, ' ').slice(0, 120);
    const { key, data } = encryptFile(bytes);
    const { id: fileId } = await this.api.uploadFile(data);
    const upload = { id: fileId, key, name: fileName, mime: String(mime || 'application/octet-stream').slice(0, 100), size: bytes.length };
    const id = randomId(12);
    if (peer) {
      await this._post('chat', { text: `📎 ${fileName}`, upload, thread: 'dm', ...this._agentContext() }, { to: agent.id, id });
      return id;
    }
    await this._post('chat', { text: `/${agent.name} 📎 ${fileName}`, agentAsk: true }, { id });
    await this._post('chat', { upload, thread: 'group', replyTo: id, agentCopy: true, ...this._agentContext() }, { to: agent.id, silent: true });
    return id;
  }

  /** After a file was read and saved: delete it from the server, or keep it (it then shows in Memory). */
  async answerAgentFile(choiceId, keep, { peer = null } = {}) {
    const agent = this.agent;
    if (!agent) throw new Error('This circle has no agent');
    await this._post('chat', { fileChoice: { id: choiceId, keep: !!keep }, thread: peer ? 'dm' : 'group', agentCopy: true, ...this._agentContext() }, { to: agent.id, silent: true });
  }

  /** Done on a reminder the helper sent (a yearly one moves to next year). */
  async doneAgentReminder(reminderId, { peer = null } = {}) {
    const agent = this.agent;
    if (!agent) throw new Error('This circle has no agent');
    await this._post('chat', { reminderDone: { id: reminderId }, thread: peer ? 'dm' : 'group', agentCopy: true, ...this._agentContext() }, { to: agent.id, silent: true });
  }

  /** A kept file's bytes ({ id, key } from its note in Memory). */
  async openAgentFile({ id, key }) {
    return decryptFile(await this.api.downloadFile(id), key);
  }

  /** Save (ok) or Discard a list the agent found (the dates in a calendar PDF). */
  async saveAgentFound(id, ok, { peer = null } = {}) {
    const agent = this.agent;
    if (!agent) throw new Error('This circle has no agent');
    await this._post('chat', { saveFound: { id, ok: !!ok }, thread: peer ? 'dm' : 'group', agentCopy: true, ...this._agentContext() }, { to: agent.id, silent: true });
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
    const remember = { text: text.slice(0, 20000), by: this.members.get(m.from)?.name || 'Someone', at: m.ts, scope: m.peer ? 'private' : 'circle' };
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
    await this._post('chat', { text: `🆘 ${name} sent an SOS. Open HomeCircle to see where they are.`, sos: { state: 'start' } }, { id, urgent: true });
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
    return this._post('chat', { text: `✅ ${name} is safe now.`, sos: { state: 'safe', of: sosId } }, { urgent: true });
  }

  /**
   * SOSes still on, newest first: [{ id, memberId, name, since, arrived }].
   * One ends with "I'm safe" from its sender, when they leave the circle, or
   * after a day without one (a phone that died mid-SOS).
   */
  activeSos(now = Date.now()) {
    if (!this.feature('sos')) return [];
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

  // --- call-back requests ------------------------------------------------
  // From the Elderly Companion app: "call me back", to everyone in the circle
  // or to one person (`for`). A group chat message with `body.callback`
  // (older apps show its text); replies point at it with `of`. Only "I'm
  // calling you now" closes it. No server changes: it's all sealed messages.

  /**
   * Ask for a call back: everyone (`to` null) or one member. `tz` is the
   * asker's time zone, `awake` whether it's outside their sleep hours, and
   * `remind` the minutes between reminders on the family's phones (0: none).
   * Returns the request's id.
   */
  async askCallback({ to = null, tz = null, awake = true, remind = 0 } = {}) {
    if (to && !this.members.get(to)) throw new Error('No such member in this circle');
    const id = randomId(12);
    const name = this.myName;
    const who = to ? ` from ${this.members.get(to).name}` : '';
    const callback = { state: 'ask', for: to ? [to] : null, tz: cleanTimeZone(tz), awake: awake !== false, remind: cleanRemind(remind) };
    await this._post('chat', { text: `📞 ${name} would like a call back${who}. Update HomeCircle to reply.`, callback }, { id, urgent: true });
    return id;
  }

  /** Answer a call-back request: 'now' (which closes it), '5min', 'morning' or 'evening'. */
  replyCallback(requestId, reply) {
    if (!CALLBACK_REPLIES.includes(reply)) return Promise.reject(new Error('Not a call-back reply'));
    const req = this._callbackRequest(requestId);
    if (!req) return Promise.reject(new Error('No such call-back request'));
    const name = this.myName;
    return this._post('chat', { text: `📞 ${name}: ${CALLBACK_REPLY_TEXT[reply]}`, callback: { state: 'reply', of: requestId, reply } }, { urgent: true });
  }

  _callbackRequest(id) {
    const m = this.messages.find((x) => x.id === id && x.kind === 'chat' && !x.peer && x.body?.callback?.state === 'ask');
    return m && this._callbackName(m.from) ? m : null;
  }

  /** A member's name, or null if they left. Background tasks have only the pinned names. */
  _callbackName(id) {
    const m = this.members.get(id);
    if (m) return m.removed ? null : m.name;
    return this.account?.known[id]?.name ?? null;
  }

  /**
   * Where a request stands: who asked, who was asked, each person's latest
   * reply, and who took it (the first "now"; the request is then closed).
   */
  callbackState(requestId) {
    const req = this._callbackRequest(requestId);
    if (!req) return null;
    const c = req.body.callback;
    const asked = Array.isArray(c.for) ? c.for.filter((id) => typeof id === 'string').slice(0, MAX_MEMBERS_ASKED) : null;
    const replies = new Map(); // memberId -> latest reply
    let takenBy = null;
    for (const m of this.messages) {
      const r = m.kind === 'chat' && !m.peer && m.seq > req.seq ? m.body?.callback : null;
      if (!r || r.state !== 'reply' || r.of !== requestId || !CALLBACK_REPLIES.includes(r.reply)) continue;
      const name = m.from === req.from ? null : this._callbackName(m.from);
      if (!name) continue;
      replies.set(m.from, { memberId: m.from, name, reply: r.reply, ts: m.ts, seq: m.seq });
      if (r.reply === 'now' && !takenBy) takenBy = { memberId: m.from, name, ts: m.ts };
    }
    return {
      id: req.id,
      from: req.from,
      name: this._callbackName(req.from),
      ts: req.ts,
      seq: req.seq,
      for: asked,
      tz: cleanTimeZone(c.tz),
      awake: c.awake !== false,
      remind: cleanRemind(c.remind),
      replies: [...replies.values()].sort((a, b) => a.seq - b.seq),
      takenBy,
      open: !takenBy,
    };
  }

  /** Whether a request asks this member (everyone, or them by name). */
  callbackAsks(state, memberId = this.account?.memberId) {
    return !!state && state.from !== memberId && (!state.for || state.for.includes(memberId));
  }

  /** Open requests in this circle, newest first (optionally only those from one member). */
  openCallbacks({ from = null } = {}) {
    const out = [];
    for (const m of this.messages) {
      if (m.kind !== 'chat' || m.peer || m.body?.callback?.state !== 'ask' || (from && m.from !== from)) continue;
      const s = this.callbackState(m.id);
      if (s?.open) out.push(s);
    }
    return out.sort((a, b) => b.seq - a.seq);
  }

  /**
   * Open requests this phone should keep reminding about: they ask this
   * member, have reminders on, and this member hasn't replied yet.
   */
  callbacksAwaitingMe() {
    const me = this.account?.memberId;
    return this.openCallbacks().filter((s) => s.remind > 0 && this.callbackAsks(s, me) && !s.replies.some((r) => r.memberId === me));
  }

  // --- records: member settings and family names --------------------------
  //
  // Sealed and signed, kept on the server by kind and subject (it checks who
  // may write from the ids alone). A member record holds admin settings about
  // one member (her skin and Elderly Companion settings, someone's he/she)
  // and counts only if an admin signed it. An alias is what one member calls
  // another ("Nani"), set by either of them or an admin; it counts only if
  // one of those signed it. The latest valid copy wins.

  _isAdminMember(id) {
    const m = this.members.get(id);
    return !!m && !m.removed && (m.role === 'owner' || m.role === 'admin');
  }

  async fetchRecords() {
    const { records } = await this.api.records();
    const member = new Map();
    const alias = new Map();
    for (const r of records) {
      const msg = this._open(r.env, r.by, [r.kind]);
      if (!msg || msg === REPLAYED) continue;
      if (r.kind === 'member') {
        const body = cleanMemberRecord(msg.body);
        if (body && body.member === r.subject && this._isAdminMember(r.by)) member.set(r.subject, { ...body, by: r.by, ts: msg.ts });
      } else if (r.kind === 'alias') {
        const body = cleanAlias(msg.body);
        const allowed = body && (r.by === body.caller || r.by === body.member || this._isAdminMember(r.by));
        if (allowed && `${body.caller}.${body.member}` === r.subject) alias.set(r.subject, { ...body, by: r.by, ts: msg.ts });
      }
    }
    this.records = { member, alias };
    this.emit('records', this.records);
    return this.records;
  }

  async _putRecord(kind, subject, body) {
    await this._withEpochRetry(() => this.api.putRecord(kind, subject, this._seal(kind, body)));
    await this.fetchRecords();
  }

  /** Admin settings about a member, or null: { member, skin, page, ringEveryone, games, tiles, sleep, remindEvery, inactiveHours, lang, g }. */
  memberRecord(memberId) {
    return this.records.member.get(memberId) ?? null;
  }

  /** Admins: change settings about a member (merged into what's there). */
  async setMemberRecord(memberId, patch) {
    if (!this.isAdmin) throw new Error('Only circle admins can change that');
    if (!this.members.get(memberId)) throw new Error('No such member in this circle');
    const { by, ts, ...current } = this.memberRecord(memberId) ?? {};
    const body = cleanMemberRecord({ ...current, ...patch, member: memberId });
    await this._putRecord('member', memberId, body);
    return this.memberRecord(memberId);
  }

  /**
   * Admins: mark someone as an elder. Their phone switches to `skin` (the
   * Elderly Companion screens by default), and they stop being an admin;
   * only the owner can do that to an admin, and nobody to the owner.
   */
  async markElder(memberId, settings = {}) {
    const m = this.members.get(memberId);
    if (!m || m.removed) throw new Error('No such member in this circle');
    if (m.role === 'owner') throw new Error('The circle’s owner can’t be marked as an elder');
    if (m.role === 'admin' && this.me?.role !== 'owner') throw new Error(`${m.name} is an admin. Only the circle’s owner can mark them as an elder.`);
    const record = await this.setMemberRecord(memberId, { skin: 'elderly', ...settings });
    if (m.role === 'admin') await this.setRole(memberId, 'member');
    return record;
  }

  /** What `callerId` calls `memberId` ("Nani"), or null. */
  familyName(callerId, memberId) {
    return this.records.alias.get(`${callerId}.${memberId}`)?.name || null;
  }

  /** How to name a member to a viewer (you by default): their family name for them, else their own name. */
  displayName(memberId, viewerId = this.account?.memberId) {
    return this.familyName(viewerId, memberId) || this.members.get(memberId)?.name || this.account?.known[memberId]?.name || 'Former member';
  }

  /**
   * Set what `callerId` calls `memberId` (empty `name` removes it). Either of
   * them, or an admin, can.
   */
  async setFamilyName(callerId, memberId, { name, rel = null } = {}) {
    const me = this.account.memberId;
    if (callerId === memberId) throw new Error('A family name is what one person calls another');
    if (me !== callerId && me !== memberId && !this.isAdmin) throw new Error('Only either of them or an admin can set that');
    const subject = `${callerId}.${memberId}`;
    const clean = cleanName(name);
    if (!clean) {
      await this._withEpochRetry(() => this.api.deleteRecord('alias', subject));
      await this.fetchRecords();
      return null;
    }
    await this._putRecord('alias', subject, cleanAlias({ caller: callerId, member: memberId, name: clean, rel }));
    return this.familyName(callerId, memberId);
  }

  /** A member's he/she for languages whose verbs need it: their own choice, else an admin's, else null. */
  genderOf(memberId) {
    return this.members.get(memberId)?.g || this.memberRecord(memberId)?.g || null;
  }

  // --- photos -------------------------------------------------------------
  // A photo is a file encrypted on the phone with a key of its own; the
  // server keeps the ciphertext, and the key travels only inside a sealed
  // profile (your own photo) or member record (photos an admin adds for an
  // elder's tiles). A new photo replaces the old one, whose file is deleted.

  async _uploadPhoto(bytes) {
    if (!(bytes instanceof Uint8Array) || !bytes.length) throw new Error('That photo is empty');
    if (bytes.length > 2 * 1024 * 1024 - 64) throw new Error('That photo is too big (over 2 MB)');
    const { key, data } = encryptFile(bytes);
    const { id } = await this.api.uploadFile(data, { purpose: 'photo' });
    return { id, key, at: Date.now() };
  }

  /** Set your own photo (JPEG bytes), or remove it (null). */
  async setProfilePhoto(bytes) {
    const old = cleanPhotoRef(this.account.profile.photo);
    this.account.profile.photo = bytes ? await this._uploadPhoto(bytes) : undefined;
    await this.api.putProfile(this._seal('profile', this._profileBody()));
    await this._save();
    if (old) await this.api.deleteFile(old.id).catch(() => {});
    await this.refresh();
  }

  /**
   * Admins: set the photo on an elder's tile for someone (JPEG bytes), or
   * remove it (null). Their own photo, if they add one, comes first.
   */
  async setTilePhoto(elderId, memberId, bytes) {
    const photos = { ...(this.memberRecord(elderId)?.photos ?? {}) };
    const old = photos[memberId];
    if (bytes) photos[memberId] = await this._uploadPhoto(bytes);
    else delete photos[memberId];
    await this.setMemberRecord(elderId, { photos });
    if (old) await this.api.deleteFile(old.id).catch(() => {});
  }

  /** The photo an elder's tile shows for someone: their own, else an admin's, else null. */
  tilePhoto(elderId, memberId) {
    return this.members.get(memberId)?.photo || this.memberRecord(elderId)?.photos?.[memberId] || null;
  }

  /** A photo's bytes ({ id, key } from a profile or record). */
  async photoBytes(ref) {
    const r = cleanPhotoRef(ref);
    if (!r) throw new Error('No such photo');
    return decryptFile(await this.api.downloadFile(r.id), r.key);
  }

  /** Your own he/she ('m', 'f', or null to clear it), in your profile. */
  async setGender(g) {
    this.account.profile.g = GENDERS.includes(g) ? g : undefined;
    await this.api.putProfile(this._seal('profile', this._profileBody()));
    await this._save();
    await this.refresh();
  }

  /**
   * An elder's phone, once joined: tell the circle (a readable line), so an
   * admin's phone can save her settings as a member record.
   */
  announceElder({ page = 'care', skin = 'elderly' } = {}) {
    const elder = cleanCompanionInvite({ name: this.myName, page, skin });
    return this._post('chat', { text: `👵 ${this.myName} joined with the Elderly Companion screens.`, elderJoined: { page: elder.page, skin: elder.skin } });
  }

  /** Elders who announced themselves and have no member record yet: [{ memberId, page, skin }]. */
  unrecordedElders() {
    const out = new Map();
    for (const m of this.messages) {
      const e = m.kind === 'chat' && !m.peer ? m.body?.elderJoined : null;
      if (!e || !this.members.get(m.from) || this.memberRecord(m.from)) continue;
      const clean = cleanCompanionInvite({ page: e.page, skin: e.skin });
      out.set(m.from, { memberId: m.from, page: clean.page, skin: clean.skin });
    }
    return [...out.values()];
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
      let since = Date.now();
      for (const m of messages) {
        this._addMessage(m);
        this.fetchedSeq = Math.max(this.fetchedSeq, m.seq);
        // Opening a message takes tens of ms on a phone: after every ~12 ms of
        // it, let the screen draw and taps through, instead of freezing for
        // the whole page (a first load can be hundreds of messages).
        if (Date.now() - since > 12) {
          await yieldToUi();
          since = Date.now();
        }
      }
      if (messages.length) this.emit('messages', this.messages);
      if (messages.length < 500) break;
    }
    this._saveCacheSoon();
    this.emit('messages', this.messages);
    return this.messages;
  }

  // --- this phone's copy of the messages ----------------------------------

  get _cacheKey() {
    return `${this.accountKey}.messages`;
  }

  /** Keep what a message opened to, for the cache (failures keep the envelope, to try again). */
  _remember(m, msg) {
    if (!this.cache || !Number.isInteger(m.seq)) return;
    // The helper's answers to the app (Memory and the like) are never shown: not kept.
    if (msg?.body?.agentCopy && msg.body.rpcResult) return;
    this._cacheRows.set(m.seq, {
      seq: m.seq,
      id: m.id,
      from: m.from,
      to: m.to ?? null,
      createdAt: m.createdAt,
      ...(msg ? { opened: msg, env: { nonce: m.env?.nonce, epoch: m.env?.epoch } } : { env: m.env }),
    });
    if (!this._cacheTimer) this._saveCacheSoon();
  }

  /** The messages this phone already opened, back in place without opening them again. */
  async _loadCache() {
    if (!this.cache || this._cacheLoaded) return;
    this._cacheLoaded = true;
    let c = null;
    try {
      c = JSON.parse((await this.cache.getItem(this._cacheKey)) || 'null');
    } catch (e) {
      this.onError(e);
    }
    if (!c || c.v !== 1 || c.circleId !== this.account.circleId || c.memberId !== this.account.memberId || !Array.isArray(c.rows)) return;
    for (const [i, row] of c.rows.entries()) {
      this._addMessage(row);
      if (i % 200 === 199) await yieldToUi();
    }
    // Only messages after these are fetched.
    this.fetchedSeq = Math.max(this.fetchedSeq, Number(c.fetchedSeq) || 0);
    this.emit('messages', this.messages);
  }

  _saveCacheSoon() {
    if (!this.cache) return;
    clearTimeout(this._cacheTimer);
    this._cacheTimer = setTimeout(() => {
      this._cacheTimer = null;
      this._saveCache().catch(this.onError);
    }, 2000);
  }

  /** Kept as long as the circle keeps messages, and at most the newest 6000. */
  async _saveCache() {
    if (!this.cache || !this.account) return;
    const days = this.state?.retentionDays ?? 90;
    const since = Date.now() - days * 86400_000;
    const rows = [...this._cacheRows.values()].filter((r) => !r.createdAt || r.createdAt >= since).sort((a, b) => a.seq - b.seq);
    const kept = rows.slice(-6000);
    if (kept.length < this._cacheRows.size) this._cacheRows = new Map(kept.map((r) => [r.seq, r]));
    await this.cache.setItem(this._cacheKey, JSON.stringify({ v: 1, circleId: this.account.circleId, memberId: this.account.memberId, fetchedSeq: this.fetchedSeq, rows: kept }));
  }

  async _post(kind, body, { silent = false, to = null, id = randomId(12), urgent = false } = {}) {
    let env;
    const res = await this._withEpochRetry(() => {
      env = this._seal(kind, body, this.account.epoch, { to, id });
      return this.api.postMessage(id, env, { silent, to, urgent });
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
    // Arrived/left alerts only where the circle has place alerts on.
    if (body?.type === 'place' && !this.feature('placeAlerts')) return;
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

  /**
   * Invite someone. `companion` makes it an elder's invite: her name, which
   * page this circle is on her phone ('care' or 'grandkids') and the skin it
   * shows travel sealed inside it, so nobody types on her phone and it
   * switches to her screens as soon as it joins.
   */
  async createInvite({ hours = 48, companion = null } = {}) {
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
      ...(companion ? { companion: cleanCompanionInvite(companion) } : {}),
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
    if (!this.feature('frequentPlaces')) return;
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

  /**
   * Load everything and keep it live while the app is in the foreground.
   * Started before (coming back to the app): connect again and catch up.
   * Locations come before messages, and the live connection opens before
   * the messages are fetched, so the map is right even while a long
   * history is still being opened.
   */
  async start() {
    if (this._started) {
      this.connect();
      return this.catchUp();
    }
    await this.refresh();
    await this._loadCache();
    await Promise.all([this.fetchLocations(), this.fetchPlaces(), this.fetchRecords().catch(() => {})]);
    this.connect();
    await this.fetchMessages();
    this._started = true;
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

  /**
   * Fetch whatever changed while the live connection was down. One at a
   * time: asked again while one runs (a flaky network reconnecting over and
   * over), it runs once more afterwards instead of in parallel.
   */
  catchUp() {
    if (this._catching) {
      this._catchAgain = true;
      return this._catching;
    }
    this._catching = (async () => {
      try {
        do {
          this._catchAgain = false;
          await this.refresh();
          await Promise.all([this.fetchLocations(), this.fetchPlaces()]);
          await this.fetchMessages();
        } while (this._catchAgain && this.account);
      } finally {
        this._catching = null;
      }
    })();
    return this._catching;
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
        this._saveCacheSoon();
        if (m) {
          this.emit('messages', this.messages);
          if (m.from !== this.account.memberId && m.kind !== 'reaction') this.emit('newMessage', m);
        }
        break;
      }
      case 'delivered': {
        for (const [id, seq] of Object.entries(e.delivered || {})) {
          if (Number.isInteger(seq) && seq > (this.delivered.get(id) ?? 0)) this.delivered.set(id, seq);
        }
        this.emit('receipts');
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
      case 'plugin':
        // An admin saved a plugin's settings (Home Assistant: send it your position now).
        this.emit('plugin', e.id);
        break;
      case 'frequent':
        await this.fetchFrequent();
        break;
      case 'records':
        await this.fetchRecords().catch(() => {});
        break;
      default:
        break;
    }
  }
}

/** { stop, moving, still, charging, limited } or null: what a phone said about how often it updates. */
function cleanCadence(c) {
  if (!c || typeof c !== 'object') return null;
  const min = (v) => (Number.isFinite(v) && v > 0 && v <= 24 * 60 ? Math.round(v * 10) / 10 : null);
  const moving = min(c.moving);
  const still = min(c.still);
  if (moving == null || still == null) return null;
  const stop = Number.isInteger(c.stop) && c.stop >= 1 && c.stop <= 6 ? c.stop : 'custom';
  return { stop, moving, still, charging: c.charging === true, limited: c.limited === true };
}

/**
 * What an elder's invite says: { name, page, skin }, or null. `skin` names
 * the screens her phone shows (the apps keep the list; 'elderly' by default).
 */
function cleanCompanionInvite(c) {
  if (!c || typeof c !== 'object') return null;
  const skin = typeof c.skin === 'string' && /^[a-z]{2,16}$/.test(c.skin) ? c.skin : 'elderly';
  return { name: cleanName(c.name), page: c.page === 'grandkids' ? 'grandkids' : 'care', skin };
}

export const GENDERS = ['m', 'f'];
const ALIAS_RELS = ['grandparent', 'grandchild', 'parent', 'child', 'sibling', 'other'];
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const MAX_TILES = 50;

/** A member record as sealed: only known fields, each checked. */
function cleanMemberRecord(b) {
  if (!b || typeof b !== 'object' || typeof b.member !== 'string' || !b.member) return null;
  const bool = (v) => (typeof v === 'boolean' ? v : null);
  const int = (v, lo, hi) => (Number.isInteger(v) && v >= lo && v <= hi ? v : null);
  const sleep = b.sleep && HHMM.test(b.sleep.from) && HHMM.test(b.sleep.to) ? { from: b.sleep.from, to: b.sleep.to } : null;
  return {
    member: b.member,
    skin: typeof b.skin === 'string' && /^[a-z]{2,16}$/.test(b.skin) ? b.skin : 'full',
    page: b.page === 'care' || b.page === 'grandkids' ? b.page : null,
    ringEveryone: bool(b.ringEveryone),
    games: bool(b.games),
    tiles: Array.isArray(b.tiles) ? [...new Set(b.tiles.filter((x) => typeof x === 'string'))].slice(0, MAX_TILES) : null,
    sleep,
    remindEvery: int(b.remindEvery, 1, 240),
    inactiveHours: int(b.inactiveHours, 1, 168),
    lang: typeof b.lang === 'string' && /^[a-z]{2,3}$/.test(b.lang) ? b.lang : null,
    g: GENDERS.includes(b.g) ? b.g : null,
    photos: cleanPhotoMap(b.photos),
  };
}

/** A photo reference: { id, key, at } of an encrypted file, or null. */
function cleanPhotoRef(p) {
  if (!p || typeof p.id !== 'string' || !/^[A-Za-z0-9_-]{16,40}$/.test(p.id) || typeof p.key !== 'string' || !/^[A-Za-z0-9_-]{40,48}$/.test(p.key)) return null;
  return { id: p.id, key: p.key, at: typeof p.at === 'number' ? p.at : 0 };
}

function cleanPhotoMap(m) {
  if (!m || typeof m !== 'object') return null;
  const out = {};
  for (const [id, ref] of Object.entries(m).slice(0, MAX_TILES)) {
    const r = cleanPhotoRef(ref);
    if (r) out[id] = r;
  }
  return out;
}

/** A family name as sealed: who calls whom what, and how they're related (optional). */
function cleanAlias(b) {
  if (!b || typeof b.caller !== 'string' || typeof b.member !== 'string' || b.caller === b.member) return null;
  const name = cleanName(b.name);
  if (!name) return null;
  return { caller: b.caller, member: b.member, name, rel: ALIAS_RELS.includes(b.rel) ? b.rel : null };
}

/** An IANA time zone name such as "Asia/Karachi", or null. */
function cleanTimeZone(tz) {
  return typeof tz === 'string' && /^[A-Za-z][A-Za-z0-9_+\-/]{0,63}$/.test(tz) ? tz : null;
}

/** Minutes between call-back reminders: 0 (none) up to 4 hours. */
function cleanRemind(m) {
  return Number.isInteger(m) && m > 0 ? Math.min(240, m) : 0;
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
