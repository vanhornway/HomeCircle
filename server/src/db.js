// SQLite storage via Node's built-in node:sqlite (no native modules, so the
// same image runs on x86 servers and Raspberry Pis).
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (
  k TEXT PRIMARY KEY,
  v TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS members (
  id TEXT PRIMARY KEY,
  role TEXT NOT NULL,
  box_pub TEXT NOT NULL,
  sign_pub TEXT NOT NULL,
  profile TEXT NOT NULL,
  token_hash TEXT UNIQUE,
  push_token TEXT,
  push_platform TEXT,
  joined_at INTEGER NOT NULL,
  last_seen_at INTEGER,
  removed_at INTEGER
);
CREATE TABLE IF NOT EXISTS invites (
  id TEXT PRIMARY KEY,
  auth_hash TEXT NOT NULL,
  wrapped TEXT NOT NULL,
  epoch INTEGER NOT NULL,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used_by TEXT,
  used_at INTEGER,
  revoked_at INTEGER
);
CREATE TABLE IF NOT EXISTS key_envelopes (
  epoch INTEGER NOT NULL,
  member_id TEXT NOT NULL,
  from_id TEXT NOT NULL,
  env TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (epoch, member_id)
);
CREATE TABLE IF NOT EXISTS locations (
  member_id TEXT PRIMARY KEY,
  env TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS messages (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  from_id TEXT NOT NULL,
  env TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS messages_created ON messages (created_at);
CREATE TABLE IF NOT EXISTS places (
  id TEXT PRIMARY KEY,
  env TEXT NOT NULL,
  updated_by TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
`;

export function openDb(dataDir) {
  mkdirSync(dataDir, { recursive: true });
  const db = new DatabaseSync(join(dataDir, 'homecircle.db'));
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  db.exec(SCHEMA);
  return new Store(db);
}

const parse = (s) => (s ? JSON.parse(s) : null);

function memberRow(r) {
  return r && {
    id: r.id,
    role: r.role,
    boxPub: r.box_pub,
    signPub: r.sign_pub,
    profile: parse(r.profile),
    pushToken: r.push_token,
    pushPlatform: r.push_platform,
    joinedAt: r.joined_at,
    lastSeenAt: r.last_seen_at,
    removed: r.removed_at != null,
  };
}

export class Store {
  constructor(db) {
    this.db = db;
    this.stmts = new Map();
  }

  q(sql) {
    let s = this.stmts.get(sql);
    if (!s) {
      s = this.db.prepare(sql);
      this.stmts.set(sql, s);
    }
    return s;
  }

  tx(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const r = fn();
      this.db.exec('COMMIT');
      return r;
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  // meta
  getMeta(k) {
    return this.q('SELECT v FROM meta WHERE k = ?').get(k)?.v ?? null;
  }
  setMeta(k, v) {
    this.q('INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v').run(k, String(v));
  }
  get isSetup() {
    return this.getMeta('circle_id') != null;
  }
  get epoch() {
    return Number(this.getMeta('epoch') || 0);
  }

  // members
  insertMember({ id, role, boxPub, signPub, profile, tokenHash, now }) {
    this.q(
      `INSERT INTO members (id, role, box_pub, sign_pub, profile, token_hash, joined_at, last_seen_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(id, role, boxPub, signPub, JSON.stringify(profile), tokenHash, now, now);
  }
  memberByToken(tokenHash) {
    return memberRow(this.q('SELECT * FROM members WHERE token_hash = ? AND removed_at IS NULL').get(tokenHash));
  }
  member(id) {
    return memberRow(this.q('SELECT * FROM members WHERE id = ?').get(id));
  }
  members() {
    return this.q('SELECT * FROM members ORDER BY joined_at').all().map(memberRow);
  }
  activeMembers() {
    return this.members().filter((m) => !m.removed);
  }
  touchMember(id, now) {
    this.q('UPDATE members SET last_seen_at = ? WHERE id = ?').run(now, id);
  }
  setProfile(id, profile) {
    this.q('UPDATE members SET profile = ? WHERE id = ?').run(JSON.stringify(profile), id);
  }
  setPush(id, token, platform) {
    // A push token belongs to one device; clear it from anyone else first.
    if (token) this.q('UPDATE members SET push_token = NULL WHERE push_token = ? AND id != ?').run(token, id);
    this.q('UPDATE members SET push_token = ?, push_platform = ? WHERE id = ?').run(token, platform, id);
  }
  clearPushToken(token) {
    this.q('UPDATE members SET push_token = NULL WHERE push_token = ?').run(token);
  }
  setRole(id, role) {
    this.q('UPDATE members SET role = ? WHERE id = ?').run(role, id);
  }
  removeMember(id, now) {
    this.q('UPDATE members SET removed_at = ?, token_hash = NULL, push_token = NULL WHERE id = ?').run(now, id);
    this.q('DELETE FROM locations WHERE member_id = ?').run(id);
  }

  // invites
  insertInvite({ id, authHash, wrapped, epoch, createdBy, now, expiresAt }) {
    this.q(
      `INSERT INTO invites (id, auth_hash, wrapped, epoch, created_by, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(id, authHash, JSON.stringify(wrapped), epoch, createdBy, now, expiresAt);
  }
  invite(id) {
    const r = this.q('SELECT * FROM invites WHERE id = ?').get(id);
    return r && { ...r, wrapped: parse(r.wrapped) };
  }
  openInvites(now) {
    return this.q(
      `SELECT id, created_by, created_at, expires_at FROM invites
       WHERE used_at IS NULL AND revoked_at IS NULL AND expires_at > ? ORDER BY created_at DESC`,
    ).all(now);
  }
  countOpenInvites(now) {
    return this.openInvites(now).length;
  }
  useInvite(id, memberId, now) {
    return this.q('UPDATE invites SET used_by = ?, used_at = ? WHERE id = ? AND used_at IS NULL AND revoked_at IS NULL').run(
      memberId,
      now,
      id,
    ).changes;
  }
  revokeInvite(id, now) {
    return this.q('UPDATE invites SET revoked_at = ? WHERE id = ? AND used_at IS NULL').run(now, id).changes;
  }
  revokeAllInvites(now) {
    this.q('UPDATE invites SET revoked_at = ? WHERE used_at IS NULL AND revoked_at IS NULL').run(now);
  }

  // keys
  insertEnvelope({ epoch, memberId, fromId, env, now }) {
    this.q('INSERT INTO key_envelopes (epoch, member_id, from_id, env, created_at) VALUES (?, ?, ?, ?, ?)').run(
      epoch,
      memberId,
      fromId,
      JSON.stringify(env),
      now,
    );
  }
  envelopesFor(memberId, since) {
    return this.q('SELECT * FROM key_envelopes WHERE member_id = ? AND epoch > ? ORDER BY epoch')
      .all(memberId, since)
      .map((r) => ({ epoch: r.epoch, from: r.from_id, ...parse(r.env) }));
  }

  // locations
  putLocation(memberId, env, now) {
    this.q(
      `INSERT INTO locations (member_id, env, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(member_id) DO UPDATE SET env = excluded.env, updated_at = excluded.updated_at`,
    ).run(memberId, JSON.stringify(env), now);
  }
  locations() {
    return this.q(
      `SELECT l.* FROM locations l JOIN members m ON m.id = l.member_id WHERE m.removed_at IS NULL`,
    )
      .all()
      .map((r) => ({ memberId: r.member_id, env: parse(r.env), updatedAt: r.updated_at }));
  }

  // messages
  insertMessage({ id, fromId, env, now }) {
    const r = this.q('INSERT INTO messages (id, from_id, env, created_at) VALUES (?, ?, ?, ?)').run(
      id,
      fromId,
      JSON.stringify(env),
      now,
    );
    return Number(r.lastInsertRowid);
  }
  messagesAfter(after, limit) {
    return this.q('SELECT * FROM messages WHERE seq > ? ORDER BY seq LIMIT ?')
      .all(after, limit)
      .map(messageRow);
  }
  messageExists(id) {
    return !!this.q('SELECT 1 FROM messages WHERE id = ?').get(id);
  }
  pruneMessages(before) {
    return this.q('DELETE FROM messages WHERE created_at < ?').run(before).changes;
  }
  pruneInvites(before) {
    return this.q('DELETE FROM invites WHERE expires_at < ?').run(before).changes;
  }

  // places
  putPlace(id, env, by, now) {
    this.q(
      `INSERT INTO places (id, env, updated_by, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET env = excluded.env, updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
    ).run(id, JSON.stringify(env), by, now);
  }
  places() {
    return this.q('SELECT * FROM places ORDER BY updated_at').all().map(placeRow);
  }
  place(id) {
    const r = this.q('SELECT * FROM places WHERE id = ?').get(id);
    return r && placeRow(r);
  }
  countPlaces() {
    return this.q('SELECT COUNT(*) AS n FROM places').get().n;
  }
  deletePlace(id) {
    return this.q('DELETE FROM places WHERE id = ?').run(id).changes;
  }

  close() {
    this.db.close();
  }
}

export function messageRow(r) {
  return { seq: r.seq, id: r.id, from: r.from_id, env: parse(r.env), createdAt: r.created_at };
}

function placeRow(r) {
  return { id: r.id, env: parse(r.env), updatedBy: r.updated_by, updatedAt: r.updated_at };
}
