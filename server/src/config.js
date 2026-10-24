import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

const int = (name, def) => {
  const v = process.env[name];
  if (v === undefined || v === '') return def;
  const n = Number.parseInt(v, 10);
  if (!Number.isFinite(n)) throw new Error(`${name} must be a number`);
  return n;
};
const bool = (name, def) => {
  const v = process.env[name];
  if (v === undefined || v === '') return def;
  return ['1', 'true', 'yes', 'on'].includes(v.toLowerCase());
};

export function loadConfig() {
  const config = {
    version: pkg.version,
    port: int('PORT', 8080),
    host: process.env.HOST || '0.0.0.0',
    dataDir: process.env.DATA_DIR || '/data',
    setupToken: process.env.SETUP_TOKEN || '',
    setupTokenGenerated: false,
    publicUrl: (process.env.PUBLIC_URL || '').replace(/\/+$/, ''),
    // How many proxies in front of the server to trust for the client's
    // address: "true" means one (Caddy, Render, Railway, Tailscale), or a count.
    trustProxy: /^\d+$/.test(process.env.TRUST_PROXY || '') ? int('TRUST_PROXY', 0) : bool('TRUST_PROXY', false) ? 1 : 0,
    // Longest any circle may keep messages; each circle's admin picks up to this.
    // Never more than a year: older messages are always deleted from the server.
    maxRetentionDays: Math.min(365, Math.max(1, int('MESSAGE_RETENTION_DAYS', 365) || 365)),
    locationRequestCooldown: int('LOCATION_REQUEST_COOLDOWN_SECONDS', 60),
    inviteMaxHours: int('INVITE_MAX_HOURS', 168),
    push: process.env.PUSH_PROVIDER || 'expo',
    expoPushUrl: process.env.EXPO_PUSH_URL || 'https://exp.host/--/api/v2/push/send',
    expoAccessToken: process.env.EXPO_ACCESS_TOKEN || '',
    tileUrl: process.env.TILE_URL || 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
    tileAttribution: process.env.TILE_ATTRIBUTION || '&copy; OpenStreetMap contributors',
    webClient: bool('WEB_CLIENT', true),
    // A throwaway server for the swarm (scripts/swarm.mjs): it says so in /info,
    // its web page shows a banner, and the swarm refuses any server without it.
    loadTest: bool('LOAD_TEST', false),
  };
  if (config.setupToken && config.setupToken.length < 12) {
    throw new Error('SETUP_TOKEN must be at least 12 characters');
  }
  return config;
}

/**
 * If no SETUP_TOKEN was provided, use the code this server generated before,
 * or make one and keep it, so it stays the same after restarts. It's needed
 * again later to recover circles.
 */
export function ensureSetupToken(config, store) {
  if (config.setupToken) return;
  let code = store.getMeta('setup_code');
  if (!code) {
    code = randomBytes(12).toString('base64url');
    store.setMeta('setup_code', code);
  }
  config.setupToken = code;
  config.setupTokenGenerated = true;
}
