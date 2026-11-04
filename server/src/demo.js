// Demo mode (DEMO_MODE=1): a server that holds only throwaway copies of a
// made-up family, never a real circle. The demo director (demo/director.mjs)
// builds each copy as an ordinary circle and registers it here with an invite;
// a visitor is handed one ready copy, which is theirs alone for an hour. Copies
// end at the hour, when the visitor leaves, or when they go quiet.
//
// What the server learns is what it always learns, plus one thing: the invite
// link of a copy waiting for a visitor passes through it, so it could read that
// copy. Nobody real is in a copy until the visitor joins, and only they choose
// to say anything in it. This is why no real circle may ever live on this server.
import { HttpError, fail, safeEqual, vId, RateLimiter } from './http.js';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS demo_copies (
  circle_id TEXT PRIMARY KEY,
  link TEXT,
  created_at INTEGER NOT NULL,
  claimed_at INTEGER,
  expires_at INTEGER,
  visitor_id TEXT,
  active_at INTEGER
);
`;

const DAY_MS = 86400_000;

/** Whether this request comes from the demo director (it holds DEMO_TOKEN). */
export function fromDirector(config, req) {
  const token = req.headers['x-demo-token'];
  return !!config.demoMode && typeof token === 'string' && safeEqual(token, config.demoToken);
}

export class Demo {
  constructor({ config, store, hub, files = null, agentHost = null, log = () => {} }) {
    this.config = config;
    this.store = store;
    this.hub = hub;
    this.files = files;
    this.agentHost = agentHost;
    this.log = log;
    store.db.exec(SCHEMA);
    this.ipStarts = new RateLimiter(config.demoStartsPerIp, DAY_MS);
    this.deviceStarts = new RateLimiter(config.demoStartsPerDevice, DAY_MS);
    this.timer = setInterval(() => this.sweep(), config.demoSweepMs);
    this.timer.unref?.();
  }

  close() {
    clearInterval(this.timer);
  }

  copies() {
    return this.store.q('SELECT * FROM demo_copies ORDER BY created_at').all();
  }

  copy(circleId) {
    return this.store.q('SELECT * FROM demo_copies WHERE circle_id = ?').get(circleId) ?? null;
  }

  counts() {
    const all = this.copies();
    const running = all.filter((c) => c.claimed_at).length;
    return { ready: all.length - running, running, maxRunning: this.config.demoMaxRunning };
  }

  /** The director finished building a copy: it's ready for a visitor. */
  register(circleId, link) {
    if (!this.store.circleExists(circleId)) fail(404, 'not_found', 'No such circle');
    if (this.copy(circleId)) fail(409, 'conflict', 'That copy is already registered');
    this.store.q('INSERT INTO demo_copies (circle_id, link, created_at) VALUES (?, ?, ?)').run(circleId, link, Date.now());
  }

  /** Hand a visitor the oldest ready copy. Only a start that gets one counts against the limits. */
  claim({ ip, device = null, now = Date.now() }) {
    const { ready, running, maxRunning } = this.counts();
    if (running >= maxRunning || !ready) {
      throw new HttpError(503, 'demo_busy', 'Every demo family is in use right now. Try again in a few minutes.', { retryAfter: 120 });
    }
    const limit = (limiter, key) => {
      const wait = limiter.take(key, now);
      if (wait) throw new HttpError(429, 'demo_limit', 'That’s all the demos for today. Come back tomorrow.', { retryAfter: wait });
    };
    limit(this.ipStarts, ip);
    if (device) limit(this.deviceStarts, device);
    const copy = this.store.tx(() => {
      const c = this.store.q('SELECT * FROM demo_copies WHERE claimed_at IS NULL ORDER BY created_at LIMIT 1').get();
      const expiresAt = now + this.config.demoMinutes * 60_000;
      // The link isn't kept once it's handed out.
      this.store.q('UPDATE demo_copies SET link = NULL, claimed_at = ?, expires_at = ?, active_at = ? WHERE circle_id = ?').run(now, expiresAt, now, c.circle_id);
      return { link: c.link, expiresAt };
    });
    this.log('demo: a visitor started a copy');
    return copy;
  }

  /** Someone joined a copy without the director's token: that's its visitor. */
  joined(circleId, memberId, now = Date.now()) {
    this.store.q('UPDATE demo_copies SET visitor_id = ?, active_at = ? WHERE circle_id = ? AND visitor_id IS NULL').run(memberId, now, circleId);
  }

  visitorOf(circleId) {
    return this.copy(circleId)?.visitor_id ?? null;
  }

  /** What the app shows: how long this copy has left. Null for a copy with no visitor yet. */
  stateFor(circleId, now = Date.now()) {
    const c = this.copy(circleId);
    return c?.expires_at ? { secondsLeft: Math.max(0, Math.round((c.expires_at - now) / 1000)) } : null;
  }

  /** Turn a copy off, for everyone in it, with everything in it. `leaver` left by choice and isn't told it ended. */
  end(circleId, why, leaver = null) {
    this.hub.broadcast(circleId, { type: 'circle_deleted' }, leaver);
    const memberIds = this.store.circleExists(circleId) ? this.store.tx(() => this.store.deleteCircle(circleId)) : [];
    this.store.q('DELETE FROM demo_copies WHERE circle_id = ?').run(circleId);
    this.files?.removeCircle(circleId);
    for (const id of memberIds) this.hub.disconnect(id);
    this.agentHost?._forget(circleId).catch(() => {});
    this.log(`demo: a copy ended (${why})`);
  }

  /** The hour is up, the visitor went quiet, or a link handed out was never used. */
  sweep(now = Date.now()) {
    const { demoIdleMinutes, demoUnusedMinutes } = this.config;
    for (const c of this.copies()) {
      if (!c.claimed_at) continue;
      if (now >= c.expires_at) {
        this.end(c.circle_id, 'expired');
      } else if (!c.visitor_id) {
        if (now - c.claimed_at >= demoUnusedMinutes * 60_000) this.end(c.circle_id, 'never joined');
      } else if (this.hub.isOnline(c.visitor_id)) {
        this.store.q('UPDATE demo_copies SET active_at = ? WHERE circle_id = ?').run(now, c.circle_id);
      } else {
        const seen = this.store.member(c.circle_id, c.visitor_id)?.lastSeenAt ?? 0;
        if (now - Math.max(c.active_at, seen) >= demoIdleMinutes * 60_000) this.end(c.circle_id, 'went quiet');
      }
    }
  }
}

export function mountDemo(r, demo, config, limitPublic) {
  const requireDirector = (ctx) => ctx.director || fail(403, 'forbidden', 'Only the demo director can do that');

  // Anyone: one ready copy, and the link to join it.
  r.add(
    'POST',
    '/demo/start',
    ({ body, ctx }) => {
      limitPublic(ctx);
      const device = typeof body.device === 'string' && body.device ? body.device.slice(0, 64) : null;
      const { link, expiresAt } = demo.claim({ ip: ctx.ip, device });
      // The director builds copies over loopback; visitors reach this address.
      const proto = ctx.req.headers['x-forwarded-proto'] === 'https' ? 'https' : 'http';
      const origin = config.publicUrl || `${proto}://${ctx.req.headers.host}`;
      return { link: link.replace(/^https?:\/\/[^/#]+/, origin), expiresAt, minutes: config.demoMinutes };
    },
    { auth: false, cors: true },
  );

  // The director's view of every copy, so it can notice claims, ends and leftovers.
  r.add(
    'GET',
    '/demo/copies',
    ({ ctx }) => {
      requireDirector(ctx);
      return {
        ...demo.counts(),
        copies: demo.copies().map((c) => ({ circleId: c.circle_id, claimedAt: c.claimed_at, expiresAt: c.expires_at, visitorId: c.visitor_id })),
      };
    },
    { auth: false },
  );

  r.add(
    'POST',
    '/demo/copies',
    ({ body, ctx }) => {
      requireDirector(ctx);
      const circleId = vId(body.circleId, 'circleId');
      if (typeof body.link !== 'string' || body.link.length > 1024) fail(400, 'invalid', 'link is required');
      demo.register(circleId, body.link);
      return { ok: true };
    },
    { auth: false },
  );

  r.add(
    'DELETE',
    '/demo/copies/:id',
    ({ params, ctx }) => {
      requireDirector(ctx);
      demo.end(vId(params.id, 'id'), 'director');
      return { ok: true };
    },
    { auth: false },
  );
}
