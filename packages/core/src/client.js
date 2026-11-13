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
  openFromKey,
  newBoxKeyPair,
  browserLinkUrl,
} from './crypto.js';
import { isValidReaction } from './emoji.js';
import { MESH_TEXT_MAX, openMesh, sealMeshMessage } from './mesh.js';
import { utf8Encode } from './encoding.js';
import { quickReturns } from './places.js';
import { FREE_RE, PLAN_ANSWERS, TRAVEL_RE, busyDays, cleanBusy, cleanPlan, travelStats, tripsFrom } from './schedule.js';
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
/** Every answer a request can get: the four buttons, and 'asleep', which a phone sends by itself. */
export const CALLBACK_ANSWERS = [...CALLBACK_REPLIES, 'asleep'];
/** A group call is on this long after it started or someone last joined. */
export const GROUP_CALL_OPEN_MS = 30 * 60_000;
// A call in HomeCircle ends when everyone has left. This is for phones that vanished without saying so.
const MESH_CALL_OPEN_MS = 4 * 60 * 60_000;

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
// A call signal signed longer ago than this, or further ahead (clocks differ), isn't part of a call now.
const CALL_SIGNAL_MAX_AGE_MS = 90_000;
const CALL_SIGNAL_MAX_SKEW_MS = 120_000;

