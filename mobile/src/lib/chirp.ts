// Chirps: a short bird sound (and maybe a flash) on someone's phone to get
// their attention. Each person picks their own chirp, so you can tell who it
// is without looking. Sounds play as notifications, which means Android's Do
// Not Disturb applies; the flash checks Do Not Disturb itself. Someone at
// school from 8 AM to 3 PM is probably in class, so their chirps only flash.
import * as Location from 'expo-location';
import * as Notifications from 'expo-notifications';
import { AndroidImportance } from 'expo-notifications';
import { Alert, Platform } from 'react-native';
import { ApiError, CHIRP_SOUNDS, type ChirpSound, type CircleClient, type IncomingChirp } from '@homecircle/core';
import { blinkLight, isDoNotDisturbOn, previewSound } from '../../modules/hc-attention/src/HcAttentionModule';
import { errorText } from './circle';
import { diag } from './diagnostics';
import { classHours, inClass } from './school';
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

// What the sender knows of where someone is only counts if it's this recent.
const WHERE_FRESH_MS = 2 * 3600_000;

/** Who you'd chirp (one person, or everyone else) that's probably in class right now, by what this phone last heard. */
export function inClassNow(client: CircleClient, to: string | null): string[] {
  const ids = to ? [to] : client.memberList().filter((m) => !m.isMe && !m.removed).map((m) => m.id);
  return ids.filter((id) => {
    const loc = client.locations.get(id);
    return !!loc && Date.now() - loc.ts < WHERE_FRESH_MS && inClass(client, id, loc);
  });
}

/** Whether this phone is at school in class hours, so a chirp should only flash. */
async function amInClass(client: CircleClient): Promise<boolean> {
  const me = client.account?.memberId;
  if (!me || !classHours(new Date())) return false;
  // Woken by a push, the circle's places may not be loaded yet.
  if (!client.places.size) await client.fetchPlaces().catch(() => {});
  const fix = await Location.getLastKnownPositionAsync({ maxAge: 30 * 60_000 }).catch(() => null);
  const here = fix ? { lat: fix.coords.latitude, lng: fix.coords.longitude } : client.locations.get(me);
  return inClass(client, me, here);
}

const names = (client: CircleClient, ids: string[]) => {
  const list = ids.map((id) => client.members.get(id)?.name || 'Someone');
  return list.length < 2 ? list.join('') : `${list.slice(0, -1).join(', ')} and ${list.at(-1)}`;
};

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
  // In class: no sound, just the flash.
  const quiet = await amInClass(client);
  for (const c of fresh) {
    diag('chirp:in', { sound: c.sound, flash: c.flash, muted: !settings.chirpSound, quiet });
    await Notifications.scheduleNotificationAsync({
      content: {
        title: `${c.name} chirped`,
        body: [multiCircle ? client.circle.name : null, quiet ? 'Flash only, since you’re at school' : null].filter(Boolean).join(' · ') || 'Tap to open HomeCircle',
        data: { t: 'chirp', circle: client.circleId ?? '' },
      },
      trigger: Platform.OS === 'android' ? { channelId: settings.chirpSound && !quiet ? channelFor(c.sound) : SILENT_CHANNEL } : null,
    });
  }
  if ((quiet || fresh.some((c) => c.flash)) && settings.chirpFlash && !isDoNotDisturbOn()) {
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
  if (to && inClassNow(client, to).length) {
    Alert.alert(`Chirp ${who}?`, `${who} is at school and might be in class, so they’ll only get a flash.`, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Flash', onPress: () => go(true) },
    ]);
    return;
  }
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
    // Their phone turns it into a flash when they're in class; ask for one
    // too, for phones on an older version.
    const quiet = inClassNow(client, to);
    const res = await client.chirp(to, { flash: flash || (!!to && quiet.length > 0) });
    diag('chirp:out', { to: to ? 'one' : 'everyone', flash, quiet: quiet.length });
    const who = to ? client.members.get(to)?.name || 'them' : 'everyone';
    const lines = [
      to && quiet.length ? `${who} might be in class, so only a flash was sent.` : `Chirped ${who}.`,
      !to && quiet.length ? `${names(client, quiet)} might be in class, so ${quiet.length === 1 ? 'they' : 'they each'} only got a flash.` : null,
      res.remaining > 0 ? `${res.remaining} more before a 30-minute break.` : 'That was the last one for 30 minutes.',
    ];
    return lines.filter(Boolean).join(' ');
  } catch (e) {
    if (e instanceof ApiError && e.code === 'chirp_cooldown') return e.message;
    throw e;
  }
}
