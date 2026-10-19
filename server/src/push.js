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

  /** Generic "something happened" notification for chat and place events. */
  activity(members) {
    return this._send(
      members.map((m) => ({
        to: m.pushToken,
        title: 'HomeCircle',
        body: 'New activity in your circle',
        sound: 'default',
        priority: 'high',
        channelId: 'activity',
        data: { t: 'msg' },
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
