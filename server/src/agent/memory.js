// The agent's memory for one circle: small linked notes, like an Obsidian
// vault. On disk every note's text is encrypted with the agent's key; at
// start the notes are read into an in-memory SQLite index (full text, links,
// dates) so lookups take milliseconds and cost nothing.
//
// A note is circle memory (scope 'circle', anyone in the circle can recall
// it) or one person's private note (scope = their member id). Every change
// keeps the version before it, with who made it, so any edit can be undone.
import { DatabaseSync } from 'node:sqlite';
import nacl from 'tweetnacl';
import { randomBytes } from 'node:crypto';

export const NOTE_TYPES = ['person', 'place', 'schedule', 'event', 'decision', 'fact', 'recipe', 'contact', 'health', 'document', 'trip', 'howto', 'source'];
// Kinds of note that are over once their dates have passed.
export const DATED_TYPES = ['event', 'schedule', 'trip'];
const DAY = 86400_000;

const enc = new TextEncoder();
const dec = new TextDecoder();
const b64 = (u8) => Buffer.from(u8).toString('base64');
const unb64 = (s) => new Uint8Array(Buffer.from(s, 'base64'));

/** "[[Kid]] has soccer" → ['kid'] */
export function linksIn(text) {
  return [...String(text || '').matchAll(/\[\[([^\]]{1,80})\]\]/g)].map((m) => m[1].trim().toLowerCase());
}

const day = (v) => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null);