/** Let the screen draw and taps through (a macrotask), then carry on. */
const yieldToUi = () => new Promise((r) => setTimeout(r, 0));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// History is fetched newest first: the latest page opens the chat, older
// pages fill in behind it. Opening a message (checking its signature) takes
// tens of ms on a phone, so the first page is small.
const FIRST_PAGE = 80;
const FORWARD_PAGE = 500;
const OLDER_PAGE = 100;
// The most messages kept on the phone between launches.
const CACHE_MAX = 500;

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
    this.busy = new Map();
    this.plans = new Map();
    // Sealed records (fetchRecords): member settings by member id, and
    // family names by "caller.member".
    this.records = { member: new Map(), alias: new Map() };
    // The newest message seen, live or fetched.
    this.lastSeq = 0;
    // Where the next fetch starts: moved only by fetches. Messages that arrive
    // live can't move it, or a catch-up after reconnecting would skip whatever
    // was sent just before them.
    this.fetchedSeq = 0;
    // History is held from here up to fetchedSeq: older than this is not
    // fetched yet (0 = all of it is). Fetching starts from the newest
    // messages and works back, so this is what reading further back needs.
    this.backSeq = 0;
    this._generation = (this._generation || 0) + 1;
    this.connection = null;
    this.status = 'offline';
    // Opened envelopes, so the same location, place or profile isn't
    // decrypted and checked again on every refresh: "from|to|id|ct" -> msg.
    this._opened = new Map();
    this._seenCalls = new Set(); // ids of call signals already handled
    // Messages as opened, kept on this phone between launches (opts.cache):
    // a cold start then only opens what's new. seq -> row.
    this._cacheRows = new Map();
    this._cacheLoading = null;
    this._cacheTimer = null;
    this._cacheDue = 0;
    this._cacheDirty = false;
    this._saving = Promise.resolve();
    this._rawLocations = null;
    // Fetches of messages take turns; reading further back is its own queue.
    this._fetchLock = Promise.resolve();
    this._olderLock = Promise.resolve();
    this._backfilling = null;
    this._backfillStop = false;
    this.backfillPauseMs = 150;
    // How long the pieces of opening took, for Diagnostics.
    this.timings = {};
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
   * Forget this device's keys locally. A browser signed in from the phone is
   * signed out on the server too (its own token), when the server is reachable. `reason` is passed on with the
   * 'signedOut' event so apps can log why: 'signed_out' (the person chose
   * to), 'left', 'deleted_circle', 'removed' or 'circle_deleted'.
   */
  async signOut(reason = 'signed_out') {
    if (this.account?.browser && this.api && reason === 'signed_out') await this.api.deleteSession('current').catch(() => {});
    this.disconnect();
    clearTimeout(this._cacheTimer);
    this._generation++;
    // A save still being written must not bring the cache back after it's deleted.
    await this._saving;
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

  /**
   * A browser asks to be signed in from a phone: a one-time key and a link id,
   * and `url` to show as a QR code. Keep the result (it holds the key) and
   * pass it to `finishLink`.
   */
  static async startLink(serverUrl, label, fetchImpl) {
    const server = normalizeServerUrl(serverUrl);
    const key = newBoxKeyPair();
    const res = await new Api(server, { fetchImpl }).startLink(key.boxPub, label);
    return { server, id: res.id, expiresAt: res.expiresAt, ...key, label, url: browserLinkUrl(server, res.id, key.boxPub, label) };
  }

  /**
   * The browser: wait for the phone to answer the QR code, then this client
   * is signed in as that member, with a token of its own. False if the code
   * expired first or `signal` was aborted.
   */
  async finishLink(link, { signal, every = 2000 } = {}) {
    const api = new Api(link.server, { fetchImpl: this.fetchImpl });
    while (!signal?.aborted && Date.now() < link.expiresAt) {
      const res = await api.pollLink(link.id);
      if (res?.state === 'linked') {
        const got = openFromKey(res.sealed, res.from, link.boxSecret);
        const a = got?.account;
        if (!a || typeof a.memberId !== 'string' || typeof a.circleId !== 'string' || !a.identity || !a.keyring) {
          throw new Error('The phone’s answer couldn’t be opened. Make a new code and try again.');
        }
        this.account = { ...a, server: link.server, token: res.token, browser: true };
        await this._save();
        this.api = this._makeApi(this.account.server, this.account.token);
        return true;
      }
      await new Promise((r) => setTimeout(r, every));
    }
    return false;
  }

  /**
   * The phone: sign in the browser that shows this QR code (read with
   * `parseBrowserLink`) as me. It gets a copy of this circle's keys, sealed
   * so only that browser can open them, and a token of its own.
   */
  async linkBrowser(link) {
    if (!this.account) throw new Error('Not signed in');
    if (normalizeServerUrl(link.server) !== normalizeServerUrl(this.account.server)) throw new Error('That code is for another server');
    const { token, browser, ...account } = this.account;
    const key = newBoxKeyPair();
    const sealed = sealToKey({ v: 1, account }, link.boxPub, key.boxSecret);
    return this.api.answerLink(link.id, { sealed, from: key.boxPub });
  }

  /** The browsers signed in as me (`current`: this one). */
  async browserSessions() {
    return (await this.api.sessions()).sessions;
  }

  /** Sign out a browser signed in as me. */
  async signOutBrowser(id) {
    await this.api.deleteSession(id);
  }

  /** This is a browser signed in from a phone (not the member's own device). */
  get isLinkedBrowser() {
    return !!this.account?.browser;
  }

  /** A one-time ticket for setting up from a phone, from the setup code, or a check of one: { code, expiresAt }. */
  static setupTicket(serverUrl, setupToken, fetchImpl) {
    return new Api(normalizeServerUrl(serverUrl), { fetchImpl }).setupTicket({ setupToken: String(setupToken || '').trim() });
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

  // --- messages over the mesh -----------------------------------------------
  //
  // With no internet, a phone can send a short message through the
  // Meshtastic tracker its person carries (over Bluetooth); the circle's home
  // base hands it to the server like a tracker's position. The packet is
  // sealed here, so nothing on the way can read it. Its tag uses this
  // member's mesh key, registered with the server over the internet first
  // (prepareMesh), since a packet can't prove who sent it otherwise.

  /** The most text (UTF-8 bytes) a mesh message carries: a group message, and a direct one. */
  get meshTextMax() {
    return MESH_TEXT_MAX;
  }

  /** Whether this text fits one mesh message. */
  meshFits(text, to = null) {
    return utf8Encode(String(text ?? '')).length <= (to ? MESH_TEXT_MAX.direct : MESH_TEXT_MAX.chat);
  }

  /** Whether this phone can send messages over the mesh (its mesh key is registered). */
  get meshReady() {
    return !!this.account?.meshKey;
  }

  /** Register this member's mesh key with the server, if it hasn't been yet. Needs the internet. */
  async prepareMesh() {
    if (this.account.meshKey) return;
    const key = randomId(32); // 32 random bytes, base64url
    await this.api.registerMesh(key);
    this.account.meshKey = key;
    await this._save();
  }

  /**
   * A message sealed for the mesh, for the tracker to send: { id, packet }
   * (packet: Uint8Array, one LoRa packet). Works offline once prepareMesh ran.
   */
  async meshMessage(text, { to = null, id = randomId(12) } = {}) {
    const t = String(text ?? '').trim();
    if (!t) throw new Error('Nothing to send');
    if (!this.account.meshKey) throw new Error('Messages over the mesh need this phone online once first.');
    if (!this.meshFits(t, to)) throw new Error(`Too long for the mesh: at most ${to ? MESH_TEXT_MAX.direct : MESH_TEXT_MAX.chat} bytes.`);
    const a = this.account;
    // Only ever goes up (the server refuses a counter it has seen): seconds now, or one more.
    const counter = Math.max((a.meshCounter ?? 0) + 1, Math.floor(Date.now() / 1000));
    a.meshCounter = counter;
    await this._save();
    const packet = sealMeshMessage({
      from: a.memberId,
      circle: a.circleId,
      epoch: a.epoch,
      key: a.keyring[a.epoch],
      meshKey: a.meshKey,
      signSecret: a.identity.signSecret,
      counter,
      id,
      text: t,
      toId: to,
      directKey: to ? this._directKey(to) : null,
    });
    return { id, packet };
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
      ...(cleanPhone(a.profile.phone) ? { phone: cleanPhone(a.profile.phone) } : {}),
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
    this._cacheDirty = true;
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
          view.phone = cleanPhone(p.body.phone);
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
      this.circle = { name: cleanName(msg.body.name) || 'Our Circle', agent: cleanAgentCard(msg.body.agent), groupCallLink: cleanCallLink(msg.body.groupCallLink) };
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
      .filter((m) => !m.removed && m.kind !== 'agent' && !this.hiddenDevice(m.id))
      .sort((a, b) => (a.isMe ? -1 : b.isMe ? 1 : a.name.localeCompare(b.name)));
  }

  /**
   * A device in the circle rather than a person: a tracker (a Meshtastic
   * tracker, a tracker phone) or a Meshtastic home base, as an admin's record
   * about it says.
   */
  isDevice(memberId) {
    const r = this.memberRecord(memberId);
    return !!(r?.tracker || r?.homeBase);
  }

  /**
   * A Meshtastic tracker or home base while the circle has the Meshtastic
   * plugin off: left out of the member list (the map, chats, counts) until
   * it's on again. Its record stays, so turning the plugin back on brings it back.
   */
  hiddenDevice(memberId) {
    if (this.feature('meshtastic')) return false;
    const r = this.memberRecord(memberId);
    return !!(r?.homeBase || r?.tracker?.node);
  }

  /** The circle's people: members who aren't trackers or a home base. */
  peopleList() {
    return this.memberList().filter((m) => !this.isDevice(m.id));
  }

  /** The circle's trackers and home bases. */
  deviceList() {
    return this.memberList().filter((m) => this.isDevice(m.id));
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
    // A packet that came over the mesh (a tracker's, or a phone's message sent
    // through its tracker): compact, sealed with the circle key and signed the
    // same way; a direct message's text is sealed again with the direct key.
    if (typeof env?.mesh === 'string') {
      try {
        const msg = openMesh(env.mesh, {
          key: this.account.keyring[env.epoch],
          signPub,
          from,
          circle: this.account.circleId,
          directKey: to ? key : null,
        });
        if (msg.epoch !== env.epoch || (id && msg.id !== id) || !kinds.includes(msg.kind)) return null;
        return msg;
      } catch (e) {
        this.onError(e);
        return null;
      }
    }
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
      // Do Not Disturb (or bedtime) on when sent, their time zone, and for
      // an elder's phone when she last used it (0.22+).
      dnd: b.dnd === true,
      tz: cleanTimeZone(b.tz),
      used: num(b.used),
      // Which skin and page this phone is showing (0.22.1), so an admin who
      // switched it can see it has.
      skin: typeof b.skin === 'string' && /^[a-z]{2,16}$/.test(b.skin) ? b.skin : null,
      page: b.page === 'care' || b.page === 'grandkids' ? b.page : null,
      // Came over the mesh radio from a tracker, through a home base.
      via: b.via === 'radio' ? 'radio' : null,
      // How it came: hops, and the path from the tracker to the home base.
      mesh: cleanMeshPath(b.mesh),
      ts: msg.ts,
      receivedAt: updatedAt,
    };
    const prev = this.locations.get(memberId);
    if (prev && prev.ts > loc.ts) return prev;
    this.locations.set(memberId, loc);
    this.paused.delete(memberId);
    if (this.memberRecord(memberId)?.homeBase && this._pinHomeBases()) return this.locations.get(memberId);
    return loc;
  }

  async fetchLocations() {
    const { locations } = await this.api.locations();
    this._rawLocations = locations;
    this._cacheDirty = true;
    this.paused = new Map();
    for (const l of locations) this._decodeLocation(l.memberId, l.env, l.updatedAt);
    this._pinHomeBases();
    this.emit('locations', this.locations);
    return this.locations;
  }

  /** Upload this device's location, encrypted. */
  async shareLocation({ lat, lng, accuracy, battery, charging, speed, trigger = 'update', placeId = null, approx = false, power, perm, precise, app, cadence, ts, dnd, tz, used, skin, page }) {
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
    // Asleep or on Do Not Disturb, and the time where they are, for the
    // Elderly Companion skin (sealed like the rest; 0.22+).
    if (dnd === true) body.dnd = true;
    if (cleanTimeZone(tz)) body.tz = tz;
    if (typeof used === 'number' && Number.isFinite(used)) body.used = used;
    if (typeof skin === 'string' && /^[a-z]{2,16}$/.test(skin)) body.skin = skin;
    if (page === 'care' || page === 'grandkids') body.page = page;
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

  _addMessage(m, { bulk = false } = {}) {
    // Before the duplicate check: a fetch that returns our own messages
    // (already shown) must still move past them.
    this.lastSeq = Math.max(this.lastSeq, m.seq);
    if (this.seenMessageIds.has(m.id)) return false;
    this.seenMessageIds.add(m.id);
    // A mesh packet has no nonce of its own: the packet itself stands in.
    const nonceKey = m.env?.nonce ?? m.env?.mesh;
    if (this.seenNonces.has(nonceKey)) return false;
    this.seenNonces.add(nonceKey);
    const to = m.to ?? null;
    // Direct messages: the other person in the conversation. null = the group.
    const peer = to ? (m.from === this.account.memberId ? to : m.from) : null;
    const kinds = to ? ['chat', 'reaction'] : ['chat', 'event', 'reaction'];
    // From this phone's cache: opened (and checked) on an earlier launch.
    const msg = m.opened ? (kinds.includes(m.opened.kind) ? m.opened : null) : this._open(m.env, m.from, kinds, to, m.id);
    if (msg === REPLAYED) return false;
    // A phone passing its tracker's position to the home base (the phone bridge): not a chat message.
    if (msg?.body?.trackerFix) return false;
    this._remember(m, msg, { quiet: bulk });
    if (msg?.kind === 'reaction') {
      // A read receipt: "I've read this conversation up to here".
      if (Number.isInteger(msg.body?.read) && msg.body.read > 0) {
        const key = `${m.from}|${peer ?? ''}`;
        if (msg.body.read > (this.reads.get(key) ?? 0)) this.reads.set(key, Math.min(msg.body.read, m.seq));
        this.emit('receipts');
        return { kind: 'reaction', id: m.id, from: m.from, to, peer, seq: m.seq, body: msg.body };
      }
      if (isPollUpdate(msg.body)) this._applyPollUpdate(m.from, m.seq, msg.body);
      else if (isPlanUpdate(msg.body)) this._applyPlanUpdate(m.from, m.seq, msg.body);
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
    // Many at once (the cache): the caller sorts when it's done.
    if (!bulk) this.messages.sort((a, b) => a.seq - b.seq);
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

  // --- plans ---------------------------------------------------------------
  // A time suggested in the chat. Answers are reactions; nothing goes into
  // anyone's calendar unless they ask their own phone to put it there.

  _applyPlanUpdate(from, seq, body) {
    let p = this.plans.get(body.target);
    if (!p) this.plans.set(body.target, (p = { answers: new Map(), cancels: new Set() }));
    if (body.cancelPlan === true) p.cancels.add(from);
    else if (seq >= (p.answers.get(from)?.seq ?? 0)) p.answers.set(from, { answer: body.rsvp, seq });
  }

  /** Suggest a time: { title, start, end, allDay, where }. Returns its id. */
  async createPlan(details) {
    const plan = cleanPlan(details);
    if (!plan) throw new Error('A plan needs a name and a time');
    const id = randomId(12);
    await this._post('chat', { text: `📅 ${plan.title}`, plan }, { id });
    return id;
  }

  /** Your answer: 'going', 'maybe' or 'no'. */
  answerPlan(planId, rsvp) {
    const s = this.planState(planId);
    if (!s) return Promise.reject(new Error('No such plan'));
    if (s.cancelled) return Promise.reject(new Error('This plan was cancelled'));
    if (!PLAN_ANSWERS.includes(rsvp)) return Promise.reject(new Error('Going, maybe or no'));
    return this._post('reaction', { target: planId, rsvp }, { silent: true });
  }

  cancelPlan(planId) {
    const s = this.planState(planId);
    if (!s) return Promise.reject(new Error('No such plan'));
    if (s.from !== this.account.memberId) return Promise.reject(new Error('Only whoever made a plan can cancel it'));
    return this._post('reaction', { target: planId, cancelPlan: true }, { silent: true });
  }

  /** A plan and where it stands: its details, from, cancelled, answers [{ memberId, answer }], mine. Null if there's no such plan. */
  planState(planId) {
    const m = this.messages.find((x) => x.id === planId && x.kind === 'chat' && x.body?.plan);
    const plan = m ? cleanPlan(m.body.plan) : null;
    if (!plan) return null;
    const p = this.plans.get(planId);
    const answers = [...(p?.answers ?? [])].map(([memberId, a]) => ({ memberId, answer: a.answer }));
    return { ...plan, id: planId, from: m.from, cancelled: !!p?.cancels.has(m.from), answers, mine: answers.find((a) => a.memberId === this.account?.memberId)?.answer ?? null };
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
    const list = this.messages.filter((m) => (m.peer ?? null) === peer);
    if (peer) return list;
    const hidden = quickReturns(list);
    return hidden.size ? list.filter((m) => !hidden.has(m.id)) : list;
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
    if (this.circle.groupCallLink && !('groupCallLink' in patch)) body.groupCallLink = this.circle.groupCallLink;
    if (!body.groupCallLink) delete body.groupCallLink;
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

  /** Share something kept private with the circle (the button on its "📌 Saved" message). */
  async shareAgentNotes(noteIds, { peer = null } = {}) {
    const agent = this.agent;
    if (!agent) throw new Error('This circle has no agent');
    await this._post('chat', { shareNotes: noteIds, thread: peer ? 'dm' : 'group', agentCopy: true, ...this._agentContext() }, { to: agent.id, silent: true });
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
  /**
   * What a question needs that the helper can't read for itself (it has no
   * circle key): only summaries this phone worked out, and only for a question
   * that calls for them. Travel times and busy days, never positions or titles.
   */
  _agentFacts(q) {
    const name = (id) => this.members.get(id)?.name;
    const facts = {};
    if (TRAVEL_RE.test(q)) {
      facts.travel = travelStats(tripsFrom(this.messages))
        .slice(0, 40)
        .map(({ memberId, ...r }) => ({ ...r, who: name(memberId) }))
        .filter((r) => r.who);
    }
    if (FREE_RE.test(q) && this.busy.size) {
      facts.busyDays = [...this.busy].map(([id, b]) => ({ who: name(id), days: busyDays(b.blocks) })).filter((b) => b.who && b.days.length);
    }
    return facts;
  }

  async askAgent(text, { peer = null } = {}) {
    const agent = this.agent;
    if (!agent) throw new Error('This circle has no agent');
    const q = String(text || '').trim().slice(0, 2000);
    if (!q) return null;
    if (peer && peer !== agent.id) throw new Error('Ask the agent in the group or in a chat with it');
    if (peer) {
      const id = randomId(12);
      await this._post('chat', { text: q, ask: q, thread: 'dm', ...this._agentContext(), ...this._agentFacts(q) }, { to: agent.id, id });
      return id;
    }
    const id = randomId(12);
    await this._post('chat', { text: `/${agent.name} ${q}`, agentAsk: true }, { id });
    await this._post('chat', { ask: q, thread: 'group', replyTo: id, agentCopy: true, ...this._agentContext(), ...this._agentFacts(q) }, { to: agent.id, silent: true });
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

  /**
   * Answer a call-back request: 'now' (which closes it), '5min', 'morning'
   * or 'evening'; or 'asleep', which a phone sends by itself when a request
   * reaches it at night or on Do Not Disturb (she's told; it stays open).
   */
  replyCallback(requestId, reply) {
    if (!CALLBACK_ANSWERS.includes(reply)) return Promise.reject(new Error('Not a call-back reply'));
    const req = this._callbackRequest(requestId);
    if (!req) return Promise.reject(new Error('No such call-back request'));
    const name = this.myName;
    const text = reply === 'asleep' ? `📞 ${name} is asleep. ${this._callbackName(req.from)} was told.` : `📞 ${name}: ${CALLBACK_REPLY_TEXT[reply]}`;
    return this._post('chat', { text, callback: { state: 'reply', of: requestId, reply } }, { urgent: true });
  }

  /**
   * Whether a member is likely asleep: their phone said Do Not Disturb was
   * on (within the last 12 hours), or it's night where they are (10 pm to
   * 7 am in their time zone).
   */
  availability(memberId, now = Date.now()) {
    const loc = this.locations.get(memberId);
    const tz = loc?.tz ?? null;
    const hour = localHour(tz, now);
    const night = hour != null && (hour >= 22 || hour < 7);
    const dnd = !!loc?.dnd && now - loc.ts < 12 * 3600_000;
    return { asleep: dnd || night, dnd, night, tz };
  }

  /**
   * Elders whose phone hasn't been used for longer than their admins set
   * (24 hours by default): [{ memberId, name, hours, used }].
   */
  inactiveElders(now = Date.now()) {
    const out = [];
    for (const [memberId, rec] of this.records.member) {
      if (rec.skin !== 'elderly' || !this.members.get(memberId) || this.members.get(memberId).removed) continue;
      const used = this.locations.get(memberId)?.used;
      if (typeof used !== 'number') continue;
      const hours = (now - used) / 3600_000;
      if (hours >= (rec.inactiveHours ?? 24)) out.push({ memberId, name: this.members.get(memberId).name, hours: Math.floor(hours), used });
    }
    return out;
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
      if (!r || r.state !== 'reply' || r.of !== requestId || !CALLBACK_ANSWERS.includes(r.reply)) continue;
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
    const asks = this.openCallbacks().filter((s) => s.remind > 0 && this.callbackAsks(s, me) && !s.replies.some((r) => r.memberId === me));
    // She may ask again: only the newest open request from each person is
    // reminded about, so asking twice doesn't double the reminders.
    const newest = new Map();
    for (const s of asks) if (!newest.has(s.from)) newest.set(s.from, s);
    return [...newest.values()];
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

  async fetchRecords(refreshed = false) {
    const { records } = await this.api.records();
    // Written by someone this phone doesn't know yet (an admin who joined
    // since the last refresh): learn the members first, once, or the record
    // would be dropped as unsigned.
    if (!refreshed && records.some((r) => !this.account.known[r.by])) {
      await this.refresh();
      return this.fetchRecords(true);
    }
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
    if (this._pinHomeBases()) this.emit('locations', this.locations);
    return this.records;
  }

  /**
   * After a key rotation: seal the settings records again under the new key,
   * so a member who joins later can read them (their skin and her settings),
   * as places are. Each is signed by the admin who rotated; phones accept
   * a record from any admin.
   */
  async _resealRecords() {
    const pairs = [...[...this.records.member].map(([k, r]) => ['member', k, r]), ...[...this.records.alias].map(([k, r]) => ['alias', k, r])];
    const here = (id) => !!this.members.get(id) && !this.members.get(id).removed;
    for (const [kind, subject, rec] of pairs) {
      // Records about someone who just left go with them (the server deletes them).
      if (!subject.split('.').every(here)) continue;
      const { by, ts, ...body } = rec;
      await this.api.putRecord(kind, subject, this._seal(kind, body)).catch((e) => {
        if (!(e instanceof ApiError && e.status === 404)) this.onError(e);
      });
    }
    await this.fetchRecords().catch(() => {});
  }

  async _putRecord(kind, subject, body) {
    await this._withEpochRetry(() => this.api.putRecord(kind, subject, this._seal(kind, body)));
    await this.fetchRecords();
  }

  /** Admin settings about a member, or null: { member, skin, page, ringEveryone, games, canDial, tiles, sleep, remindEvery, inactiveHours, lang, g }. */
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
   * Your own phone number (international format, "+92 300 1234567" is fine),
   * in your profile: only your circle can read it. Empty clears it.
   */
  async setPhone(phone) {
    const clean = cleanPhone(phone);
    if (String(phone ?? '').trim() && !clean) throw new Error('Enter the number with its country code, such as +1 555 123 4567');
    this.account.profile.phone = clean || undefined;
    await this.api.putProfile(this._seal('profile', this._profileBody()));
    await this._save();
    await this.refresh();
  }

  /** A member's phone number: their own, else the one an admin saved for them, else null. */
  phoneOf(memberId) {
    return this.members.get(memberId)?.phone || this.memberRecord(memberId)?.phone || null;
  }

  /** The circle's WhatsApp call link, or null. */
  get groupCallLink() {
    return this.circle?.groupCallLink || null;
  }

  // --- group calls ---------------------------------------------------------
  // Anyone starts the circle's group call: a group chat message with
  // `body.groupCall` { state: 'start' }, sent urgent so every phone wakes and
  // shows "join". Joining adds a quiet { state: 'join', of } line. A call in
  // HomeCircle has `mesh: true`, and people say when they leave it, so it's on
  // while someone is on it. On WhatsApp the link stays in the circle record, and
  // a call counts as on for 30 minutes after it started or someone last joined.

  /** Start the group call (or join the one that's on). Returns its id. */
  async startGroupCall() {
    if (!this.groupCallLink) throw new Error('This circle has no WhatsApp group call link yet. An admin adds it in the group chat’s Group call.');
    const on = this.activeGroupCall();
    if (on) {
      await this.joinGroupCall(on.id);
      return on.id;
    }
    const id = randomId(12);
    await this._post('chat', { text: `📞 ${this.myName} started a WhatsApp group call. Tap to join.`, groupCall: { state: 'start' } }, { id, urgent: true });
    return id;
  }

  /** Start a group call in HomeCircle (or join the one that's on). Returns its id. */
  async startMeshCall() {
    if (!this.feature('calls')) throw new Error('Voice calls are off for this circle.');
    const on = this.activeGroupCall();
    if (on) {
      await this.joinGroupCall(on.id);
      return on.id;
    }
    const id = randomId(12);
    await this._post('chat', { text: `📞 ${this.myName} started a group call. Tap to join.`, groupCall: { state: 'start', mesh: true } }, { id, urgent: true });
    return id;
  }

  /** Say you joined a group call (once, unless you left it). */
  async joinGroupCall(callId) {
    const s = this.groupCallState(callId);
    const me = this.account?.memberId;
    if (!s || s.present.includes(me)) return;
    await this._post('chat', { text: `📞 ${this.myName} joined the group call.`, groupCall: { state: 'join', of: callId } });
  }

  /** Say you left a group call in HomeCircle. */
  async leaveGroupCall(callId) {
    await this._post('chat', { text: `📞 ${this.myName} left the group call.`, groupCall: { state: 'leave', of: callId } }, { silent: true });
  }

  /** A group call: { id, from, ts, joined (member ids, the starter first), present (those still on it), mesh, last, open }. */
  groupCallState(callId, now = Date.now()) {
    const start = this.messages.find((m) => m.id === callId && m.kind === 'chat' && !m.peer && m.body?.groupCall?.state === 'start');
    if (!start) return null;
    const joined = [start.from];
    const present = new Set(joined);
    let last = start.ts;
    for (const m of this.messages) {
      const g = m.body?.groupCall;
      if (m.kind !== 'chat' || m.peer || m.seq <= start.seq || (g?.state !== 'join' && g?.state !== 'leave') || g.of !== callId) continue;
      if (g.state === 'leave') {
        present.delete(m.from);
        continue;
      }
      if (!joined.includes(m.from)) joined.push(m.from);
      present.add(m.from);
      last = Math.max(last, m.ts);
    }
    const mesh = start.body.groupCall.mesh === true;
    return { id: callId, from: start.from, ts: start.ts, joined, present: [...present], mesh, last, open: mesh ? present.size > 0 && now - last < MESH_CALL_OPEN_MS : now - last < GROUP_CALL_OPEN_MS };
  }

  /** The group call that's on now (the newest), or null. */
  activeGroupCall(now = Date.now()) {
    for (let i = this.messages.length - 1; i >= 0; i--) {
      const m = this.messages[i];
      if (m.kind === 'chat' && !m.peer && m.body?.groupCall?.state === 'start') {
        const s = this.groupCallState(m.id, now);
        if (s?.open) return s;
      }
    }
    return null;
  }

  /** Admins: save (or, empty, remove) the circle's WhatsApp group call link, sealed in the circle's record. */
  async setGroupCallLink(link) {
    if (!this.isAdmin) throw new Error('Only circle admins can change that');
    const clean = cleanCallLink(link);
    if (String(link ?? '').trim() && !clean) throw new Error('That isn’t a WhatsApp call link (it starts with https://call.whatsapp.com/)');
    await this.api.putCircle(this._seal('circle', this._circleBody({ groupCallLink: clean })));
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

  /**
   * Fetch what this phone doesn't have yet, newest first. With nothing held
   * (a new phone, or the cache is gone) the chat opens on the latest
   * messages; older history is read back in behind them (backfillHistory,
   * loadOlder). With a cache it's only what came after it, unless more than
   * a page was missed: then the latest page opens first too, and the gap
   * fills in from there. One at a time.
   */
  fetchMessages() {
    const run = this._fetchLock.then(() => this._fetchMessages());
    this._fetchLock = run.catch(() => {});
    return run;
  }

  async _fetchMessages() {
    // What was already opened comes first; fetching from 0 instead would
    // open it all again, and a save would then overwrite the cache with less.
    await this._loadCache();
    if (!this.account) return this.messages;
    const t0 = Date.now();
    let mode = 'forward';
    let count = 0;
    if (this.fetchedSeq === 0) {
      mode = 'tail';
      const { messages } = await this.api.messagesTail(FIRST_PAGE);
      await this._openTail(messages, FIRST_PAGE);
      count = messages.length;
    } else {
      for (let first = true; ; first = false) {
        const { messages } = await this.api.messages(this.fetchedSeq, FORWARD_PAGE);
        if (first && messages.length >= FORWARD_PAGE) {
          // Missed more than a page: the latest first, the gap behind it later.
          const { messages: tail } = await this.api.messagesTail(FIRST_PAGE);
          if (tail.length) {
            mode = 'gap';
            await this._openTail(tail, FIRST_PAGE);
            count = tail.length;
            break;
          }
        }
        await this._take(messages);
        count += messages.length;
        if (messages.length) this.emit('messages', this.messages);
        if (messages.length < FORWARD_PAGE) break;
      }
    }
    if (!this.timings.firstFetch) this.timings.firstFetch = { mode, count, ms: Date.now() - t0 };
    // Soon: this is the moment a killed app would lose the most.
    this._saveCacheSoon(count ? 300 : 2000);
    this.emit('messages', this.messages);
    return this.messages;
  }

  /** Open each fetched message, letting the screen draw in between. */
  async _take(messages, { forward = true } = {}) {
    let since = Date.now();
    for (const m of messages) {
      this._addMessage(m);
      if (forward) this.fetchedSeq = Math.max(this.fetchedSeq, m.seq);
      // Opening a message takes tens of ms on a phone: after every ~12 ms of
      // it, let the screen draw and taps through, instead of freezing for
      // the whole page.
      if (Date.now() - since > 12) {
        await yieldToUi();
        since = Date.now();
      }
    }
  }

  /** `rows` are the newest messages there are: held from them up, whatever is older not yet. */
  async _openTail(rows, limit) {
    const full = rows.length >= limit;
    if (this.fetchedSeq > 0 && full) {
      // Missed about as many messages as the phone keeps: what it had is too
      // old to join up with these, and would only leave a hole. Reading back
      // fills in the newest ones instead.
      this.messages.length = 0;
      this.seenMessageIds.clear();
      this.seenNonces.clear();
      this._cacheRows.clear();
    }
    this.backSeq = full ? rows[0].seq - 1 : 0;
    await this._take(rows);
  }

  /** Whether there is older history on the server this phone hasn't fetched. */
  get hasOlder() {
    return this.backSeq > 0;
  }

  /**
   * Read back one more page of older messages (the person scrolled up).
   * Returns how many were fetched; 0 when there is nothing older.
   */
  loadOlder(limit = OLDER_PAGE) {
    const run = this._olderLock.then(() => this._loadOlder(limit));
    this._olderLock = run.catch(() => {});
    return run;
  }

  async _loadOlder(limit) {
    await this._loadCache();
    const gen = this._generation;
    if (!this.account || this.backSeq <= 0) return 0;
    const { messages } = await this.api.messagesBefore(this.backSeq + 1, limit);
    if (gen !== this._generation) return 0;
    await this._take(messages, { forward: false });
    let back = messages.length >= limit ? messages[0].seq - 1 : 0;
    // The cache keeps this many; reading further back would only be dropped again.
    if (this._cacheRows.size >= CACHE_MAX) back = 0;
    this.backSeq = back;
    if (messages.length) this.emit('messages', this.messages);
    this._saveCacheSoon(back ? 5000 : 1000);
    return messages.length;
  }

  /**
   * Read the rest of the history back in while the app is open: a page at a
   * time with a rest in between, so the screen and the live connection come
   * first. Stops when the connection is closed (the app went to the
   * background) and carries on when it's started again.
   */
  backfillHistory() {
    this._backfillStop = false;
    if (this._backfilling) return this._backfilling;
    this._backfilling = (async () => {
      try {
        while (this.account && this.backSeq > 0 && !this._backfillStop) {
          await sleep(this.backfillPauseMs);
          if (this._backfillStop) break;
          if (!(await this.loadOlder())) break;
        }
      } catch (e) {
        this.onError(e);
      } finally {
        this._backfilling = null;
      }
    })();
    return this._backfilling;
  }

  // --- this phone's copy of the messages ----------------------------------

  get _cacheKey() {
    return `${this.accountKey}.messages`;
  }

  /** Keep what a message opened to, for the cache (failures keep the envelope, to try again). */
  _remember(m, msg, { quiet = false } = {}) {
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
    if (!quiet) this._saveCacheSoon(4000);
  }

  /**
   * The messages (and members and last locations) this phone already has,
   * back in place without opening them again. Every way of adding or saving
   * messages waits for this first: a client that saved before reading would
   * replace a good cache with whatever it had fetched since.
   */
  _loadCache() {
    if (!this.cache || !this.account) return Promise.resolve();
    if (!this._cacheLoading) {
      const t0 = Date.now();
      this._cacheLoading = this._readCache()
        .catch((e) => this.onError(e))
        .then(() => {
          this.timings.cache = { ms: Date.now() - t0, rows: this._cacheRows.size, fetchedSeq: this.fetchedSeq };
        });
    }
    return this._cacheLoading;
  }

  /** Start reading the cache without waiting for it (it's read once). */
  loadCache() {
    return this._loadCache();
  }

  async _readCache() {
    let c = null;
    try {
      c = JSON.parse((await this.cache.getItem(this._cacheKey)) || 'null');
    } catch (e) {
      this.onError(e);
    }
    if (!c || (c.v !== 1 && c.v !== 2) || c.circleId !== this.account.circleId || c.memberId !== this.account.memberId || !Array.isArray(c.rows)) return;
    // Members and the circle's name first: messages are filed under the agent, and names show at once.
    if (c.state && !this.state) {
      try {
        this.state = c.state;
        this._decodeMembers(c.state);
        this._decodeCircle(c.state);
        this.emit('members', this.memberList());
        this.emit('circle', this.circle);
      } catch (e) {
        this.state = null;
        this.onError(e);
      }
    }
    for (const [i, row] of c.rows.entries()) {
      this._addMessage(row, { bulk: true });
      if (i % 200 === 199) await yieldToUi();
    }
    this.messages.sort((a, b) => a.seq - b.seq);
    // Only messages after these are fetched; older than backSeq, not yet.
    if (!this.fetchedSeq) {
      this.fetchedSeq = Number(c.fetchedSeq) || 0;
      this.backSeq = c.v === 2 ? Math.max(0, Number(c.backSeq) || 0) : 0;
    }
    if (Array.isArray(c.locations) && !this.locations.size) {
      this._rawLocations = c.locations;
      for (const l of c.locations) this._decodeLocation(l.memberId, l.env, l.updatedAt);
      this.emit('locations', this.locations);
    }
    this.emit('messages', this.messages);
  }

  /** Save after a while (a burst of messages is one save). An earlier time asked for wins. */
  _saveCacheSoon(delay = 2000) {
    if (!this.cache) return;
    this._cacheDirty = true;
    const due = Date.now() + delay;
    if (this._cacheTimer && this._cacheDue <= due) return;
    clearTimeout(this._cacheTimer);
    this._cacheDue = due;
    this._cacheTimer = setTimeout(() => {
      this._cacheTimer = null;
      this._saveCache().catch(this.onError);
    }, delay);
  }

  /** Save now if anything changed: the app is going to the background, where it can be closed any moment. */
  async flushCache() {
    clearTimeout(this._cacheTimer);
    this._cacheTimer = null;
    if (!this._cacheDirty || !this.cache || !this.account) return;
    await this._saveCache();
  }

  /** One save at a time, in order. */
  _saveCache() {
    const run = this._saving.then(() => this._writeCache());
    this._saving = run.catch(() => {});
    return run;
  }

  /** Kept as long as the circle keeps messages, and at most the newest 500. */
  async _writeCache() {
    if (!this.cache || !this.account) return;
    const gen = this._generation;
    await this._loadCache();
    if (gen !== this._generation || !this.account) return;
    this._cacheDirty = false;
    const days = this.state?.retentionDays ?? 90;
    const since = Date.now() - days * 86400_000;
    const rows = [...this._cacheRows.values()].filter((r) => !r.createdAt || r.createdAt >= since).sort((a, b) => a.seq - b.seq);
    const kept = rows.slice(-CACHE_MAX);
    let { backSeq } = this;
    if (kept.length < this._cacheRows.size) this._cacheRows = new Map(kept.map((r) => [r.seq, r]));
    // Messages cut off for being too many aren't fetched again.
    if (kept.length < rows.length) {
      backSeq = 0;
    }
    await this.cache.setItem(
      this._cacheKey,
      JSON.stringify({
        v: 2,
        circleId: this.account.circleId,
        memberId: this.account.memberId,
        fetchedSeq: this.fetchedSeq,
        backSeq,
        state: this.state,
        locations: this._rawLocations,
        rows: kept,
      }),
    );
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

  /**
   * The phone bridge: pass the position of the tracker this person carries
   * (read over Bluetooth) to the home base, sealed to it and silent. The home
   * base posts it as the tracker's, "via <name>'s phone". Not shown in chats.
   */
  sendTrackerFix(homeBaseId, { node, lat, lng, at, battery = null }) {
    if (!/^![0-9a-f]{8}$/.test(node) || !Number.isFinite(lat) || !Number.isFinite(lng)) return Promise.reject(new Error('Not a tracker position'));
    const fix = { node, lat: Math.round(lat * 1e6) / 1e6, lng: Math.round(lng * 1e6) / 1e6, at: Number.isFinite(at) ? at : Date.now(), ...(Number.isInteger(battery) ? { battery } : {}) };
    return this._post('chat', { trackerFix: fix }, { to: homeBaseId, silent: true });
  }

  /**
   * Send to the whole circle, or only to `to` (a direct message). Pass the
   * same `id` to try a message again (or to send it over the mesh too): the
   * server keeps one, and a copy it already has counts as sent.
   */
  async sendChat(text, { to = null, id } = {}) {
    const t = String(text || '').trim().slice(0, 4000);
    if (!t) return;
    try {
      await this._post('chat', { text: t }, { to, ...(id ? { id } : {}) });
    } catch (e) {
      // It got there before (the answer was lost, or it came over the mesh): sent.
      if (id && e instanceof ApiError && e.status === 409 && e.code === 'conflict') {
        await this._fetchMessages?.().catch(() => {});
        return;
      }
      throw e;
    }
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
      // Where the circle's home base is (its pin on the map), whatever its GPS says.
      homeBase: b.homeBase === true,
      updatedBy: p.updatedBy,
    };
    this.places.set(p.id, place);
    this._pinHomeBases();
    return place;
  }

  /** The place the home base is pinned to (normally Home), if one is chosen. */
  homeBasePlace() {
    for (const p of this.places.values()) if (p.homeBase) return p;
    return null;
  }

  /** Pin the home base to this place (null: back to its GPS). One place at a time. */
  async pinHomeBase(placeId) {
    if (placeId && !this.places.has(placeId)) throw new Error('No such place');
    for (const p of [...this.places.values()]) {
      const want = p.id === placeId;
      if (!!p.homeBase !== want) {
        const { updatedBy, ...body } = p;
        await this.savePlace({ ...body, homeBase: want });
      }
    }
    this._pinHomeBases();
    this.emit('locations', this.locations);
  }

  /**
   * A home base pinned to a place shows there, as of its last check-in, with
   * or without a GPS fix (its status still says what the GPS sees). Called
   * whenever places, records or locations change.
   */
  _pinHomeBases() {
    if (!this.records?.member) return false;
    const pin = this.homeBasePlace();
    let changed = false;
    for (const [id, r] of this.records.member) {
      if (!r?.homeBase) continue;
      const cur = this.locations.get(id);
      if (!pin) {
        if (cur?.pinned) {
          this.locations.delete(id);
          changed = true;
        }
        continue;
      }
      const ts = Math.max(r.homeBase.at, cur?.ts ?? 0);
      if (cur?.pinned && cur.lat === pin.lat && cur.lng === pin.lng && cur.ts === ts) continue;
      this.locations.set(id, { ...(cur ?? {}), lat: pin.lat, lng: pin.lng, accuracy: 10, approximate: false, placeId: pin.id, via: null, pinned: true, ts, receivedAt: Date.now() });
      changed = true;
    }
    return changed;
  }

  async fetchPlaces() {
    const { places } = await this.api.places();
    this.places = new Map();
    for (const p of places) this._decodePlace(p);
    this.emit('places', this.places);
    if (this._pinHomeBases()) this.emit('locations', this.locations);
    return this.places;
  }

  async savePlace({ id = randomId(9), name, lat, lng, radius = 150, icon = 'pin', address = null, group = null, homeBase }) {
    // Editing a place keeps it the home base's pin unless told otherwise.
    const pinned = typeof homeBase === 'boolean' ? homeBase : !!this.places.get(id)?.homeBase;
    const body = { id, name: cleanName(name), lat, lng, radius, icon, address, group, ...(pinned ? { homeBase: true } : {}) };
    await this._withEpochRetry(() => this.api.putPlace(id, this._seal('place', body)));
    this.places.set(id, { ...body, homeBase: pinned, updatedBy: this.account.memberId });
    this.emit('places', this.places);
    if (this._pinHomeBases()) this.emit('locations', this.locations);
    return id;
  }

  async deletePlace(id) {
    await this.api.deletePlace(id);
    this.places.delete(id);
    this.emit('places', this.places);
    if (this._pinHomeBases()) this.emit('locations', this.locations);
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

  // --- voice calls ---------------------------------------------------------

  /**
   * Send one call signal to a member of this circle, sealed with the pair's
   * direct key: { callId, op: 'offer' | 'answer' | 'ice' | 'ringing' | 'hangup' |
   * 'busy' | 'decline', ...}. The server relays it and forgets it. `ring` marks
   * the first offer of a call, which also wakes the other phone with a push.
   * Resolves { online, held, pushed }.
   */
  async sendCallSignal(to, body, { ring = false } = {}) {
    const id = randomId(12);
    const env = this._seal('call', body, this.account.epoch, { to, id });
    return this.api.callSignal(to, id, env, { ring });
  }

  /**
   * Leave a line in the direct chat with the person called: "Missed voice
   * call" (they never answered) or "Voice call · 3:12". An ordinary sealed
   * direct message, so it shows in any version of the app as text.
   */
  logCall(to, { missed = false, seconds = 0 } = {}) {
    const mm = Math.floor(seconds / 60);
    const text = missed ? '📞 Missed voice call' : `📞 Voice call · ${mm}:${String(Math.round(seconds % 60)).padStart(2, '0')}`;
    return this._post('chat', { text, call: missed ? { state: 'missed' } : { state: 'ended', seconds: Math.round(seconds) } }, { to, silent: !missed });
  }

  /** The STUN (and, if the server has one, TURN) servers for a call: { iceServers }. */
  callsConfig() {
    return this.api.callsConfig();
  }

  /**
   * Call signals that waited for this phone while it was asleep. Each is
   * handled like a live one (a 'callSignal' event). Returns how many were new.
   */
  async collectCallSignals() {
    const { signals } = await this.api.callsPending();
    let n = 0;
    for (const s of signals) if (this._onCallSignal(s)) n++;
    return n;
  }

  /**
   * Open a relayed call signal and tell the app ('callSignal': { from, id,
   * ts, callId, op, ... }). Ignored: one that doesn't open (not from a
   * member of this circle with that key), one already seen, and one signed
   * too long ago (or too far ahead) to belong to a call going on now.
   */
  _onCallSignal(s) {
    if (!this.feature('calls') || !s || typeof s.id !== 'string' || this._seenCalls.has(s.id)) return false;
    const msg = this._open(s.env, s.from, ['call'], this.account.memberId, s.id);
    if (!msg || msg === REPLAYED || typeof msg.body?.callId !== 'string') return false;
    const age = Date.now() - msg.ts;
    if (age > CALL_SIGNAL_MAX_AGE_MS || age < -CALL_SIGNAL_MAX_SKEW_MS) return false;
    this._seenCalls.add(s.id);
    if (this._seenCalls.size > 500) this._seenCalls.delete(this._seenCalls.values().next().value);
    this.emit('callSignal', { ...msg.body, from: s.from, id: s.id, ts: msg.ts });
    return true;
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
  /** Share when you're busy: { s, e } blocks only, sealed to the circle. */
  async shareBusy(blocks) {
    if (!this.feature('busyTimes')) return;
    const clean = cleanBusy(blocks);
    await this.api.putBusy(this._seal('busy', { blocks: clean }));
    this.busy.set(this.account.memberId, { blocks: clean, ts: Date.now() });
    this.emit('busy', this.busy);
  }

  async clearBusy() {
    await this.api.deleteBusy();
    this.busy.delete(this.account.memberId);
    this.emit('busy', this.busy);
  }

  async fetchBusy() {
    const { busy } = await this.api.busy();
    this.busy = new Map();
    for (const b of busy) {
      const msg = this._open(b.env, b.memberId, ['busy']);
      if (msg) this.busy.set(b.memberId, { blocks: cleanBusy(msg.body?.blocks), ts: msg.ts });
    }
    this.emit('busy', this.busy);
    return this.busy;
  }

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
    await this._resealRecords();
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
      return this.catchUp().finally(() => this.backfillHistory().catch(() => {}));
    }
    // What this phone already has shows at once, before the network answers.
    await this._loadCache();
    const t0 = Date.now();
    await this.refresh();
    this.timings.refreshMs = Date.now() - t0;
    await Promise.all([this.fetchLocations(), this.fetchPlaces()]);
    this.connect();
    // After the connection opens, so a change made while this was loading
    // (an admin switching this phone's skin) is in one or the other.
    await Promise.all([this.fetchRecords().catch(() => {}), this.fetchMessages()]);
    this._started = true;
    // The rest of the history, behind the screen.
    this.backfillHistory().catch(() => {});
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
          // The first time: settings fetched while the connection was still
          // opening may already be out of date (an admin's change of skin).
          else this.fetchRecords().catch(() => {});
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
          // Records too: an admin's change of this phone's skin comes with
          // them, and a live event for it is missed while the phone is away.
          await Promise.all([this.fetchLocations(), this.fetchPlaces(), this.fetchRecords().catch(() => {})]);
          await this.fetchMessages();
        } while (this._catchAgain && this.account);
      } finally {
        this._catching = null;
      }
    })();
    return this._catching;
  }

  disconnect() {
    // Reading history back pauses with the connection (the app went away).
    this._backfillStop = true;
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
        this._saveCacheSoon(1500);
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
        if (this._decodePlace(e.place)) {
          this.emit('places', this.places);
          this.emit('locations', this.locations);
        }
        break;
      case 'place_deleted':
        this.places.delete(e.id);
        this.emit('places', this.places);
        if (this._pinHomeBases()) this.emit('locations', this.locations);
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
      case 'call_signal':
        this._onCallSignal(e);
        break;
      case 'plugin':
        // An admin saved a plugin's settings (Home Assistant: send it your position now).
        this.emit('plugin', e.id);
        break;
      case 'frequent':
        await this.fetchFrequent();
        break;
      case 'busy':
        await this.fetchBusy();
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
/**
 * A tracker's radio path, from its home base: { hops, at, path: [{ id, name,
 * snr }] } from the tracker to the home base (a Meshtastic traceroute), or
 * just hops. Null when there's none.
 */
function cleanMeshPath(m) {
  if (!m || typeof m !== 'object') return null;
  const hops = Number.isInteger(m.hops) && m.hops >= 0 && m.hops <= 10 ? m.hops : null;
  const path = Array.isArray(m.path)
    ? m.path.slice(0, 10).map((h) => ({
        id: typeof h?.id === 'string' && /^(![0-9a-f]{8}|\?)$/.test(h.id) ? h.id : null,
        name: typeof h?.name === 'string' ? h.name.replace(/[\u0000-\u001f]/g, '').trim().slice(0, 40) || null : null,
        snr: Number.isFinite(h?.snr) ? Math.round(h.snr * 4) / 4 : null,
        // Where a relay is, if the home base has heard its position (for the line on the map).
        lat: Number.isFinite(h?.lat) && Math.abs(h.lat) <= 90 && Number.isFinite(h?.lng) && Math.abs(h.lng) <= 180 ? h.lat : null,
        lng: Number.isFinite(h?.lat) && Math.abs(h.lat) <= 90 && Number.isFinite(h?.lng) && Math.abs(h.lng) <= 180 ? h.lng : null,
      }))
    : null;
  // The last mile: heard by the home base's own radio, uplinked by a gateway
  // over the internet (MQTT), passed on by the carrier's phone, or a public beacon.
  const src = ['radio', 'internet', 'phone', 'beacon'].includes(m.src) ? m.src : null;
  const gateway = typeof m.gateway === 'string' ? m.gateway.replace(/[\u0000-\u001f]/g, '').trim().slice(0, 40) || null : null;
  if (hops == null && !path && !src) return null;
  return { hops, at: Number.isFinite(m.at) ? m.at : null, path: path && path.length >= 2 ? path : null, src, gateway };
}

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
    canDial: bool(b.canDial),
    tiles: Array.isArray(b.tiles) ? [...new Set(b.tiles.filter((x) => typeof x === 'string'))].slice(0, MAX_TILES) : null,
    sleep,
    remindEvery: int(b.remindEvery, 1, 240),
    inactiveHours: int(b.inactiveHours, 1, 168),
    lang: typeof b.lang === 'string' && /^[a-z]{2,3}$/.test(b.lang) ? b.lang : null,
    g: GENDERS.includes(b.g) ? b.g : null,
    photos: cleanPhotoMap(b.photos),
    phone: cleanPhone(b.phone),
    tracker: cleanTracker(b.tracker),
    homeBase: cleanHomeBase(b.homeBase),
  };
}

/**
 * A home base's own status, in the member record about itself (it is an
 * admin): when it last checked in, the Meshtastic nodes it hears, and its
 * trackers. Null for anyone else.
 */
function cleanHomeBase(h) {
  if (!h || typeof h !== 'object' || !Number.isFinite(h.at)) return null;
  const node = (v) => (typeof v === 'string' && /^![0-9a-f]{8}$/.test(v) ? v : null);
  const text = (v) => (typeof v === 'string' ? v.replace(/[\u0000-\u001f]/g, '').trim().slice(0, 40) : '');
  const list = (a, f) => (Array.isArray(a) ? a.slice(0, 40).map(f).filter(Boolean) : []);
  const num = (v, lo, hi) => (Number.isFinite(v) && v >= lo && v <= hi ? v : null);
  // What the radio knows about a node: when it was heard, how far, its signal and battery.
  const radio = (n) => ({
    at: Number.isFinite(n?.at) ? n.at : null,
    hops: Number.isInteger(n?.hops) ? n.hops : null,
    snr: num(n?.snr, -40, 40),
    battery: Number.isInteger(n?.battery) ? num(n.battery, 0, 100) : null,
    plugged: n?.plugged === true,
    volts: num(n?.volts, 0, 30),
  });
  const s = h.self && typeof h.self === 'object' ? h.self : null;
  const g = h.gps && typeof h.gps === 'object' ? h.gps : null;
  return {
    at: h.at,
    // How often it reports, in seconds (older home bases: every 5 minutes).
    every: Number.isInteger(h.every) ? num(h.every, 10, 3600) : null,
    // After how long a phone counts as quiet (the Meshtastic plugin's setting).
    quietMinutes: Number.isInteger(h.quietMinutes) && h.quietMinutes >= 10 && h.quietMinutes <= 720 ? h.quietMinutes : null,
    // The home base itself: power, Wi-Fi signal (dBm), uptime (s), free memory (KB), LoRa channel and its own airtime (%).
    self: s
      ? {
          battery: Number.isInteger(s.battery) ? num(s.battery, 0, 100) : null,
          volts: num(s.volts, 0, 30),
          plugged: s.plugged === true,
          wifi: num(s.wifi, -120, -1),
          up: Number.isInteger(s.up) ? num(s.up, 0, 1e9) : null,
          heap: Number.isInteger(s.heap) ? num(s.heap, 0, 1e6) : null,
          ch: num(s.ch, 0, 100),
          tx: num(s.tx, 0, 100),
          // The internet bridge (MQTT): connected or not; null when it's off.
          mqtt: typeof s.mqtt === 'boolean' ? s.mqtt : null,
        }
      : null,
    gps: g ? { fix: g.fix === true, sats: Number.isInteger(g.sats) ? num(g.sats, 0, 99) : null, hdop: num(g.hdop, 0, 99) } : null,
    // Its firmware version ("0.29.0"), for "Update" in the app.
    fw: typeof h.fw === 'string' && /^[0-9A-Za-z.+_-]{1,32}$/.test(h.fw) ? h.fw : null,
    heard: list(h.heard, (n) => (node(n?.node) ? { node: n.node, name: text(n.name) || null, ...radio(n) } : null)),
    trackers: list(h.trackers, (t) =>
      node(t?.node) && typeof t.member === 'string'
        ? {
            node: t.node,
            member: t.member,
            at: Number.isFinite(t.at) ? t.at : null,
            radio: t.radio && typeof t.radio === 'object' ? radio(t.radio) : null,
            // Its settings on the tracker itself: 'set' (as HomeCircle says), 'sending',
            // or 'needs-key' (the tracker doesn't trust the home base's key yet).
            settings: ['set', 'sending', 'needs-key'].includes(t.settings) ? t.settings : null,
            // Positions the home base heard lately, with how each got home: the trip on the map.
            log: list(t.log, (e) => {
              const ll = (o) => (Number.isFinite(o?.lat) && Math.abs(o.lat) <= 90 && Number.isFinite(o?.lng) && Math.abs(o.lng) <= 180 ? { lat: o.lat, lng: o.lng } : null);
              const at = ll(e);
              if (!at || !Number.isFinite(e?.at)) return null;
              const r = e.relay && typeof e.relay === 'object' && node(e.relay.id) ? e.relay : null;
              return {
                at: e.at,
                ...at,
                hops: Number.isInteger(e.hops) ? num(e.hops, 0, 10) : null,
                snr: num(e.snr, -40, 40),
                relay: r ? { id: r.id, name: text(r.name) || null, ...(ll(r) ?? { lat: null, lng: null }) } : null,
                // How it reached the home base: its radio, a gateway over the internet, a phone, a public beacon.
                src: ['radio', 'internet', 'phone', 'beacon'].includes(e.src) ? e.src : 'radio',
              };
            }).slice(-30),
          }
        : null,
    ),
    // The home base's Meshtastic public key: added on a tracker as its admin key,
    // it lets the home base change the tracker's settings over the radio.
    key: typeof h.key === 'string' && /^[A-Za-z0-9+/]{43}=$/.test(h.key) ? h.key : null,
    // Its Meshtastic node id ("!69852494"): phones address messages over the mesh to it.
    node: typeof h.node === 'string' && /^![0-9a-f]{8}$/.test(h.node) ? h.node : null,
    // The link that puts a tracker on the circle's private Meshtastic channel (to open in the Meshtastic app).
    channel: typeof h.channel === 'string' && h.channel.length < 400 && /^https:\/\/meshtastic\.org\/e\/#[A-Za-z0-9_-]+$/.test(h.channel) ? h.channel : null,
  };
}

/**
 * How a tracker reports, set by an admin: a phone in the tracker skin or a
 * small tracker device (devices/tracker). Minutes between reports while
 * moving and while still, quiet hours in its own time, and whether its SOS
 * button is on. Null when the record has none.
 */
const TRACKER_MODES = ['carried', 'car', 'pet', 'luggage', 'keys', 'other'];

function cleanTracker(t) {
  if (!t || typeof t !== 'object') return null;
  const mins = (v, lo, hi, d) => (Number.isInteger(v) && v >= lo && v <= hi ? v : d);
  const quiet = t.quiet && HHMM.test(t.quiet.from) && HHMM.test(t.quiet.to) ? { from: t.quiet.from, to: t.quiet.to } : null;
  return {
    // What it's for: carried by someone, in a car, on a pet, in luggage, on keys, or something else.
    mode: TRACKER_MODES.includes(t.mode) ? t.mode : 'car',
    moving: mins(t.moving, 1, 60, 2),
    still: mins(t.still, 5, 1440, 60),
    quiet,
    sos: t.sos !== false,
    // A Meshtastic tracker a home base sends for: its node id ("!a1b2c3d4"),
    // and the member who carries it, whose pin it stands in for when their
    // phone goes quiet.
    node: typeof t.node === 'string' && /^![0-9a-f]{8}$/.test(t.node) ? t.node : null,
    carriedBy: typeof t.carriedBy === 'string' && /^[A-Za-z0-9_-]{8,64}$/.test(t.carriedBy) ? t.carriedBy : null,
    // A Meshtastic tracker's own settings, where an admin chose them for it;
    // null means it follows the circle's (the Meshtastic plugin's settings).
    custom: cleanTrackerCustom(t.custom),
    // Its public beacon: every this many minutes, a rounded position on the
    // public Meshtastic channel (0: off, the default), so gateways anywhere pass it on.
    beacon: [15, 30, 60].includes(t.beacon) ? t.beacon : 0,
  };
}

/** One tracker's own settings: only what differs from the circle's. Null when it has none. */
function cleanTrackerCustom(c) {
  if (!c || typeof c !== 'object') return null;
  const int = (v, ok) => (Number.isInteger(v) && ok(v) ? v : null);
  const presses = {};
  for (const n of ['1', '2', '3', '4', '5']) {
    const v = c.presses?.[n];
    if (typeof v === 'string' && v.trim()) presses[n] = v.replace(/[\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80);
  }
  const out = {
    moving: int(c.moving, (v) => v >= 1 && v <= 60),
    still: int(c.still, (v) => v >= 5 && v <= 720),
    battery: int(c.battery, (v) => v === 0 || (v >= 5 && v <= 720)),
    presses: Object.keys(presses).length ? presses : null,
  };
  return out.moving != null || out.still != null || out.battery != null || out.presses ? out : null;
}

/**
 * A phone number as kept: "+" and 8 to 15 digits (E.164), or null. Spaces,
 * hyphens, dots and brackets are dropped; a leading 00 means "+". A number
 * without a country code is refused, never guessed.
 */
export function cleanPhone(p) {
  if (typeof p !== 'string' || p.length > 40) return null;
  const t = p.trim();
  if (/[^\d\s()\-.+]/.test(t) || t.indexOf('+') > 0 || (t.match(/\+/g) ?? []).length > 1) return null;
  let digits = t.replace(/\D/g, '');
  if (!t.startsWith('+')) {
    if (!digits.startsWith('00')) return null;
    digits = digits.slice(2);
  }
  return /^[1-9]\d{7,14}$/.test(digits) ? `+${digits}` : null;
}

/** A WhatsApp call link ("https://call.whatsapp.com/video/…" or "/voice/…") as kept, or null. */
export function cleanCallLink(u) {
  if (typeof u !== 'string' || u.length > 300) return null;
  let url;
  try {
    url = new URL(u.trim());
  } catch {
    return null;
  }
  const m = /^\/(video|voice)\/([A-Za-z0-9_-]{8,64})\/?$/.exec(url.pathname);
  if (url.protocol !== 'https:' || url.hostname !== 'call.whatsapp.com' || url.port || url.username || url.password || !m) return null;
  return `https://call.whatsapp.com/${m[1]}/${m[2]}`;
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

/** The hour (0–23) in a time zone, or null if it can't be worked out. */
function localHour(tz, now) {
  if (!tz) return null;
  try {
    const h = Number(new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: 'numeric', hourCycle: 'h23' }).format(new Date(now)));
    return Number.isInteger(h) ? h % 24 : null;
  } catch {
    return null;
  }
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
function isPlanUpdate(b) {
  return !!b && typeof b.target === 'string' && b.emoji === undefined && (b.cancelPlan === true || PLAN_ANSWERS.includes(b.rsvp));
}

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
