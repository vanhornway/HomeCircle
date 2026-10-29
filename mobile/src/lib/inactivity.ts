// An elder's phone not used for a while (PRD CUJ 11): her phone sends,
// sealed with its location, when she last used it; family phones in her
// care circle compare that with the time her admins set and tell their
// person quietly, once for each quiet stretch. The server has no part in it.
import { Platform } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Notifications from 'expo-notifications';
import { AndroidImportance } from 'expo-notifications';
import type { CircleClient } from '@homecircle/core';

const CHANNEL = 'elder-inactive';
const KEY = 'homecircle.inactiveNotified';
// From the background task: at most this often (it needs a fetch of the circle).
const BACKGROUND_EVERY_MS = 2 * 3600_000;

async function notified(): Promise<Record<string, number>> {
  try {
    return JSON.parse((await AsyncStorage.getItem(KEY)) || '{}');
  } catch {
    return {};
  }
}

/** Tell this phone's person about any elder in this circle whose phone has been quiet too long. */
export async function checkInactivity(client: CircleClient, now = Date.now()) {
  if (!client.circleId || !client.account) return;
  const me = client.account.memberId;
  const seen = await notified();
  let changed = false;
  for (const e of client.inactiveElders(now)) {
    // Her care circle looks after her; not her own phone.
    if (e.memberId === me || client.memberRecord(e.memberId)?.page === 'grandkids') continue;
    const key = `${client.circleId}:${e.memberId}`;
    if (seen[key] === e.used) continue;
    seen[key] = e.used;
    changed = true;
    if (Platform.OS === 'android') {
      await Notifications.setNotificationChannelAsync(CHANNEL, { name: 'An elder’s phone is quiet', importance: AndroidImportance.DEFAULT, sound: null });
    }
    const her = client.genderOf(e.memberId) === 'm' ? 'his' : 'her';
    await Notifications.scheduleNotificationAsync({
      content: {
        title: `${client.displayName(e.memberId)} hasn’t used ${her} phone for ${e.hours} hours`,
        body: 'It may be nothing. You could give them a call.',
        data: { t: 'chat', circle: client.circleId, peer: '' },
      },
      trigger: Platform.OS === 'android' ? { channelId: CHANNEL } : null,
    });
  }
  if (changed) await AsyncStorage.setItem(KEY, JSON.stringify(seen));
}

let lastBackground = 0;

/** From the background task, now and then: fetch what's needed and check. */
export async function checkInactivityInBackground(clients: CircleClient[]) {
  const now = Date.now();
  if (now - lastBackground < BACKGROUND_EVERY_MS) return;
  lastBackground = now;
  for (const c of clients) {
    try {
      await c.refresh();
      await c.fetchRecords();
      if (![...c.records.member.values()].some((r) => r.skin === 'elderly')) continue;
      await c.fetchLocations();
      await checkInactivity(c, now);
    } catch {
      // Offline: next time.
    }
  }
}
