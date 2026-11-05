import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { loadConfig, ensureSetupToken } from './config.js';
import { openDb } from './db.js';
import { Hub } from './hub.js';
import { Push } from './push.js';
import { buildRoutes } from './routes.js';
import { createStatic } from './static.js';
import { AgentHost } from './agent/host.js';
import { createFiles } from './files.js';
import { CallRelay } from './calls.js';
import { Demo, fromDirector } from './demo.js';
import { HttpError, sendJson, readJson, readRaw, sha256, clientIp, RateLimiter } from './http.js';

// Logs never include IPs, tokens or payloads.
const log = (...args) => console.log(new Date().toISOString(), ...args);

export function createApp(config) {
  config = {
    maxRetentionDays: 365,
    // Per device: requests a minute (writes, all), messages a day. Per circle:
    // bytes of messages stored. Per address: open live connections.
    writesPerMinute: 120,
    requestsPerMinute: 600,
    maxMessagesPerDay: 5000,
    maxCircleBytes: 256 * 1024 * 1024,
    maxSocketsPerIp: 40,
    ...config,
  };
  // The load-test swarm runs hundreds of simulated phones from one address,
  // up to 500× a normal day: limits meant for one person would only measure
  // themselves.
  if (config.loadTest) {
    config.writesPerMinute *= 100;
    config.requestsPerMinute *= 100;
    config.maxMessagesPerDay *= 100;
    config.maxSocketsPerIp = 100_000;
  }
  // Seeding a copy sends a burst of notes through its owner; a copy is small and short-lived.
  if (config.demoMode) {
    config.writesPerMinute *= 5;
    config.maxCircleBytes = 32 * 1024 * 1024;
    // Every copy's helper connects from this machine.
    config.maxSocketsPerIp = Math.max(config.maxSocketsPerIp, config.demoMaxRunning * 2 + 20);
  }
  const store = openDb(config.dataDir);
  ensureSetupToken(config, store);
  const calls = new CallRelay();
  // A phone that just connected (a push woke it) gets the call signals that waited for it.
  const onReady = (id) => {
    for (const s of calls.take(id)) hub.send(id, { type: 'call_signal', from: s.from, id: s.id, env: s.env, at: s.at });
  };
  const hub = new Hub({ store, log, onReady, authTimeoutMs: config.wsAuthTimeoutMs, maxSocketsPerIp: config.maxSocketsPerIp, ipOf: (req) => clientIp(req, config.trustProxy), noSocketLimit: (req) => fromDirector(config, req) });
  const requestLimiter = new RateLimiter(config.requestsPerMinute, 60_000);
  const writeLimiter = new RateLimiter(config.writesPerMinute, 60_000);
  // The helper answers in the group once per member, and big answers in parts.
  const agentWriteLimiter = new RateLimiter(config.writesPerMinute * 5, 60_000);
  const push = new Push(config, store, log);
  // Birdie joins each demo copy over loopback, as the director's: it isn't a visitor at that address's limits.
  const agentFetch = config.demoMode ? (url, init = {}) => fetch(url, { ...init, headers: { ...init.headers, 'x-demo-token': config.demoToken } }) : undefined;
  const agentHost = config.agent ? new AgentHost({ dataDir: config.dataDir, log, fetchImpl: agentFetch, brainOptions: { ...config.agentBrainOptions, demo: !!config.demoMode } }) : null;
  const files = createFiles({ dataDir: config.dataDir, store });
  const demo = config.demoMode ? new Demo({ config, store, hub, files, agentHost, log }) : null;
  const router = buildRoutes({ config, store, hub, push, log, agentHost, files, calls, demo });
  const serveStatic = config.webClient ? createStatic(config) : null;

  const server = createServer(async (req, res) => {
    const url = new URL(req.url || '/', 'http://localhost');
    const path = url.pathname;
    const secureHeaders = {};
    if (req.headers['x-forwarded-proto'] === 'https' || req.socket.encrypted) {
      secureHeaders['Strict-Transport-Security'] = 'max-age=31536000';
    }
    try {
      if (path === '/healthz') {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        return res.end('ok');
      }
      if (path.startsWith('/api/v1/')) {
        const apiPath = path.slice(7);
        if (req.method === 'OPTIONS' && apiPath === '/info') {
          res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET' });
          return res.end();
        }
        const match = router.match(req.method, apiPath);
        if (!match) throw new HttpError(404, 'not_found', 'Unknown endpoint');
        if (match.notAllowed) throw new HttpError(405, 'method_not_allowed', 'Method not allowed');
        const { route, params } = match;
        let me = null;
        if (route.auth) {
          const auth = req.headers.authorization || '';
          const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
          me = token ? store.memberByToken(sha256(token)) : null;
          if (!me) throw new HttpError(401, 'unauthorized', 'Your device is not signed in to this circle');
          // A circle's agent reads its state and messages and sends direct messages; nothing else.
          if (me.kind === 'agent' && !route.agent) throw new HttpError(403, 'forbidden', 'Not available to an agent');
          const wait = requestLimiter.take(me.id) || (req.method === 'GET' ? 0 : (me.kind === 'agent' ? agentWriteLimiter : writeLimiter).take(me.id));
          if (wait) throw new HttpError(429, 'rate_limited', 'Too many requests from this device, try again shortly', { retryAfter: wait });
          const now = Date.now();
          if (!me.lastSeenAt || now - me.lastSeenAt > 60_000) store.touchMember(me.id, now);
        }
        const body = route.raw ? await readRaw(req, route.raw) : ['POST', 'PUT', 'PATCH'].includes(req.method) ? await readJson(req) : {};
        const ctx = { ip: clientIp(req, config.trustProxy), req, director: fromDirector(config, req) };
        const result = await route.handler({ me, body, params, query: url.searchParams, ctx });
        const headers = { ...secureHeaders };
        if (route.cors) headers['Access-Control-Allow-Origin'] = '*';
        // A file (ciphertext) goes back as bytes.
        if (Buffer.isBuffer(result)) {
          res.writeHead(200, { ...headers, 'Content-Type': 'application/octet-stream', 'Content-Length': result.length, 'Cache-Control': 'no-store' });
          return res.end(result);
        }
        return sendJson(res, 200, result ?? { ok: true }, headers);
      }
      if (serveStatic && (await serveStatic(req, res, path))) return;
      throw new HttpError(404, 'not_found', 'Not found');
    } catch (e) {
      if (e instanceof HttpError) {
        return sendJson(res, e.status, { error: e.code, message: e.message, ...e.extra }, secureHeaders);
      }
      log('error', e?.stack || e);
      return sendJson(res, 500, { error: 'internal', message: 'Something went wrong on the server' });
    }
  });
  // Requests are small: a client that trickles its headers or body is cut
  // off instead of holding a connection open (Node's defaults are minutes).
  server.headersTimeout = 15_000;
  // Two minutes for a whole request: a 15 MB file on a slow phone connection.
  server.requestTimeout = 120_000;
  hub.attach(server);

  const prune = () => {
    const now = Date.now();
    store.pruneMessages(now, config.maxRetentionDays);
    store.countCircleBytes();
    store.pruneInvites(now - 7 * 86400_000);
    store.pruneRejoins(now - 7 * 86400_000);
    // A chirp is only worth playing right away; one nobody collected in 10
    // minutes is dropped. Limits are kept until their 30 minutes are over.
    store.pruneChirps(now - 10 * 60_000, now - 30 * 60_000);
    files.prune(now);
    calls.sweep(now);
  };
  prune();
  const pruneTimer = setInterval(prune, 3600_000);

  const close = async () => {
    demo?.close();
    await agentHost?.stop();
    return new Promise((resolve) => {
      clearInterval(pruneTimer);
      hub.close();
      push.close();
      server.close(() => {
        store.close();
        resolve();
      });
      server.closeAllConnections?.();
    });
  };

  return { server, store, hub, push, config, close, agentHost, demo };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  // createApp fills in defaults and may generate the setup code, so use the
  // config it returns, not the one passed in.
  const app = createApp(loadConfig());
  const { config } = app;
  app.server.listen(config.port, config.host, () => {
    log(`HomeCircle server ${config.version} listening on ${config.host}:${config.port}`);
    // Agents talk to this server like any phone, over loopback.
    const local = ['0.0.0.0', '::', ''].includes(config.host) ? '127.0.0.1' : config.host;
    app.agentHost?.start(`http://${local.includes(':') ? `[${local}]` : local}:${config.port}`).catch((e) => log('agent host failed to start', e?.message ?? e));
    const where = config.publicUrl || 'your server address';
    log('──────────────────────────────────────────────────────────');
    if (config.loadTest) {
      log('  LOAD-TEST SERVER (LOAD_TEST=1): for simulated people only. Never put your family on it.');
    }
    if (config.demoMode) {
      log('  DEMO SERVER (DEMO_MODE=1): throwaway copies of a made-up family. Never put your family on it.');
      log('──────────────────────────────────────────────────────────');
      if (config.demoDirector) startDirector();
      return;
    }
    if (!app.store.isSetup) {
      log('  This server has no circle yet.');
      log(`  Open the HomeCircle app, choose "Set up a new server", enter ${where}`);
    } else {
      log('  Lost access to your circle? In the HomeCircle app choose "I set up this server",');
      log(`  enter ${where}`);
    }
    if (config.setupTokenGenerated) {
      log(`  and this setup code:  ${config.setupToken}`);
      log('  (It stays the same after restarts. Keep it private. Set SETUP_TOKEN to choose your own.)');
    } else {
      log('  and the setup code you chose (SETUP_TOKEN, or setup_code in Home Assistant).');
    }
    log('──────────────────────────────────────────────────────────');
  });
  // The demo director, restarted if it stops. It rebuilds its copies from nothing.
  let director = null;
  const startDirector = () => {
    director = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', fileURLToPath(new URL('../demo/director.mjs', import.meta.url))], {
      env: { ...process.env, DEMO_SERVER: `http://127.0.0.1:${app.config.port}` },
      stdio: 'inherit',
    });
    director.on('exit', () => {
      if (director) setTimeout(startDirector, 5000);
    });
  };
  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, async () => {
      log('shutting down');
      const child = director;
      director = null;
      child?.kill();
      await app.close();
      process.exit(0);
    });
  }
}
