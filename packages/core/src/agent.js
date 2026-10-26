// A circle's agent, as a member. It joins with an agent invite, which carries
// no circle key, so it can't read the circle's chat, profiles or locations.
// It knows members only by the public keys the server lists (pinned the first
// time it sees them), and reads and sends nothing but direct messages, each
// sealed with a key it shares with one person.
import { Api, ApiError } from './api.js';
import { decryptFile, deriveInvite, directKey, encryptFile, generateIdentity, open, parseInviteLink, randomId, seal } from './crypto.js';
import { hasFeature } from './features.js';

const STORAGE_KEY = 'homecircle.agent';

export class AgentClient {
  /**
   * @param {object} opts
   * @param {{getItem(k:string):Promise<string|null>, setItem(k:string,v:string):Promise<void>, removeItem(k:string):Promise<void>}} opts.storage
   */
  constructor({ storage, key = STORAGE_KEY, fetchImpl, WebSocketImpl, onError = () => {} }) {
    this.storage = storage;
    this.key = key;
    this.fetchImpl = fetchImpl;
    this.WebSocketImpl = WebSocketImpl;
    this.onError = onError;
    this.account = null;
    this.members = new Map();
    this.epoch = 0;
    this.listeners = new Map();
    this.seen = new Set();
    this.connection = null;
  }

  on(event, fn) {
    if (!this.listeners.has(event)) this.listeners.set(event, new Set());
    this.listeners.get(event).add(fn);
    return () => this.listeners.get(event)?.delete(fn);
  }

  emit(event, data) {
    for (const fn of this.listeners.get(event) || []) {
      try {
        const r = fn(data);
        if (r && typeof r.catch === 'function') r.catch(this.onError);
      } catch (e) {
        this.onError(e);
      }
    }
  }

  _api(server, token = null) {
    return new Api(server, { token, fetchImpl: this.fetchImpl, WebSocketImpl: this.WebSocketImpl });
  }

  /** A file someone sent: fetched from the server and decrypted with the key they sealed to us. */
  async readFile({ id, key }) {
    return decryptFile(await this.api.downloadFile(id), key);
  }

  /** A file for someone (a memory download): encrypted here, so the server only stores ciphertext. */
  async sendFile(bytes) {
    const { key, data } = encryptFile(bytes);
    const { id } = await this.api.uploadFile(data);
    return { id, key };
  }

  keepFile = (id) => this.api.keepFile(id);
  deleteFile = (id) => this.api.deleteFile(id);

  async load() {
    const raw = await this.storage.getItem(this.key);
    this.account = raw ? JSON.parse(raw) : null;
    if (this.account) this.api = this._api(this.account.server, this.account.token);
    return !!this.account;
  }

  async _save() {
    await this.storage.setItem(this.key, JSON.stringify(this.account));
  }

  get memberId() {
    return this.account?.memberId ?? null;
  }

  get circleId() {
    return this.account?.circleId ?? null;
  }

  /** Join a circle with an agent invite link. */
  async join(link) {
    const { serverUrl, inviteId, secret } = parseInviteLink(link);
    const { inviteAuth } = deriveInvite(secret);
    const api = this._api(serverUrl);
    const preview = await api.joinPreview({ inviteId, inviteAuth });
    if (preview.kind !== 'agent') throw new Error('That isn’t an agent invite');
    const identity = generateIdentity();
    const memberId = randomId();
    const res = await api.join({ inviteId, inviteAuth, member: { id: memberId, boxPub: identity.boxPub, signPub: identity.signPub } });
    this.account = { server: serverUrl, token: res.token, memberId, circleId: null, identity, known: {}, cursor: 0 };
    this.api = this._api(serverUrl, res.token);
    await this.refresh();
    return memberId;
  }

