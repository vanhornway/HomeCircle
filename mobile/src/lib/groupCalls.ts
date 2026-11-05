// The circle's group call: someone starts it, every phone shows a notification,
// and one tap joins. It runs in HomeCircle (lib/calls.ts, phone to phone, up to
// six people); WhatsApp's link is the fallback, for phones or circles without
// that. The start and joins are sealed group chat messages (see packages/core),
// and a WhatsApp link stays in the circle record.
import { useEffect } from 'react';
import { Platform } from 'react-native';
import * as Notifications from 'expo-notifications';
import { AndroidImportance, AndroidNotificationVisibility } from 'expo-notifications';
import type { CircleClient, GroupCallState } from '@homecircle/core';
import { clientForCircle, errorText } from './circle';
import { joinMesh, meshAvailable } from './calls';
import { showSheet } from './sheet';
import { openGroupCallLink, showOutcome } from './whatsapp';

export const GROUP_CALLS_CHANNEL = 'group-calls';
const PREFIX = 'groupcall:';

export async function ensureGroupCallChannel() {
  if (Platform.OS !== 'android') return;
  await Notifications.setNotificationChannelAsync(GROUP_CALLS_CHANNEL, {
    name: 'Group calls',
    description: 'When someone in your circle starts the WhatsApp group call',
    importance: AndroidImportance.HIGH,
    sound: 'default',
    vibrationPattern: [0, 300, 150, 300],
    enableVibrate: true,
    lockscreenVisibility: AndroidNotificationVisibility.PUBLIC,
  });
}

/** "Maya started the group call · tap to join" (one per call, replaced as people join). */
export async function notifyGroupCall(client: CircleClient, s: GroupCallState, { previews = true, title, body }: { previews?: boolean; title?: string; body?: string } = {}) {
  await ensureGroupCallChannel();
  const others = s.joined.filter((id) => id !== s.from).length;
  await Notifications.scheduleNotificationAsync({
    identifier: `${PREFIX}${client.circleId}:${s.id}`,
    content: {
      title: title ?? (previews ? `📞 ${client.displayName(s.from)} started the group call` : '📞 Your circle’s group call started'),
      body: body ?? `${others ? `${others + 1} people are on it. ` : ''}${s.mesh ? 'Tap to join.' : 'Tap to join in WhatsApp.'}`,
      sound: 'default',
      data: { t: 'groupcall', circle: client.circleId ?? '', call: s.id },
    },
    trigger: Platform.OS === 'android' ? { channelId: GROUP_CALLS_CHANNEL } : null,
  });
}

/** Take the call's notification away (you joined, or it's over). */
export async function clearGroupCallNotice(client: CircleClient, callId: string) {
  await Notifications.dismissNotificationAsync(`${PREFIX}${client.circleId}:${callId}`).catch(() => {});
}

/**
 * Join the call that's on; `callId` null starts one when none is. In HomeCircle
 * when that works here, otherwise WhatsApp opens into the call at once and the
 * circle is told.
 */
export async function joinGroupCall(client: CircleClient, callId: string | null) {
  const current = callId ? client.groupCallState(callId) : client.activeGroupCall();
  if (callId && current?.mesh && !current.open) {
    showSheet('That call has ended');
    await clearGroupCallNotice(client, callId);
    return;
  }
  if (current?.open ? current.mesh : meshAvailable(client)) {
    try {
      await joinMesh(client, current?.open ? current.id : null);
      await clearGroupCallNotice(client, current?.id ?? '');
    } catch (e) {
      showSheet('Couldn’t join the call', errorText(e));
    }
    return;
  }
  const link = client.groupCallLink;
  if (!link) {
    showOutcome({ ok: false, reason: 'bad_link', message: 'This circle has no group call link yet. An admin adds it in the group chat’s Group call.' });
    return;
  }
  const opened = openGroupCallLink(link).then(showOutcome);
  const on = callId ? client.groupCallState(callId) : null;
  const id = on?.open ? (await client.joinGroupCall(on.id), on.id) : await client.startGroupCall();
  await clearGroupCallNotice(client, id);
  await opened;
}

// Group call notification taps already acted on (this run of the app).
const handled = new Set<string>();

/** Tapping a group call notification joins. Used by the full app and the elder skin. */
export function useJoinGroupCallFromNotification() {
  const response = Notifications.useLastNotificationResponse();
  useEffect(() => {
    const data = response?.notification.request.content.data as { t?: string; circle?: string; call?: string } | undefined;
    if (!response || data?.t !== 'groupcall') return;
    // The same tap is reported again after a redraw or relaunch: act on each once.
    const key = `${response.notification.request.identifier}|${response.notification.date}`;
    if (handled.has(key)) return;
    handled.add(key);
    const client = clientForCircle(data.circle);
    if (client) joinGroupCall(client, data.call ?? null).catch(() => {});
  }, [response]);
}
