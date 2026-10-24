// Message notifications. The server's push only says "something happened";
// the phone fetches and decrypts the message itself, then shows it here.
// Nothing readable ever passes through Google, Apple or Expo.
import { AppState, Platform } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Notifications from 'expo-notifications';
import { ensureChirpChannels } from './chirp';
import { AndroidImportance, AndroidNotificationVisibility } from 'expo-notifications';
import { ACCOUNT_KEY, type CircleClient, type Message } from '@homecircle/core';
import { getSettings } from './storage';
import { allClients } from './circle';
import { conversationKey } from './unread';
import { previewText } from './polls';

const LAST_NOTIFIED_KEY = 'homecircle.lastNotifiedSeq';
export const MESSAGES_CHANNEL = 'messages';

// The conversation on screen right now (see lib/unread.ts for keys), so we
// don't notify for what you're reading.
let visibleConversation: string | null = null;

export function setVisibleConversation(key: string | null) {
  visibleConversation = key;
}

export async function ensureNotificationChannels() {
  if (Platform.OS !== 'android') return;
  await Notifications.setNotificationChannelAsync(MESSAGES_CHANNEL, {
    name: 'Messages',
    description: 'New messages and arrivals in your circles',
    importance: AndroidImportance.HIGH,
    sound: 'default',
    vibrationPattern: [0, 250, 150, 250],
    enableVibrate: true,
    lockscreenVisibility: AndroidNotificationVisibility.PRIVATE,
  });
  await ensureChirpChannels();
}

// Message sequence numbers are per server, so each circle keeps its own mark.
// The phone's first circle may still have the mark from before multiple circles.
async function lastNotified(client: CircleClient): Promise<number | null> {
  let v = await AsyncStorage.getItem(`${LAST_NOTIFIED_KEY}.${client.circleId}`);
  if (v == null && client.accountKey === ACCOUNT_KEY) v = await AsyncStorage.getItem(LAST_NOTIFIED_KEY);
  return v == null ? null : Number(v) || 0;
}

/** Everything up to `seq` in this circle has been seen (or notified); don't notify for it again. */
export async function markSeen(client: CircleClient, seq: number) {
  if (!client.circleId) return;
  // Always record a mark the first time, even 0 for a circle with no messages
  // yet; without one, the first message would be mistaken for old history.
  const last = await lastNotified(client);
  if (last == null || seq > last) await AsyncStorage.setItem(`${LAST_NOTIFIED_KEY}.${client.circleId}`, String(seq));
}

function nameOf(client: CircleClient, id: string) {
  // Background tasks don't load the member list; pinned names are in the account.
  return client.members.get(id)?.name || client.account?.known[id]?.name || 'Someone';
}

function describe(client: CircleClient, m: Message, previews: boolean, multi: boolean) {
  const name = nameOf(client, m.from);
  const circle = client.circle.name || 'HomeCircle';
  if (m.kind === 'event') {
    const verb = m.body?.action === 'left' ? 'left' : 'arrived at';
    return { title: circle, body: previews ? `${name} ${verb} ${m.body?.placeName || 'a place'}` : 'Someone arrived or left a place' };
  }
  // Like other messengers: a direct message is titled with the person, a group
  // message with the circle and "Name: text".
  if (m.peer) {
    if (!previews) return { title: 'HomeCircle', body: 'New direct message' };
    return { title: multi ? `${name} · ${circle}` : name, body: previewText(m) };
  }
  if (!previews) return { title: circle, body: 'New message' };
  return { title: circle, body: `${name}: ${previewText(m)}` };
}

/**
 * Show notifications for messages newer than the last one notified or seen
 * in this circle. Called for live messages while the app is open and from
 * the push task.
 */
export async function notifyNewMessages(client: CircleClient, messages: Message[]) {
  const me = client.account?.memberId;
  if (!me) return;
  const maxSeq = messages.reduce((n, m) => Math.max(n, m.seq), 0);
  const last = await lastNotified(client);
  if (last == null) {
    // First time for this circle on this phone: the existing history isn't news.
    await markSeen(client, maxSeq);
    return;
  }
  const id = client.circleId!;
  const reading = AppState.currentState === 'active' ? visibleConversation : null;
  const { showPreviews, showPlaceAlerts, notifyAllPlaceAlerts, alertRules } = await getSettings();
  // Your "notify me when…" rules fire even when other place alerts are off.
  const rules = alertRules.filter((r) => r.circleId === id);
  const ruleHit = (m: Message) =>
    m.kind === 'event' &&
    rules.some((r) => r.memberId === m.from && r.placeId === m.body?.placeId && (r.on === 'both' || r.on === m.body?.action));
  const fresh = messages.filter(
    (m) =>
      m.seq > last &&
      m.from !== me &&
      (m.kind === 'chat' || ruleHit(m) || (m.kind === 'event' && showPlaceAlerts && notifyAllPlaceAlerts)) &&
      conversationKey(id, m.peer) !== reading,
  );
  await markSeen(client, maxSeq);
  if (!fresh.length) return;

  const multi = allClients().length > 1;
  const shown = fresh.slice(-4);
  for (const m of shown) {
    const content = describe(client, m, showPreviews, multi);
    if (ruleHit(m)) content.title = `🔔 ${content.title}`;
    await Notifications.scheduleNotificationAsync({
      content: { ...content, sound: 'default', data: { t: 'chat', circle: id, peer: m.peer ?? '' } },
      trigger: Platform.OS === 'android' ? { channelId: MESSAGES_CHANNEL } : null,
    });
  }
  if (fresh.length > shown.length) {
    await Notifications.scheduleNotificationAsync({
      content: { title: multi ? client.circle.name : 'HomeCircle', body: `${fresh.length - shown.length} more new messages`, data: { t: 'chat', circle: id, peer: '' } },
      trigger: Platform.OS === 'android' ? { channelId: MESSAGES_CHANNEL } : null,
    });
  }
}
