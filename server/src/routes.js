// HomeCircle API. The server never sees plaintext: it validates shapes,
// enforces membership and roles, stores ciphertext and relays it.
import { randomBytes } from 'node:crypto';
import {
  Router,
  fail,
  sha256,
  safeEqual,
  inviteAuthHash,
  vId,
  vBytes,
  vEpoch,
  vEnvelope,
  vBox,
  RateLimiter,
} from './http.js';
import { isPushToken } from './push.js';

const MAX_MEMBERS = 50;
const MAX_OPEN_INVITES = 20;
const MAX_PLACES = 100;

const isAdmin = (m) => m.role === 'owner' || m.role === 'admin';
const requireAdmin = (m) => isAdmin(m) || fail(403, 'forbidden', 'Only circle admins can do that');

export function buildRoutes({ config, store, hub, push, log }) {
  const r = new Router();
  const publicLimiter = new RateLimiter(20, 60_000);
  const requestLimiter = new RateLimiter(1, config.locationRequestCooldown * 1000);

  const limitPublic = (ctx) => {
    const wait = publicLimiter.take(ctx.ip);
    if (wait) fail(429, 'rate_limited', 'Too many attempts, try again shortly', { retryAfter: wait });
  };
  const currentEpoch = (epoch) => {
    if (epoch !== store.epoch) fail(409, 'stale_epoch', 'The circle key changed; refresh and retry', { epoch: store.epoch });
  };
  const newToken = () => {
    const token = randomBytes(32).toString('base64url');
    return { token, tokenHash: sha256(token) };
  };
  const vMember = (m) => {
    if (!m || typeof m !== 'object') fail(400, 'invalid', 'member is required');
    return {
      id: vId(m.id, 'member.id'),
      boxPub: vBytes(m.boxPub, 'member.boxPub', 32),
      signPub: vBytes(m.signPub, 'member.signPub', 32),
      profile: vEnvelope(m.profile, 'member.profile', 4096),
    };
  };
  const checkInvite = (body, now) => {
    const inviteId = vId(body.inviteId, 'inviteId');
    if (typeof body.inviteAuth !== 'string') fail(400, 'invalid', 'inviteAuth is required');
    const inv = store.invite(inviteId);
    const ok =
      inv &&
      !inv.used_at &&
      !inv.revoked_at &&
      inv.expires_at > now &&
      inv.epoch === store.epoch &&
      safeEqual(inviteAuthHash(body.inviteAuth), inv.auth_hash);
    if (!ok) fail(404, 'invalid_invite', 'This invite is invalid, expired or already used. Ask for a new one.');
    return inv;
  };

  // --- public --------------------------------------------------------------

  r.add(
    'GET',
    '/info',
    () => ({
      app: 'homecircle',
      version: config.version,
      setup: store.isSetup,
      circleId: store.getMeta('circle_id'),
      push: push.enabled,
      tileUrl: config.tileUrl,
      tileAttribution: config.tileAttribution,
      locationRequestCooldown: config.locationRequestCooldown,
    }),
    { auth: false, cors: true },
  );

  r.add(
    'POST',
    '/setup',
    ({ body, ctx }) => {
      limitPublic(ctx);
      if (store.isSetup) fail(409, 'already_setup', 'This server already has a circle. Ask an admin for an invite.');
      if (typeof body.setupToken !== 'string' || !safeEqual(body.setupToken, config.setupToken)) {
        fail(403, 'bad_setup_token', 'That setup code is not right. Find it in your server logs or hosting dashboard.');
      }
      const circleId = vId(body.circleId, 'circleId');
      if (vEpoch(body.epoch) !== 1) fail(400, 'invalid', 'epoch must be 1');
      const member = vMember(body.member);
      const circle = vEnvelope(body.circle, 'circle', 2048);
      if (member.profile.epoch !== 1 || circle.epoch !== 1) fail(400, 'invalid', 'envelopes must use epoch 1');
      const { token, tokenHash } = newToken();
      const now = Date.now();
      store.tx(() => {
        store.setMeta('circle_id', circleId);
        store.setMeta('epoch', 1);
        store.setMeta('rotation_needed', 0);
        store.setMeta('circle_env', JSON.stringify(circle));
        store.setMeta('circle_by', member.id);
        store.setMeta('created_at', now);
        store.insertMember({ ...member, role: 'owner', tokenHash, now });
      });
      log('setup complete: circle created');
      return { memberId: member.id, token };
    },
    { auth: false },
  );

  r.add(
    'POST',
    '/join/preview',
    ({ body, ctx }) => {
      limitPublic(ctx);
      const inv = checkInvite(body, Date.now());
      return { wrapped: inv.wrapped, epoch: inv.epoch };
    },
    { auth: false },
  );

  r.add(
    'POST',
    '/join',
    ({ body, ctx }) => {
      limitPublic(ctx);
      const now = Date.now();
      const inv = checkInvite(body, now);
      const member = vMember(body.member);
      currentEpoch(member.profile.epoch);
      if (store.member(member.id)) fail(409, 'conflict', 'Member id already exists');
      if (store.activeMembers().length >= MAX_MEMBERS) fail(409, 'circle_full', 'This circle is full');
      const { token, tokenHash } = newToken();
      store.tx(() => {
        if (!store.useInvite(inv.id, member.id, now)) fail(404, 'invalid_invite', 'This invite was just used');
        store.insertMember({ ...member, role: 'member', tokenHash, now });
      });
      hub.broadcast({ type: 'members_changed' });
      log('member joined');
      return { memberId: member.id, token };
    },
    { auth: false },
  );

  // --- circle & members --------------------------------------------------

  r.add('GET', '/state', ({ me }) => ({
    circleId: store.getMeta('circle_id'),
    epoch: store.epoch,
    rotationNeeded: store.getMeta('rotation_needed') === '1',
    circle: { env: JSON.parse(store.getMeta('circle_env')), by: store.getMeta('circle_by') },
    me: me.id,
    members: store.members().map((m) => ({
      id: m.id,
      role: m.role,
      boxPub: m.boxPub,
      signPub: m.signPub,
      profile: m.profile,
      joinedAt: m.joinedAt,
      lastSeenAt: m.removed ? null : m.lastSeenAt,
      removed: m.removed,
      online: hub.isOnline(m.id),
    })),
  }));

  r.add('PUT', '/circle', ({ me, body }) => {
    requireAdmin(me);
    const env = vEnvelope(body, 'circle', 2048);
    currentEpoch(env.epoch);
    store.setMeta('circle_env', JSON.stringify(env));
    store.setMeta('circle_by', me.id);
    hub.broadcast({ type: 'circle' }, me.id);
    return { ok: true };
  });

  r.add('PUT', '/members/me/profile', ({ me, body }) => {
    const profile = vEnvelope(body.profile, 'profile', 4096);
    currentEpoch(profile.epoch);
    store.setProfile(me.id, profile);
    hub.broadcast({ type: 'members_changed' }, me.id);
    return { ok: true };
  });

  r.add('PUT', '/members/me/push', ({ me, body }) => {
    const token = body.token == null ? null : body.token;
    if (token !== null && !isPushToken(token)) fail(400, 'invalid', 'Unsupported push token');
    const platform = ['ios', 'android', 'web'].includes(body.platform) ? body.platform : null;
    store.setPush(me.id, token, platform);
    return { ok: true };
  });

  r.add('DELETE', '/members/:id', ({ me, params }) => {
    const target = store.member(vId(params.id, 'id'));
    if (!target || target.removed) fail(404, 'not_found', 'No such member');
    if (target.id === me.id) {
      if (me.role === 'owner') fail(400, 'owner_cannot_leave', 'The owner cannot leave. Delete the server instead.');
    } else {
      requireAdmin(me);
      if (target.role === 'owner') fail(403, 'forbidden', 'The owner cannot be removed');
      if (target.role === 'admin' && me.role !== 'owner') fail(403, 'forbidden', 'Only the owner can remove admins');
    }
    const now = Date.now();
    store.tx(() => {
      store.removeMember(target.id, now);
      store.setMeta('rotation_needed', 1);
      store.revokeAllInvites(now);
    });
    hub.send(target.id, { type: 'removed', memberId: target.id });
    hub.disconnect(target.id);
    hub.broadcast({ type: 'removed', memberId: target.id });
    log('member removed; key rotation pending');
    return { ok: true, rotationNeeded: true };
  });

  r.add('POST', '/members/:id/role', ({ me, params, body }) => {
    if (me.role !== 'owner') fail(403, 'forbidden', 'Only the owner can change roles');
    const target = store.member(vId(params.id, 'id'));
    if (!target || target.removed) fail(404, 'not_found', 'No such member');
    if (target.role === 'owner') fail(400, 'invalid', "The owner's role can't change");
    if (!['admin', 'member'].includes(body.role)) fail(400, 'invalid', 'role must be admin or member');
    store.setRole(target.id, body.role);
    hub.broadcast({ type: 'members_changed' });
    return { ok: true };
  });

  // --- invites -----------------------------------------------------------

  r.add('POST', '/invites', ({ me, body }) => {
    requireAdmin(me);
    if (store.getMeta('rotation_needed') === '1') {
      fail(409, 'rotation_needed', 'Waiting for the circle key to be rotated after someone was removed');
    }
    const id = vId(body.id, 'id');
    currentEpoch(vEpoch(body.epoch));
    const authHash = vBytes(body.authHash, 'authHash', 32);
    const wrapped = vBox(body.wrapped, 'wrapped', 2048);
    const now = Date.now();
    if (store.countOpenInvites(now) >= MAX_OPEN_INVITES) fail(409, 'too_many_invites', 'Too many open invites');
    if (store.invite(id)) fail(409, 'conflict', 'Invite id already exists');
    const hours = Math.min(config.inviteMaxHours, Math.max(1, Number.isInteger(body.hours) ? body.hours : 48));
    const expiresAt = now + hours * 3600_000;
    store.insertInvite({ id, authHash, wrapped, epoch: store.epoch, createdBy: me.id, now, expiresAt });
    return { id, expiresAt };
  });

  r.add('GET', '/invites', ({ me }) => {
    requireAdmin(me);
    return {
      invites: store.openInvites(Date.now()).map((i) => ({
        id: i.id,
        createdBy: i.created_by,
        createdAt: i.created_at,
        expiresAt: i.expires_at,
      })),
    };
  });

  r.add('DELETE', '/invites/:id', ({ me, params }) => {
    requireAdmin(me);
    if (!store.revokeInvite(vId(params.id, 'id'), Date.now())) fail(404, 'not_found', 'No such open invite');
    return { ok: true };
  });

  // --- keys --------------------------------------------------------------

  r.add('POST', '/keys/rotate', ({ me, body }) => {
    requireAdmin(me);
    const epoch = vEpoch(body.epoch);
    if (epoch !== store.epoch + 1) fail(409, 'stale_epoch', 'Someone else already rotated the key', { epoch: store.epoch });
    if (!body.envelopes || typeof body.envelopes !== 'object') fail(400, 'invalid', 'envelopes required');
    const active = store.activeMembers().map((m) => m.id).sort();
    const given = Object.keys(body.envelopes).sort();
    if (active.length !== given.length || active.some((id, i) => id !== given[i])) {
      fail(400, 'envelopes_mismatch', 'Need exactly one key envelope per active member');
    }
    const envs = given.map((id) => [id, vBox(body.envelopes[id], `envelopes.${id}`, 1024)]);
    const now = Date.now();
    store.tx(() => {
      for (const [memberId, env] of envs) store.insertEnvelope({ epoch, memberId, fromId: me.id, env, now });
      store.setMeta('epoch', epoch);
      store.setMeta('rotation_needed', 0);
      store.revokeAllInvites(now);
    });
    hub.broadcast({ type: 'key_rotated', epoch }, me.id);
    log(`circle key rotated to epoch ${epoch}`);
    return { epoch };
  });

  r.add('GET', '/keys/envelopes', ({ me, query }) => {
    const since = Math.max(0, Number.parseInt(query.get('since') || '0', 10) || 0);
    return { envelopes: store.envelopesFor(me.id, since) };
  });

  // --- locations ---------------------------------------------------------

  r.add('GET', '/locations', () => ({ locations: store.locations() }));

  r.add('PUT', '/locations/me', ({ me, body }) => {
    const env = vEnvelope(body, 'location', 4096);
    currentEpoch(env.epoch);
    const now = Date.now();
    store.putLocation(me.id, env, now);
    hub.broadcast({ type: 'location', memberId: me.id, env, updatedAt: now }, me.id);
    return { ok: true, updatedAt: now };
  });

  r.add('POST', '/locations/request', ({ me, body }) => {
    const wait = requestLimiter.take(me.id);
    if (wait) fail(429, 'rate_limited', `You can ask again in ${wait}s`, { retryAfter: wait });
    const others = store.activeMembers().filter((m) => m.id !== me.id);
    const wanted = Array.isArray(body.targets) ? new Set(body.targets) : null;
    const targets = wanted ? others.filter((m) => wanted.has(m.id)) : others;
    const offline = [];
    let online = 0;
    for (const m of targets) {
      if (hub.isOnline(m.id)) {
        hub.send(m.id, { type: 'location_request', from: me.id });
        online++;
      } else if (m.pushToken) {
        offline.push(m);
      }
    }
    push.locationRequest(offline);
    return { requested: targets.length, online, pushed: offline.length, cooldown: config.locationRequestCooldown };
  });

  // --- messages ----------------------------------------------------------

  r.add('GET', '/messages', ({ query }) => {
    const after = Math.max(0, Number.parseInt(query.get('after') || '0', 10) || 0);
    const limit = Math.min(500, Math.max(1, Number.parseInt(query.get('limit') || '200', 10) || 200));
    return { messages: store.messagesAfter(after, limit) };
  });

  r.add('POST', '/messages', ({ me, body }) => {
    const id = vId(body.id, 'id');
    const env = vEnvelope({ epoch: body.epoch, nonce: body.nonce, ct: body.ct }, 'message', 16 * 1024);
    currentEpoch(env.epoch);
    if (store.messageExists(id)) fail(409, 'conflict', 'Duplicate message id');
    const now = Date.now();
    const seq = store.insertMessage({ id, fromId: me.id, env, now });
    const message = { seq, id, from: me.id, env, createdAt: now };
    hub.broadcast({ type: 'message', message }, me.id);
    // Clients mark reactions "silent": stored and relayed live, but no push.
    if (body.silent !== true) {
      push.activity(store.activeMembers().filter((m) => m.id !== me.id && m.pushToken && !hub.isOnline(m.id)));
    }
    return { seq, createdAt: now };
  });

  // --- places ------------------------------------------------------------

  r.add('GET', '/places', () => ({ places: store.places() }));

  r.add('PUT', '/places/:id', ({ me, params, body }) => {
    const id = vId(params.id, 'id');
    const env = vEnvelope(body, 'place', 4096);
    currentEpoch(env.epoch);
    if (!store.place(id) && store.countPlaces() >= MAX_PLACES) fail(409, 'too_many_places', 'Too many places');
    const now = Date.now();
    store.putPlace(id, env, me.id, now);
    hub.broadcast({ type: 'place', place: { id, env, updatedBy: me.id, updatedAt: now } }, me.id);
    return { ok: true };
  });

  r.add('DELETE', '/places/:id', ({ me, params }) => {
    const id = vId(params.id, 'id');
    if (!store.deletePlace(id)) fail(404, 'not_found', 'No such place');
    hub.broadcast({ type: 'place_deleted', id }, me.id);
    return { ok: true };
  });

  return r;
}
