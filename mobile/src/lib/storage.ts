// Keys live in the iOS Keychain / Android Keystore via expo-secure-store.
// Values are chunked because SecureStore may reject values over ~2 KB.
import * as SecureStore from 'expo-secure-store';
import { useSyncExternalStore } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import type { ChirpSound, Storage } from '@homecircle/core';

const CHUNK = 1800;
// Background tasks run while the phone is locked, so keys must be readable
// after first unlock. THIS_DEVICE_ONLY keeps them out of backups.
const OPTS: SecureStore.SecureStoreOptions = {
  keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY,
};

export const secureStorage: Storage = {
  async getItem(key) {
    const n = await SecureStore.getItemAsync(`${key}.n`, OPTS);
    if (n == null) return null;
    const parts: string[] = [];
    for (let i = 0; i < Number(n); i++) {
      const part = await SecureStore.getItemAsync(`${key}.${i}`, OPTS);
      if (part == null) return null;
      parts.push(part);
    }
    return parts.join('');
  },
  async setItem(key, value) {
    const old = Number((await SecureStore.getItemAsync(`${key}.n`, OPTS)) || 0);
    const count = Math.max(1, Math.ceil(value.length / CHUNK));
    for (let i = 0; i < count; i++) {
      await SecureStore.setItemAsync(`${key}.${i}`, value.slice(i * CHUNK, (i + 1) * CHUNK), OPTS);
    }
    await SecureStore.setItemAsync(`${key}.n`, String(count), OPTS);
    for (let i = count; i < old; i++) await SecureStore.deleteItemAsync(`${key}.${i}`, OPTS);
  },
  async removeItem(key) {
    const n = Number((await SecureStore.getItemAsync(`${key}.n`, OPTS)) || 0);
    for (let i = 0; i < n; i++) await SecureStore.deleteItemAsync(`${key}.${i}`, OPTS);
    await SecureStore.deleteItemAsync(`${key}.n`, OPTS);
  },
};

// --- non-secret device settings ------------------------------------------

export interface AlertRule {
  id: string;
  circleId: string;
  memberId: string;
  placeId: string;
  on: 'arrived' | 'left' | 'both';
}

export interface Settings {
  /** Share this phone's location with the circle. */
  sharing: boolean;
  /** Background update interval. The OS treats this as a minimum. */
  intervalMinutes: number;
  /** Show sender and text in notifications (otherwise just "New message"). */
  showPreviews: boolean;
  /** Circles (by id) this phone doesn't share its location with. */
  pausedCircles: string[];
  /** Post "arrived at / left" messages to the group chats when this phone crosses a place. */
  announcePlaces: boolean;
  /** Show other people's arrived/left messages in chats (and notify for them). */
  showPlaceAlerts: boolean;
  /** Notify for everyone's arrivals and departures, not only your alert rules. */
  notifyAllPlaceAlerts: boolean;
  /** Circles (by id) that get an approximate (~1 km) location instead of an exact one. */
  approximateCircles: string[];
  /** Optional reason shown to a circle while sharing with it is paused. */
  pauseReasons: Record<string, string>;
  /** "Notify me when <person> arrives at / leaves <place>". */
  alertRules: AlertRule[];
  /** Your chirp: the sound others hear when you chirp them. */
  myChirp: ChirpSound | null;
  /** Play chirps' sounds (off: they still show, silently). Do Not Disturb always applies. */
  chirpSound: boolean;
  /** Blink the camera light for chirps that ask for it (never during Do Not Disturb). */
  chirpFlash: boolean;
  /** Map tiles, from the server's /info. */
  tileUrl: string;
  tileAttribution: string;
}

const SETTINGS_KEY = 'homecircle.settings';
const LAST_UPLOAD_KEY = 'homecircle.lastUpload';

export const DEFAULT_SETTINGS: Settings = {
  sharing: true,
  intervalMinutes: 15,
  showPreviews: true,
  pausedCircles: [],
  announcePlaces: true,
  showPlaceAlerts: true,
  notifyAllPlaceAlerts: true,
  approximateCircles: [],
  pauseReasons: {},
  alertRules: [],
  myChirp: null,
  chirpSound: true,
  chirpFlash: true,
  tileUrl: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
  tileAttribution: '&copy; OpenStreetMap contributors',
};

// The latest settings, so screens can render them without waiting.
let cached: Settings | null = null;
const settingsSubs = new Set<() => void>();
const setCached = (s: Settings) => {
  cached = s;
  settingsSubs.forEach((fn) => fn());
};

export async function getSettings(): Promise<Settings> {
  try {
    const raw = await AsyncStorage.getItem(SETTINGS_KEY);
    const s = { ...DEFAULT_SETTINGS, ...(raw ? JSON.parse(raw) : {}) };
    if (JSON.stringify(s) !== JSON.stringify(cached)) setCached(s);
    return s;
  } catch {
    return DEFAULT_SETTINGS;
  }
}

/** Settings as last loaded (defaults until then). */
export function currentSettings(): Settings {
  if (!cached) getSettings().catch(() => {});
  return cached ?? DEFAULT_SETTINGS;
}

/** Re-renders when settings change. */
export function useSettings(): Settings {
  return useSyncExternalStore(
    (cb) => {
      settingsSubs.add(cb);
      return () => settingsSubs.delete(cb);
    },
    currentSettings,
  );
}

export async function updateSettings(patch: Partial<Settings>): Promise<Settings> {
  const next = { ...(await getSettings()), ...patch };
  await AsyncStorage.setItem(SETTINGS_KEY, JSON.stringify(next));
  setCached(next);
  return next;
}

export interface LastUpload {
  ts: number;
  lat: number;
  lng: number;
  /** Lowest battery warning already sent (10 or 5, in percent), until it charges. */
  lowBattery?: number | null;
}

export async function getLastUpload(): Promise<LastUpload | null> {
  try {
    const raw = await AsyncStorage.getItem(LAST_UPLOAD_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export async function setLastUpload(v: LastUpload | null) {
  if (v) await AsyncStorage.setItem(LAST_UPLOAD_KEY, JSON.stringify(v));
  else await AsyncStorage.removeItem(LAST_UPLOAD_KEY);
}

export async function clearDeviceData() {
  const keys = await AsyncStorage.getAllKeys();
  await AsyncStorage.multiRemove([
    SETTINGS_KEY,
    LAST_UPLOAD_KEY,
    'homecircle.geofenceEvents',
    ...keys.filter((k) => k.startsWith('homecircle.lastNotifiedSeq')),
  ]);
}
