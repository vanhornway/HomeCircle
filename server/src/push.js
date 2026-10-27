// Content-free push notifications through Expo's push service (which relays to
// APNs / FCM). Payloads never contain names, locations or message text.
import { pushHint } from '../../packages/core/src/crypto.js';

const EXPO_TOKEN = /^Expo(nent)?PushToken\[[A-Za-z0-9_\-:.]+\]$/;
// Chat wake-ups: at most one per member (so per circle) in this long; a
// burst ends with one more, so the last message isn't missed.
export const ACTIVITY_COALESCE_MS = 45_000;

/**
 * Which circle a push is about, in a form only that phone can match: a short
 * hash of its own member id there. FCM sees a token that stays the same per
 * person and circle, never the circle.
 */
export const circleHint = pushHint;
export const isPushToken = (t) => typeof t === 'string' && t.length < 256 && EXPO_TOKEN.test(t);

export class Push {
  constructor(config, store, log) {
    this.config = config;
    this.store = store;
    this.log = log;
    this.enabled = config.push === 'expo';
    // memberId -> { at, timer } for coalescing chat wake-ups.
    this.recent = new Map();
    this.coalesceMs = config.pushCoalesceMs ?? ACTIVITY_COALESCE_MS;
  }

  /**
   * A new chat message or place event, coalesced: a member who had one in
   * the last 45 s gets the next one when that time is up (once, however many
   * arrive meanwhile).
   */
  activity(members) {
    const now = Date.now();
    const sendNow = [];
    for (const m of members) {
      const r = this.recent.get(m.id);
      if (!r || now - r.at >= this.coalesceMs) {
        this.recent.set(m.id, { at: now, timer: null });
        sendNow.push(m);
      } else if (!r.timer) {
        r.timer = setTimeout(() => {
          this.recent.set(m.id, { at: Date.now(), timer: null });
          this._activity([m]);
        }, r.at + this.coalesceMs - now);
        r.timer.unref?.();
      }
    }
    // Old entries go, so the map stays small.
    if (this.recent.size > 5000) for (const [id, r] of this.recent) if (!r.timer && now - r.at > this.coalesceMs) this.recent.delete(id);
    return this._activity(sendNow);
  }

  close() {
    for (const r of this.recent.values()) clearTimeout(r.timer);
    this.recent.clear();
  }

  /** Ask phones to take one fresh location fix (silent / data-only push). */
  locationRequest(members) {
    return this._send(
      members.map((m) => ({
        to: m.pushToken,
        data: { t: 'loc_req' },
        priority: 'high',
        _contentAvailable: true,
      })),
    );
  }

  /**
   * Android phones get a content-free data push that wakes the app, which
   * fetches, decrypts and shows the message itself; `c` says which of its
   * circles (circleHint) and collapseId keeps only the latest in transit.
   * Other platforms get a generic visible alert.
   */
  _activity(members) {
    if (!members.length) return Promise.resolve();
    return this._send(
      members.map((m) => {
        const c = circleHint(m.id);
        return m.pushPlatform === 'android'
          ? { to: m.pushToken, data: { t: 'msg', c }, priority: 'high', collapseId: `msg-${c}` }
          : {
              to: m.pushToken,
              title: 'HomeCircle',
              body: 'New message in your circle',
              sound: 'default',
              priority: 'high',
              data: { t: 'msg', c },
              collapseId: `msg-${c}`,
              _contentAvailable: true,
            };
      }),
    );
  }

  /**
   * Someone chirped: wake the phone so it collects the chirp and plays the
   * sender's sound. Android gets a content-free data push; other platforms a
   * generic alert.
   */
  chirp(members) {
    return this._send(
      members.map((m) =>
        m.pushPlatform === 'android'
          ? { to: m.pushToken, data: { t: 'chirp' }, priority: 'high' }
          : { to: m.pushToken, title: 'HomeCircle', body: 'Someone chirped you', sound: 'default', priority: 'high', data: { t: 'chirp' } },
      ),
    );
  }

  /** Someone used the setup code to ask to rejoin. No name: just open the app. */
  rejoinRequest(members) {
    return this._send(
      members.map((m) => ({
        to: m.pushToken,
        title: 'HomeCircle',
        body: 'Someone asked to rejoin your circle. Open HomeCircle to approve or deny.',
        sound: 'default',
        priority: 'high',
        data: { t: 'rejoin' },
      })),
    );
  }

  async _send(messages) {
    messages = messages.filter((m) => isPushToken(m.to));
    if (!this.enabled || !messages.length) return;
    const headers = { 'Content-Type': 'application/json', Accept: 'application/json' };
    if (this.config.expoAccessToken) headers.Authorization = `Bearer ${this.config.expoAccessToken}`;
    for (let i = 0; i < messages.length; i += 100) {
      const batch = messages.slice(i, i + 100);
      try {
        const res = await fetch(this.config.expoPushUrl, { method: 'POST', headers, body: JSON.stringify(batch) });
        const json = await res.json().catch(() => null);
        (json?.data || []).forEach((ticket, j) => {
          if (ticket?.status === 'error' && ticket.details?.error === 'DeviceNotRegistered') {
            this.store.clearPushToken(batch[j].to);
          }
        });
        if (!res.ok) this.log(`push: relay returned ${res.status}`);
      } catch (e) {
        this.log(`push: ${e.message}`);
      }
    }
  }
}
