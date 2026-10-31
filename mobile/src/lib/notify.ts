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
import { alertSos, ensureSosChannels, stopAlarm } from './sosAlarm';
import { ensureCallbackChannel, notifyCallback, syncCallbackReminders } from './callbacks';
import { loadSkin } from '../skins';
import { isDoNotDisturbOn } from '../../modules/hc-attention/src/HcAttentionModule';
import { companionAlerts } from '../companion/alerts';
import { countText, planNotifications } from './notifyPlan';
import { diag } from './diagnostics';

const LAST_NOTIFIED_KEY = 'homecircle.lastNotifiedSeq';
export const MESSAGES_CHANNEL = 'messages';
/** Messages that arrived late: listed, without a sound or a pop-up. */
export const QUIET_MESSAGES_CHANNEL = 'messages_quiet';
/** Call-back requests, replies and SOS that reach a phone through the backup alert (server/src/push.js). */
export const URGENT_CHANNEL = 'urgent';
/** What the server's backup alert says (it knows nothing more): see clearBackupAlerts. */
export const BACKUP_TITLE = 'HomeCircle';
export const BACKUP_BODY = 'New message in your circle';

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
  await Notifications.setNotificationChannelAsync(QUIET_MESSAGES_CHANNEL, {
    name: 'Earlier messages',
    description: 'Messages that reached this phone minutes after they were sent, kept without a sound',
    importance: AndroidImportance.LOW,
    sound: null,
    lockscreenVisibility: AndroidNotificationVisibility.PRIVATE,
  });
  await Notifications.setNotificationChannelAsync(URGENT_CHANNEL, {
    name: 'Urgent messages',
    description: 'The backup alert for call-back requests, replies and SOS when the phone was asleep',
    importance: AndroidImportance.HIGH,
    sound: 'default',
    vibrationPattern: [0, 400, 200, 400],
    enableVibrate: true,
    lockscreenVisibility: AndroidNotificationVisibility.PRIVATE,
  });
  await ensureChirpChannels();
  await ensureSosChannels();
  await ensureCallbackChannel();
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
 * Take down the generic backup alert the server sends an Android phone that
 * opted in, when the wake-up for a message went unanswered (Settings →
 * Notifications). The system showed it with a sound; now that this phone has
 * fetched, the real notification replaces it. Returns how many were removed.
 */
export async function clearBackupAlerts(): Promise<number> {
  if (Platform.OS !== 'android') return 0;
  try {
    const shown = await Notifications.getPresentedNotificationsAsync();
    const ids = shown
      .filter((n) => n.request.content.title === BACKUP_TITLE && n.request.content.body === BACKUP_BODY)
      .map((n) => n.request.identifier);
    if (!ids.length) return 0;
    await Promise.all(ids.map((id) => Notifications.dismissNotificationAsync(id)));
    await diag('push:backup-cleared', { n: ids.length });
    return ids.length;
  } catch {
    return 0;
  }
}

/**
 * Show notifications for messages newer than the last one notified or seen
 * in this circle. Called for live messages while the app is open and from
 * the push task. One notification per conversation (a newer one replaces it);
 * only the newest sounds, and messages minutes old are shown quietly
 * (lib/notifyPlan.ts). Returns how many conversations got one, and how many of
 * those were quiet.
 */