/** Tags as given ("#Dentist", "health care") → ['dentist', 'health care']: lowercase, unique, at most 12. */
export function cleanTags(tags) {
  if (!Array.isArray(tags)) return [];
  const out = tags.map((t) => String(t).toLowerCase().replace(/^#+/, '').replace(/\s+/g, ' ').trim().slice(0, 30)).filter(Boolean);
  return [...new Set(out)].slice(0, 12);
}

/** The lines under a recipe's "## Ingredients" (or "Ingredients:"), without their bullets or sub-headings like "For the rice:". */
export function recipeIngredients(body) {
  const m = String(body || '').match(/^(?:#{1,4}\s*)?ingredients\b[^\n]*\n([\s\S]*?)(?=^#{1,2}\s|^(?:#{1,4}\s*)?(?:steps|method|directions|instructions)\b|$(?![\s\S]))/im);
  if (!m) return [];
  return m[1]
    .split('\n')
    .filter((l) => !/^\s*#/.test(l))
    .map((l) => l.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, '').replace(/^\[[ x]\]\s*/i, '').trim())
    .filter((l) => l && !/:$/.test(l.replace(/\*+/g, '')))
    .slice(0, 100);
}

/**
 * A recipe's data: { serves, time, ingredients }. The ingredients follow the
 * body's Ingredients list when it has one, so an edit there keeps them in step.
 */
function recipeData(data, body) {
  const d = data && typeof data === 'object' ? data : {};
  const fromBody = recipeIngredients(body);
  const given = Array.isArray(d.ingredients) ? d.ingredients.map((i) => String(i).trim()).filter(Boolean).slice(0, 100) : [];
  const text = (v) => (v == null || v === '' ? null : String(v).slice(0, 60));
  return { ...d, serves: text(d.serves), time: text(d.time), ingredients: fromBody.length ? fromBody : given };
}

// What each kind of note keeps in its data, besides anything else already there.
const TYPE_FIELDS = {
  contact: ['role', 'phone', 'email', 'address', 'hours', 'website'],
  health: ['kind', 'dose', 'schedule', 'refillBy'],
  document: ['kind', 'owner', 'expires', 'number_last4', 'where'],
  howto: ['every'],
  person: ['sizes', 'gifts', 'favourites'],
};
const DATE_FIELDS = new Set(['refillBy', 'expires']);
export const LEG_KINDS = ['flight', 'train', 'hotel', 'car', 'other'];

/** A trip's legs as given → [{ kind, from, to, at, arrives, confirmation }]. */
function cleanLegs(legs) {
  if (!Array.isArray(legs)) return [];
  const text = (v) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, 120);
  return legs
    .filter((l) => l && typeof l === 'object')
    .map((l) => ({ kind: LEG_KINDS.includes(l.kind) ? l.kind : 'other', from: text(l.from), to: text(l.to), at: text(l.at), arrives: text(l.arrives), confirmation: text(l.confirmation) }))
    .filter((l) => l.from || l.to || l.at)
    .slice(0, 30);
}

/** A typed note's data: its own fields trimmed (blank ones dropped, dates checked), the rest kept. */
function typeData(type, data) {
  const d = data && typeof data === 'object' ? { ...data } : {};
  for (const k of TYPE_FIELDS[type] ?? []) {
    const v = d[k] == null ? '' : String(d[k]).replace(/\s+/g, ' ').trim().slice(0, 300);
    if (k === 'number_last4') d[k] = v.replace(/\D/g, '').slice(-4) || null;
    else d[k] = DATE_FIELDS.has(k) ? day(v) : v || null;
    if (d[k] == null) delete d[k];
  }
  if (type === 'trip') d.legs = cleanLegs(d.legs);
  return Object.keys(d).length ? d : null;
}

// --- secrets ---------------------------------------------------------------
// The helper never keeps a password, a code, or a whole card, account, ID or
// passport number: only the last 4 digits. Enforced here, whatever the AI or
// the app sends.

const keepLast4 = (digits) => `ending ${digits.slice(-4)}`;
const luhn = (digits) => {
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let n = Number(digits[digits.length - 1 - i]);
    if (i % 2) n = n * 2 > 9 ? n * 2 - 9 : n * 2;
    sum += n;
  }
  return sum % 10 === 0;
};
const CODE_WORDS =
  '(?:wi-?fi\\s+)?(?:passwords?|passcodes?|pass\\s+codes?|passphrases?|pins?(?:\\s+(?:numbers?|codes?))?|(?:alarm|door|gate|garage(?:\\s+door)?|lock|key|keypad|security|access|entry|safe|lockbox|unlock)\\s+codes?|cvv|cvc|codes?)';
// "the door code is 4821", "password: hunter2", "alarm code 4821" (a bare value needs a digit). Not zip codes and the like.
const CODE_RE = new RegExp(`(?<!\\b(?:zip|post|postal|area|country|dress|promo|discount|source|bar|qr|dial(?:ling)?)\\s)\\b(${CODE_WORDS})(\\s*(?:is|was|=|:)\\s*|\\s+(?=\\S*\\d))([^\\s,;]+)`, 'gi');
const PHONE_BEFORE = /(?:phone|tel|telephone|call|cell|mobile|text|fax|whatsapp)\b[^\n\d]{0,12}$/i;

/** Text with secrets taken out: { text, found } (found is true when anything was). */
export function scrubSecrets(text, { numbers = true } = {}) {
  let found = false;
  const hit = (out) => {
    found = true;
    return out;
  };
  let t = String(text ?? '').replace(CODE_RE, (m, word, sep, value) => {
    // "code is 4821." keeps its full stop.
    const end = value.match(/[.!?)]+$/)?.[0] ?? '';
    return value.slice(0, value.length - end.length) === '[not' ? m : hit(`${word}${sep}[not kept]${end}`);
  });
  if (numbers) {
    t = t
      // Social Security numbers.
      .replace(/\b\d{3}-\d{2}-\d{4}\b/g, (m) => hit(keepLast4(m.replace(/\D/g, ''))))
      // Card numbers, with or without spaces or dashes.
      .replace(/\b\d(?:[ -]?\d){12,18}\b/g, (m) => (luhn(m.replace(/\D/g, '')) ? hit(keepLast4(m.replace(/\D/g, ''))) : m))
      // Account, ID and passport numbers: 9 or more digits in a row, unless it's a phone number.
      .replace(/(\+?)\b\d{9,}\b/g, (m, plus, at, all) => (plus || PHONE_BEFORE.test(all.slice(Math.max(0, at - 24), at)) ? m : hit(keepLast4(m))))
      // Letters then digits, like a passport or licence number (X12345678).
      .replace(/\b[A-Z]{1,2}\d{6,9}\b/g, (m) => hit(keepLast4(m.replace(/\D/g, ''))));
  }
  return { text: t, found };
}

/** Every string in a note's data scrubbed (phone numbers kept; files and calendar dates as they are). */
function scrubData(v, key = '') {
  if (typeof v === 'string') return scrubSecrets(v, { numbers: !/^(?:phone|fax|email|website|url|at)$/.test(key) }).text;
  if (Array.isArray(v)) return v.map((x) => scrubData(x, key));
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, k === 'file' || k === 'events' ? x : scrubData(x, k)]));
  return v;
}

