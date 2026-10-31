// Content-free push notifications through Expo's push service (which relays to
// APNs / FCM). Payloads never contain names, locations or message text.
import { pushHint } from '../../packages/core/src/crypto.js';

const EXPO_TOKEN = /^Expo(nent)?PushToken\[[A-Za-z0-9_\-:.]+\]$/;
// Chat wake-ups: at most one per member (so per circle) in this long; a
// burst ends with one more, so the last message isn't missed.
export const ACTIVITY_COALESCE_MS = 45_000;
// Backup alert for an Android phone that opted in: if the silent wake-up for a
// message hasn't been followed by the phone fetching it after this long, the
// phone is asleep and Android is holding the wake-up back. Send one generic
// visible alert, which the system shows and sounds at once. Sooner for urgent.
export const FALLBACK_DELAY_MS = 12_000;
export const FALLBACK_URGENT_DELAY_MS = 4_000;
// Android channels the app creates (mobile/src/lib/notify.ts) for those alerts.
export const FALLBACK_CHANNEL = 'messages';
export const FALLBACK_URGENT_CHANNEL = 'urgent';

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
    this.fallbackMs = config.pushFallbackMs ?? FALLBACK_DELAY_MS;
    this.fallbackUrgentMs = config.pushFallbackUrgentMs ?? FALLBACK_URGENT_DELAY_MS;
    // memberId -> { seq, urgent, due, timer }: backup alerts waiting to be checked.
    this.fallbacks = new Map();
  }

  /**
   * A new chat message or place event, coalesced: a member who had one in
   * the last 45 s gets the next one when that time is up (once, however many
   * arrive meanwhile). An `urgent` one (a call-back request, a reply to it,
   * an SOS) goes at once and stands in for any wake-up still waiting; the
   * push itself is the same as any other.
   *
   * `seq` is the message's sequence number: for a member who opted in to
   * backup alerts it says what to check was fetched (see _watch).
   */
  activity(members, { urgent = false, seq = 0 } = {}) {
    const now = Date.now();
    const sendNow = [];
    for (const m of members) {
      const r = this.recent.get(m.id);
      if (urgent) {
        if (r?.timer) clearTimeout(r.timer);
        this.recent.set(m.id, { at: now, timer: null });
        sendNow.push(m);
      } else if (!r || now - r.at >= this.coalesceMs) {
        this.recent.set(m.id, { at: now, timer: null });
        sendNow.push(m);
      } else {
        // Held back until the end of the window; the wake-up that ends it
        // stands for the latest message.
        r.seq = Math.max(r.seq ?? 0, seq);
        if (!r.timer) {
          r.timer = setTimeout(() => {
            const last = this.recent.get(m.id)?.seq ?? 0;
            this.recent.set(m.id, { at: Date.now(), timer: null });
            this._activity([m], { seq: last });
          }, r.at + this.coalesceMs - now);
          r.timer.unref?.();
        }
      }
    }
    // Old entries go, so the map stays small.
    if (this.recent.size > 5000) for (const [id, r] of this.recent) if (!r.timer && now - r.at > this.coalesceMs) this.recent.delete(id);
    return this._activity(sendNow, { urgent, seq });
  }

  close() {
    for (const r of this.recent.values()) clearTimeout(r.timer);
    this.recent.clear();
    for (const f of this.fallbacks.values()) clearTimeout(f.timer);
    this.fallbacks.clear();
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
  _activity(members, { urgent = false, seq = 0 } = {}) {
    if (!members.length) return Promise.resolve();
    if (seq) for (const m of members) if (m.pushPlatform === 'android' && m.pushFallback) this._watch(m, seq, urgent);
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
   * A phone that opted in to backup alerts was woken for message `seq`. Android
   * delivers a high-priority data push at once to a phone in active use, but a
   * phone that's locked and idle may hold it back (or the app's JavaScript may
   * not get to run), and then nothing sounds until the phone is picked up. The
   * server already knows when the phone has fetched (the delivered ticks): if
   * it hasn't after a few seconds, send one generic alert that the system
   * shows with sound by itself. The app takes it down once it has fetched and
   * shown the real notification. One check per member, for the latest seq.
   */
  _watch(m, seq, urgent) {
    const delay = urgent ? this.fallbackUrgentMs : this.fallbackMs;
    const due = Date.now() + delay;
    const cur = this.fallbacks.get(m.id);
    if (cur && cur.due <= due) {
      cur.seq = Math.max(cur.seq, seq);
      return;
    }
    if (cur) clearTimeout(cur.timer);
    const entry = { seq: Math.max(seq, cur?.seq ?? 0), urgent: urgent || !!cur?.urgent, due, timer: null };
    entry.timer = setTimeout(() => {
      if (this.fallbacks.get(m.id) === entry) this.fallbacks.delete(m.id);
      this._fallback(m, entry).catch(() => {});
    }, delay);
    entry.timer.unref?.();
    this.fallbacks.set(m.id, entry);
  }

  async _fallback(m, { seq, urgent }) {
    if ((this.store.deliveredSeqOf?.(m.id) ?? 0) >= seq) return;
    const c = circleHint(m.id);
    return this._send([
      {
        to: m.pushToken,
        title: 'HomeCircle',
        body: 'New message in your circle',
        sound: 'default',
        priority: 'high',
        channelId: urgent ? FALLBACK_URGENT_CHANNEL : FALLBACK_CHANNEL,
        // Stale after a few minutes: the app shows the real one when it can.
        ttl: 600,
        // Not the wake-up's collapse key: that one must not replace this, nor this it.
        collapseId: `fb-${c}`,
        data: { t: 'msg', c, fb: 1 },
      },
    ]);
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

  /**
   * Someone is calling: wake the phone so it fetches the (sealed) call and
   * rings. Content-free like every push: no name, no call id. Android gets a
   * data push; other platforms a generic alert. Never coalesced.
   */
  call(members) {
    return this._send(
      members.map((m) => {
        const c = circleHint(m.id);
        return m.pushPlatform === 'android'
          ? { to: m.pushToken, data: { t: 'call', c }, priority: 'high', ttl: 45 }
          : { to: m.pushToken, title: 'HomeCircle', body: 'Incoming call', sound: 'default', priority: 'high', ttl: 45, data: { t: 'call', c } };
      }),
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
