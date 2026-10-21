// HomeCircle API. The server never sees plaintext: it validates shapes,
// enforces membership and roles, stores ciphertext and relays it.
//
// A server hosts any number of circles. A device's token identifies one member
// of one circle, and every request only ever touches that circle's data.
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
const MAX_CIRCLES = 100;
// How long a circle keeps messages: 1 day, 1 week, 1 month, 1 quarter, 1 year.
export const RETENTION_CHOICES = [1, 7, 30, 90, 365];
const DEFAULT_RETENTION_DAYS = 90;

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
  const currentEpoch = (circleId, epoch) => {
    const current = store.circle(circleId).epoch;
    if (epoch !== current) fail(409, 'stale_epoch', 'The circle key changed; refresh and retry', { epoch: current });
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
      inv.epoch === store.circle(inv.circle_id)?.epoch &&
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
      // Only meaningful on single-circle servers; apps before 0.4 compare it.
      circleId: store.soleCircleId(),
      multiCircle: true,
      push: push.enabled,
      tileUrl: config.tileUrl,
      tileAttribution: config.tileAttribution,
      locationRequestCooldown: config.locationRequestCooldown,
      maxRetentionDays: config.maxRetentionDays,
    }),
    { auth: false, cors: true },
  );

  const vNewCircle = (body) => {
    const circleId = vId(body.circleId, 'circleId');
    if (vEpoch(body.epoch) !== 1) fail(400, 'invalid', 'epoch must be 1');
    const member = vMember(body.member);
    const circle = vEnvelope(body.circle, 'circle', 2048);
    if (member.profile.epoch !== 1 || circle.epoch !== 1) fail(400, 'invalid', 'envelopes must use epoch 1');
    if (store.circleExists(circleId) || store.memberExists(member.id)) fail(409, 'conflict', 'Circle or member id already exists');
    return { circleId, member, circle };
  };
  const insertCircle = ({ circleId, member, circle }) => {
    const { token, tokenHash } = newToken();
    const now = Date.now();
    store.tx(() => {
      store.insertCircle({ id: circleId, env: circle, by: member.id, now, retentionDays: Math.min(DEFAULT_RETENTION_DAYS, config.maxRetentionDays) });
      store.insertMember({ ...member, circleId, role: 'owner', serverAdmin: true, tokenHash, now });
    });
    return { memberId: member.id, token };
  };

  // First circle on a new server, authorized by the setup code.
  r.add(
    'POST',
    '/setup',
    ({ body, ctx }) => {
      limitPublic(ctx);
      if (store.isSetup) fail(409, 'already_setup', 'This server already has a circle. Ask an admin for an invite.');
      if (typeof body.setupToken !== 'string' || !safeEqual(body.setupToken, config.setupToken)) {
        fail(403, 'bad_setup_token', 'That setup code is not right. Find it in your server logs or hosting dashboard.');
      }
      const res = insertCircle(vNewCircle(body));
      log('setup complete: first circle created');
      return res;
    },
    { auth: false },
  );

  // More circles on the same server (e.g. one for your household, one for your
  // parents and siblings). Only server admins can create them; whoever creates
  // a circle owns it and can invite anyone. Circles never see each other.
  r.add('POST', '/circles', ({ me, body }) => {
    if (!me.serverAdmin) fail(403, 'forbidden', 'Only the person who set up this server can create circles on it');
    if (store.circleCount() >= MAX_CIRCLES) fail(409, 'too_many_circles', 'This server has reached its circle limit');
    const res = insertCircle(vNewCircle(body));
    log('new circle created');
    return res;
  });

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
      const circleId = inv.circle_id;
      const member = vMember(body.member);
      currentEpoch(circleId, member.profile.epoch);
      if (store.memberExists(member.id)) fail(409, 'conflict', 'Member id already exists');
      if (store.activeMembers(circleId).length >= MAX_MEMBERS) fail(409, 'circle_full', 'This circle is full');
      const { token, tokenHash } = newToken();
      store.tx(() => {
        if (!store.useInvite(inv.id, member.id, now)) fail(404, 'invalid_invite', 'This invite was just used');
        store.insertMember({ ...member, circleId, role: 'member', tokenHash, now });
      });
      hub.broadcast(circleId, { type: 'members_changed' });
      log('member joined');
      return { memberId: member.id, token };
    },
    { auth: false },
  );

  // --- circle & members --------------------------------------------------

  r.add('GET', '/state', ({ me }) => {
    const circle = store.circle(me.circleId);
    return {
      circleId: circle.id,
      epoch: circle.epoch,
      rotationNeeded: circle.rotationNeeded,
      retentionDays: Math.min(circle.retentionDays, config.maxRetentionDays),
      retentionChoices: RETENTION_CHOICES.filter((d) => d <= config.maxRetentionDays),
      circle: { env: circle.env, by: circle.by },
      me: me.id,
      serverAdmin: me.serverAdmin,
      members: store.members(me.circleId).map((m) => ({
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
    };
  });

  r.add('PUT', '/circle', ({ me, body }) => {
    requireAdmin(me);
    const env = vEnvelope(body, 'circle', 2048);
    currentEpoch(me.circleId, env.epoch);
    store.setCircleEnv(me.circleId, env, me.id);
    hub.broadcast(me.circleId, { type: 'circle' }, me.id);
    return { ok: true };
  });

  // Admins choose how long the circle's messages (group and direct) are kept.
  r.add('PUT', '/circle/retention', ({ me, body }) => {
    requireAdmin(me);
    const days = body.days;
    if (!RETENTION_CHOICES.includes(days) || days > config.maxRetentionDays) {
      fail(400, 'invalid', `days must be one of ${RETENTION_CHOICES.filter((d) => d <= config.maxRetentionDays).join(', ')}`);
    }
    store.setRetention(me.circleId, days);
    store.pruneMessages(Date.now(), config.maxRetentionDays);
    hub.broadcast(me.circleId, { type: 'circle' });
    log(`message retention set to ${days} days`);
    return { ok: true, retentionDays: days };
  });

  // The owner can delete their circle and everything in it.
  r.add('DELETE', '/circle', ({ me }) => {
    if (me.role !== 'owner') fail(403, 'forbidden', 'Only the circle owner can delete it');
    const circleId = me.circleId;
    hub.broadcast(circleId, { type: 'circle_deleted' }, me.id);
    const memberIds = store.tx(() => store.deleteCircle(circleId));
    for (const id of memberIds) hub.disconnect(id);
    log('circle deleted');
    return { ok: true };
  });

  r.add('PUT', '/members/me/profile', ({ me, body }) => {
    const profile = vEnvelope(body.profile, 'profile', 4096);
    currentEpoch(me.circleId, profile.epoch);
    store.setProfile(me.id, profile);
    hub.broadcast(me.circleId, { type: 'members_changed' }, me.id);
    return { ok: true };
  });

  r.add('PUT', '/members/me/push', ({ me, body }) => {
    const token = body.token == null ? null : body.token;
    if (token !== null && !isPushToken(token)) fail(400, 'invalid', 'Unsupported push token');
    const platform = ['ios', 'android', 'web'].includes(body.platform) ? body.platform : null;
    store.setPush(me, token, platform);
    return { ok: true };
  });

  r.add('DELETE', '/members/:id', ({ me, params }) => {
    const target = store.member(me.circleId, vId(params.id, 'id'));
    if (!target || target.removed) fail(404, 'not_found', 'No such member');
    if (target.id === me.id) {
      if (me.role === 'owner') fail(400, 'owner_cannot_leave', 'The owner cannot leave. Delete the circle instead.');
    } else {
      requireAdmin(me);
      if (target.role === 'owner') fail(403, 'forbidden', 'The owner cannot be removed');
      if (target.role === 'admin' && me.role !== 'owner') fail(403, 'forbidden', 'Only the owner can remove admins');
    }
    const now = Date.now();
    store.tx(() => {
      store.removeMember(target.id, now);
      store.setRotationNeeded(me.circleId);
      store.revokeAllInvites(me.circleId, now);
    });
    hub.send(target.id, { type: 'removed', memberId: target.id });
    hub.disconnect(target.id);
    hub.broadcast(me.circleId, { type: 'removed', memberId: target.id });
    log('member removed; key rotation pending');
    return { ok: true, rotationNeeded: true };
  });

  r.add('POST', '/members/:id/role', ({ me, params, body }) => {
    if (me.role !== 'owner') fail(403, 'forbidden', 'Only the owner can change roles');
    const target = store.member(me.circleId, vId(params.id, 'id'));
    if (!target || target.removed) fail(404, 'not_found', 'No such member');
    if (target.role === 'owner') fail(400, 'invalid', "The owner's role can't change");
    if (!['admin', 'member'].includes(body.role)) fail(400, 'invalid', 'role must be admin or member');
    store.setRole(target.id, body.role);
    hub.broadcast(me.circleId, { type: 'members_changed' });
    return { ok: true };
  });

  // --- invites -----------------------------------------------------------

  r.add('POST', '/invites', ({ me, body }) => {
    requireAdmin(me);
    const circle = store.circle(me.circleId);
    if (circle.rotationNeeded) fail(409, 'rotation_needed', 'Waiting for the circle key to be rotated after someone was removed');
    const id = vId(body.id, 'id');
    currentEpoch(me.circleId, vEpoch(body.epoch));
    const authHash = vBytes(body.authHash, 'authHash', 32);
    const wrapped = vBox(body.wrapped, 'wrapped', 2048);
    const now = Date.now();
    if (store.countOpenInvites(me.circleId, now) >= MAX_OPEN_INVITES) fail(409, 'too_many_invites', 'Too many open invites');
    if (store.inviteExists(id)) fail(409, 'conflict', 'Invite id already exists');
    const hours = Math.min(config.inviteMaxHours, Math.max(1, Number.isInteger(body.hours) ? body.hours : 48));
    const expiresAt = now + hours * 3600_000;
    store.insertInvite({ id, circleId: me.circleId, authHash, wrapped, epoch: circle.epoch, createdBy: me.id, now, expiresAt });
    return { id, expiresAt };
  });

  r.add('GET', '/invites', ({ me }) => {
    requireAdmin(me);
    return {
      invites: store.openInvites(me.circleId, Date.now()).map((i) => ({
        id: i.id,
        createdBy: i.created_by,
        createdAt: i.created_at,
        expiresAt: i.expires_at,
      })),
    };
  });

  r.add('DELETE', '/invites/:id', ({ me, params }) => {
    requireAdmin(me);
    if (!store.revokeInvite(me.circleId, vId(params.id, 'id'), Date.now())) fail(404, 'not_found', 'No such open invite');
    return { ok: true };
  });

  // --- keys --------------------------------------------------------------

  r.add('POST', '/keys/rotate', ({ me, body }) => {
    requireAdmin(me);
    const epoch = vEpoch(body.epoch);
    const current = store.circle(me.circleId).epoch;
    if (epoch !== current + 1) fail(409, 'stale_epoch', 'Someone else already rotated the key', { epoch: current });
    if (!body.envelopes || typeof body.envelopes !== 'object') fail(400, 'invalid', 'envelopes required');
    const active = store.activeMembers(me.circleId).map((m) => m.id).sort();
    const given = Object.keys(body.envelopes).sort();
    if (active.length !== given.length || active.some((id, i) => id !== given[i])) {
      fail(400, 'envelopes_mismatch', 'Need exactly one key envelope per active member');
    }
    const envs = given.map((id) => [id, vBox(body.envelopes[id], `envelopes.${id}`, 1024)]);
    const now = Date.now();
    store.tx(() => {
      for (const [memberId, env] of envs) store.insertEnvelope({ epoch, memberId, fromId: me.id, env, now });
      store.setCircleEpoch(me.circleId, epoch);
      store.revokeAllInvites(me.circleId, now);
    });
    hub.broadcast(me.circleId, { type: 'key_rotated', epoch }, me.id);
    log(`circle key rotated to epoch ${epoch}`);
    return { epoch };
  });

  r.add('GET', '/keys/envelopes', ({ me, query }) => {
    const since = Math.max(0, Number.parseInt(query.get('since') || '0', 10) || 0);
    return { envelopes: store.envelopesFor(me.id, since) };
  });

  // --- locations ---------------------------------------------------------

  r.add('GET', '/locations', ({ me }) => ({ locations: store.locations(me.circleId) }));

  r.add('PUT', '/locations/me', ({ me, body }) => {
    const env = vEnvelope(body, 'location', 4096);
    currentEpoch(me.circleId, env.epoch);
    const now = Date.now();
    store.putLocation(me.id, env, now);
    hub.broadcast(me.circleId, { type: 'location', memberId: me.id, env, updatedAt: now }, me.id);
    return { ok: true, updatedAt: now };
  });

  // Stop sharing with this circle: its members no longer see where you were.
  r.add('DELETE', '/locations/me', ({ me }) => {
    store.deleteLocation(me.id);
    hub.broadcast(me.circleId, { type: 'location_deleted', memberId: me.id }, me.id);
    return { ok: true };
  });

  // Locate one person, or "Refresh everyone" (no targets). Each has its own
  // cooldown, so asking for one person doesn't block asking for another or
  // refreshing everyone.
  r.add('POST', '/locations/request', ({ me, body }) => {
    const others = store.activeMembers(me.circleId).filter((m) => m.id !== me.id);
    const wanted = Array.isArray(body.targets) ? new Set(body.targets) : null;
    let targets;
    if (!wanted) {
      const wait = requestLimiter.take(`${me.id}>*`);
      if (wait) fail(429, 'rate_limited', `You can refresh everyone again in ${wait}s`, { retryAfter: wait });
      targets = others;
    } else {
      const asked = others.filter((m) => wanted.has(m.id));
      const waits = asked.map((m) => requestLimiter.take(`${me.id}>${m.id}`));
      targets = asked.filter((_, i) => !waits[i]);
      if (asked.length && !targets.length) {
        const wait = Math.min(...waits);
        fail(429, 'rate_limited', `You can ask again in ${wait}s`, { retryAfter: wait });
      }
    }
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

  r.add('GET', '/messages', ({ me, query }) => {
    const after = Math.max(0, Number.parseInt(query.get('after') || '0', 10) || 0);
    const limit = Math.min(500, Math.max(1, Number.parseInt(query.get('limit') || '200', 10) || 200));
    return { messages: store.messagesAfter(me.circleId, me.id, after, limit) };
  });

  r.add('POST', '/messages', ({ me, body }) => {
    const id = vId(body.id, 'id');
    const env = vEnvelope({ epoch: body.epoch, nonce: body.nonce, ct: body.ct }, 'message', 16 * 1024);
    currentEpoch(me.circleId, env.epoch);
    // A direct message goes to one other member of the same circle.
    let to = null;
    if (body.to != null) {
      to = store.member(me.circleId, vId(body.to, 'to'));
      if (!to || to.removed || to.id === me.id) fail(404, 'not_found', 'No such member in this circle');
    }
    if (store.messageExists(id)) fail(409, 'conflict', 'Duplicate message id');
    const now = Date.now();
    const seq = store.insertMessage({ id, circleId: me.circleId, fromId: me.id, toId: to?.id ?? null, env, now });
    const message = { seq, id, from: me.id, to: to?.id ?? null, env, createdAt: now };
    if (to) hub.send(to.id, { type: 'message', message });
    else hub.broadcast(me.circleId, { type: 'message', message }, me.id);
    // Clients mark reactions "silent": stored and relayed live, but no push.
    if (body.silent !== true) {
      const recipients = to ? [to] : store.activeMembers(me.circleId).filter((m) => m.id !== me.id);
      push.activity(recipients.filter((m) => m.pushToken && !hub.isOnline(m.id)));
    }
    return { seq, createdAt: now };
  });

  // --- places ------------------------------------------------------------

  r.add('GET', '/places', ({ me }) => ({ places: store.places(me.circleId) }));

  r.add('PUT', '/places/:id', ({ me, params, body }) => {
    const id = vId(params.id, 'id');
    const env = vEnvelope(body, 'place', 4096);
    currentEpoch(me.circleId, env.epoch);
    const owner = store.placeCircle(id);
    if (owner && owner !== me.circleId) fail(409, 'conflict', 'Place id already exists');
    if (!owner && store.countPlaces(me.circleId) >= MAX_PLACES) fail(409, 'too_many_places', 'Too many places');
    const now = Date.now();
    store.putPlace(me.circleId, id, env, me.id, now);
    hub.broadcast(me.circleId, { type: 'place', place: { id, env, updatedBy: me.id, updatedAt: now } }, me.id);
    return { ok: true };
  });

  r.add('DELETE', '/places/:id', ({ me, params }) => {
    const id = vId(params.id, 'id');
    if (!store.deletePlace(me.circleId, id)) fail(404, 'not_found', 'No such place');
    hub.broadcast(me.circleId, { type: 'place_deleted', id }, me.id);
    return { ok: true };
  });

  return r;
}
