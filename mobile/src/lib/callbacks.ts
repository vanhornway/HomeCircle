// Call-back requests from the Elderly Companion app ("call me back"). The
// request and the replies are sealed chat messages (see packages/core); this
// phone reminds you with its own repeating notification until you answer,
// so nothing extra goes through the server or Google.
import { Platform } from 'react-native';
import * as Notifications from 'expo-notifications';
import { AndroidImportance, AndroidNotificationVisibility, SchedulableTriggerInputTypes } from 'expo-notifications';
import type { CallbackReply, CallbackState, CircleClient } from '@homecircle/core';

const PREFIX = 'callback:';
export const CALLBACKS_CHANNEL = 'callbacks';

/** The reply buttons, in order. */
export const REPLY_LABELS: Record<CallbackReply, string> = {
  now: 'I’m calling you now',
  '5min': 'I’ll call you back in 5 minutes',
  morning: 'I’ll call you in the morning',
  evening: 'I’ll call you in the evening',
};

/** How a reply reads in the summary: "Sara: in 5 minutes". */
export const REPLY_SHORT: Record<CallbackReply, string> = {
  now: 'calling now',
  '5min': 'in 5 minutes',
  morning: 'in the morning',
  evening: 'in the evening',
};

/** "9:40 pm" in someone's time zone (falls back to this phone's). */
export function timeIn(tz: string | null, ts = Date.now()): string {
  try {
    return new Date(ts).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit', ...(tz ? { timeZone: tz } : {}) });
  } catch {
    return new Date(ts).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  }
}

/** Who was asked, as the card says it. */
export function askedLine(client: CircleClient, s: CallbackState): string {
  if (!s.for) return 'Asked everyone';
  const me = client.account?.memberId;
  return `Asked ${s.for.map((id) => (id === me ? 'you' : client.members.get(id)?.name || 'someone')).join(', ')}`;
}

export async function ensureCallbackChannel() {
  if (Platform.OS !== 'android') return;
  await Notifications.setNotificationChannelAsync(CALLBACKS_CHANNEL, {
    name: 'Call-back requests',
    description: 'When someone using the Elderly Companion app asks you to call',
    importance: AndroidImportance.HIGH,
    sound: 'default',
    vibrationPattern: [0, 400, 200, 400],
    enableVibrate: true,
    lockscreenVisibility: AndroidNotificationVisibility.PRIVATE,
  });
}

/** Notify now about a request that asks you. */
export async function notifyCallback(client: CircleClient, s: CallbackState, previews: boolean) {
  await ensureCallbackChannel();
  await Notifications.scheduleNotificationAsync({
    content: {
      title: previews ? `📞 ${s.name} wants a call back` : '📞 A call-back request',
      body: previews ? `${askedLine(client, s)} · their time ${timeIn(s.tz, s.ts)}. Open the chat to reply.` : 'Open HomeCircle to reply.',
      sound: 'default',
      data: { t: 'chat', circle: client.circleId ?? '', peer: '' },
    },
    trigger: Platform.OS === 'android' ? { channelId: CALLBACKS_CHANNEL } : null,
  });
}

/**
 * Keep one repeating reminder per open request that asks you and that you
 * haven't answered; cancel the rest. Run after every fetch of the circle.
 */
export async function syncCallbackReminders(client: CircleClient, previews = true) {
  const circle = client.circleId;
  if (!circle) return;
  const mine = `${PREFIX}${circle}:`;
  const want = new Map(client.callbacksAwaitingMe().map((s) => [`${mine}${s.id}`, s]));
  const scheduled = await Notifications.getAllScheduledNotificationsAsync();
  const have = new Set<string>();
  for (const n of scheduled) {
    if (!n.identifier.startsWith(mine)) continue;
    if (want.has(n.identifier)) have.add(n.identifier);
    else await Notifications.cancelScheduledNotificationAsync(n.identifier);
  }
  for (const [identifier, s] of want) {
    if (have.has(identifier)) continue;
    await ensureCallbackChannel();
    await Notifications.scheduleNotificationAsync({
      identifier,
      content: {
        title: previews ? `📞 ${s.name} still wants a call back` : '📞 A call-back request is waiting',
        body: `Nobody is calling yet. Reminding every ${s.remind} min until you reply.`,
        sound: 'default',
        data: { t: 'chat', circle, peer: '' },
      },
      trigger: {
        type: SchedulableTriggerInputTypes.TIME_INTERVAL,
        seconds: Math.max(60, s.remind * 60),
        repeats: true,
        ...(Platform.OS === 'android' ? { channelId: CALLBACKS_CHANNEL } : {}),
      },
    });
  }
}
