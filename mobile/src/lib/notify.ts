// Message notifications. The server's push only says "something happened";
// the phone fetches and decrypts the message itself, then shows it here.
// Nothing readable ever passes through Google, Apple or Expo.
import { useSyncExternalStore } from 'react';
import { AppState, Platform } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Notifications from 'expo-notifications';
import { AndroidImportance, AndroidNotificationVisibility } from 'expo-notifications';
import { ACCOUNT_KEY, type CircleClient, type Message } from '@homecircle/core';
import { getSettings } from './storage';
import { allClients, getClient } from './circle';

const LAST_NOTIFIED_KEY = 'homecircle.lastNotifiedSeq';
export const MESSAGES_CHANNEL = 'messages';

let chatVisible = false;
// Unread messages per circle, for the Chat tab badge and the circle switcher.
let unread: Record<string, number> = {};
const unreadSubs = new Set<() => void>();
const setUnread = (next: Record<string, number>) => {
  unread = next;
  unreadSubs.forEach((fn) => fn());
};

/** The Chat screen reports when it's on screen, so we don't notify for what you're reading. */
export function setChatVisible(visible: boolean) {
  chatVisible = visible;
  const id = getClient().circleId;
  if (visible && id && unread[id]) setUnread({ ...unread, [id]: 0 });
}

/** Unread counts by circle id. */
export function useUnread(): Record<string, number> {
  return useSyncExternalStore(
    (cb) => {
      unreadSubs.add(cb);
      return () => unreadSubs.delete(cb);
    },
    () => unread,
  );
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
  const last = (await lastNotified(client)) ?? 0;
  if (seq > last) await AsyncStorage.setItem(`${LAST_NOTIFIED_KEY}.${client.circleId}`, String(seq));
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
  if (!previews) return { title: multi ? circle : 'HomeCircle', body: 'New message' };
  return { title: multi ? `${name} · ${circle}` : name, body: String(m.body?.text ?? '') };
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
  const fresh = messages.filter((m) => m.seq > last && m.from !== me && (m.kind === 'chat' || m.kind === 'event'));
  await markSeen(client, maxSeq);
  if (!fresh.length) return;
  const viewing = getClient() === client;
  if (viewing && chatVisible && AppState.currentState === 'active') return;
  const id = client.circleId!;
  setUnread({ ...unread, [id]: (unread[id] || 0) + fresh.length });

  const { showPreviews } = await getSettings();
  const multi = allClients().length > 1;
  const data = { t: 'chat', circle: id };
  const shown = fresh.slice(-4);
  for (const m of shown) {
    await Notifications.scheduleNotificationAsync({
      content: { ...describe(client, m, showPreviews, multi), sound: 'default', data },
      trigger: Platform.OS === 'android' ? { channelId: MESSAGES_CHANNEL } : null,
    });
  }
  if (fresh.length > shown.length) {
    await Notifications.scheduleNotificationAsync({
      content: { title: multi ? client.circle.name : 'HomeCircle', body: `${fresh.length - shown.length} more new messages`, data },
      trigger: Platform.OS === 'android' ? { channelId: MESSAGES_CHANNEL } : null,
    });
  }
}
