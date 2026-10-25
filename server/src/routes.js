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
import { MAX_FILE_BYTES } from './files.js';
import { allFeatures, cleanFeatures, hasFeature, resolveFeatures } from '../../packages/core/src/features.js';

const MAX_MEMBERS = 50;
const MAX_OPEN_INVITES = 20;
const MAX_PLACES = 100;
const MAX_CIRCLES = 100;
const MAX_OPEN_REJOINS = 3;
const REJOIN_HOURS = 48;
// Chirps: three in a row to the same person (or the whole circle), then a
// break of 30 minutes. A new run starts after 30 minutes without a chirp.
const CHIRP_BURST = 3;
const CHIRP_COOLDOWN_MS = 30 * 60_000;
// How long a circle keeps messages: 1 day, 1 week, 1 month, 1 quarter, 1 year.
export const RETENTION_CHOICES = [1, 7, 30, 90, 365];
const DEFAULT_RETENTION_DAYS = 90;

// What apps before 0.11 get for an agent's profile: shaped like one, opened by no key.
const NO_PROFILE = { epoch: 0, nonce: 'A'.repeat(32), ct: 'AA' };

const isAdmin = (m) => m.role === 'owner' || m.role === 'admin';

const requireAdmin = (m) => isAdmin(m) || fail(403, 'forbidden', 'Only circle admins can do that');

