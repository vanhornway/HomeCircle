// SQLite storage via Node's built-in node:sqlite (no native modules, so the
// same image runs on x86 servers and Raspberry Pis).
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

// One server hosts any number of circles. Every row belongs to exactly one
// circle (directly, or through its member), and every query is scoped to it.
const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (
  k TEXT PRIMARY KEY,
  v TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS circles (
  id TEXT PRIMARY KEY,
  epoch INTEGER NOT NULL,
  rotation_needed INTEGER NOT NULL DEFAULT 0,
  retention_days INTEGER NOT NULL DEFAULT 90,
  env TEXT NOT NULL,
  env_by TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS members (
  id TEXT PRIMARY KEY,
  circle_id TEXT,
  server_admin INTEGER NOT NULL DEFAULT 0,
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
  circle_id TEXT,
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
  circle_id TEXT,
  to_id TEXT,
  from_id TEXT NOT NULL,
  env TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS messages_created ON messages (created_at);
CREATE TABLE IF NOT EXISTS places (
  id TEXT PRIMARY KEY,
  circle_id TEXT,
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
  migrateToMultiCircle(db);
  db.exec(`
    CREATE INDEX IF NOT EXISTS members_circle ON members (circle_id);
    CREATE INDEX IF NOT EXISTS invites_circle ON invites (circle_id);
    CREATE INDEX IF NOT EXISTS messages_circle_seq ON messages (circle_id, seq);
    CREATE INDEX IF NOT EXISTS places_circle ON places (circle_id);
  `);
  return new Store(db);
}

/**
 * Servers from before multi-circle support kept their single circle in
 * `meta` and had no circle_id columns. Move that circle into `circles`,
 * tag every row with it, and make its owner a server admin.
 */
function migrateToMultiCircle(db) {
  const cols = (table) => db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
  const add = (table, col, def) => {
    if (!cols(table).includes(col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`);
  };
  add('members', 'circle_id', 'TEXT');
  add('members', 'server_admin', 'INTEGER NOT NULL DEFAULT 0');
  add('invites', 'circle_id', 'TEXT');
  add('messages', 'circle_id', 'TEXT');
  add('places', 'circle_id', 'TEXT');
  add('circles', 'retention_days', 'INTEGER NOT NULL DEFAULT 90');
  add('messages', 'to_id', 'TEXT');

  const meta = (k) => db.prepare('SELECT v FROM meta WHERE k = ?').get(k)?.v ?? null;
  const circleId = meta('circle_id');
  if (!circleId) return;
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare(
      `INSERT OR IGNORE INTO circles (id, epoch, rotation_needed, env, env_by, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(circleId, Number(meta('epoch') || 1), meta('rotation_needed') === '1' ? 1 : 0, meta('circle_env'), meta('circle_by'), Number(meta('created_at') || Date.now()));
    for (const t of ['members', 'invites', 'messages', 'places']) {
      db.prepare(`UPDATE ${t} SET circle_id = ? WHERE circle_id IS NULL`).run(circleId);
    }
    db.prepare(`UPDATE members SET server_admin = 1 WHERE role = 'owner' AND circle_id = ?`).run(circleId);
    db.prepare(`DELETE FROM meta WHERE k IN ('circle_id', 'epoch', 'rotation_needed', 'circle_env', 'circle_by', 'created_at')`).run();
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

const parse = (s) => (s ? JSON.parse(s) : null);

function memberRow(r) {
  return r && {
    id: r.id,
    circleId: r.circle_id,
    serverAdmin: r.server_admin === 1,
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

  // circles
  get isSetup() {
    return this.circleCount() > 0;
  }
  circleCount() {
    return this.q('SELECT COUNT(*) AS n FROM circles').get().n;
  }
  /** The only circle's id, if the server has exactly one (older apps check it). */
  soleCircleId() {
    const rows = this.q('SELECT id FROM circles LIMIT 2').all();
    return rows.length === 1 ? rows[0].id : null;
  }
  insertCircle({ id, env, by, now, retentionDays }) {
    this.q('INSERT INTO circles (id, epoch, rotation_needed, retention_days, env, env_by, created_at) VALUES (?, 1, 0, ?, ?, ?, ?)').run(
      id,
      retentionDays,
      JSON.stringify(env),
      by,
      now,
    );
  }
  setRetention(id, days) {
    this.q('UPDATE circles SET retention_days = ? WHERE id = ?').run(days, id);
  }
  circle(id) {
    const r = this.q('SELECT * FROM circles WHERE id = ?').get(id);
    return (
      r && {
        id: r.id,
        epoch: r.epoch,
        rotationNeeded: r.rotation_needed === 1,
        retentionDays: r.retention_days,
        env: parse(r.env),
        by: r.env_by,
        createdAt: r.created_at,
      }
    );
  }
  circleExists(id) {
    return !!this.q('SELECT 1 FROM circles WHERE id = ?').get(id);
  }
  setCircleEnv(id, env, by) {
    this.q('UPDATE circles SET env = ?, env_by = ? WHERE id = ?').run(JSON.stringify(env), by, id);
  }
  setCircleEpoch(id, epoch) {
    this.q('UPDATE circles SET epoch = ?, rotation_needed = 0 WHERE id = ?').run(epoch, id);
  }
  setRotationNeeded(id) {
    this.q('UPDATE circles SET rotation_needed = 1 WHERE id = ?').run(id);
  }
  /** Delete a circle and everything in it. */
  deleteCircle(id) {
    const members = this.q('SELECT id FROM members WHERE circle_id = ?').all(id).map((r) => r.id);
    for (const m of members) {
      this.q('DELETE FROM locations WHERE member_id = ?').run(m);
      this.q('DELETE FROM key_envelopes WHERE member_id = ?').run(m);
    }
    for (const t of ['messages', 'places', 'invites', 'members']) this.q(`DELETE FROM ${t} WHERE circle_id = ?`).run(id);
    this.q('DELETE FROM circles WHERE id = ?').run(id);
    return members;
  }

  // members
  insertMember({ id, circleId, role, serverAdmin = false, boxPub, signPub, profile, tokenHash, now }) {
    this.q(
      `INSERT INTO members (id, circle_id, server_admin, role, box_pub, sign_pub, profile, token_hash, joined_at, last_seen_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(id, circleId, serverAdmin ? 1 : 0, role, boxPub, signPub, JSON.stringify(profile), tokenHash, now, now);
  }
  memberByToken(tokenHash) {
    return memberRow(this.q('SELECT * FROM members WHERE token_hash = ? AND removed_at IS NULL').get(tokenHash));
  }
  memberExists(id) {
    return !!this.q('SELECT 1 FROM members WHERE id = ?').get(id);
  }
  /** A member of this circle (removed ones included), or null. */
  member(circleId, id) {
    return memberRow(this.q('SELECT * FROM members WHERE id = ? AND circle_id = ?').get(id, circleId));
  }
  members(circleId) {
    return this.q('SELECT * FROM members WHERE circle_id = ? ORDER BY joined_at').all(circleId).map(memberRow);
  }
  activeMembers(circleId) {
    return this.members(circleId).filter((m) => !m.removed);
  }
  touchMember(id, now) {
    this.q('UPDATE members SET last_seen_at = ? WHERE id = ?').run(now, id);
  }
  setProfile(id, profile) {
    this.q('UPDATE members SET profile = ? WHERE id = ?').run(JSON.stringify(profile), id);
  }
  setPush(member, token, platform) {
    // A push token belongs to one device, and that device has one member per
    // circle it's in. Clear it from anyone else in the same circle first.
    if (token) {
      this.q('UPDATE members SET push_token = NULL WHERE push_token = ? AND id != ? AND circle_id = ?').run(token, member.id, member.circleId);
    }
    this.q('UPDATE members SET push_token = ?, push_platform = ? WHERE id = ?').run(token, platform, member.id);
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
  insertInvite({ id, circleId, authHash, wrapped, epoch, createdBy, now, expiresAt }) {
    this.q(
      `INSERT INTO invites (id, circle_id, auth_hash, wrapped, epoch, created_by, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(id, circleId, authHash, JSON.stringify(wrapped), epoch, createdBy, now, expiresAt);
  }
  invite(id) {
    const r = this.q('SELECT * FROM invites WHERE id = ?').get(id);
    return r && { ...r, wrapped: parse(r.wrapped) };
  }
  inviteExists(id) {
    return !!this.q('SELECT 1 FROM invites WHERE id = ?').get(id);
  }
  openInvites(circleId, now) {
    return this.q(
      `SELECT id, created_by, created_at, expires_at FROM invites
       WHERE circle_id = ? AND used_at IS NULL AND revoked_at IS NULL AND expires_at > ? ORDER BY created_at DESC`,
    ).all(circleId, now);
  }
  countOpenInvites(circleId, now) {
    return this.openInvites(circleId, now).length;
  }
  useInvite(id, memberId, now) {
    return this.q('UPDATE invites SET used_by = ?, used_at = ? WHERE id = ? AND used_at IS NULL AND revoked_at IS NULL').run(
      memberId,
      now,
      id,
    ).changes;
  }
  revokeInvite(circleId, id, now) {
    return this.q('UPDATE invites SET revoked_at = ? WHERE id = ? AND circle_id = ? AND used_at IS NULL').run(now, id, circleId).changes;
  }
  revokeAllInvites(circleId, now) {
    this.q('UPDATE invites SET revoked_at = ? WHERE circle_id = ? AND used_at IS NULL AND revoked_at IS NULL').run(now, circleId);
  }

  // keys (member ids are unique server-wide, so envelopes are scoped by member)
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

  // locations (scoped through the member's circle)
  putLocation(memberId, env, now) {
    this.q(
      `INSERT INTO locations (member_id, env, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(member_id) DO UPDATE SET env = excluded.env, updated_at = excluded.updated_at`,
    ).run(memberId, JSON.stringify(env), now);
  }
  deleteLocation(memberId) {
    this.q('DELETE FROM locations WHERE member_id = ?').run(memberId);
  }
  locations(circleId) {
    return this.q(
      `SELECT l.* FROM locations l JOIN members m ON m.id = l.member_id WHERE m.circle_id = ? AND m.removed_at IS NULL`,
    )
      .all(circleId)
      .map((r) => ({ memberId: r.member_id, env: parse(r.env), updatedAt: r.updated_at }));
  }

  // messages (seq is server-wide; each circle sees an increasing subset).
  // Direct messages have to_id set and are only ever returned to their two members.
  insertMessage({ id, circleId, fromId, toId = null, env, now }) {
    const r = this.q('INSERT INTO messages (id, circle_id, from_id, to_id, env, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(
      id,
      circleId,
      fromId,
      toId,
      JSON.stringify(env),
      now,
    );
    return Number(r.lastInsertRowid);
  }
  /** Group messages plus this member's own direct messages. */
  messagesAfter(circleId, memberId, after, limit) {
    return this.q(
      `SELECT * FROM messages WHERE circle_id = ? AND seq > ? AND (to_id IS NULL OR to_id = ? OR from_id = ?)
       ORDER BY seq LIMIT ?`,
    )
      .all(circleId, after, memberId, memberId, limit)
      .map(messageRow);
  }
  messageExists(id) {
    return !!this.q('SELECT 1 FROM messages WHERE id = ?').get(id);
  }
  /** Delete each circle's messages older than its retention (and never keep more than `maxDays`). */
  pruneMessages(now, maxDays) {
    let n = 0;
    for (const c of this.q('SELECT id, retention_days FROM circles').all()) {
      const days = Math.min(maxDays, Math.max(1, c.retention_days));
      n += this.q('DELETE FROM messages WHERE circle_id = ? AND created_at < ?').run(c.id, now - days * 86400_000).changes;
    }
    // Anything not tied to a circle (shouldn't exist) goes after the maximum too.
    n += this.q('DELETE FROM messages WHERE circle_id IS NULL AND created_at < ?').run(now - maxDays * 86400_000).changes;
    return n;
  }
  pruneInvites(before) {
    return this.q('DELETE FROM invites WHERE expires_at < ?').run(before).changes;
  }

  // places
  putPlace(circleId, id, env, by, now) {
    this.q(
      `INSERT INTO places (id, circle_id, env, updated_by, updated_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET env = excluded.env, updated_by = excluded.updated_by, updated_at = excluded.updated_at
       WHERE places.circle_id = excluded.circle_id`,
    ).run(id, circleId, JSON.stringify(env), by, now);
  }
  places(circleId) {
    return this.q('SELECT * FROM places WHERE circle_id = ? ORDER BY updated_at').all(circleId).map(placeRow);
  }
  /** Which circle a place id belongs to, if any. */
  placeCircle(id) {
    return this.q('SELECT circle_id FROM places WHERE id = ?').get(id)?.circle_id ?? null;
  }
  countPlaces(circleId) {
    return this.q('SELECT COUNT(*) AS n FROM places WHERE circle_id = ?').get(circleId).n;
  }
  deletePlace(circleId, id) {
    return this.q('DELETE FROM places WHERE id = ? AND circle_id = ?').run(id, circleId).changes;
  }

  close() {
    this.db.close();
  }
}

export function messageRow(r) {
  return { seq: r.seq, id: r.id, from: r.from_id, to: r.to_id ?? null, env: parse(r.env), createdAt: r.created_at };
}

function placeRow(r) {
  return { id: r.id, env: parse(r.env), updatedBy: r.updated_by, updatedAt: r.updated_at };
}
