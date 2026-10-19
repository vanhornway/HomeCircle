// Serves the built-in web client and the browser builds of its dependencies.
import { readFile } from 'node:fs/promises';
import { resolve, join, extname, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.ico': 'image/x-icon',
};

export function createStatic(config) {
  const publicDir = resolve(here, '../public');
  const coreDir = resolve(process.env.CORE_DIR || resolve(here, '../../packages/core/src'));
  const leafletDir = dirname(require.resolve('leaflet/dist/leaflet.css'));
  const naclFile = require.resolve('tweetnacl/nacl-fast.js');
  const qrFile = resolve(dirname(require.resolve('qrcode-generator')), 'qrcode.mjs');
  const cache = new Map();

  const tileOrigin = (() => {
    const m = config.tileUrl.match(/^https:\/\/[^/]+/);
    return m ? m[0].replace(/\{s\}\./, '*.') : '';
  })();
  const cspFor = (host) => [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    `img-src 'self' data: blob: ${tileOrigin}`,
    // 'self' covers same-origin WebSockets in current browsers; older Safari needs them listed.
    `connect-src 'self'${host ? ` wss://${host} ws://${host}` : ''}`,
    "font-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
    "form-action 'self'",
  ].join('; ');
  const HOST_RE = /^[A-Za-z0-9.-]+(:\d+)?$/;

  async function load(key, file, transform) {
    if (cache.has(key)) return cache.get(key);
    let body = await readFile(file);
    if (transform) body = Buffer.from(transform(body.toString('utf8')));
    if (process.env.NODE_ENV === 'production') cache.set(key, body);
    return body;
  }

  // Core modules import 'tweetnacl' as a bare specifier; browsers need a path.
  const rewriteCore = (src) => src.replace(/from 'tweetnacl'/g, "from '/vendor/tweetnacl.mjs'");
  // nacl-fast.js is UMD; in module scope it attaches to self.nacl.
  const naclEsm = (src) => `${src}\nexport default self.nacl;\n`;

  const safe = (base, rel) => {
    if (!/^[A-Za-z0-9_.\-/]+$/.test(rel) || rel.includes('..')) return null;
    const p = resolve(join(base, rel));
    return p.startsWith(base) ? p : null;
  };

  /** Returns true if it handled the request. */
  return async function serveStatic(req, res, path) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return false;
    let file;
    let key = path;
    let transform;
    let maxAge = 0;
    if (path === '/' || path === '/join' || path === '/join/') {
      file = join(publicDir, 'index.html');
      key = '/index.html';
    } else if (path.startsWith('/app/')) {
      file = safe(publicDir, path.slice(5));
    } else if (path.startsWith('/core/')) {
      file = safe(coreDir, path.slice(6));
      transform = rewriteCore;
    } else if (path === '/vendor/tweetnacl.mjs') {
      file = naclFile;
      transform = naclEsm;
      maxAge = 86400;
    } else if (path === '/vendor/qrcode.mjs') {
      file = qrFile;
      maxAge = 86400;
    } else if (path.startsWith('/vendor/leaflet/')) {
      file = safe(leafletDir, path.slice(16));
      maxAge = 86400;
    } else {
      return false;
    }
    if (!file) return false;
    let body;
    try {
      body = await load(key, file, transform);
    } catch {
      return false;
    }
    const type = TYPES[extname(file)] || 'application/octet-stream';
    const headers = {
      'Content-Type': type,
      'Content-Length': body.length,
      'Cache-Control': maxAge ? `public, max-age=${maxAge}` : 'no-cache',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
    };
    if (type.startsWith('text/html')) {
      const host = HOST_RE.test(req.headers.host || '') ? req.headers.host : '';
      headers['Content-Security-Policy'] = cspFor(host);
      headers['X-Frame-Options'] = 'DENY';
      headers['Permissions-Policy'] = 'geolocation=(self), camera=(), microphone=()';
    }
    res.writeHead(200, headers);
    res.end(req.method === 'HEAD' ? undefined : body);
    return true;
  };
}
