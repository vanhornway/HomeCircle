// Chirps: a short bird sound (and maybe a flash) on someone's phone to get
// their attention. Each person picks their own chirp, so you can tell who it
// is without looking. Sounds play as notifications, which means Android's Do
// Not Disturb applies; the flash checks Do Not Disturb itself.
import * as Notifications from 'expo-notifications';
import { AndroidImportance } from 'expo-notifications';
import { Alert, Platform } from 'react-native';
import { ApiError, CHIRP_SOUNDS, type ChirpSound, type CircleClient, type IncomingChirp } from '@homecircle/core';
import { blinkLight, isDoNotDisturbOn, previewSound } from '../../modules/hc-attention/src/HcAttentionModule';
import { errorText } from './circle';
import { diag } from './diagnostics';
import { getSettings, updateSettings } from './storage';

export const CHIRP_NAMES: Record<ChirpSound, string> = {
  robin: 'Robin',
  wren: 'Wren',
  finch: 'Finch',
  chickadee: 'Chickadee',
  cardinal: 'Cardinal',
  bluebird: 'Bluebird',
  canary: 'Canary',
  sparrow: 'Sparrow',
  lark: 'Lark',
  dove: 'Dove',
};

// Android fixes a channel's sound when it's created, so each chirp has its own.
const channelFor = (sound: ChirpSound) => `chirp-${sound}`;
const SILENT_CHANNEL = 'chirp-silent';
// A chirp is a "right now" thing: one that waited longer than this isn't played.
const FRESH_MS = 2 * 60_000;

export async function ensureChirpChannels() {
  if (Platform.OS !== 'android') return;
  for (const sound of CHIRP_SOUNDS) {
    await Notifications.setNotificationChannelAsync(channelFor(sound), {
      name: `Chirps: ${CHIRP_NAMES[sound]}`,
      description: `When someone whose chirp is the ${CHIRP_NAMES[sound]} chirps you`,
      importance: AndroidImportance.HIGH,
      sound: `chirp_${sound}.wav`,
      vibrationPattern: [0, 90, 60, 90],
    });
  }
  await Notifications.setNotificationChannelAsync(SILENT_CHANNEL, {
    name: 'Chirps (sound off)',
    description: 'Chirps while you have their sound turned off in HomeCircle',
    importance: AndroidImportance.DEFAULT,
    sound: null,
    vibrationPattern: [0, 90],
  });
}

/** Play a chirp once, for picking yours. */
export function previewChirp(sound: ChirpSound) {
  return previewSound(`chirp_${sound}`);
}

/**
 * Show and sound the chirps that arrived for one circle: each on the sender's
 * chirp channel (silent if you turned chirp sounds off), and blink the light
 * if one asked for it and you allow it, unless Do Not Disturb is on.
 */
export async function playChirps(client: CircleClient, chirps: IncomingChirp[], { multiCircle = false } = {}) {
  const fresh = chirps.filter((c) => Date.now() - c.at < FRESH_MS);
  if (!fresh.length) return;
  const settings = await getSettings();
  for (const c of fresh) {
    diag('chirp:in', { sound: c.sound, flash: c.flash, muted: !settings.chirpSound });
    await Notifications.scheduleNotificationAsync({
      content: {
        title: `${c.name} chirped`,
        body: multiCircle ? client.circle.name : 'Tap to open HomeCircle',
        data: { t: 'chirp', circle: client.circleId ?? '' },
      },
      trigger: Platform.OS === 'android' ? { channelId: settings.chirpSound ? channelFor(c.sound) : SILENT_CHANNEL } : null,
    });
  }
  if (fresh.some((c) => c.flash) && settings.chirpFlash && !isDoNotDisturbOn()) {
    diag('chirp:flash', { ok: await blinkLight() });
  }
}

/** Collect and play waiting chirps for every circle given. */
export async function collectAndPlay(clients: CircleClient[]) {
  await Promise.allSettled(
    clients.map(async (c) => {
      if (!c.account) return;
      const chirps = await c.collectChirps();
      await playChirps(c, chirps, { multiCircle: clients.length > 1 });
    }),
  );
}

/** Your chirp, for every circle on this phone (and circles you join later). */
export async function setMyChirp(clients: CircleClient[], sound: ChirpSound) {
  await updateSettings({ myChirp: sound });
  await Promise.allSettled(clients.map((c) => c.setChirp(sound)));
}

/** Keep a circle's profile on the chirp you picked (e.g. a circle joined since). */
export async function applyMyChirp(client: CircleClient) {
  const { myChirp } = await getSettings();
  if (myChirp && client.me && client.me.chirp !== myChirp) await client.setChirp(myChirp);
}

/** Ask how to chirp (sound, or sound and flash), send it, and say how it went. */
export function chirpWithChoice(client: CircleClient, to: string | null) {
  const who = to ? client.members.get(to)?.name || 'them' : 'everyone';
  const mine = client.me?.chirp ? `your ${CHIRP_NAMES[client.me.chirp]}` : 'your chirp';
  const go = (flash: boolean) =>
    sendChirp(client, to, flash)
      .then((msg) => Alert.alert('Chirp', msg))
      .catch((e) => Alert.alert('Couldn’t chirp', errorText(e)));
  Alert.alert(`Chirp ${who}?`, `They’ll hear ${mine}, even with the app closed. Not while Do Not Disturb is on.`, [
    { text: 'Cancel', style: 'cancel' },
    { text: 'Sound + flash', onPress: () => go(true) },
    { text: 'Chirp', onPress: () => go(false) },
  ]);
}

/**
 * Chirp one person (or everyone with `to` null). Returns a short line for the
 * person who tapped: how many chirps are left, or when they can chirp again.
 */
export async function sendChirp(client: CircleClient, to: string | null, flash: boolean): Promise<string> {
  try {
    const res = await client.chirp(to, { flash });
    diag('chirp:out', { to: to ? 'one' : 'everyone', flash });
    const who = to ? client.members.get(to)?.name || 'them' : 'everyone';
    return res.remaining > 0
      ? `Chirped ${who}. ${res.remaining} more before a 30-minute break.`
      : `Chirped ${who}. That was the last one for 30 minutes.`;
  } catch (e) {
    if (e instanceof ApiError && e.code === 'chirp_cooldown') return e.message;
    throw e;
  }
}