/** A note as given, cleaned up: { type, title, body, people, tags, start, end, data, source }. */
export function cleanNote(n) {
  const type = NOTE_TYPES.includes(n?.type) ? n.type : 'fact';
  // Calendars keep their dates and ids as they are; everything else loses any secrets.
  const scrub = (t) => (type === 'source' ? t : scrubSecrets(t).text);
  const title = scrub(String(n?.title || '').trim()).slice(0, 120);
  const body = scrub(String(n?.body || '')).slice(0, 20_000);
  if (!title && !body) throw new Error('A note needs a title or some text');
  const start = day(n?.start);
  const end = day(n?.end) ?? start;
  const people = Array.isArray(n?.people) ? [...new Set(n.people.map((p) => String(p).trim()).filter(Boolean))].slice(0, 20) : [];
  return {
    type,
    title: title || body.split('\n')[0].slice(0, 80),
    body,
    people,
    // Words to find it by later: its topic, other words for it, who, where.
    tags: cleanTags(n?.tags),
    start,
    end: start && end && end < start ? start : end,
    // Anything structured (a calendar's events, a source's URL): kept as is.
    data: type === 'source' ? (n?.data && typeof n.data === 'object' ? n.data : null) : scrubData(type === 'recipe' ? recipeData(n?.data, body) : typeData(type, n?.data)),
    source: n?.source ? String(n.source).slice(0, 200) : null,
  };
}

