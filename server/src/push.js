// Content-free push notifications through Expo's push service (which relays to
// APNs / FCM). Payloads never contain names, locations or message text.

const EXPO_TOKEN = /^Expo(nent)?PushToken\[[A-Za-z0-9_\-:.]+\]$/;
export const isPushToken = (t) => typeof t === 'string' && t.length < 256 && EXPO_TOKEN.test(t);

export class Push {
  constructor(config, store, log) {
    this.config = config;
    this.store = store;
    this.log = log;
    this.enabled = config.push === 'expo';
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
   * A new chat message or place event. Android phones get a content-free
   * data push that wakes the app, which fetches, decrypts and shows the
   * message itself. Other platforms get a generic visible alert.
   */
  activity(members) {
    return this._send(
      members.map((m) =>
        m.pushPlatform === 'android'
          ? { to: m.pushToken, data: { t: 'msg' }, priority: 'high' }
          : {
              to: m.pushToken,
              title: 'HomeCircle',
              body: 'New message in your circle',
              sound: 'default',
              priority: 'high',
              data: { t: 'msg' },
              _contentAvailable: true,
            },
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
