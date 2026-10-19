// Message notifications. The server's push only says "something happened";
// the phone fetches and decrypts the message itself, then shows it here.
// Nothing readable ever passes through Google, Apple or Expo.
import { useSyncExternalStore } from 'react';
import { AppState, Platform } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Notifications from 'expo-notifications';
import { AndroidImportance, AndroidNotificationVisibility } from 'expo-notifications';
import type { CircleClient, Message } from '@homecircle/core';
import { getSettings } from './storage';

const LAST_NOTIFIED_KEY = 'homecircle.lastNotifiedSeq';
export const MESSAGES_CHANNEL = 'messages';

let chatVisible = false;
let unread = 0;
const unreadSubs = new Set<() => void>();
const setUnread = (n: number) => {
  unread = n;
  unreadSubs.forEach((fn) => fn());
};

/** The Chat screen reports when it's on screen, so we don't notify for what you're reading. */
export function setChatVisible(visible: boolean) {
  chatVisible = visible;
  if (visible) setUnread(0);
}

/** Unread count for the Chat tab badge. */
export function useUnreadCount(): number {
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
    description: 'New messages and arrivals in your circle',
    importance: AndroidImportance.HIGH,
    sound: 'default',
    vibrationPattern: [0, 250, 150, 250],
    enableVibrate: true,
    lockscreenVisibility: AndroidNotificationVisibility.PRIVATE,
  });
}

async function lastNotified(): Promise<number | null> {
  const v = await AsyncStorage.getItem(LAST_NOTIFIED_KEY);
  return v == null ? null : Number(v) || 0;
}

/** Everything up to `seq` has been seen (or notified); don't notify for it again. */
export async function markSeen(seq: number) {
  const last = (await lastNotified()) ?? 0;
  if (seq > last) await AsyncStorage.setItem(LAST_NOTIFIED_KEY, String(seq));
}

function nameOf(client: CircleClient, id: string) {
  // Background tasks don't load the member list; pinned names are in the account.
  return client.members.get(id)?.name || client.account?.known[id]?.name || 'Someone';
}

function describe(client: CircleClient, m: Message, previews: boolean) {
  const name = nameOf(client, m.from);
  if (m.kind === 'event') {
    const verb = m.body?.action === 'left' ? 'left' : 'arrived at';
    return { title: client.circle.name || 'HomeCircle', body: previews ? `${name} ${verb} ${m.body?.placeName || 'a place'}` : 'Someone arrived or left a place' };
  }
  return { title: previews ? name : 'HomeCircle', body: previews ? String(m.body?.text ?? '') : 'New message' };
}

/**
 * Show notifications for messages newer than the last one notified or seen.
 * Called for live messages while the app is open and from the push task.
 */
export async function notifyNewMessages(client: CircleClient, messages: Message[]) {
  const me = client.account?.memberId;
  const maxSeq = messages.reduce((n, m) => Math.max(n, m.seq), 0);
  const last = await lastNotified();
  if (last == null) {
    // First run on this phone: the existing history isn't news.
    await markSeen(maxSeq);
    return;
  }
  const fresh = messages.filter((m) => m.seq > last && m.from !== me && (m.kind === 'chat' || m.kind === 'event'));
  await markSeen(maxSeq);
  if (!fresh.length) return;
  if (chatVisible && AppState.currentState === 'active') return;
  setUnread(unread + fresh.length);

  const { showPreviews } = await getSettings();
  const shown = fresh.slice(-4);
  for (const m of shown) {
    await Notifications.scheduleNotificationAsync({
      content: { ...describe(client, m, showPreviews), sound: 'default', data: { t: 'chat' } },
      trigger: Platform.OS === 'android' ? { channelId: MESSAGES_CHANNEL } : null,
    });
  }
  if (fresh.length > shown.length) {
    await Notifications.scheduleNotificationAsync({
      content: { title: 'HomeCircle', body: `${fresh.length - shown.length} more new messages`, data: { t: 'chat' } },
      trigger: Platform.OS === 'android' ? { channelId: MESSAGES_CHANNEL } : null,
    });
  }
}
