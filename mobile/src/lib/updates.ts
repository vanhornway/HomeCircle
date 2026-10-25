// New versions of the app. HomeCircle isn't in an app store, so the app asks
// GitHub for the latest release now and then (at most every 4 hours) and
// offers it: a banner while the app is open, and one notification per version
// when it found it in the background. Android always asks before installing
// an app, so the person downloads it and taps Install.
import { useSyncExternalStore } from 'react';
import { Linking, Platform } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import Constants from 'expo-constants';
import * as Notifications from 'expo-notifications';
import { MESSAGES_CHANNEL, ensureNotificationChannels } from './notify';

const LATEST_URL = 'https://api.github.com/repos/vanhornway/HomeCircle/releases/latest';
export const APK_URL = 'https://github.com/vanhornway/HomeCircle/releases/latest/download/HomeCircle.apk';
const EVERY_MS = 4 * 3600_000;
const HIDE_MS = 24 * 3600_000;
const KEY = 'homecircle.update';

export const APP_VERSION = Constants.expoConfig?.version ?? '0.0.0';

type State = { checkedAt: number; latest: string | null; notified: string | null; hiddenUntil: number };
let state: State = { checkedAt: 0, latest: null, notified: null, hiddenUntil: 0 };
let loaded: Promise<void> | null = null;
const listeners = new Set<() => void>();

const load = () =>
  (loaded ??= AsyncStorage.getItem(KEY)
    .then((raw) => {
      if (raw) state = { ...state, ...JSON.parse(raw) };
    })
    .catch(() => {})
    .then(() => listeners.forEach((l) => l())));

async function save(patch: Partial<State>) {
  state = { ...state, ...patch };
  listeners.forEach((l) => l());
  await AsyncStorage.setItem(KEY, JSON.stringify(state)).catch(() => {});
}

/** Whether version `a` is newer than `b` ("0.10.1" vs "0.9.4"). */
export function isNewer(a: string, b: string): boolean {
  const pa = a.split('.').map((n) => Number.parseInt(n, 10) || 0);
  const pb = b.split('.').map((n) => Number.parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) > (pb[i] ?? 0);
  }
  return false;
}

const available = () => (state.latest && isNewer(state.latest, APP_VERSION) ? state.latest : null);

/**
 * Ask GitHub for the latest release, unless we asked in the last 4 hours
 * (`force` asks anyway). Returns the newer version, or null.
 */
export async function checkForUpdate({ force = false } = {}): Promise<string | null> {
  if (Platform.OS !== 'android') return null; // Only the Android app is installed by hand.
  await load();
  if (!force && Date.now() - state.checkedAt < EVERY_MS) return available();
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), 10_000);
  try {
    const res = await fetch(LATEST_URL, { headers: { Accept: 'application/vnd.github+json' }, signal: abort.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const rel = (await res.json()) as { tag_name?: string; assets?: { name?: string }[] };
    const version = String(rel.tag_name ?? '').replace(/^v/, '');
    // Only a release that has the app in it.
    const hasApk = (rel.assets ?? []).some((a) => a.name === 'HomeCircle.apk');
    await save({ checkedAt: Date.now(), latest: /^\d+(\.\d+)*$/.test(version) && hasApk ? version : state.latest });
  } catch {
    await save({ checkedAt: Date.now() - EVERY_MS + 30 * 60_000 }); // try again in half an hour
  } finally {
    clearTimeout(timer);
  }
  return available();
}

/** Check, and if there's a new version found in the background, say so once. */
export async function checkForUpdateInBackground() {
  const version = await checkForUpdate();
  if (!version || state.notified === version) return;
  await save({ notified: version });
  await ensureNotificationChannels();
  await Notifications.scheduleNotificationAsync({
    content: { title: `HomeCircle ${version} is out`, body: 'Tap to download it, then tap Install.', data: { t: 'update' } },
    trigger: Platform.OS === 'android' ? { channelId: MESSAGES_CHANNEL } : null,
  });
}

/** Open the latest app in the browser, which downloads it. */
export function downloadUpdate() {
  return Linking.openURL(APK_URL);
}

/** Hide the banner for a day. */
export function hideUpdateBanner() {
  return save({ hiddenUntil: Date.now() + HIDE_MS });
}

/** The newer version to offer in the banner, or null. */
export function useAvailableUpdate(): string | null {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      load();
      return () => listeners.delete(l);
    },
    () => (Date.now() < state.hiddenUntil ? null : available()),
  );
}

/** The newer version for Settings, even while the banner is hidden. */
export function useNewerVersion(): string | null {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      load();
      return () => listeners.delete(l);
    },
    () => available(),
  );
}