  /** Members and their public keys, from the server. A key that changes for someone already known is not trusted. */
  async refresh() {
    const st = await this.api.state();
    this.epoch = st.epoch;
    this.account.circleId = st.circleId;
    const known = this.account.known;
    this.members = new Map();
    for (const m of st.members) {
      const pinned = known[m.id];
      const keyChanged = !!pinned && (pinned.signPub !== m.signPub || pinned.boxPub !== m.boxPub);
      if (!pinned && !m.removed) known[m.id] = { signPub: m.signPub, boxPub: m.boxPub };
      this.members.set(m.id, { id: m.id, role: m.role, kind: m.kind || 'person', removed: !!m.removed, keyChanged, signPub: m.signPub, boxPub: m.boxPub });
    }
    // Which features the circle has (null from servers before they could be chosen: all of them).
    this.features = st.features ?? null;
    await this._save();
    this.emit('members', this.members);
    return st;
  }

  /** Whether the circle has a feature on (shopping lists, reminders, files…). */
  feature(id) {
    return hasFeature(this.features, id);
  }

  /** The people in the circle (not the agent), who can talk to it. */
  people() {
    return [...this.members.values()].filter((m) => !m.removed && m.kind !== 'agent' && !m.keyChanged);
  }

  isAdmin(memberId) {
    const role = this.members.get(memberId)?.role;
    return role === 'owner' || role === 'admin';
  }

  _keyWith(memberId) {
    const m = this.members.get(memberId);
    if (!m || m.keyChanged) return null;
    return directKey(this.account.identity.boxSecret, m.boxPub);
  }

  /** Take in a message: only one sealed to this agent by a member it knows. */
  _take(m) {
    if (this.seen.has(m.id) || m.to !== this.memberId) return null;
    this.seen.add(m.id);
    const sender = this.members.get(m.from);
    const key = sender && !sender.removed ? this._keyWith(m.from) : null;
    if (!key) return null;
    try {
      const msg = open(m.env, { key, signPub: sender.signPub, from: m.from, to: this.memberId, circle: this.circleId, id: m.id });
      if (msg.kind !== 'chat') return null;
      return { id: m.id, seq: m.seq, from: m.from, ts: msg.ts, body: msg.body };
    } catch (e) {
      this.onError(e);
      return null;
    }
  }

  /** Everything sent to the agent since last time. Emits 'message' for each. */
  async fetchMessages() {
    const out = [];
    for (;;) {
      const { messages } = await this.api.messages(this.account.cursor, 500);
      for (const m of messages) {
        if (m.from !== this.memberId && !this.members.has(m.from)) await this.refresh();
        const msg = this._take(m);
        this.account.cursor = Math.max(this.account.cursor, m.seq);
        if (msg) {
          out.push(msg);
          this.emit('message', msg);
        }
      }
      if (messages.length < 500) break;
    }
    await this._save();
    return out;
  }

  /** Send one person a direct message (sealed with the key only the two share). */
  async send(to, body) {
    const key = this._keyWith(to);
    if (!key) throw new Error('No such member');
    const id = randomId(12);
    const post = () =>
      this.api.postMessage(
        id,
        seal({ kind: 'chat', from: this.memberId, to, circle: this.circleId, epoch: this.epoch, key, signSecret: this.account.identity.signSecret, body, id }),
        { to },
      );
    try {
      await post();
    } catch (e) {
      // The circle key moved on: envelopes carry its number, so pick it up and retry.
      if (!(e instanceof ApiError && e.code === 'stale_epoch')) throw e;
      await this.refresh();
      await post();
    }
    return id;
  }

  /** Keep up live: new messages, members joining or leaving. */
  connect() {
    if (this.connection) return;
    let connectedBefore = false;
    this.connection = this.api.connect({
      onStatus: (s) => {
        if (s === 'online') {
          if (connectedBefore) this.fetchMessages().catch(this.onError);
          connectedBefore = true;
        }
      },
      onEvent: async (e) => {
        try {
          // Removed from the circle: nothing to refresh any more (it would fail).
          if (e.type === 'removed' && e.memberId === this.memberId) return this.emit('removed', {});
          if (e.type === 'message' && e.message?.to === this.memberId) await this.fetchMessages();
          else if (e.type === 'members_changed' || e.type === 'removed' || e.type === 'key_rotated' || e.type === 'circle') await this.refresh();
        } catch (err) {
          this.onError(err);
        }
      },
    });
  }

  disconnect() {
    this.connection?.close();
    this.connection = null;
  }
}
