import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { loadConfig, ensureSetupToken } from './config.js';
import { openDb } from './db.js';
import { Hub } from './hub.js';
import { Push } from './push.js';
import { buildRoutes } from './routes.js';
import { createStatic } from './static.js';
import { HttpError, sendJson, readJson, sha256, clientIp } from './http.js';

// Logs never include IPs, tokens or payloads.
const log = (...args) => console.log(new Date().toISOString(), ...args);

export function createApp(config) {
  config = { maxRetentionDays: 365, ...config };
  const store = openDb(config.dataDir);
  ensureSetupToken(config, store);
  const hub = new Hub({ store, log, authTimeoutMs: config.wsAuthTimeoutMs });
  const push = new Push(config, store, log);
  const router = buildRoutes({ config, store, hub, push, log });
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
          const now = Date.now();
          if (!me.lastSeenAt || now - me.lastSeenAt > 60_000) store.touchMember(me.id, now);
        }
        const body = ['POST', 'PUT', 'PATCH'].includes(req.method) ? await readJson(req) : {};
        const ctx = { ip: clientIp(req, config.trustProxy) };
        const result = await route.handler({ me, body, params, query: url.searchParams, ctx });
        const headers = { ...secureHeaders };
        if (route.cors) headers['Access-Control-Allow-Origin'] = '*';
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
  hub.attach(server);

  const prune = () => {
    const now = Date.now();
    store.pruneMessages(now, config.maxRetentionDays);
    store.pruneInvites(now - 7 * 86400_000);
    store.pruneRejoins(now - 7 * 86400_000);
    // A chirp is only worth playing right away; one nobody collected in 10
    // minutes is dropped. Limits are kept until their 30 minutes are over.
    store.pruneChirps(now - 10 * 60_000, now - 30 * 60_000);
  };
  prune();
  const pruneTimer = setInterval(prune, 3600_000);

  const close = () =>
    new Promise((resolve) => {
      clearInterval(pruneTimer);
      hub.close();
      server.close(() => {
        store.close();
        resolve();
      });
      server.closeAllConnections?.();
    });

  return { server, store, hub, config, close };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  // createApp fills in defaults and may generate the setup code, so use the
  // config it returns, not the one passed in.
  const app = createApp(loadConfig());
  const { config } = app;
  app.server.listen(config.port, config.host, () => {
    log(`HomeCircle server ${config.version} listening on ${config.host}:${config.port}`);
    const where = config.publicUrl || 'your server address';
    log('──────────────────────────────────────────────────────────');
    if (config.loadTest) {
      log('  LOAD-TEST SERVER (LOAD_TEST=1): for simulated people only. Never put your family on it.');
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
  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, async () => {
      log('shutting down');
      await app.close();
      process.exit(0);
    });
  }
}
