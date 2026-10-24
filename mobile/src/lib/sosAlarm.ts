// An SOS from someone in your circle: a notification that can't be missed,
// with their chirp and "SOS" in Morse. Normally it rings like any urgent
// notification, so Do Not Disturb silences it. If you opted in (Settings →
// SOS), it plays at alarm volume instead, which Do Not Disturb lets through
// unless you've also blocked alarms.
import { useSyncExternalStore } from 'react';
import { Platform } from 'react-native';
import * as Notifications from 'expo-notifications';
import { AndroidImportance, AndroidNotificationVisibility } from 'expo-notifications';
import { CHIRP_SOUNDS, type ChirpSound, type CircleClient, type Message } from '@homecircle/core';
import { isDoNotDisturbOn, playAlarm, stopAlarmSound } from '../../modules/hc-attention/src/HcAttentionModule';
import { diag } from './diagnostics';
import { getSettings } from './storage';

// Android fixes a channel's sound when it's made, so one per chirp.
const channelFor = (sound: ChirpSound) => `sos-${sound}`;
const QUIET_CHANNEL = 'sos-quiet';
// "SOS" in Morse, as a vibration: . . .  - - -  . . .
const MORSE_VIBRATION = [0, 150, 100, 150, 100, 150, 300, 450, 100, 450, 100, 450, 300, 150, 100, 150, 100, 150];
// An SOS older than this when it reaches the phone (it was off, say) still
// notifies, but doesn't ring.
const RING_WITHIN_MS = 30 * 60_000;

export async function ensureSosChannels() {
  if (Platform.OS !== 'android') return;
  const common = {
    importance: AndroidImportance.MAX,
    vibrationPattern: MORSE_VIBRATION,
    enableVibrate: true,
    lockscreenVisibility: AndroidNotificationVisibility.PUBLIC,
  };
  for (const sound of CHIRP_SOUNDS) {
    await Notifications.setNotificationChannelAsync(channelFor(sound), {
      ...common,
      name: `SOS: ${sound}`,
      description: 'When someone in your circle sends an SOS',
      sound: `sos_${sound}.wav`,
    });
  }
  // For an SOS that rings at alarm volume, or arrived too late to ring.
  await Notifications.setNotificationChannelAsync(QUIET_CHANNEL, { ...common, name: 'SOS (sound played separately)', sound: null });
}

/** Alert this phone to an SOS someone in `client`'s circle just sent. */
export async function alertSos(client: CircleClient, m: Message) {
  const member = client.members.get(m.from);
  const name = member?.name || client.account?.known[m.from]?.name || 'Someone';
  const sound: ChirpSound = member?.chirp && CHIRP_SOUNDS.includes(member.chirp) ? member.chirp : CHIRP_SOUNDS[0];
  const { sosThroughDnd } = await getSettings();
  const ring = Date.now() - m.ts < RING_WITHIN_MS;
  const asAlarm = ring && sosThroughDnd && isDoNotDisturbOn();
  diag('sos:in', { ring, asAlarm });
  await ensureSosChannels();
  await Notifications.scheduleNotificationAsync({
    content: {
      title: `🆘 ${name} needs help`,
      body: `${name} sent an SOS${client.circle.name ? ` in ${client.circle.name}` : ''}. Tap to see where they are.`,
      data: { t: 'sos', circle: client.circleId ?? '', member: m.from },
      priority: Notifications.AndroidNotificationPriority.MAX,
    },
    trigger: Platform.OS === 'android' ? { channelId: ring && !asAlarm ? channelFor(sound) : QUIET_CHANNEL } : null,
  });
  if (asAlarm && playAlarm(`sos_${sound}`, 2)) setRinging(true);
}

// Whether an SOS is ringing at alarm volume (the sound plays twice, ~16 s).
let ringing = false;
let ringTimer: ReturnType<typeof setTimeout> | null = null;
const listeners = new Set<() => void>();
function setRinging(on: boolean) {
  ringing = on;
  if (ringTimer) clearTimeout(ringTimer);
  ringTimer = on ? setTimeout(() => setRinging(false), 20_000) : null;
  listeners.forEach((l) => l());
}

/** Live: is an SOS ringing at alarm volume right now? */
export function useAlarmRinging(): boolean {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => ringing,
  );
}

/** Stop an SOS alarm that's ringing (you tapped Stop, acted on it, or they're safe). */
export function stopAlarm() {
  stopAlarmSound();
  setRinging(false);
}
