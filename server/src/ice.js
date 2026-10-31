// The servers phones use to connect a call (docs/CALLS-PLAN.md). STUN is
// always listed. A TURN relay, for two phones that can't reach each other
// directly, comes from one of three places, tried in this order:
//   - a hosted relay with a free tier, for servers that can't run one
//     themselves (Render, the Home Assistant add-on): Cloudflare Realtime
//     TURN or Metered. This server fetches short-lived credentials with the
//     account's key and hands them to circle members; the key never leaves it.
//   - the family's own coturn, with credentials made from a shared secret.
// The relay sees encrypted packets, their sizes and timing, never the voice.
import { createHmac } from 'node:crypto';
import { sha256 } from './http.js';

/** STUN servers apps use when the server doesn't say (CALLS_STUN overrides). */
export const DEFAULT_STUN = ['stun:stun.cloudflare.com:3478', 'stun:stun.l.google.com:19302'];

const CLOUDFLARE = (keyId) => `https://rtc.live.cloudflare.com/v1/turn/keys/${encodeURIComponent(keyId)}/credentials/generate-ice-servers`;
const METERED = (app, key) => `https://${encodeURIComponent(app)}.metered.live/api/v1/turn/credentials?apiKey=${encodeURIComponent(key)}`;

/** Only the relay entries of a provider's answer: urls (turn:/turns:) with a username and credential. */
export function turnEntries(list) {
  const out = [];
  for (const s of Array.isArray(list) ? list : []) {
    const urls = (Array.isArray(s?.urls) ? s.urls : [s?.urls]).filter((u) => typeof u === 'string' && /^turns?:/.test(u));
    if (urls.length && typeof s.username === 'string' && typeof s.credential === 'string') out.push({ urls, username: s.username, credential: s.credential });
  }
  return out;
}

export class IceServers {
  constructor(config, log = () => {}) {
    this.config = config;
    this.log = log;
    this.fetch = config.fetchImpl || globalThis.fetch.bind(globalThis);
    this.cache = null; // { entries, until }
  }

  get provider() {
    const c = this.config;
    if (c.callsCloudflareKeyId && c.callsCloudflareToken) return 'cloudflare';
    if (c.callsMeteredApp && c.callsMeteredKey) return 'metered';
    if (c.callsTurnUrls?.length && c.callsTurnSecret) return 'coturn';
    return null;
  }

  /** { iceServers, relayOnly? } for a member. Never throws: a relay that can't be reached leaves STUN only. */
  async forMember(memberId, now = Date.now()) {
    const stun = this.config.callsStun?.length ? this.config.callsStun : DEFAULT_STUN;
    const iceServers = stun.map((urls) => ({ urls }));
    let turn = [];
    try {
      turn = await this._turn(memberId, now);
    } catch (e) {
      this.log(`calls: relay credentials failed (${e.message})`);
    }
    iceServers.push(...turn);
    return { iceServers, ...(turn.length && this.config.callsRelayOnly ? { relayOnly: true } : {}) };
  }

  async _turn(memberId, now) {
    const c = this.config;
    const hours = Math.max(1, c.callsTurnTtlHours ?? 6);
    switch (this.provider) {
      case 'coturn': {
        // coturn's "use-auth-secret": the username is when the credential expires,
        // the password an HMAC of it with the shared secret.
        const username = `${Math.floor(now / 1000) + hours * 3600}:${sha256(memberId).slice(0, 8)}`;
        const credential = createHmac('sha1', c.callsTurnSecret).update(username).digest('base64');
        return [{ urls: c.callsTurnUrls, username, credential }];
      }
      case 'cloudflare':
        // One set for everyone, refreshed when half its life has passed, so what
        // is handed out always has at least that long left (a call can be long).
        return this._cached(now, (hours * 3600_000) / 2, async () => {
          const res = await this.fetch(CLOUDFLARE(c.callsCloudflareKeyId), {
            method: 'POST',
            headers: { Authorization: `Bearer ${c.callsCloudflareToken}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ ttl: hours * 3600 }),
          });
          if (!res.ok) throw new Error(`Cloudflare answered ${res.status}`);
          return turnEntries((await res.json())?.iceServers);
        });
      case 'metered':
        return this._cached(now, 30 * 60_000, async () => {
          const res = await this.fetch(METERED(c.callsMeteredApp, c.callsMeteredKey));
          if (!res.ok) throw new Error(`Metered answered ${res.status}`);
          return turnEntries(await res.json());
        });
      default:
        return [];
    }
  }

  async _cached(now, keepMs, load) {
    if (this.cache && this.cache.until > now) return this.cache.entries;
    // Several phones asking at once share one request.
    this.pending ??= load().finally(() => (this.pending = null));
    const entries = await this.pending;
    if (entries.length) this.cache = { entries, until: now + keepMs };
    return entries;
  }
}