export function buildRoutes({ config, store, hub, push, log, agentHost = null, files = null }) {
  const r = new Router();
  const publicLimiter = new RateLimiter(20, 60_000);
  const requestLimiter = new RateLimiter(1, config.locationRequestCooldown * 1000);
  // A few Locates per person per hour at most, so nobody's battery is drained.
  const hourlyLocateLimiter = new RateLimiter(6, 3600_000);

  // Guessing the setup code: a few dozen tries per hour from one address.
  const setupCodeLimiter = new RateLimiter(30, 3600_000);

  // A feature the circle's admins turned off: refused here too, not only hidden in the apps.
  const requireFeature = (me, id, what) => {
    if (!hasFeature(resolveFeatures(store.circle(me.circleId)?.features), id)) {
      fail(403, 'feature_off', `${what} ${/s$/.test(what) ? 'are' : 'is'} turned off in this circle. An admin can turn ${/s$/.test(what) ? 'them' : 'it'} on in Settings.`);
    }
  };

  const limitPublic = (ctx) => {
    const wait = publicLimiter.take(ctx.ip);
    if (wait) fail(429, 'rate_limited', 'Too many attempts, try again shortly', { retryAfter: wait });
  };
  const checkSetupCode = (body, ctx) => {
    limitPublic(ctx);
    const wait = setupCodeLimiter.take(ctx.ip);
    if (wait) fail(429, 'rate_limited', 'Too many attempts, try again later', { retryAfter: wait });
    if (typeof body.setupToken !== 'string' || !safeEqual(body.setupToken.trim(), config.setupToken)) {
      fail(
        403,
        'bad_setup_token',
        'That setup code isn’t right. Use setup_code from the Home Assistant app’s Configuration, SETUP_TOKEN from your host’s settings (Render: Environment), or the code printed in the server log. A [load-test] code only works on the load-test server.',
      );
    }
  };
  const vName = (v) => {
    const name = typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 40) : '';
    if (!name) fail(400, 'invalid', 'name is required');
    return name;
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
  const vAgentMember = (m) => {
    if (!m || typeof m !== 'object') fail(400, 'invalid', 'member is required');
    return { id: vId(m.id, 'member.id'), boxPub: vBytes(m.boxPub, 'member.boxPub', 32), signPub: vBytes(m.signPub, 'member.signPub', 32), profile: null };
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
      // Setup-code recovery: /recover/* and rejoin requests (0.8+).
      recovery: true,
      // A throwaway server for load tests: never put real people on it.
      loadTest: !!config.loadTest,
      // Chirps and most-visited places (0.9+).
      chirps: true,
      frequentPlaces: true,
      // The optional AI helper runs here (0.11+).
      agent: !!agentHost,
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
    // The features the owner chose; an app from before features could be
    // chosen gets everything, as it had before (it can't show the choice).
    const features = body.features && typeof body.features === 'object' ? resolveFeatures(body.features) : allFeatures();
    return { circleId, member, circle, features };
  };
  const insertCircle = ({ circleId, member, circle, features }) => {
    const { token, tokenHash } = newToken();
    const now = Date.now();
    store.tx(() => {
      store.insertCircle({ id: circleId, env: circle, by: member.id, now, retentionDays: Math.min(DEFAULT_RETENTION_DAYS, config.maxRetentionDays), features });
      store.insertMember({ ...member, circleId, role: 'owner', serverAdmin: true, tokenHash, now });
    });
    return { memberId: member.id, token };
  };

  // A circle authorized by the setup code: the server's first, or another one
  // by whoever set the server up (for example after losing their phone).
  r.add(
    'POST',
    '/setup',
    ({ body, ctx }) => {
      checkSetupCode(body, ctx);
      const first = !store.isSetup;
      if (store.circleCount() >= MAX_CIRCLES) fail(409, 'too_many_circles', 'This server has reached its circle limit');
      const res = insertCircle(vNewCircle(body));
      log(first ? 'setup complete: first circle created' : 'new circle created with the setup code');
      return res;
    },
    { auth: false },
  );

  // --- recovery with the setup code -----------------------------------------
  // Whoever has the setup code can see which circles exist (dates and member
  // counts only: names are encrypted), delete one, or ask to rejoin one.
  // Rejoining needs a member of that circle to approve on their phone: only
  // members hold the circle key, so the setup code alone never reveals
  // anything inside a circle.

  r.add(
    'POST',
    '/recover',
    ({ body, ctx }) => {
      checkSetupCode(body, ctx);
      const now = Date.now();
      return { circles: store.circleSummaries().map((c) => ({ ...c, waiting: store.countOpenRejoins(c.id, now) })) };
    },
    { auth: false },
  );

  r.add(
    'POST',
    '/recover/delete',
    ({ body, ctx }) => {
      checkSetupCode(body, ctx);
      const circleId = vId(body.circleId, 'circleId');
      if (!store.circleExists(circleId)) fail(404, 'not_found', 'No such circle');
      hub.broadcast(circleId, { type: 'circle_deleted' });
      const memberIds = store.tx(() => store.deleteCircle(circleId));
      for (const id of memberIds) hub.disconnect(id);
      log('circle deleted with the setup code');
      return { ok: true };
    },
    { auth: false },
  );

  r.add(
    'POST',
    '/recover/rejoin',
    ({ body, ctx }) => {
      checkSetupCode(body, ctx);
      const circleId = vId(body.circleId, 'circleId');
      if (!store.circleExists(circleId)) fail(404, 'not_found', 'No such circle');
      const id = vId(body.requestId, 'requestId');
      const name = vName(body.name);
      const boxPub = vBytes(body.boxPub, 'boxPub', 32);
      const signPub = vBytes(body.signPub, 'signPub', 32);
      const authHash = vBytes(body.authHash, 'authHash', 32);
      const now = Date.now();
      const active = store.activeMembers(circleId);
      if (!active.length) fail(409, 'no_members', 'Nobody is left in this circle to approve you. Delete it and start a new circle instead.');
      if (store.countOpenRejoins(circleId, now) >= MAX_OPEN_REJOINS) {
        fail(409, 'too_many_requests', 'This circle already has requests waiting. Ask a member to approve or deny them first.');
      }
      if (store.rejoin(id)) fail(409, 'conflict', 'Request id already exists');
      const expiresAt = now + REJOIN_HOURS * 3600_000;
      store.insertRejoin({ id, circleId, name, boxPub, signPub, authHash, now, expiresAt });
      hub.broadcast(circleId, { type: 'rejoin_requests' });
      push.rejoinRequest(active.filter((m) => m.pushToken && !hub.isOnline(m.id)));
      log('rejoin requested with the setup code');
      return { id, expiresAt };
    },
    { auth: false },
  );

  // The requester checks back with the secret only they have (not the setup code).
  const rejoinRequest = (body) => {
    const req = store.rejoin(vId(body.requestId, 'requestId'));
    if (!req || typeof body.auth !== 'string' || !safeEqual(inviteAuthHash(body.auth), req.auth_hash)) {
      fail(404, 'not_found', 'No such request');
    }
    return req;
  };

  r.add(
    'POST',
    '/recover/rejoin/status',
    ({ body, ctx }) => {
      limitPublic(ctx);
      const req = rejoinRequest(body);
      if (req.used_at) return { status: 'done' };
      if (req.denied_at) return { status: 'denied' };
      if (req.expires_at <= Date.now()) return { status: 'expired' };
      if (!req.approved_at) return { status: 'pending', expiresAt: req.expires_at };
      const by = store.member(req.circle_id, req.approved_by);
      if (!by) return { status: 'pending', expiresAt: req.expires_at };
      return { status: 'approved', epoch: req.epoch, wrapped: req.wrapped, from: { id: by.id, boxPub: by.boxPub } };
    },
    { auth: false },
  );

  r.add(
    'POST',
    '/recover/rejoin/complete',
    ({ body, ctx }) => {
      limitPublic(ctx);
      const req = rejoinRequest(body);
      const now = Date.now();
      if (req.used_at || req.denied_at || !req.approved_at || req.expires_at <= now) {
        fail(409, 'not_approved', 'This request isn’t approved, or it has expired.');
      }
      const member = vMember(body.member);
      if (member.boxPub !== req.box_pub || member.signPub !== req.sign_pub) fail(400, 'invalid', 'Keys don’t match the request');
      const circleId = req.circle_id;
      const circle = store.circle(circleId);
      if (req.epoch !== circle.epoch || member.profile.epoch !== circle.epoch) {
        // The key changed after they approved: ask again with the new one.
        store.reopenRejoin(req.id);
        hub.broadcast(circleId, { type: 'rejoin_requests' });
        fail(409, 'stale_epoch', 'The circle key changed. Ask them to approve you again.', { epoch: circle.epoch });
      }
      if (store.memberExists(member.id)) fail(409, 'conflict', 'Member id already exists');
      if (store.activeMembers(circleId).length >= MAX_MEMBERS) fail(409, 'circle_full', 'This circle is full');
      const { token, tokenHash } = newToken();
      store.tx(() => {
        if (!store.useRejoin(req.id, member.id, now)) fail(409, 'not_approved', 'This request was just used');
        // The setup code holder becomes the owner; the previous owner stays as an admin.
        for (const m of store.activeMembers(circleId)) if (m.role === 'owner') store.setRole(m.id, 'admin');
        store.insertMember({ ...member, circleId, role: 'owner', serverAdmin: true, tokenHash, now });
      });
      hub.broadcast(circleId, { type: 'members_changed' });
      hub.broadcast(circleId, { type: 'rejoin_requests' });
      log('owner rejoined with the setup code');
      return { memberId: member.id, token };
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
      return { wrapped: inv.wrapped, epoch: inv.epoch, kind: inv.kind || 'person' };
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
      const agent = inv.kind === 'agent';
      // An agent has no profile: it can't seal one without the circle key.
      // Its name and keys go in the circle's own (sealed) record instead.
      const member = agent ? vAgentMember(body.member) : vMember(body.member);
      if (!agent) currentEpoch(circleId, member.profile.epoch);
      if (agent && store.activeMembers(circleId).some((m) => m.kind === 'agent')) fail(409, 'agent_exists', 'This circle already has an agent');
      if (store.memberExists(member.id)) fail(409, 'conflict', 'Member id already exists');
      if (store.activeMembers(circleId).length >= MAX_MEMBERS) fail(409, 'circle_full', 'This circle is full');
      const { token, tokenHash } = newToken();
      store.tx(() => {
        if (!store.useInvite(inv.id, member.id, now)) fail(404, 'invalid_invite', 'This invite was just used');
        store.insertMember({ ...member, circleId, role: 'member', kind: agent ? 'agent' : 'person', tokenHash, now });
      });
      hub.broadcast(circleId, { type: 'members_changed' });
      log(agent ? 'agent joined' : 'member joined');
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
      features: resolveFeatures(circle.features),
      circle: { env: circle.env, by: circle.by },
      me: me.id,
      serverAdmin: me.serverAdmin,
      members: store.members(me.circleId).map((m) => ({
        id: m.id,
        role: m.role,
        kind: m.kind,
        deliveredSeq: m.deliveredSeq,
        boxPub: m.boxPub,
        signPub: m.signPub,
        profile: m.profile ?? NO_PROFILE,
        joinedAt: m.joinedAt,
        lastSeenAt: m.removed ? null : m.lastSeenAt,
        removed: m.removed,
        online: hub.isOnline(m.id),
      })),
    };
  }, { agent: true });

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

  // Which features the circle has: admins choose. Phones hide what's off;
  // the server also refuses what goes through it (chirps, Locate, …).
  r.add('PUT', '/circle/features', ({ me, body }) => {
    requireAdmin(me);
    const features = resolveFeatures({ ...resolveFeatures(store.circle(me.circleId).features), ...cleanFeatures(body.features) });
    store.setFeatures(me.circleId, features);
    hub.broadcast(me.circleId, { type: 'circle' });
    log('circle features changed');
    return { ok: true, features };
  });

  // The owner can delete their circle and everything in it.
  r.add('DELETE', '/circle', ({ me }) => {
    if (me.role !== 'owner') fail(403, 'forbidden', 'Only the circle owner can delete it');
    const circleId = me.circleId;
    hub.broadcast(circleId, { type: 'circle_deleted' }, me.id);
    const memberIds = store.tx(() => store.deleteCircle(circleId));
    files?.removeCircle(circleId);
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
    // An agent never had the circle key, so removing it needs no new key.
    const agent = target.kind === 'agent';
    store.tx(() => {
      store.removeMember(target.id, now);
      if (!agent) {
        store.setRotationNeeded(me.circleId);
        store.revokeAllInvites(me.circleId, now);
      }
    });
    // Files were only ever for the agent (and only it had their keys).
    if (agent) files?.removeCircle(me.circleId);
    hub.send(target.id, { type: 'removed', memberId: target.id });
    hub.disconnect(target.id);
    hub.broadcast(me.circleId, { type: 'removed', memberId: target.id });
    log(agent ? 'agent removed' : 'member removed; key rotation pending');
    return { ok: true, rotationNeeded: !agent };
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
    // An agent's invite carries no circle key: the agent never reads the chat.
    const agent = body.agent === true;
    if (agent) requireFeature(me, 'agent', 'The circle helper');
    if (agent && store.activeMembers(me.circleId).some((m) => m.kind === 'agent')) fail(409, 'agent_exists', 'This circle already has an agent');
    const wrapped = agent ? null : vBox(body.wrapped, 'wrapped', 2048);
    const now = Date.now();
    if (store.countOpenInvites(me.circleId, now) >= MAX_OPEN_INVITES) fail(409, 'too_many_invites', 'Too many open invites');
    if (store.inviteExists(id)) fail(409, 'conflict', 'Invite id already exists');
    const hours = Math.min(config.inviteMaxHours, Math.max(1, Number.isInteger(body.hours) ? body.hours : 48));
    const expiresAt = now + hours * 3600_000;
    store.insertInvite({ id, circleId: me.circleId, authHash, wrapped, epoch: circle.epoch, createdBy: me.id, now, expiresAt, kind: agent ? 'agent' : 'person' });
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

  // --- rejoin requests -----------------------------------------------------
  // Made with the setup code (see /recover/rejoin). Any member can approve:
  // their phone encrypts the circle key and name to the requester's key.

  r.add('GET', '/rejoin-requests', ({ me }) => ({
    requests: store.openRejoins(me.circleId, Date.now()).map((q) => ({
      id: q.id,
      name: q.name,
      boxPub: q.box_pub,
      signPub: q.sign_pub,
      createdAt: q.created_at,
      expiresAt: q.expires_at,
    })),
  }));

  const waitingRejoin = (me, id) => {
    const req = store.rejoin(vId(id, 'id'));
    if (!req || req.circle_id !== me.circleId || req.approved_at || req.denied_at || req.used_at || req.expires_at <= Date.now()) {
      fail(404, 'not_found', 'This request is no longer waiting');
    }
    return req;
  };

  r.add('POST', '/rejoin-requests/:id/approve', ({ me, params, body }) => {
    const req = waitingRejoin(me, params.id);
    const epoch = vEpoch(body.epoch);
    currentEpoch(me.circleId, epoch);
    const wrapped = vBox(body.wrapped, 'wrapped', 4096);
    if (!store.approveRejoin(req.id, me.id, wrapped, epoch, Date.now())) fail(404, 'not_found', 'This request is no longer waiting');
    hub.broadcast(me.circleId, { type: 'rejoin_requests' });
    log('rejoin approved');
    return { ok: true };
  });

  r.add('POST', '/rejoin-requests/:id/deny', ({ me, params }) => {
    const req = waitingRejoin(me, params.id);
    store.denyRejoin(req.id, Date.now());
    hub.broadcast(me.circleId, { type: 'rejoin_requests' });
    log('rejoin denied');
    return { ok: true };
  });

  // --- keys --------------------------------------------------------------

  r.add('POST', '/keys/rotate', ({ me, body }) => {
    requireAdmin(me);
    const epoch = vEpoch(body.epoch);
    const current = store.circle(me.circleId).epoch;
    if (epoch !== current + 1) fail(409, 'stale_epoch', 'Someone else already rotated the key', { epoch: current });
    if (!body.envelopes || typeof body.envelopes !== 'object') fail(400, 'invalid', 'envelopes required');
    const members = store.activeMembers(me.circleId);
    const agents = new Set(members.filter((m) => m.kind === 'agent').map((m) => m.id));
    const active = members.filter((m) => !agents.has(m.id)).map((m) => m.id).sort();
    const given = Object.keys(body.envelopes).filter((id) => !agents.has(id)).sort();
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
    requireFeature(me, 'locate', 'Locate');
    const others = store.activeMembers(me.circleId).filter((m) => m.id !== me.id);
    const wanted = Array.isArray(body.targets) ? new Set(body.targets) : null;
    let targets;
    if (!wanted) {
      const wait = requestLimiter.take(`${me.id}>*`);
      if (wait) fail(429, 'rate_limited', `You can refresh everyone again in ${wait}s`, { retryAfter: wait });
      targets = others;
    } else {
      const asked = others.filter((m) => wanted.has(m.id));
      const waits = asked.map((m) => requestLimiter.take(`${me.id}>${m.id}`) || hourlyLocateLimiter.take(`${me.id}>${m.id}`));
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
    // Per person: delivered over the live connection, sent as a push, or unreachable.
    const delivery = Object.fromEntries(
      targets.map((m) => [m.id, hub.isOnline(m.id) ? 'delivered' : m.pushToken ? 'pushed' : 'unreachable']),
    );
    return { requested: targets.length, online, pushed: offline.length, delivery, cooldown: config.locationRequestCooldown };
  });

  // --- most visited places -------------------------------------------------
  // Each phone works out its own most visited places from its own location
  // history (which never leaves it) and shares only a short summary, sealed
  // with the circle key like a location.

  r.add('GET', '/frequent', ({ me }) => ({ frequent: store.frequent(me.circleId) }));

  r.add('PUT', '/frequent/me', ({ me, body }) => {
    requireFeature(me, 'frequentPlaces', 'Most visited places');
    const env = vEnvelope(body, 'frequent', 8192);
    currentEpoch(me.circleId, env.epoch);
    const now = Date.now();
    store.putFrequent(me.id, env, now);
    hub.broadcast(me.circleId, { type: 'frequent', memberId: me.id }, me.id);
    return { ok: true, updatedAt: now };
  });

  r.add('DELETE', '/frequent/me', ({ me }) => {
    store.deleteFrequent(me.id);
    hub.broadcast(me.circleId, { type: 'frequent', memberId: me.id }, me.id);
    return { ok: true };
  });

  // --- chirps --------------------------------------------------------------
  // A short sound, and optionally a flash, on one person's phone or everyone's
  // in the circle. Phones play the sender's own chirp, from their encrypted
  // profile, so the server only knows who chirped whom. The chirp waits here
  // until the phone collects it (a content-free push wakes it).

  const takeChirp = (key, now) => {
    const row = store.chirpLimit(key);
    if (row && row.blocked_until > now) {
      const wait = Math.ceil((row.blocked_until - now) / 1000);
      fail(429, 'chirp_cooldown', `You can chirp again in ${Math.ceil(wait / 60)} min`, { retryAfter: wait, cooldownUntil: row.blocked_until });
    }
    const fresh = !row || row.blocked_until || now - row.last_at > CHIRP_COOLDOWN_MS;
    const count = (fresh ? 0 : row.count) + 1;
    const blockedUntil = count >= CHIRP_BURST ? now + CHIRP_COOLDOWN_MS : 0;
    store.setChirpLimit(key, count, now, blockedUntil);
    return { remaining: CHIRP_BURST - count, cooldownUntil: blockedUntil || null };
  };

  r.add('POST', '/chirps', ({ me, body }) => {
    requireFeature(me, 'chirps', 'Chirps');
    const to = body.to == null ? null : vId(body.to, 'to');
    const flash = body.flash === true;
    const others = store.activeMembers(me.circleId).filter((m) => m.id !== me.id);
    const targets = to ? others.filter((m) => m.id === to) : others;
    if (to && !targets.length) fail(404, 'not_found', 'No such member');
    if (!targets.length) fail(409, 'nobody', 'There’s no one else in this circle yet');
    const now = Date.now();
    const limit = takeChirp(`${me.id}>${to || '*'}`, now);
    store.insertChirps(
      me.circleId,
      me.id,
      flash,
      targets.map((m) => ({ id: randomBytes(12).toString('base64url'), toId: m.id })),
      now,
    );
    for (const m of targets) if (hub.isOnline(m.id)) hub.send(m.id, { type: 'chirp' });
    push.chirp(targets.filter((m) => m.pushToken && !hub.isOnline(m.id)));
    log(to ? 'chirp sent' : `chirp sent to a circle (${targets.length})`);
    return { sent: targets.length, ...limit };
  });

  // Collect waiting chirps: { id, from, flash, at }. Collecting removes them.
  r.add('GET', '/chirps', ({ me }) => ({ chirps: store.takeChirps(me.id) }));

  // --- the circle's agent ------------------------------------------------
  // The agent host's public key, for sealing the agent invite to it; and the
  // setup itself. The server never sees the invite link.

  r.add('GET', '/agent-host', ({ me }) => ({
    available: !!agentHost,
    boxPub: agentHost?.boxPub ?? null,
    running: !!agentHost?.hasAgent(me.circleId),
  }));

  r.add('POST', '/agent-host/setup', async ({ me, body }) => {
    requireAdmin(me);
    requireFeature(me, 'agent', 'The circle helper');
    if (!agentHost) fail(404, 'no_agent_host', 'This server doesn’t run agents. Turn on AGENT=true (or run_agent in the Home Assistant app) first.');
    const from = vBytes(body.from, 'from', 32);
    if (from !== me.boxPub) fail(400, 'invalid', 'from must be your own key');
    const box = vBox(body.box, 'box', 2048);
    try {
      return await agentHost.setup({ circleId: me.circleId, fromBoxPub: from, box });
    } catch (e) {
      if (e.code === 'agent_exists') fail(409, 'agent_exists', e.message);
      if (e.code === 'invalid') fail(400, 'invalid', e.message);
      throw e;
    }
  });

  // --- files for the agent -----------------------------------------------
  // A photo or document someone sends the agent, encrypted on their phone.
  // The server only stores ciphertext; the key goes to the agent sealed in a
  // direct message. Kept or deleted by the agent when the sender chooses.

  const agentOf = (circleId) => store.activeMembers(circleId).find((m) => m.kind === 'agent') ?? null;
  const fileFor = (me, id) => {
    const f = /^[A-Za-z0-9_-]{16,40}$/.test(String(id)) ? store.file(id) : null;
    if (!f || f.circleId !== me.circleId) fail(404, 'not_found', 'No such file');
    return f;
  };

  r.add(
    'POST',
    '/files',
    ({ me, body }) => {
      if (!files || !agentHost || !agentOf(me.circleId)) fail(404, 'no_agent', 'This circle has no agent to send files to');
      requireFeature(me, 'uploads', 'Sending files to the helper');
      if (!Buffer.isBuffer(body) || body.length < 40) fail(400, 'invalid', 'Send the encrypted file as the request body');
      if (store.unkeptFilesBy(me.id) >= 20) fail(429, 'rate_limited', 'You have 20 files waiting for an answer. Save or discard some first.', { retryAfter: 3600 });
      if ((store.circleBytes.get(me.circleId) || 0) + store.circleFileBytes(me.circleId) + body.length > config.maxCircleBytes) {
        fail(507, 'circle_full', 'This circle’s storage is full. Delete files you no longer need in Memory.');
      }
      const id = randomBytes(18).toString('base64url');
      files.save({ id, circleId: me.circleId, uploaderId: me.id, bytes: body, now: Date.now() });
      return { id };
    },
    { raw: MAX_FILE_BYTES },
  );

  // Anyone in the circle can fetch the ciphertext (only those given the key can read it).
  r.add('GET', '/files/:id', ({ me, params }) => files.read(fileFor(me, params.id).id), { agent: true });

  // The agent keeps a file when the sender says so; otherwise it goes after 7 days.
  r.add(
    'POST',
    '/files/:id/keep',
    ({ me, params }) => {
      if (me.kind !== 'agent') fail(403, 'forbidden', 'Only the agent keeps files');
      store.keepFile(fileFor(me, params.id).id);
      return { ok: true };
    },
    { agent: true },
  );

  r.add(
    'DELETE',
    '/files/:id',
    ({ me, params }) => {
      const f = fileFor(me, params.id);
      if (me.kind !== 'agent' && f.uploaderId !== me.id && !isAdmin(me)) fail(403, 'forbidden', 'Only whoever sent it, the agent or an admin can delete it');
      files.remove(f.id);
      return { ok: true };
    },
    { agent: true },
  );

  // --- messages ----------------------------------------------------------

  r.add('GET', '/messages', ({ me, query }) => {
    const after = Math.max(0, Number.parseInt(query.get('after') || '0', 10) || 0);
    const limit = Math.min(500, Math.max(1, Number.parseInt(query.get('limit') || '200', 10) || 200));
    const rows = me.kind === 'agent' ? store.directMessagesAfter(me.circleId, me.id, after, limit) : store.messagesAfter(me.circleId, me.id, after, limit);
    // A phone asking for what's after `after` has everything up to it; a page
    // that isn't full means it now has everything. Delivered ticks follow.
    if (me.kind !== 'agent') {
      const upTo = rows.length < limit ? Math.max(after, rows.at(-1)?.seq ?? 0) : after;
      if (upTo > 0 && store.setDelivered(me.id, upTo)) hub.broadcast(me.circleId, { type: 'delivered', delivered: { [me.id]: upTo } }, me.id);
    }
    return { messages: rows };
  }, { agent: true });

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
    if (me.kind === 'agent' && !to) fail(403, 'forbidden', 'An agent only sends direct messages');
    if (store.messageExists(id)) fail(409, 'conflict', 'Duplicate message id');
    const now = Date.now();
    // Storage limits, so one device (or a stolen one) can't fill the disk.
    if ((store.circleBytes.get(me.circleId) || 0) + (files ? store.circleFileBytes(me.circleId) : 0) > config.maxCircleBytes) {
      fail(507, 'circle_full', 'This circle’s message storage is full. Older messages are deleted as they expire; an admin can shorten how long messages are kept.');
    }
    if (store.messagesFromSince(me.id, now - 86400_000) >= config.maxMessagesPerDay) {
      fail(429, 'rate_limited', 'You’ve sent a lot of messages today. Try again later.', { retryAfter: 3600 });
    }
    const seq = store.insertMessage({ id, circleId: me.circleId, fromId: me.id, toId: to?.id ?? null, env, now });
    const message = { seq, id, from: me.id, to: to?.id ?? null, env, createdAt: now };
    if (to) hub.send(to.id, { type: 'message', message });
    else hub.broadcast(me.circleId, { type: 'message', message }, me.id);
    // Phones with the app open got it just now: delivered.
    const reached = {};
    for (const m of to ? [to] : store.activeMembers(me.circleId)) {
      if (m.id !== me.id && m.kind !== 'agent' && hub.isOnline(m.id) && store.setDelivered(m.id, seq)) reached[m.id] = seq;
    }
    if (Object.keys(reached).length) hub.broadcast(me.circleId, { type: 'delivered', delivered: reached });
    // Clients mark reactions "silent": stored and relayed live, but no push.
    if (body.silent !== true) {
      const recipients = to ? [to] : store.activeMembers(me.circleId).filter((m) => m.id !== me.id);
      push.activity(recipients.filter((m) => m.pushToken && !hub.isOnline(m.id)));
    }
    return { seq, createdAt: now };
  }, { agent: true });

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
