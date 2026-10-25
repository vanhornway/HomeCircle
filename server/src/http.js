// Minimal HTTP plumbing: errors, JSON bodies, routing, validation, rate limits.
import { createHash, timingSafeEqual } from 'node:crypto';

export class HttpError extends Error {
  constructor(status, code, message, extra = {}) {
    super(message || code);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

export const fail = (status, code, message, extra) => {
  throw new HttpError(status, code, message, extra);
};

export function sendJson(res, status, data, headers = {}) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(body);
}

/** The request body as bytes, up to `limit` (an encrypted file). */
export function readRaw(req, limit) {
  return new Promise((resolve, reject) => {
    if (Number(req.headers['content-length']) > limit) {
      reject(new HttpError(413, 'too_large', 'That file is too big'));
      return;
    }
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new HttpError(413, 'too_large', 'That file is too big'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

export function readJson(req, limit = 256 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new HttpError(413, 'too_large', 'Request body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        const v = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (v === null || typeof v !== 'object' || Array.isArray(v)) throw new Error();
        resolve(v);
      } catch {
        reject(new HttpError(400, 'bad_json', 'Body must be a JSON object'));
      }
    });
    req.on('error', reject);
  });
}

export class Router {
  constructor() {
    this.routes = [];
  }
  add(method, pattern, handler, { auth = true, cors = false, agent = false, raw = 0 } = {}) {
    const keys = [];
    const re = new RegExp(
      `^${pattern.replace(/:([a-z]+)/gi, (_, k) => {
        keys.push(k);
        return '([^/]+)';
      })}$`,
    );
    this.routes.push({ method, re, keys, handler, auth, cors, agent, raw });
  }
  match(method, path) {
    let pathMatched = false;
    for (const r of this.routes) {
      const m = path.match(r.re);
      if (!m) continue;
      pathMatched = true;
      if (r.method !== method) continue;
      const params = {};
      r.keys.forEach((k, i) => (params[k] = decodeURIComponent(m[i + 1])));
      return { route: r, params };
    }
    return pathMatched ? { notAllowed: true } : null;
  }
}

// --- hashing -------------------------------------------------------------

export const sha256 = (s) => createHash('sha256').update(s).digest('hex');

export function safeEqual(a, b) {
  const x = createHash('sha256').update(String(a)).digest();
  const y = createHash('sha256').update(String(b)).digest();
  return timingSafeEqual(x, y);
}

/** Must match inviteAuthHash() in packages/core: first 32 bytes of SHA-512. */
export function inviteAuthHash(inviteAuth) {
  return createHash('sha512').update(Buffer.from(inviteAuth, 'base64url')).digest().subarray(0, 32).toString('base64url');
}

// --- validation ----------------------------------------------------------

const B64URL = /^[A-Za-z0-9_-]+$/;
const ID = /^[A-Za-z0-9_-]{8,64}$/;

const bad = (field, why = 'is invalid') => fail(400, 'invalid', `${field} ${why}`);

export function vId(v, field) {
  if (typeof v !== 'string' || !ID.test(v)) bad(field);
  return v;
}

export function vBytes(v, field, len) {
  if (typeof v !== 'string' || !B64URL.test(v)) bad(field);
  if (Buffer.from(v, 'base64url').length !== len) bad(field, `must be ${len} bytes`);
  return v;
}

export function vEpoch(v, field = 'epoch') {
  if (!Number.isInteger(v) || v < 1 || v > 1e9) bad(field);
  return v;
}

/** Sealed envelope: { epoch, nonce, ct }. */
export function vEnvelope(v, field, maxCt = 16 * 1024) {
  if (!v || typeof v !== 'object') bad(field);
  vEpoch(v.epoch, `${field}.epoch`);
  vBytes(v.nonce, `${field}.nonce`, 24);
  if (typeof v.ct !== 'string' || !B64URL.test(v.ct) || v.ct.length > maxCt) bad(`${field}.ct`);
  return { epoch: v.epoch, nonce: v.nonce, ct: v.ct };
}

/** Box/secretbox without epoch: { nonce, ct }. */
export function vBox(v, field, maxCt = 4096) {
  if (!v || typeof v !== 'object') bad(field);
  vBytes(v.nonce, `${field}.nonce`, 24);
  if (typeof v.ct !== 'string' || !B64URL.test(v.ct) || v.ct.length > maxCt) bad(`${field}.ct`);
  return { nonce: v.nonce, ct: v.ct };
}

// --- rate limiting -------------------------------------------------------

export class RateLimiter {
  constructor(limit, windowMs) {
    this.limit = limit;
    this.windowMs = windowMs;
    this.hits = new Map();
  }
  /** Returns 0 if allowed, otherwise seconds until the next allowed request. */
  take(key, now = Date.now()) {
    let h = this.hits.get(key);
    if (!h || now - h.start >= this.windowMs) {
      h = { start: now, n: 0 };
      this.hits.set(key, h);
    }
    if (h.n >= this.limit) return Math.ceil((h.start + this.windowMs - now) / 1000);
    h.n++;
    if (this.hits.size > 10000) this.sweep(now);
    return 0;
  }
  sweep(now = Date.now()) {
    for (const [k, h] of this.hits) if (now - h.start >= this.windowMs) this.hits.delete(k);
  }
}

/**
 * The address a request came from. Behind `hops` trusted proxies, each one
 * appends the address it saw to X-Forwarded-For, so the client is the entry
 * that many places from the end. Entries before it are whatever the client
 * sent, so they never count (they'd let anyone dodge rate limits).
 */
export function clientIp(req, hops) {
  if (hops > 0) {
    const xff = req.headers['x-forwarded-for'];
    const parts = (Array.isArray(xff) ? xff.join(',') : typeof xff === 'string' ? xff : '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    if (parts.length) return parts.at(Math.max(0, parts.length - hops));
    const fly = req.headers['fly-client-ip'];
    if (typeof fly === 'string' && fly) return fly;
  }
  return req.socket.remoteAddress || 'unknown';
}
