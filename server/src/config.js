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
    trustProxy: bool('TRUST_PROXY', false),
    messageRetentionDays: int('MESSAGE_RETENTION_DAYS', 90),
    locationRequestCooldown: int('LOCATION_REQUEST_COOLDOWN_SECONDS', 60),
    inviteMaxHours: int('INVITE_MAX_HOURS', 168),
    push: process.env.PUSH_PROVIDER || 'expo',
    expoPushUrl: process.env.EXPO_PUSH_URL || 'https://exp.host/--/api/v2/push/send',
    expoAccessToken: process.env.EXPO_ACCESS_TOKEN || '',
    tileUrl: process.env.TILE_URL || 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
    tileAttribution: process.env.TILE_ATTRIBUTION || '&copy; OpenStreetMap contributors',
    webClient: bool('WEB_CLIENT', true),
  };
  if (config.setupToken && config.setupToken.length < 12) {
    throw new Error('SETUP_TOKEN must be at least 12 characters');
  }
  return config;
}

/** If no SETUP_TOKEN was provided, make one for this boot and print it. */
export function ensureSetupToken(config) {
  if (!config.setupToken) {
    config.setupToken = randomBytes(12).toString('base64url');
    config.setupTokenGenerated = true;
  }
}