export class Memory {
  /**
   * @param {string} file SQLite file for this circle's notes
   * @param {Uint8Array} key 32-byte key the notes are encrypted with
   */
  constructor(file, key) {
    this.key = key;
    this.db = new DatabaseSync(file);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS notes (id TEXT PRIMARY KEY, scope TEXT NOT NULL, sealed TEXT NOT NULL, created_by TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, deleted INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS history (note_id TEXT NOT NULL, at INTEGER NOT NULL, by TEXT, sealed TEXT, deleted INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS history_note ON history (note_id, at);
      CREATE TABLE IF NOT EXISTS usage (month TEXT NOT NULL, member TEXT NOT NULL, usd REAL NOT NULL, PRIMARY KEY (month, member));
      CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT NOT NULL);
    `);
    // The index: plain text, in memory only.
    this.ix = new DatabaseSync(':memory:');
    this.ix.exec(`
      CREATE TABLE n (id TEXT PRIMARY KEY, scope TEXT, type TEXT, title TEXT, start TEXT, end_ TEXT, archived INTEGER, updated_at INTEGER);
      CREATE VIRTUAL TABLE t USING fts5(id UNINDEXED, title, body, people, tags, tokenize = 'porter unicode61');
      CREATE TABLE l (src TEXT, dst TEXT);
      CREATE TABLE g (id TEXT, tag TEXT);
      CREATE INDEX g_tag ON g (tag);
      CREATE INDEX l_src ON l (src);
      CREATE INDEX l_dst ON l (dst);
      CREATE INDEX n_dates ON n (start, end_);
    `);
    // Prepared once: a lookup runs many of these.
    const q = (sql) => this.ix.prepare(sql);
    this.q = {
      insN: q('INSERT INTO n VALUES (?, ?, ?, ?, ?, ?, ?, ?)'),
      insT: q('INSERT INTO t VALUES (?, ?, ?, ?, ?)'),
      insL: q('INSERT INTO l VALUES (?, ?)'),
      insG: q('INSERT INTO g VALUES (?, ?)'),
      delN: q('DELETE FROM n WHERE id = ?'),
      delT: q('DELETE FROM t WHERE id = ?'),
      delL: q('DELETE FROM l WHERE src = ?'),
      delG: q('DELETE FROM g WHERE id = ?'),
      tagged: q('SELECT id FROM g WHERE tag = ?'),
      text: q('SELECT id, bm25(t) AS s FROM t WHERE t MATCH ? ORDER BY s LIMIT 60'),
      titled: q('SELECT id FROM n WHERE title = ?'),
      // The most recent notes that link to someone, not all of them.
      linkingTo: q('SELECT l.src AS id FROM l JOIN n ON n.id = l.src WHERE l.dst = ? ORDER BY n.updated_at DESC LIMIT 60'),
      linkedFrom: q('SELECT n.id FROM l JOIN n ON n.title = l.dst WHERE l.src = ?'),
      dated: q('SELECT id FROM n WHERE start IS NOT NULL AND end_ >= ? AND start <= ?'),
      archived: q('SELECT id FROM n WHERE archived = 1'),
    };
    this.notes = new Map();
    for (const r of this.db.prepare('SELECT * FROM notes WHERE deleted = 0').all()) this._index(this._row(r));
  }

  close() {
    this.db.close();
    this.ix.close();
  }

  _seal(obj) {
    const nonce = randomBytes(24);
    return `${b64(nonce)}.${b64(nacl.secretbox(enc.encode(JSON.stringify(obj)), nonce, this.key))}`;
  }

  _open(s) {
    const [n, c] = String(s).split('.');
    const plain = nacl.secretbox.open(unb64(c), unb64(n), this.key);
    if (!plain) throw new Error('Memory note could not be decrypted (wrong key?)');
    return JSON.parse(dec.decode(plain));
  }

  _row(r) {
    return { id: r.id, scope: r.scope, createdBy: r.created_by, createdAt: r.created_at, updatedAt: r.updated_at, ...this._open(r.sealed) };
  }

  _index(note) {
    this._unindex(note.id);
    this.notes.set(note.id, note);
    const archived = note.end && note.end < new Date(Date.now() - DAY).toISOString().slice(0, 10) && DATED_TYPES.includes(note.type) ? 1 : 0;
    this.q.insN.run(note.id, note.scope, note.type, note.title.toLowerCase(), note.start, note.end, archived, note.updatedAt);
    const tags = note.tags ?? [];
    this.q.insT.run(note.id, note.title, note.body, note.people.join(' '), tags.join(' '));
    for (const tag of tags) this.q.insG.run(note.id, tag);
    for (const to of new Set([...linksIn(note.body), ...note.people.map((p) => p.toLowerCase())])) this.q.insL.run(note.id, to);
  }

  _unindex(id) {
    this.notes.delete(id);
    this.q.delN.run(id);
    this.q.delT.run(id);
    this.q.delL.run(id);
    this.q.delG.run(id);
  }

  _canSee(note, memberId) {
    return note.scope === 'circle' || note.scope === memberId;
  }

  /** Save a new note. Returns it. */
  add(note, { scope = 'circle', by = null, now = Date.now() } = {}) {
    const n = cleanNote(note);
    const id = randomBytes(9).toString('base64url');
    this.db.prepare('INSERT INTO notes (id, scope, sealed, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(id, scope, this._seal(n), by, now, now);
    this.db.prepare('INSERT INTO history (note_id, at, by, sealed, deleted) VALUES (?, ?, ?, NULL, 0)').run(id, now, by);
    const full = { id, scope, createdBy: by, createdAt: now, updatedAt: now, ...n };
    this._index(full);
    return full;
  }

  /** Change a note someone can see (keeps the old version). */
  update(id, patch, { by, now = Date.now() } = {}) {
    const old = this.notes.get(id);
    if (!old || !this._canSee(old, by)) throw new Error('No such note');
    const { id: _i, scope, createdBy, createdAt, updatedAt, ...prev } = old;
    const n = cleanNote({ ...prev, ...patch });
    this.db.prepare('INSERT INTO history (note_id, at, by, sealed, deleted) VALUES (?, ?, ?, ?, 0)').run(id, now, by, this._seal(prev));
    this.db.prepare('UPDATE notes SET sealed = ?, updated_at = ? WHERE id = ?').run(this._seal(n), now, id);
    const full = { ...old, ...n, updatedAt: now };
    this._index(full);
    return full;
  }

  /** Delete a note someone can see (it can still be brought back with undo). */
  remove(id, { by, now = Date.now() } = {}) {
    const old = this.notes.get(id);
    if (!old || !this._canSee(old, by)) throw new Error('No such note');
    const { id: _i, scope, createdBy, createdAt, updatedAt, ...prev } = old;
    this.db.prepare('INSERT INTO history (note_id, at, by, sealed, deleted) VALUES (?, ?, ?, ?, 1)').run(id, now, by, this._seal(prev));
    this.db.prepare('UPDATE notes SET deleted = 1, updated_at = ? WHERE id = ?').run(now, id);
    this._unindex(id);
  }

  /** Undo the last change to a note: an edit goes back, a delete comes back, a new note goes away. */
  undo(id, { by, now = Date.now() } = {}) {
    const row = this.db.prepare('SELECT * FROM notes WHERE id = ?').get(id);
    if (!row) throw new Error('No such note');
    if (row.scope !== 'circle' && row.scope !== by) throw new Error('No such note');
    const last = this.db.prepare('SELECT rowid, * FROM history WHERE note_id = ? ORDER BY at DESC, rowid DESC LIMIT 1').get(id);
    if (!last) throw new Error('Nothing to undo');
    this.db.prepare('DELETE FROM history WHERE rowid = ?').run(last.rowid);
    if (last.sealed == null) {
      // It was just added: undoing removes it.
      this.db.prepare('UPDATE notes SET deleted = 1, updated_at = ? WHERE id = ?').run(now, id);
      this._unindex(id);
      return null;
    }
    this.db.prepare('UPDATE notes SET sealed = ?, deleted = 0, updated_at = ? WHERE id = ?').run(last.sealed, now, id);
    const note = this._row({ ...row, sealed: last.sealed, updated_at: now });
    this._index(note);
    return note;
  }

  /** Who changed a note, when (newest first). */
  history(id, { by } = {}) {
    const note = this.notes.get(id);
    if (note && !this._canSee(note, by)) return [];
    return this.db
      .prepare('SELECT at, by, deleted, sealed IS NULL AS created FROM history WHERE note_id = ? ORDER BY at DESC, rowid DESC')
      .all(id)
      .map((r) => ({ at: r.at, by: r.by, change: r.created ? 'added' : r.deleted ? 'deleted' : 'edited' }));
  }

  get(id, { by } = {}) {
    const n = this.notes.get(id);
    return n && this._canSee(n, by) ? n : null;
  }

  /**
   * Notes for a question, best first: full-text matches, then what they link
   * to (one or two hops), then anything in a date range. Only notes `by` can
   * see. Archived (past) events only when `archived` is set.
   */
  lookup({ text = '', people = [], from = null, to = null, by, hops = 1, archived = false, limit = 25 } = {}) {
    const scores = new Map();
    const visible = (id) => {
      const n = this.notes.get(id);
      return n && this._canSee(n, by);
    };
    const add = (id, s) => {
      if (visible(id)) scores.set(id, Math.max(scores.get(id) ?? 0, s));
    };
    const terms = [...new Set([...String(text).toLowerCase().matchAll(/[\p{L}\p{N}]{2,}/gu)].map((m) => m[0]))].filter((w) => !STOP.has(w));
    if (terms.length) {
      const q = terms.map((w) => `"${w}"*`).join(' OR ');
      for (const r of this.q.text.all(q)) add(r.id, 10 + Math.min(10, -r.s * 1e6));
      // A word that is one of a note's tags (or a two-word tag) is a strong hint.
      const pairs = terms.slice(1).map((w, i) => `${terms[i]} ${w}`);
      for (const t of [...terms, ...pairs]) for (const r of this.q.tagged.all(t)) add(r.id, 16);
    }
    // People named in the question: their notes, and notes that link to them.
    for (const p of people.map((x) => String(x).toLowerCase())) {
      for (const r of this.q.titled.all(p)) add(r.id, 15);
      for (const r of this.q.linkingTo.all(p)) add(r.id, 12);
    }
    if (from || to) {
      for (const r of this.q.dated.all(from ?? '0000-01-01', to ?? '9999-12-31')) add(r.id, 14);
    }
    // Follow links out from the best of what was found (not from everything:
    // a person most notes link to would pull in the whole memory).
    let frontier = [...scores].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([id]) => id);
    for (let hop = 1; hop <= hops && frontier.length; hop++) {
      const next = [];
      for (const id of frontier) {
        const title = this.notes.get(id)?.title.toLowerCase();
        const linked = [...this.q.linkedFrom.all(id).map((r) => r.id), ...(title ? this.q.linkingTo.all(title).map((r) => r.id) : [])];
        for (const lid of linked) {
          if (!scores.has(lid)) next.push(lid);
          add(lid, 6 / hop);
        }
      }
      frontier = next.slice(0, 12);
    }
    const archivedIds = new Set(this.q.archived.all().map((r) => r.id));
    return [...scores]
      .filter(([id]) => archived || !archivedIds.has(id))
      .sort((a, b) => b[1] - a[1])
      .slice(0, limit)
      .map(([id]) => this.notes.get(id));
  }

  /** Every note `by` can see, newest first (for the Memory screen), optionally of one type. */
  list({ by, type = null, archived = true } = {}) {
    return [...this.notes.values()]
      .filter((n) => this._canSee(n, by) && (!type || n.type === type))
      .filter((n) => archived || !(n.end && n.end < new Date(Date.now() - DAY).toISOString().slice(0, 10) && DATED_TYPES.includes(n.type)))
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }

  /** A person note by name (any scope `by` can see), or null. */
  person(name, { by } = {}) {
    const key = String(name).trim().toLowerCase();
    return [...this.notes.values()].find((n) => n.type === 'person' && n.title.toLowerCase() === key && this._canSee(n, by)) ?? null;
  }

  // --- spending -----------------------------------------------------------

  spend(memberId, usd, now = new Date()) {
    const month = now.toISOString().slice(0, 7);
    this.db.prepare('INSERT INTO usage (month, member, usd) VALUES (?, ?, ?) ON CONFLICT (month, member) DO UPDATE SET usd = usd + excluded.usd').run(month, memberId, usd);
  }

  /** This month's spending: { total, byMember: { id: usd } }. */
  spent(now = new Date()) {
    const rows = this.db.prepare('SELECT member, usd FROM usage WHERE month = ?').all(now.toISOString().slice(0, 7));
    return { total: rows.reduce((s, r) => s + r.usd, 0), byMember: Object.fromEntries(rows.map((r) => [r.member, r.usd])) };
  }

  // --- small settings (sealed too) ----------------------------------------

  getSetting(k) {
    const r = this.db.prepare('SELECT v FROM kv WHERE k = ?').get(k);
    return r ? this._open(r.v) : null;
  }

  setSetting(k, v) {
    if (v == null) this.db.prepare('DELETE FROM kv WHERE k = ?').run(k);
    else this.db.prepare('INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT (k) DO UPDATE SET v = excluded.v').run(k, this._seal(v));
  }
}

const STOP = new Set(
  'a an the and or of to in on at for is are was were be been it its this that these those what when where who whom which how do does did i me my we our us you your he she they them their with from by as about into can could should would will just next free want plan some any all'.split(' '),
);
