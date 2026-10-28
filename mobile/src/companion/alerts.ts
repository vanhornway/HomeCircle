// What reaches her phone from a circle, open or closed: a reply to her
// call-back request is played in Urdu (and shown in Urdu if the app is
// closed); someone else's SOS rings as in HomeCircle. She never gets message text.
import { AppState, Platform } from 'react-native';
import * as Notifications from 'expo-notifications';
import { AndroidImportance, AndroidNotificationVisibility } from 'expo-notifications';
import type { CircleClient, Message } from '@homecircle/core';
import { alertSos, stopAlarm } from '../lib/sosAlarm';
import { replyLine } from './status';
import { say, urdu, type Line } from './lines';

const CHANNEL = 'companion-replies';

async function ensureChannel() {
  if (Platform.OS !== 'android') return;
  // The clip plays on its own, so the notification itself is silent.
  await Notifications.setNotificationChannelAsync(CHANNEL, {
    name: 'Replies from family',
    importance: AndroidImportance.HIGH,
    sound: null,
    lockscreenVisibility: AndroidNotificationVisibility.PUBLIC,
  });
}

/** Messages newer than `last` in this circle, as her phone takes them. */
export async function companionAlerts(client: CircleClient, messages: Message[], last: number) {
  const me = client.account?.memberId;
  if (!me) return;
  let latest: Line | null = null;
  for (const m of messages) {
    if (m.seq <= last || m.from === me || m.kind !== 'chat' || m.peer) continue;
    const sos = client.feature('sos') ? m.body?.sos?.state : null;
    if (sos === 'start') await alertSos(client, m).catch(() => {});
    if (sos === 'safe') stopAlarm();
    const r = m.body?.callback;
    if (r?.state !== 'reply') continue;
    const s = client.callbackState(r.of);
    const who = s?.replies.find((x) => x.memberId === m.from);
    if (s?.from === me && who) latest = replyLine(client, who.memberId, who.name, who.reply);
  }
  if (!latest) return;
  say(latest);
  if (AppState.currentState === 'active') return;
  await ensureChannel();
  await Notifications.scheduleNotificationAsync({
    content: { title: urdu(latest), data: { t: 'companion', circle: client.circleId ?? '' } },
    trigger: Platform.OS === 'android' ? { channelId: CHANNEL } : null,
  });
}