export async function notifyNewMessages(client: CircleClient, messages: Message[]): Promise<{ shown: number; quiet: number }> {
  const none = { shown: 0, quiet: 0 };
  const me = client.account?.memberId;
  if (!me) return none;
  // This phone has fetched: a backup alert the system showed meanwhile is stale.
  await clearBackupAlerts();
  const maxSeq = messages.reduce((n, m) => Math.max(n, m.seq), 0);
  const last = await lastNotified(client);
  if (last == null) {
    // First time for this circle on this phone: the existing history isn't news.
    await markSeen(client, maxSeq);
    await syncCallbackReminders(client).catch(() => {});
    return none;
  }
  const id = client.circleId!;
  // The Elderly Companion skin never shows message text: it plays the
  // replies to her call-back requests in Urdu, and rings for an SOS.
  if ((await loadSkin()) === 'elderly') {
    await companionAlerts(client, messages, last);
    await markSeen(client, maxSeq);
    return none;
  }
  // An SOS rings even if you're reading that chat; "safe now" stops it.
  const sosOf = (m: Message) => (client.feature('sos') && m.seq > last && m.from !== me && m.kind === 'chat' && !m.peer ? m.body?.sos?.state : null);
  for (const m of messages) {
    if (sosOf(m) === 'start') await alertSos(client, m).catch(() => {});
    if (sosOf(m) === 'safe') stopAlarm();
  }
  const reading = AppState.currentState === 'active' ? visibleConversation : null;
  const { showPreviews, showPlaceAlerts, notifyAllPlaceAlerts, alertRules } = await getSettings();
  // Your "notify me when…" rules fire even when other place alerts are off.
  const rules = alertRules.filter((r) => r.circleId === id);
  const ruleHit = (m: Message) =>
    m.kind === 'event' &&
    rules.some((r) => r.memberId === m.from && r.placeId === m.body?.placeId && (r.on === 'both' || r.on === m.body?.action));
  // A call-back request: its own notification, and only for whoever it asks.
  const callbackAsk = (m: Message) => m.kind === 'chat' && !m.peer && m.body?.callback?.state === 'ask';
  for (const m of messages) {
    if (!callbackAsk(m) || m.seq <= last || m.from === me) continue;
    const s = client.callbackState(m.id);
    if (!s?.open || !client.callbackAsks(s)) continue;
    // Night here, or Do Not Disturb on: no sound, and she's told we're asleep (PRD CUJ 6).
    const asleep = iAmAsleep();
    if (asleep && !s.replies.some((r) => r.memberId === me)) await client.replyCallback(s.id, 'asleep').catch(() => {});
    if (conversationKey(id, null) !== reading) await notifyCallback(client, s, showPreviews, { quiet: asleep }).catch(() => {});
  }
  await syncCallbackReminders(client, showPreviews).catch(() => {});
  const fresh = messages.filter(
    (m) =>
      m.seq > last &&
      m.from !== me &&
      sosOf(m) !== 'start' &&
      !callbackAsk(m) &&
      (m.kind === 'chat' || ruleHit(m) || (m.kind === 'event' && showPlaceAlerts && notifyAllPlaceAlerts)) &&
      conversationKey(id, m.peer) !== reading,
  );
  await markSeen(client, maxSeq);
  if (!fresh.length) return none;

  const multi = allClients().length > 1;
  const groups = planNotifications(fresh, id, Date.now(), AppState.currentState === 'active');
  for (const g of groups) {
    const content = describe(client, g.latest, showPreviews, multi);
    if (ruleHit(g.latest)) content.title = `🔔 ${content.title}`;
    const count = countText(g.messages.length);
    if (count) content.body = showPreviews ? `${count} · ${content.body}` : count;
    await Notifications.scheduleNotificationAsync({
      identifier: g.identifier,
      content: { ...content, ...(g.loud ? { sound: 'default' as const } : { sound: false }), data: { t: 'chat', circle: id, peer: g.peer ?? '' } },
      trigger: Platform.OS === 'android' ? { channelId: g.loud ? MESSAGES_CHANNEL : QUIET_MESSAGES_CHANNEL } : null,
    });
  }
  return { shown: groups.length, quiet: groups.filter((g) => !g.loud).length };
}

/** Whether this phone's person is likely asleep: Do Not Disturb on, or 10 pm to 7 am here. */
export function iAmAsleep(now = new Date()): boolean {
  const h = now.getHours();
  return isDoNotDisturbOn() || h >= 22 || h < 7;
}
